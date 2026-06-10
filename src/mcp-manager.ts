import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync, existsSync } from 'fs';
import type Anthropic from '@anthropic-ai/sdk';
import type { ToolDef } from './tools/index.js';
import { mcpConfigPath } from './paths.js';

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

interface McpConnection {
  client: Client;
  transport: StdioClientTransport;
  serverName: string;
}

const connections: McpConnection[] = [];
const CONFIG_PATH = mcpConfigPath;

function loadConfig(): McpConfigFile | null {
  if (!existsSync(CONFIG_PATH)) {
    console.log('[MCP] No mcp-servers.json found — skipping MCP initialization');
    return null;
  }

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as McpConfigFile;
  } catch (err) {
    console.error('[MCP] Failed to parse mcp-servers.json:', err);
    return null;
  }
}

async function connectServer(name: string, config: McpServerConfig): Promise<ToolDef[]> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: { ...process.env, ...config.env } as Record<string, string>,
  });

  const client = new Client({ name: `secondbrain-${name}`, version: '1.0.0' });

  await client.connect(transport);
  connections.push({ client, transport, serverName: name });

  const { tools } = await client.listTools();
  console.log(`[MCP] ${name}: ${tools.length} tool(s) discovered`);

  return tools.map((tool) => ({
    definition: {
      name: `mcp_${name}_${tool.name}`,
      description: tool.description || `${name}: ${tool.name}`,
      input_schema: {
        type: 'object' as const,
        ...((tool.inputSchema as Record<string, unknown>) || {}),
      } as Anthropic.Tool.InputSchema,
    },
    handler: async (input: Record<string, unknown>) => {
      try {
        const result = await client.callTool({ name: tool.name, arguments: input });
        const parts = (result.content as Array<{ type: string; text?: string }>)
          .filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text);
        return parts.join('\n') || 'Done (no text output).';
      } catch (err) {
        return `MCP tool error (${name}/${tool.name}): ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  }));
}

export async function startMcpServers(): Promise<Record<string, ToolDef[]>> {
  const config = loadConfig();
  if (!config || !config.mcpServers) return {};

  const result: Record<string, ToolDef[]> = {};

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    try {
      console.log(`[MCP] Starting ${name} (${serverConfig.command} ${(serverConfig.args || []).join(' ')})...`);
      const tools = await connectServer(name, serverConfig);
      if (tools.length > 0) {
        result[name] = tools;
      }
      console.log(`[MCP] ${name}: ready`);
    } catch (err) {
      console.warn(`[MCP] ${name}: failed to start — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

export async function stopMcpServers(): Promise<void> {
  for (const conn of connections) {
    try {
      await conn.client.close();
      console.log(`[MCP] ${conn.serverName}: disconnected`);
    } catch {
      // Best effort cleanup
    }
  }
  connections.length = 0;
}
