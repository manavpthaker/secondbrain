import { existsSync, readdirSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import db, { getBrainStats, getTaskStats, factsAbout } from './db.js';
import { checkFinanceConfig } from './tools/finance.js';
import { getBotName, getProfileConfig } from './config.js';

/**
 * Health check for the live second brain. One source of truth for "is everything
 * actually live and are the proactive loops firing", so a silent failure (a dead
 * cron, an un-run seed, a stalled backup) is visible without tailing logs.
 *
 * runHealthCheck() is pure data — it reads the DB + filesystem and returns a
 * structured report. It's consumed by:
 *   - scripts/doctor.ts (npm run doctor)  → full human-readable report + exit code
 *   - scheduler.ts daily alive-ping       → surfaces any issues in the DM
 */

export type CheckStatus = 'ok' | 'warn';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface HealthReport {
  healthy: boolean;
  checks: Check[];
  issues: Check[]; // the subset with status !== 'ok'
  stats: ReturnType<typeof getBrainStats> & { overdue_tasks: number };
}

// Staleness thresholds, in hours. Each loop's cadence + a buffer.
const REFLECTION_STALE_H = 26; // nightly 22:00 ET
const BACKUP_STALE_H = 30; // nightly 03:00 ET
const DAEMON_TICK_STALE_H = 2; // KeepAlive daemons tick on the order of minutes
const SYNC_STALE_H = 1; // scripts/sync-repos.sh runs every 5 min; 1h = 12 missed clean runs

// Repo root, cwd-independent: this file compiles to dist/doctor.js, so ".." is
// the brownbot checkout the 5-min sync pulls into.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Inner-circle people the seed guarantees; their absence means the seed never
// ran. Derived from the profile config so a new operator's people are checked.
const SEEDED_PEOPLE = getProfileConfig().people.map((p) => p.name);

// A canonical marker fact the seed always writes; its presence means the seed ran.
const SEED_MARKER = { subject: '__seed__', predicate: 'ran' };

const BACKUP_DIR = join(homedir(), 'brownbot-backups');

function hoursSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 3_600_000;
}

function fmtAge(hours: number | null): string {
  if (hours === null) return 'never';
  if (hours < 1) return `${Math.round(hours * 60)}m ago`;
  if (hours < 48) return `${hours.toFixed(1)}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function checkSeededPeople(): Check {
  // No people configured in the profile — nothing to verify, treat as healthy.
  if (SEEDED_PEOPLE.length === 0) {
    return { name: 'seeded people', status: 'ok', detail: 'no inner-circle people configured' };
  }
  const placeholders = SEEDED_PEOPLE.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT name FROM people WHERE name IN (${placeholders}) COLLATE NOCASE`)
    .all(...SEEDED_PEOPLE) as { name: string }[];
  const present = new Set(rows.map((r) => r.name.toLowerCase()));
  const missing = SEEDED_PEOPLE.filter((n) => !present.has(n.toLowerCase()));
  return missing.length === 0
    ? { name: 'seeded people', status: 'ok', detail: `all ${SEEDED_PEOPLE.length} inner-circle present` }
    : { name: 'seeded people', status: 'warn', detail: `missing: ${missing.join(', ')} — run npm run seed:facts` };
}

function checkSeedFacts(): Check {
  const hit = factsAbout(SEED_MARKER.subject, 200).some((f) => f.predicate === SEED_MARKER.predicate);
  return hit
    ? { name: 'seed facts', status: 'ok', detail: `profile facts loaded` }
    : { name: 'seed facts', status: 'warn', detail: `marker fact missing — seed never ran (npm run seed:facts)` };
}

function checkReflection(lastReflection: string | null): Check {
  const age = hoursSince(lastReflection);
  if (age === null) {
    return { name: 'nightly reflection', status: 'warn', detail: 'never run — 22:00 cron may not be firing' };
  }
  if (age > REFLECTION_STALE_H) {
    return { name: 'nightly reflection', status: 'warn', detail: `last ran ${fmtAge(age)} (>${REFLECTION_STALE_H}h) — 22:00 cron may be dead` };
  }
  return { name: 'nightly reflection', status: 'ok', detail: `last ran ${fmtAge(age)}` };
}

function checkBackup(): Check {
  if (!existsSync(BACKUP_DIR)) {
    return { name: 'nightly backup', status: 'warn', detail: `${BACKUP_DIR} missing — backup never ran` };
  }
  try {
    const files = readdirSync(BACKUP_DIR).filter((f) => f.includes('brownbot.db'));
    if (files.length === 0) {
      return { name: 'nightly backup', status: 'warn', detail: 'no backup files found' };
    }
    const newest = Math.max(...files.map((f) => statSync(join(BACKUP_DIR, f)).mtimeMs));
    const age = (Date.now() - newest) / 3_600_000;
    return age > BACKUP_STALE_H
      ? { name: 'nightly backup', status: 'warn', detail: `newest ${fmtAge(age)} (>${BACKUP_STALE_H}h) — 03:00 backup may be dead` }
      : { name: 'nightly backup', status: 'ok', detail: `${files.length} backups, newest ${fmtAge(age)}` };
  } catch (err) {
    return { name: 'nightly backup', status: 'warn', detail: `unreadable: ${(err as Error).message}` };
  }
}

// Deploy freshness. The 5-min auto-sync (scripts/sync-repos.sh) is the only path
// that advances this checkout, and an uncommitted edit on this deploy target
// silently dead-locks its `git pull --ff-only`. Two independent signals catch it:
//   1. the sync stamps sync_last_success / sync_last_error into memory each run
//      (group_id='system'); an error newer than the last clean success, or a
//      stale success, means the sync is failing or has stopped running.
//   2. HEAD is behind its upstream — the most direct "deploy is stuck" signal.
//      `git pull` fetches before the ff it then rejects, so the remote-tracking
//      ref is fresh and this needs no network from the health check itself.
// Surfaces in the 09:00 alive-ping so a stuck deploy is seen by morning.
function checkSync(): Check {
  let behind: number | null = null;
  try {
    const out = execSync('git rev-list --count HEAD..@{upstream}', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const n = Number(out);
    behind = Number.isNaN(n) ? null : n;
  } catch {
    behind = null; // not a repo / no upstream — don't false-alarm
  }

  const rows = db
    .prepare(
      "SELECT key, updated_at, value FROM memory WHERE group_id = 'system' AND key IN ('sync_last_success', 'sync_last_error')",
    )
    .all() as { key: string; updated_at: string; value: string }[];
  const success = rows.find((r) => r.key === 'sync_last_success');
  const error = rows.find((r) => r.key === 'sync_last_error');
  const okAge = hoursSince(success?.updated_at);
  const errAge = hoursSince(error?.updated_at);

  // HEAD behind origin is unambiguous — lead with it and attach the reason.
  if (behind !== null && behind > 0) {
    const why = error ? ` — last error: ${error.value}` : '';
    return { name: 'deploy sync', status: 'warn', detail: `HEAD ${behind} commit(s) behind origin — auto-sync stuck${why}` };
  }

  // Neither stamp yet (fresh DB, or sync hasn't run since this shipped): the
  // git check above already covers the real risk, so don't false-alarm here.
  if (!success && !error) {
    return { name: 'deploy sync', status: 'ok', detail: 'up to date (no sync stamps yet)' };
  }

  // Last run errored: error stamp is newer than the last clean success.
  if (error && (!success || (errAge !== null && okAge !== null && errAge < okAge))) {
    return { name: 'deploy sync', status: 'warn', detail: `last sync failed ${fmtAge(errAge)}: ${error.value}` };
  }

  // Clean — but has the sync stopped stamping entirely (agent died)?
  if (okAge !== null && okAge > SYNC_STALE_H) {
    return { name: 'deploy sync', status: 'warn', detail: `last clean sync ${fmtAge(okAge)} (>${SYNC_STALE_H}h) — 5-min sync may be dead` };
  }
  return { name: 'deploy sync', status: 'ok', detail: `up to date, last clean sync ${fmtAge(okAge)}` };
}

// Daemons are separate KeepAlive processes; the DB-reading alive-ping can't see
// them die. They surface here IF they write a `<name>_last_tick` ISO into the
// memory table each tick (see TIER1-PLAN). Until they do, we report that they're
// not yet instrumented rather than firing a false alarm.
function checkDaemonTicks(): Check[] {
  const rows = db
    .prepare("SELECT key, value FROM memory WHERE key LIKE '%\\_last\\_tick' ESCAPE '\\'")
    .all() as { key: string; value: string }[];
  if (rows.length === 0) {
    return [{ name: 'daemon heartbeats', status: 'ok', detail: 'not yet instrumented (no *_last_tick keys)' }];
  }
  return rows.map((r) => {
    const label = r.key.replace(/_last_tick$/, '');
    const age = hoursSince(r.value);
    return age !== null && age > DAEMON_TICK_STALE_H
      ? { name: `daemon: ${label}`, status: 'warn' as const, detail: `last tick ${fmtAge(age)} (>${DAEMON_TICK_STALE_H}h) — process may be dead` }
      : { name: `daemon: ${label}`, status: 'ok' as const, detail: `last tick ${fmtAge(age)}` };
  });
}

// Finance config presence. The read tools go straight to the BMM Supabase DB, so
// a cleared SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / BMM_USER_ID silently routes
// the bot back to stale cached metric facts. The boot warning catches a fresh start,
// but a var cleared mid-run only surfaces here — in the 09:00 alive-ping.
function checkFinanceConfigCheck(): Check {
  const missing = checkFinanceConfig();
  return missing.length === 0
    ? { name: 'finance config', status: 'ok', detail: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / BMM_USER_ID present' }
    : { name: 'finance config', status: 'warn', detail: `missing: ${missing.join(', ')} — finance reads/sync fail, numbers go stale` };
}

export function runHealthCheck(): HealthReport {
  const stats = getBrainStats();
  const { overdue } = getTaskStats();

  const checks: Check[] = [];

  // Data presence
  checks.push(
    stats.facts_active > 0
      ? { name: 'facts store', status: 'ok', detail: `${stats.facts_active} active facts` }
      : { name: 'facts store', status: 'warn', detail: 'no active facts — DB empty or unseeded' },
  );
  checks.push(checkSeededPeople());
  checks.push(checkSeedFacts());

  // Loop liveness
  checks.push(checkReflection(stats.last_reflection));
  checks.push(checkSync());
  checks.push(...checkDaemonTicks());

  // Persistence
  checks.push(checkBackup());

  // External config
  checks.push(checkFinanceConfigCheck());

  const issues = checks.filter((c) => c.status !== 'ok');
  return {
    healthy: issues.length === 0,
    checks,
    issues,
    stats: { ...stats, overdue_tasks: overdue },
  };
}

/** Full multi-line report for the CLI. */
export function formatHealthReport(r: HealthReport): string {
  const lines: string[] = [];
  lines.push(r.healthy ? `✅ ${getBotName()} health: OK` : `⚠️  ${getBotName()} health: ${r.issues.length} issue(s)`);
  lines.push('');
  lines.push(
    `stats: ${r.stats.facts_active} facts · ${r.stats.people} people · ` +
    `${r.stats.open_tasks} open tasks (${r.stats.overdue_tasks} overdue) · ${r.stats.messages_24h} msgs/24h`,
  );
  lines.push('');
  for (const c of r.checks) {
    lines.push(`${c.status === 'ok' ? '  ✓' : '  ⚠'} ${c.name}: ${c.detail}`);
  }
  return lines.join('\n');
}

/** Compact alive-ping DM line + any issues appended. Used by the scheduler. */
export function formatAlivePing(r: HealthReport): string {
  const lastRefl = r.stats.last_reflection
    ? `last reflection ${r.stats.last_reflection.slice(0, 16).replace('T', ' ')}`
    : 'no reflection on file yet';
  const head = r.healthy ? `✅ ${getBotName()} alive` : `⚠️ ${getBotName()} alive (issues)`;
  const stat = `${r.stats.facts_active} facts · ${r.stats.people} people · ${r.stats.open_tasks} open tasks · ${r.stats.messages_24h} msgs/24h · ${lastRefl}`;
  if (r.healthy) return `${head} — ${stat}`;
  const issueLines = r.issues.map((i) => `· ${i.name}: ${i.detail}`).join('\n');
  return `${head} — ${stat}\n\nneeds attention:\n${issueLines}`;
}
