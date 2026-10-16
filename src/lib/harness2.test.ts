import { describe, expect, it } from "vitest";
import { compactHistory, estimateTokens } from "./harness";
import { buildMemoryNotes } from "./onboarding";
import { recommendModels } from "./hardware";

const turns = (n: number, size: number) =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? ("user" as const) : ("assistant" as const), content: `${i}:`.padEnd(size, "x") }));

describe("compactHistory", () => {
  it("leaves short history alone", async () => {
    const result = await compactHistory(turns(4, 50), 10_000, async () => "never");
    expect(result.compacted).toBe(false);
    expect(result.kept).toHaveLength(4);
  });
  it("summarizes older turns, keeps the newest, and starts on a user turn", async () => {
    const history = turns(20, 500);
    const result = await compactHistory(history, 4000, async (older) => `summary of ${older.length}`);
    expect(result.compacted).toBe(true);
    expect(result.summary).toMatch(/^summary of \d+/);
    expect(result.kept.at(-1)).toBe(history.at(-1));
    expect(result.kept[0].role).toBe("user");
    expect(result.kept.length).toBeLessThan(history.length);
  });
  it("falls back to trimming when summarizing fails", async () => {
    const result = await compactHistory(turns(20, 500), 4000, async () => { throw new Error("offline"); });
    expect(result.compacted).toBe(true);
    expect(result.summary).toBe("");
  });
  it("estimates tokens", () => expect(estimateTokens(400)).toBe(100));
});

describe("onboarding and hardware", () => {
  it("builds notes only from filled answers", () => {
    expect(buildMemoryNotes({})).toEqual([]);
    const notes = buildMemoryNotes({ name: "Sam", role: " " });
    expect(notes).toHaveLength(1);
    expect(notes[0].fact).toContain("- Your name: Sam");
    expect(notes[0].fact).not.toContain("Role");
  });
  it("recommends models by RAM", () => {
    expect(recommendModels(8).main).toBe("qwen3:4b");
    expect(recommendModels(16).main).toBe("qwen3:8b");
    expect(recommendModels(32).main).toBe("qwen3:14b");
    expect(recommendModels(64).main).toBe("qwen3:32b");
  });
});
