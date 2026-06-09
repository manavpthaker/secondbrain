import { mkdirSync, appendFileSync } from 'fs';
import { dirname } from 'path';
import { getAnthropicClient } from './anthropic.js';
import { setMemory } from '../db.js';

// Shared scaffolding for the launchd KeepAlive daemons (meeting / imessage /
// inbox-signal). Each previously duplicated the timestamped logger, the
// first-JSON extractor, the Haiku index-prefilter protocol, and the
// tick-on-interval main loop. This centralizes those.

/** Slice out the first balanced-ish JSON object/array between `open` and `close`. */
export function extractFirstJson(text: string, open: '{' | '[', close: '}' | ']'): string | null {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

/**
 * Parse a model reply that should be a JSON array of integers. Tolerates stray
 * prose with brackets (e.g. "[link]") by matching the first all-numeric array.
 */
export function parseIndexArray(text: string): number[] {
  const m = text.match(/\[[\d,\s]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((n): n is number => typeof n === 'number');
  } catch {
    return [];
  }
}

export type Logger = (msg: string) => void;

/** Create a timestamped file logger (also echoes to stdout in test mode). Ensures the log dir exists. */
export function makeLogger(logPath: string, testMode: boolean): Logger {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch {
    /* dir creation best-effort */
  }
  return (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try {
      appendFileSync(logPath, line);
    } catch {
      /* logging must never throw */
    }
    if (testMode) process.stdout.write(line);
  };
}

/**
 * Run a Haiku pre-filter that returns the subset of `items` worth the expensive
 * downstream call. `criteria` is the full instruction text (what to keep / drop);
 * the shared JSON-array protocol and the numbered list are appended here.
 */
export async function haikuPrefilter<T>(opts: {
  items: T[];
  render: (item: T, idx: number) => string;
  criteria: string;
  model: string;
  log: Logger;
  maxTokens?: number;
}): Promise<T[]> {
  const { items, render, criteria, model, log, maxTokens = 300 } = opts;
  if (!items.length) return [];

  const list = items.map((it, i) => render(it, i)).join('\n');
  const prompt = `${criteria}

Reply with ONLY a JSON array of integers, e.g. [0,3,4]. If none qualify, reply [].

${list}`;

  try {
    const res = await getAnthropicClient().messages.create({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });
    const block = res.content[0];
    const text = block && block.type === 'text' ? block.text : '';
    const picked = new Set(parseIndexArray(text));
    return items.filter((_, i) => picked.has(i));
  } catch (err) {
    log(`prefilter failed: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

/**
 * Standard single-tick daemon loop. In test mode runs one tick and returns;
 * otherwise kicks off immediately then repeats every `intervalMs`. Each tick's
 * errors are caught and logged (never crash the loop). Wrap the call in
 * `.catch()` at the entry point for fatal handling.
 */
export async function runDaemon(opts: {
  name: string;
  intervalMs: number;
  testMode: boolean;
  tick: () => Promise<void>;
  log: Logger;
}): Promise<void> {
  const { name, intervalMs, testMode, tick, log } = opts;
  log(`${name} starting${testMode ? ' (TEST MODE)' : ''}`);

  if (testMode) {
    await tick();
    log('test run complete; exiting');
    return; // test ticks never stamp — a dead daemon shouldn't look alive
  }

  // Liveness heartbeat: stamp <name>_last_tick after each successful tick so the
  // doctor (src/doctor.ts) can flag a daemon whose process has died — these run
  // as separate launchd KeepAlive processes the DB-reading checks can't see.
  const markTick = () => {
    try {
      setMemory('system', `${name}_last_tick`, new Date().toISOString());
    } catch {
      /* heartbeat stamp must never break the loop */
    }
  };

  setInterval(() => {
    tick().then(markTick).catch((err) => log(`tick threw: ${err instanceof Error ? err.message : err}`));
  }, intervalMs);
  // Kick off immediately too.
  tick().then(markTick).catch((err) => log(`initial tick threw: ${err instanceof Error ? err.message : err}`));
}
