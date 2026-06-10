// ─────────────────────────────────────────────────────────────────────────────
// Environment variable helper with BROWNBOT_* → SECONDBRAIN_* back-compat.
//
// Reads the new SECONDBRAIN_ name first, falls back to the legacy BROWNBOT_
// name so existing .env files keep working during the transition.
// ─────────────────────────────────────────────────────────────────────────────

const warned = new Set<string>();

function warnOnce(msg: string): void {
  if (warned.has(msg)) return;
  warned.add(msg);
  console.warn(`[secondbrain] ${msg}`);
}

/**
 * Read a SECONDBRAIN_* env var with automatic BROWNBOT_* fallback.
 * Pass the full new name, e.g. `env('SECONDBRAIN_MODEL')`.
 */
export function env(key: string): string | undefined {
  const legacyKey = key.replace('SECONDBRAIN_', 'BROWNBOT_');
  const val = process.env[key] ?? process.env[legacyKey];
  if (process.env[legacyKey] && !process.env[key]) {
    warnOnce(`${legacyKey} is deprecated — rename to ${key} in your .env`);
  }
  return val;
}

/**
 * Read a SECONDBRAIN_* env var with a default, with BROWNBOT_* fallback.
 */
export function envOr(key: string, fallback: string): string {
  return env(key) ?? fallback;
}
