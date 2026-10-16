import { beforeEach, describe, expect, it, vi } from "vitest";

const inbox = vi.hoisted(() => ({ items: [] as { id: string; from: string; subject: string; date: string; snippet: string }[] }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./mail", () => ({
  readInbox: vi.fn(async () => inbox.items),
  searchMail: vi.fn(),
  getMail: vi.fn(),
  draftReply: vi.fn(),
}));

import { executeTool, type ToolContext } from "./agentTools";

const mail = (id: string, iso: string) => ({ id, from: "a@b.c", subject: `s-${id}`, date: iso, snippet: "" });

describe("inbox watermark", () => {
  beforeEach(() => {
    inbox.items = [mail("old", "2026-10-17T08:00:00Z"), mail("edge", "2026-10-17T09:00:00Z"), mail("new1", "2026-10-17T09:30:00Z"), mail("new2", "2026-10-17T10:00:00Z")];
  });

  it("reports only mail newer than the watermark and reports the newest seen message", async () => {
    let seen: { at: number; id: string } | null = null;
    const ctx = {
      mail: {},
      watermark: Date.parse("2026-10-17T09:00:00Z"),
      lastSeenId: "edge",
      onInboxSeen: (at: number, id: string) => (seen = { at, id }),
    } as unknown as ToolContext;
    const out = await executeTool("read_inbox", {}, ctx);
    expect(out).toContain("new1");
    expect(out).toContain("new2");
    expect(out).not.toContain("s-old");
    expect(out).not.toContain("s-edge");
    expect(seen).toEqual({ at: Date.parse("2026-10-17T10:00:00Z"), id: "new2" });
  });

  it("does not move the watermark for an explicit since_hours lookup", async () => {
    const onInboxSeen = vi.fn();
    await executeTool("read_inbox", { since_hours: 48 }, { mail: {}, onInboxSeen } as unknown as ToolContext);
    expect(onInboxSeen).not.toHaveBeenCalled();
  });
});
