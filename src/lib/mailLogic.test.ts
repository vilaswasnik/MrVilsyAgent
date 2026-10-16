import { describe, expect, it } from "vitest";
import { classifyMail, composeDraft, findFollowUps, isRoutineReport } from "./mailLogic";
import { isJobDue } from "./scheduler";
import type { Job } from "./storage";

describe("classifyMail", () => {
  it("labels common mail types", () => {
    expect(classifyMail({ subject: "Interview availability", from: "a@b.com" })).toBe("interview");
    expect(classifyMail({ subject: "New contract role at Acme", from: "r@staff.com" })).toBe("recruiter");
    expect(classifyMail({ subject: "Security alert: new sign-in", from: "no-reply@bank.com" })).toBe("security");
    expect(classifyMail({ subject: "50% off sale", from: "promo@shop.com" })).toBe("ads");
    expect(classifyMail({ subject: "Dinner Friday?", from: "friend@mail.com" })).toBe("personal");
  });
});

describe("findFollowUps", () => {
  const now = Date.parse("2026-10-17T00:00:00Z");
  const day = (n: number) => new Date(now - n * 86_400_000).toISOString();
  it("finds threads waiting on either side and ignores answered ones", () => {
    const sent = [
      { subject: "Re: Quote", from: "vendor@x.com", date: day(5) },
      { subject: "Lunch", from: "pal@x.com", date: day(6) },
    ];
    const inbox = [
      { subject: "Lunch", from: "pal@x.com", date: day(4) },
      { subject: "Contract question", from: "boss@x.com", date: day(4) },
      { subject: "Deals!", from: "promo@shop.com", date: day(9) },
    ];
    const result = findFollowUps(inbox, sent, now);
    expect(result.find((r) => r.subject === "Re: Quote")?.kind).toBe("awaiting-their-reply");
    expect(result.find((r) => r.subject === "Contract question")?.kind).toBe("awaiting-your-reply");
    expect(result.some((r) => r.subject === "Lunch" && r.kind === "awaiting-their-reply")).toBe(false);
    expect(result.some((r) => r.subject === "Deals!")).toBe(false);
  });
});

describe("composeDraft", () => {
  const original = { from: "Pat <pat@x.com>", date: "Oct 1", body: "Can you join?\nThanks" };
  it("keeps real paragraphs, one signature, and quotes the original", () => {
    const text = composeDraft("Hi Pat,\n\nYes.\n\nRegards,\nSam", "Regards,\nSam", original);
    expect(text.match(/Regards,/g)).toHaveLength(1);
    expect(text).toContain("Hi Pat,\n\nYes.");
    expect(text).toContain("On Oct 1, Pat <pat@x.com> wrote:\n> Can you join?\n> Thanks");
  });
});

describe("surfacing filter", () => {
  it("treats empty and nothing-new runs as routine", () => {
    expect(isRoutineReport("NOTHING_NEW")).toBe(true);
    expect(isRoutineReport("")).toBe(true);
    expect(isRoutineReport("No new mail since 10:00.")).toBe(true);
    expect(isRoutineReport("1 recruiter email from Acme")).toBe(false);
  });
});

describe("catch-up", () => {
  const job = (over: Partial<Job>): Job => ({ id: "j", name: "j", prompt: "", schedule: { kind: "interval", minutes: 60 }, enabled: true, lastRunAt: 0, watermark: 0, ...over });
  it("runs an interval job immediately after a long gap, once", () => {
    const now = Date.now();
    expect(isJobDue(job({ lastRunAt: now - 5 * 3_600_000 }), now)).toBe(true);
    expect(isJobDue(job({ lastRunAt: now }), now)).toBe(false);
  });
  it("runs a daily job that was missed while the app was closed", () => {
    const at = new Date(); at.setHours(8, 0, 0, 0);
    const now = at.getTime() + 3 * 3_600_000;
    expect(isJobDue(job({ schedule: { kind: "daily", time: "08:00" }, lastRunAt: at.getTime() - 86_400_000 }), now)).toBe(true);
    expect(isJobDue(job({ schedule: { kind: "daily", time: "08:00" }, lastRunAt: now - 1000 }), now)).toBe(false);
  });
});
