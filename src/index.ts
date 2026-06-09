import 'dotenv/config';
import { startIMessage, setMessageHandler, sendMessage } from './channels/imessage.js';
import { initUsers, resolveUser, isAllowed, getRedirectMessage } from './user-resolver.js';
import { initGroups, resolveGroup } from './group-resolver.js';
import { runAgent } from './agent.js';
import { detectMode } from './router.js';
import { createAsyncTask, completeAsyncTask, failAsyncTask } from './db.js';
import { checkBmmHealth, checkFinanceConfig } from './tools/finance.js';
import { registerMcpTools } from './tools/index.js';
import { startScheduler } from './scheduler.js';
import { startHeartbeat } from './heartbeat.js';
import { startBrainPulse } from './brain-pulse.js';
import { startIdeaPulse } from './idea-pulse.js';
import { startHygieneLoop } from './hygiene.js';
import { startContentFlywheel } from './content-flywheel.js';
import { startBrowserBridge } from './browser-bridge.js';
import { startDashboard } from './dashboard.js';

// Fixed receipt ack fired the instant a message lands, so the user knows it was
// received while the agent works. Deliberately NOT per-message generated — the
// LLM-written acks kept drifting out of context. One reliable signal beats a
// clever-but-wrong restatement. (Emoji is intentional here; the voice.md
// no-emoji rule governs the agent's actual replies, not this plumbing signal.)
const RECEIVED_ACK = '👀👍🏽';

async function main() {
  console.log('[brownbot] Starting...');

  // Initialize users and groups from .env
  initUsers();
  initGroups();

  // Check Brown Man Money health
  const bmmUp = await checkBmmHealth();
  if (bmmUp) {
    console.log('[brownbot] Brown Man Money server: healthy');
  } else {
    console.warn('[brownbot] Brown Man Money server is NOT running. Finance group will be limited.');
    console.warn('[brownbot]   Start it with: cd ~/Documents/GitHub/brown-man-money && npm start');
  }

  // Finance config guard — without these the read tools throw and the bot silently
  // serves week-old cached metric facts. Fail loud at boot instead of hiding it.
  const missingFinanceVars = checkFinanceConfig();
  if (missingFinanceVars.length) {
    console.warn(`[brownbot] ⚠️  Finance config incomplete — missing: ${missingFinanceVars.join(', ')}.`);
    console.warn('[brownbot]   Plaid live-sync + finance reads will FAIL and fall back to stale cached numbers.');
    console.warn('[brownbot]   Set these in brownbot .env (see .env.example) and restart.');
  } else {
    console.log('[brownbot] Finance config: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / BMM_USER_ID present');
  }

  // Start MCP servers (Instacart, Spotify, etc.)
  await registerMcpTools();

  // Start browser bridge (WebSocket server for Chrome extension)
  startBrowserBridge();

  // Start local brain dashboard at http://127.0.0.1:4000
  startDashboard();

  // Set up message handler
  setMessageHandler(async ({ remoteJid, senderJid, text, image, document }) => {
    // 1. Resolve user
    const user = resolveUser(senderJid);
    if (!user) {
      console.log(`[brownbot] Unknown sender: ${senderJid}`);
      return;
    }

    // 2. Resolve group
    const group = resolveGroup(remoteJid);
    if (!group) {
      console.log(`[brownbot] Unknown group: ${remoteJid}`);
      return;
    }

    // 3. Check permissions
    if (!isAllowed(user, group.key)) {
      const msg = getRedirectMessage(user, group.key);
      await sendMessage(remoteJid, msg);
      return;
    }

    console.log(`[brownbot] ${user.name} → ${group.name}: ${text.slice(0, 80)}...`);

    // 4. Classify sync vs async (Haiku, regex fallback) + fire the fixed receipt ack.
    const mode = await detectMode(text);
    await sendMessage(remoteJid, RECEIVED_ACK);

    // Progress callback — sends tool-by-tool updates to the chat
    const onProgress = async (msg: string) => {
      await sendMessage(remoteJid, msg);
    };

    if (mode === 'async') {
      const taskId = createAsyncTask(group.key, user.id, text);

      // Run in background
      runAgent(group, user, text, image, onProgress, document)
        .then(async (response) => {
          completeAsyncTask(taskId, response);
          await sendMessage(remoteJid, response);
        })
        .catch(async (err) => {
          const errMsg = `Task failed: ${err instanceof Error ? err.message : String(err)}`;
          failAsyncTask(taskId, errMsg);
          await sendMessage(remoteJid, errMsg);
        });
    } else {
      // Sync: respond directly
      try {
        const response = await runAgent(group, user, text, image, onProgress, document);
        await sendMessage(remoteJid, response);
      } catch (err) {
        const errMsg = `Error: ${err instanceof Error ? err.message : String(err)}`;
        await sendMessage(remoteJid, errMsg);
      }
    }
  });

  // Start iMessage
  await startIMessage();

  // Start scheduled jobs
  startScheduler();

  // Start heartbeat — proactive 30-min check-ins (calendar, tasks, follow-ups)
  startHeartbeat();

  // Start brain pulse — proactive 11:00 + 16:00 ET scan of stale commitments,
  // expiring facts, and dormant leads from the second brain.
  startBrainPulse();

  // Start idea pulse — proactive 10:00 + 15:00 ET ping that offers help and
  // pitches ideas grounded in current tasks / leads / recent decisions.
  startIdeaPulse();

  // Start hygiene loop — Mon 07:30 ET weekly consolidation of facts.
  startHygieneLoop();

  // Start content flywheel — Sat 10:00 ET draft from past week's brain signal.
  startContentFlywheel();

  console.log('[brownbot] Ready. Listening for iMessages.');
}

main().catch((err) => {
  console.error('[brownbot] Fatal:', err);
  process.exit(1);
});
