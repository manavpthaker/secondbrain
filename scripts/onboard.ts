import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { createInterface } from 'readline';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

/**
 * `npm run onboard` — the Mirror.
 *
 * A conversational setup wizard. Instead of hand-editing a dozen config files,
 * it interviews you (a short strategic conversation, the same "reflect you back
 * to yourself" idea behind the product), then GENERATES your assistant's
 * identity, voice, always-on profile, seed facts, per-group context, and .env
 * keys. This is also what makes the repo a clean template: there is no personal
 * data committed — your data only ever lands in gitignored files this writes.
 *
 *   npm run onboard         full run (writes real files + .env)
 *   npm run onboard:dry     generate into .onboard-dry/ and print — no real writes
 *
 * Resumable: progress is saved to .onboard-state.json so a re-run continues.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DRY = process.argv.includes('--dry');
const DRY_DIR = join(ROOT, '.onboard-dry');
const STATE_PATH = join(ROOT, '.onboard-state.json');

const MODEL = process.env.SECONDBRAIN_MODEL || process.env.BROWNBOT_MODEL || 'claude-sonnet-4-6';

// Group key → the context dir its CLAUDE.md lives in, and the example template
// to seed it from. (The Home group's context dir is historically "personal".)
const GROUP_MAP: Record<string, { contextDir: string; example: string }> = {
  admin: { contextDir: 'admin', example: 'admin.md' },
  home: { contextDir: 'personal', example: 'personal.md' },
  work: { contextDir: 'work', example: 'work.md' },
  finance: { contextDir: 'finance', example: 'finance.md' },
  health: { contextDir: 'health', example: 'health.md' },
  'job-search': { contextDir: 'job-search', example: 'job-search.md' },
};

// ── tiny prompt helpers ──────────────────────────────────────────────────────
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> =>
  new Promise((res) => rl.question(q, (a) => res(a.trim())));
const askDefault = async (q: string, def: string): Promise<string> =>
  (await ask(`${q} [${def}]: `)) || def;
const askYesNo = async (q: string, def = false): Promise<boolean> => {
  const a = (await ask(`${q} (${def ? 'Y/n' : 'y/N'}): `)).toLowerCase();
  if (!a) return def;
  return a.startsWith('y');
};

function banner(s: string) {
  console.log(`\n\x1b[1m${s}\x1b[0m`);
}

// ── artifact writer (dry-aware) ──────────────────────────────────────────────
function writeArtifact(relPath: string, content: string) {
  const target = DRY ? join(DRY_DIR, relPath) : join(ROOT, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  console.log(`  ${DRY ? '(dry) would write' : 'wrote'} ${relPath}${DRY ? ` → ${target}` : ''}`);
}

// Upsert KEY=value lines into .env (skipped in dry mode).
function setEnv(updates: Record<string, string>) {
  if (DRY) {
    for (const [k, v] of Object.entries(updates)) {
      console.log(`  (dry) would set ${k}=${k.includes('KEY') || k.includes('TOKEN') ? '***' : v}`);
    }
    return;
  }
  const envPath = join(ROOT, '.env');
  let lines = existsSync(envPath) ? readFileSync(envPath, 'utf-8').split('\n') : [];
  for (const [key, value] of Object.entries(updates)) {
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    const line = `${key}=${value}`;
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
  }
  writeFileSync(envPath, lines.join('\n'));
  console.log(`  updated .env (${Object.keys(updates).join(', ')})`);
}

function loadState(): any {
  if (existsSync(STATE_PATH)) {
    try { return JSON.parse(readFileSync(STATE_PATH, 'utf-8')); } catch { /* ignore */ }
  }
  return {};
}
function saveState(state: any) {
  if (DRY) return;
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ── the Mirror conversation ──────────────────────────────────────────────────

const SUBMIT_TOOL: Anthropic.Tool = {
  name: 'submit_profile',
  description: 'Call this once, at the END of the interview, with everything you have gathered. Generate the markdown files (identity, voice, profile) fully written in the owner\'s chosen tone — they are used verbatim as the assistant\'s system prompt.',
  input_schema: {
    type: 'object',
    properties: {
      botName: { type: 'string', description: "What the assistant is called, e.g. 'Milo'." },
      triggerWord: { type: 'string', description: "The @-trigger for group chats, e.g. '@milo'. Lowercase, starts with @." },
      householdName: { type: 'string', description: "Collective noun for who it serves, e.g. 'Rivera family' or 'Alex'." },
      owner: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          shortName: { type: 'string', description: 'Initials or nickname, e.g. "AR".' },
          tone: { type: 'string', enum: ['direct', 'warm', 'playful'] },
        },
        required: ['name', 'shortName', 'tone'],
      },
      people: {
        type: 'array',
        description: 'Inner circle (partner, kids, key contacts, etc). Seeded into the CRM.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            relationship: { type: 'string', description: 'e.g. partner, child, friend, colleague.' },
            role: { type: 'string' },
            notes: { type: 'string' },
          },
          required: ['name'],
        },
      },
      groupsEnabled: {
        type: 'array',
        description: 'Which groups to turn on. Subset of: admin, home, work, finance, health, job-search. Always include admin.',
        items: { type: 'string' },
      },
      identityMarkdown: { type: 'string', description: "context/shared/identity.md — the assistant's soul (~25 lines). Use the bot name + household." },
      voiceMarkdown: { type: 'string', description: 'context/shared/voice.md — how it talks to the owner, in their chosen tone (~30 lines), with a banned-LLM-tells list.' },
      profileMarkdown: { type: 'string', description: "context/shared/profile.md — the always-on owner profile narrative built from the interview (~40-60 lines)." },
      facts: {
        type: 'array',
        description: '8-15 atomic facts distilled from the interview for retrieval.',
        items: {
          type: 'object',
          properties: {
            subject: { type: 'string' },
            predicate: { type: 'string' },
            object: { type: 'string' },
            fact_type: { type: 'string', enum: ['fact', 'preference', 'decision', 'commitment', 'metric'] },
          },
          required: ['subject', 'predicate', 'object'],
        },
      },
    },
    required: ['botName', 'triggerWord', 'householdName', 'owner', 'groupsEnabled', 'identityMarkdown', 'voiceMarkdown', 'profileMarkdown', 'facts'],
  },
};

const MIRROR_SYSTEM = `You are conducting the onboarding interview for a personal AI assistant that will run on the user's Mac and talk to them over iMessage. It becomes their "second brain": tasks, calendar, a people/CRM layer, durable facts, proactive reminders.

Your job: interview the user with a SHORT, sharp conversation (aim for 7-10 exchanges, ONE question at a time, no walls of text), then call submit_profile with everything — including fully-written identity.md, voice.md, and profile.md in the tone they ask for.

Cover, conversationally and in roughly this order:
1. What they want to call the assistant (and the @-trigger for group chats).
2. Who they are: name, what they do, what they're optimizing for right now.
3. Their inner circle: partner, kids, key people (names + one-line context each).
4. Their daily rhythm (rough — wake, work blocks, commitments).
5. How they want it to talk to them: tone (direct / warm / playful), and any "never do this" lines.
6. Which areas to turn on: admin is always on; offer home, work, finance, health, job-search.

Rules:
- One question per turn. React briefly to what they said before asking the next thing. Be warm but efficient.
- Do NOT ask for phone numbers, emails, or API keys — the script handles those separately.
- When you have enough, call submit_profile. Write the markdown files richly and specifically from what they told you, in their chosen voice. The profile is third-person ("about <name>"). Avoid LLM-tell phrases.
Start now with your first question.`;

async function runMirror(client: Anthropic): Promise<any> {
  const messages: Anthropic.MessageParam[] = [];
  // Kick the model for its opening question.
  messages.push({ role: 'user', content: "Let's begin. Ask me your first question." });

  for (let turn = 0; turn < 24; turn++) {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: MIRROR_SYSTEM,
      tools: [SUBMIT_TOOL],
      messages,
    });

    const toolUse = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (toolUse && toolUse.name === 'submit_profile') {
      return toolUse.input;
    }

    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    console.log(`\n\x1b[36m${text}\x1b[0m`);
    messages.push({ role: 'assistant', content: resp.content });

    const answer = await ask('\n› ');
    if (!answer) {
      // empty answer — nudge the model to wrap up
      messages.push({ role: 'user', content: '(no answer — if you have enough, go ahead and submit the profile)' });
    } else {
      messages.push({ role: 'user', content: answer });
    }
  }
  throw new Error('Interview did not converge — re-run npm run onboard.');
}

// ── artifact generation ──────────────────────────────────────────────────────

function substitute(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
}

function generateGroupContext(profile: any) {
  const vars = {
    BOT_NAME: profile.botName,
    OWNER_NAME: profile.owner.name,
    OWNER_SHORT: profile.owner.shortName,
    PARTNER_NAME: (profile.people || []).find((p: any) => /partner|spouse|wife|husband/i.test(p.relationship || ''))?.name || 'your household',
    HOUSEHOLD: profile.householdName,
  };
  for (const key of profile.groupsEnabled as string[]) {
    const map = GROUP_MAP[key];
    if (!map) { console.log(`  · skipping unknown group "${key}"`); continue; }
    const examplePath = join(ROOT, 'context', '_examples', 'groups', map.example);
    if (!existsSync(examplePath)) { console.log(`  · no template for group "${key}" (${map.example}) — skipping`); continue; }
    const rendered = substitute(readFileSync(examplePath, 'utf-8'), vars);
    writeArtifact(join('context', map.contextDir, 'CLAUDE.md'), rendered);
  }
}

function buildProfileJson(profile: any) {
  const members = (profile.people || [])
    .filter((p: any) => /partner|spouse|wife|husband/i.test(p.relationship || ''))
    .map((p: any) => ({
      id: 'partner',
      name: p.name,
      tone: 'warm',
      role: 'member',
      allowedGroups: ['home'],
      phoneEnv: 'USER_PARTNER',
      emailEnv: 'USER_PARTNER_EMAIL',
    }));

  return {
    botName: profile.botName,
    triggerWord: profile.triggerWord,
    householdName: profile.householdName,
    owner: {
      id: 'owner',
      name: profile.owner.name,
      shortName: profile.owner.shortName,
      tone: profile.owner.tone,
      role: 'admin',
      allowedGroups: Array.from(new Set([...(profile.groupsEnabled || []), 'reflection', 'brain-pulse', 'content'])),
      phoneEnv: 'USER_OWNER',
      emailEnv: 'USER_OWNER_EMAIL',
    },
    members,
    people: profile.people || [],
    groupsEnabled: profile.groupsEnabled,
  };
}

// ── phases ───────────────────────────────────────────────────────────────────

async function phaseApiKey(state: any): Promise<string> {
  banner('Step 1 — Anthropic API key');
  let key = process.env.ANTHROPIC_API_KEY || state.apiKey;
  if (key) {
    console.log('  found ANTHROPIC_API_KEY in environment.');
  } else {
    key = await ask('  Paste your Anthropic API key (sk-ant-…): ');
  }
  if (!key) throw new Error('An API key is required for the Mirror conversation.');

  // Validate with a tiny call.
  process.stdout.write('  validating… ');
  const client = new Anthropic({ apiKey: key });
  try {
    await client.messages.create({ model: process.env.SECONDBRAIN_ROUTER_MODEL || process.env.BROWNBOT_ROUTER_MODEL || 'claude-haiku-4-5', max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] });
    console.log('ok.');
  } catch (err) {
    console.log('failed.');
    throw new Error(`API key validation failed: ${(err as Error).message}`);
  }
  setEnv({ ANTHROPIC_API_KEY: key });
  state.apiKey = key;
  saveState(state);
  return key;
}

async function phaseContacts(profile: any) {
  banner('Step 4 — Your handles');
  console.log('  These map iMessage senders to people. Stored in .env, never committed.');
  const ownerPhone = await ask('  Your phone (e.g. +15551234567), or blank to skip: ');
  const ownerEmail = await ask('  Your iMessage email (Apple ID), or blank: ');
  const env: Record<string, string> = { TRIGGER_WORD: profile.triggerWord };
  if (ownerPhone) env.USER_OWNER = ownerPhone;
  if (ownerEmail) env.USER_OWNER_EMAIL = ownerEmail;

  const partner = (profile.people || []).find((p: any) => /partner|spouse|wife|husband/i.test(p.relationship || ''));
  if (partner) {
    const pPhone = await ask(`  ${partner.name}'s phone (for the Home group), or blank: `);
    const pEmail = await ask(`  ${partner.name}'s email, or blank: `);
    if (pPhone) env.USER_PARTNER = pPhone;
    if (pEmail) env.USER_PARTNER_EMAIL = pEmail;
    if (pEmail) env.HOME_AUTO_ATTENDEE = pEmail;
  }
  const ghRoot = await ask('  Path to your local repos for the Work group (e.g. ~/Documents/GitHub), or blank: ');
  if (ghRoot) env.BROWNBOT_GH_ROOT = ghRoot;
  setEnv(env);
}

async function phaseIntegrations() {
  banner('Step 5 — Integrations (all optional)');

  if (!DRY && await askYesNo('  Set up Google Calendar + Tasks now (opens a browser)?', false)) {
    console.log('  launching npm run auth:google …');
    spawnSync('npm', ['run', 'auth:google'], { cwd: ROOT, stdio: 'inherit' });
  } else {
    console.log('  skip — run `npm run auth:google` anytime.');
  }

  if (!DRY && await askYesNo('  Import Apple Contacts into the people layer now?', false)) {
    spawnSync('npm', ['run', 'import:contacts'], { cwd: ROOT, stdio: 'inherit' });
  } else {
    console.log('  skip — run `npm run import:contacts` anytime.');
  }

  console.log('\n  iMessage groups: start the bot (npm run dev) and message it; unmapped group');
  console.log('  chat IDs are logged as "[groups] Unmapped chat: … — add to .env to enable".');
  console.log('  Map them to GROUP_ADMIN / GROUP_HOME / GROUP_WORK / GROUP_FINANCE / etc. in .env.');
}

async function phaseSeedAndVerify() {
  banner('Step 6 — Seed + health check');
  if (DRY) { console.log('  (dry) would run: npm run seed:facts && npm run doctor'); return; }
  if (await askYesNo('  Seed the brain with your profile facts now?', true)) {
    spawnSync('npm', ['run', 'seed:facts'], { cwd: ROOT, stdio: 'inherit' });
  }
  if (await askYesNo('  Run the health check (npm run doctor)?', true)) {
    spawnSync('npm', ['run', 'doctor'], { cwd: ROOT, stdio: 'inherit' });
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  banner(`brownbot onboarding — the Mirror${DRY ? '  (DRY RUN — nothing real is written)' : ''}`);
  console.log('A short conversation, then your assistant is configured.\n');

  const [major] = process.versions.node.split('.').map(Number);
  if (major < 20) console.log(`  ⚠ Node ${process.versions.node} detected — Node 20+ recommended.`);
  if (process.platform !== 'darwin') console.log('  ⚠ Not macOS — the iMessage channel needs a Mac. You can still configure here.');

  const state = loadState();
  const apiKey = await phaseApiKey(state);

  banner('Step 2 — The conversation');
  console.log('  Answer naturally. One question at a time. Ctrl-C to stop (re-run resumes).\n');
  const client = new Anthropic({ apiKey });

  let profile = state.profile;
  if (profile) {
    console.log('  Found a saved profile from a previous run.');
    if (await askYesNo('  Reuse it (skip the conversation)?', true)) {
      // keep it
    } else {
      profile = await runMirror(client);
    }
  } else {
    profile = await runMirror(client);
  }
  state.profile = profile;
  saveState(state);

  banner('Step 3 — Generating your assistant');
  writeArtifact('config/profile.json', JSON.stringify(buildProfileJson(profile), null, 2));
  writeArtifact('context/shared/identity.md', profile.identityMarkdown);
  writeArtifact('context/shared/voice.md', profile.voiceMarkdown);
  writeArtifact('context/shared/profile.md', profile.profileMarkdown);
  writeArtifact('context/seeds/facts.json', JSON.stringify(profile.facts || [], null, 2));
  generateGroupContext(profile);

  await phaseContacts(profile);
  await phaseIntegrations();
  await phaseSeedAndVerify();

  banner('Done.');
  console.log(`  ${profile.botName} is configured for ${profile.owner.name}.`);
  if (DRY) {
    console.log(`  Review the generated files under ${DRY_DIR}, then run \x1b[1mnpm run onboard\x1b[0m for real.`);
  } else {
    console.log('  Next: finish any skipped integrations, then \x1b[1mnpm run dev\x1b[0m to go live.');
    console.log('  Re-run \x1b[1mnpm run onboard\x1b[0m anytime to adjust.');
  }
  rl.close();
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  rl.close();
  process.exit(1);
});
