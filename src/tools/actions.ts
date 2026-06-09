// Tier 2 Phase 1 — Actions layer: propose → confirm → execute, gated.
//
// The agent only ever sees these four tools. The actual executors (browser
// reorder, and later bookings / calls) live in EXECUTORS and run INSIDE
// confirm_action — they are deliberately NOT registered as agent-callable
// tools, so there is no path to "just run it" that bypasses the confirm gate.
//
// Routing grammar (taught in context/admin/CLAUDE.md, same #namespace:N family
// as tasks / facts / people):
//   go #action:N            → confirm_action({id:N})
//   edit #action:N <change> → confirm_action({id:N, edits:{...}})
//   cancel #action:N        → cancel_action({id:N})

import type { ToolDef, ToolContext } from './index.js';
import {
  proposeAction, confirmAction, cancelAction, getAction, listPendingActions,
  updateActionProposal, markActionExecuting, markActionDone, markActionFailed,
  type Action,
} from '../db.js';
import { checkActionsEnabled, checkSpendCap } from '../lib/spend-cap.js';
import { runBrowserReorder } from './browser-reorder.js';

type ExecutorResult = { outcome: string; outcome_url?: string; actual_cost_cents: number };
type Executor = (action: Action) => Promise<ExecutorResult>;

// The only executor in slice 1. Add bookings / calls here in later phases.
const EXECUTORS: Record<string, Executor> = {
  browser_reorder: runBrowserReorder,
};

function usd(cents: number | null | undefined): string {
  if (cents == null) return 'free';
  return `$${(cents / 100).toFixed(2)}`;
}

// The exact string the agent should DM the user. Keep the reply hints verbatim.
function dmFormat(a: Action): string {
  const cost = a.estimated_cost_cents != null ? `, est. ${usd(a.estimated_cost_cents)}` : '';
  const rev = a.reversible ? ' (reversible)' : ' (NOT reversible)';
  return `Action #${a.id}: ${a.summary}${cost}${rev}.\nReply \`go #action:${a.id}\` to execute, \`edit #action:${a.id} <change>\` to adjust, or \`cancel #action:${a.id}\` to drop.`;
}

export const actionTools: ToolDef[] = [
  {
    definition: {
      name: 'propose_action',
      description: `Propose a real-world action that spends money or commits to a person (an order, booking, or reschedule) — DO NOT execute it. This stages the action behind a confirmation gate; the user must reply "go #action:N" before anything runs. USE WHEN: the user asks you to order/reorder/buy something, book or reschedule, or otherwise take an action with a cost or an outside commitment. After calling this, DM the user the exact dm_format string returned. NEVER try to place the order yourself with the browser tool — propose it.`,
      input_schema: {
        type: 'object' as const,
        properties: {
          kind: { type: 'string', description: 'Category of action', enum: ['reorder', 'booking', 'call'] },
          tool_name: { type: 'string', description: 'Executor that will run this on confirm. Slice 1 supports only "browser_reorder".', enum: ['browser_reorder'] },
          summary: { type: 'string', description: 'One-line human-readable description, e.g. "Reorder paper towels from Amazon"' },
          payload: { type: 'object', description: 'Executor args, frozen at propose time. For browser_reorder: {store, item_url, quantity, max_price_cents, and optional site selectors}.' },
          estimated_cost_cents: { type: 'number', description: 'Best estimate of total cost in cents (e.g. 2418 for $24.18). Omit for a free action. The executor aborts if the live total drifts >5% from this.' },
          reversible: { type: 'boolean', description: 'Whether the action can be undone (a refundable order = true; a non-refundable booking = false). Default false.' },
          category: { type: 'string', description: 'Optional free-text category (reserved for future per-category limits).' },
        },
        required: ['kind', 'tool_name', 'summary', 'payload'],
      },
    },
    handler: async (input, context?: ToolContext) => {
      const { kind, tool_name, summary, payload, estimated_cost_cents, reversible, category } = input as {
        kind: string; tool_name: string; summary: string; payload: Record<string, unknown>;
        estimated_cost_cents?: number; reversible?: boolean; category?: string;
      };

      const enabled = checkActionsEnabled();
      if (!enabled.ok) return enabled.reason!;

      if (!EXECUTORS[tool_name]) {
        return `Unknown executor "${tool_name}". Supported in this version: ${Object.keys(EXECUTORS).join(', ')}.`;
      }

      const estCents = estimated_cost_cents ?? null;
      const cap = checkSpendCap(estCents);
      if (!cap.ok) return cap.message;

      const id = proposeAction({
        kind,
        tool_name,
        summary,
        payload_json: JSON.stringify(payload ?? {}),
        estimated_cost_cents: estCents,
        reversible: !!reversible,
        category: category ?? null,
        created_by_group: context?.groupKey || 'admin',
      });
      const row = getAction(id)!;
      return dmFormat(row);
    },
  },
  {
    definition: {
      name: 'confirm_action',
      description: `Confirm a pending action so it executes — this is the "go #action:N" path. Re-checks the kill switch and spend cap, then runs the executor and reports the outcome. To EDIT a pending proposal instead of running it (the "edit #action:N" path), pass "edits" (and optionally a new summary / estimated_cost_cents); the action stays pending and a fresh proposal is returned for the user to confirm.`,
      input_schema: {
        type: 'object' as const,
        properties: {
          id: { type: 'number', description: 'Action id (the N in #action:N)' },
          edits: { type: 'object', description: 'Optional partial payload to merge into the frozen payload (e.g. {quantity: 2}). If present, the action is re-proposed, NOT executed.' },
          summary: { type: 'string', description: 'Optional new summary (only used alongside edits / a re-estimate).' },
          estimated_cost_cents: { type: 'number', description: 'Optional new cost estimate in cents (use when an edit changes the price).' },
        },
        required: ['id'],
      },
    },
    handler: async (input) => {
      const { id, edits, summary, estimated_cost_cents } = input as {
        id: number; edits?: Record<string, unknown>; summary?: string; estimated_cost_cents?: number;
      };

      const enabled = checkActionsEnabled();
      if (!enabled.ok) return enabled.reason!;

      const row = getAction(id);
      if (!row) return `Action #${id} not found.`;
      if (row.status !== 'proposed') {
        return `Action #${id} is "${row.status}", not pending — nothing to confirm. (Propose a new one if you want to run it again.)`;
      }

      const isEdit = edits !== undefined || summary !== undefined || estimated_cost_cents !== undefined;
      if (isEdit) {
        const merged = { ...JSON.parse(row.payload_json), ...(edits ?? {}) };
        const newEst = estimated_cost_cents !== undefined ? estimated_cost_cents : row.estimated_cost_cents;
        const cap = checkSpendCap(newEst);
        if (!cap.ok) return cap.message;
        updateActionProposal(id, {
          payload_json: JSON.stringify(merged),
          summary: summary ?? row.summary,
          estimated_cost_cents: newEst,
        });
        return dmFormat(getAction(id)!);
      }

      // Execute path. Re-check the cap — other actions may have spent budget
      // between propose and now.
      const cap = checkSpendCap(row.estimated_cost_cents);
      if (!cap.ok) return cap.message;

      const executor = EXECUTORS[row.tool_name];
      if (!executor) {
        markActionFailed(id, `no executor for ${row.tool_name}`);
        return `Action #${id} failed: no executor registered for "${row.tool_name}".`;
      }

      confirmAction(id);
      markActionExecuting(id);
      try {
        const result = await executor(getAction(id)!);
        markActionDone(id, result);
        const link = result.outcome_url ? `\n${result.outcome_url}` : '';
        return `✅ Action #${id} done — ${result.outcome} (charged ${usd(result.actual_cost_cents)}).${link}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        markActionFailed(id, msg);
        if (msg.startsWith('human_handoff_needed')) {
          return `⚠️ Action #${id} needs you: ${msg.replace('human_handoff_needed:', '').trim()} Nothing was charged.`;
        }
        if (msg.startsWith('price_drift')) {
          return `⚠️ Action #${id} aborted — ${msg.replace('price_drift:', '').trim()} Re-propose at the current price if you still want it.`;
        }
        return `❌ Action #${id} failed: ${msg}. Nothing was charged.`;
      }
    },
  },
  {
    definition: {
      name: 'cancel_action',
      description: 'Drop a pending action — the "cancel #action:N" path. Only works while the action is still pending (proposed). USE WHEN: the user declines a proposed action.',
      input_schema: {
        type: 'object' as const,
        properties: {
          id: { type: 'number', description: 'Action id (the N in #action:N)' },
        },
        required: ['id'],
      },
    },
    handler: async (input) => {
      const { id } = input as { id: number };
      const row = getAction(id);
      if (!row) return `Action #${id} not found.`;
      const cancelled = cancelAction(id);
      if (!cancelled) return `Action #${id} is "${row.status}", not pending — can't cancel.`;
      return `Action #${id} cancelled.`;
    },
  },
  {
    definition: {
      name: 'list_pending_actions',
      description: 'List actions awaiting confirmation. USE WHEN: the user asks "what\'s pending", "any actions waiting", or you need to check before proposing a duplicate.',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    },
    handler: async () => {
      const pending = listPendingActions();
      if (pending.length === 0) return 'No pending actions.';
      return pending.map((a) => `#action:${a.id}: ${a.summary} (${usd(a.estimated_cost_cents)}${a.reversible ? ', reversible' : ''}) — proposed ${a.proposed_at}`).join('\n');
    },
  },
];
