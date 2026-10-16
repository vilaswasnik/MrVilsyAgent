import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "./storage";

export interface GmailTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export interface EmailSummary {
  id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
}

export interface EmailDetail extends EmailSummary {
  to: string;
  body: string;
}

// Opens the user's real system browser to Google's own sign-in page
// (OAuth + PKCE, no client secret, no password ever seen by this app).
export async function connectGmail(clientId: string): Promise<GmailTokens> {
  return invoke<GmailTokens>("gmail_connect", { clientId });
}

export async function refreshGmail(clientId: string, refreshToken: string): Promise<GmailTokens> {
  return invoke<GmailTokens>("gmail_refresh", { clientId, refreshToken });
}

export async function searchGmail(accessToken: string, query: string): Promise<EmailSummary[]> {
  return invoke<EmailSummary[]>("gmail_search", { accessToken, query });
}

export async function getGmailMessage(accessToken: string, id: string): Promise<EmailDetail> {
  return invoke<EmailDetail>("gmail_get_message", { accessToken, id });
}

// Creates a Gmail draft only. MrVilsyAgent never sends email automatically;
// you review and send it yourself from Gmail.
export async function createGmailDraft(
  accessToken: string,
  to: string,
  subject: string,
  body: string,
  threadId?: string,
): Promise<string> {
  return invoke<string>("gmail_create_draft", { accessToken, to, subject, body, threadId });
}

export function isGmailConnected(settings: Settings): boolean {
  return Boolean(settings.gmailRefreshToken);
}

// Returns a valid access token, transparently refreshing it first if it has
// expired (or is about to, within a minute).
export async function ensureGmailToken(
  settings: Settings,
  onChange: (patch: Partial<Settings>) => void,
): Promise<string> {
  const soonExpired = Date.now() > settings.gmailTokenExpiresAt - 60_000;
  if (!soonExpired && settings.gmailAccessToken) return settings.gmailAccessToken;
  if (!settings.gmailRefreshToken) throw new Error("Gmail is not connected.");
  const tokens = await refreshGmail(settings.gmailClientId, settings.gmailRefreshToken);
  onChange({
    gmailAccessToken: tokens.access_token,
    gmailRefreshToken: tokens.refresh_token ?? settings.gmailRefreshToken,
    gmailTokenExpiresAt: Date.now() + tokens.expires_in * 1000,
  });
  return tokens.access_token;
}
