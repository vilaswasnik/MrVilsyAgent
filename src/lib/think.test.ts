import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "agent_write") {
      const path = args.path as string;
      files.set(path, (args.append ? files.get(path) ?? "" : "") + (args.content as string));
      return null;
    }
    throw new Error(`unexpected invoke ${cmd}`);
  }),
}));

import { chat } from "./ollama";
import { executeTool, type ToolContext } from "./agentTools";
import { stripThink, ThinkFilter } from "./think";

const ctx = { mail: {}, timezone: "UTC", baseUrl: "http://localhost:11434", reminders: { list: () => [], add: () => {} } } as unknown as ToolContext;

function streamOf(lines: object[]): Response {
  const body = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  return new Response(body, { status: 200 });
}

describe("think stripping", () => {
  it("removes complete and unterminated reasoning blocks", () => {
    expect(stripThink("<think>plan</think>\n\nHello")).toBe("Hello");
    expect(stripThink("Hi <think>cut off")).toBe("Hi ");
  });

  it("filters reasoning even when tags are split across stream chunks", () => {
    const filter = new ThinkFilter();
    const chunks = ["<thi", "nk>secret", " plan</th", "ink>Answer ", "is 391"];
    const out = chunks.map((chunk) => filter.push(chunk)).join("") + filter.flush();
    expect(out.trim()).toBe("Answer is 391");
  });
});

describe("reasoning never reaches output or memory files", () => {
  beforeEach(() => files.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("chat() shows and returns only the visible answer and ignores the thinking field", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      streamOf([
        { message: { role: "assistant", content: "", thinking: "internal chain of thought" } },
        { message: { role: "assistant", content: "<think>let me reason" } },
        { message: { role: "assistant", content: " more</think>\n\nThe answer is 391." }, done: true },
      ]),
    ));
    const shown: string[] = [];
    const result = await chat("http://localhost:11434", "qwen3:8b", [{ role: "user", content: "17*23?" }], (t) => shown.push(t), new AbortController().signal);
    expect(result.content).toBe("The answer is 391.");
    expect(shown.join("")).toBe("The answer is 391.");
  });

  it("sends think:false by default and retries without it for models that reject it", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      return bodies.length === 1
        ? new Response('{"error":"\\"x\\" does not support thinking"}', { status: 400 })
        : streamOf([{ message: { content: "ok" }, done: true }]);
    }));
    const result = await chat("http://localhost:11434", "x", [], () => {}, new AbortController().signal, undefined, 8192, false);
    expect(result.content).toBe("ok");
    expect(JSON.parse(bodies[0]).think).toBe(false);
    expect("think" in JSON.parse(bodies[1])).toBe(false);
  });

  it("save_memory does not write reasoning into MEMORY.md", async () => {
    await executeTool("save_memory", { fact: "<think>user maybe wants this</think>My dentist is Dr. Okafor.", scope: "durable" }, ctx);
    const memory = files.get("MEMORY.md") ?? "";
    expect(memory).toContain("My dentist is Dr. Okafor.");
    expect(memory).not.toMatch(/think|maybe wants/i);
  });

  it("save_memory refuses a fact that is only reasoning", async () => {
    await expect(executeTool("save_memory", { fact: "<think>only thoughts</think>", scope: "durable" }, ctx)).rejects.toThrow();
    expect(files.has("MEMORY.md")).toBe(false);
  });
});
