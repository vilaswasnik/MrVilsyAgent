// Pure logic for resume tailoring (evidence/gap check) and the application tracker.

const STOP = new Set(
  `a about above after all also an and any are as at be been before being but by can do does for from had has have if in into is it its may more most must no not of on or our out over per such that the their them then these they this to up us use used using via was we were what when where which while who will with within without you your years year experience required preferred plus strong ability work working role position job team company candidate candidates looking join including include includes etc new good great knowledge skills skill understanding responsibilities requirements qualifications duties responsible senior junior`.split(
    /\s+/,
  ),
);

const norm = (text: string) => text.toLowerCase().replace(/\s+/g, " ");

// Escape for a whole-token match that still works for terms like c++, c#, node.js.
function hasTerm(haystack: string, term: string): boolean {
  const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9+#])${escaped}($|[^a-z0-9+#])`, "i").test(haystack);
}

// Candidate skill terms from a job description, most frequent first.
export function extractKeywords(jd: string, limit = 30): string[] {
  const counts = new Map<string, number>();
  for (const raw of jd.match(/[A-Za-z][A-Za-z0-9+#./-]*[A-Za-z0-9+#]|[A-Za-z]/g) ?? []) {
    const word = raw.replace(/[./-]+$/, "").toLowerCase();
    if (word.length < 2 || STOP.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([word]) => word);
}

export interface FitReport {
  evidenced: string[];
  gaps: string[];
  coverage: number;
}

// A keyword is evidenced only if it appears in the master resume.
export function analyzeFit(jd: string, master: string, extra: string[] = []): FitReport {
  const keywords = [...new Set([...extraterms(extra), ...extractKeywords(jd)])];
  const masterText = norm(master);
  const evidenced = keywords.filter((k) => hasTerm(masterText, k));
  const gaps = keywords.filter((k) => !hasTerm(masterText, k));
  return { evidenced, gaps, coverage: keywords.length ? Math.round((evidenced.length / keywords.length) * 100) : 0 };
}

const extraterms = (terms: string[]) => terms.map((t) => t.trim().toLowerCase()).filter(Boolean);

// Gap keywords that a tailored resume wrongly claims.
export function claimedGaps(tailored: string, gaps: string[]): string[] {
  const text = norm(tailored);
  return gaps.filter((gap) => hasTerm(text, gap));
}

export function formatFitReport(report: FitReport): string {
  return [
    `Keyword coverage: ${report.coverage}% (${report.evidenced.length} of ${report.evidenced.length + report.gaps.length} job keywords are evidenced in the master resume).`,
    `Evidenced (safe to emphasize): ${report.evidenced.join(", ") || "none"}`,
    `GAP (not in the master resume; never claim these): ${report.gaps.join(", ") || "none"}`,
  ].join("\n");
}

export const isMasterPath = (path: string) => /^resumes\/master\.[a-z]+$/i.test(path.replace(/\\/g, "/").replace(/^\.?\//, ""));

export function safeResumePath(name: string): string {
  const clean = name.replace(/\.md$/i, "");
  if (!/^[\w-]+$/.test(clean)) throw new Error("Resume name may only contain letters, numbers, dashes and underscores.");
  const path = `resumes/${clean}.md`;
  if (isMasterPath(path)) throw new Error("The master resume is never overwritten. Choose a different name for the tailored version.");
  return path;
}

// ---- Application tracker (state/applications.md, a markdown table) ----

export const TRACKER_PATH = "state/applications.md";
export const TRACKER_HEADER = "# Applications\n\n| Date | Board | Company | Role | Resume | Status | Note |\n|---|---|---|---|---|---|---|\n";

export const TRACKER_STATUSES = ["applied", "ineligible", "skipped", "interview", "rejected", "offer"] as const;

export interface TrackerRow {
  date: string;
  board: string;
  company: string;
  role: string;
  resume: string;
  status: string;
  note: string;
}

const cell = (text: string) => text.replace(/[|\r\n]+/g, " ").trim();

export function formatRow(row: TrackerRow): string {
  return `| ${[row.date, row.board, row.company, row.role, row.resume, row.status, row.note].map(cell).join(" | ")} |\n`;
}

export function parseTracker(markdown: string): TrackerRow[] {
  return markdown
    .split(/\r?\n/)
    .filter((line) => line.startsWith("|") && !/^\|\s*(Date|-)/i.test(line))
    .map((line) => line.split("|").slice(1, -1).map((c) => c.trim()))
    .filter((c) => c.length >= 6)
    .map(([date, board, company, role, resume, status, note = ""]) => ({ date, board, company, role, resume, status, note }));
}

const key = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const paragraphs = (text: string) =>
  text
    .replace(/\f/g, "\n\n")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 1);

// Paragraphs present in only one of two versions of a document.
export function diffParagraphs(a: string, b: string): { onlyA: string[]; onlyB: string[] } {
  const pa = paragraphs(a);
  const pb = paragraphs(b);
  const setA = new Set(pa.map(key));
  const setB = new Set(pb.map(key));
  return { onlyA: pa.filter((p) => !setB.has(key(p))), onlyB: pb.filter((p) => !setA.has(key(p))) };
}

export function formatDiff(nameA: string, nameB: string, diff: { onlyA: string[]; onlyB: string[] }, limit = 12): string {
  const list = (items: string[]) => items.slice(0, limit).map((p) => `- ${p.slice(0, 300)}`).join("\n") + (items.length > limit ? `\n…and ${items.length - limit} more` : "");
  if (!diff.onlyA.length && !diff.onlyB.length) return `No differences found between ${nameA} and ${nameB} (paragraph-level comparison).`;
  return `Differences (paragraph-level). Describe the material ones; cite the file for each.\n\nOnly in ${nameA}:\n${list(diff.onlyA) || "- (nothing)"}\n\nOnly in ${nameB}:\n${list(diff.onlyB) || "- (nothing)"}`;
}

// Same role = same company and role title, on any board.
export function findDuplicate(rows: TrackerRow[], company: string, role: string): TrackerRow | undefined {
  return rows.find((row) => key(row.company) === key(company) && key(row.role) === key(role));
}
