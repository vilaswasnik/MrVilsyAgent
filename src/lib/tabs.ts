import { invoke } from "@tauri-apps/api/core";

export interface SharedTab {
  url: string;
  title: string;
  text: string;
  received_ms: number;
}

export const tabPairingToken = () => invoke<string>("tab_pairing_token");
export const tabRegenerateToken = () => invoke<string>("tab_regenerate_token");
export const latestTab = () => invoke<SharedTab | null>("tab_latest");
export const clearTab = () => invoke<void>("tab_clear");

export const TAB_PORT = 17653;
// A shared page older than this is treated as stale and must be re-shared.
export const TAB_MAX_AGE_MS = 30 * 60_000;

const FLAGS: { label: string; pattern: RegExp }[] = [
  { label: "CITIZENSHIP / CLEARANCE", pattern: /\b(u\.?s\.?\s*citizen(ship)?|green\s*card|security\s*clearance|secret\s*clearance|ts\/sci|public\s*trust|clearance\s*required|must\s+be\s+a\s+citizen)\b/i },
  { label: "SPONSORSHIP", pattern: /\b(no\s+(visa\s+)?sponsorship|sponsorship\s+(is\s+)?(not|un)available|unable\s+to\s+sponsor|will\s+not\s+sponsor|without\s+sponsorship)\b/i },
  { label: "EMPLOYMENT TYPE", pattern: /\b(contract|c2c|corp[- ]to[- ]corp|1099|w-?2|full[- ]time|permanent|contract[- ]to[- ]hire|c2h)\b/i },
  { label: "RATE / PAY", pattern: /(\$\s?\d[\d,.]*\s*(k|\/\s*(hr|hour|h|yr|year))?|\b\d+\s*\/\s*(hr|hour)\b|\bper\s+hour\b|\bsalary\b|\bhourly\b)/i },
  { label: "LOCATION / WORK MODE", pattern: /\b(remote|hybrid|on[- ]?site|onsite)\b/i },
];

// Lines of the page that bear on the user's rules, so the verdict can cite them.
export function scanPosting(text: string, perFlag = 4): string {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l.length > 2);
  const out: string[] = [];
  for (const { label, pattern } of FLAGS) {
    const hits = lines.filter((l) => pattern.test(l)).slice(0, perFlag);
    out.push(`${label}: ${hits.length ? hits.map((l) => `"${l.slice(0, 200)}"`).join(" | ") : "nothing found on the page"}`);
  }
  return out.join("\n");
}

export function formatTab(tab: SharedTab, now = Date.now()): string {
  const ageMin = Math.max(0, Math.round((now - tab.received_ms) / 60000));
  return [
    `Shared by the user ${ageMin} min ago.`,
    `URL: ${tab.url}`,
    `Title: ${tab.title}`,
    "",
    "Lines relevant to the user's rules (quote these when citing):",
    scanPosting(tab.text),
    "",
    "Page text:",
    tab.text.slice(0, 5000),
  ].join("\n");
}
