import 'dotenv/config';
import { join } from 'path';
import {
  getUnextractedIMessages,
  markIMessagesExtracted,
  saveFact,
  upsertPerson,
  addInteraction,
  findPersonByPhone,
  findPersonByEmail,
  createTask,
  getTaskById,
  type IMessageLogRow,
} from '../src/db.js';
import { pushTaskToGoogle } from '../src/sync/tasks-sync.js';
import { getAnthropicClient } from '../src/lib/anthropic.js';
import { parseStrEnv, parseNumEnv } from '../src/lib/env.js';
import { extractFirstJson, makeLogger, haikuPrefilter, runDaemon } from '../src/lib/daemon.js';
import { logsDir } from '../src/paths.js';

// Phase 5: iMessage extraction daemon.
//
// Persistent loop (launchd KeepAlive). NOT a cron — it polls imessage_log on an
// interval the way meeting-daemon polls calendar/transcripts.
//
// Lifecycle (tick() every IMESSAGE_DAEMON_INTERVAL_MS):
//   1. getUnextractedIMessages(BATCH) — rows the channel logged but we haven't read.
//   2. Haiku pre-filter — cheap classify of which rows carry a commitment / date /
//      question / actionable signal. Discards chatter before the Sonnet call.
//   3. Sonnet extraction — one structured-JSON call over the candidates, shape
//      mirrors the meeting debrief: { commitments, deadlines, people, decisions }.
//   4. Brain write-back (direct db writes, like meeting-daemon):
//        commitment → saveFact(fact_type:'commitment')  → Brain Pulse surfaces it
//        deadline   → createTask(source:'imessage-daemon') + Google push
//        person     → upsertPerson + addInteraction (bumps last_contact)
//        decision   → saveFact(fact_type:'decision')
//   5. markIMessagesExtracted(ALL pulled ids) — both extracted and filtered-out,
//      so the cursor always advances and nothing is reprocessed.
//
// There is no proactive surfacing layer here by design — once a commitment lands
// as a fact, getStaleCommitments() (brain-pulse) picks it up for free.

const LOG_PATH = join(logsDir, 'imessage-daemon.log');

const INTERVAL_MS = parseNumEnv('IMESSAGE_DAEMON_INTERVAL_MS', 10 * 60 * 1000);
const BATCH = parseNumEnv('IMESSAGE_EXTRACT_BATCH', 100);
const PREFILTER_MODEL = parseStrEnv('SECONDBRAIN_ROUTER_MODEL', '') || parseStrEnv('BROWNBOT_ROUTER_MODEL', 'claude-haiku-4-5');
const EXTRACT_MODEL = parseStrEnv('SECONDBRAIN_MODEL', '') || parseStrEnv('BROWNBOT_MODEL', 'claude-sonnet-4-6');

const TEST_MODE = process.argv.includes('--test');
const log = makeLogger(LOG_PATH, TEST_MODE);

// A short, model-friendly label for the chat a message came from.
function chatLabel(row: IMessageLogRow): string {
  return row.chat_name || row.chat_id;
}

// Render one message line for the LLM, tagged with index + direction + chat.
function renderLine(row: IMessageLogRow, idx: number): string {
  const who = row.direction === 'out' ? 'the owner (me)' : row.sender;
  return `[${idx}] (${chatLabel(row)}) ${who}: ${(row.text || '').slice(0, 500)}`;
}

// ── Step 2: Haiku pre-filter ─────────────────────────────────────────────────
// Returns the subset of candidate rows worth the expensive extraction call.
async function prefilterMessages(rows: IMessageLogRow[]): Promise<IMessageLogRow[]> {
  const withText = rows.filter((r) => (r.text || '').trim().length > 0);
  return haikuPrefilter({
    items: withText,
    render: renderLine,
    model: PREFILTER_MODEL,
    log,
    criteria: `You are a fast classifier. Below are numbered iMessages (the owner's own messages are tagged "the owner (me)").

Return a JSON array of the indices of messages that contain ANY of:
- a commitment or promise (especially one the owner made: "I'll send…", "I'll get you…", "let me…")
- a date, deadline, or time reference ("by Friday", "next week", "tomorrow at 3")
- an explicit question awaiting a reply
- a clearly actionable to-do

Ignore greetings, reactions, logistics chatter, and emoji-only messages.`,
  });
}

// ── Step 3: Sonnet extraction ────────────────────────────────────────────────
interface ExtractJson {
  commitments?: Array<{ counterpart?: string; text: string }>;
  deadlines?: Array<{ title: string; due?: string | null }>;
  people?: Array<{ name: string }>;
  decisions?: Array<{ subject?: string; text: string }>;
}

async function extractFromMessages(rows: IMessageLogRow[]): Promise<ExtractJson | null> {
  const list = rows.map((r, i) => renderLine(r, i)).join('\n');
  const prompt = `Extract durable knowledge from these iMessages. the owner's own messages are tagged "the owner (me)". Reply with JSON only, no prose.

{
  "commitments": [{"counterpart": "who the owner promised (person name or chat)", "text": "what the owner committed to do"}],
  "deadlines": [{"title": "the to-do", "due": "YYYY-MM-DD or null"}],
  "people": [{"name": "a real person named in conversation"}],
  "decisions": [{"subject": "topic/person", "text": "the decision"}]
}

Rules:
- ONLY include commitments the owner themselves made (his "(me)" messages), not promises made TO him.
- deadlines = concrete things the owner must do by a date. Resolve relative dates against today (${new Date().toISOString().slice(0, 10)}); if no date is implied, use null.
- people = named humans (skip the owner themselves, skip group/chat names).
- Omit a section entirely if empty. Be conservative — skip anything ambiguous.

${list}`;

  try {
    const res = await getAnthropicClient().messages.create({
      model: EXTRACT_MODEL,
      max_tokens: 1500,
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

// ── Step 4: brain write-back ─────────────────────────────────────────────────
function writeBackToBrain(parsed: ExtractJson, rows: IMessageLogRow[]): void {
  // Newest message timestamp in this batch — used for interaction recency.
  const latestTs = rows.reduce((acc, r) => (r.ts > acc ? r.ts : acc), rows[0]?.ts || new Date().toISOString());

  // Commitments the owner made → durable facts for brain-pulse to surface later.
  for (const c of parsed.commitments ?? []) {
    if (!c.text) continue;
    const subject = (c.counterpart || 'imessage').trim() || 'imessage';
    try {
      saveFact({
        subject,
        predicate: 'promised',
        object: c.text,
        fact_type: 'commitment',
        source: 'imessage-daemon',
        source_ref: `imessage:${latestTs}`,
      });
    } catch (err) {
      log(`writeback: saveFact(commitment) failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Deadlines → tasks (Google-synced, like meeting-daemon action items).
  for (const d of parsed.deadlines ?? []) {
    if (!d.title) continue;
    try {
      const id = createTask({
        title: d.title,
        group_id: 'admin',
        assignee: 'owner',
        due_date: d.due || undefined,
        source: 'imessage-daemon',
        sync_to_google: true,
        notes: 'Captured from iMessage',
      });
      const t = getTaskById(id);
      if (t) pushTaskToGoogle(t).catch((err) => log(`google task push failed: ${err}`));
    } catch (err) {
      log(`writeback: createTask failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // People → upsert + interaction (bumps last_contact → feeds dormant-leads).
  for (const p of parsed.people ?? []) {
    if (!p.name) continue;
    try {
      const personId = upsertPerson({ name: p.name });
      addInteraction({
        person_id: personId,
        channel: 'imessage',
        summary: 'Mentioned in iMessage',
        ref: `imessage:${latestTs}`,
        occurred_at: latestTs,
      });
    } catch (err) {
      log(`writeback: person upsert failed for ${p.name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Decisions → durable facts.
  for (const dec of parsed.decisions ?? []) {
    if (!dec.text) continue;
    try {
      saveFact({
        subject: (dec.subject || 'imessage').trim() || 'imessage',
        predicate: 'decided',
        object: dec.text,
        fact_type: 'decision',
        source: 'imessage-daemon',
        source_ref: `imessage:${latestTs}`,
      });
    } catch (err) {
      log(`writeback: saveFact(decision) failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

// ── Sender linking ───────────────────────────────────────────────────────────
// Bind incoming iMessage activity to a *known* person by their handle. Once Apple
// Contacts seeds a person with both an email and a phone (see scripts/import-contacts.ts),
// the phone handle resolves here and the text lands as an interaction on the same row
// the email path already feeds — closing the phone↔people dedup gap. We deliberately do
// NOT create new nameless phone-only rows here; unknown handles are left for Contacts.
function linkIncomingSenders(rows: IMessageLogRow[]): void {
  // Distinct incoming sender handles → most-recent ts in this batch (one interaction each).
  const bySender = new Map<string, string>();
  for (const r of rows) {
    if (r.direction !== 'in') continue;
    const handle = (r.sender || '').trim();
    if (!handle || handle === 'me') continue;
    const prev = bySender.get(handle);
    if (!prev || r.ts > prev) bySender.set(handle, r.ts);
  }

  for (const [handle, ts] of bySender) {
    const person = handle.includes('@') ? findPersonByEmail(handle) : findPersonByPhone(handle);
    if (!person) continue; // unknown handle — leave for the Contacts importer to seed
    try {
      addInteraction({
        person_id: person.id,
        channel: 'imessage',
        summary: 'Texted the owner',
        ref: `imessage:sender:${handle}:${ts}`,
        occurred_at: ts,
      });
    } catch (err) {
      log(`link: addInteraction failed for ${handle}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

async function tick(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    log('no ANTHROPIC_API_KEY — skipping (rows left unextracted for next run)');
    return;
  }

  const rows = getUnextractedIMessages(BATCH);
  if (!rows.length) {
    if (TEST_MODE) log('tick: no unextracted messages');
    return;
  }
  log(`tick: ${rows.length} unextracted message(s)`);

  // Link incoming senders to known people by handle (cheap DB lookups, no LLM) over
  // ALL rows so recency/dormancy reflects every text, not just actionable ones.
  linkIncomingSenders(rows);

  const candidates = await prefilterMessages(rows);
  log(`tick: ${candidates.length} candidate(s) after prefilter`);

  if (candidates.length) {
    const parsed = await extractFromMessages(candidates);
    if (parsed) {
      const counts = {
        commitments: parsed.commitments?.length ?? 0,
        deadlines: parsed.deadlines?.length ?? 0,
        people: parsed.people?.length ?? 0,
        decisions: parsed.decisions?.length ?? 0,
      };
      log(`tick: extracted ${JSON.stringify(counts)}`);
      writeBackToBrain(parsed, candidates);
    }
  }

  // Mark ALL pulled rows (extracted + filtered-out) so the cursor advances.
  markIMessagesExtracted(rows.map((r) => r.id));
  log(`tick: marked ${rows.length} row(s) extracted`);
}

runDaemon({ name: 'imessage-daemon', intervalMs: INTERVAL_MS, testMode: TEST_MODE, tick, log }).catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
