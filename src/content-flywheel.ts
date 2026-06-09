import cron from 'node-cron';
import { CONTENT_GROUP } from './group-resolver.js';
import { runProactivePulse } from './lib/pulse.js';
import { parseBoolEnv } from './lib/env.js';
import { getUnreviewedDraftsCount } from './db.js';

// Tier 1 Phase 3: Content Flywheel.
//
// Saturday 10:00 ET cron. Calls the agent (CONTENT_GROUP) to gather signal,
// pick an angle, draft one LinkedIn post, save it via the `content` tools.
// The agent DMs a preview back.
//
// Drafts land in ~/brownbot-drafts/linkedin/ (outside any tracked repo, so
// sync-repos.sh never races us). the user reviews and hand-publishes.

export async function runContentFlywheel(): Promise<void> {
  await runProactivePulse<{ unreviewed: number }>({
    name: 'ContentFlywheel',
    group: CONTENT_GROUP,
    clearSentinel: 'CONTENT_THIN',
    // Always runs (the agent itself gathers the week's signal); never bails on
    // empty here. unreviewed-draft count just colors the prompt.
    gather: () => ({ unreviewed: getUnreviewedDraftsCount() }),
    buildPrompt: ({ unreviewed }) => `Weekly content drafter — see context/content/CLAUDE.md.

1. Call gather_content_signal({ days: 7 }) first.
2. From that, pick the ONE highest-signal angle of the past week.
3. Call draft_linkedin_post with a ~250-word draft. Cite source_fact_ids you grounded the post in (REQUIRED — don't fabricate metrics).
4. Reply with the draft id and a 2-line gist (angle + file path).
${unreviewed > 0 ? `\nthe user has ${unreviewed} unreviewed draft(s) already — mention them in your reply so the queue doesn't grow silently.` : ''}

If signal is thin (no reflection or JD facts from the past week), reply 'CONTENT_THIN' and nothing else.`,
  });
}

export function startContentFlywheel(): void {
  if (!parseBoolEnv('CONTENT_FLYWHEEL_ENABLED', true)) {
    console.log('[ContentFlywheel] CONTENT_FLYWHEEL_ENABLED=false — skipping registration.');
    return;
  }
  cron.schedule(
    '0 10 * * 6', // Saturday 10:00 ET
    () => {
      console.log('[ContentFlywheel] Tick');
      runContentFlywheel().catch((err) => console.error('[ContentFlywheel] Tick failed:', err));
    },
    { timezone: 'America/New_York' },
  );
  console.log('[ContentFlywheel] Registered cron: Sat 10:00 ET');
}
