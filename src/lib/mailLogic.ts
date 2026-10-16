export type MailCategory = "interview" | "recruiter" | "security" | "personal" | "ads";

interface Mini {
  subject: string;
  from: string;
  snippet?: string;
  date: string;
  id?: string;
}

const RULES: [MailCategory, RegExp][] = [
  ["security", /\b(security alert|sign-?in|verification code|one-time|password reset|suspicious|fraud|bank|statement|payment (due|failed)|unusual activity)\b/i],
  ["interview", /\b(interview|screening call|phone screen|technical round|schedule a call|availability for)\b/i],
  ["recruiter", /\b(recruiter|opportunity|opening|position|hiring|contract role|job description|your resume|your profile|rate)\b/i],
  ["ads", /\b(unsubscribe|newsletter|% off|sale|deal|promo|offer ends|limited time|coupon|webinar)\b/i],
];

// Rule-based first pass so a small model never has to guess; unmatched mail is "personal".
export function classifyMail(mail: Pick<Mini, "subject" | "from" | "snippet">): MailCategory {
  const text = `${mail.subject} ${mail.from} ${mail.snippet ?? ""}`;
  for (const [category, pattern] of RULES) if (pattern.test(text)) return category;
  if (/no-?reply|noreply|marketing|news@|offers@|promo/i.test(mail.from)) return "ads";
  return "personal";
}

export const normalizeSubject = (subject: string) =>
  subject.replace(/^\s*((re|fw|fwd)\s*:\s*)+/gi, "").replace(/\s+/g, " ").trim().toLowerCase();

export interface FollowUp {
  subject: string;
  to: string;
  sentAt: string;
  ageDays: number;
  kind: "awaiting-their-reply" | "awaiting-your-reply";
}

// Threads are matched by normalized subject. Heuristic: a thread is "awaiting their reply" when your
// newest sent message has no later inbox message with the same subject, and "awaiting your reply"
// when the newest inbox message has no later sent message.
export function findFollowUps(inbox: Mini[], sent: Mini[], now = Date.now(), minAgeDays = 3): FollowUp[] {
  const latest = (list: Mini[]) => {
    const map = new Map<string, Mini>();
    for (const mail of list) {
      const key = normalizeSubject(mail.subject);
      const at = Date.parse(mail.date);
      if (!key || Number.isNaN(at)) continue;
      const existing = map.get(key);
      if (!existing || at > Date.parse(existing.date)) map.set(key, mail);
    }
    return map;
  };
  const inboxLatest = latest(inbox);
  const sentLatest = latest(sent);
  const out: FollowUp[] = [];
  const age = (mail: Mini) => Math.floor((now - Date.parse(mail.date)) / 86_400_000);

  for (const [key, mail] of sentLatest) {
    const theirs = inboxLatest.get(key);
    if (theirs && Date.parse(theirs.date) > Date.parse(mail.date)) continue;
    if (age(mail) >= minAgeDays) out.push({ subject: mail.subject, to: mail.from, sentAt: mail.date, ageDays: age(mail), kind: "awaiting-their-reply" });
  }
  for (const [key, mail] of inboxLatest) {
    const mine = sentLatest.get(key);
    if (mine && Date.parse(mine.date) > Date.parse(mail.date)) continue;
    if (classifyMail(mail) === "ads") continue;
    if (age(mail) >= minAgeDays) out.push({ subject: mail.subject, to: mail.from, sentAt: mail.date, ageDays: age(mail), kind: "awaiting-your-reply" });
  }
  return out.sort((a, b) => b.ageDays - a.ageDays);
}

// Builds the draft: the reply, the signature exactly once, and the original quoted underneath.
export function composeDraft(body: string, signature: string, original: { from: string; date: string; body: string }): string {
  let text = body.replace(/\r\n/g, "\n").trim();
  const sig = signature.replace(/\r\n/g, "\n").trim();
  if (sig) {
    while (text.includes(sig)) text = text.replace(sig, "").trim();
    text = `${text}\n\n${sig}`;
  }
  const quoted = original.body
    .replace(/\r\n/g, "\n")
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `${text}\n\nOn ${original.date}, ${original.from} wrote:\n${quoted}`;
}

// Surfacing filter: routine "nothing new" runs stay silent in Reports.
export const NOTHING_NEW = "NOTHING_NEW";

export function isRoutineReport(text: string): boolean {
  const clean = text.trim();
  if (!clean) return true;
  if (clean.toUpperCase().startsWith(NOTHING_NEW)) return true;
  return /^(no new (mail|messages|emails)|nothing new|nothing to report)\b/i.test(clean) && clean.length < 160;
}

export function categoryLabel(category: MailCategory): string {
  return { interview: "INTERVIEW", recruiter: "RECRUITER", security: "BANK/SECURITY", personal: "PERSONAL", ads: "AD" }[category];
}
