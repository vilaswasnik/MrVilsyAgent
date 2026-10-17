import { forwardRef, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AgentPanel } from "./components/AgentPanel";
import { runAgent, type ApprovalDecision } from "./lib/agent";
import { executeTool, describeAction, type ToolContext } from "./lib/agentTools";
import { Onboarding } from "./components/Onboarding";
import { loadOnboarding, saveOnboarding, type OnboardingState } from "./lib/onboarding";
import { estimateTokens } from "./lib/harness";
import { isRoutineReport } from "./lib/mailLogic";
import { notifyDesktop } from "./lib/notify";
import { BrowserSettings } from "./components/BrowserSettings";
import { CloudSettings, SelfTest } from "./components/CloudSettings";
import { markTaskEnd, markTaskStart, readInterruptedTask } from "./lib/verify";
import { askCloud, cloudKeyPresent, escalationPreview } from "./lib/cloud";
import { loadedModels, probeHardware, recommendModels, type HardwareInfo, type LoadedModel } from "./lib/hardware";
import { fetchModels, streamChat, type ChatMessage, type OllamaModel } from "./lib/ollama";
import { isJobDue, SCHEDULED_RUN_NOTE } from "./lib/scheduler";
import { EMBED_MODEL_PREFIX } from "./lib/memory";
import { hydrateVaultTokens, saveVaultToken, VAULT_FIELDS, type VaultField } from "./lib/vault";
import { applyRestore, backupTarget, pickRestore, runBackup } from "./lib/workspace";
import {
  connectGmail,
  createGmailDraft,
  ensureGmailToken,
  getGmailMessage,
  isGmailConnected,
  searchGmail,
  type EmailDetail,
  type EmailSummary,
} from "./lib/gmail";
import {
  connectOutlook,
  createOutlookDraft,
  ensureOutlookToken,
  getOutlookMessage,
  isOutlookConnected,
  searchOutlook,
} from "./lib/outlook";
import {
  defaultSettings,
  enableTokenScrubbing,
  loadConversations,
  loadJobs,
  loadPending,
  loadReminders,
  loadReports,
  loadSettings,
  saveConversations,
  saveJobs,
  savePending,
  saveReminders,
  saveReports,
  saveSettings,
  withoutTokens,
  type Job,  type PendingAction,
  type Reminder,
  type Report,
  type Settings,
} from "./lib/storage";
import type { Conversation, Message, ToolTrace } from "./types";

const id = () => crypto.randomUUID();

interface ApprovalRequest {
  tool: string;
  summary: string;
  resolve: (decision: ApprovalDecision) => void;
}
const greetingPrompts = [
  "What's in my inbox that needs a reply?",
  "What do you remember about me?",
  "Help me plan my day",
];

function greeting(name: string): string {
  const hour = new Date().getHours();
  const part = hour < 5 ? "Hi" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return name.trim() ? `${part}, ${name.trim().split(/\s+/)[0]}` : part;
}

function App() {
  const [conversations, setConversations] = useState<Conversation[]>(loadConversations);
  const [activeId, setActiveId] = useState<string | null>(() => loadConversations()[0]?.id ?? null);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [connection, setConnection] = useState<"checking" | "online" | "offline">("checking");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState<string[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [cloudReady, setCloudReady] = useState(false);
  const [notice, setNotice] = useState(() => {
    const left = readInterruptedTask();
    if (!left) return "";
    markTaskEnd();
    return `The app closed while this was running: “${left.label}”. Nothing was repeated automatically. Check Agent → Audit for what already happened, then ask again if needed.`;
  });
  const [attachment, setAttachment] = useState("");
  const [showMail, setShowMail] = useState(false);
  const [showAgent, setShowAgent] = useState(false);
  const [jobs, setJobs] = useState<Job[]>(loadJobs);
  const [reports, setReports] = useState<Report[]>(loadReports);
  const [pending, setPending] = useState<PendingAction[]>(loadPending);
  const [reminders, setReminders] = useState<Reminder[]>(loadReminders);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [runningJobId, setRunningJobId] = useState("");
  const [onboarding, setOnboarding] = useState<OnboardingState>(loadOnboarding);
  const [tokensPerSec, setTokensPerSec] = useState(0);
  const settingsRef = useRef(settings);
  const modelsRef = useRef<OllamaModel[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  modelsRef.current = models;
  const jobsRef = useRef(jobs);
  const remindersRef = useRef(reminders);
  const busyRef = useRef(false);
  const runningRef = useRef(false);
  settingsRef.current = settings;
  jobsRef.current = jobs;
  remindersRef.current = reminders;
  busyRef.current = busy;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const onScrollMessages = () => {
    const el = scrollRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  const activeConversation = conversations.find((chat) => chat.id === activeId) ?? null;
  const ready = connection === "online" && Boolean(settings.model);

  // Follow new output unless the user scrolled up to read.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [activeConversation?.messages, activeId]);
  useEffect(() => { stickRef.current = true; }, [activeId]);

  useEffect(() => saveConversations(conversations), [conversations]);
  useEffect(() => saveSettings(settings), [settings]);

  // Refresh tokens live in the Windows Credential Manager, not in localStorage.
  const vaultReadyRef = useRef(false);
  const vaultSyncedRef = useRef<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    hydrateVaultTokens(settingsRef.current)
      .then((patch) => {
        if (cancelled) return;
        vaultSyncedRef.current = {
          gmailRefreshToken: patch.gmailRefreshToken ?? settingsRef.current.gmailRefreshToken,
          outlookRefreshToken: patch.outlookRefreshToken ?? settingsRef.current.outlookRefreshToken,
        };
        if (Object.keys(patch).length) setSettings((previous) => ({ ...previous, ...patch }));
      })
      .catch(() => setNotice("Windows Credential Manager is unavailable, so mail sign-in will not be remembered."))
      .finally(() => {
        if (cancelled) return;
        vaultReadyRef.current = true;
        enableTokenScrubbing();
        saveSettings(settingsRef.current);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!vaultReadyRef.current) return;
    for (const field of Object.keys(VAULT_FIELDS) as VaultField[]) {
      const value = settings[field];
      if (vaultSyncedRef.current[field] === value) continue;
      vaultSyncedRef.current[field] = value;
      void saveVaultToken(field, value).catch(() => setNotice("Could not save the mail sign-in to Windows Credential Manager."));
    }
  }, [settings]);
  useEffect(() => saveJobs(jobs), [jobs]);
  useEffect(() => saveReports(reports), [reports]);
  useEffect(() => savePending(pending), [pending]);
  useEffect(() => saveReminders(reminders), [reminders]);

  const toolContext = useCallback(
    (watermark?: number, inbox?: { lastSeenId?: string; onInboxSeen?: (at: number, id: string) => void }): ToolContext => ({
      mail: {
        getSettings: () => settingsRef.current,
        patchSettings: (patch) => setSettings((previous) => ({ ...previous, ...patch })),
      },
      timezone: settingsRef.current.timezone || "UTC",
      baseUrl: settingsRef.current.baseUrl,
      embedModel: modelsRef.current.find((model) => model.name.startsWith(EMBED_MODEL_PREFIX))?.name,
      reminders: {
        list: () => remindersRef.current,
        add: (text, dueAt) => {
          const reminder: Reminder = { id: id(), text, dueAt, fired: false };
          remindersRef.current = [...remindersRef.current, reminder];
          setReminders(remindersRef.current);
        },
      },
      watermark,
      lastSeenId: inbox?.lastSeenId,
      onInboxSeen: inbox?.onInboxSeen,
    }),
    [],
  );

  const addReport = useCallback((report: Omit<Report, "id" | "at">) => {
    setReports((previous) => [{ ...report, id: id(), at: Date.now() }, ...previous].slice(0, 50));
  }, []);

  const runJob = useCallback(
    async (jobId: string) => {
      const job = jobsRef.current.find((item) => item.id === jobId);
      const current = settingsRef.current;
      if (!job || runningRef.current || busyRef.current || !current.model) return;
      runningRef.current = true;
      setRunningJobId(job.id);
      const startedAt = Date.now();
      const patchJob = (patch: Partial<Job>) =>
        setJobs((previous) => previous.map((item) => (item.id === job.id ? { ...item, ...patch } : item)));
      patchJob({ lastRunAt: startedAt });
      let seen: { at: number; id: string } | null = null;
      markTaskStart(`Scheduled job: ${job.name}`);
      try {
        const text = await runAgent({
          settings: current,
          history: [{ role: "user", content: job.prompt }],
          ctx: toolContext(job.watermark || startedAt - 3_600_000, {
            lastSeenId: job.lastSeenId,
            onInboxSeen: (at, id) => {
              if (!seen || at > seen.at) seen = { at, id };
            },
          }),
          signal: new AbortController().signal,
          onToken: () => {},
          onTrace: () => {},
          note: SCHEDULED_RUN_NOTE,
          requestApproval: async (tool, args, summary) => {
            setPending((previous) => [...previous, { id: id(), source: job.name, tool, args, summary, createdAt: Date.now() }]);
            return "queued";
          },
        });
        const clean = text.trim() || "(no output)";
        const silent = isRoutineReport(text);
        addReport({ jobId: job.id, jobName: job.name, text: silent ? "Nothing new." : clean, silent });
        if (!silent) notifyDesktop(job.name, clean);
        // Advance to the newest mail actually reported; a failed run leaves the watermark alone.
        const reported = seen as { at: number; id: string } | null;
        if (reported) patchJob({ watermark: reported.at, lastSeenId: reported.id });
        else if (!job.watermark) patchJob({ watermark: startedAt });
      } catch (error) {
        addReport({ jobId: job.id, jobName: job.name, text: "", error: error instanceof Error ? error.message : "The job failed." });
      } finally {
        markTaskEnd();
        runningRef.current = false;
        setRunningJobId("");
      }
    },
    [addReport, toolContext],
  );

  // Runs due jobs one after another. Called on start, on wake/focus and every minute, so runs missed
  // while the app was closed or the PC slept catch up once; watermarks stop anything being reported twice.
  const runDueJobs = useCallback(async () => {
    if (!settingsRef.current.model) return;
    const now = Date.now();
    const due = remindersRef.current.filter((reminder) => !reminder.fired && reminder.dueAt <= now);
    if (due.length) {
      due.forEach((reminder) => {
        addReport({ jobId: "reminder", jobName: "Reminder", text: reminder.text });
        notifyDesktop("Reminder", reminder.text);
      });
      setReminders((previous) => previous.map((reminder) => (due.some((item) => item.id === reminder.id) ? { ...reminder, fired: true } : reminder)));
    }
    for (const job of jobsRef.current) {
      if (!isJobDue(job, Date.now()) || runningRef.current || busyRef.current) continue;
      await runJob(job.id);
    }
  }, [addReport, runJob]);

  // Checks once a minute while the app is open. Nothing runs when the app is closed.
  useEffect(() => {
    const timer = window.setInterval(() => void runDueJobs(), 60_000);
    const onWake = () => { if (document.visibilityState === "visible") void runDueJobs(); };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, [runDueJobs]);

  // Catch up as soon as a model is available after launch.
  useEffect(() => {
    if (settings.model && connection === "online") void runDueJobs();
  }, [settings.model, connection, runDueJobs]);

  async function approvePending(actionId: string) {
    const action = pending.find((item) => item.id === actionId);
    if (!action) return;
    try {
      const result = await executeTool(action.tool, action.args, toolContext());
      addReport({ jobId: "approval", jobName: `Approved: ${action.tool}`, text: result });
      setPending((previous) => previous.filter((item) => item.id !== actionId));
    } catch (error) {
      addReport({ jobId: "approval", jobName: `Failed: ${action.tool}`, text: "", error: error instanceof Error ? error.message : String(error) });
    }
  }

  useEffect(() => {
    let mounted = true;
    setConnection("checking");
    fetchModels(settings.baseUrl)
      .then((available) => {
        if (!mounted) return;
        setModels(available);
        setConnection("online");
        setNotice("");
        setSettings((previous) => ({
          ...previous,
          model: available.some((model) => model.name === previous.model)
            ? previous.model
            : available[0]?.name ?? "",
        }));
      })
      .catch(() => {
        if (!mounted) return;
        setModels([]);
        setConnection("offline");
      });
    return () => {
      mounted = false;
    };
  }, [settings.baseUrl]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [activeId]);

  const sortedConversations = useMemo(
    () => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations],
  );

  function newChat() {
    setActiveId(null);
    setDraft("");
    setAttachment("");
  }

  async function refreshModels() {
    setConnection("checking");
    try {
      const available = await fetchModels(settings.baseUrl);
      setModels(available);
      setConnection("online");
      setSettings((previous) => ({
        ...previous,
        model: available.some((model) => model.name === previous.model)
          ? previous.model
          : available[0]?.name ?? "",
      }));
      setNotice("");
    } catch {
      setConnection("offline");
      setNotice("Can’t reach Ollama. Start it locally, then try again.");
    }
  }

  async function attachFile(file?: File) {
    if (!file) return;
    if (file.size > 500_000) {
      setNotice("For safety, context files must be smaller than 500 KB.");
      return;
    }
    try {
      const text = await file.text();
      setAttachment(`\n\n[User-attached file: ${file.name}]\n${text}\n[End attached file]`);
      setNotice(`${file.name} is attached to your next message only.`);
    } catch {
      setNotice("That file couldn’t be read as text.");
    }
  }

  useEffect(() => {
    if (settings.cloudEnabled) cloudKeyPresent().then(setCloudReady);
    else setCloudReady(false);
  }, [settings.cloudEnabled, showSettings]);

  // Sends only the user's last message, after showing exactly what will leave the computer.
  async function escalate() {
    const chat = activeConversation;
    const question = [...(chat?.messages ?? [])].reverse().find((message) => message.role === "user")?.content.trim();
    if (!chat || !question || busy) return;
    if (!window.confirm(escalationPreview(settings, question))) return;
    setBusy(true);
    setNotice("");
    let content: string;
    try {
      content = `Cloud answer (${settings.cloudModel}, sent only on your request):\n\n${await askCloud(settings, question)}`;
    } catch (error) {
      content = `Cloud escalation failed: ${String(error)}`;
    }
    const message: Message = { id: id(), role: "assistant", content, createdAt: Date.now() };
    setConversations((previous) => previous.map((item) => (item.id === chat.id ? { ...item, updatedAt: Date.now(), messages: [...item.messages, message] } : item)));
    setBusy(false);
  }

  async function send(event?: FormEvent, suggested?: string) {
    event?.preventDefault();
    const text = (suggested ?? draft).trim();
    if (!text || !ready) return;
    if (busy) {
      setQueue((previous) => [...previous, `${text}${attachment}`]);
      setDraft("");
      setAttachment("");
      return;
    }

    const chatId = activeId ?? id();
    const now = Date.now();
    const userMessage: Message = {
      id: id(),
      role: "user",
      content: `${text}${attachment}`,
      createdAt: now,
    };
    const assistantMessage: Message = {
      id: id(),
      role: "assistant",
      content: "",
      createdAt: now,
    };
    const existing = conversations.find((chat) => chat.id === chatId);
    const updated: Conversation = {
      id: chatId,
      title: existing?.title ?? text.slice(0, 46),
      updatedAt: now,
      messages: [...(existing?.messages ?? []), userMessage, assistantMessage],
    };
    const requestMessages: ChatMessage[] = updated.messages
      .filter((message) => message.id !== assistantMessage.id && message.content.trim())
      .map(({ role, content }) => ({ role, content }));

    setConversations((previous) => [updated, ...previous.filter((chat) => chat.id !== chatId)]);
    setActiveId(chatId);
    setDraft("");
    setAttachment("");
    setNotice("");
    setBusy(true);

    const updateLast = (change: (last: Message) => Message) => {
      setConversations((previous) =>
        previous.map((chat) => {
          if (chat.id !== chatId) return chat;
          const messages = [...chat.messages];
          messages[messages.length - 1] = change(messages[messages.length - 1]);
          return { ...chat, updatedAt: Date.now(), messages };
        }),
      );
    };
    const appendToken = (token: string) => updateLast((last) => ({ ...last, content: last.content + token }));
    const upsertTrace = (trace: ToolTrace) =>
      updateLast((last) => {
        const traces = last.trace ?? [];
        const exists = traces.some((item) => item.id === trace.id);
        return { ...last, trace: exists ? traces.map((item) => (item.id === trace.id ? trace : item)) : [...traces, trace] };
      });

    const controller = new AbortController();
    abortRef.current = controller;
    markTaskStart(text);
    try {
      await runAgent({
        settings,
        history: requestMessages,
        ctx: toolContext(),
        signal: controller.signal,
        onToken: appendToken,
        onTrace: upsertTrace,
        onStats: setTokensPerSec,
        requestApproval: (tool, _args, summary) =>
          new Promise<ApprovalDecision>((resolve) => setApproval({ tool, summary, resolve })),
      });
    } catch (error) {
      if (controller.signal.aborted) {
        appendToken("\n\n(Stopped.)");
      } else {
        appendToken(`\n\n${error instanceof Error ? `Connection error: ${error.message}` : "Something went wrong."}`);
        setConnection("offline");
      }
    } finally {
      markTaskEnd();
      abortRef.current = null;
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  // Runs the next queued message once the current answer has finished.
  useEffect(() => {
    if (busy || !ready || approval || queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void send(undefined, next);
  });

  function stop() {
    setQueue([]);
    abortRef.current?.abort();
    approval?.resolve("rejected");
    setApproval(null);
  }

  function decide(decision: ApprovalDecision) {
    approval?.resolve(decision);
    setApproval(null);
  }

  function updateSettings(patch: Partial<Settings>) {
    setSettings((previous) => ({ ...previous, ...patch }));
  }

  // Onboarding answers only become approval requests; MEMORY.md changes when the user approves each one.
  function finishOnboarding(notes: { title: string; fact: string }[], answers: Record<string, string>) {
    setPending((previous) => [
      ...previous,
      ...notes.map((note) => {
        const args = { fact: note.fact, scope: "durable" };
        return { id: id(), source: "Onboarding", tool: "save_memory", args, summary: describeAction("save_memory", args), createdAt: Date.now() };
      }),
    ]);
    const patch: Partial<Settings> = {};
    if (!settings.userName && answers.name?.trim()) patch.userName = answers.name.trim();
    if (!settings.jobTitle && answers.role?.trim()) patch.jobTitle = answers.role.trim();
    if (Object.keys(patch).length) updateSettings(patch);
    const done: OnboardingState = { ...onboarding, answers, status: "done" };
    saveOnboarding(done);
    setOnboarding(done);
    if (notes.length) setShowAgent(true);
  }

  function skipOnboarding(state: OnboardingState) {
    const skipped: OnboardingState = { ...state, status: "skipped" };
    saveOnboarding(skipped);
    setOnboarding(skipped);
  }

  const contextTokens = useMemo(() => {
    const chars = (activeConversation?.messages ?? []).reduce((sum, message) => sum + message.content.length, 0);
    return estimateTokens(chars) + 1200;
  }, [activeConversation]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark" aria-hidden="true"><span /></div>
          <span className="brand-name">MrVilsyAgent<span>.</span></span>
          <button className="icon-button sidebar-toggle" aria-label="Collapse sidebar">‹</button>
        </div>
        <button className="new-chat" onClick={newChat}><span>＋</span> New chat <kbd>⌘ K</kbd></button>
        <div className="sidebar-label">RECENT CHATS</div>
        <nav className="chat-list" aria-label="Conversation history">
          {sortedConversations.map((chat) => (
            <button key={chat.id} className={`chat-item ${chat.id === activeId ? "selected" : ""}`} onClick={() => setActiveId(chat.id)}>
              <span className="chat-icon">◌</span><span className="chat-title">{chat.title}</span>
            </button>
          ))}
          {sortedConversations.length === 0 && <p className="empty-history">Your conversations will appear here.</p>}
        </nav>
        <div className="sidebar-bottom">
          <div className={`local-status ${connection}`}><span className="status-dot" />{connection === "online" ? "Local model connected" : connection === "checking" ? "Checking Ollama…" : "Ollama is offline"}</div>
          <button className="settings-link" onClick={() => setShowMail((value) => !value)}><span>✉</span> Mail {showMail ? "(close)" : ""}</button>
          <button className="settings-link" onClick={() => setShowAgent((value) => !value)}><span>✦</span> Agent{pending.length ? ` (${pending.length} to approve)` : ""}{runningJobId ? " · running" : ""}</button>
          <button className="settings-link" onClick={() => setShowSettings(true)}><span>⚙</span> Settings</button>
          <div className="privacy-note"><span className="privacy-icon">◈</span><span>Private by design<br /><small>Your chats stay on this device.</small></span></div>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div className="topbar-context"><span>{settings.agentName || "MrVilsyAgent"}</span><span className="crumb-divider">/</span><span className="crumb-active">{activeConversation?.title ?? "New chat"}</span></div>
          <div className="topbar-actions">
            <button className="model-pill" onClick={() => setShowSettings(true)}><span className={`mini-dot ${connection}`} />{settings.model || "Choose a model"}<span className="chevron">⌄</span></button>
            <button className="avatar" aria-label={settings.email ? `Local profile (${settings.email})` : "Local profile"} title={settings.email || "No email set"} onClick={() => setShowSettings(true)}>{settings.email ? settings.email[0].toUpperCase() : "L"}</button>
          </div>
        </header>

        {activeConversation ? (
          <section className="conversation-view" aria-label="Conversation">
            <div className="message-scroll" ref={scrollRef} onScroll={onScrollMessages}>
            <div className="message-list">
              {activeConversation.messages.map((message, index) => (
                <article key={message.id} className={`message ${message.role}`}>
                  <div className="message-avatar">{message.role === "assistant" ? <span className="brand-mark small"><span /></span> : (settings.email ? settings.email[0].toUpperCase() : "L")}</div>
                  <div className="message-body">
                    <div className="message-name">{message.role === "assistant" ? "MrVilsyAgent" : "You"}</div>
                    <div className="message-content">{message.content || (busy && index === activeConversation.messages.length - 1 && !message.trace?.length ? <span className="thinking"><i /><i /><i /></span> : "")}</div>
                    {message.trace?.map((trace) => (
                      <div key={trace.id} className={`tool-trace ${trace.status}`} title={trace.result}>
                        <span className="tool-trace-icon">{trace.status === "done" ? "✓" : trace.status === "error" ? "!" : trace.status === "rejected" ? "×" : "…"}</span>
                        <code>{trace.summary}</code>
                        {trace.status === "awaiting-approval" && <span> waiting for your approval</span>}
                        {trace.status === "rejected" && <span> not run</span>}
                      </div>
                    ))}
                  </div>
                </article>
              ))}
            </div>
            </div>
            <div className="composer-dock">
              {cloudReady && !busy && activeConversation?.messages.some((message) => message.role === "user") && (
                <button className="secondary-button escalate-button" onClick={escalate} title="Ask the configured cloud model about your last message. You see exactly what is sent first.">Escalate this</button>
              )}
              <Composer ref={inputRef} draft={draft} setDraft={setDraft} busy={busy} ready={ready} attachment={Boolean(attachment)} onSend={send} onStop={stop} onFile={attachFile} queued={queue.length} />
              <p className="disclaimer">MrVilsyAgent can make mistakes. Verify important information.</p>
              <p className="context-meter" title="Estimated size of this chat against the context window. Older turns are summarized automatically when it fills.">
                Context ≈ {contextTokens.toLocaleString()} / {settings.numCtx.toLocaleString()} tokens{tokensPerSec ? ` · ${tokensPerSec} tok/s` : ""}
              </p>
            </div>
          </section>
        ) : (
          <section className="welcome-view">
            <div className="welcome-content">
              <div className="welcome-spark">✳</div>
              <div className="eyebrow">YOUR PRIVATE AI, ON YOUR DEVICE</div>
              <h1>{greeting(settings.userName)}.<br />What can I <em>help with?</em></h1>
              <p className="welcome-subtitle">I remember what matters to you, read what you share, and always ask before I change anything.</p>
              {connection === "offline" && <button className="connection-banner" onClick={refreshModels}><span className="warning-icon">!</span><span><strong>Ollama isn’t connected</strong><small>Start Ollama locally to begin. Click to retry.</small></span><span className="banner-arrow">↗</span></button>}
              {connection === "online" && !settings.model && <button className="connection-banner" onClick={() => setShowSettings(true)}><span className="warning-icon">!</span><span><strong>No model found</strong><small>Pull a model in Ollama, then refresh.</small></span><span className="banner-arrow">↗</span></button>}
              <div className="prompt-grid">
                {greetingPrompts.map((prompt, index) => <button key={prompt} className="prompt-card" onClick={() => send(undefined, prompt)} disabled={!ready}><span className={`prompt-symbol symbol-${index}`}>{["✉", "☺", "☀"][index]}</span><span>{prompt}</span><span className="prompt-arrow">↗</span></button>)}
              </div>
              <Composer ref={inputRef} draft={draft} setDraft={setDraft} busy={busy} ready={ready} attachment={Boolean(attachment)} onSend={send} onStop={stop} onFile={attachFile} queued={queue.length} />
              <p className="disclaimer">Your messages stay local. MrVilsyAgent can make mistakes—verify important information.</p>
              {notice && <div className="notice" role="status">{notice}</div>}
            </div>
          </section>
        )}
      </main>

      {onboarding.status === "pending" && connection !== "checking" && !showSettings && (
        <Onboarding initial={onboarding} onFinish={finishOnboarding} onSkip={skipOnboarding} />
      )}
      {showSettings && <SettingsModal settings={settings} jobs={jobs} models={models} connection={connection} onClose={() => setShowSettings(false)} onChange={updateSettings} onRefresh={refreshModels} />}
      {showMail && <MailPanel settings={settings} onChange={updateSettings} onClose={() => setShowMail(false)} />}
      {showAgent && (
        <AgentPanel
          jobs={jobs}
          onJobsChange={setJobs}
          reports={reports}
          onReportsChange={setReports}
          pending={pending}
          onApprovePending={approvePending}
          onRejectPending={(actionId) => setPending((previous) => previous.filter((item) => item.id !== actionId))}
          reminders={reminders}
          onRemindersChange={setReminders}
          runningJobId={runningJobId}
          onRunJob={(jobId) => void runJob(jobId)}
          baseUrl={settings.baseUrl}
          chatModel={settings.model}
          numCtx={settings.numCtx}
          embedModel={models.find((model) => model.name.startsWith(EMBED_MODEL_PREFIX))?.name}
          onClose={() => setShowAgent(false)}
        />
      )}
      {approval && (
        <div className="modal-backdrop" role="presentation">
          <section className="settings-modal approval-modal" role="alertdialog" aria-modal="true" aria-labelledby="approval-title">
            <div className="eyebrow">APPROVAL REQUIRED</div>
            <h2 id="approval-title">Allow {approval.tool}?</h2>
            <p className="mail-help">The agent wants to do exactly this. Nothing happens unless you approve.</p>
            <pre className="agent-pre approval-text">{approval.summary}</pre>
            <div className="agent-row">
              <button className="primary-button" onClick={() => decide("approved")}>Approve</button>
              <button className="secondary-button" onClick={() => decide("rejected")}>Reject</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

interface ComposerProps {
  draft: string;
  setDraft: (value: string) => void;
  busy: boolean;
  ready: boolean;
  attachment: boolean;
  onSend: (event?: FormEvent) => void;
  onStop: () => void;
  onFile: (file?: File) => void;
  queued: number;
}

const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer(
  { draft, setDraft, busy, ready, attachment, onSend, onStop, onFile, queued },
  ref,
) {
  return (
    <form className="composer" onSubmit={onSend}>
      {attachment && <div className="attachment-chip">▧ File attached to next message <span>· text only</span></div>}
      <textarea ref={ref} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={ready ? "Ask anything…" : "Connect Ollama to start chatting…"} rows={1} disabled={!ready} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSend(); } }} />
      <div className="composer-toolbar">
        <div className="composer-tools">
          <label className="tool-button" title="Attach a text file"><span>＋</span><span className="tool-label">Add context</span><input type="file" accept=".txt,.md,.json,.ts,.tsx,.js,.jsx,.py,.rs,.html,.css,.yml,.yaml,.toml,.xml,.csv" onChange={(event) => { onFile(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>
          <span className="composer-separator" />
          <span className="composer-mode"><span className="mode-dot" /> Local chat</span>
        </div>
        <div className="composer-end"><span className="enter-hint">{queued ? `${queued} queued · ` : ""}{busy ? "↵ to queue" : "↵ to send"}</span>{busy ? <button className="send-button" type="button" onClick={onStop} aria-label="Stop">■</button> : <button className="send-button" type="submit" disabled={!ready || !draft.trim()} aria-label="Send message">↑</button>}</div>
      </div>
    </form>
  );
});

interface SettingsModalProps {
  settings: Settings;
  jobs: Job[];
  models: OllamaModel[];
  connection: "checking" | "online" | "offline";
  onClose: () => void;
  onChange: (patch: Partial<Settings>) => void;
  onRefresh: () => void;
}

function SettingsModal({ settings, jobs, models, connection, onClose, onChange, onRefresh }: SettingsModalProps) {
  const [backupMessage, setBackupMessage] = useState("");
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [loaded, setLoaded] = useState<LoadedModel[]>([]);
  useEffect(() => {
    probeHardware().then(setHardware).catch(() => setHardware(null));
    loadedModels(settings.baseUrl).then(setLoaded).catch(() => setLoaded([]));
  }, [settings.baseUrl]);
  const recommended = hardware ? recommendModels(hardware.total_ram_gb) : null;
  const installed = (name: string) => models.some((model) => model.name === name || model.name.startsWith(`${name}:`));

  async function exportBackup() {
    try {
      const target = await backupTarget();
      if (!window.confirm(`Save a backup of your memory, notes, skills and settings to:\n\n${target}\n\nMail sign-in tokens are not included.`)) return;
      const saved = await runBackup(target, JSON.stringify({ settings: withoutTokens(settings), jobs }, null, 2));
      setBackupMessage(`Backup saved to ${saved}`);
    } catch (error) {
      setBackupMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function restoreBackup() {
    try {
      const preview = await pickRestore();
      if (!preview) return;
      const text = `Restore from:\n${preview.file}\n\n${preview.files} files will be restored; ${preview.overwrites} existing file(s) with the same name will be REPLACED (files not in the backup are kept).${preview.has_settings ? "\nSettings and jobs in the backup will also be applied; your mail sign-in and API keys are kept." : ""}\n\nContinue?`;
      if (!window.confirm(text)) return;
      const { count, settingsJson } = await applyRestore();
      if (settingsJson) {
        const saved = JSON.parse(settingsJson) as { settings?: Partial<Settings>; jobs?: Job[] };
        if (saved.settings) saveSettings({ ...settings, ...saved.settings, gmailRefreshToken: settings.gmailRefreshToken, outlookRefreshToken: settings.outlookRefreshToken, gmailAccessToken: settings.gmailAccessToken, outlookAccessToken: settings.outlookAccessToken });
        if (saved.jobs) saveJobs(saved.jobs);
      }
      setBackupMessage(`Restored ${count} files. Reloading…`);
      setTimeout(() => window.location.reload(), 800);
    } catch (error) {
      setBackupMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="modal-header"><div><div className="eyebrow">PREFERENCES</div><h2 id="settings-title">Settings</h2></div><button className="icon-button close-button" onClick={onClose} aria-label="Close settings">×</button></div>
        <div className="settings-section"><label htmlFor="profile-email">Email</label><p>Used only to personalize your local profile (your initial and a label). Stored on this device only—never sent anywhere, including to Ollama.</p><input id="profile-email" type="email" value={settings.email} onChange={(event) => onChange({ email: event.target.value })} placeholder="you@example.com" /></div>
        <div className="settings-section"><label htmlFor="ollama-url">Ollama address</label><p>Local server endpoint. Nothing is sent to a cloud service.</p><input id="ollama-url" type="url" value={settings.baseUrl} onChange={(event) => onChange({ baseUrl: event.target.value })} onBlur={onRefresh} placeholder={defaultSettings.baseUrl} /></div>
        <div className="settings-section"><label htmlFor="model-select">Model</label><p>Choose one of the models installed in Ollama.</p><div className="model-select-row"><select id="model-select" value={settings.model} onChange={(event) => onChange({ model: event.target.value })}><option value="">Select a model</option>{models.map((model) => <option key={model.name} value={model.name}>{model.name}</option>)}</select><button className="secondary-button" onClick={onRefresh}>Refresh</button></div></div>
        <div className={`settings-status ${connection}`}><span className="status-dot" />{connection === "online" ? `${models.length} local model${models.length === 1 ? "" : "s"} available` : connection === "checking" ? "Checking local Ollama server…" : "Ollama is not reachable"}</div>
        <div className="settings-section"><label>This computer</label>
          {hardware ? (
            <>
              <p>{hardware.cpu_name || "CPU"} · {hardware.cpu_threads} threads · {hardware.total_ram_gb} GB RAM ({hardware.available_ram_gb} GB free)</p>
              {recommended && <p>Recommended: <code>{recommended.main}</code> for chat, <code>{recommended.fast}</code> for quick background tasks, <code>{recommended.embed}</code> for memory search. {recommended.note} {[recommended.main, recommended.fast, recommended.embed].filter((name) => !installed(name)).map((name) => `ollama pull ${name}`).join(" · ")}</p>}
            </>
          ) : <p>Hardware details are only available in the desktop app.</p>}
          {loaded.length > 0 && <p>Loaded now: {loaded.map((model) => `${model.name} (${model.percentGpu}% on GPU)`).join(", ")}</p>}
          <label htmlFor="fast-model">Fast model (summaries, optional)</label>
          <select id="fast-model" value={settings.fastModel} onChange={(event) => onChange({ fastModel: event.target.value })}><option value="">Same as main model</option>{models.map((model) => <option key={model.name} value={model.name}>{model.name}</option>)}</select>
          <button className="secondary-button" onClick={() => {
            const smallest = models.filter((model) => !/embed/i.test(model.name) && model.size).sort((a, b) => (a.size ?? 0) - (b.size ?? 0))[0];
            onChange({ thinking: false, numCtx: 4096, ...(smallest ? { fastModel: smallest.name } : {}) });
          }} title="Fast model = smallest installed chat model, thinking off, context 4096">Fast mode (quicker replies)</button>
          <button className="secondary-button" onClick={() => { saveOnboarding({ step: 0, answers: loadOnboarding().answers, status: "pending" }); window.location.reload(); }}>Redo onboarding interview</button>
        </div>
        <BrowserSettings />
        <CloudSettings settings={settings} onChange={onChange} />
        <SelfTest />
        <div className="settings-section"><label>Agent persona</label><p>Builds the system prompt the agent runs with. Stored on this device only and sent only to your local Ollama.</p>
          <div className="persona-grid">
            <input aria-label="Agent name" value={settings.agentName} onChange={(event) => onChange({ agentName: event.target.value })} placeholder="Agent name" />
            <input aria-label="Your name" value={settings.userName} onChange={(event) => onChange({ userName: event.target.value })} placeholder="Your name" />
            <input aria-label="Timezone" value={settings.timezone} onChange={(event) => onChange({ timezone: event.target.value })} placeholder="Timezone, e.g. Asia/Kolkata" />
            <input aria-label="Job title" value={settings.jobTitle} onChange={(event) => onChange({ jobTitle: event.target.value })} placeholder="Your role" />
          </div>
          <textarea aria-label="Current priorities" rows={2} value={settings.priorities} onChange={(event) => onChange({ priorities: event.target.value })} placeholder="Current priorities (1–3 lines)" />
          <textarea aria-label="Email signature" rows={3} value={settings.signature} onChange={(event) => onChange({ signature: event.target.value })} placeholder={"Email signature, e.g.\nRegards,\nYour Name\nYour title"} />
          <textarea aria-label="Extra rules" rows={3} value={settings.extraRules} onChange={(event) => onChange({ extraRules: event.target.value })} placeholder="Extra rules (e.g. never reply to appointment-portal messages)" />
          <label className="check-row"><input type="checkbox" checked={settings.toolsEnabled} onChange={(event) => onChange({ toolsEnabled: event.target.checked })} /> Let the agent use tools (read mail and notes freely; every write asks for your approval)</label>
          <label className="check-row"><input type="checkbox" checked={settings.thinking} onChange={(event) => onChange({ thinking: event.target.checked })} /> Let reasoning models (Qwen3, DeepSeek-R1) think first: slower, sometimes better. Their reasoning is never shown or saved.</label>
          <label htmlFor="theme-select">Appearance</label>
          <select id="theme-select" value={settings.theme} onChange={(event) => onChange({ theme: event.target.value as Settings["theme"] })}>
            <option value="warm">Warm (cream)</option>
            <option value="light">Light (white)</option>
            <option value="dark">Dark (black)</option>
          </select>
          <label htmlFor="num-ctx">Context window (tokens)</label>
          <select id="num-ctx" value={settings.numCtx} onChange={(event) => onChange({ numCtx: Number(event.target.value) })}>
            {[4096, 8192, 16384, 32768].map((size) => <option key={size} value={size}>{size.toLocaleString()}{size === 8192 ? " (recommended)" : ""}</option>)}
          </select>
          <p>Larger windows remember more but need more RAM. For meaning-based memory recall, run <code>ollama pull nomic-embed-text</code>; otherwise memory search uses keywords.</p>
        </div>
        <div className="settings-section"><label>Backup</label><p>Saves a zip of MEMORY.md, daily notes, skills and settings to your Documents folder. You confirm the exact file first. Mail tokens are never included.</p><button className="secondary-button" onClick={() => void exportBackup()}>Export backup…</button> <button className="secondary-button" onClick={() => void restoreBackup()}>Restore from backup…</button>{backupMessage && <p>{backupMessage}</p>}</div>
        <div className="settings-footnote">Conversation history and preferences are stored in this app’s local browser storage. File attachments are sent only to your configured local Ollama server.</div>
        <button className="primary-button" onClick={onClose}>Done</button>
      </section>
    </div>
  );
}

export default App;

interface MailPanelProps {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
}

const PROVIDER_INFO = {
  gmail: {
    label: "Gmail",
    searchPlaceholder: "Gmail search, e.g. from:boss@work.com",
    defaultQuery: "newer_than:3d in:inbox",
    steps: (
      <>
        <li>Open <strong>console.cloud.google.com</strong>, create (or pick) a project.</li>
        <li>APIs &amp; Services → Credentials → Create Credentials → OAuth client ID → type <strong>Desktop app</strong>.</li>
        <li>Enable the <strong>Gmail API</strong> for that project.</li>
        <li>Copy the Client ID it gives you and paste it below.</li>
      </>
    ),
    clientIdPlaceholder: "xxxxxxxxxx.apps.googleusercontent.com",
  },
  outlook: {
    label: "Outlook",
    searchPlaceholder: "Outlook search text, e.g. invoice",
    defaultQuery: "newsletter",
    steps: (
      <>
        <li>Open <strong>entra.microsoft.com</strong> (or portal.azure.com) → App registrations → New registration.</li>
        <li>Supported account types: <strong>Personal Microsoft accounts only</strong>.</li>
        <li>Add a platform: <strong>Mobile and desktop applications</strong>, redirect URI exactly <strong>http://localhost</strong>.</li>
        <li>Copy the Application (client) ID it gives you and paste it below.</li>
      </>
    ),
    clientIdPlaceholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  },
} as const;

function MailPanel({ settings, onChange, onClose }: MailPanelProps) {
  const provider = settings.mailProvider;
  const info = PROVIDER_INFO[provider];
  const connected = provider === "gmail" ? isGmailConnected(settings) : isOutlookConnected(settings);
  const clientIdValue = provider === "gmail" ? settings.gmailClientId : settings.outlookClientId;

  const [clientId, setClientId] = useState(clientIdValue);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState<string>(info.defaultQuery);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<EmailSummary[]>([]);
  const [selected, setSelected] = useState<EmailDetail | null>(null);
  const [loadingMessage, setLoadingMessage] = useState(false);
  const [instruction, setInstruction] = useState("Write a short, polite reply.");
  const [draftText, setDraftText] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [savedNotice, setSavedNotice] = useState("");

  function switchProvider(next: "gmail" | "outlook") {
    onChange({ mailProvider: next });
    setClientId(next === "gmail" ? settings.gmailClientId : settings.outlookClientId);
    setQuery(PROVIDER_INFO[next].defaultQuery);
    setError("");
    setResults([]);
    setSelected(null);
    setDraftText("");
  }

  async function connect() {
    setError("");
    setConnecting(true);
    try {
      const trimmed = clientId.trim();
      if (!trimmed) throw new Error(`Paste your ${info.label} OAuth Client ID first.`);
      if (provider === "gmail") {
        onChange({ gmailClientId: trimmed });
        const tokens = await connectGmail(trimmed);
        onChange({
          gmailClientId: trimmed,
          gmailAccessToken: tokens.access_token,
          gmailRefreshToken: tokens.refresh_token ?? "",
          gmailTokenExpiresAt: Date.now() + tokens.expires_in * 1000,
        });
      } else {
        onChange({ outlookClientId: trimmed });
        const tokens = await connectOutlook(trimmed);
        onChange({
          outlookClientId: trimmed,
          outlookAccessToken: tokens.access_token,
          outlookRefreshToken: tokens.refresh_token ?? "",
          outlookTokenExpiresAt: Date.now() + tokens.expires_in * 1000,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not connect to ${info.label}.`);
    } finally {
      setConnecting(false);
    }
  }

  function disconnect() {
    if (provider === "gmail") {
      onChange({ gmailAccessToken: "", gmailRefreshToken: "", gmailTokenExpiresAt: 0 });
    } else {
      onChange({ outlookAccessToken: "", outlookRefreshToken: "", outlookTokenExpiresAt: 0 });
    }
    setResults([]);
    setSelected(null);
    setDraftText("");
  }

  async function runSearch() {
    setError("");
    setSearching(true);
    setSelected(null);
    try {
      const found =
        provider === "gmail"
          ? await searchGmail(await ensureGmailToken(settings, onChange), query)
          : await searchOutlook(await ensureOutlookToken(settings, onChange), query);
      setResults(found);
    } catch (err) {
      setError(err instanceof Error ? err.message : `${info.label} search failed.`);
    } finally {
      setSearching(false);
    }
  }

  async function openMessage(messageId: string) {
    setError("");
    setLoadingMessage(true);
    setDraftText("");
    try {
      const detail =
        provider === "gmail"
          ? await getGmailMessage(await ensureGmailToken(settings, onChange), messageId)
          : await getOutlookMessage(await ensureOutlookToken(settings, onChange), messageId);
      setSelected(detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load that email.");
    } finally {
      setLoadingMessage(false);
    }
  }

  async function draftReply() {
    if (!selected || !settings.model) return;
    setError("");
    setDrafting(true);
    setDraftText("");
    const prompt = `You are drafting a reply to the email below. Follow the user's instruction. Reply with only the email body text, no subject line and no commentary.\n\nInstruction: ${instruction}\n\n--- Original email ---\nFrom: ${selected.from}\nSubject: ${selected.subject}\nDate: ${selected.date}\n\n${selected.body}`;
    try {
      let accumulated = "";
      await streamChat(
        settings.baseUrl,
        settings.model,
        [{ role: "user", content: prompt }],
        (token) => {
          accumulated += token;
          setDraftText(accumulated);
        },
        new AbortController().signal,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Drafting failed.");
    } finally {
      setDrafting(false);
    }
  }

  async function saveDraft() {
    if (!selected || !draftText.trim()) return;
    setError("");
    setSavedNotice("");
    try {
      if (provider === "gmail") {
        const token = await ensureGmailToken(settings, onChange);
        const replyTo = selected.from.match(/<(.+?)>/)?.[1] ?? selected.from;
        const subject = selected.subject.toLowerCase().startsWith("re:") ? selected.subject : `Re: ${selected.subject}`;
        await createGmailDraft(token, replyTo, subject, draftText, selected.id);
      } else {
        const token = await ensureOutlookToken(settings, onChange);
        await createOutlookDraft(token, selected.id, draftText);
      }
      setSavedNotice(`Saved as a draft in ${info.label}. Review and send it from there.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not save the draft to ${info.label}.`);
    }
  }

  return (
    <aside className="mail-panel" aria-label="Mail">
      <div className="mail-header">
        <h2>Mail</h2>
        <button className="icon-button close-button" onClick={onClose} aria-label="Close mail panel">×</button>
      </div>

      {!connected && (
        <div className="mail-provider-switch">
          <button
            className={`secondary-button ${provider === "gmail" ? "selected" : ""}`}
            onClick={() => switchProvider("gmail")}
          >
            Gmail
          </button>
          <button
            className={`secondary-button ${provider === "outlook" ? "selected" : ""}`}
            onClick={() => switchProvider("outlook")}
          >
            Outlook
          </button>
        </div>
      )}

      {!connected ? (
        <div className="mail-connect">
          <p className="mail-help">
            MrVilsyAgent signs in through {info.label === "Gmail" ? "Google’s" : "Microsoft’s"} own sign-in page
            (OAuth) — it never sees your password, and only gets read + draft access (it can never send email on its
            own).
          </p>
          <ol className="mail-steps">{info.steps}</ol>
          <label htmlFor="mail-client-id">{info.label} OAuth Client ID</label>
          <input
            id="mail-client-id"
            type="text"
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            placeholder={info.clientIdPlaceholder}
          />
          <button className="primary-button" onClick={connect} disabled={connecting}>
            {connecting ? "Waiting for sign-in in your browser…" : `Connect ${info.label}`}
          </button>
          {error && <p className="mail-error">{error}</p>}
        </div>
      ) : (
        <div className="mail-body">
          <div className="mail-search">
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={info.searchPlaceholder}
              onKeyDown={(event) => { if (event.key === "Enter") runSearch(); }}
            />
            <button className="secondary-button" onClick={runSearch} disabled={searching}>
              {searching ? "Searching…" : "Search"}
            </button>
          </div>

          {error && <p className="mail-error">{error}</p>}

          {!selected ? (
            <div className="mail-results">
              {results.length === 0 && !searching && <p className="mail-help">Search your inbox to get started.</p>}
              {results.map((item) => (
                <button key={item.id} className="mail-result" onClick={() => openMessage(item.id)}>
                  <span className="mail-result-subject">{item.subject || "(no subject)"}</span>
                  <span className="mail-result-from">{item.from}</span>
                  <span className="mail-result-snippet">{item.snippet}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="mail-detail">
              <button className="secondary-button mail-back" onClick={() => setSelected(null)}>← Back to results</button>
              {loadingMessage ? (
                <p className="mail-help">Loading…</p>
              ) : (
                <>
                  <h3>{selected.subject || "(no subject)"}</h3>
                  <p className="mail-meta">From: {selected.from}<br />Date: {selected.date}</p>
                  <div className="mail-message-body">{selected.body}</div>

                  <label htmlFor="mail-instruction">Draft a reply</label>
                  <textarea
                    id="mail-instruction"
                    value={instruction}
                    onChange={(event) => setInstruction(event.target.value)}
                    rows={2}
                  />
                  <button className="secondary-button" onClick={draftReply} disabled={drafting || !settings.model}>
                    {drafting ? "Drafting with MrVilsyAgent…" : "Draft reply with MrVilsyAgent"}
                  </button>

                  {draftText && (
                    <div className="mail-draft-preview">
                      <textarea value={draftText} onChange={(event) => setDraftText(event.target.value)} rows={8} />
                      <button className="primary-button" onClick={saveDraft}>Save as {info.label} draft (never auto-sent)</button>
                      {savedNotice && <p className="mail-saved">{savedNotice}</p>}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <button className="icon-button mail-disconnect" onClick={disconnect}>Disconnect {info.label}</button>
        </div>
      )}
    </aside>
  );
}
