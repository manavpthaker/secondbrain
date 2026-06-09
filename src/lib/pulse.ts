import { sendMessage, getDefaultRecipient } from '../channels/imessage.js';
import { runAgent } from '../agent.js';
import { isQuietHours } from './time-et.js';
import { getSystemUser } from './system-user.js';
import type { GroupConfig } from '../group-resolver.js';

// Shared harness for the proactive pulses (brain-pulse, idea-pulse,
// content-flywheel). Each previously reimplemented the same shape with subtle
// drift: enabled gate → quiet-hours bail → gather rows → bail-if-empty →
// resolve recipient → build prompt → runAgent → send unless a clear-sentinel →
// post-send/always hooks. This centralizes that flow; callers supply only the
// parts that differ.

export interface PulseSpec<G> {
  /** Log prefix, e.g. 'BrainPulse'. */
  name: string;
  /** Per-run enable flag (already parsed). Omit for always-on pulses. */
  enabled?: boolean;
  /** Synthetic group the agent runs as. */
  group: GroupConfig;
  /**
   * Gather context for this run. Return `null` to skip silently (e.g. nothing
   * to surface). The returned value is threaded into the later callbacks.
   */
  gather: () => G | null;
  /** Build the agent prompt from the gathered context. */
  buildPrompt: (ctx: G) => string;
  /** If the agent's response contains this token, suppress the DM. */
  clearSentinel: string;
  /** Runs only after a DM was actually sent (e.g. dedup bookkeeping). */
  onSent?: (ctx: G, response: string) => void;
  /**
   * Runs after the agent attempt regardless of send/error (but only when
   * `gather` returned non-null and a recipient existed) — e.g. mark-surfaced.
   */
  afterAll?: (ctx: G) => void;
}

export async function runProactivePulse<G>(spec: PulseSpec<G>): Promise<void> {
  const { name, enabled = true, group, gather, buildPrompt, clearSentinel, onSent, afterAll } = spec;

  if (!enabled) return;
  if (isQuietHours()) return;

  const ctx = gather();
  if (ctx === null || ctx === undefined) return;

  const target = getDefaultRecipient();
  if (!target) {
    console.log(`[${name}] No DM recipient configured; skipping.`);
    return;
  }

  try {
    const response = await runAgent(group, getSystemUser(), buildPrompt(ctx));
    if (response && !response.includes(clearSentinel)) {
      await sendMessage(target, response);
      onSent?.(ctx, response);
    }
  } catch (err) {
    console.error(`[${name}] runAgent failed:`, err);
  } finally {
    afterAll?.(ctx);
  }
}
