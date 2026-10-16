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
export async function draftReply(ctx: MailContext, messageId: string, body: string): Promise<string> {
  const settings = requireConnected(ctx);
  if (settings.mailProvider === "outlook") {
    return createOutlookDraft(await ensureOutlookToken(settings, ctx.patchSettings), messageId, body);
  }
  const token = await ensureGmailToken(settings, ctx.patchSettings);
  const original = await getGmailMessage(token, messageId);
  const replyTo = original.from.match(/<(.+?)>/)?.[1] ?? original.from;
  const subject = original.subject.toLowerCase().startsWith("re:") ? original.subject : `Re: ${original.subject}`;
  return createGmailDraft(token, replyTo, subject, body, messageId);
}
