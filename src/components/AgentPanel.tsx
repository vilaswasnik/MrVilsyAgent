import { useCallback, useEffect, useState } from "react";
import { DEFAULT_PROMPT_TEMPLATE } from "../lib/prompt";
import { clearAudit, readAudit } from "../lib/harness";
import { describeSchedule } from "../lib/scheduler";
import {
  addDocFolder,
  clearIndex,
  docFolders,
  indexDocuments,
  loadIndex,
  removeDocFolder,
  resetIndexCache,
  type DocIndex,
} from "../lib/docs";
import type { Job, PendingAction, Reminder, Report } from "../lib/storage";
import {
  initWorkspace,
  listWorkspace,
  openWorkspaceFolder,
  readWorkspaceFile,
  workspaceInfo,
  writeWorkspaceFile,
  type WorkspaceEntry,
  type WorkspaceInfo,
} from "../lib/workspace";

interface AgentPanelProps {
  jobs: Job[];
  onJobsChange: (jobs: Job[]) => void;
  reports: Report[];
  onReportsChange: (reports: Report[]) => void;
  pending: PendingAction[];
  onApprovePending: (id: string) => void;
  onRejectPending: (id: string) => void;
  reminders: Reminder[];
  onRemindersChange: (reminders: Reminder[]) => void;
  runningJobId: string;
  onRunJob: (id: string) => void;
  baseUrl: string;
  chatModel: string;
  numCtx: number;
  embedModel?: string;
  onClose: () => void;
}

type Tab = "approvals" | "jobs" | "memory" | "documents" | "resumes" | "skills" | "reports" | "audit";

function AuditLog() {
  const [entries, setEntries] = useState(() => readAudit().reverse());
  return (
    <div className="agent-section">
      <div className="agent-row">
        <span className="agent-muted">{entries.length} recent tool calls (kept on this device, newest first)</span>
        <button className="secondary-button" onClick={() => setEntries(readAudit().reverse())}>Refresh</button>
        <button className="secondary-button" onClick={() => { clearAudit(); setEntries([]); }}>Clear</button>
      </div>
      {entries.length === 0 && <p className="agent-muted">No tool calls yet.</p>}
      {entries.map((entry, index) => (
        <div key={index} className="agent-card">
          <div className="agent-card-title">{entry.tool} <small>· {entry.status}</small></div>
          <small>{new Date(entry.at).toLocaleString()}</small>
          <div><code>{entry.args}</code></div>
          <small>{entry.result}</small>
        </div>
      ))}
    </div>
  );
}

export function AgentPanel(props: AgentPanelProps) {
  const [tab, setTab] = useState<Tab>(props.pending.length ? "approvals" : "jobs");

  return (
    <aside className="mail-panel agent-panel" aria-label="Agent">
      <div className="mail-header">
        <h2>Agent</h2>
        <button className="icon-button close-button" onClick={props.onClose} aria-label="Close agent panel">×</button>
      </div>
      <div className="agent-tabs" role="tablist">
        {(["approvals", "jobs", "memory", "documents", "resumes", "skills", "reports", "audit"] as Tab[]).map((name) => (
          <button key={name} role="tab" aria-selected={tab === name} className={tab === name ? "selected" : ""} onClick={() => setTab(name)}>
            {name === "approvals" ? `Approvals${props.pending.length ? ` (${props.pending.length})` : ""}` : name[0].toUpperCase() + name.slice(1)}
          </button>
        ))}
      </div>
      {tab === "approvals" && <Approvals {...props} />}
      {tab === "jobs" && <Jobs {...props} />}
      {tab === "memory" && <Memory />}
      {tab === "documents" && <Documents {...props} />}
      {tab === "resumes" && <FolderEditor folder="resumes" extra="state/applications.md" help="Master and tailored resumes. The agent never overwrites the master; tailored versions are new files created after you approve them. Edits here are saved directly." />}
      {tab === "skills" && <FolderEditor folder="skills" help="Markdown playbooks the agent reads on request. Edit them to change behavior without code changes." />}
      {tab === "reports" && <Reports {...props} />}
      {tab === "audit" && <AuditLog />}
    </aside>
  );
}

function Documents({ baseUrl, chatModel, numCtx, embedModel }: AgentPanelProps) {
  const [folders, setFolders] = useState<string[]>([]);
  const [index, setIndex] = useState<DocIndex | null>(null);
  const [summarizeLong, setSummarizeLong] = useState(true);
  const [status, setStatus] = useState("");
  const [running, setRunning] = useState(false);
  const [abort, setAbort] = useState<AbortController | null>(null);

  const refresh = useCallback(async () => {
    setFolders(await docFolders().catch(() => []));
    resetIndexCache();
    setIndex(await loadIndex());
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function add() {
    try {
      const path = await addDocFolder();
      if (path) await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function remove(path: string) {
    await removeDocFolder(path);
    // Re-indexing prunes entries for files that are no longer inside a granted folder.
    setStatus("Folder removed. Click Index to drop its documents from search.");
    await refresh();
  }

  async function run() {
    if (!embedModel) {
      setStatus("Run `ollama pull nomic-embed-text` first: document search needs the local embedding model.");
      return;
    }
    const controller = new AbortController();
    setAbort(controller);
    setRunning(true);
    try {
      const result = await indexDocuments({ baseUrl, embedModel, chatModel, summarizeLong, numCtx, signal: controller.signal, onProgress: setStatus });
      setStatus(`${controller.signal.aborted ? "Stopped. " : ""}Indexed ${result.indexed}, unchanged ${result.skipped}, failed ${result.failed}, removed ${result.removed}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
      setAbort(null);
      await refresh();
    }
  }

  const files = index ? Object.values(index.files).sort((a, b) => a.name.localeCompare(b.name)) : [];
  return (
    <div className="agent-section">
      <p className="mail-help">The agent can read, never change, files in the folders you add (PDF, DOCX, TXT, MD). Text is extracted and indexed on this device with your local embedding model. The index is stored unencrypted in the app data folder.</p>
      <div className="agent-card">
        <div className="agent-card-title">Folders the agent may read</div>
        {folders.length === 0 && <small className="agent-muted">None yet.</small>}
        {folders.map((folder) => (
          <div key={folder} className="agent-row">
            <code className="agent-path">{folder}</code>
            <button className="secondary-button" onClick={() => void remove(folder)}>Remove</button>
          </div>
        ))}
        <div className="agent-row"><button className="secondary-button" onClick={() => void add()}>Add folder…</button></div>
      </div>
      <div className="agent-card">
        <label className="check-row"><input type="checkbox" checked={summarizeLong} onChange={(event) => setSummarizeLong(event.target.checked)} /> Summarize long documents section by section (slower to index, better answers)</label>
        <div className="agent-row">
          {running ? <button className="secondary-button" onClick={() => abort?.abort()}>Stop</button> : <button className="primary-button" disabled={!folders.length} onClick={() => void run()}>Index now</button>}
        </div>
        {status && <small className="agent-muted">{status}</small>}
      </div>
      <div className="agent-card">
        <div className="agent-card-title">Indexed documents ({files.length})</div>
        {files.map((file) => (
          <div key={file.path} className="agent-doc">
            <strong>{file.name}</strong>
            <small className="agent-muted">{file.error ? `Not searchable: ${file.error}` : `${file.chunkCount} chunks, indexed ${new Date(file.indexedAt).toLocaleDateString()}`}</small>
          </div>
        ))}
        {files.length > 0 && <div className="agent-row"><button className="secondary-button" onClick={() => void clearIndex().then(refresh)}>Clear index</button></div>}
      </div>
    </div>
  );
}

function Approvals({ pending, onApprovePending, onRejectPending }: AgentPanelProps) {
  return (
    <div className="agent-section">
      <p className="mail-help">Actions the agent proposed during unattended runs. Nothing runs until you approve the exact text shown.</p>
      {pending.length === 0 && <p className="mail-help">No pending actions.</p>}
      {pending.map((action) => (
        <div key={action.id} className="agent-card">
          <div className="agent-card-title">{action.tool} <small>from {action.source}</small></div>
          <pre className="agent-pre">{action.summary}</pre>
          <div className="agent-row">
            <button className="primary-button" onClick={() => onApprovePending(action.id)}>Approve</button>
            <button className="secondary-button" onClick={() => onRejectPending(action.id)}>Reject</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Jobs({ jobs, onJobsChange, runningJobId, onRunJob, reminders, onRemindersChange }: AgentPanelProps) {
  const update = (id: string, patch: Partial<Job>) => onJobsChange(jobs.map((job) => (job.id === id ? { ...job, ...patch } : job)));
  const upcoming = reminders.filter((reminder) => !reminder.fired).sort((a, b) => a.dueAt - b.dueAt);

  return (
    <div className="agent-section">
      <p className="mail-help">Jobs run only while this app is open, use read-only tools, and never send or write anything on their own. They are off until you enable them.</p>
      {jobs.map((job) => (
        <div key={job.id} className="agent-card">
          <label className="check-row">
            <input type="checkbox" checked={job.enabled} onChange={(event) => update(job.id, { enabled: event.target.checked, lastRunAt: event.target.checked ? 0 : job.lastRunAt })} />
            <strong>{job.name}</strong> <small>({describeSchedule(job)})</small>
          </label>
          <div className="agent-row">
            {job.schedule.kind === "interval" ? (
              <input type="number" min={5} value={job.schedule.minutes} onChange={(event) => update(job.id, { schedule: { kind: "interval", minutes: Math.max(5, Number(event.target.value) || 60) } })} aria-label="Minutes between runs" />
            ) : (
              <input type="time" value={job.schedule.time} onChange={(event) => update(job.id, { schedule: { kind: "daily", time: event.target.value || "08:00" } })} aria-label="Time of day" />
            )}
            <button className="secondary-button" disabled={Boolean(runningJobId)} onClick={() => onRunJob(job.id)}>{runningJobId === job.id ? "Running…" : "Run now"}</button>
          </div>
          <textarea rows={4} value={job.prompt} onChange={(event) => update(job.id, { prompt: event.target.value })} aria-label={`${job.name} prompt`} />
          <small className="agent-muted">{job.lastRunAt ? `Last run ${new Date(job.lastRunAt).toLocaleString()}` : "Never run"}</small>
        </div>
      ))}
      <div className="agent-card">
        <div className="agent-card-title">Reminders</div>
        {upcoming.length === 0 && <p className="mail-help">No pending reminders. Ask the agent to set one; you approve it first.</p>}
        {upcoming.map((reminder) => (
          <div key={reminder.id} className="agent-row agent-reminder">
            <span>{new Date(reminder.dueAt).toLocaleString()} — {reminder.text}</span>
            <button className="icon-button" onClick={() => onRemindersChange(reminders.filter((item) => item.id !== reminder.id))} aria-label="Delete reminder">×</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Memory() {
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [files, setFiles] = useState<WorkspaceEntry[]>([]);
  const [selected, setSelected] = useState("");
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setInfo(await workspaceInfo());
      setFiles(await listWorkspace());
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function open(path: string) {
    setError("");
    setSaved("");
    try {
      setContent(await readWorkspaceFile(path));
      setSelected(path);
    } catch (err) {
      setError(String(err));
    }
  }

  async function save() {
    setError("");
    try {
      await writeWorkspaceFile(selected, content, false);
      setSaved(`Saved ${selected}.`);
      refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  async function setup() {
    setError("");
    try {
      const created = await initWorkspace();
      // Written only on this explicit click, and never over an existing file.
      const existing = await readWorkspaceFile("system_prompt.md").catch(() => "");
      if (!existing) await writeWorkspaceFile("system_prompt.md", DEFAULT_PROMPT_TEMPLATE, false);
      setInfo(created);
      setFiles(await listWorkspace());
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="agent-section">
      <p className="mail-help">
        The agent reads <strong>MEMORY.md</strong>, daily notes and skill playbooks from one local folder and cannot touch anything outside it. It only writes after you approve the exact text. Files are plain, unencrypted text.
      </p>
      {info && <p className="agent-muted">{info.path}</p>}
      {info && !info.initialized && <button className="primary-button" onClick={setup}>Set up agent workspace</button>}
      {info?.initialized && (
        <>
          <div className="agent-row">
            <button className="secondary-button" onClick={() => openWorkspaceFolder().catch((err) => setError(String(err)))}>Open folder</button>
            <button className="secondary-button" onClick={refresh}>Refresh</button>
          </div>
          {!files.some((file) => file.path === "system_prompt.md") && (
            <button className="secondary-button" onClick={setup}>Create editable system_prompt.md</button>
          )}
          <div className="agent-files">
            {files.map((file) => (
              <button key={file.path} className={file.path === selected ? "selected" : ""} onClick={() => open(file.path)}>{file.path}</button>
            ))}
          </div>
          {selected && (
            <>
              <textarea rows={12} value={content} onChange={(event) => setContent(event.target.value)} aria-label={`Edit ${selected}`} />
              <button className="primary-button" onClick={save}>Save {selected}</button>
              {saved && <p className="mail-saved">{saved}</p>}
            </>
          )}
        </>
      )}
      {error && <p className="mail-error">{error}</p>}
    </div>
  );
}

function FolderEditor({ folder, help, extra }: { folder: string; help: string; extra?: string }) {
  const [files, setFiles] = useState<WorkspaceEntry[]>([]);
  const [selected, setSelected] = useState("");
  const [content, setContent] = useState("");
  const [newName, setNewName] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [extraText, setExtraText] = useState("");

  const refresh = useCallback(async () => {
    try {
      const all = await listWorkspace();
      setFiles(all.filter((file) => file.path.replace(/\\/g, "/").startsWith(`${folder}/`)));
      if (extra) setExtraText(await readWorkspaceFile(extra).catch(() => ""));
    } catch (err) {
      setError(String(err));
    }
  }, [folder, extra]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function open(path: string) {
    setError("");
    setMessage("");
    try {
      setContent(await readWorkspaceFile(path));
      setSelected(path);
    } catch (err) {
      setError(String(err));
    }
  }

  async function save() {
    setError("");
    try {
      await writeWorkspaceFile(selected, content, false);
      setMessage(`Saved ${selected}.`);
      refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  async function create() {
    const name = newName.trim();
    if (!/^[\w.\- ]+\.md$/.test(name)) {
      setError("Use a plain file name ending in .md (letters, numbers, spaces, - _ .).");
      return;
    }
    const path = `${folder}/${name}`;
    setError("");
    try {
      const existing = await readWorkspaceFile(path).catch(() => "");
      if (existing) {
        setError(`${path} already exists; open it from the list instead.`);
        return;
      }
      await writeWorkspaceFile(path, `# ${name.replace(/\.md$/, "")}\n\n`, false);
      setNewName("");
      await refresh();
      open(path);
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="agent-section">
      <p className="mail-help">{help}</p>
      {extra && (
        <details>
          <summary>Application tracker ({extra})</summary>
          <pre className="agent-muted">{extraText || "No applications logged yet."}</pre>
        </details>
      )}
      <div className="agent-row">
        <input value={newName} placeholder="new-file.md" onChange={(event) => setNewName(event.target.value)} aria-label={`New ${folder} file name`} />
        <button className="secondary-button" onClick={create}>Create</button>
        <button className="secondary-button" onClick={refresh}>Refresh</button>
      </div>
      <div className="agent-files">
        {files.length === 0 && <p className="agent-muted">No files in {folder}/ yet.</p>}
        {files.map((file) => (
          <button key={file.path} className={file.path === selected ? "selected" : ""} onClick={() => open(file.path)}>{file.path}</button>
        ))}
      </div>
      {selected && (
        <>
          <textarea rows={12} value={content} onChange={(event) => setContent(event.target.value)} aria-label={`Edit ${selected}`} />
          <button className="primary-button" onClick={save}>Save {selected}</button>
          {message && <p className="mail-saved">{message}</p>}
        </>
      )}
      {error && <p className="mail-error">{error}</p>}
    </div>
  );
}

function Reports({ reports, onReportsChange }: AgentPanelProps) {
  const [showSilent, setShowSilent] = useState(false);
  const surfaced = reports.filter((report) => !report.silent);
  const quiet = reports.filter((report) => report.silent);
  return (
    <div className="agent-section">
      {reports.length === 0 && <p className="mail-help">Reports from scheduled jobs and reminders appear here. Routine runs with nothing new stay quiet.</p>}
      {reports.length > 0 && <button className="secondary-button" onClick={() => onReportsChange([])}>Clear reports</button>}
      {surfaced.map((report) => (
        <div key={report.id} className="agent-card">
          <div className="agent-card-title">{report.jobName} <small>{new Date(report.at).toLocaleString()}</small></div>
          <pre className={`agent-pre ${report.error ? "agent-error" : ""}`}>{report.error ?? report.text}</pre>
        </div>
      ))}
      {quiet.length > 0 && (
        <button className="secondary-button" onClick={() => setShowSilent(!showSilent)}>
          {showSilent ? "Hide" : "Show"} {quiet.length} quiet run{quiet.length === 1 ? "" : "s"} with nothing new
        </button>
      )}
      {showSilent && quiet.map((report) => <small key={report.id} className="agent-muted">{new Date(report.at).toLocaleString()} · {report.jobName}: nothing new</small>)}
    </div>
  );
}
