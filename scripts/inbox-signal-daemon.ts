import 'dotenv/config';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  isEmailExtracted,
  markEmailExtracted,
  saveFact,
  createTask,
  getTaskById,
} from '../src/db.js';
import { pushTaskToGoogle } from '../src/sync/tasks-sync.js';
import { createCalendarEventRaw } from '../src/tools/calendar.js';
import { sparkRaw } from '../src/tools/spark.js';
import { sendMessage, getDefaultRecipient } from '../src/channels/imessage.js';
import { getAnthropicClient } from '../src/lib/anthropic.js';
import { parseStrEnv, parseNumEnv, parseBoolEnv } from '../src/lib/env.js';
import { extractFirstJson, makeLogger, haikuPrefilter, runDaemon } from '../src/lib/daemon.js';

// Tier 2 — proactive inbox-signal extraction daemon.
//
// Persistent loop (launchd KeepAlive). NOT a cron — it polls Spark on an
// interval the way imessage-daemon polls imessage_log. The structural
// difference: email has no upstream poller filling a DB table, so this daemon
// BOTH enumerates from Spark AND extracts in one process, deduping against
// email_extraction_log (keyed on the Spark message ID).
//
// Lifecycle (tick() every INBOX_SIGNAL_INTERVAL_MS):
//   1. enumerateNewEmails() — list a recent window from Spark, drop message_ids
//      already in email_extraction_log.
//   2. Haiku pre-filter — cheap classify of which rows carry a delivery / bill /
//      payment-failure / registration / document signal. Drops everything else
//      (especially meeting transcripts — owned by meeting-daemon).
//   3. Sonnet extraction — one structured-JSON call over the full thread bodies
//      of the survivors: { deliveries, bills, payment_failures, registrations,
//      documents }.
//   4. Auto-create artifacts (reversible only — never spends money / replies):
//        delivery     → createCalendarEventRaw (delivery window)
//        bill         → createTask(finance) + Google push  → heartbeat surfaces
//        payment_fail → high-priority createTask + urgent line in the digest DM
//        registration → createCalendarEventRaw + saveFact
//        document     → saveFact(fact_type:'reference')  → search_facts finds it
//   5. One digest DM of everything created (the "+ notify" half of the trust
//      model); payment failures first.
//   6. markEmailExtracted(ALL enumerated message_ids) — extracted or dropped —
//      so the cursor always advances and nothing is reprocessed.
//
// Surfacing is otherwise free: tasks ride heartbeat.ts, facts ride brain-pulse.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const LOG_PATH = join(REPO_ROOT, 'logs', 'inbox-signal-daemon.log');

const INTERVAL_MS = parseNumEnv('INBOX_SIGNAL_INTERVAL_MS', 15 * 60 * 1000);
const BATCH = parseNumEnv('INBOX_SIGNAL_BATCH', 50);
const WINDOW = parseStrEnv('INBOX_SIGNAL_WINDOW', '2d'); // Spark newer_than window
const ENABLED = parseBoolEnv('INBOX_SIGNAL_ENABLED', true);
const PREFILTER_MODEL = parseStrEnv('BROWNBOT_ROUTER_MODEL', 'claude-haiku-4-5');
const EXTRACT_MODEL = parseStrEnv('BROWNBOT_MODEL', 'claude-sonnet-4-6');

const TEST_MODE = process.argv.includes('--test');
const log = makeLogger(LOG_PATH, TEST_MODE);

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Step 1: enumerate new emails ─────────────────────────────────────────────
interface EmailRow {
  message_id: string; // Spark list "ID" column
  preview: string;    // raw row text (account / from / date / subject / flags, truncated)
}

// Spark `emails` list output is a column table. Each data row starts with the
// integer ID; the header ("ID  Account…"), "New Senders:", "Page N of…" and blank
// lines don't start with digits, so a leading-digit match isolates data rows.
function parseEmailList(output: string): EmailRow[] {
  const rows: EmailRow[] = [];
  for (const line of output.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*\S)\s*$/);
    if (!m) continue;
    rows.push({ message_id: m[1], preview: m[2].replace(/\s+/g, ' ').trim() });
  }
  return rows;
}

async function enumerateNewEmails(): Promise<EmailRow[]> {
  const out = await sparkRaw(['emails', '--filter', `newer_than:${WINDOW}`, '--page-size', String(BATCH)]);
  if (out.startsWith('Spark error')) {
    log(`enumerate: ${out.split('\n')[0]}`);
    return [];
  }
  const all = parseEmailList(out);
  const fresh = all.filter((r) => !isEmailExtracted(r.message_id));
  log(`enumerate: ${all.length} in window, ${fresh.length} new`);
  return fresh;
}

// ── Step 2: Haiku pre-filter ─────────────────────────────────────────────────
async function prefilterEmails(rows: EmailRow[]): Promise<EmailRow[]> {
  return haikuPrefilter({
    items: rows,
    render: (r, i) => `[${i}] ${r.preview}`,
    model: PREFILTER_MODEL,
    log,
    criteria: `You are a fast email classifier. Below are numbered emails (From + Subject).

Return a JSON array of the indices of emails that look like ANY of:
- a delivery or shipment confirmation / "out for delivery" / "arriving" notice
- a bill, invoice, or upcoming-payment notice with money due
- a FAILED or declined payment / card-expired / subscription-paused alert
- a confirmation that the owner registered for / booked an event, appointment, or class he should attend
- an important document or file shared with the owner (attachment, Google Drive / Dropbox share link, signed contract)

Ignore: newsletters, marketing, social notifications, meeting-transcript emails, and anything where someone ELSE registered for the owner's event (inbound signups are not actionable for him).`,
  });
}

// ── Step 3: Sonnet extraction ────────────────────────────────────────────────
interface ExtractJson {
  deliveries?: Array<{ message_id: string; carrier?: string; item?: string; date: string; window_start?: string | null; window_end?: string | null; tracking?: string | null }>;
  bills?: Array<{ message_id: string; payee: string; amount?: string | null; due_date: string }>;
  payment_failures?: Array<{ message_id: string; service: string; amount?: string | null; reason?: string | null; action_url?: string | null }>;
  registrations?: Array<{ message_id: string; event_name: string; date: string; start_time?: string | null; end_time?: string | null; location?: string | null; organizer?: string | null }>;
  documents?: Array<{ message_id: string; title: string; kind?: string | null; link?: string | null; attachment_name?: string | null; sender?: string | null }>;
}

async function readEmailBodies(rows: EmailRow[]): Promise<string> {
  const blocks: string[] = [];
  for (const r of rows) {
    const body = await sparkRaw(['thread', r.message_id]);
    blocks.push(`=== message_id: ${r.message_id} ===\n${body.slice(0, 2500)}`);
  }
  return blocks.join('\n\n');
}

async function extractSignals(rows: EmailRow[]): Promise<ExtractJson | null> {
  const bodies = await readEmailBodies(rows);
  const prompt = `Extract actionable signals from these emails. Each block is tagged with its message_id — echo the SAME message_id back on every item you extract from that block. Reply with JSON only, no prose.

{
  "deliveries":       [{"message_id":"", "carrier":"e.g. Amazon/UPS/USPS", "item":"short desc of what's arriving", "date":"YYYY-MM-DD", "window_start":"HH:MM or null", "window_end":"HH:MM or null", "tracking":"or null"}],
  "bills":            [{"message_id":"", "payee":"who is owed", "amount":"e.g. $84.20 or null", "due_date":"YYYY-MM-DD"}],
  "payment_failures": [{"message_id":"", "service":"e.g. Netflix/AWS", "amount":"or null", "reason":"e.g. card declined / expired", "action_url":"or null"}],
  "registrations":    [{"message_id":"", "event_name":"", "date":"YYYY-MM-DD", "start_time":"HH:MM or null", "end_time":"HH:MM or null", "location":"or null", "organizer":"or null"}],
  "documents":        [{"message_id":"", "title":"what the doc is", "kind":"e.g. contract/invoice/spreadsheet", "link":"share URL or null", "attachment_name":"file name or null", "sender":"or null"}]
}

Rules:
- Resolve all relative dates ("tomorrow", "arriving Tuesday") against today (${today()}). Use 24h HH:MM for times.
- registrations = events the owner themselves registered for / booked and should attend. NEVER include emails where someone else signed up for the owner's own event.
- payment_failures = the payment FAILED or needs action. A normal upcoming-renewal notice is a bill, not a failure.
- documents = a real file/attachment or share link worth keeping; skip inline marketing images and tracking pixels.
- Omit any section entirely if empty. Be conservative — when a date or amount is ambiguous, omit the field (or the item) rather than guess.

${bodies}`;

  try {
    const res = await getAnthropicClient().messages.create({
      model: EXTRACT_MODEL,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });
    const block = res.content[0];
    const text = block && block.type === 'text' ? block.text : '';
    const json = extractFirstJson(text, '{', '}');
    if (!json) {
      log('extract: could not locate JSON in response');
      return null;
    }
    return JSON.parse(json) as ExtractJson;
  } catch (err) {
    log(`extract failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ── Step 4+5: write back artifacts + build the digest ────────────────────────
interface Writeback {
  signalsByMsg: Map<string, number>; // message_id → artifacts created
  urgentLines: string[];             // payment failures — lead the DM
  normalLines: string[];             // deliveries/bills/registrations/documents
}

async function writeBackAndDigest(parsed: ExtractJson): Promise<Writeback> {
  const wb: Writeback = { signalsByMsg: new Map(), urgentLines: [], normalLines: [] };
  const bump = (mid: string) => wb.signalsByMsg.set(mid, (wb.signalsByMsg.get(mid) || 0) + 1);

  // Deliveries → calendar event (no task; the calendar + 6:30am prep cover it).
  for (const d of parsed.deliveries ?? []) {
    if (!d.date) continue;
    const label = [d.carrier, d.item].filter(Boolean).join(' — ') || 'Package';
    const title = `📦 Delivery: ${label}`;
    try {
      if (!TEST_MODE) {
        await createCalendarEventRaw({
          title,
          date: d.date,
          allDay: !d.window_start,
          startTime: d.window_start || undefined,
          endTime: d.window_end || undefined,
          description: d.tracking ? `Tracking: ${d.tracking}` : undefined,
          addHomeAttendee: false,
        });
      }
      const when = d.window_start ? `${d.date} ${d.window_start}–${d.window_end || ''}` : d.date;
      wb.normalLines.push(`📦 ${label} — ${when}`);
      bump(d.message_id);
    } catch (err) {
      log(`writeback delivery failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Bills → finance task (Google-synced; heartbeat surfaces it).
  for (const b of parsed.bills ?? []) {
    if (!b.payee || !b.due_date) continue;
    const title = `Pay ${b.payee}${b.amount ? ` ${b.amount}` : ''}`;
    try {
      if (!TEST_MODE) {
        const id = createTask({
          title,
          group_id: 'finance',
          assignee: 'owner',
          due_date: b.due_date,
          source: 'inbox-signal-daemon',
          sync_to_google: true,
          notes: 'Captured from a bill email',
        });
        const t = getTaskById(id);
        if (t) pushTaskToGoogle(t).catch((err) => log(`google task push failed: ${err}`));
      }
      wb.normalLines.push(`💵 ${title} — due ${b.due_date}`);
      bump(b.message_id);
    } catch (err) {
      log(`writeback bill failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Payment failures → high-priority task (due today) + urgent DM line.
  for (const p of parsed.payment_failures ?? []) {
    if (!p.service) continue;
    const title = `Fix payment: ${p.service}${p.amount ? ` ${p.amount}` : ''}`;
    try {
      if (!TEST_MODE) {
        const id = createTask({
          title,
          group_id: 'finance',
          assignee: 'owner',
          priority: 'high',
          due_date: today(),
          source: 'inbox-signal-daemon',
          notes: [p.reason, p.action_url].filter(Boolean).join(' — ') || 'Payment failed',
        });
        const t = getTaskById(id);
        if (t) pushTaskToGoogle(t).catch((err) => log(`google task push failed: ${err}`));
      }
      const detail = [p.reason, p.action_url].filter(Boolean).join(' — ');
      wb.urgentLines.push(`⚠️ Payment failed: ${p.service}${p.amount ? ` ${p.amount}` : ''}${detail ? ` (${detail})` : ''}`);
      bump(p.message_id);
    } catch (err) {
      log(`writeback payment_failure failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Registrations → calendar event + durable fact.
  for (const r of parsed.registrations ?? []) {
    if (!r.event_name || !r.date) continue;
    try {
      if (!TEST_MODE) {
        await createCalendarEventRaw({
          title: r.event_name,
          date: r.date,
          allDay: !r.start_time,
          startTime: r.start_time || undefined,
          endTime: r.end_time || undefined,
          description: r.location ? `Location: ${r.location}` : undefined,
          addHomeAttendee: false,
        });
        saveFact({
          subject: (r.organizer || r.event_name).trim(),
          predicate: 'registered for',
          object: `${r.event_name} on ${r.date}${r.location ? ` @ ${r.location}` : ''}`,
          fact_type: 'fact',
          source: 'inbox-signal-daemon',
          source_ref: `email:${r.message_id}`,
        });
      }
      wb.normalLines.push(`🗓️ ${r.event_name} — ${r.date}${r.start_time ? ` ${r.start_time}` : ''}`);
      bump(r.message_id);
    } catch (err) {
      log(`writeback registration failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Documents → reference fact (searchable via search_facts). v1 stores the
  // pointer; fetching/parsing Drive files is a follow-up (the daemon runs in the
  // bot process, not an MCP session).
  for (const doc of parsed.documents ?? []) {
    if (!doc.title) continue;
    const objectParts = [doc.title, doc.attachment_name, doc.link].filter(Boolean);
    try {
      if (!TEST_MODE) {
        saveFact({
          subject: (doc.sender || doc.title).trim(),
          predicate: 'shared document',
          object: objectParts.join(' — '),
          fact_type: 'reference',
          source: 'inbox-signal-daemon',
          source_ref: `email:${doc.message_id}`,
        });
      }
      wb.normalLines.push(`📎 ${doc.title}${doc.sender ? ` (from ${doc.sender})` : ''}`);
      bump(doc.message_id);
    } catch (err) {
      log(`writeback document failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  return wb;
}

async function sendDigest(wb: Writeback): Promise<void> {
  const lines = [...wb.urgentLines, ...wb.normalLines];
  if (!lines.length) return;
  const body = `🧠 Inbox auto-actions:\n${lines.join('\n')}`;
  if (TEST_MODE) {
    log(`would DM:\n${body}`);
    return;
  }
  const recipient = getDefaultRecipient();
  if (!recipient) {
    log('digest: no DM recipient configured — skipping notify');
    return;
  }
  try {
    await sendMessage(recipient, body);
  } catch (err) {
    log(`digest DM failed: ${err instanceof Error ? err.message : err}`);
  }
}

// ── Tick ─────────────────────────────────────────────────────────────────────
async function tick(): Promise<void> {
  if (!ENABLED) {
    log('INBOX_SIGNAL_ENABLED=false — skipping');
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    log('no ANTHROPIC_API_KEY — skipping (emails left for next run)');
    return;
  }

  const rows = await enumerateNewEmails();
  if (!rows.length) {
    if (TEST_MODE) log('tick: no new emails');
    return;
  }

  const candidates = await prefilterEmails(rows);
  log(`tick: ${candidates.length} candidate(s) after prefilter`);

  if (candidates.length) {
    const parsed = await extractSignals(candidates);
    if (parsed) {
      const counts = {
        deliveries: parsed.deliveries?.length ?? 0,
        bills: parsed.bills?.length ?? 0,
        payment_failures: parsed.payment_failures?.length ?? 0,
        registrations: parsed.registrations?.length ?? 0,
        documents: parsed.documents?.length ?? 0,
      };
      log(`tick: extracted ${JSON.stringify(counts)}`);
      const wb = await writeBackAndDigest(parsed);
      await sendDigest(wb);

      // Mark each enumerated row, carrying its per-email artifact count.
      if (!TEST_MODE) {
        for (const r of rows) {
          markEmailExtracted({ message_id: r.message_id, signal_count: wb.signalsByMsg.get(r.message_id) || 0 });
        }
      }
      log(`tick: marked ${rows.length} email(s) extracted`);
      return;
    }
  }

  // No candidates (or extraction failed) — still advance the cursor so we don't
  // re-enumerate the same emails every tick.
  if (!TEST_MODE) {
    for (const r of rows) markEmailExtracted({ message_id: r.message_id });
  }
  log(`tick: marked ${rows.length} email(s) extracted`);
}

runDaemon({ name: 'inbox-signal-daemon', intervalMs: INTERVAL_MS, testMode: TEST_MODE, tick, log }).catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
