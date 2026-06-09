import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { toSqliteDate } from './lib/dates.js';
import { startOfTodayET, startOfWeekET } from './lib/time-et.js';
import { normalizePhone } from './lib/phone.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'brownbot.db');

const db: DatabaseType = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    role TEXT NOT NULL,        -- 'user' | 'assistant'
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS async_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT DEFAULT 'pending',  -- 'pending' | 'running' | 'done' | 'failed'
    result TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS memory (
    group_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (group_id, key)
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    group_id TEXT NOT NULL,
    assignee TEXT NOT NULL DEFAULT 'owner',
    priority TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'open',
    due_date TEXT,
    source TEXT DEFAULT 'manual',
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    notes TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_async_tasks_status ON async_tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee, status);
  CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);

  -- Atomic facts: the things brownbot knows about you and your world.
  -- See SECOND-BRAIN-ROADMAP.md Phase 1 for the supersession policy.
  CREATE TABLE IF NOT EXISTS facts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    subject       TEXT NOT NULL,
    predicate     TEXT NOT NULL,
    object        TEXT NOT NULL,
    fact_type     TEXT DEFAULT 'fact',
    group_id      TEXT,
    source        TEXT DEFAULT 'manual',
    source_ref    TEXT,
    confidence    REAL DEFAULT 1.0,
    valid_until   TEXT,
    active        INTEGER DEFAULT 1,
    superseded_at TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_facts_subject    ON facts(subject COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_facts_type       ON facts(fact_type);
  CREATE INDEX IF NOT EXISTS idx_facts_subj_pred  ON facts(subject COLLATE NOCASE, predicate COLLATE NOCASE, active);

  CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
    subject, predicate, object,
    content='facts', content_rowid='id'
  );
  CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
    INSERT INTO facts_fts(rowid, subject, predicate, object)
    VALUES (new.id, new.subject, new.predicate, new.object);
  END;
  CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
    INSERT INTO facts_fts(facts_fts, rowid, subject, predicate, object)
    VALUES('delete', old.id, old.subject, old.predicate, old.object);
  END;
  CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
    INSERT INTO facts_fts(facts_fts, rowid, subject, predicate, object)
    VALUES('delete', old.id, old.subject, old.predicate, old.object);
    INSERT INTO facts_fts(rowid, subject, predicate, object)
    VALUES (new.id, new.subject, new.predicate, new.object);
  END;

  -- People graph: canonical person records + email map + interaction log.
  CREATE TABLE IF NOT EXISTS people (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    company      TEXT,
    role         TEXT,
    linkedin_url TEXT,
    relationship TEXT,
    notes        TEXT,
    last_contact TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  );
  -- Normalized email→person map so the same human arriving via Spark (personal)
  -- and Calendar (work) merges into one row, not two.
  CREATE TABLE IF NOT EXISTS person_emails (
    email     TEXT PRIMARY KEY COLLATE NOCASE,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_person_emails_pid ON person_emails(person_id);
  -- Normalized phone→person map (last-10 digits, see lib/phone.ts). Lets iMessage
  -- senders (phone handles) and Apple Contacts dedup against email-keyed rows.
  CREATE TABLE IF NOT EXISTS person_phones (
    phone     TEXT PRIMARY KEY,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_person_phones_pid ON person_phones(person_id);
  CREATE INDEX IF NOT EXISTS idx_people_linkedin   ON people(linkedin_url);
  CREATE INDEX IF NOT EXISTS idx_people_name       ON people(name COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS interactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id   INTEGER REFERENCES people(id) ON DELETE CASCADE,
    channel     TEXT,
    summary     TEXT,
    ref         TEXT,
    occurred_at TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_interactions_person ON interactions(person_id);
  CREATE INDEX IF NOT EXISTS idx_interactions_dedup  ON interactions(person_id, channel, ref);

  -- Phase 5: passive iMessage capture. Every observed message (both directions,
  -- all chats) is logged here regardless of the @brownbot trigger. The
  -- imessage-daemon reads unextracted rows and feeds the brain (facts/people/tasks).
  -- rowid_src is the chat.db ROWID; UNIQUE + INSERT OR IGNORE makes re-polling idempotent.
  CREATE TABLE IF NOT EXISTS imessage_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    rowid_src    INTEGER UNIQUE,
    chat_id      TEXT NOT NULL,
    chat_name    TEXT,
    sender       TEXT NOT NULL,           -- handle for incoming, 'me' for outgoing
    direction    TEXT NOT NULL,           -- 'in' | 'out'
    text         TEXT,
    ts           TEXT NOT NULL,           -- ISO, converted from Apple epoch
    extracted_at TEXT,                    -- NULL until the daemon processes it
    created_at   TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_imsg_extracted ON imessage_log(extracted_at, id);
  CREATE INDEX IF NOT EXISTS idx_imsg_chat      ON imessage_log(chat_id, ts);

  -- Proactive inbox-signal extraction dedup (inbox-signal-daemon).
  -- Unlike imessage_log there is no upstream poller filling this table — email
  -- lives only in Spark. The daemon enumerates a recent window from Spark and
  -- records every message_id it has SEEN here (extracted or not), so the cursor
  -- is "have we processed this message_id" rather than "id > N". message_id is
  -- Spark's per-message integer rendered as text; UNIQUE + INSERT OR IGNORE makes
  -- re-enumerating an overlapping newer_than window idempotent.
  CREATE TABLE IF NOT EXISTS email_extraction_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id    TEXT UNIQUE NOT NULL,     -- Spark message ID (the list "ID" column)
    account       TEXT,
    subject       TEXT,
    sender        TEXT,
    ts            TEXT,                      -- email date if parseable
    signal_count  INTEGER DEFAULT 0,         -- artifacts created from this email
    extracted_at  TEXT DEFAULT (datetime('now')),
    created_at    TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_email_ext_msgid ON email_extraction_log(message_id);
`);

// Safe migrations for scheduling columns (no-ops if already exist)
const schedulingMigrations = [
  'ALTER TABLE tasks ADD COLUMN duration_minutes INTEGER',
  'ALTER TABLE tasks ADD COLUMN focus_level TEXT DEFAULT \'normal\'',
  'ALTER TABLE tasks ADD COLUMN calendar_event_id TEXT',
  'ALTER TABLE tasks ADD COLUMN splittable INTEGER DEFAULT 1',
  // Google Tasks sync columns
  'ALTER TABLE tasks ADD COLUMN google_task_id TEXT',
  'ALTER TABLE tasks ADD COLUMN google_list_id TEXT',
  'ALTER TABLE tasks ADD COLUMN sync_to_google INTEGER DEFAULT 1',
  'ALTER TABLE tasks ADD COLUMN last_synced_at TEXT',
  'ALTER TABLE tasks ADD COLUMN updated_at TEXT',
  // Reminder hygiene columns (Phase 7). snoozed_until suppresses surfacing
  // without moving due_date; last_surfaced_at + surface_count power resurface
  // dedup so heartbeat doesn't re-ping the same task every 30 minutes.
  'ALTER TABLE tasks ADD COLUMN snoozed_until TEXT',
  'ALTER TABLE tasks ADD COLUMN last_surfaced_at TEXT',
  'ALTER TABLE tasks ADD COLUMN surface_count INTEGER DEFAULT 0',
  // retired_at (organic reminders): set when a task has been surfaced enough
  // times that the heartbeat stops re-pinging it and the morning brief instead
  // asks one pointed "kill it or commit a day" question. Cleared when the user
  // touches the task (snooze / reschedule) so it re-enters the rotation fresh.
  'ALTER TABLE tasks ADD COLUMN retired_at TEXT',
  // facts.person_id (Phase 6d) — canonical link to the people row when a fact's
  // subject names a person. Filled by saveFact's auto-bind (exact name match)
  // or explicit pass-through from callers that already know the personId.
  'ALTER TABLE facts ADD COLUMN person_id INTEGER REFERENCES people(id) ON DELETE SET NULL',
  // Brain Pulse (Tier 1 Phase 1): resurface dedup + commitment completion.
  // Mirrors the tasks pattern (last_surfaced_at / surface_count) so the cron
  // doesn't re-ping the same fact every pulse. completed_at flips on a closed
  // commitment; superseded_at stays null (completion ≠ supersession).
  'ALTER TABLE facts ADD COLUMN last_surfaced_at TEXT',
  'ALTER TABLE facts ADD COLUMN surface_count INTEGER DEFAULT 0',
  'ALTER TABLE facts ADD COLUMN completed_at TEXT',
  'ALTER TABLE people ADD COLUMN last_surfaced_at TEXT',
  // Phase 2 — Hygiene Loop. Every mutation by the weekly hygiene cron writes a
  // row here with before/after JSON so `scripts/hygiene-revert.ts <run_id>`
  // can roll back a single pass without re-reasoning the diff.
  `CREATE TABLE IF NOT EXISTS hygiene_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT NOT NULL,
    action      TEXT NOT NULL,
    fact_id     INTEGER REFERENCES facts(id),
    before_json TEXT,
    after_json  TEXT,
    rationale   TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  )`,
  // Phase 3 — Content Flywheel. Drafts have their own lifecycle
  // (pending/approved/discarded/published) and a separate source-link concept,
  // so they get their own table rather than overloading the facts row.
  `CREATE TABLE IF NOT EXISTS fact_drafts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    kind             TEXT NOT NULL,
    title            TEXT,
    body             TEXT NOT NULL,
    source_fact_ids  TEXT,
    path             TEXT,
    status           TEXT DEFAULT 'pending',
    created_at       TEXT DEFAULT (datetime('now')),
    reviewed_at      TEXT,
    last_surfaced_at TEXT
  )`,
  // Tier 2 Phase 1 — Actions layer. Real-world actions that spend money or
  // commit to a person (orders, bookings, calls) flow propose → confirm →
  // execute, each transition stamped in-row. payload_json is frozen at propose
  // time and is the audit-grade snapshot of exactly what will run. The agent
  // only ever calls propose/confirm/cancel/list; executors run INSIDE
  // confirm_action, never as agent-callable tools — that's what makes the gate
  // unskippable. See CLAUDE.md "Actions layer".
  `CREATE TABLE IF NOT EXISTS actions (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    kind                 TEXT NOT NULL,        -- 'reorder' | 'booking' | 'call'
    tool_name            TEXT NOT NULL,        -- executor key in EXECUTORS dispatch
    summary              TEXT NOT NULL,        -- human-readable one-liner for the DM
    payload_json         TEXT NOT NULL,        -- full executor args; frozen at propose
    estimated_cost_cents INTEGER,              -- nullable for $0 actions
    actual_cost_cents    INTEGER,              -- written at execute
    currency             TEXT NOT NULL DEFAULT 'USD',
    reversible           INTEGER NOT NULL DEFAULT 0,
    status               TEXT NOT NULL DEFAULT 'proposed',
        -- 'proposed' | 'confirmed' | 'executing' | 'done' | 'failed' | 'cancelled'
    category             TEXT,                 -- reserved (future autonomy ladder)
    autonomy_level       TEXT NOT NULL DEFAULT 'confirm',  -- reserved; always 'confirm' in slice 1
    proposed_at          TEXT DEFAULT (datetime('now')),
    confirmed_at         TEXT,
    executed_at          TEXT,
    outcome              TEXT,
    outcome_url          TEXT,
    error                TEXT,
    created_by_group     TEXT NOT NULL,
    last_surfaced_at     TEXT
  )`,
];
for (const sql of schedulingMigrations) {
  try { db.exec(sql); } catch { /* column already exists */ }
}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_google ON tasks(google_task_id)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_snoozed ON tasks(snoozed_until)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_facts_person ON facts(person_id)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_facts_commitment_open ON facts(fact_type, completed_at, active)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_facts_valid_until ON facts(valid_until)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_hygiene_run ON hygiene_log(run_id)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_drafts_status ON fact_drafts(status)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_actions_executed ON actions(executed_at)'); } catch { /* */ }

export function saveMessage(groupId: string, sender: string, role: string, content: string) {
  db.prepare('INSERT INTO messages (group_id, sender, role, content) VALUES (?, ?, ?, ?)').run(groupId, sender, role, content);
}

export function getRecentMessages(groupId: string, limit = 75): { role: string; content: string }[] {
  return db.prepare(
    'SELECT role, content FROM messages WHERE group_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(groupId, limit).reverse() as { role: string; content: string }[];
}

export interface MessageRow {
  id: number;
  group_id: string;
  sender: string;
  role: string;
  content: string;
  created_at: string;
}

// All messages across groups since a timestamp, oldest first.
// Used by the nightly reflection to scan everything new in one pass.
export function getMessagesSince(isoTimestamp: string): MessageRow[] {
  return db
    .prepare(
      `SELECT id, group_id, sender, role, content, created_at
       FROM messages WHERE created_at >= ?
       ORDER BY created_at ASC`
    )
    .all(isoTimestamp) as MessageRow[];
}

// ── Phase 5: passive iMessage capture ───────────────────────────────────────

export interface IMessageLogRow {
  id: number;
  rowid_src: number;
  chat_id: string;
  chat_name: string | null;
  sender: string;
  direction: string; // 'in' | 'out'
  text: string | null;
  ts: string;
  extracted_at: string | null;
  created_at: string;
}

// Log one observed iMessage. INSERT OR IGNORE on the UNIQUE rowid_src means
// re-polling the same chat.db ROWID never double-logs.
export function logIMessage(row: {
  rowid_src: number;
  chat_id: string;
  chat_name?: string | null;
  sender: string;
  direction: 'in' | 'out';
  text?: string | null;
  ts: string;
}): void {
  db.prepare(
    `INSERT OR IGNORE INTO imessage_log (rowid_src, chat_id, chat_name, sender, direction, text, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.rowid_src,
    row.chat_id,
    row.chat_name ?? null,
    row.sender,
    row.direction,
    row.text ?? null,
    row.ts,
  );
}

// Backfill one historical iMessage from chat.db. Same idempotent INSERT OR IGNORE
// as logIMessage, but stamps extracted_at = now so the imessage-daemon does NOT run
// LLM extraction over years of old history — backfilled rows are for search only.
// Returns true if a new row was inserted (false if the ROWID was already present).
export function backfillIMessage(row: {
  rowid_src: number;
  chat_id: string;
  chat_name?: string | null;
  sender: string;
  direction: 'in' | 'out';
  text?: string | null;
  ts: string;
}): boolean {
  const res = db.prepare(
    `INSERT OR IGNORE INTO imessage_log (rowid_src, chat_id, chat_name, sender, direction, text, ts, extracted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    row.rowid_src,
    row.chat_id,
    row.chat_name ?? null,
    row.sender,
    row.direction,
    row.text ?? null,
    row.ts,
  );
  return res.changes > 0;
}

// Bulk backfill wrapped in a single transaction (152k individual inserts in WAL mode
// would otherwise fsync per row). Returns how many rows were newly inserted.
export function backfillIMessages(rows: Array<Parameters<typeof backfillIMessage>[0]>): number {
  const txn = db.transaction((batch: Array<Parameters<typeof backfillIMessage>[0]>) => {
    let inserted = 0;
    for (const r of batch) if (backfillIMessage(r)) inserted++;
    return inserted;
  });
  return txn(rows);
}

// Oldest-first batch of messages the daemon hasn't processed yet.
export function getUnextractedIMessages(limit = 100): IMessageLogRow[] {
  return db
    .prepare(
      `SELECT id, rowid_src, chat_id, chat_name, sender, direction, text, ts, extracted_at, created_at
       FROM imessage_log WHERE extracted_at IS NULL
       ORDER BY id ASC LIMIT ?`
    )
    .all(limit) as IMessageLogRow[];
}

// Mark a batch processed. Call for BOTH extracted and filtered-out rows so the
// cursor always advances and nothing is reprocessed on the next tick.
export function markIMessagesExtracted(ids: number[]): void {
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(
    `UPDATE imessage_log SET extracted_at = datetime('now') WHERE id IN (${placeholders})`
  ).run(...ids);
}

// Agent-facing search over observed iMessage history. Matches a free-text query against
// the message body, the sender handle, and the chat name. Optionally narrows to one
// sender/chat handle. Newest first. Note: only covers messages logged since the bot
// started observing (no historical backfill).
export function searchIMessages(opts: { query?: string; handle?: string; limit?: number }): IMessageLogRow[] {
  const clauses: string[] = ['text IS NOT NULL', "TRIM(text) <> ''"];
  const params: (string | number)[] = [];
  if (opts.query && opts.query.trim()) {
    const q = `%${opts.query.trim()}%`;
    clauses.push('(text LIKE ? OR sender LIKE ? OR COALESCE(chat_name, \'\') LIKE ?)');
    params.push(q, q, q);
  }
  if (opts.handle && opts.handle.trim()) {
    const h = `%${opts.handle.trim()}%`;
    clauses.push('(sender LIKE ? OR chat_id LIKE ? OR COALESCE(chat_name, \'\') LIKE ?)');
    params.push(h, h, h);
  }
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  params.push(limit);
  return db.prepare(
    `SELECT * FROM imessage_log WHERE ${clauses.join(' AND ')} ORDER BY ts DESC LIMIT ?`
  ).all(...params) as IMessageLogRow[];
}

// ── Inbox-signal extraction dedup (inbox-signal-daemon) ──────────────────────

// True if we've already enumerated this Spark message in a prior tick.
export function isEmailExtracted(messageId: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM email_extraction_log WHERE message_id = ? LIMIT 1')
    .get(messageId);
  return row !== undefined;
}

// Record that a Spark message has been processed. Call for BOTH emails that
// yielded artifacts and ones the prefilter dropped, so the cursor always
// advances. INSERT OR IGNORE keeps re-enumeration idempotent. Returns true if
// this was the first time we've seen this message_id.
export function markEmailExtracted(row: {
  message_id: string;
  account?: string | null;
  subject?: string | null;
  sender?: string | null;
  ts?: string | null;
  signal_count?: number;
}): boolean {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO email_extraction_log (message_id, account, subject, sender, ts, signal_count)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.message_id,
      row.account ?? null,
      row.subject ?? null,
      row.sender ?? null,
      row.ts ?? null,
      row.signal_count ?? 0,
    );
  return res.changes > 0;
}

export function createAsyncTask(groupId: string, sender: string, prompt: string): number {
  const result = db.prepare(
    'INSERT INTO async_tasks (group_id, sender, prompt) VALUES (?, ?, ?)'
  ).run(groupId, sender, prompt);
  return result.lastInsertRowid as number;
}

export function completeAsyncTask(taskId: number, result: string) {
  db.prepare(
    "UPDATE async_tasks SET status = 'done', result = ?, completed_at = datetime('now') WHERE id = ?"
  ).run(result, taskId);
}

export function failAsyncTask(taskId: number, error: string) {
  db.prepare(
    "UPDATE async_tasks SET status = 'failed', result = ?, completed_at = datetime('now') WHERE id = ?"
  ).run(error, taskId);
}

export function getPendingTasks() {
  return db.prepare("SELECT * FROM async_tasks WHERE status = 'pending'").all();
}

export function setMemory(groupId: string, key: string, value: string) {
  db.prepare(
    'INSERT OR REPLACE INTO memory (group_id, key, value, updated_at) VALUES (?, ?, ?, datetime(\'now\'))'
  ).run(groupId, key, value);
}

export function getMemory(groupId: string, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM memory WHERE group_id = ? AND key = ?').get(groupId, key) as { value: string } | undefined;
  return row?.value;
}

export function deleteMemory(groupId: string, key: string): void {
  db.prepare('DELETE FROM memory WHERE group_id = ? AND key = ?').run(groupId, key);
}

export interface MemoryEntry { key: string; value: string; updated_at: string }

export function getRecentMemory(
  groupId: string,
  opts: { prefix?: string; suffix?: string; limit?: number } = {}
): MemoryEntry[] {
  const limit = opts.limit ?? 5;
  const params: (string | number)[] = [groupId];
  let where = 'group_id = ?';
  if (opts.prefix) { where += ' AND key LIKE ?'; params.push(`${opts.prefix}%`); }
  if (opts.suffix) { where += ' AND key LIKE ?'; params.push(`%${opts.suffix}`); }
  params.push(limit);
  return db.prepare(
    `SELECT key, value, updated_at FROM memory WHERE ${where} ORDER BY updated_at DESC LIMIT ?`
  ).all(...params) as MemoryEntry[];
}

// --- Facts (knowledge store) ---

export interface Fact {
  id: number;
  subject: string;
  predicate: string;
  object: string;
  fact_type: string;
  group_id: string | null;
  source: string;
  source_ref: string | null;
  confidence: number;
  valid_until: string | null;
  active: number;
  superseded_at: string | null;
  created_at: string;
  updated_at: string;
  person_id: number | null;
  // Phase 1 additions:
  last_surfaced_at: string | null;
  surface_count: number | null;
  completed_at: string | null;
}

// fact_types that overwrite prior (subject, predicate) rows. Others append.
const SUPERSEDE_FACT_TYPES = new Set(['preference', 'decision', 'metric']);

// Stopwords for FTS5 query sanitization. We strip these before building MATCH
// expressions so a sentence like "What's the Q1 budget?" tokenizes to {q1, budget}.
const FTS_STOPWORDS = new Set([
  'a','an','the','and','or','but','if','then','so',
  'is','are','was','were','be','been','being','am',
  'do','does','did','doing','done',
  'have','has','had','having',
  'i','me','my','mine','myself',
  'you','your','yours','yourself','youre','youve',
  'he','him','his','she','her','hers','it','its',
  'we','us','our','ours','they','them','their','theirs',
  'this','that','these','those',
  'what','whats','which','who','whom','where','when','why','how',
  'of','for','to','at','by','in','on','with','about','from','into','onto','as','out','up','down',
  'can','could','will','would','should','may','might','must','shall',
  'not','no','yes','very','just','now','then','here','there','also','too',
  'tell','show','give','get','got','let','lets','please',
  's','t','d','ll','ve','re','m',
]);

function ftsTokenize(text: string): string {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) || [];
  const kept = tokens.filter((t) => t.length >= 2 && !FTS_STOPWORDS.has(t));
  if (kept.length === 0) return '';
  return kept.map((t) => `"${t}"`).join(' OR ');
}

export function saveFact(f: {
  subject: string;
  predicate: string;
  object: string;
  fact_type?: string;
  group_id?: string;
  source?: string;
  source_ref?: string;
  confidence?: number;
  valid_until?: string;
  mode?: 'append' | 'supersede';
  /** Canonical person link. If omitted, saveFact attempts an exact-name auto-bind
   *  to a row in `people` (case-insensitive). Set explicitly when the caller
   *  already knows the person id (calendar/spark/linkedin hooks). */
  person_id?: number | null;
}): number {
  const subject = f.subject.trim().toLowerCase();
  const predicate = f.predicate.trim().toLowerCase();
  if (!subject || !predicate) {
    throw new Error('saveFact: subject and predicate are required');
  }
  const fact_type = f.fact_type || 'fact';
  const mode = f.mode || (SUPERSEDE_FACT_TYPES.has(fact_type) ? 'supersede' : 'append');

  // Auto-bind: if the caller didn't pass a person_id, try to resolve the subject
  // to a person row via strict exact-name match (case-insensitive). Strict match
  // avoids false binds — "John" wouldn't bind to "John Smith".
  let personId: number | null = f.person_id ?? null;
  if (personId === null) {
    try {
      const hit = db
        .prepare('SELECT id FROM people WHERE name = ? COLLATE NOCASE LIMIT 1')
        .get(subject) as { id: number } | undefined;
      if (hit) personId = hit.id;
    } catch { /* ignore — auto-bind is opportunistic */ }
  }

  if (mode === 'supersede') {
    db.prepare(
      `UPDATE facts SET active = 0, superseded_at = datetime('now')
       WHERE subject = ? COLLATE NOCASE AND predicate = ? COLLATE NOCASE AND active = 1`
    ).run(subject, predicate);
  }

  const result = db.prepare(
    `INSERT INTO facts (subject, predicate, object, fact_type, group_id, source, source_ref, confidence, valid_until, person_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    subject,
    predicate,
    f.object,
    fact_type,
    f.group_id || null,
    f.source || 'manual',
    f.source_ref || null,
    f.confidence ?? 1.0,
    toSqliteDate(f.valid_until),
    personId,
  );
  return result.lastInsertRowid as number;
}

export function searchFacts(query: string, limit = 8): Fact[] {
  const ftsQuery = ftsTokenize(query);
  if (!ftsQuery) return [];
  try {
    return db.prepare(
      `SELECT f.* FROM facts_fts
       JOIN facts f ON f.id = facts_fts.rowid
       WHERE facts_fts MATCH ?
         AND f.active = 1
         AND (f.valid_until IS NULL OR datetime(f.valid_until) > datetime('now'))
       ORDER BY rank LIMIT ?`
    ).all(ftsQuery, limit) as Fact[];
  } catch {
    // FTS5 syntax errors shouldn't blow up the prompt-building path.
    return [];
  }
}

// Loose keyword tokens (non-stopword, len>=2) for a LIKE fallback. Unlike
// ftsTokenize this returns the raw tokens, not an FTS MATCH expression.
function looseTokens(text: string): string[] {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) || [];
  return tokens.filter((t) => t.length >= 2 && !FTS_STOPWORDS.has(t));
}

// FTS-first fact search with a LIKE fallback. searchFacts (FTS5) is precise but
// brittle: a stopword-only query, a near-miss phrasing, or a substring that
// isn't a whole token returns nothing. When FTS comes up empty we scan
// subject/predicate/object with LIKE '%token%' (OR across tokens) so the agent
// stops claiming "I don't have that" when the data is right there. Same
// active/unexpired filter as searchFacts.
export function searchFactsBroad(query: string, limit = 8): Fact[] {
  const ftsHits = searchFacts(query, limit);
  if (ftsHits.length > 0) return ftsHits;

  const tokens = looseTokens(query);
  if (tokens.length === 0) return [];
  const clauses = tokens
    .map(() => '(subject LIKE ? OR predicate LIKE ? OR object LIKE ?)')
    .join(' OR ');
  const params: (string | number)[] = [];
  for (const t of tokens) {
    const like = `%${t}%`;
    params.push(like, like, like);
  }
  params.push(limit);
  try {
    return db.prepare(
      `SELECT * FROM facts
       WHERE (${clauses})
         AND active = 1
         AND (valid_until IS NULL OR datetime(valid_until) > datetime('now'))
       ORDER BY updated_at DESC LIMIT ?`
    ).all(...params) as Fact[];
  } catch {
    return [];
  }
}

// Plain ordered list of facts — the "show me everything" safety net. Used by the
// recall tool and dashboard when no targeted query applies.
export function getAllFacts(opts: { limit?: number; includeInactive?: boolean } = {}): Fact[] {
  const limit = opts.limit ?? 200;
  if (opts.includeInactive) {
    return db.prepare('SELECT * FROM facts ORDER BY updated_at DESC LIMIT ?').all(limit) as Fact[];
  }
  return db.prepare(
    `SELECT * FROM facts
     WHERE active = 1
       AND (valid_until IS NULL OR datetime(valid_until) > datetime('now'))
     ORDER BY updated_at DESC LIMIT ?`
  ).all(limit) as Fact[];
}

export function factsAbout(subject: string, limit = 12): Fact[] {
  const s = subject.trim();
  if (!s) return [];

  // First try the subject string. Then, if the subject names a known person,
  // also union facts linked by person_id — catches cases where the same person
  // is referenced under different subject strings ("aniket", "aniket-patel").
  const byString = db.prepare(
    `SELECT * FROM facts
     WHERE subject = ? COLLATE NOCASE
       AND active = 1
       AND (valid_until IS NULL OR datetime(valid_until) > datetime('now'))
     ORDER BY updated_at DESC LIMIT ?`
  ).all(s, limit) as Fact[];

  const person = db
    .prepare('SELECT id FROM people WHERE name = ? COLLATE NOCASE LIMIT 1')
    .get(s) as { id: number } | undefined;
  if (!person) return byString;

  const byPerson = db.prepare(
    `SELECT * FROM facts
     WHERE person_id = ?
       AND active = 1
       AND (valid_until IS NULL OR datetime(valid_until) > datetime('now'))
     ORDER BY updated_at DESC LIMIT ?`
  ).all(person.id, limit) as Fact[];

  // Merge + dedupe by id, preserving string-match order first (most likely
  // semantically aligned with what the agent searched for).
  const seen = new Set<number>();
  const merged: Fact[] = [];
  for (const list of [byString, byPerson]) {
    for (const fact of list) {
      if (seen.has(fact.id)) continue;
      seen.add(fact.id);
      merged.push(fact);
      if (merged.length >= limit) return merged;
    }
  }
  return merged;
}

/** Direct lookup by person id. Used by the People Context block in
 *  loadSystemPrompt — once a person is matched, prefer their `person_id`-
 *  linked facts over a fuzzy subject-string lookup. */
export function factsByPersonId(personId: number, limit = 6): Fact[] {
  return db.prepare(
    `SELECT * FROM facts
     WHERE person_id = ?
       AND active = 1
       AND (valid_until IS NULL OR datetime(valid_until) > datetime('now'))
     ORDER BY updated_at DESC LIMIT ?`
  ).all(personId, limit) as Fact[];
}

export function getBrainStats(): {
  facts_active: number;
  people: number;
  open_tasks: number;
  messages_24h: number;
  last_reflection: string | null;
} {
  const facts = db.prepare('SELECT COUNT(*) AS c FROM facts WHERE active = 1').get() as { c: number };
  const people = db.prepare('SELECT COUNT(*) AS c FROM people').get() as { c: number };
  const open = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE status IN ('open','in_progress')").get() as { c: number };
  const msgs = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE created_at >= datetime('now', '-1 day')").get() as { c: number };
  const lastReflection = (db.prepare("SELECT value FROM memory WHERE group_id = 'reflection' AND key = 'last_reflection_at'").get() as { value: string } | undefined)?.value || null;
  return {
    facts_active: facts.c,
    people: people.c,
    open_tasks: open.c,
    messages_24h: msgs.c,
    last_reflection: lastReflection,
  };
}

export function getFactsByType(types: string[], limit = 20): Fact[] {
  if (types.length === 0) return [];
  const placeholders = types.map(() => '?').join(',');
  return db.prepare(
    `SELECT * FROM facts
     WHERE fact_type IN (${placeholders})
       AND active = 1
       AND (valid_until IS NULL OR datetime(valid_until) > datetime('now'))
     ORDER BY confidence DESC, updated_at DESC LIMIT ?`
  ).all(...types, limit) as Fact[];
}

// --- Brain Pulse helpers (Tier 1 Phase 1) ---
//
// All three "find" queries filter rows surfaced within PULSE_RESURFACE_HOURS so
// the same nudge doesn't fire every 11/16 ET pulse. Mirrors getOverdueTasks's
// dedup-aware shape. mark* helpers flip last_surfaced_at after a pulse cites
// (or even considers) the row — conservative, same posture as
// heartbeatTaskCheck → markTaskSurfaced.

const PULSE_RESURFACE_HOURS = Number(process.env.PULSE_RESURFACE_HOURS) || 18;

export function getStaleCommitments(limit = 5): Fact[] {
  return db.prepare(
    `SELECT * FROM facts
     WHERE fact_type = 'commitment' AND active = 1 AND completed_at IS NULL
       AND datetime(created_at) < datetime('now', '-7 days')
       AND (last_surfaced_at IS NULL
            OR datetime(last_surfaced_at) < datetime('now', '-' || ? || ' hours'))
     ORDER BY datetime(created_at) ASC LIMIT ?`
  ).all(PULSE_RESURFACE_HOURS, limit) as Fact[];
}

export function getExpiringFacts(daysAhead = 7, limit = 5): Fact[] {
  // Exclude 'metric' (fix #4): metrics carry valid_until = next Sunday by design
  // and auto-supersede weekly. Surfacing them every Mon-Sun would be recurring
  // noise, not action.
  return db.prepare(
    `SELECT * FROM facts
     WHERE valid_until IS NOT NULL AND active = 1
       AND fact_type != 'metric'
       AND datetime(valid_until) BETWEEN datetime('now') AND datetime('now', '+' || ? || ' days')
       AND (last_surfaced_at IS NULL
            OR datetime(last_surfaced_at) < datetime('now', '-' || ? || ' hours'))
     ORDER BY datetime(valid_until) ASC LIMIT ?`
  ).all(daysAhead, PULSE_RESURFACE_HOURS, limit) as Fact[];
}

export function getDormantLeads(daysSince = 60, limit = 5): Person[] {
  return db.prepare(
    `SELECT * FROM people
     WHERE relationship = 'lead'
       AND (last_contact IS NULL OR datetime(last_contact) < datetime('now', '-' || ? || ' days'))
       AND (last_surfaced_at IS NULL
            OR datetime(last_surfaced_at) < datetime('now', '-' || ? || ' hours'))
     ORDER BY datetime(COALESCE(last_contact, created_at)) ASC LIMIT ?`
  ).all(daysSince, PULSE_RESURFACE_HOURS, limit) as Person[];
}

// People we've actually interacted with before but have gone quiet on. Unlike
// getDormantLeads this is relationship-agnostic and requires a real prior contact
// (last_contact IS NOT NULL), so it surfaces "we used to talk, now cold" rather than
// the thousands of never-contacted imported Apple Contacts. Powers who_to_reach_out_to.
export function getStaleContacts(daysSince = 30, limit = 15): Person[] {
  return db.prepare(
    `SELECT * FROM people
     WHERE last_contact IS NOT NULL
       AND datetime(last_contact) < datetime('now', '-' || ? || ' days')
     ORDER BY datetime(last_contact) ASC LIMIT ?`
  ).all(daysSince, limit) as Person[];
}

export function markFactSurfaced(id: number): void {
  db.prepare(
    "UPDATE facts SET last_surfaced_at = datetime('now'), surface_count = COALESCE(surface_count, 0) + 1 WHERE id = ?"
  ).run(id);
}

export function markPersonSurfaced(id: number): void {
  db.prepare(
    "UPDATE people SET last_surfaced_at = datetime('now') WHERE id = ?"
  ).run(id);
}

export function completeFact(id: number, note?: string): void {
  // Do NOT touch superseded_at — completion is a different semantic from
  // supersession. Dashboards distinguish "done" (completed_at + active=0,
  // superseded_at IS NULL) from "replaced by newer fact" (superseded_at set).
  if (note) {
    db.prepare(
      `UPDATE facts SET completed_at = datetime('now'), active = 0,
                        source_ref = COALESCE(source_ref || '; ', '') || 'completed via pulse: ' || ?
       WHERE id = ? AND fact_type = 'commitment'`
    ).run(note, id);
  } else {
    db.prepare(
      "UPDATE facts SET completed_at = datetime('now'), active = 0 WHERE id = ? AND fact_type = 'commitment'"
    ).run(id);
  }
}

export function extendFactValidity(id: number, days: number): void {
  // If valid_until is null, anchor to 'now'; otherwise extend from existing value.
  db.prepare(
    `UPDATE facts SET valid_until = datetime(COALESCE(valid_until, 'now'), '+' || ? || ' days') WHERE id = ?`
  ).run(days, id);
}

// --- Hygiene helpers (Tier 1 Phase 2) ---
//
// The weekly hygiene cron writes every mutation to `hygiene_log` with full
// before/after JSON. Revert is a single UPDATE per row from the snapshot.
//
// `findDuplicateFacts` keys on (subject, predicate, OBJECT) and restricts to
// `fact_type='fact'` ONLY. Append-only log types (commitment/feedback) can
// legitimately share (subject, predicate) with different objects — dedup-ing
// those would destroy real distinct entries.

export interface DuplicateFactGroup {
  subject: string;
  predicate: string;
  object: string;
  ids: number[];
}

export interface ContradictionGroup {
  subject: string;
  predicate: string;
  ids: number[];
}

export function findDuplicateFacts(): DuplicateFactGroup[] {
  const rows = db.prepare(
    `SELECT subject, predicate, object, GROUP_CONCAT(id) AS ids, COUNT(*) AS c
     FROM facts
     WHERE active = 1 AND fact_type = 'fact'
     GROUP BY LOWER(subject), LOWER(predicate), LOWER(object)
     HAVING c > 1`
  ).all() as Array<{ subject: string; predicate: string; object: string; ids: string; c: number }>;
  return rows.map((r) => ({
    subject: r.subject,
    predicate: r.predicate,
    object: r.object,
    ids: r.ids.split(',').map((s) => Number(s)),
  }));
}

export function findContradictions(): ContradictionGroup[] {
  // Defensive guard: supersede-types should never have >1 active row on
  // (subject, predicate). If this turns up rows, something bypassed saveFact's
  // supersession path. Flag only; never auto-resolve.
  const rows = db.prepare(
    `SELECT subject, predicate, GROUP_CONCAT(id) AS ids, COUNT(*) AS c
     FROM facts
     WHERE active = 1 AND fact_type IN ('preference','decision','metric')
     GROUP BY LOWER(subject), LOWER(predicate)
     HAVING c > 1`
  ).all() as Array<{ subject: string; predicate: string; ids: string; c: number }>;
  return rows.map((r) => ({
    subject: r.subject,
    predicate: r.predicate,
    ids: r.ids.split(',').map((s) => Number(s)),
  }));
}

export function findLowConfidenceFacts(threshold: number, minAgeDays: number): Fact[] {
  return db.prepare(
    `SELECT * FROM facts
     WHERE active = 1 AND confidence < ?
       AND datetime(updated_at) < datetime('now', '-' || ? || ' days')`
  ).all(threshold, minAgeDays) as Fact[];
}

export function findExpiredCommitments(staleDays: number, minSurfaceCount: number): Fact[] {
  // Safe-to-retire: commitments older than `staleDays` that brain-pulse has
  // already surfaced `minSurfaceCount` times without resolution. "Old" alone
  // isn't enough — a never-pinged commitment might still be live.
  return db.prepare(
    `SELECT * FROM facts
     WHERE fact_type = 'commitment' AND active = 1 AND completed_at IS NULL
       AND datetime(created_at) < datetime('now', '-' || ? || ' days')
       AND COALESCE(surface_count, 0) >= ?`
  ).all(staleDays, minSurfaceCount) as Fact[];
}

export function findStaleNeverSurfacedCommitments(staleDays: number): Fact[] {
  // Same age window, but brain-pulse has never pinged. Flag for human review;
  // never auto-mutate.
  return db.prepare(
    `SELECT * FROM facts
     WHERE fact_type = 'commitment' AND active = 1 AND completed_at IS NULL
       AND datetime(created_at) < datetime('now', '-' || ? || ' days')
       AND COALESCE(surface_count, 0) = 0`
  ).all(staleDays) as Fact[];
}

export interface HygieneLogRow {
  id: number;
  run_id: string;
  action: string;
  fact_id: number | null;
  before_json: string | null;
  after_json: string | null;
  rationale: string | null;
  created_at: string;
}

export function logHygieneAction(args: {
  runId: string;
  action: string;
  factId: number | null;
  before: unknown;
  after: unknown;
  rationale: string;
}): void {
  db.prepare(
    `INSERT INTO hygiene_log (run_id, action, fact_id, before_json, after_json, rationale)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    args.runId,
    args.action,
    args.factId,
    args.before === undefined ? null : JSON.stringify(args.before),
    args.after === undefined ? null : JSON.stringify(args.after),
    args.rationale,
  );
}

export function getRecentHygieneActions(limit = 20): HygieneLogRow[] {
  return db.prepare(
    `SELECT * FROM hygiene_log ORDER BY id DESC LIMIT ?`
  ).all(limit) as HygieneLogRow[];
}

export function getHygieneRun(runId: string): HygieneLogRow[] {
  return db.prepare(
    `SELECT * FROM hygiene_log WHERE run_id = ? ORDER BY id DESC`
  ).all(runId) as HygieneLogRow[];
}

export function setFactInactive(id: number, completed = false): void {
  // Used by hygiene to demote / dedupe / expire. Optionally flips completed_at
  // alongside active=0 (for the expire-commitment path). superseded_at stays
  // null — these aren't supersessions, they're hygiene-driven retirements.
  if (completed) {
    db.prepare(
      "UPDATE facts SET active = 0, completed_at = datetime('now') WHERE id = ?"
    ).run(id);
  } else {
    db.prepare("UPDATE facts SET active = 0 WHERE id = ?").run(id);
  }
}

export function restoreFactFromSnapshot(id: number, snapshot: Partial<Fact>): void {
  // Used by revertHygieneRun. Restores the columns hygiene might have touched:
  // active, completed_at, superseded_at (defensive — should already be null),
  // confidence. Subject/predicate/object are never mutated by hygiene so we
  // don't restore them — keeps the revert narrow and safe.
  db.prepare(
    `UPDATE facts
       SET active = COALESCE(?, active),
           completed_at = ?,
           superseded_at = ?,
           confidence = COALESCE(?, confidence)
       WHERE id = ?`
  ).run(
    snapshot.active ?? null,
    (snapshot.completed_at ?? null) as string | null,
    (snapshot.superseded_at ?? null) as string | null,
    snapshot.confidence ?? null,
    id,
  );
}

// --- Content drafts (Tier 1 Phase 3) ---

export interface FactDraft {
  id: number;
  kind: string;
  title: string | null;
  body: string;
  source_fact_ids: string | null;
  path: string | null;
  status: string;
  created_at: string;
  reviewed_at: string | null;
  last_surfaced_at: string | null;
}

export function createDraft(args: {
  kind: 'linkedin' | 'newsletter';
  title?: string;
  body: string;
  source_fact_ids?: number[];
  path?: string;
}): number {
  const result = db.prepare(
    `INSERT INTO fact_drafts (kind, title, body, source_fact_ids, path)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    args.kind,
    args.title ?? null,
    args.body,
    args.source_fact_ids ? JSON.stringify(args.source_fact_ids) : null,
    args.path ?? null,
  );
  return result.lastInsertRowid as number;
}

export function getDraftById(id: number): FactDraft | undefined {
  return db.prepare('SELECT * FROM fact_drafts WHERE id = ?').get(id) as FactDraft | undefined;
}

export function listDrafts(opts: { status?: string; limit?: number } = {}): FactDraft[] {
  const limit = opts.limit ?? 20;
  if (opts.status) {
    return db.prepare(
      'SELECT * FROM fact_drafts WHERE status = ? ORDER BY created_at DESC LIMIT ?'
    ).all(opts.status, limit) as FactDraft[];
  }
  return db.prepare(
    'SELECT * FROM fact_drafts ORDER BY created_at DESC LIMIT ?'
  ).all(limit) as FactDraft[];
}

export function updateDraftStatus(id: number, status: 'pending' | 'approved' | 'discarded' | 'published'): void {
  db.prepare(
    "UPDATE fact_drafts SET status = ?, reviewed_at = datetime('now') WHERE id = ?"
  ).run(status, id);
}

export function getUnreviewedDraftsCount(): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM fact_drafts WHERE status = 'pending'").get() as { c: number };
  return row.c;
}

export function getRecentFactsBySource(source: string, sinceIso: string, limit = 20): Fact[] {
  return db.prepare(
    `SELECT * FROM facts
     WHERE source = ? AND active = 1
       AND datetime(created_at) >= datetime(?)
     ORDER BY datetime(created_at) DESC LIMIT ?`
  ).all(source, sinceIso, limit) as Fact[];
}

export function getTopRecentPeople(sinceIso: string, limit = 5): Array<{ person_id: number; name: string; count: number }> {
  return db.prepare(
    `SELECT i.person_id AS person_id, p.name AS name, COUNT(*) AS count
     FROM interactions i
     JOIN people p ON p.id = i.person_id
     WHERE datetime(COALESCE(i.occurred_at, i.created_at)) >= datetime(?)
     GROUP BY i.person_id
     ORDER BY count DESC
     LIMIT ?`
  ).all(sinceIso, limit) as Array<{ person_id: number; name: string; count: number }>;
}

export function revertHygieneRun(runId: string): { reverted: number; skipped: number } {
  const rows = getHygieneRun(runId);
  if (rows.length === 0) return { reverted: 0, skipped: 0 };

  // Sanity guard: refuse runs older than 14 days. Hygiene log keeps rows but
  // the live state may have moved on; mass-reverting a stale run could undo
  // newer legitimate changes.
  const oldest = rows[rows.length - 1];
  const ageMs = Date.now() - new Date(oldest.created_at + 'Z').getTime();
  if (ageMs > 14 * 86400 * 1000) {
    throw new Error(`Hygiene run ${runId} is older than 14 days; refusing to revert. Manual recovery required.`);
  }

  let reverted = 0;
  let skipped = 0;
  const tx = db.transaction((logRows: HygieneLogRow[]) => {
    for (const row of logRows) {
      if (row.fact_id === null || !row.before_json) {
        skipped++;
        continue;
      }
      try {
        const snapshot = JSON.parse(row.before_json) as Partial<Fact>;
        restoreFactFromSnapshot(row.fact_id, snapshot);
        reverted++;
      } catch {
        skipped++;
      }
    }
  });
  tx(rows);
  return { reverted, skipped };
}

// --- People graph ---

export interface Person {
  id: number;
  name: string;
  company: string | null;
  role: string | null;
  linkedin_url: string | null;
  relationship: string | null;
  notes: string | null;
  last_contact: string | null;
  created_at: string;
}

export interface Interaction {
  id: number;
  person_id: number;
  channel: string | null;
  summary: string | null;
  ref: string | null;
  occurred_at: string | null;
  created_at: string;
}

// Upsert with multi-key dedup: try (any of) emails → linkedin_url → otherwise insert.
// Only patches fields that are explicitly provided; never overwrites with null.
export function upsertPerson(input: {
  emails?: string[];
  phones?: string[];
  name?: string;
  company?: string;
  role?: string;
  linkedin_url?: string;
  relationship?: string;
  notes?: string;
}): number {
  const emails = (input.emails ?? [])
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  const phones = Array.from(new Set(
    (input.phones ?? []).map((p) => normalizePhone(p)).filter((p) => p.length > 0)
  ));

  let personId: number | undefined;

  if (emails.length > 0) {
    const placeholders = emails.map(() => '?').join(',');
    const found = db
      .prepare(`SELECT person_id FROM person_emails WHERE email IN (${placeholders}) LIMIT 1`)
      .get(...emails) as { person_id: number } | undefined;
    if (found) personId = found.person_id;
  }

  if (!personId && phones.length > 0) {
    const placeholders = phones.map(() => '?').join(',');
    const found = db
      .prepare(`SELECT person_id FROM person_phones WHERE phone IN (${placeholders}) LIMIT 1`)
      .get(...phones) as { person_id: number } | undefined;
    if (found) personId = found.person_id;
  }

  if (!personId && input.linkedin_url) {
    const found = db
      .prepare('SELECT id FROM people WHERE linkedin_url = ? LIMIT 1')
      .get(input.linkedin_url) as { id: number } | undefined;
    if (found) personId = found.id;
  }

  if (!personId) {
    const fallbackName = input.name?.trim() || emails[0] || 'Unknown';
    const result = db
      .prepare(
        `INSERT INTO people (name, company, role, linkedin_url, relationship, notes)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        fallbackName,
        input.company ?? null,
        input.role ?? null,
        input.linkedin_url ?? null,
        input.relationship ?? null,
        input.notes ?? null,
      );
    personId = result.lastInsertRowid as number;
  } else {
    const sets: string[] = [];
    const params: (string | null)[] = [];
    if (input.name) { sets.push('name = ?'); params.push(input.name); }
    if (input.company) { sets.push('company = ?'); params.push(input.company); }
    if (input.role) { sets.push('role = ?'); params.push(input.role); }
    if (input.linkedin_url) { sets.push('linkedin_url = ?'); params.push(input.linkedin_url); }
    if (input.relationship) { sets.push('relationship = ?'); params.push(input.relationship); }
    if (input.notes) { sets.push('notes = ?'); params.push(input.notes); }
    if (sets.length > 0) {
      params.push(String(personId));
      db.prepare(`UPDATE people SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    }
  }

  for (const email of emails) {
    db.prepare('INSERT OR IGNORE INTO person_emails (email, person_id) VALUES (?, ?)').run(email, personId);
  }

  for (const phone of phones) {
    db.prepare('INSERT OR IGNORE INTO person_phones (phone, person_id) VALUES (?, ?)').run(phone, personId);
  }

  return personId;
}

export function findPersonByPhone(phone: string): Person | undefined {
  const p = normalizePhone(phone);
  if (!p) return undefined;
  return db
    .prepare(
      `SELECT p.* FROM people p
       JOIN person_phones pp ON pp.person_id = p.id
       WHERE pp.phone = ? LIMIT 1`
    )
    .get(p) as Person | undefined;
}

export function findPersonByEmail(email: string): Person | undefined {
  const e = email.trim().toLowerCase();
  if (!e) return undefined;
  return db
    .prepare(
      `SELECT p.* FROM people p
       JOIN person_emails pe ON pe.person_id = p.id
       WHERE pe.email = ? COLLATE NOCASE LIMIT 1`
    )
    .get(e) as Person | undefined;
}

export function getPersonById(id: number): Person | undefined {
  return db.prepare('SELECT * FROM people WHERE id = ?').get(id) as Person | undefined;
}

export function peopleSearch(query: string, limit = 5): Person[] {
  const q = `%${query.trim().toLowerCase()}%`;
  if (q === '%%') return [];
  return db
    .prepare(
      `SELECT DISTINCT p.* FROM people p
       LEFT JOIN person_emails pe ON pe.person_id = p.id
       WHERE LOWER(p.name) LIKE ? OR LOWER(COALESCE(p.company,'')) LIKE ? OR LOWER(COALESCE(pe.email,'')) LIKE ?
       ORDER BY COALESCE(p.last_contact, p.created_at) DESC LIMIT ?`
    )
    .all(q, q, q, limit) as Person[];
}

export function addInteraction(input: {
  person_id: number;
  channel?: string;
  summary?: string;
  ref?: string;
  occurred_at?: string;
}): number {
  // Dedup on (person, channel, ref) so re-reading the same email/event doesn't spam.
  if (input.ref && input.channel) {
    const existing = db
      .prepare('SELECT id FROM interactions WHERE person_id = ? AND channel = ? AND ref = ? LIMIT 1')
      .get(input.person_id, input.channel, input.ref) as { id: number } | undefined;
    if (existing) return existing.id;
  }
  const occurredAt = toSqliteDate(input.occurred_at);
  const result = db
    .prepare(
      `INSERT INTO interactions (person_id, channel, summary, ref, occurred_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      input.person_id,
      input.channel ?? null,
      input.summary ?? null,
      input.ref ?? null,
      occurredAt,
    );
  if (occurredAt) {
    db.prepare(
      `UPDATE people SET last_contact = ?
       WHERE id = ? AND (last_contact IS NULL OR datetime(last_contact) < datetime(?))`
    ).run(occurredAt, input.person_id, occurredAt);
  }
  return result.lastInsertRowid as number;
}

export function getRecentInteractions(personId: number, limit = 5): Interaction[] {
  return db
    .prepare(
      `SELECT * FROM interactions WHERE person_id = ?
       ORDER BY COALESCE(occurred_at, created_at) DESC LIMIT ?`
    )
    .all(personId, limit) as Interaction[];
}

// --- Task management ---

export interface Task {
  id: number;
  title: string;
  description: string | null;
  group_id: string;
  assignee: string;
  priority: string;
  status: string;
  due_date: string | null;
  source: string;
  created_at: string;
  completed_at: string | null;
  notes: string | null;
  duration_minutes: number | null;
  focus_level: string | null;
  calendar_event_id: string | null;
  splittable: number | null;
  google_task_id: string | null;
  google_list_id: string | null;
  sync_to_google: number | null;
  last_synced_at: string | null;
  updated_at: string | null;
  snoozed_until: string | null;
  last_surfaced_at: string | null;
  surface_count: number | null;
  retired_at: string | null;
}

export function createTask(task: {
  title: string;
  description?: string;
  group_id: string;
  assignee?: string;
  priority?: string;
  due_date?: string;
  source?: string;
  notes?: string;
  duration_minutes?: number;
  focus_level?: string;
  splittable?: boolean;
  sync_to_google?: boolean;
  google_task_id?: string;
  google_list_id?: string;
}): number {
  const assignee = task.assignee || 'owner';
  const sync = task.sync_to_google !== undefined
    ? (task.sync_to_google ? 1 : 0)
    : (assignee === 'brownbot' ? 0 : 1);
  const result = db.prepare(
    `INSERT INTO tasks (title, description, group_id, assignee, priority, due_date, source, notes, duration_minutes, focus_level, splittable, sync_to_google, google_task_id, google_list_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    task.title,
    task.description || null,
    task.group_id,
    assignee,
    task.priority || 'medium',
    task.due_date || null,
    task.source || 'manual',
    task.notes || null,
    task.duration_minutes || null,
    task.focus_level || null,
    task.splittable === false ? 0 : 1,
    sync,
    task.google_task_id || null,
    task.google_list_id || null,
  );
  return result.lastInsertRowid as number;
}

export function updateTaskStatus(taskId: number, status: string, notes?: string) {
  if (status === 'done' || status === 'cancelled') {
    db.prepare(
      "UPDATE tasks SET status = ?, notes = COALESCE(?, notes), completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).run(status, notes || null, taskId);
  } else {
    db.prepare(
      "UPDATE tasks SET status = ?, notes = COALESCE(?, notes), updated_at = datetime('now') WHERE id = ?"
    ).run(status, notes || null, taskId);
  }
}

export function getTaskById(taskId: number): Task | undefined {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined;
}

export function updateTaskFields(taskId: number, fields: Partial<Pick<Task, 'title' | 'description' | 'due_date' | 'notes' | 'priority'>>) {
  const sets: string[] = [];
  const params: (string | null)[] = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    params.push((v as string | null) ?? null);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  // Rescheduling (a new due_date) is a re-engagement: reset the decay ladder +
  // retirement so the moved deadline starts a fresh surfacing cycle.
  if ('due_date' in fields) {
    sets.push('surface_count = 0', 'last_surfaced_at = NULL', 'retired_at = NULL');
  }
  params.push(String(taskId));
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function setTaskGoogleMapping(taskId: number, googleTaskId: string, googleListId: string) {
  db.prepare(
    "UPDATE tasks SET google_task_id = ?, google_list_id = ?, last_synced_at = datetime('now') WHERE id = ?"
  ).run(googleTaskId, googleListId, taskId);
}

export function stampTaskSynced(taskId: number) {
  db.prepare("UPDATE tasks SET last_synced_at = datetime('now') WHERE id = ?").run(taskId);
}

export function clearTaskGoogleMapping(taskId: number) {
  db.prepare('UPDATE tasks SET google_task_id = NULL, google_list_id = NULL WHERE id = ?').run(taskId);
}

export function getTaskByGoogleId(googleTaskId: string): Task | undefined {
  return db.prepare('SELECT * FROM tasks WHERE google_task_id = ?').get(googleTaskId) as Task | undefined;
}

export function getTasksNeedingPush(): Task[] {
  return db.prepare(
    `SELECT * FROM tasks
     WHERE sync_to_google = 1
       AND (google_task_id IS NULL OR last_synced_at IS NULL OR updated_at > last_synced_at)`
  ).all() as Task[];
}

export function getTasksWithGoogleMapping(): Task[] {
  return db.prepare('SELECT * FROM tasks WHERE google_task_id IS NOT NULL').all() as Task[];
}

export function getOpenTasks(groupId?: string, assignee?: string): Task[] {
  let query = "SELECT * FROM tasks WHERE status IN ('open', 'in_progress')";
  const params: string[] = [];
  if (groupId) { query += ' AND group_id = ?'; params.push(groupId); }
  if (assignee) { query += ' AND assignee = ?'; params.push(assignee); }
  query += ' ORDER BY CASE priority WHEN \'urgent\' THEN 0 WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 ELSE 3 END, due_date ASC';
  return db.prepare(query).all(...params) as Task[];
}

// Resurface window for heartbeat task pings. Configurable via env so the user
// can dial reminder frequency without code edits.
const HEARTBEAT_RESURFACE_HOURS = Number(process.env.HEARTBEAT_RESURFACE_HOURS) || 6;

// Escalating backoff (organic reminders). Instead of a flat re-ping every N
// hours, the gap before a task is surfaced again grows with how many times it's
// already been surfaced: the first surface (surface_count 0) is immediate, then
// LADDER[surface_count-1] hours, capped at the last rung. So a task you keep
// ignoring goes quiet on its own instead of pinging every 6h. Tunable via
// HEARTBEAT_BACKOFF_HOURS (comma-separated hours), default ~1d, 2d, 4d, weekly.
const BACKOFF_LADDER_HOURS: number[] = (() => {
  const raw = process.env.HEARTBEAT_BACKOFF_HOURS;
  if (raw) {
    const parsed = raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0);
    if (parsed.length > 0) return parsed;
  }
  return [24, 48, 96, 168];
})();

// After this many surfaces a still-open task stops being re-pinged by the
// heartbeat and is routed to the morning "needs a decision" pass instead (one
// pointed question, then retired until touched). Tunable via HEARTBEAT_RETIRE_AFTER.
const RETIRE_AT_SURFACE_COUNT = Number(process.env.HEARTBEAT_RETIRE_AFTER) || 4;

// SQL CASE → hours to wait before the next surface, given surface_count. Built
// once from the ladder; the values are sanitized integers so they're safe to
// inline. surface_count 0 → 0h (immediate first ping).
const DECAY_HOURS_CASE: string = (() => {
  const rungs = BACKOFF_LADDER_HOURS;
  const lines = ['CASE', 'WHEN COALESCE(surface_count,0) <= 0 THEN 0'];
  for (let i = 0; i < rungs.length - 1; i++) {
    lines.push(`WHEN COALESCE(surface_count,0) = ${i + 1} THEN ${rungs[i]}`);
  }
  lines.push(`ELSE ${rungs[rungs.length - 1]}`);
  lines.push('END');
  return lines.join(' ');
})();

// Shared eligibility predicate: open, not snoozed, not retired, and the decayed
// resurface gap has elapsed. (Caller adds the overdue/due-soon time window.)
const DECAY_ELIGIBLE = `
       AND (snoozed_until IS NULL OR snoozed_until <= datetime('now'))
       AND retired_at IS NULL
       AND (last_surfaced_at IS NULL
            OR datetime(last_surfaced_at, '+' || (${DECAY_HOURS_CASE}) || ' hours') <= datetime('now'))`;

// Default-filtered versions used by the heartbeat + morning brief — exclude
// snoozed/retired tasks and tasks within their (decaying) resurface gap, and
// drop tasks that have crossed the retire threshold (those go to the morning
// decision pass via getTasksNeedingDecision). Cancelled tasks excluded by status.
export function getOverdueTasks(): Task[] {
  return db.prepare(
    `SELECT * FROM tasks
     WHERE status IN ('open', 'in_progress')
       AND due_date IS NOT NULL AND due_date < datetime('now')
       AND COALESCE(surface_count,0) < ${RETIRE_AT_SURFACE_COUNT}
       ${DECAY_ELIGIBLE}
     ORDER BY due_date ASC`
  ).all() as Task[];
}

export function getTasksDueSoon(hours: number): Task[] {
  return db.prepare(
    `SELECT * FROM tasks
     WHERE status IN ('open', 'in_progress')
       AND due_date IS NOT NULL
       AND due_date BETWEEN datetime('now') AND datetime('now', '+' || ? || ' hours')
       AND COALESCE(surface_count,0) < ${RETIRE_AT_SURFACE_COUNT}
       ${DECAY_ELIGIBLE}
     ORDER BY due_date ASC`
  ).all(hours) as Task[];
}

// Tasks that have been surfaced enough times to cross the retire threshold and
// are due for their next (decayed) surface — but instead of re-pinging, the
// morning brief asks one pointed question and retires them. Same snooze/retire/
// decay gating as the surfacing queries.
export function getTasksNeedingDecision(): Task[] {
  return db.prepare(
    `SELECT * FROM tasks
     WHERE status IN ('open', 'in_progress')
       AND due_date IS NOT NULL AND due_date < datetime('now')
       AND COALESCE(surface_count,0) >= ${RETIRE_AT_SURFACE_COUNT}
       ${DECAY_ELIGIBLE}
     ORDER BY due_date ASC`
  ).all() as Task[];
}

// Unfiltered variants for the dashboard, daily brief, etc. — these should
// always show the truth, not the dedup-aware view used by the heartbeat.
export function getOverdueTasksAll(): Task[] {
  return db.prepare(
    "SELECT * FROM tasks WHERE status IN ('open', 'in_progress') AND due_date IS NOT NULL AND due_date < datetime('now') ORDER BY due_date ASC"
  ).all() as Task[];
}

export function getTasksDueSoonAll(hours: number): Task[] {
  return db.prepare(
    `SELECT * FROM tasks WHERE status IN ('open', 'in_progress') AND due_date IS NOT NULL AND due_date BETWEEN datetime('now') AND datetime('now', '+' || ? || ' hours') ORDER BY due_date ASC`
  ).all(hours) as Task[];
}

export function snoozeTask(taskId: number, untilIso: string): void {
  // Snoozing is a re-engagement — reset the decay ladder + retirement so the
  // task gets a fresh cycle when the snooze expires (not an instant re-ping at
  // its old, decayed-out cadence).
  db.prepare(
    "UPDATE tasks SET snoozed_until = ?, surface_count = 0, last_surfaced_at = NULL, retired_at = NULL, updated_at = datetime('now') WHERE id = ?"
  ).run(untilIso, taskId);
}

export function markTaskSurfaced(taskId: number): void {
  db.prepare(
    "UPDATE tasks SET last_surfaced_at = datetime('now'), surface_count = COALESCE(surface_count, 0) + 1 WHERE id = ?"
  ).run(taskId);
}

// Pull a task out of the reminder rotation after the morning decision question.
// Stays out until the user touches it (resetTaskSurfacing clears retired_at).
export function markTaskRetired(taskId: number): void {
  db.prepare("UPDATE tasks SET retired_at = datetime('now') WHERE id = ?").run(taskId);
}

// "Touch" reset: the user re-engaged with the task (snoozed or rescheduled), so
// the decay ladder and any retirement start fresh — next time it's eligible it
// surfaces immediately, then decays again.
export function resetTaskSurfacing(taskId: number): void {
  db.prepare(
    "UPDATE tasks SET surface_count = 0, last_surfaced_at = NULL, retired_at = NULL WHERE id = ?"
  ).run(taskId);
}

export function getTaskStats(): { total: number; open: number; done: number; overdue: number } {
  const total = (db.prepare('SELECT COUNT(*) as c FROM tasks').get() as { c: number }).c;
  const open = (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status IN ('open', 'in_progress')").get() as { c: number }).c;
  const done = (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'done' AND completed_at > datetime('now', '-7 days')").get() as { c: number }).c;
  const overdue = (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status IN ('open', 'in_progress') AND due_date IS NOT NULL AND due_date < datetime('now')").get() as { c: number }).c;
  return { total, open, done, overdue };
}

export function updateTaskSchedule(taskId: number, calendarEventId: string) {
  db.prepare('UPDATE tasks SET calendar_event_id = ? WHERE id = ?').run(calendarEventId, taskId);
}

export function clearTaskSchedule(taskId: number) {
  db.prepare('UPDATE tasks SET calendar_event_id = NULL WHERE id = ?').run(taskId);
}

export function getSchedulableTasks(assignee?: string): Task[] {
  let query = "SELECT * FROM tasks WHERE status IN ('open', 'in_progress') AND calendar_event_id IS NULL";
  const params: string[] = [];
  if (assignee) { query += ' AND assignee = ?'; params.push(assignee); }
  query += " ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, due_date ASC";
  return db.prepare(query).all(...params) as Task[];
}

// --- Actions layer (Tier 2 Phase 1) ---
//
// propose → confirm → execute, with every transition stamped in-row. The
// payload_json snapshot frozen at propose time is the audit record. Spend SUMs
// are bounded by ET calendar day/week (see lib/time-et.ts); only status='done'
// rows with an actual_cost_cents count toward the cap.

export interface Action {
  id: number;
  kind: string;
  tool_name: string;
  summary: string;
  payload_json: string;
  estimated_cost_cents: number | null;
  actual_cost_cents: number | null;
  currency: string;
  reversible: number;
  status: string; // 'proposed' | 'confirmed' | 'executing' | 'done' | 'failed' | 'cancelled'
  category: string | null;
  autonomy_level: string;
  proposed_at: string;
  confirmed_at: string | null;
  executed_at: string | null;
  outcome: string | null;
  outcome_url: string | null;
  error: string | null;
  created_by_group: string;
  last_surfaced_at: string | null;
}

export function proposeAction(a: {
  kind: string;
  tool_name: string;
  summary: string;
  payload_json: string;
  estimated_cost_cents?: number | null;
  reversible?: boolean;
  category?: string | null;
  created_by_group: string;
}): number {
  const result = db.prepare(
    `INSERT INTO actions (kind, tool_name, summary, payload_json, estimated_cost_cents, reversible, category, created_by_group)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    a.kind,
    a.tool_name,
    a.summary,
    a.payload_json,
    a.estimated_cost_cents ?? null,
    a.reversible ? 1 : 0,
    a.category ?? null,
    a.created_by_group,
  );
  return result.lastInsertRowid as number;
}

export function getAction(id: number): Action | undefined {
  return db.prepare('SELECT * FROM actions WHERE id = ?').get(id) as Action | undefined;
}

export function listPendingActions(limit = 20): Action[] {
  return db.prepare(
    "SELECT * FROM actions WHERE status = 'proposed' ORDER BY proposed_at DESC LIMIT ?"
  ).all(limit) as Action[];
}

export function listRecentActions(limit = 20): Action[] {
  return db.prepare(
    `SELECT * FROM actions WHERE status IN ('done','failed','cancelled')
     ORDER BY COALESCE(executed_at, confirmed_at, proposed_at) DESC LIMIT ?`
  ).all(limit) as Action[];
}

// Edit-in-place while still 'proposed' (the `edit #action:N` path). Refreshes the
// frozen payload + derived summary/estimate; never advances status.
export function updateActionProposal(id: number, fields: {
  summary?: string;
  payload_json?: string;
  estimated_cost_cents?: number | null;
}): void {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (fields.summary !== undefined) { sets.push('summary = ?'); params.push(fields.summary); }
  if (fields.payload_json !== undefined) { sets.push('payload_json = ?'); params.push(fields.payload_json); }
  if (fields.estimated_cost_cents !== undefined) { sets.push('estimated_cost_cents = ?'); params.push(fields.estimated_cost_cents); }
  if (sets.length === 0) return;
  params.push(id);
  db.prepare(`UPDATE actions SET ${sets.join(', ')} WHERE id = ? AND status = 'proposed'`).run(...params);
}

export function confirmAction(id: number): void {
  db.prepare(
    "UPDATE actions SET status = 'confirmed', confirmed_at = datetime('now') WHERE id = ? AND status = 'proposed'"
  ).run(id);
}

export function markActionExecuting(id: number): void {
  db.prepare("UPDATE actions SET status = 'executing' WHERE id = ?").run(id);
}

export function markActionDone(id: number, r: { outcome: string; outcome_url?: string | null; actual_cost_cents: number }): void {
  db.prepare(
    "UPDATE actions SET status = 'done', outcome = ?, outcome_url = ?, actual_cost_cents = ?, executed_at = datetime('now') WHERE id = ?"
  ).run(r.outcome, r.outcome_url ?? null, r.actual_cost_cents, id);
}

export function markActionFailed(id: number, error: string): void {
  db.prepare(
    "UPDATE actions SET status = 'failed', error = ?, executed_at = datetime('now') WHERE id = ?"
  ).run(error, id);
}

// Returns true only if the row was in 'proposed'; lets the tool report a clean
// "already executed / already cancelled" instead of silently no-op'ing.
export function cancelAction(id: number): boolean {
  const result = db.prepare(
    "UPDATE actions SET status = 'cancelled' WHERE id = ? AND status = 'proposed'"
  ).run(id);
  return result.changes > 0;
}

export function getDailyActionSpendCents(): number {
  const since = toSqliteDate(startOfTodayET());
  const row = db.prepare(
    "SELECT COALESCE(SUM(actual_cost_cents), 0) AS c FROM actions WHERE status = 'done' AND executed_at >= ?"
  ).get(since) as { c: number };
  return row.c;
}

export function getWeeklyActionSpendCents(): number {
  const since = toSqliteDate(startOfWeekET());
  const row = db.prepare(
    "SELECT COALESCE(SUM(actual_cost_cents), 0) AS c FROM actions WHERE status = 'done' AND executed_at >= ?"
  ).get(since) as { c: number };
  return row.c;
}

export default db;
