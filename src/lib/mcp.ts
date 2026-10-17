import { invoke } from "@tauri-apps/api/core";
import type { ToolDefinition } from "./ollama";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: { type?: string; properties?: Record<string, unknown>; required?: string[] };
}

export interface McpServer {
  id: string;
  name: string;
  command: string;
  // Space-separated; double quotes group words that contain spaces.
  args: string;
  enabled: boolean;
  tools: McpTool[];
}

const PREFIX = "mcp_";
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "x";

export const isMcpTool = (name: string) => name.startsWith(PREFIX);
export const mcpToolName = (server: McpServer, tool: McpTool) => `${PREFIX}${slug(server.name)}__${slug(tool.name)}`.slice(0, 64);

export function splitArgs(line: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line))) out.push(match[1] ?? match[2]);
  return out;
}

// Only enabled servers contribute tools, and only ones the user has connected (tools discovered).
export function buildMcpTools(servers: McpServer[]): ToolDefinition[] {
  return servers
    .filter((server) => server.enabled)
    .flatMap((server) =>
      server.tools.map((tool) => ({
        type: "function" as const,
        function: {
          name: mcpToolName(server, tool),
          description: `[MCP server "${server.name}"] ${tool.description || tool.name}`.slice(0, 600),
          parameters: {
            type: "object",
            properties: tool.inputSchema?.properties ?? {},
            required: tool.inputSchema?.required ?? [],
          },
        },
      })),
    );
}

export function resolveMcp(servers: McpServer[], fullName: string): { server: McpServer; tool: McpTool } | null {
  for (const server of servers) {
    if (!server.enabled) continue;
    const tool = server.tools.find((item) => mcpToolName(server, item) === fullName);
    if (tool) return { server, tool };
  }
  return null;
}

export async function discoverMcp(server: Pick<McpServer, "command" | "args">): Promise<McpTool[]> {
  const raw = await invoke<{ name?: string; description?: string; inputSchema?: McpTool["inputSchema"] }[]>("mcp_discover", {
    command: server.command.trim(),
    args: splitArgs(server.args),
  });
  return raw
    .filter((item) => typeof item.name === "string" && item.name)
    .map((item) => ({ name: item.name!, description: item.description ?? "", inputSchema: item.inputSchema ?? {} }));
}

export const callMcp = (server: McpServer, tool: string, args: Record<string, unknown>) =>
  invoke<string>("mcp_call", { command: server.command.trim(), args: splitArgs(server.args), tool, arguments: args });

export function describeMcpCall(server: McpServer, tool: string, args: Record<string, unknown>): string {
  return `Run the MCP tool "${tool}" on server "${server.name}".\nThis starts: ${server.command} ${server.args}\nArguments:\n${JSON.stringify(args, null, 2)}`;
}
