import { ALL_TOOLS, describeAction, executeTool, isWriteTool, preflight, summarizeCall, type ToolContext } from "./agentTools";
import { chat, ToolsUnsupportedError, type ChatMessage } from "./ollama";
import type { Settings } from "./storage";
import type { ToolTrace } from "../types";
import { composePrompt } from "./prompt";
import { stripThink } from "./think";
import { listWorkspace, readWorkspaceFileOrEmpty, todayStamp } from "./workspace";

import { appendAudit, callKey, compactHistory, MAX_STEPS, validateCall, wrapToolOutput } from "./harness";

export type ApprovalDecision = "approved" | "rejected" | "queued";

export interface AgentRun {
  settings: Settings;
  history: ChatMessage[];
  ctx: ToolContext;
  signal: AbortSignal;
  onToken: (token: string) => void;
  onTrace: (trace: ToolTrace) => void;
  // Every write tool goes through this gate; the exact action is shown to the user.
  requestApproval: (tool: string, args: Record<string, unknown>, summary: string) => Promise<ApprovalDecision>;
  // Extra instructions for this run (for example a scheduled job's read-only notice).
  note?: string;
  onStats?: (tokensPerSec: number) => void;
}

export async function buildSystemPrompt(settings: Settings, note?: string): Promise<string> {
  const yesterday = new Date(Date.now() - 86_400_000);
  const [template, memory, files, today, previous] = await Promise.all([
    readWorkspaceFileOrEmpty("system_prompt.md"),
    readWorkspaceFileOrEmpty("MEMORY.md"),
    listWorkspace().catch(() => []),
    readWorkspaceFileOrEmpty(`memory/${todayStamp()}.md`),
    readWorkspaceFileOrEmpty(`memory/${todayStamp(yesterday)}.md`),
  ]);
  const skills = files
    .filter((file) => file.path.startsWith("skills/"))
    .map((file) => file.path.replace(/^skills\//, "").replace(/\.md$/, ""));
  const recent = [previous && `(${todayStamp(yesterday)})\n${previous.trim()}`, today && `(${todayStamp()})\n${today.trim()}`]
    .filter(Boolean)
    .join("\n\n");
  return composePrompt(template, settings, skills, memory, note, recent);
}

// Drops the oldest turns so the prompt fits the context window (~4 chars per token),
// always keeping the latest user message.
export function trimHistory(history: ChatMessage[], numCtx: number, reservedChars: number): ChatMessage[] {
  const budget = Math.max(2000, numCtx * 4 - reservedChars - 3000);
  const kept: ChatMessage[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    used += history[i].content.length;
    if (used > budget && kept.length > 0) break;
    kept.unshift(history[i]);
  }
  while (kept.length > 1 && kept[0].role !== "user") kept.shift();
  return kept;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  return {};
}

// Runs the tool-calling loop and returns the model's final answer.
export async function runAgent(run: AgentRun): Promise<string> {
  const { settings, ctx, signal } = run;
  const system = await buildSystemPrompt(settings, run.note);
  const numCtx = settings.numCtx || 8192;
  const budget = Math.max(2000, numCtx * 4 - system.length - 3000);
  const compacted = await compactHistory(run.history, budget, async (older) => {
    const transcript = older.map((turn) => `${turn.role}: ${turn.content}`).join("\n\n").slice(-24_000);
    const out = await chat(
      settings.baseUrl,
      settings.fastModel || settings.model,
      [
        { role: "system", content: "Summarize this earlier conversation into a short checkpoint note: decisions made, facts the user stated, open tasks, and any approvals given or refused. Plain bullets, under 200 words. Do not invent anything." },
        { role: "user", content: transcript },
      ],
      () => {},
      signal,
      undefined,
      numCtx,
      false,
    );
    return stripThink(out.content);
  });
  const systemWithNote = compacted.summary ? `${system}\n\nEARLIER IN THIS CONVERSATION (summary of older turns):\n${compacted.summary}` : system;
  const messages: ChatMessage[] = [{ role: "system", content: systemWithNote }, ...trimHistory(compacted.kept, numCtx, systemWithNote.length)];
  let tools = settings.toolsEnabled ? ALL_TOOLS : undefined;
  let finalText = "";
  const seen = new Set<string>();
  let invalidCalls = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    let result;
    try {
      result = await chat(settings.baseUrl, settings.model, messages, run.onToken, signal, tools, numCtx, settings.thinking);
    } catch (error) {
      if (error instanceof ToolsUnsupportedError && tools) {
        tools = undefined;
        run.onToken("(This model does not support tools, so it will answer without them.)\n\n");
        step--;
        continue;
      }
      throw error;
    }

    finalText = stripThink(result.content);
    if (result.tokensPerSec) run.onStats?.(result.tokensPerSec);
    if (!result.toolCalls.length) return finalText;

    messages.push({ role: "assistant", content: finalText, tool_calls: result.toolCalls });

    for (const call of result.toolCalls) {
      const name = call.function.name;
      const args = parseArgs(call.function.arguments);
      const trace: ToolTrace = { id: crypto.randomUUID(), name, summary: summarizeCall(name, args), status: "done" };
      let output: string;

      const problem = validateCall(ALL_TOOLS, name, call.function.arguments);
      if (problem) {
        invalidCalls++;
        trace.status = "error";
        trace.result = problem;
        run.onTrace({ ...trace });
        appendAudit({ tool: name, args: trace.summary, result: problem, status: "rejected-invalid" });
        if (invalidCalls >= 2) {
          return `${finalText}\n\nStopped: the model made two malformed tool calls in a row (${problem}). Nothing was executed.`.trim();
        }
        messages.push({ role: "tool", content: `Invalid tool call: ${problem} Fix the call or answer without it.`, tool_name: name });
        continue;
      }
      invalidCalls = 0;

      const key = callKey(name, args);
      if (seen.has(key)) {
        trace.status = "error";
        trace.result = "Repeated identical call";
        run.onTrace({ ...trace });
        appendAudit({ tool: name, args: trace.summary, result: "loop detected", status: "stopped" });
        return `${finalText}\n\nStopped: the model repeated the same call (${trace.summary}) without making progress.`.trim();
      }
      seen.add(key);

      try {
        if (isWriteTool(name)) {
          const refusal = await preflight(name, args);
          if (refusal) {
            output = refusal;
            trace.status = "rejected";
          } else {
          trace.status = "awaiting-approval";
          run.onTrace({ ...trace });
          const decision = await run.requestApproval(name, args, describeAction(name, args));
          if (decision === "approved") {
            output = await executeTool(name, args, ctx);
            trace.status = "done";
          } else if (decision === "queued") {
            output = "Not executed. The action was queued for the user's approval in the Agent panel.";
            trace.status = "rejected";
          } else {
            output = "The user rejected this action. Do not retry it; ask what they want instead.";
            trace.status = "rejected";
          }
          }
        } else {
          output = await executeTool(name, args, ctx);
        }
      } catch (error) {
        output = `Error: ${error instanceof Error ? error.message : String(error)}`;
        trace.status = "error";
      }

      trace.result = output.slice(0, 500);
      run.onTrace({ ...trace });
      appendAudit({ tool: name, args: trace.summary, result: output.replace(/\s+/g, " ").slice(0, 160), status: trace.status });
      messages.push({ role: "tool", content: wrapToolOutput(name, output), tool_name: name });
    }
  }

  return `${finalText}\n\n(Stopped after ${MAX_STEPS} tool steps.)`;
}
