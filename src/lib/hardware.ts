import { invoke } from "@tauri-apps/api/core";

export interface HardwareInfo {
  total_ram_gb: number;
  available_ram_gb: number;
  cpu_name: string;
  cpu_threads: number;
}

export interface ModelSet {
  main: string;
  fast: string;
  embed: string;
  note: string;
}

export const probeHardware = () => invoke<HardwareInfo>("hardware_probe");

// Picks a model set from installed RAM. GPU memory is not probed; Ollama uses a GPU on its own when it can.
export function recommendModels(ramGb: number): ModelSet {
  const embed = "nomic-embed-text";
  if (ramGb >= 56) return { main: "qwen3:32b", fast: "qwen3:8b", embed, note: "Plenty of memory: a 32B model runs well, slower on CPU only." };
  if (ramGb >= 28) return { main: "qwen3:14b", fast: "qwen3:4b", embed, note: "A 14B model fits comfortably." };
  if (ramGb >= 14) return { main: "qwen3:8b", fast: "qwen3:4b", embed, note: "An 8B model is the sweet spot for this machine." };
  return { main: "qwen3:4b", fast: "qwen3:1.7b", embed, note: "Limited memory: stick to small models." };
}

export interface LoadedModel {
  name: string;
  percentGpu: number;
}

// Asks the local Ollama which models are loaded and how much of each sits in GPU memory.
export async function loadedModels(baseUrl: string): Promise<LoadedModel[]> {
  const url = new URL(baseUrl);
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) return [];
  const response = await fetch(`${url.origin}/api/ps`);
  if (!response.ok) return [];
  const data = (await response.json()) as { models?: { name: string; size: number; size_vram: number }[] };
  return (data.models ?? []).map((model) => ({
    name: model.name,
    percentGpu: model.size ? Math.round((model.size_vram / model.size) * 100) : 0,
  }));
}
