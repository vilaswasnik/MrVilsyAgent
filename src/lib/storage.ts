import type { Conversation } from "../types";

const CONVERSATIONS_KEY = "mrvilsyagent.conversations.v1";
const SETTINGS_KEY = "mrvilsyagent.settings.v1";

export interface Settings {
  baseUrl: string;
  model: string;
  email: string;
  agentName: string;
  userName: string;
  timezone: string;
  jobTitle: string;
  priorities: string;
  signature: string;
  extraRules: string;
  toolsEnabled: boolean;
  numCtx: number;
  // Optional smaller model for background summaries (compaction); empty = use the main model.
  fastModel: string;
  // When false, reasoning models (Qwen3, DeepSeek-R1) are asked not to think: faster replies.
  thinking: boolean;
  mailProvider: "gmail" | "outlook";
  gmailClientId: string;
  gmailAccessToken: string;
  gmailRefreshToken: string;
  gmailTokenExpiresAt: number;
  outlookClientId: string;
  outlookAccessToken: string;
  outlookRefreshToken: string;
  outlookTokenExpiresAt: number;
}

export const defaultSettings: Settings = {
  baseUrl: "http://localhost:11434",
  model: "",
  email: "",
  agentName: "MrVilsyAgent",
  userName: "",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  jobTitle: "",
  priorities: "",
  signature: "",
  extraRules: "",
  toolsEnabled: true,
  numCtx: 8192,
  fastModel: "",
  thinking: false,
  mailProvider: "outlook",
  gmailClientId: "",
  gmailAccessToken: "",
  gmailRefreshToken: "",
  gmailTokenExpiresAt: 0,
  outlookClientId: "",
  outlookAccessToken: "",
  outlookRefreshToken: "",
  outlookTokenExpiresAt: 0,
};

export function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(CONVERSATIONS_KEY);
    return raw ? (JSON.parse(raw) as Conversation[]) : [];
  } catch {
    return [];
  }
}

export function saveConversations(conversations: Conversation[]): void {
  localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversations));
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...defaultSettings, ...(JSON.parse(raw) as Partial<Settings>) } : defaultSettings;
  } catch {
    return defaultSettings;
  }
}

export function saveSettings(settings: Settings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(scrubTokens ? withoutTokens(settings) : settings));
}

// Once the Credential Manager is ready, no OAuth token is ever written to localStorage.
let scrubTokens = false;
export function enableTokenScrubbing(): void {
  scrubTokens = true;
}

export function withoutTokens(settings: Settings): Settings {
  return { ...settings, gmailAccessToken: "", gmailRefreshToken: "", outlookAccessToken: "", outlookRefreshToken: "" };
}

export interface Job {
  id: string;
  name: string;
  prompt: string;
  schedule: { kind: "interval"; minutes: number } | { kind: "daily"; time: string };
  enabled: boolean;
  lastRunAt: number;
  // Only mail received after this time is considered "new" by the inbox watch.
  watermark: number;
  lastSeenId?: string;
}

export interface Report {
  id: string;
  jobId: string;
  jobName: string;
  at: number;
  text: string;
  error?: string;
}

export interface PendingAction {
  id: string;
  source: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  createdAt: number;
}

const JOBS_KEY = "mrvilsyagent.jobs.v1";
const REPORTS_KEY = "mrvilsyagent.reports.v1";
const PENDING_KEY = "mrvilsyagent.pending.v1";

// Scheduled jobs are read-only by design and ship disabled until the user opts in.
export const defaultJobs: Job[] = [
  {
    id: "inbox-watch",
    name: "Hourly inbox watch",
    prompt:
      "Use read_inbox to list mail newer than the watermark. Report only: recruiters or interviews, bank or security alerts, immigration, appointments. One line each: sender, subject, time. Flag anything that needs my reply. If nothing qualifies, say so in one line.",
    schedule: { kind: "interval", minutes: 60 },
    enabled: false,
    lastRunAt: 0,
    watermark: 0,
  },
  {
    id: "morning-brief",
    name: "Morning brief",
    prompt:
      "Give me a morning brief: mail from the last 24 hours that needs a reply, open follow-ups from my notes that are older than 3 days, and one thing I said I would do today. Search my memory notes before answering.",
    schedule: { kind: "daily", time: "08:00" },
    enabled: false,
    lastRunAt: 0,
    watermark: 0,
  },
];

function loadList<T>(key: string, fallback: T[]): T[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T[]) : fallback;
  } catch {
    return fallback;
  }
}

export const loadJobs = () => loadList<Job>(JOBS_KEY, defaultJobs);
export const saveJobs = (jobs: Job[]) => localStorage.setItem(JOBS_KEY, JSON.stringify(jobs));
export const loadReports = () => loadList<Report>(REPORTS_KEY, []);
export const saveReports = (reports: Report[]) => localStorage.setItem(REPORTS_KEY, JSON.stringify(reports.slice(0, 50)));
export const loadPending = () => loadList<PendingAction>(PENDING_KEY, []);
export const savePending = (pending: PendingAction[]) => localStorage.setItem(PENDING_KEY, JSON.stringify(pending));

export interface Reminder {
  id: string;
  text: string;
  dueAt: number;
  fired: boolean;
}

const REMINDERS_KEY = "mrvilsyagent.reminders.v1";
export const loadReminders = () => loadList<Reminder>(REMINDERS_KEY, []);
export const saveReminders = (reminders: Reminder[]) => localStorage.setItem(REMINDERS_KEY, JSON.stringify(reminders));
