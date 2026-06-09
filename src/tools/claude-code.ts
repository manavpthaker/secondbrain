import { spawn } from 'child_process';
import { existsSync } from 'fs';
import type { ToolDef } from './index.js';
import { validateRepoName } from './path-utils.js';

// launchd starts brownbot with the default PATH (/usr/bin:/bin:/usr/sbin:/sbin), which
// does NOT include Homebrew's /opt/homebrew/bin where `claude` lives — so a bare
// spawn('claude') fails with ENOENT. Pin an absolute path (env-overridable) instead.
const CLAUDE_BIN = process.env.CLAUDE_CODE_BIN || '/opt/homebrew/bin/claude';

export const claudeCodeTools: ToolDef[] = [
  {
    definition: {
      name: 'spawn_claude_code',
      description: 'Spawn a Claude Code session on the Mac mini to work on a repository. Runs with --dangerously-skip-permissions. Returns the session output when complete. Use for code changes, debugging, and development tasks.',
      input_schema: {
        type: 'object' as const,
        properties: {
          repo: { type: 'string', description: 'Repository name under ~/Documents/GitHub/' },
          prompt: { type: 'string', description: 'The task prompt for Claude Code' },
        },
        required: ['repo', 'prompt'],
      },
    },
    handler: async (input) => {
      const repo = input.repo as string;
      const prompt = input.prompt as string;
      let repoPath: string;
      try {
        repoPath = validateRepoName(repo);
      } catch (err) {
        return `spawn_claude_code rejected: ${err instanceof Error ? err.message : String(err)}`;
      }

      if (!existsSync(CLAUDE_BIN)) {
        return `Claude Code binary not found at ${CLAUDE_BIN}. Set CLAUDE_CODE_BIN to the absolute path of the \`claude\` CLI.`;
      }

      return new Promise<string>((resolve) => {
        let output = '';
        const child = spawn(CLAUDE_BIN, [
          '--dangerously-skip-permissions',
          '-p', prompt,
        ], {
          cwd: repoPath,
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        child.stdout.on('data', (data: Buffer) => {
          output += data.toString();
        });

        child.stderr.on('data', (data: Buffer) => {
          output += data.toString();
        });

        // Timeout after 5 minutes
        const timeout = setTimeout(() => {
          child.kill();
          resolve(`Claude Code session timed out after 5 minutes. Partial output:\n${output.slice(-2000)}`);
        }, 5 * 60 * 1000);

        child.on('close', (code) => {
          clearTimeout(timeout);
          if (code === 0) {
            resolve(output.slice(-4000) || 'Claude Code session completed with no output.');
          } else {
            resolve(`Claude Code exited with code ${code}. Output:\n${output.slice(-2000)}`);
          }
        });

        child.on('error', (err) => {
          clearTimeout(timeout);
          resolve(`Failed to spawn Claude Code: ${err.message}`);
        });
      });
    },
  },
];
