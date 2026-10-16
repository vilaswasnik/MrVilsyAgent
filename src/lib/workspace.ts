import { invoke } from "@tauri-apps/api/core";

export interface WorkspaceInfo {
  path: string;
  initialized: boolean;
}

export interface WorkspaceEntry {
  path: string;
  size: number;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export const workspaceInfo = () => invoke<WorkspaceInfo>("agent_workspace_info");
// Creates the agent folder and starter files. Call only from an explicit user action.
export const initWorkspace = () => invoke<WorkspaceInfo>("agent_workspace_init");
export const listWorkspace = () => invoke<WorkspaceEntry[]>("agent_list");
export const readWorkspaceFile = (path: string) => invoke<string>("agent_read", { path });
export const searchWorkspace = (query: string) => invoke<SearchHit[]>("agent_search", { query });
export const openWorkspaceFolder = () => invoke<void>("agent_open_folder");
export const backupTarget = () => invoke<string>("agent_backup_target");
export const runBackup = (destination: string, settingsJson: string) => invoke<string>("agent_backup", { destination, settingsJson });
// Writes must only run after the user approved the exact action.
export const writeWorkspaceFile = (path: string, content: string, append: boolean) =>
  invoke<void>("agent_write", { path, content, append });

export async function readWorkspaceFileOrEmpty(path: string): Promise<string> {
  try {
    return await readWorkspaceFile(path);
  } catch {
    return "";
  }
}

export function todayStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
