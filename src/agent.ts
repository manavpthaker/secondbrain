import Anthropic from '@anthropic-ai/sdk';
import type { GroupConfig } from './group-resolver.js';
import type { User } from './user-resolver.js';
import type { ImageData, DocumentData } from './channels/imessage.js';
import { loadSystemBlocks } from './context-resolver.js';
import { getRecentMessages, saveMessage } from './db.js';
import { toolRegistry, type ToolDef } from './tools/index.js';
import { getAnthropicClient } from './lib/anthropic.js';
import { parseStrEnv } from './lib/env.js';

const client = getAnthropicClient();

const MAX_TURNS = 25;
const MODEL = parseStrEnv('BROWNBOT_MODEL', 'claude-sonnet-4-6');
const MAX_TOKENS_DEFAULT = 8000;
const MAX_TOKENS_THINKING = 16000;
const THINKING_BUDGET = 3000;

const COMPLEX_PATTERN = /\b(plan|analyze|research|compare|design|debug|why|explain)\b/i;

function shouldThink(userMessage: string): boolean {
  if (userMessage.length > 200) return true;
  if (COMPLEX_PATTERN.test(userMessage)) return true;
  return false;
}

export type ProgressCallback = (message: string) => Promise<void>;

const TOOL_LABELS: Record<string, string> = {
  // Calendar
  list_events: '📅 Checking calendar...',
  create_event: '📅 Creating event...',
  // Web
  web_search: '🔍 Searching the web...',
  fetch_url: '🌐 Reading that page...',
  // Browser
  browser_navigate: '🌐 Opening URL...',
  browser_read_page: '🌐 Reading page content...',
  browser_click: '🌐 Interacting with page...',
  browser_input: '🌐 Filling in form...',
  browser_action: '🌐 Driving browser...',
  clip_to_facts: '📎 Clipping page...',
  // LinkedIn
  linkedin_search: '💼 Searching LinkedIn...',
  // Career / job-search knowledge base
  load_jd_rubric: '📊 Loading JD rubric...',
  load_verified_facts: '📊 Loading your background...',
  load_positioning_strategies: '📊 Loading positioning angles...',
  load_voice_calibration: '📊 Loading voice calibration...',
  save_jd_analysis: '💾 Saving analysis...',
  // GitHub
  git_commit_summary: '📦 Checking commits...',
  read_context_file: '📄 Reading context...',
  write_context_file: '📄 Writing context...',
  list_repo_files: '📄 Browsing repo...',
  // Finance
  finance_health_check: '💰 Checking finance server...',
  get_account_balances: '💰 Pulling balances...',
  get_transactions: '💰 Looking at transactions...',
  get_spending_summary: '💰 Summarizing spending...',
  sync_transactions: '💰 Syncing from Plaid...',
  get_budget_status: '💰 Checking budget...',
  // Claude Code
  spawn_claude_code: '⚡ Spawning Claude Code...',
  // Household
  read_household: '🏠 Reading household doc...',
  update_household: '🏠 Updating household doc...',
  append_household: '🏠 Adding to household doc...',
  // Memory
  remember: '🧠 Saving to memory...',
  recall: '🧠 Checking memory...',
  read_group_context: '🧠 Reading group context...',
  assign_human_task: '📌 Creating task for you...',
  memory_checkpoint: '🧠 Saving checkpoint...',
  save_fact: '🧠 Filing a fact...',
  search_facts: '🧠 Searching facts...',
  facts_about: '🧠 Pulling profile...',
  // People
  find_person: '👤 Looking up person...',
  note_about_person: '👤 Updating contact...',
  recent_interactions: '👤 Pulling interactions...',
  // Tasks
  create_task: '📌 Creating task...',
  list_tasks: '📌 Checking tasks...',
  update_task: '📌 Updating task...',
  complete_task: '✅ Completing task...',
  cancel_task: '✂️ Cancelling task...',
  snooze_task: '😴 Snoozing task...',
  get_task_summary: '📊 Summarizing tasks...',
  get_schedulable_tasks: '📌 Finding unscheduled tasks...',
  link_task_to_event: '📌 Linking task to calendar...',
  unlink_task_from_event: '📌 Unlinking task from calendar...',
  delete_event: '📅 Removing event...',
  update_event: '📅 Updating event...',
  // MCP — Instacart
  mcp_instacart_create_shoppable_recipe: '🛒 Creating recipe on Instacart...',
  mcp_instacart_search_products: '🛒 Searching Instacart...',
  mcp_instacart_search_recipes: '🛒 Finding recipes...',
  mcp_instacart_create_cart: '🛒 Building cart...',
  // MCP — Spotify
  mcp_spotify_play: '🎵 Playing music...',
  mcp_spotify_search: '🎵 Searching Spotify...',
  mcp_spotify_get_playlists: '🎵 Checking playlists...',
  mcp_spotify_get_current_track: '🎵 Checking what\'s playing...',
};

const MIN_PROGRESS_INTERVAL_MS = 2000;

export async function runAgent(
  groupConfig: GroupConfig,
  user: User,
  userMessage: string,
  image?: ImageData,
  onProgress?: ProgressCallback,
  document?: DocumentData,
): Promise<string> {
  // Two cache breakpoints: the static prefix (identity/voice/group/tools) caches
  // across messages within the 5-min TTL; the dynamic suffix (date/memory/retrieval)
  // only caches within this run's tool loop, where the blocks are byte-identical.
  const { staticPrefix, dynamic } = loadSystemBlocks(groupConfig, user, userMessage);
  const systemBlocks: Anthropic.TextBlockParam[] = [
    { type: 'text', text: staticPrefix, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: dynamic, cache_control: { type: 'ephemeral' } },
  ];

  // Load conversation history for context
  const history = getRecentMessages(groupConfig.key);
  const messages: Anthropic.MessageParam[] = history.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  // Build current message content — text + optional image / PDF document
  if (image || document) {
    const content: Anthropic.ContentBlockParam[] = [];
    if (image) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.mimetype as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          data: image.base64,
        },
      });
    }
    if (document) {
      content.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: document.base64,
        },
      });
    }
    content.push({ type: 'text', text: userMessage });
    messages.push({ role: 'user', content });
  } else {
    messages.push({ role: 'user', content: userMessage });
  }
  saveMessage(groupConfig.key, user.id, 'user', userMessage);

  // Get scoped tools for this group
  const tools = getScopedTools(groupConfig.tools);
  const toolDefs = tools.map((t) => t.definition);

  const thinkingEnabled = shouldThink(userMessage);

  let response: string = '';
  let lastProgressTime = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const result = await client.messages.create({
      model: MODEL,
      max_tokens: thinkingEnabled ? MAX_TOKENS_THINKING : MAX_TOKENS_DEFAULT,
      system: systemBlocks,
      messages,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      ...(thinkingEnabled
        ? { thinking: { type: 'enabled' as const, budget_tokens: THINKING_BUDGET } }
        : {}),
    });

    // Collect text and tool use blocks (ignore thinking blocks for response text)
    const textBlocks: string[] = [];
    const toolUseBlocks: Anthropic.ContentBlockParam[] = [];
    let hasToolUse = false;

    for (const block of result.content) {
      if (block.type === 'text') {
        textBlocks.push(block.text);
      } else if (block.type === 'tool_use') {
        hasToolUse = true;
        toolUseBlocks.push(block);
      }
      // thinking / redacted_thinking blocks pass through via messages.push(result.content)
    }

    // Add assistant message to history
    messages.push({ role: 'assistant', content: result.content });

    if (!hasToolUse) {
      response = textBlocks.join('\n');
      break;
    }

    // Execute tools and collect results
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      if (block.type !== 'tool_use') continue;

      // Send progress update (rate-limited)
      if (onProgress) {
        const now = Date.now();
        if (now - lastProgressTime >= MIN_PROGRESS_INTERVAL_MS) {
          const label = TOOL_LABELS[block.name] || `Working on ${block.name}...`;
          try {
            await onProgress(label);
          } catch {
            // Don't let progress failures break the agent loop
          }
          lastProgressTime = now;
        }
      }

      const tool = tools.find((t) => t.definition.name === block.name);
      if (!tool) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Tool "${block.name}" not available in this group.`,
          is_error: true,
        });
        continue;
      }

      try {
        const output = await tool.handler(block.input as Record<string, unknown>, { groupKey: groupConfig.key });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: typeof output === 'string' ? output : JSON.stringify(output),
        });
      } catch (err) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        });
      }
    }

    messages.push({ role: 'user', content: toolResults });

    // On the last turn, force Claude to respond with text (no more tools)
    if (turn === MAX_TURNS - 2) {
      toolDefs.length = 0;
    }
  }

  // If we still have no response, do one final call with no tools to force text output
  if (!response) {
    try {
      const finalResult = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS_DEFAULT,
        system: systemBlocks,
        messages,
      });
      for (const block of finalResult.content) {
        if (block.type === 'text') response += block.text;
      }
    } catch {
      // last resort
    }
  }

  if (response) {
    saveMessage(groupConfig.key, 'brownbot', 'assistant', response);
  }

  return response || 'Sorry, I ran out of processing steps. Try a simpler request or break it into parts.';
}

function getScopedTools(toolKeys: string[]): ToolDef[] {
  return toolKeys.flatMap((key) => toolRegistry[key] || []);
}
