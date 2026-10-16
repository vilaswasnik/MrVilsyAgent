import type { ToolDefinition } from "./ollama";
import { stripThink } from "./think";
import { draftReply, getMail, readInbox, searchMail, type MailContext } from "./mail";
import type { Reminder } from "./storage";
import { semanticSearch } from "./memory";
import { listIndexedDocuments, searchDocuments } from "./docs";
import {
  listWorkspace,
  readWorkspaceFile,
  searchWorkspace,
  todayStamp,
  writeWorkspaceFile,
} from "./workspace";

const MAX_RESULT_CHARS = 6000;

export interface ToolContext {
  mail: MailContext;
  timezone: string;
  baseUrl: string;
  // Set when a local embedding model is installed; enables meaning-based memory recall.
  embedModel?: string;
  reminders: { list: () => Reminder[]; add: (text: string, dueAt: number) => void };
  // Mail received after this time counts as new (used by the inbox watch).
  watermark?: number;
  // Newest message already reported; skipped if it reappears at the watermark time.
  lastSeenId?: string;
  // Called with the newest message the inbox read returned, so the job can advance its watermark.
  onInboxSeen?: (at: number, id: string) => void;
}

type Args = Record<string, unknown>;

const fn = (
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
): ToolDefinition => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });

// Read tools run freely. Write tools never run without explicit user approval.
export const READ_TOOLS: ToolDefinition[] = [
  fn("get_time", "Get the current date and time in the user's timezone."),
  fn(
    "read_inbox",
    "List new inbox mail (sender, subject, time, preview). Read-only.",
    { since_hours: { type: "number", description: "Only mail from the last N hours. Defaults to mail newer than the watermark, or 24 hours." } },
  ),
  fn("search_mail", "Search the connected mailbox. Read-only.", { query: { type: "string" } }, ["query"]),
  fn("read_email", "Read the full text of one email by id.", { id: { type: "string" } }, ["id"]),
  fn("search_memory", "Search MEMORY.md, daily notes and skills for the given words. Use before answering questions about the user's life, plans or people.", { query: { type: "string" } }, ["query"]),
  fn("list_files", "List files in the agent workspace (MEMORY.md, memory/, skills/ and other notes)."),
  fn("read_file", "Read a text file in the agent workspace by relative path.", { path: { type: "string" } }, ["path"]),
  fn("list_skills", "List available skill playbooks."),
  fn("read_skill", "Read a skill playbook by name (for example triage-recruiter-email).", { name: { type: "string" } }, ["name"]),
  fn("list_reminders", "List pending reminders."),
  fn(
    "search_documents",
    "Search the user's indexed documents (PDF, DOCX, TXT, MD in folders they granted). Returns passages labelled with their source file. Use for any question about the user's documents. Answer only from the returned passages and cite the file name.",
    { query: { type: "string", description: "What to look for, in the user's own words plus any key terms (form numbers, names, dates)." } },
    ["query"],
  ),
  fn("list_documents", "List the documents that are indexed and searchable."),
];

export const WRITE_TOOLS: ToolDefinition[] = [
  fn(
    "draft_email",
    "Save a reply DRAFT on the original thread. This never sends. The user sees the exact text and must approve. Use real paragraph breaks and the user's signature.",
    { message_id: { type: "string" }, body: { type: "string", description: "Exact final email body text." } },
    ["message_id", "body"],
  ),
  fn(
    "save_memory",
    "Save a durable fact (scope 'durable', goes to MEMORY.md) or a dated note (scope 'daily'). The user must approve.",
    { fact: { type: "string" }, scope: { type: "string", enum: ["durable", "daily"] } },
    ["fact"],
  ),
  fn(
    "write_file",
    "Create or modify a text file in the agent workspace. The user must approve the exact content.",
    { path: { type: "string" }, content: { type: "string" }, append: { type: "boolean" } },
    ["path", "content"],
  ),
  fn(
    "add_reminder",
    "Schedule a reminder that notifies the user inside the app. The user must approve.",
    { text: { type: "string" }, due: { type: "string", description: "Local date-time like 2026-10-17T09:00" } },
    ["text", "due"],
  ),
];

export const ALL_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS];
const WRITE_NAMES = new Set(WRITE_TOOLS.map((tool) => tool.function.name));

export const isWriteTool = (name: string) => WRITE_NAMES.has(name);

const str = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));

function parseDue(value: string): number {
  const due = new Date(value).getTime();
  if (Number.isNaN(due)) throw new Error("Invalid due date. Use a local date-time like 2026-10-17T09:00.");
  return due;
}

function safeSkillPath(name: string): string {
  const clean = name.replace(/\.md$/i, "");
  if (!/^[\w-]+$/.test(clean)) throw new Error("Invalid skill name.");
  return `skills/${clean}.md`;
}

// Human-readable description of the exact action, shown before approval.
export function describeAction(name: string, args: Args): string {
  switch (name) {
    case "draft_email":
      return `Save a reply draft for message ${str(args.message_id)}. Nothing is sent.\n\n${stripThink(str(args.body))}`;
    case "save_memory":
      return `Append to ${str(args.scope) === "daily" ? `memory/${todayStamp()}.md` : "MEMORY.md"}:\n\n${stripThink(str(args.fact))}`;
    case "write_file":
      return `${args.append ? "Append to" : "Write"} ${str(args.path)}:\n\n${stripThink(str(args.content))}`;
    case "add_reminder":
      return `Remind you at ${str(args.due)}: ${str(args.text)}`;
    default:
      return `${name} ${JSON.stringify(args)}`;
  }
}

export function summarizeCall(name: string, args: Args): string {
  const short = Object.values(args).map((value) => str(value).replace(/\s+/g, " ").slice(0, 60)).filter(Boolean).join(", ");
  return `${name}(${short})`;
}

function clip(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated]` : text;
}

const formatMail = (items: { id: string; from: string; subject: string; date: string; snippet: string }[]) =>
  items.length
    ? items.map((m) => `id=${m.id} | ${m.date} | ${m.from} | ${m.subject}\n  ${m.snippet.slice(0, 160)}`).join("\n")
    : "No matching mail.";

// Executes a tool. For write tools the caller must already hold user approval.
export async function executeTool(name: string, args: Args, ctx: ToolContext): Promise<string> {
  switch (name) {
    case "get_time":
      return new Date().toLocaleString("en-US", { timeZone: ctx.timezone, dateStyle: "full", timeStyle: "long" });
    case "read_inbox": {
      const hours = Number(args.since_hours);
      const explicit = hours > 0;
      const since = explicit ? Date.now() - hours * 3_600_000 : ctx.watermark || Date.now() - 24 * 3_600_000;
      let mail = await readInbox(ctx.mail, since);
      if (!explicit && ctx.watermark) {
        // Only mail strictly newer than the watermark; the last reported message is never repeated.
        mail = mail.filter((m) => {
          const at = Date.parse(m.date);
          return Number.isNaN(at) || at > ctx.watermark! || (at === ctx.watermark && m.id !== ctx.lastSeenId);
        });
      }
      const newest = mail
        .map((m) => ({ at: Date.parse(m.date), id: m.id }))
        .filter((m) => !Number.isNaN(m.at))
        .sort((a, b) => b.at - a.at)[0];
      if (newest && !explicit) ctx.onInboxSeen?.(newest.at, newest.id);
      return clip(formatMail(mail));
    }
    case "search_mail":
      return clip(formatMail(await searchMail(ctx.mail, str(args.query))));
    case "read_email": {
      const mail = await getMail(ctx.mail, str(args.id));
      return clip(`From: ${mail.from}\nTo: ${mail.to}\nDate: ${mail.date}\nSubject: ${mail.subject}\n\n${mail.body}`);
    }
    case "search_memory": {
      const query = str(args.query);
      const lines = (await searchWorkspace(query)).map((hit) => `${hit.path}:${hit.line}: ${hit.text}`);
      if (ctx.embedModel) {
        try {
          const semantic = await semanticSearch(ctx.baseUrl, ctx.embedModel, query);
          for (const item of semantic) if (!lines.some((line) => line.includes(item.split(": ").slice(1).join(": ").slice(0, 40)))) lines.push(item);
        } catch {
          /* keyword results are still returned */
        }
      }
      return lines.length ? clip(lines.slice(0, 25).join("\n")) : "No matches in memory.";
    }
    case "list_files": {
      const files = await listWorkspace();
      return files.length ? files.map((file) => `${file.path} (${file.size} bytes)`).join("\n") : "The agent workspace is empty or not set up.";
    }
    case "read_file":
      return clip(await readWorkspaceFile(str(args.path)));
    case "list_skills": {
      const files = (await listWorkspace()).filter((file) => file.path.startsWith("skills/"));
      return files.length ? files.map((file) => file.path.replace(/^skills\//, "").replace(/\.md$/, "")).join("\n") : "No skills found.";
    }
    case "read_skill":
      return clip(await readWorkspaceFile(safeSkillPath(str(args.name))));
    case "search_documents":
      return clip(await searchDocuments(ctx.baseUrl, ctx.embedModel, str(args.query)));
    case "list_documents":
      return clip(await listIndexedDocuments());
    case "list_reminders": {
      const pending = ctx.reminders.list().filter((reminder) => !reminder.fired);
      return pending.length ? pending.map((r) => `${new Date(r.dueAt).toLocaleString()}: ${r.text}`).join("\n") : "No pending reminders.";
    }
    case "draft_email":
      await draftReply(ctx.mail, str(args.message_id), stripThink(str(args.body)));
      return "Draft saved. It was not sent; the user will review and send it.";
    case "save_memory": {
      const daily = str(args.scope) === "daily";
      const path = daily ? `memory/${todayStamp()}.md` : "MEMORY.md";
      const fact = stripThink(str(args.fact)).trim();
      if (!fact) throw new Error("Nothing to save after removing reasoning text.");
      await writeWorkspaceFile(path, `\n- ${fact}\n`, true);
      return `Saved to ${path}.`;
    }
    case "write_file":
      await writeWorkspaceFile(str(args.path), stripThink(str(args.content)), Boolean(args.append));
      return `Wrote ${str(args.path)}.`;
    case "add_reminder": {
      const dueAt = parseDue(str(args.due));
      ctx.reminders.add(str(args.text), dueAt);
      return `Reminder set for ${new Date(dueAt).toLocaleString()}.`;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
