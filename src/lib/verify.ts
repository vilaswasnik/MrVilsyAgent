// Harness safeguards that do not depend on the model: claim verification against the
// tool outputs of a run, in-flight task tracking for crash recovery, and duplicate-write protection.

const SOURCE_TOOLS = new Set(["read_inbox", "search_mail", "read_email", "search_documents", "read_file", "review_current_tab", "list_follow_ups", "compare_documents"]);

export const isSourceTool = (name: string) => SOURCE_TOOLS.has(name);

const norm = (text: string) => text.toLowerCase().replace(/[\s,]+/g, " ");
const digitsOnly = (text: string) => text.replace(/[^0-9]/g, "");

// Concrete facts a reader would act on: emails, dates, money, long numbers, ids like I-797.
export function extractClaims(answer: string): string[] {
  const found = new Set<string>();
  const add = (list: RegExpMatchArray | null) => list?.forEach((item) => found.add(item.trim()));
  add(answer.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g));
  add(answer.match(/\b\d{4}-\d{2}-\d{2}\b/g));
  add(answer.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g));
  add(answer.match(/\$\s?\d[\d,]*(\.\d+)?(\s?[kK])?/g));
  add(answer.match(/\b[A-Z]{1,4}-\d{2,}\b/g));
  add(answer.match(/\b\d{5,}\b/g));
  return [...found];
}

export interface Verification {
  checked: number;
  unsupported: string[];
}

// A claim is supported only if it appears in what the tools actually returned.
export function verifyAnswer(answer: string, sources: string[]): Verification {
  const claims = extractClaims(answer);
  const haystack = norm(sources.join("\n"));
  const digits = digitsOnly(sources.join("\n"));
  const unsupported = claims.filter((claim) => {
    if (haystack.includes(norm(claim))) return false;
    const d = digitsOnly(claim);
    return !(d.length >= 5 && digits.includes(d));
  });
  return { checked: claims.length, unsupported };
}

export function verificationNote(result: Verification): string {
  if (!result.unsupported.length) return "";
  return `\n\n⚠ Verification: ${result.unsupported.join(", ")} ${result.unsupported.length > 1 ? "do" : "does"} not appear in the source text I read. Treat ${result.unsupported.length > 1 ? "these" : "this"} as unconfirmed and check the original.`;
}

// ---- Crash recovery ----

const TASK_KEY = "mrvilsyagent.task.v1";
const DONE_KEY = "mrvilsyagent.executed.v1";
const DUPLICATE_WINDOW_MS = 10 * 60_000;

export interface InFlightTask {
  startedAt: number;
  label: string;
}

export function markTaskStart(label: string): void {
  try {
    localStorage.setItem(TASK_KEY, JSON.stringify({ startedAt: Date.now(), label: label.slice(0, 120) }));
  } catch {
    /* tracking must never break a run */
  }
}

export function markTaskEnd(): void {
  try {
    localStorage.removeItem(TASK_KEY);
  } catch {
    /* ignore */
  }
}

// A record left behind means the app closed while a task was running.
export function readInterruptedTask(): InFlightTask | null {
  try {
    const raw = localStorage.getItem(TASK_KEY);
    return raw ? (JSON.parse(raw) as InFlightTask) : null;
  } catch {
    return null;
  }
}

// ---- No duplicate actions ----

function readDone(now: number): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(DONE_KEY) ?? "{}") as Record<string, number>;
    return Object.fromEntries(Object.entries(parsed).filter(([, at]) => now - at < DUPLICATE_WINDOW_MS));
  } catch {
    return {};
  }
}

export function wasRecentlyExecuted(key: string, now = Date.now()): boolean {
  return key in readDone(now);
}

export function recordExecuted(key: string, now = Date.now()): void {
  try {
    const done = readDone(now);
    done[key] = now;
    localStorage.setItem(DONE_KEY, JSON.stringify(done));
  } catch {
    /* ignore */
  }
}
