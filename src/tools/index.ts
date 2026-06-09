import type Anthropic from '@anthropic-ai/sdk';
import { calendarTools } from './calendar.js';
import { githubTools } from './github.js';
import { webTools } from './web.js';
import { linkedinTools } from './linkedin.js';
import { careerOsTools } from './career-os.js';
import { financeTools } from './finance.js';
import { claudeCodeTools } from './claude-code.js';
import { householdTools } from './household.js';
import { browserTools } from './browser.js';
import { memoryTools } from './memory.js';
import { taskTools } from './tasks.js';
import { sparkTools } from './spark.js';
import { peopleTools } from './people.js';
import { messagesTools } from './messages.js';
import { recallTools } from './recall.js';
import { contentTools } from './content.js';
import { actionTools } from './actions.js';
import { canairyTools } from './canairy.js';
import { startMcpServers } from '../mcp-manager.js';

export interface ToolContext {
  groupKey: string;
}

export interface ToolDef {
  definition: Anthropic.Tool;
  handler: (input: Record<string, unknown>, context?: ToolContext) => Promise<string>;
}

export const toolRegistry: Record<string, ToolDef[]> = {
  calendar: calendarTools,
  github: githubTools,
  web: webTools,
  linkedin: linkedinTools,
  'career-os': careerOsTools,
  finance: financeTools,
  'claude-code': claudeCodeTools,
  household: householdTools,
  browser: browserTools,
  memory: memoryTools,
  tasks: taskTools,
  spark: sparkTools,
  people: peopleTools,
  messages: messagesTools,
  recall: recallTools,
  content: contentTools,
  actions: actionTools,
  canairy: canairyTools,
};

export async function registerMcpTools(): Promise<void> {
  const mcpTools = await startMcpServers();
  for (const [serverName, tools] of Object.entries(mcpTools)) {
    toolRegistry[serverName] = tools;
    console.log(`[Tools] Registered MCP tools: ${serverName} (${tools.length} tools)`);
  }
}
