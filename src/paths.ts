import { join, resolve, dirname } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, cpSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';

// ─────────────────────────────────────────────────────────────────────────────
// paths.ts — single source of truth for every filesystem path.
//
// Two roots:
//   PACKAGE_ROOT  — the installed package directory (templates, examples, seeds)
//   DATA_HOME     — user state (db, config, generated context, backups, logs)
//
// For a `git clone` dev setup these overlap (both point to the repo root).
// For a global npm install they diverge: PACKAGE_ROOT is wherever npm put the
// package, DATA_HOME is ~/.secondbrain/ (or SECONDBRAIN_HOME).
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The installed package root (repo root in dev, npm package dir in production). */
export const PACKAGE_ROOT = resolve(__dirname, '..');

/** User data directory. Override with SECONDBRAIN_HOME env var. */
export const DATA_HOME = process.env.SECONDBRAIN_HOME
  || process.env.BROWNBOT_HOME
  || join(homedir(), '.secondbrain');

// ── User state paths (DATA_HOME) ────────────────────────────────────────────

export const dbPath = join(DATA_HOME, 'secondbrain.db');
export const profilePath = join(DATA_HOME, 'config', 'profile.json');
export const profileDir = join(DATA_HOME, 'config');
export const userContextDir = join(DATA_HOME, 'context');
export const userSharedContextDir = join(DATA_HOME, 'context', 'shared');
export const envPath = join(DATA_HOME, '.env');
export const mcpConfigPath = join(DATA_HOME, 'mcp-servers.json');
export const backupsDir = join(DATA_HOME, 'backups');
export const draftsDir = join(DATA_HOME, 'drafts');
export const logsDir = join(DATA_HOME, 'logs');
export const dataDir = join(DATA_HOME, 'data');

// ── Package-shipped paths (PACKAGE_ROOT, read-only) ─────────────────────────

export const packageContextDir = join(PACKAGE_ROOT, 'context');
export const packageExamplesDir = join(PACKAGE_ROOT, 'context', '_examples');
export const packageSeedsDir = join(PACKAGE_ROOT, 'context', 'seeds');
export const packageLaunchdDir = join(PACKAGE_ROOT, 'launchd');
export const envExamplePath = join(PACKAGE_ROOT, '.env.example');

// ── Detect dev mode ─────────────────────────────────────────────────────────

/** True when running from the repo checkout (not a global npm install). */
export const isDevMode = existsSync(join(PACKAGE_ROOT, 'tsconfig.json'));

// ── Resolve context paths ───────────────────────────────────────────────────

/**
 * Resolve a context file path. Looks in user data dir first, falls back to
 * the package-shipped version (for synthetic groups, examples, seeds).
 */
export function resolveContextPath(...segments: string[]): string {
  const userPath = join(userContextDir, ...segments);
  if (existsSync(userPath)) return userPath;
  const packagePath = join(packageContextDir, ...segments);
  return packagePath;
}

/**
 * Resolve a shared context file (identity.md, voice.md, profile.md, security.md).
 * User-generated versions in DATA_HOME take precedence over package defaults.
 */
export function resolveSharedFile(filename: string): string {
  return resolveContextPath('shared', filename);
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

const DATA_SUBDIRS = [
  'config',
  'context',
  'context/shared',
  'backups',
  'drafts',
  'logs',
  'data',
];

/**
 * Ensure the data home directory exists with all required subdirectories.
 * Called by the CLI before any command that needs state.
 *
 * In dev mode (running from repo checkout), this is a no-op — state lives
 * in the repo tree alongside the source.
 */
export function ensureDataHome(): void {
  if (isDevMode) return;

  for (const sub of DATA_SUBDIRS) {
    const dir = join(DATA_HOME, sub);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  // Seed package-shipped context templates into user context dir if empty
  const syntheticGroups = ['brain-pulse', 'idea-pulse', 'reflection', 'content'];
  for (const group of syntheticGroups) {
    const dest = join(userContextDir, group);
    const src = join(packageContextDir, group);
    if (!existsSync(dest) && existsSync(src)) {
      cpSync(src, dest, { recursive: true });
    }
  }

  // Seed security.md if not present
  const secDest = join(userSharedContextDir, 'security.md');
  const secSrc = join(packageContextDir, 'shared', 'security.md');
  if (!existsSync(secDest) && existsSync(secSrc)) {
    cpSync(secSrc, secDest);
  }
}

// ── Dev-mode compatibility ──────────────────────────────────────────────────

/**
 * In dev mode, paths resolve to the repo tree (backward-compatible with the
 * pre-CLI layout). In production (npm install), paths resolve to DATA_HOME.
 *
 * This getter lets callers that need the "root" for legacy patterns get the
 * right directory without caring which mode they're in.
 */
export function getRoot(): string {
  return isDevMode ? PACKAGE_ROOT : DATA_HOME;
}
