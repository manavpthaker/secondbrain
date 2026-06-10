import cron from 'node-cron';
import { sendMessage, getDefaultRecipient } from './channels/imessage.js';
import { runAgent } from './agent.js';
import type { GroupConfig } from './group-resolver.js';
import { REFLECTION_GROUP } from './group-resolver.js';
import { getSystemUser } from './lib/system-user.js';
import { parseNumEnv } from './lib/env.js';
import {
  getMessagesSince, getMemory, setMemory, deleteMemory,
  getOverdueTasks, getTasksDueSoon, getTasksNeedingDecision, markTaskSurfaced, markTaskRetired,
  type MessageRow, type Task,
} from './db.js';
import { getCanairyWarnings, formatTightenUpAlert } from './tools/canairy.js';
import { syncPlaidTransactions, checkFinanceConfig } from './tools/finance.js';
import { runHealthCheck, formatAlivePing } from './doctor.js';

// YYYY-MM-DD in America/New_York. en-CA's date format happens to be ISO.
function todayDateET(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
function tomorrowDateET(): string {
  const t = new Date();
  t.setDate(t.getDate() + 1);
  return t.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
function nextSundayIso(): string {
  const now = new Date();
  const day = now.getUTCDay();
  const daysUntil = day === 0 ? 7 : 7 - day;
  const target = new Date(now.getTime() + daysUntil * 86400000);
  target.setUTCHours(0, 0, 0, 0);
  return target.toISOString();
}
function daysFromNowIso(n: number): string {
  return new Date(Date.now() + n * 86400000).toISOString();
}

function groupConfig(key: string, name: string, tools: string[], contextPath: string): GroupConfig {
  return { key, name, tools, contextPath };
}

// Sync Plaid → finance DB, then re-stamp the bmm runway/burn/balance metric facts
// from a live read so chat retrieves today's numbers (not week-old cached facts).
// Shared by the 07:00 cron and the boot kick. Silent — only writes facts.
async function runFinanceMetricRefresh(user: ReturnType<typeof getSystemUser>): Promise<void> {
  await syncPlaidTransactions(30);
  const group = groupConfig('finance', 'Finance', ['finance', 'memory'], 'context/finance');
  await runAgent(group, user,
    `Refresh the headline finance metrics from the live finance DB (call get_account_balances and whatever else you need — the DB was just synced from Plaid). Persist them as metric facts so future prompts retrieve today's numbers. Use save_fact with fact_type='metric' and valid_until = ${daysFromNowIso(2)} (expires in ~2 days so a missed run doesn't leave it permanently). Capture:
- subject='bmm', predicate='runway_months', object=<number>
- subject='bmm', predicate='monthly_burn', object=<dollar amount>
- subject='bmm', predicate='total_balance', object=<dollar amount>

This is a silent background refresh — do NOT write a narrative or checkpoint, just save the facts and stop.`
  );
}

function briefTaskLine(t: Task): string {
  const due = t.due_date
    ? ` (due ${new Date(t.due_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })})`
    : '';
  return `#${t.id} ${t.title}${due}`;
}

// Builds the once-daily task pass for the morning brief (organic reminders).
// Routine overdue + due-today are listed for the agent to weave in contextually;
// "needs a decision" items (surfaced enough times to cross the retire threshold)
// get one pointed question, then are retired out of rotation until touched.
// Returns the prompt text plus the rows to mark afterward (mirrors the heartbeat:
// we mark what we handed the agent, whether or not it cites every line).
function buildMorningTaskContext(): { text: string; surfaced: Task[]; retired: Task[] } {
  const overdue = getOverdueTasks();
  const dueToday = getTasksDueSoon(24);
  const needsDecision = getTasksNeedingDecision();

  if (overdue.length === 0 && dueToday.length === 0 && needsDecision.length === 0) {
    return { text: '', surfaced: [], retired: [] };
  }

  const sections: string[] = ['\n\nTASK SIGNALS (weave these into the brief naturally — do not just paste the list):'];
  if (overdue.length > 0) {
    sections.push(`Overdue:\n${overdue.map(briefTaskLine).join('\n')}`);
  }
  if (dueToday.length > 0) {
    sections.push(`Due today:\n${dueToday.map(briefTaskLine).join('\n')}`);
  }
  if (overdue.length > 0 || dueToday.length > 0) {
    sections.push('Lead with the ONE that actually matters today; mention the rest briefly. Offer to calendar-block or reschedule rather than just restating them.');
  }
  if (needsDecision.length > 0) {
    sections.push(
      `NEEDS A DECISION (these have been raised several times and keep slipping — stop reminding, ask once):\n${needsDecision.map(briefTaskLine).join('\n')}\n` +
      `For each, ask one short, direct question: kill it or commit to a day? No guilt, no lecture — just the choice. Tell me you\'ll stop bringing it up until I decide.`,
    );
  }

  return {
    text: sections.join('\n\n'),
    surfaced: [...overdue, ...dueToday],
    retired: needsDecision,
  };
}

export function startScheduler() {
  const user = getSystemUser();

  // ============================================================
  // DAILY WORKFLOWS
  // ============================================================

  const personalTarget = getDefaultRecipient();
  const financeTarget = process.env.GROUP_FINANCE || getDefaultRecipient();

  // Live Plaid pull → finance DB (every 6h). The finance read tools only ever read
  // the DB (no Plaid call), so without this nothing refreshes the numbers between
  // manual syncs. Deterministic HTTP call — no LLM. Logs the outcome.
  cron.schedule('0 */6 * * *', async () => {
    console.log('[Scheduler] Plaid sync (6h)');
    try {
      const result = await syncPlaidTransactions(30);
      console.log('[Scheduler] Plaid sync result:', result.slice(0, 200));
    } catch (err) {
      console.error('[Scheduler] Plaid sync failed:', err);
    }
  }, { timezone: 'America/New_York' });

  // Daily finance metric refresh (7:00 AM ET). Syncs Plaid first, then re-stamps the
  // bmm runway/burn/balance metric facts with a short validity so chat reflects
  // current numbers within a day (was Sunday-only → up to a week stale). Silent — it
  // only refreshes facts, no DM.
  if (financeTarget) {
    cron.schedule('0 7 * * *', async () => {
      console.log('[Scheduler] Daily finance metric refresh');
      try {
        await runFinanceMetricRefresh(user);
      } catch (err) {
        console.error('[Scheduler] Finance metric refresh failed:', err);
      }
    }, { timezone: 'America/New_York' });

    // Boot kick: a cron only fires at its next matching time, so a fresh deploy
    // would otherwise serve stale numbers for up to 6h (and cached facts until
    // 07:00). Run one sync + refresh now so a deploy takes effect within a minute.
    // Guarded to once/hour via a memory stamp so a crash-loop can't spam the LLM.
    void (async () => {
      if (checkFinanceConfig().length) return; // unconfigured — boot warning already fired
      try {
        await syncPlaidTransactions(30); // deterministic DB refresh always
        const last = getMemory('system', 'finance_boot_refresh_at');
        const hoursSince = last ? (Date.now() - Date.parse(last)) / 3_600_000 : Infinity;
        if (hoursSince >= 1) {
          console.log('[Scheduler] Boot finance metric refresh');
          await runFinanceMetricRefresh(user);
          setMemory('system', 'finance_boot_refresh_at', new Date().toISOString());
        }
      } catch (err) {
        console.error('[Scheduler] Boot finance sync/refresh failed:', err);
      }
    })();
  }

  // Daily inbox triage → personal DM (8:00 AM ET)
  if (personalTarget) {
    cron.schedule('0 8 * * *', async () => {
      console.log('[Scheduler] Daily inbox triage');
      try {
        const group = groupConfig('home', 'Home', ['spark', 'memory', 'tasks', 'people'], 'context/personal');
        const response = await runAgent(group, user,
          `Daily inbox triage across all my Spark accounts. Do this carefully:

1. NEWSLETTERS (category:newsletter is:unread): read each one with read_email_thread, then archive it with email_action(archive). Produce a CONSOLIDATED overview that summarizes the key takeaways across all newsletters — group by topic, highlight anything genuinely new or actionable.
2. NOTIFICATIONS (category:notification is:unread): list and summarize the meaningful ones. Don't auto-archive these — some are receipts/alerts I need to see.
3. PEOPLE (category:personal is:unread): list each thread with a one-line summary. Flag any that look like they need a reply or my attention.
4. PRIORITY (category:priority is:unread): full per-thread summary. Never auto-act on these.
5. INVITES (category:invitation): list any pending calendar invitations.

While you read each thread, capture durable facts in the knowledge store:
- save_fact for commitments I made or that someone made to me, deadlines, decisions confirmed, or any datum I'd want surfaced again later. Use source='email' and source_ref=<message_id>.
- note_about_person when an email reveals a new role, company, or relationship for someone I should track. (Senders are auto-ingested as people, so you only need note_about_person to add structured fields like role/company/relationship.)
- Don't over-save — only durable facts, not transient noise. A confirmation email about a package is not a fact; "Alex is now Director of Eng at Acme" is.

End with three sections:
- Act on (threads needing a reply or decision today)
- Learn more about (interesting items worth a deeper read)
- Read myself (things I should read directly, not just from your summary)

Keep newsletter summary compact but information-dense. For everything else, keep it scannable — message IDs included so I can act on them.`
        );
        await sendMessage(personalTarget, response);
      } catch (err) {
        console.error('[Scheduler] Inbox triage failed:', err);
      }
    }, { timezone: 'America/New_York' });
  }

  // Daily calendar prep → personal DM (6:30 AM ET).
  // Also delivers the nightly reflection's morning brief, if one is staged.
  if (personalTarget) {
    cron.schedule('30 6 * * *', async () => {
      console.log('[Scheduler] Daily calendar prep');
      try {
        const briefKey = `morning_brief_${todayDateET()}`;
        const reflectionBrief = getMemory('reflection', briefKey);

        const group = groupConfig('home', 'Home', ['spark', 'calendar', 'tasks', 'memory'], 'context/personal');
        const briefPrefix = reflectionBrief
          ? `Last night's reflection produced this morning brief. Surface it verbatim at the top of your response under a header "Morning Brief", then continue with the calendar overview below:\n\n"""\n${reflectionBrief}\n"""\n\n`
          : '';

        // Organic reminders: the morning brief is the once-daily home for routine
        // task surfacing (the 30-min heartbeat only does critical 24h+ overdue now).
        const taskCtx = buildMorningTaskContext();

        const response = await runAgent(group, user,
          briefPrefix +
          "Give me today's calendar overview. Use list_calendar_events (spark) so you see ALL my accounts unified (work + personal), not just primary. Cover: events, any conflicts, what I should prep for, and who I'm meeting with so I can prep." +
          taskCtx.text
        );
        await sendMessage(personalTarget, response);

        // Mark what we handed the agent so the decay ladder advances; retire the
        // decision items so they leave the rotation until touched.
        for (const t of taskCtx.surfaced) markTaskSurfaced(t.id);
        for (const t of taskCtx.retired) { markTaskSurfaced(t.id); markTaskRetired(t.id); }

        // Clear the brief after delivery so a missed reflection tomorrow doesn't surface stale content.
        if (reflectionBrief) deleteMemory('reflection', briefKey);
      } catch (err) {
        console.error('[Scheduler] Calendar prep failed:', err);
      }
    }, { timezone: 'America/New_York' });
  }

  // (Removed: 3x weekday meeting-prep cron — heartbeat covers this every 30 min with finer granularity.)
  // (Removed: 3pm logistics ping — overlapped with 8am calendar prep and 6pm evening wrap.)

  const adminTarget = process.env.GROUP_ADMIN || getDefaultRecipient();

  // Evening wrap-up → Admin group (6:00 PM ET weekdays)
  if (adminTarget) {
    cron.schedule('0 18 * * 1-5', async () => {
      console.log('[Scheduler] Evening wrap-up');
      try {
        const group = groupConfig('admin', 'Admin', ['calendar', 'github', 'memory'], 'context/admin');
        const response = await runAgent(group, user,
          `Evening wrap-up. Give me a quick end-of-day summary:

1. Tomorrow's calendar preview — any early meetings I should prep for tonight?
2. Any pending tasks or follow-ups I should be aware of? Check memory for assigned human tasks.
3. Quick wins: anything small I could knock out tonight to start tomorrow clean?

Keep it concise — I'm winding down.`
        );
        await sendMessage(adminTarget, response);
      } catch (err) {
        console.error('[Scheduler] Evening wrap-up failed:', err);
      }
    }, { timezone: 'America/New_York' });
  }

  // ============================================================
  // WEEKLY WORKFLOWS
  // ============================================================

  // Weekly household overview → personal DM (Sunday 9:00 AM ET)
  if (personalTarget) {
    cron.schedule('0 9 * * 0', async () => {
      console.log('[Scheduler] Weekly household overview');
      try {
        const group = groupConfig('home', 'Home', ['calendar', 'tasks', 'household', 'memory'], 'context/personal');
        const response = await runAgent(group, user,
          "Give me the weekly household overview: upcoming tasks, events for the week, any household inventory notes, and any pending human tasks. Flag any scheduling conflicts for the week ahead."
        );
        await sendMessage(personalTarget, response);
      } catch (err) {
        console.error('[Scheduler] Household overview failed:', err);
      }
    }, { timezone: 'America/New_York' });
  }

  // Weekly work priority brief → Job Search group (Monday 8:00 AM ET)
  const jobTarget = process.env.GROUP_JOB_SEARCH || getDefaultRecipient();
  if (jobTarget) {
    cron.schedule('0 8 * * 1', async () => {
      console.log('[Scheduler] Weekly work priority brief');
      try {
        const group = groupConfig('job-search', 'Job Search', ['career-os', 'github', 'memory'], 'context/job-search');
        const response = await runAgent(group, user,
          "Give me the weekly job search brief: list recent JD analyses from context/job-search/analyses/, any follow-ups due, and suggested priorities for this week. Check memory for any pending outreach or interview prep needed."
        );
        await sendMessage(jobTarget, response);
      } catch (err) {
        console.error('[Scheduler] Work brief failed:', err);
      }
    }, { timezone: 'America/New_York' });
  }

  // Weekly GitHub commit summary → Admin (Friday 5:00 PM ET)
  if (adminTarget) {
    cron.schedule('0 17 * * 5', async () => {
      console.log('[Scheduler] Weekly git summary');
      try {
        const group = groupConfig('admin', 'Admin', ['github', 'memory'], 'context/admin');
        const repos = process.env.SECONDBRAIN_ALLOWED_REPOS || process.env.BROWNBOT_ALLOWED_REPOS || 'secondbrain';
        const response = await runAgent(group, user,
          `Give me a commit summary for the past week across these repos: ${repos}. Use git_commit_summary for each. Save a memory checkpoint with the highlights.`
        );
        await sendMessage(adminTarget, response);
      } catch (err) {
        console.error('[Scheduler] Git summary failed:', err);
      }
    }, { timezone: 'America/New_York' });
  }

  // Weekly financial summary → Finance group (Sunday 10:00 AM ET)
  // (financeTarget is declared up in the daily section.)
  if (financeTarget) {
    cron.schedule('0 10 * * 0', async () => {
      console.log('[Scheduler] Weekly financial summary');
      try {
        // Pull fresh Plaid data before summarizing so the weekly snapshot is live.
        await syncPlaidTransactions(30);
        const group = groupConfig('finance', 'Finance', ['finance', 'memory'], 'context/finance');
        const response = await runAgent(group, user,
          `Give me a weekly financial summary: account balances, budget status, and any notable spending patterns.

Also persist the headline numbers as metric facts so the reflection job + future prompts can retrieve them. Use save_fact with fact_type='metric' and valid_until = ${nextSundayIso()} (7 days from now, so each week's snapshot auto-expires when superseded). At minimum capture:
- subject='bmm', predicate='runway_months', object=<number>
- subject='bmm', predicate='monthly_burn', object=<dollar amount>
- subject='bmm', predicate='total_balance', object=<dollar amount>

Save a memory checkpoint too for the longer narrative.`
        );
        await sendMessage(financeTarget, response);
      } catch (err) {
        console.error('[Scheduler] Finance summary failed:', err);
      }
    }, { timezone: 'America/New_York' });
  }

  // Weekly work/project brief → Work group (Monday 9:00 AM ET)
  const workTarget = process.env.GROUP_WORK || getDefaultRecipient();
  if (workTarget) {
    cron.schedule('0 9 * * 1', async () => {
      console.log('[Scheduler] Weekly work brief');
      try {
        const group = groupConfig('work', 'Work', ['github', 'memory'], 'context/work');
        const response = await runAgent(group, user,
          "Give me a weekly work/project brief: recent commits to my active repos, any context updates, and check memory for any product decisions or notes from last week."
        );
        await sendMessage(workTarget, response);
      } catch (err) {
        console.error('[Scheduler] Work brief failed:', err);
      }
    }, { timezone: 'America/New_York' });
  }

  // Weekly task scheduling → Admin (Sunday 8:00 PM ET)
  if (adminTarget) {
    cron.schedule('0 20 * * 0', async () => {
      console.log('[Scheduler] Weekly task scheduling');
      try {
        const group = groupConfig('admin', 'Admin', ['calendar', 'tasks', 'memory'], 'context/admin');
        const response = await runAgent(group, user,
          `Plan my week — schedule all open unscheduled tasks for Monday through Friday.
Follow the task-scheduling skill. Present the proposed schedule and save it to memory as "weekly_schedule_proposal" so I can review it Monday morning.`
        );
        await sendMessage(adminTarget, response);
      } catch (err) {
        console.error('[Scheduler] Weekly task scheduling failed:', err);
      }
    }, { timezone: 'America/New_York' });
  }

  // Evening health check-in → Health group (9:00 PM ET). Casual, brief.
  const healthTarget = process.env.GROUP_HEALTH;
  if (healthTarget) {
    cron.schedule('0 21 * * *', async () => {
      console.log('[Scheduler] Health evening check-in');
      try {
        const group = groupConfig('health', 'Health', ['memory', 'tasks', 'people'], 'context/health');
        const response = await runAgent(group, user,
          "Evening health check-in. Ask casually about today's workout, meals, and energy/mood. Keep it brief — one or two questions, no lecture. If recent memory shows a streak or pattern, lead with that."
        );
        await sendMessage(healthTarget, response);
      } catch (err) {
        console.error('[Scheduler] Health check-in failed:', err);
      }
    }, { timezone: 'America/New_York' });
  }

  // Daily "I'm alive" ping → personal DM (9:00 AM ET). Surfaces brain stats so
  // a silent failure (cron dead, db locked, BMM down) is visible the same day.
  if (personalTarget) {
    cron.schedule('0 9 * * *', async () => {
      console.log('[Scheduler] Daily alive ping');
      try {
        const msg = formatAlivePing(runHealthCheck());
        await sendMessage(personalTarget, msg);
      } catch (err) {
        console.error('[Scheduler] Alive ping failed:', err);
      }
    }, { timezone: 'America/New_York' });
  }

  // ============================================================
  // NIGHTLY REFLECTION (the cross-domain pass)
  // ============================================================

  // Runs silently at 22:00 ET. Reads everything new since the last reflection,
  // extracts durable facts, and stages a morning brief keyed to tomorrow's date.
  // The 06:30 calendar prep above reads that key and prepends the brief.
  cron.schedule('0 22 * * *', async () => {
    console.log('[Scheduler] Nightly reflection');
    try {
      const lastRun = getMemory('reflection', 'last_reflection_at')
        || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const messages = getMessagesSince(lastRun);

      // Cap per-group input volume — 24h × N groups × MAX_TURNS thinking is heavy.
      const PER_GROUP_CAP = 50;
      const PER_MESSAGE_CHAR_CAP = 500;
      const byGroup = new Map<string, MessageRow[]>();
      for (const m of messages) {
        const arr = byGroup.get(m.group_id) ?? [];
        arr.push(m);
        byGroup.set(m.group_id, arr);
      }

      const sections: string[] = [];
      for (const [gKey, msgs] of byGroup) {
        const recent = msgs.length > PER_GROUP_CAP ? msgs.slice(-PER_GROUP_CAP) : msgs;
        const omitted = msgs.length - recent.length;
        sections.push(`\n## ${gKey} (${recent.length}/${msgs.length} messages${omitted > 0 ? `, oldest ${omitted} trimmed` : ''})`);
        for (const m of recent) {
          const content = m.content.length > PER_MESSAGE_CHAR_CAP
            ? `${m.content.slice(0, PER_MESSAGE_CHAR_CAP)}…`
            : m.content;
          sections.push(`[${m.created_at}] ${m.role}: ${content}`);
        }
      }

      const targetDate = tomorrowDateET();
      const activityBlock = sections.length === 0
        ? '(no activity since last reflection)'
        : sections.join('\n');

      // The morning brief is staged to a memory key (consumed by the 06:30
      // calendar prep) AND saved as a durable reflection fact. The memory key
      // gets deleted after delivery; the fact persists for 30 days so the
      // Saturday content drafter has substrate to pull from. The 30-day TTL
      // keeps stale briefs from polluting Relevant-Knowledge retrieval.
      const reflectionFactExpiresAt = new Date(Date.now() + 30 * 86400 * 1000)
        .toISOString()
        .slice(0, 19)
        .replace('T', ' ');

      const prompt = `Nightly reflection — see context/reflection/CLAUDE.md for instructions.

Today is ${todayDateET()}. The morning brief you produce should be saved to memory key 'morning_brief_${targetDate}' (tomorrow's date in ET) so the 06:30 ET calendar prep tomorrow can prepend it. Use the remember tool with that exact key.

Goals (recap):
1. save_fact for durable facts in the activity below (commitments, decisions, metrics, new people).
2. Surface 1–3 non-obvious cross-domain connections.
3. remember(key='morning_brief_${targetDate}', value=<brief, ≤600 chars>).
4. ALSO save the same brief as a durable fact (for the Saturday content drafter):
   save_fact({
     subject: 'self',
     predicate: 'reflection_brief_${targetDate}',
     object: <same brief text>,
     fact_type: 'fact',
     source: 'reflection',
     valid_until: '${reflectionFactExpiresAt}'
   })
   The 30-day TTL means it survives the 06:30 memory-key delete but ages out
   of FTS retrieval, so old briefs don't pollute future queries.

If activity is empty or trivially low-signal, save a short brief that says so — don't fabricate connections.

--- Activity since ${lastRun} ---
${activityBlock.slice(0, 50000)}`;

      await runAgent(REFLECTION_GROUP, user, prompt);

      setMemory('reflection', 'last_reflection_at', new Date().toISOString());
    } catch (err) {
      console.error('[Scheduler] Reflection failed:', err);
    }
  }, { timezone: 'America/New_York' });

  // ============================================================
  // CANAIRY — proactive critical (TIGHTEN-UP) push, every 6 hours
  // Threshold-based: fetches indicators directly and DMs only on the
  // critical 2+-red condition. Does NOT call runAgent, so it costs no
  // Claude tokens. Ad-hoc questions go through the canairy_* tools.
  // ============================================================
  if (getDefaultRecipient()) {
    cron.schedule('0 */6 * * *', () => { void canairyCriticalCheck(); }, { timezone: 'America/New_York' });
  }

  console.log('[Scheduler] All cron jobs registered (daily + weekly + nightly reflection + canairy)');
}

const CANAIRY_MEM_GROUP = 'canairy';
const CANAIRY_MEM_KEY = 'last_alert';

/**
 * Fetch canairy warnings and DM the user only when the critical TIGHTEN-UP
 * condition (>= 2 reds) is active. Dedups via the memory table: re-pings only
 * when the set of red indicators changes, or after CANAIRY_RESURFACE_HOURS
 * (default 24h) if the same condition persists. Sends one all-clear when it lifts.
 * Exported so it can be invoked manually for testing.
 */
export async function canairyCriticalCheck(): Promise<void> {
  const target = getDefaultRecipient();
  if (!target) return;

  const w = await getCanairyWarnings();
  if (!w.ok) {
    console.warn('[Scheduler] Canairy check skipped:', w.error);
    return;
  }

  const resurfaceHours = parseNumEnv('CANAIRY_RESURFACE_HOURS', 24);
  const signature = w.red.map((i) => i.id).sort().join(',');
  const prevRaw = getMemory(CANAIRY_MEM_GROUP, CANAIRY_MEM_KEY);
  const prev = prevRaw ? (JSON.parse(prevRaw) as { sig: string; at: number }) : null;

  if (w.tightenUp) {
    const changed = !prev || prev.sig !== signature;
    const stale = prev ? Date.now() - prev.at >= resurfaceHours * 3_600_000 : true;
    if (changed || stale) {
      await sendMessage(target, formatTightenUpAlert(w));
      setMemory(CANAIRY_MEM_GROUP, CANAIRY_MEM_KEY, JSON.stringify({ sig: signature, at: Date.now() }));
      console.log(`[Scheduler] Canairy TIGHTEN-UP alert sent (${w.counts.red} red: ${signature})`);
    } else {
      console.log('[Scheduler] Canairy TIGHTEN-UP unchanged — suppressed (dedup).');
    }
  } else if (prev) {
    await sendMessage(target, `🐦✅ Canairy all-clear — TIGHTEN-UP lifted. Now ${w.counts.red} red / ${w.counts.amber} amber / ${w.counts.green} green.`);
    deleteMemory(CANAIRY_MEM_GROUP, CANAIRY_MEM_KEY);
    console.log('[Scheduler] Canairy all-clear sent.');
  } else {
    console.log(`[Scheduler] Canairy nominal (${w.counts.red} red / ${w.counts.amber} amber).`);
  }
}
