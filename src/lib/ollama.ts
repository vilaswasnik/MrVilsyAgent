import type { Message } from "../types";
import { ThinkFilter } from "./think";

export interface OllamaModel {
  name: string;
  size?: number;
}

export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  tokensPerSec?: number;
}

interface TagsResponse {
  models?: OllamaModel[];
}

interface ChatChunk {
  message?: { content?: string; tool_calls?: ToolCall[] };
  error?: string;
  done?: boolean;
  eval_count?: number;
  eval_duration?: number;
}

function localEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("For privacy, MrVilsyAgent only connects to Ollama on this device (localhost or 127.0.0.1).");
  }
  return url.origin;
}

export async function fetchModels(baseUrl: string): Promise<OllamaModel[]> {
  const response = await fetch(`${localEndpoint(baseUrl)}/api/tags`);
  if (!response.ok) throw new Error(`Ollama returned ${response.status}.`);
  const data = (await response.json()) as TagsResponse;
  return data.models ?? [];
}

export class ToolsUnsupportedError extends Error {}

// Ollama's default context window is small; without num_ctx a long system prompt
// plus memory is silently truncated.
export async function embed(baseUrl: string, model: string, input: string[]): Promise<number[][]> {
  const response = await fetch(`${localEndpoint(baseUrl)}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input }),
  });
  if (!response.ok) throw new Error(`Embedding failed (${response.status}).`);
  const data = (await response.json()) as { embeddings?: number[][] };
  return data.embeddings ?? [];
}

export async function chat(
  baseUrl: string,
  model: string,
  messages: ChatMessage[],
  onToken: (token: string) => void,
  signal: AbortSignal,
  tools?: ToolDefinition[],
  numCtx = 8192,
  think = true,
): Promise<ChatResult> {
  const request = (withThink: boolean) =>
    fetch(`${localEndpoint(baseUrl)}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        options: { num_ctx: numCtx },
        ...(withThink ? { think: false } : {}),
        ...(tools?.length ? { tools } : {}),
      }),
      signal,
    });

  // think=false turns reasoning off for models that support it (Qwen3, DeepSeek-R1);
  // models that do not support the flag are retried without it.
  let response = await request(!think);
  if (!think && response.status === 400) {
    const detail = await response.clone().text().catch(() => "");
    if (/think/i.test(detail)) response = await request(false);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 400 && /does not support tools/i.test(detail)) {
      throw new ToolsUnsupportedError(`${model} does not support tool calling.`);
    }
    throw new Error(`Ollama returned ${response.status}.${detail ? ` ${detail.slice(0, 200)}` : ""}`);
  }
  if (!response.body) throw new Error("Ollama did not return a response stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const result: ChatResult = { content: "", toolCalls: [] };
  const filter = new ThinkFilter();
  let pending = "";

  const emit = (text: string) => {
    if (!result.content) text = text.replace(/^\s+/, "");
    if (!text) return;
    result.content += text;
    onToken(text);
  };

  const handle = (line: string) => {
    if (!line.trim()) return;
    const chunk = JSON.parse(line) as ChatChunk;
    if (chunk.error) throw new Error(chunk.error);
    // message.thinking (separate reasoning field) is intentionally ignored.
    if (chunk.message?.content) emit(filter.push(chunk.message.content));
    if (chunk.message?.tool_calls?.length) result.toolCalls.push(...chunk.message.tool_calls);
    if (chunk.done && chunk.eval_count && chunk.eval_duration) {
      result.tokensPerSec = Math.round((chunk.eval_count / (chunk.eval_duration / 1e9)) * 10) / 10;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      lines.forEach(handle);
      if (done) break;
    }
    handle(pending);
    emit(filter.flush());
  } finally {
    reader.releaseLock();
  }
  return result;
}

// Plain streaming chat without tools (used by the mail draft helper).
export async function streamChat(
  baseUrl: string,
  model: string,
  messages: Pick<Message, "role" | "content">[],
  onToken: (token: string) => void,
  signal: AbortSignal,
): Promise<void> {
  await chat(baseUrl, model, messages, onToken, signal);
}
