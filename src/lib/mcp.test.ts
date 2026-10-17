import { describe, expect, it } from "vitest";
import { buildMcpTools, isMcpTool, resolveMcp, splitArgs, type McpServer } from "./mcp";
import { validateCall, wrapToolOutput } from "./harness";

const server: McpServer = {
  id: "1",
  name: "My Files!",
  command: "npx",
  args: "-y pkg",
  enabled: true,
  tools: [{ name: "read.file", description: "Read", inputSchema: { properties: { path: { type: "string" } }, required: ["path"] } }],
};

describe("mcp", () => {
  it("splits arguments with quotes", () => {
    expect(splitArgs('-y pkg "C:\\My Docs" x')).toEqual(["-y", "pkg", "C:\\My Docs", "x"]);
  });

  it("builds prefixed tools only for enabled servers", () => {
    const [tool] = buildMcpTools([server]);
    expect(tool.function.name).toBe("mcp_my_files__read_file");
    expect(isMcpTool(tool.function.name)).toBe(true);
    expect(buildMcpTools([{ ...server, enabled: false }])).toEqual([]);
  });

  it("resolves a call back to its server and validates arguments", () => {
    const tools = buildMcpTools([server]);
    expect(resolveMcp([server], "mcp_my_files__read_file")?.tool.name).toBe("read.file");
    expect(resolveMcp([{ ...server, enabled: false }], "mcp_my_files__read_file")).toBeNull();
    expect(validateCall(tools, "mcp_my_files__read_file", {})).toMatch(/missing/);
    expect(validateCall(tools, "mcp_my_files__read_file", { path: "a" })).toBeNull();
  });

  it("marks MCP output as untrusted", () => {
    expect(wrapToolOutput("mcp_x__y", "hi")).toContain("<untrusted_content");
  });
});
