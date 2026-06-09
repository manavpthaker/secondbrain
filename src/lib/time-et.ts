// Quiet-hours / ET-clock helpers, lifted from heartbeat.ts so brain-pulse,
// hygiene, and content-flywheel crons can share the same gate.

export function etHour(): number {
  return parseInt(
    new Date().toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hour12: false,
    }),
  );
}

export function isQuietHours(): boolean {
  const h = etHour();
  return h >= 21 || h < 7;
}

// ── ET calendar boundaries (Tier 2 Phase 1: spend caps) ──────────────────────
//
// SQLite stores timestamps via datetime('now') = UTC. To bound a SUM by "today
// in ET" or "this week in ET" we need the UTC instant of ET midnight, not the
// server-local one. These return real Date objects; pass through toSqliteDate
// before comparing against stored timestamps.

// "-04:00" (EDT) or "-05:00" (EST) for the given instant in America/New_York.
function etOffset(at: Date): string {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'longOffset',
  })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value || 'GMT-05:00';
  return name.replace('GMT', '') || '-05:00';
}

// ET calendar date (YYYY-MM-DD) for the given instant.
function etYmd(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

// UTC instant of 00:00 ET today.
export function startOfTodayET(): Date {
  const now = new Date();
  return new Date(`${etYmd(now)}T00:00:00${etOffset(now)}`);
}

// UTC instant of 00:00 ET on the most recent Sunday (week starts Sunday, matching
// the finance valid_until='next Sunday' convention).
export function startOfWeekET(): Date {
  const now = new Date();
  const wd = now.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
  const daysBack = idx < 0 ? 0 : idx;
  const target = new Date(now.getTime() - daysBack * 86400000);
  return new Date(`${etYmd(target)}T00:00:00${etOffset(target)}`);
}
