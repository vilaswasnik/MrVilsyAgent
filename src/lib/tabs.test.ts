import { describe, expect, it } from "vitest";
import { formatTab, scanPosting } from "./tabs";

const posting = `Senior Data Engineer
Contract, 6 months, remote
Rate: $70/hr on C2C
Candidates must be a U.S. citizen and hold an active secret clearance.
No sponsorship available.`;

describe("posting scan", () => {
  it("surfaces citizenship, clearance, sponsorship and rate lines for citing", () => {
    const out = scanPosting(posting);
    expect(out).toContain('CITIZENSHIP / CLEARANCE: "Candidates must be a U.S. citizen');
    expect(out).toContain("No sponsorship available.");
    expect(out).toContain("$70/hr");
    expect(out).toContain("remote");
  });

  it("says so when nothing relevant is on the page", () => {
    expect(scanPosting("Welcome to our blog about cooking.")).toContain("CITIZENSHIP / CLEARANCE: nothing found");
  });

  it("includes the age of the shared page", () => {
    const text = formatTab({ url: "https://x.test/j", title: "Job", text: posting, received_ms: 0 }, 5 * 60000);
    expect(text).toContain("5 min ago");
    expect(text).toContain("https://x.test/j");
  });
});
