import cron from 'node-cron';
import { sendMessage, getDefaultRecipient } from './channels/imessage.js';
import { runAgent } from './agent.js';
import type { GroupConfig } from './group-resolver.js';
import { getPendingTasks, getMemory, setMemory, getOverdueTasks, getSchedulableTasks, markTaskSurfaced, type Task } from './db.js';
import { etHour, isQuietHours } from './lib/time-et.js';
import { getSystemUser } from './lib/system-user.js';

const MAX_TASKS_PER_HEARTBEAT = 5;

function groupConfig(key: string, name: string, tools: string[], contextPath: string): GroupConfig {
  return { key, name, tools, contextPath };
}

function clearOldNotifications() {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const lastClear = getMemory('system', 'last_notification_clear');
  if (lastClear !== today) {
    setMemory('system', 'last_notification_clear', today);
  }
}

function formatTaskLine(t: Task): string {
  const priority = t.priority === 'urgent' ? '🔴' : t.priority === 'high' ? '🟠' : '🟡';
  const due = t.due_date ? ` (due ${new Date(t.due_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })})` : '';
  return `${priority} #${t.id}: ${t.title}${due} → ${t.assignee}`;
}

async function heartbeatCalendarCheck() {
  if (isQuietHours()) return;
  const user = getSystemUser();
  const target = process.env.GROUP_ADMIN || process.env.GROUP_HOME || getDefaultRecipient();

  if (!target) return;

  const group = groupConfig('home', 'Home', ['calendar', 'tasks', 'memory'], 'context/personal');

  try {
    const response = await runAgent(group, user,
      `Heartbeat check — look at my calendar for the next 2 hours. Only send a message if one of these is true:

(a) A meeting starts in 15-25 minutes AND has a physical location/address — send a "time to leave" with the location.
(b) There is a hard scheduling conflict in the next 2 hours.

Otherwise respond with exactly "HEARTBEAT_CLEAR" and nothing else. Do NOT send for routine internal meetings or back-to-back syncs unless there's a conflict.

Note: external-meeting prep (30 min before) is handled by the separate meeting-daemon process; do NOT send a prep DM here.`
    );

    if (response && !response.includes('HEARTBEAT_CLEAR')) {
      await sendMessage(target, response);
    }
  } catch (err) {
    console.error('[Heartbeat] Calendar check failed:', err);
  }
}

async function heartbeatPendingAsyncCheck() {
  if (isQuietHours()) return;
  const adminGroupId = process.env.GROUP_ADMIN || getDefaultRecipient();
  if (!adminGroupId) return;

  try {
    const pending = getPendingTasks();
    if (pending.length === 0) return;

    const stale = (pending as Array<{ id: number; created_at: string; prompt: string; group_id: string }>).filter((t) => {
      const created = new Date(t.created_at).getTime();
      return Date.now() - created > 30 * 60 * 1000;
    });

    if (stale.length > 0) {
      const summary = stale
        .map((t) => `- [${t.group_id}] ${t.prompt.slice(0, 80)}...`)
        .join('\n');
      await sendMessage(adminGroupId, `Heads up — ${stale.length} async task(s) have been pending for 30+ min:\n\n${summary}`);
    }
  } catch (err) {
    console.error('[Heartbeat] Pending async check failed:', err);
  }
}

async function heartbeatSyncTasks() {
  try {
    const { reconcile } = await import('./sync/tasks-sync.js');
    const r = await reconcile();
    if (r.pushed || r.pulled || r.conflicts) {
      console.log(`[Heartbeat] Sync: pushed=${r.pushed} pulled=${r.pulled} conflicts=${r.conflicts}`);
    }
  } catch (err) {
    console.error('[Heartbeat] Task sync failed:', err);
  }
}

// Organic reminders: the 30-min heartbeat is the INTERRUPT channel, so it only
// surfaces tasks that genuinely earn an interruption — 24h+ critical overdue.
// Routine overdue / due-soon moved to the once-daily morning brief (06:30), and
// the resurface spacing now decays per task (see getOverdueTasks in db.ts), so
// even critical items space themselves out instead of pinging every pulse.
async function heartbeatTaskCheck() {
  const adminGroupId = process.env.GROUP_ADMIN || getDefaultRecipient();
  if (!adminGroupId) return;

  try {
    // getOverdueTasks already applies snooze/retire/decay filtering, so this is
    // only the subset eligible to surface right now.
    const critical = getOverdueTasks().filter((t) => {
      if (!t.due_date) return false;
      const hoursOverdue = (Date.now() - new Date(t.due_date).getTime()) / (1000 * 60 * 60);
      return hoursOverdue > 24;
    });

    if (critical.length === 0) return; // routine tasks are the morning brief's job

    const surfaced = critical.slice(0, MAX_TASKS_PER_HEARTBEAT);
    for (const t of surfaced) markTaskSurfaced(t.id);

    const moreNote = critical.length > surfaced.length
      ? `\n\n(+${critical.length - surfaced.length} more — full list in the dashboard.)`
      : '';
    const hint = '\n\nReply with #<id> + an action: "snooze #N 3 days", "cancel #N", "done #N".';
    await sendMessage(
      adminGroupId,
      `⚠️ ${surfaced.length} task(s) overdue by 24+ hours — need attention NOW:\n${surfaced.map(formatTaskLine).join('\n')}${moreNote}${hint}`,
    );
  } catch (err) {
    console.error('[Heartbeat] Task check failed:', err);
  }
}

async function heartbeatScheduleOpportunity() {
  // Run only once a day around 10am ET — running every 30 min competes with focused work.
  const h = etHour();
  if (h !== 10) return;
  const adminGroupId = process.env.GROUP_ADMIN || getDefaultRecipient();
  if (!adminGroupId) return;

  try {
    // Only suggest if there are unscheduled tasks
    const schedulable = getSchedulableTasks('owner');
    if (schedulable.length === 0) return;

    const user = getSystemUser();
    const group = groupConfig('admin', 'Admin', ['calendar', 'tasks', 'memory'], 'context/admin');

    const response = await runAgent(group, user,
      `Quick schedule check — look at my calendar for the next 3 hours. If there's a gap of 30+ minutes with no events, and I have unscheduled tasks, suggest ONE task I could work on in that gap. Use get_schedulable_tasks to find the best match.

If there are no meaningful gaps, respond with exactly "SCHEDULE_CLEAR" and nothing else.
Keep the suggestion to 2 sentences max.`
    );

    if (response && !response.includes('SCHEDULE_CLEAR')) {
      await sendMessage(adminGroupId, response);
    }
  } catch (err) {
    console.error('[Heartbeat] Schedule opportunity check failed:', err);
  }
}

export function startHeartbeat() {
  cron.schedule('0,30 * * * *', async () => {
    console.log('[Heartbeat] Pulse...');
    clearOldNotifications();

    // Sync runs FIRST so all other checks see the post-sync state (fixes "completed on phone but heartbeat still nags").
    await heartbeatSyncTasks();

    await Promise.allSettled([
      heartbeatCalendarCheck(),
      heartbeatPendingAsyncCheck(),
      heartbeatTaskCheck(),
      heartbeatScheduleOpportunity(),
    ]);

    console.log('[Heartbeat] Complete.');
  }, { timezone: 'America/New_York' });

  console.log('[Heartbeat] Started — pulsing every 30 minutes');
}
