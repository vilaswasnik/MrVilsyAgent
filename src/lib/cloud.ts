import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "./storage";

export const cloudKeyPresent = () => invoke<boolean>("cloud_key_present").catch(() => false);
export const saveCloudKey = (value: string) => invoke<void>("cloud_key_set", { value });
export const deleteCloudKey = () => invoke<void>("cloud_key_delete");

export function cloudHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

// The exact text that would leave this computer. Nothing else (no memory, mail or files) is added.
export function escalationPreview(settings: Settings, question: string): string {
  return `This will send ONLY the text below to ${cloudHost(settings.cloudBaseUrl)} (model ${settings.cloudModel || "not set"}). Your memory, mail, files and the rest of this chat are not included.\n\n${question.slice(0, 1500)}${question.length > 1500 ? "…" : ""}\n\nSend it?`;
}

export const askCloud = (settings: Settings, question: string) =>
  invoke<string>("cloud_ask", { baseUrl: settings.cloudBaseUrl, model: settings.cloudModel, prompt: question });
