import Anthropic from '@anthropic-ai/sdk';

// Single lazily-initialized Anthropic client per process. The main agent and the
// router previously each held their own instance; this unifies them. (The
// launchd daemons run in separate processes, so each still gets its own
// singleton — they import this helper for consistency, not sharing.)
let client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}
