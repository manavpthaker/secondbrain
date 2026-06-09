import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { transcribeAudio } from '../transcribe.js';
import { logIMessage } from '../db.js';
import { getProfileConfig, getOwner } from '../config.js';

const exec = promisify(execFile);

const TRIGGER = (process.env.TRIGGER_WORD || getProfileConfig().triggerWord).toLowerCase();
const CHAT_DB_PATH = `${homedir()}/Library/Messages/chat.db`;

export function getDefaultRecipient(): string | null {
  const ownerPhoneEnv = getOwner().phoneEnv || 'USER_OWNER';
  return process.env.DM_RECIPIENT || process.env[ownerPhoneEnv] || null;
}
const POLL_INTERVAL_MS = 2000;
const APPLE_EPOCH_OFFSET = 978307200;

// chat.db `message.date` is nanoseconds since 2001-01-01 on modern macOS
// (older versions stored seconds). Convert either to a Unix ISO timestamp.
function appleDateToISO(date: number): string {
  if (!date) return new Date(0).toISOString();
  const ms2001 = date > 1e12 ? date / 1e6 : date * 1000; // ns vs s
  return new Date(ms2001 + APPLE_EPOCH_OFFSET * 1000).toISOString();
}

export type ImageData = {
  base64: string;
  mimetype: string;
};

export type DocumentData = {
  base64: string;
  mimetype: string;
};

type MessageHandler = (msg: {
  remoteJid: string;
  senderJid: string;
  text: string;
  image?: ImageData;
  document?: DocumentData;
}) => Promise<void>;

// Apple stores iMessage voice memos as Core Audio (.caf); other clips may be m4a/amr/etc.
const SUPPORTED_IMAGE = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
// Most iMessage photos arrive as HEIC (Claude vision can't read it). Convert with sips,
// which ships with macOS. Absolute path: launchd's PATH may be minimal.
const SIPS_BIN = process.env.SIPS_BIN || '/usr/bin/sips';

// Convert an unsupported image (heic/heic-sequence/tiff/avif/...) to a base64 JPEG via
// sips. Returns null on failure so the caller can skip without crashing the poll loop.
function convertImageToJpegBase64(filePath: string, rowId: number): string | null {
  const tmpPath = join(tmpdir(), `brownbot-img-${rowId}-${Date.now()}.jpg`);
  try {
    execFileSync(SIPS_BIN, ['-s', 'format', 'jpeg', filePath, '--out', tmpPath], {
      stdio: 'ignore',
    });
    const base64 = readFileSync(tmpPath).toString('base64');
    console.log(`[iMessage] Converted image → JPEG via sips: ${filePath}`);
    return base64;
  } catch (err) {
    console.warn(`[iMessage] Image convert failed for ${filePath}:`, err instanceof Error ? err.message : err);
    return null;
  } finally {
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
  }
}

let onMessage: MessageHandler;
let lastMessageRowId = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let chatDb: InstanceType<typeof Database> | null = null;

export function setMessageHandler(handler: MessageHandler) {
  onMessage = handler;
}

async function runAppleScript(script: string): Promise<string> {
  const { stdout } = await exec('osascript', ['-e', script]);
  return stdout.trim();
}

function escapeForAppleScript(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function isGroupChat(identifier: string): boolean {
  // Group chats: "chat..." prefix, "iMessage;+;chat..." prefix, or hex UUID (e.g. "ce51a40a...")
  if (identifier.startsWith('chat') || identifier.startsWith('iMessage;+;chat')) return true;
  // Hex UUIDs from iMessage group chats (not a phone number, not an email)
  if (!identifier.startsWith('+') && !identifier.includes('@') && /^[a-f0-9]{20,}$/.test(identifier)) return true;
  return false;
}

function isDM(identifier: string): boolean {
  if (identifier.startsWith('+')) return true;
  if (identifier.startsWith('chat') || identifier.startsWith('iMessage;')) return false;
  if (identifier.includes('@') && !identifier.startsWith('chat')) return true;
  return false;
}

export async function sendMessage(recipient: string, text: string) {
  const escaped = escapeForAppleScript(text);

  const MAX_CHUNK = 15000;
  const chunks: string[] = [];
  for (let i = 0; i < escaped.length; i += MAX_CHUNK) {
    chunks.push(escaped.slice(i, i + MAX_CHUNK));
  }

  for (const chunk of chunks) {
    try {
      if (isGroupChat(recipient)) {
        // AppleScript chat IDs use "any;+;" or "iMessage;+;" prefix — try common prefixes
        const chatId = recipient.includes(';') ? recipient : `any;+;${recipient}`;
        await runAppleScript(
          `tell application "Messages" to send "${chunk}" to chat id "${chatId}"`
        );
      } else {
        await runAppleScript(
          `tell application "Messages"
  set targetService to 1st account whose service type = iMessage
  set targetBuddy to buddy "${recipient}" of targetService
  send "${chunk}" to targetBuddy
end tell`
        );
      }
    } catch (err) {
      console.error(`[iMessage] Failed to send to ${recipient}:`, err);
      throw err;
    }

    if (chunks.length > 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

type LoadedAttachments = {
  image?: ImageData;
  document?: DocumentData;
  audioPath?: string;
};

// Pull the first image, PDF, and audio attachment off a message (one of each, at most).
function loadAttachments(messageRowId: number): LoadedAttachments {
  const result: LoadedAttachments = {};
  if (!chatDb) return result;

  try {
    const rows = chatDb.prepare(`
      SELECT a.filename, a.mime_type
      FROM message_attachment_join maj
      JOIN attachment a ON maj.attachment_id = a.ROWID
      WHERE maj.message_id = ?
      AND (
        a.mime_type LIKE 'image/%'
        OR a.mime_type LIKE 'audio/%'
        OR a.mime_type = 'application/pdf'
      )
    `).all(messageRowId) as Array<{ filename: string | null; mime_type: string | null }>;

    for (const att of rows) {
      if (!att.filename) continue;
      const filePath = att.filename.replace(/^~/, homedir());
      if (!existsSync(filePath)) continue;

      const mime = att.mime_type || '';

      if (mime.startsWith('image/') && !result.image) {
        if (SUPPORTED_IMAGE.includes(mime)) {
          result.image = { base64: readFileSync(filePath).toString('base64'), mimetype: mime };
        } else {
          // HEIC and friends: convert to JPEG via sips rather than dropping the image.
          const base64 = convertImageToJpegBase64(filePath, messageRowId);
          if (base64) result.image = { base64, mimetype: 'image/jpeg' };
        }
      } else if (mime === 'application/pdf' && !result.document) {
        result.document = { base64: readFileSync(filePath).toString('base64'), mimetype: mime };
      } else if (mime.startsWith('audio/') && !result.audioPath) {
        // Transcribed lazily in the async handler (whisper.cpp is slow-ish).
        result.audioPath = filePath;
      }
    }
  } catch (err) {
    console.error('[iMessage] Attachment load error:', err);
  }

  return result;
}

// Handles transcription and a few placeholder fallbacks, then forwards to the handler.
async function dispatchMessage(args: {
  chatId: string;
  senderHandle: string;
  cleaned: string;
  image?: ImageData;
  document?: DocumentData;
  audioPath?: string;
}): Promise<void> {
  const { chatId, senderHandle, cleaned, image, document, audioPath } = args;
  let text = cleaned;

  if (audioPath) {
    const transcript = await transcribeAudio(audioPath);
    if (transcript) {
      console.log(`[iMessage] 🎙️ transcribed: "${transcript.slice(0, 80)}"`);
      // Prepend any typed caption, then the voice transcript.
      text = text ? `${text}\n\n[Voice message]: ${transcript}` : transcript;
    } else if (!text && !image && !document) {
      // Couldn't transcribe and there's nothing else to act on.
      text = "(I received a voice message but couldn't transcribe it.)";
    }
  }

  if (!text) {
    if (image) text = 'What is this image?';
    else if (document) text = 'What is in this document?';
  }

  try {
    await onMessage({ remoteJid: chatId, senderJid: senderHandle, text, image, document });
  } catch (err) {
    console.error('[iMessage] Handler error:', err);
  }
}

function pollMessages() {
  if (!chatDb || !onMessage) return;

  try {
    const messages = chatDb.prepare(`
      SELECT
        m.ROWID,
        m.text,
        m.date,
        m.is_from_me,
        h.id as sender_handle,
        c.chat_identifier as chat_id,
        c.display_name as chat_name
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
      LEFT JOIN chat c ON cmj.chat_id = c.ROWID
      WHERE m.ROWID > ?
      ORDER BY m.ROWID ASC
    `).all(lastMessageRowId) as Array<{
      ROWID: number;
      text: string | null;
      date: number;
      is_from_me: number;
      sender_handle: string | null;
      chat_id: string | null;
      chat_name: string | null;
    }>;

    for (const msg of messages) {
      lastMessageRowId = msg.ROWID;

      const text = msg.text || '';

      const senderHandle = msg.sender_handle || '';
      const chatId = msg.chat_id || senderHandle;

      if (!chatId) continue; // can't attribute a chat → skip

      // Phase 5: passive ingestion. Log every message (both directions, all
      // chats) BEFORE any trigger gating — observing and replying are separate
      // decisions now. Outgoing rows have an empty sender_handle, which is why
      // this runs before the senderHandle guard below.
      try {
        logIMessage({
          rowid_src: msg.ROWID,
          chat_id: chatId,
          chat_name: msg.chat_name,
          sender: msg.is_from_me ? 'me' : senderHandle,
          direction: msg.is_from_me ? 'out' : 'in',
          text,
          ts: appleDateToISO(msg.date),
        });
      } catch (err) {
        console.error('[iMessage] imessage_log write failed:', err);
      }

      // Reply path below is unchanged. Never dispatch our own messages to the agent.
      if (msg.is_from_me) continue;
      if (!senderHandle) continue; // incoming needs a sender to route

      const dm = isDM(chatId);

      // DMs don't need the trigger word; group chats do
      if (!dm) {
        const triggerFound = text.toLowerCase().includes(TRIGGER);
        if (!triggerFound) continue;
      }

      // Strip trigger word and optional @ prefix (e.g., "@bb" when TRIGGER is "bb")
      const escapedTrigger = TRIGGER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const cleaned = text.replace(
        new RegExp(`@?${escapedTrigger}`, 'gi'),
        ''
      ).trim();

      const { image, document, audioPath } = loadAttachments(msg.ROWID);

      if (!cleaned && !image && !document && !audioPath) continue;

      console.log(`[iMessage] ${senderHandle}: "${cleaned.slice(0, 80)}"`);

      // Transcription is async; dispatch off the polling loop so we don't stall it.
      void dispatchMessage({ chatId, senderHandle, cleaned, image, document, audioPath });
    }
  } catch (err) {
    console.error('[iMessage] Poll error:', err);
  }
}

export function listChats(): Array<{ chatId: string; displayName: string; participants: string }> {
  const db = new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const chats = db.prepare(`
      SELECT
        c.chat_identifier as chatId,
        c.display_name as displayName,
        GROUP_CONCAT(h.id, ', ') as participants
      FROM chat c
      LEFT JOIN chat_handle_join chj ON c.ROWID = chj.chat_id
      LEFT JOIN handle h ON chj.handle_id = h.ROWID
      GROUP BY c.ROWID
      ORDER BY c.ROWID DESC
      LIMIT 50
    `).all() as Array<{ chatId: string; displayName: string; participants: string }>;
    return chats;
  } finally {
    db.close();
  }
}

export async function startIMessage() {
  console.log('[iMessage] Starting...');

  if (!existsSync(CHAT_DB_PATH)) {
    console.error(`[iMessage] chat.db not found at ${CHAT_DB_PATH}`);
    console.error('[iMessage] Make sure Messages.app is set up and Full Disk Access is granted.');
    process.exit(1);
  }

  chatDb = new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });

  // Start from the latest message (don't process old messages)
  const latest = chatDb.prepare('SELECT MAX(ROWID) as maxId FROM message').get() as { maxId: number } | undefined;
  lastMessageRowId = latest?.maxId || 0;
  console.log(`[iMessage] Starting from message ROWID ${lastMessageRowId}`);

  // Verify Messages.app can send
  try {
    await runAppleScript('tell application "Messages" to get name');
    console.log('[iMessage] Messages.app is accessible');
  } catch (err) {
    console.error('[iMessage] Cannot access Messages.app:', err);
    console.error('[iMessage] Make sure iMessage is signed in and Messages.app can be scripted.');
    process.exit(1);
  }

  // Log available chats if groups aren't configured
  const groupEnvVars = ['GROUP_ADMIN', 'GROUP_JOB_SEARCH', 'GROUP_WORK', 'GROUP_FINANCE', 'GROUP_HOME', 'GROUP_HEALTH'];
  const hasAnyGroup = groupEnvVars.some((v) => process.env[v]);
  if (!hasAnyGroup) {
    console.log('\n[iMessage] No groups configured. Available iMessage chats:');
    try {
      const chats = listChats();
      for (const chat of chats) {
        console.log(`  ${chat.chatId} — "${chat.displayName || '(unnamed)'}" [${chat.participants || 'no participants'}]`);
      }
      console.log('\n[iMessage] Add chat IDs to your .env file as GROUP_ADMIN, GROUP_HOME, etc.\n');
    } catch (err) {
      console.error('[iMessage] Could not list chats:', err);
    }
  }

  // Start polling
  pollTimer = setInterval(pollMessages, POLL_INTERVAL_MS);
  console.log(`[iMessage] Polling chat.db every ${POLL_INTERVAL_MS}ms`);
  console.log('[iMessage] Connected and ready!');
}
