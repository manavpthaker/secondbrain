#!/usr/bin/env node
import { readFileSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { PACKAGE_ROOT, ensureDataHome, isDevMode, DATA_HOME } from './paths.js';

// ─────────────────────────────────────────────────────────────────────────────
// Second Brain CLI — zero-dep subcommand dispatcher.
//
// Compiled to dist/cli.js, wired as the `bin` entry in package.json.
// Each command wraps an existing entrypoint. Scripts that live outside src/
// (in scripts/) are spawned as child processes via tsx/node.
// ─────────────────────────────────────────────────────────────────────────────

const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const HELP = `
Second Brain — a personal AI assistant that runs on your Mac

Usage: secondbrain <command> [options]

Commands:
  init              Run the onboarding wizard (the Mirror)
  start             Start the assistant (iMessage + dashboard + all loops)
  doctor            Health check: facts seeded, loops firing, backup fresh
  auth google       Set up Google Calendar + Tasks OAuth
  seed              Seed owner profile facts and inner-circle people
  install           Install launchd agents (run on boot)
  uninstall         Remove launchd agents
  help              Show this help message

Options:
  --version, -v     Show version number
  --help, -h        Show help

Data directory: ${DATA_HOME}
`.trim();

// ── Preflight checks ────────────────────────────────────────────────────────

function checkNode(): void {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 20) {
    console.error(`Second Brain requires Node.js 20+. You have ${process.version}.`);
    process.exit(1);
  }
}

function checkPlatform(command: string): void {
  const macOnly = new Set(['start', 'install', 'uninstall']);
  if (macOnly.has(command) && process.platform !== 'darwin') {
    console.error(`"secondbrain ${command}" requires macOS (iMessage + launchd).`);
    process.exit(1);
  }
}

async function loadDotenv(): Promise<void> {
  if (!isDevMode) {
    const dotenv = await import('dotenv');
    dotenv.config({ path: join(DATA_HOME, '.env') });
  } else {
    await import('dotenv/config');
  }
}

// ── Spawn a script from scripts/ ────────────────────────────────────────────

function runScript(scriptName: string, args: string[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const scriptPath = join(PACKAGE_ROOT, 'scripts', scriptName);
    // In dev: use tsx. In production (npm install): scripts are pre-compiled
    // alongside dist/, or we use tsx if available.
    const tsxBin = join(PACKAGE_ROOT, 'node_modules', '.bin', 'tsx');
    const child = spawn(tsxBin, [scriptPath, ...args], {
      stdio: 'inherit',
      cwd: PACKAGE_ROOT,
      env: { ...process.env },
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Script ${scriptName} exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

// ── Command handlers ────────────────────────────────────────────────────────

async function cmdInit(args: string[]): Promise<void> {
  await runScript('onboard.ts', args.includes('--dry') ? ['--dry'] : []);
}

async function cmdStart(): Promise<void> {
  checkPlatform('start');
  await loadDotenv();
  const { main } = await import('./index.js') as { main: () => Promise<void> };
  await main();
}

async function cmdDoctor(): Promise<void> {
  await loadDotenv();
  const { runHealthCheck, formatHealthReport } = await import('./doctor.js');
  const report = runHealthCheck();
  console.log(formatHealthReport(report));
  process.exit(report.healthy ? 0 : 1);
}

async function cmdAuthGoogle(): Promise<void> {
  await runScript('google-auth.ts');
}

async function cmdSeed(args: string[]): Promise<void> {
  await runScript('seed-facts.ts', args.includes('--dry') ? ['--dry'] : []);
}

async function cmdInstall(): Promise<void> {
  checkPlatform('install');
  console.log('Installing launchd agents...');
  // TODO: generate com.secondbrain.* plists from templates,
  // pointed at the installed CLI bin, and launchctl load them.
  console.log('Not yet implemented. Use the manual launchd setup from README for now.');
}

async function cmdUninstall(): Promise<void> {
  checkPlatform('uninstall');
  console.log('Removing launchd agents...');
  // TODO: launchctl unload + remove plists
  console.log('Not yet implemented. Manually unload with: launchctl unload ~/Library/LaunchAgents/com.secondbrain.*');
}

// ── Dispatcher ──────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  checkNode();

  const args = process.argv.slice(2);
  const command = args[0]?.toLowerCase();
  const rest = args.slice(1);

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }
  if (command === '--version' || command === '-v') {
    console.log(`secondbrain v${VERSION}`);
    return;
  }

  // Ensure data home exists before running commands that need state
  ensureDataHome();

  switch (command) {
    case 'init':
      await cmdInit(rest);
      break;
    case 'start':
      await cmdStart();
      break;
    case 'doctor':
      await cmdDoctor();
      break;
    case 'auth':
      if (rest[0]?.toLowerCase() === 'google') {
        await cmdAuthGoogle();
      } else {
        console.error(`Unknown auth target: ${rest[0] || '(none)'}. Try: secondbrain auth google`);
        process.exit(1);
      }
      break;
    case 'seed':
      await cmdSeed(rest);
      break;
    case 'install':
      await cmdInstall();
      break;
    case 'uninstall':
      await cmdUninstall();
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
