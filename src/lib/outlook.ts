import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "./storage";

export interface OutlookTokens {
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

// Opens the user's real system browser to Microsoft's own sign-in page
// (OAuth + PKCE, no client secret, no password ever seen by this app).
export async function connectOutlook(clientId: string): Promise<OutlookTokens> {
  return invoke<OutlookTokens>("outlook_connect", { clientId });
}

export async function refreshOutlook(clientId: string, refreshToken: string): Promise<OutlookTokens> {
  return invoke<OutlookTokens>("outlook_refresh", { clientId, refreshToken });
}

export async function searchOutlook(accessToken: string, query: string): Promise<EmailSummary[]> {
  return invoke<EmailSummary[]>("outlook_search", { accessToken, query });
}

export async function recentOutlook(accessToken: string, sinceIso: string): Promise<EmailSummary[]> {
  return invoke<EmailSummary[]>("outlook_recent", { accessToken, sinceIso });
}

export async function getOutlookMessage(accessToken: string, id: string): Promise<EmailDetail> {
  return invoke<EmailDetail>("outlook_get_message", { accessToken, id });
}

// Creates an Outlook draft reply only. MrVilsyAgent never sends email
// automatically; you review and send it yourself from Outlook.
export async function createOutlookDraft(accessToken: string, messageId: string, body: string): Promise<string> {
  return invoke<string>("outlook_create_draft", { accessToken, messageId, body });
}

export function isOutlookConnected(settings: Settings): boolean {
  return Boolean(settings.outlookRefreshToken);
}

// Returns a valid access token, transparently refreshing it first if it has
// expired (or is about to, within a minute).
export async function ensureOutlookToken(
  settings: Settings,
  onChange: (patch: Partial<Settings>) => void,
): Promise<string> {
  const soonExpired = Date.now() > settings.outlookTokenExpiresAt - 60_000;
  if (!soonExpired && settings.outlookAccessToken) return settings.outlookAccessToken;
  if (!settings.outlookRefreshToken) throw new Error("Outlook is not connected.");
  const tokens = await refreshOutlook(settings.outlookClientId, settings.outlookRefreshToken);
  onChange({
    outlookAccessToken: tokens.access_token,
    outlookRefreshToken: tokens.refresh_token ?? settings.outlookRefreshToken,
    outlookTokenExpiresAt: Date.now() + tokens.expires_in * 1000,
  });
  return tokens.access_token;
}
