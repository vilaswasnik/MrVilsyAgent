import { beforeEach, describe, expect, it } from "vitest";

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
} as Storage;

import { extractClaims, markTaskEnd, markTaskStart, readInterruptedTask, recordExecuted, verificationNote, verifyAnswer, wasRecentlyExecuted } from "./verify";

beforeEach(() => store.clear());

describe("claim verification", () => {
  const source = "From: hr@acme.com | 2026-10-14 | Offer: $85/hr, receipt ABC-12345, ref 9876543";

  it("accepts claims found in the source text", () => {
    const result = verifyAnswer("hr@acme.com wrote on 2026-10-14 offering $85 for receipt ABC-12345.", [source]);
    expect(result.checked).toBeGreaterThan(2);
    expect(result.unsupported).toEqual([]);
  });

  it("flags claims that are not in the source", () => {
    const result = verifyAnswer("The rate is $95 and the contact is boss@evil.com on 2026-11-30.", [source]);
    expect(result.unsupported).toEqual(expect.arrayContaining(["boss@evil.com", "2026-11-30", "$95"]));
    expect(verificationNote(result)).toContain("Verification");
  });

  it("finds nothing to check in plain prose", () => {
    expect(extractClaims("Nothing special here.")).toEqual([]);
  });
});

describe("crash recovery", () => {
  it("reports a task that never finished", () => {
    markTaskStart("Draft a reply to Acme");
    expect(readInterruptedTask()?.label).toBe("Draft a reply to Acme");
    markTaskEnd();
    expect(readInterruptedTask()).toBeNull();
  });

  it("refuses to repeat an action that already ran, then allows it later", () => {
    recordExecuted("draft_email:x", 1_000);
    expect(wasRecentlyExecuted("draft_email:x", 2_000)).toBe(true);
    expect(wasRecentlyExecuted("draft_email:x", 1_000 + 11 * 60_000)).toBe(false);
  });
});
