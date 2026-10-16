import { describe, expect, it } from "vitest";
import { analyzeFit, claimedGaps, diffParagraphs, findDuplicate, formatRow, parseTracker, safeResumePath, TRACKER_HEADER } from "./resumeLogic";
import { chunkPaged, formatHits, type DocHit } from "./docs";

const master = "Data engineer. Python, SQL, Airflow and AWS. Built ETL pipelines.";
const jd = "We need Python, SQL, Kubernetes and Terraform. Kubernetes experience is key. Terraform too.";

describe("resume gap analysis", () => {
  it("reports unevidenced keywords as gaps and blocks claiming them", () => {
    const fit = analyzeFit(jd, master);
    expect(fit.gaps).toEqual(expect.arrayContaining(["kubernetes", "terraform"]));
    expect(fit.evidenced).toEqual(expect.arrayContaining(["python", "sql"]));
    expect(claimedGaps("Skills: Python, Kubernetes", fit.gaps)).toEqual(["kubernetes"]);
    expect(claimedGaps("Skills: Python, SQL, AWS", fit.gaps)).toEqual([]);
  });

  it("never overwrites the master resume", () => {
    expect(() => safeResumePath("master")).toThrow();
    expect(safeResumePath("acme-data")).toBe("resumes/acme-data.md");
    expect(() => safeResumePath("../x")).toThrow();
  });
});

describe("application tracker", () => {
  it("detects the same role on any board", () => {
    const rows = parseTracker(TRACKER_HEADER + formatRow({ date: "2026-10-17", board: "LinkedIn", company: "Acme Inc", role: "Data Engineer", resume: "a.md", status: "applied", note: "" }));
    expect(rows).toHaveLength(1);
    expect(findDuplicate(rows, "acme inc.", "data engineer")?.board).toBe("LinkedIn");
    expect(findDuplicate(rows, "Other", "Data Engineer")).toBeUndefined();
  });
});

describe("document versions and pages", () => {
  it("lists paragraphs that differ between two versions", () => {
    const d = diffParagraphs("Intro\n\nTerm is 12 months.\n\nSame.", "Intro\n\nTerm is 24 months.\n\nSame.");
    expect(d.onlyA).toEqual(["Term is 12 months."]);
    expect(d.onlyB).toEqual(["Term is 24 months."]);
  });

  it("labels chunks with the PDF page they came from", () => {
    const pages = Array.from({ length: 30 }, (_, i) => (i === 26 ? "The visa is valid until 2029-01-05." : `Filler page ${i + 1}.`));
    const chunks = chunkPaged(pages.join("\f"), 60, 10);
    const hit = chunks.find((c) => c.text.includes("2029-01-05"));
    expect(hit!.page! <= 27 && hit!.pageTo! >= 27).toBe(true);
    expect(chunks.every((c) => !c.text.includes("\f"))).toBe(true);
  });

  it("cites the page in hits", () => {
    const hit: DocHit = { file: "a.pdf", path: "a.pdf", kind: "chunk", n: 3, total: 9, page: 27, pageTo: 27, text: "x", score: 1, modifiedMs: 0 };
    expect(formatHits([hit])).toContain("page 27");
  });
});
