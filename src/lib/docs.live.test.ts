// Opt-in live check against the real local Ollama: LIVE=1 npx vitest run src/lib/docs.live.test.ts
import { describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ index: "" }));

const DOC = `Form I-797 Notice of Action\nReceipt number: WAC2412345678\nBeneficiary: Jane Doe\nClassification: H-1B Specialty Occupation\nValidity period: 10/01/2024 to 09/30/2027\nThis notice does not grant any immigration status by itself.`;
const PADDING = Array.from({ length: 60 }, (_, i) => `Cover letter paragraph ${i}: the employer confirms the position and duties.`).join("\n");

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "docs_scan":
        return [{ path: "C:\\Docs\\I-797.txt", name: "I-797.txt", size: 500, modified_ms: Date.parse("2024-10-05") }, { path: "C:\\Docs\\notes.txt", name: "notes.txt", size: 500, modified_ms: Date.parse("2025-01-01") }];
      case "docs_extract":
        return (args.path as string).includes("I-797") ? `${PADDING}\n\n${DOC}` : "Grocery list: milk, eggs, bread. Dentist appointment on Friday.";
      case "docs_index_load":
        return store.index;
      case "docs_index_save":
        store.index = args.json as string;
        return null;
      case "agent_list":
      case "agent_search":
        return [];
      case "agent_read":
        throw new Error("missing");
      default:
        throw new Error(`unexpected invoke ${cmd}`);
    }
  }),
}));

import { runAgent } from "./agent";
import { indexDocuments } from "./docs";
import { defaultSettings } from "./storage";
import type { ToolContext } from "./agentTools";

const live = process.env.LIVE ? describe : describe.skip;

live("live document Q&A", () => {
  const settings = { ...defaultSettings, model: "qwen2.5:7b", toolsEnabled: true };
  const ctx = { mail: {}, timezone: "UTC", baseUrl: "http://localhost:11434", embedModel: "nomic-embed-text", reminders: { list: () => [], add: () => {} } } as unknown as ToolContext;

  async function ask(question: string) {
    const calls: string[] = [];
    const answer = await runAgent({
      settings,
      history: [{ role: "user", content: question }],
      ctx,
      signal: new AbortController().signal,
      onToken: () => {},
      onTrace: (t) => calls.push(`${t.name}:${t.status}`),
      requestApproval: async () => "rejected",
    });
    return { answer, calls };
  }

  it("indexes, answers with a citation, and admits when it cannot find something", async () => {
    const result = await indexDocuments({ baseUrl: ctx.baseUrl, embedModel: "nomic-embed-text", chatModel: "qwen2.5:7b", summarizeLong: true, numCtx: 8192, signal: new AbortController().signal, onProgress: (m) => console.log(m) });
    expect(result.failed).toBe(0);

    const found = await ask("What does my I-797 document say my visa validity is?");
    console.log("FOUND:", found.calls, found.answer);
    expect(found.calls.some((c) => c.startsWith("search_documents"))).toBe(true);
    expect(found.answer).toMatch(/09\/30\/2027|September 30, 2027|30 September 2027/);
    expect(found.answer).toMatch(/I-797/);

    const missing = await ask("What is my passport number according to my documents?");
    console.log("MISSING:", missing.calls, missing.answer);
    expect(missing.answer).not.toMatch(/[A-Z]\d{8}/);
    expect(missing.answer.toLowerCase()).toMatch(/(cannot|can't|couldn't|could not|unable|not).*(find|found|locate|contain|include)|no .*(passport|information|mention)/);
  }, 600_000);
});
