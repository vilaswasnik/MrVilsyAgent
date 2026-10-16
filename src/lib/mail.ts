import {
  createGmailDraft,
  ensureGmailToken,
  getGmailMessage,
  isGmailConnected,
  searchGmail,
  type EmailDetail,
  type EmailSummary,
} from "./gmail";
import {
  createOutlookDraft,
  ensureOutlookToken,
  getOutlookMessage,
  isOutlookConnected,
  recentOutlook,
  searchOutlook,
} from "./outlook";
import type { Settings } from "./storage";
import { composeDraft } from "./mailLogic";

export interface MailContext {
  getSettings: () => Settings;
  patchSettings: (patch: Partial<Settings>) => void;
}

export function mailConnected(settings: Settings): boolean {
  return settings.mailProvider === "gmail" ? isGmailConnected(settings) : isOutlookConnected(settings);
}

function requireConnected(ctx: MailContext): Settings {
  const settings = ctx.getSettings();
  if (!mailConnected(settings)) throw new Error("No mail account is connected. Connect one in the Mail panel first.");
  return settings;
}

// Read-only: new inbox mail received after `sinceMs`.
export async function readInbox(ctx: MailContext, sinceMs: number): Promise<EmailSummary[]> {
  const settings = requireConnected(ctx);
  if (settings.mailProvider === "gmail") {
    const token = await ensureGmailToken(settings, ctx.patchSettings);
    return searchGmail(token, `in:inbox after:${Math.floor(sinceMs / 1000)}`);
  }
  const token = await ensureOutlookToken(settings, ctx.patchSettings);
  return recentOutlook(token, new Date(sinceMs).toISOString().replace(/\.\d+Z$/, "Z"));
}

export async function searchMail(ctx: MailContext, query: string): Promise<EmailSummary[]> {
  const settings = requireConnected(ctx);
  return settings.mailProvider === "gmail"
    ? searchGmail(await ensureGmailToken(settings, ctx.patchSettings), query)
    : searchOutlook(await ensureOutlookToken(settings, ctx.patchSettings), query);
}

export async function getMail(ctx: MailContext, id: string): Promise<EmailDetail> {
  const settings = requireConnected(ctx);
  return settings.mailProvider === "gmail"
    ? getGmailMessage(await ensureGmailToken(settings, ctx.patchSettings), id)
    : getOutlookMessage(await ensureOutlookToken(settings, ctx.patchSettings), id);
}

// Saves a reply draft on the original thread. There is no send capability.
// The draft keeps the signature once and quotes the original message underneath.
export async function draftReply(ctx: MailContext, messageId: string, body: string): Promise<string> {
  const settings = requireConnected(ctx);
  const original = await getMail(ctx, messageId);
  const text = composeDraft(body, settings.signature, { from: original.from, date: original.date, body: original.body });
  if (settings.mailProvider === "outlook") {
    return createOutlookDraft(await ensureOutlookToken(settings, ctx.patchSettings), messageId, text);
  }
  const token = await ensureGmailToken(settings, ctx.patchSettings);
  const replyTo = original.from.match(/<(.+?)>/)?.[1] ?? original.from;
  const subject = original.subject.toLowerCase().startsWith("re:") ? original.subject : `Re: ${original.subject}`;
  return createGmailDraft(token, replyTo, subject, text, messageId);
}

type Folder = "inbox" | "sent" | "junk";

// Read-only: recent mail in one folder.
export async function readFolder(ctx: MailContext, folder: Folder, days: number): Promise<EmailSummary[]> {
  const settings = requireConnected(ctx);
  if (settings.mailProvider === "gmail") {
    const token = await ensureGmailToken(settings, ctx.patchSettings);
    const scope = { inbox: "in:inbox", sent: "in:sent", junk: "in:spam" }[folder];
    return searchGmail(token, `${scope} newer_than:${days}d`);
  }
  const token = await ensureOutlookToken(settings, ctx.patchSettings);
  const since = new Date(Date.now() - days * 86_400_000).toISOString().replace(/\.\d+Z$/, "Z");
  return recentOutlook(token, since, folder);
}

export async function readThreads(ctx: MailContext, days: number) {
  const [inbox, sent] = await Promise.all([readFolder(ctx, "inbox", days), readFolder(ctx, "sent", days)]);
  return { inbox, sent };
}
