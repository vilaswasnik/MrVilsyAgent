# MrVilsyAgent

MrVilsyAgent is a local-first Windows desktop AI assistant built with Tauri, React, TypeScript, and Ollama. It has a streaming chat UI, local conversation history, model selection, and explicit text-file attachments for code/context review.

## Privacy and scope

- Inference requests go to the Ollama address configured in Settings (default: `http://localhost:11434`). No cloud model API, analytics, or telemetry is configured.
- Conversations and settings are stored in the desktop webview's local storage on this device. They are not encrypted by this starter app.
- File attachments are selected by you, read as text (up to 500 KB), and included only with the next message to the configured Ollama server. Attachments are not written back to disk.
- This starter intentionally does not run shell commands. The optional agent (see "Personal agent") can write only inside its own sandboxed workspace folder, and only after you approve the exact action.
- Ollama must allow the Tauri webview's local origin. See the Windows setup below if the connection check fails.

## Windows prerequisites

1. Install Node.js LTS (npm is included).
2. Install Rust using rustup.
3. Install Microsoft C++ Build Tools with the **Desktop development with C++** workload. WebView2 Runtime is also required; it is included on most current Windows installations.
4. Install Ollama and download a model that fits your computer's memory. For example, `qwen2.5:7b` is a useful general-purpose starting point; smaller models can run on less memory.

## Run locally

From this project folder:

```powershell
npm install
ollama pull qwen2.5:7b
npm run tauri dev
```

Ollama's local server normally runs on port 11434. Open **Settings** in MrVilsyAgent to verify its address and select an installed model.

### If MrVilsyAgent cannot connect to Ollama

Current Ollama releases already allow the Tauri webview origin by default, so start it normally (`ollama serve`, or the tray app). On older versions, quit the tray app and start Ollama from PowerShell with your local origins allowed:

```powershell
$env:OLLAMA_ORIGINS="tauri://*,http://tauri.localhost,http://localhost:1420"
ollama serve
```

If Ollama exits with `panic: bad origin`, unset `OLLAMA_ORIGINS` and use the default. Keep that PowerShell window open while using the app. Only allow the local origins shown here; do not expose Ollama to public networks.

## What the agent can do

- **Chat and memory:** local chat with a Stop button and context meter, automatic compaction, persistent `MEMORY.md` and daily notes, and a skippable onboarding interview. Memory writes need your approval.
- **Email (Gmail or Outlook, read and draft only):** read and search the inbox, label messages, write threaded draft replies, and track threads awaiting a reply. Sending is impossible.
- **Scheduled jobs and reminders:** inbox watch, morning and evening briefs, junk review and follow-up digest. Off by default, run only while the app is open, and catch up on start.
- **Documents:** index folders you grant, ask questions with file and page citations, summarize, and compare versions.
- **Resumes and applications:** keyword-coverage and GAP analysis, tailored resumes saved as new files, and an application tracker that blocks duplicate applications. Edit them in **Agent → Resumes** and **Agent → Skills**.
- **Browser review:** a Chrome extension that shares the active tab only when you invoke it (Ctrl+Shift+Y).
- **Safety:** approvals for every write, schema-validated tool calls, an audit log, untrusted-content wrapping, `<think>` stripping, claim verification, crash recovery, read-only sub-tasks, backup and restore, and a self-test runner.
- **Settings:** models and context size, hardware probe, **Appearance** (warm, light or dark), optional cloud escalation.
- **Not built:** automatic job applying, OCR for scanned PDFs, moving or blocking junk mail.

## Personal agent (memory, tools, scheduled jobs)

MrVilsyAgent can act as a local personal agent. Everything runs on your Ollama model, and every action that changes something needs your approval.

- **System prompt.** In **Settings → Agent persona**, set the agent name, your name, timezone, role, priorities, email signature and extra rules. These build the system prompt, which includes your hard rules (draft but never send email, never invent facts about you, irreversible actions need your OK) and the current contents of `MEMORY.md`.
- **Memory.** Open **Agent → Memory** and click **Set up agent workspace**. This creates `MEMORY.md`, `system_prompt.md` (your editable prompt template), `memory/` (daily notes) and `skills/` (markdown playbooks) in the app's data folder. You can edit them in the panel. The agent gets `MEMORY.md` and the last two daily notes in its prompt (capped in size) and searches the rest with `search_memory`. Search is keyword-based; if you run `ollama pull nomic-embed-text`, it also finds facts by meaning (for example "who looks after my teeth" finds your dentist). Embeddings are computed locally and kept in memory only. The agent cannot read or write anything outside that folder.
- **Context window.** Settings → Context window sets Ollama's `num_ctx` (default 8192). Without it Ollama may silently truncate long prompts. Older chat turns are dropped automatically to fit. Use the **■** button to stop a reply.
- **Tools.** With a tool-capable model (for example `qwen2.5:7b`), the agent can call read tools freely: `read_inbox`, `search_mail`, `read_email`, `search_memory`, `list_files`, `read_file`, `list_skills`, `read_skill`, `list_reminders`, `get_time`, `search_documents`, `list_documents`, `compare_documents`, `list_follow_ups`, `review_junk`, `analyze_job_fit`, `check_application`, `list_applications`, `review_current_tab`. Write tools always show the exact action first and wait for your **Approve** or **Reject**: `draft_email` (saves a draft, never sends), `save_memory`, `write_file`, `add_reminder`, `save_resume`, `log_application`. Turn tools off in Settings if you prefer plain chat.
- **Scheduled jobs.** **Agent → Jobs** has an hourly inbox watch and a morning brief, both off by default. They run only while the app is open, use read tools only, and put their reports under **Reports**. If a job proposes a write, it is queued under **Approvals** and nothing runs until you approve it. Reminders fire as entries in **Reports** while the app is open.
- **Skills.** Add your own `skills/*.md` playbooks; the agent reads one when a task matches.

Limitations: there is no web search tool (it would be a new cloud integration and needs explicit approval first), jobs do not run when the app is closed, workspace files and reports are unencrypted local text, and small local models can make mistakes with multi-step tool use, so review what they propose.

### Harness safeguards

- Every tool call is validated against its schema. One malformed call is fed back to the model; a second in a row stops the task. Repeating the same call twice stops it too, and a task is capped at 25 steps. **Agent → Audit** lists every call (time, tool, arguments, result).
- `delegate_task` runs a read-only sub-task in a fresh context (fast model, at most 8 steps) and returns a short summary; its output is treated as untrusted too.
- After a task that read mail, files or pages, a deterministic check flags concrete claims (emails, dates, amounts, ids, long numbers) that do not appear in the tool results. It does not re-call the tools or use a second model pass.
- If the app is closed mid-task, the next start shows a notice and repeats nothing. An identical approved write is refused for 10 minutes, so a retry cannot duplicate it.
- **Settings → Appearance** switches between warm, light (white) and dark (black).
- Text from mail, documents, files and web pages is wrapped as untrusted data. Instructions inside it are never followed.
- Long chats are compacted automatically (older turns are summarized, optionally by a smaller **Fast model**). The context meter under the composer shows usage and tokens per second.
- **Settings → This computer** probes RAM/CPU and recommends a model set. First run starts a skippable onboarding interview; answers become `MEMORY.md` entries that wait in **Approvals**.
- **Settings → Self-test** runs offline safety checks (no `<think>` leakage, no send tool, malformed calls rejected, outside-workspace reads refused, writes gated, gap skills blocked, duplicates blocked, cloud off by default).

### Mail extras

Messages are labelled INTERVIEW / RECRUITER / BANK-SECURITY / PERSONAL / AD. `list_follow_ups` lists threads awaiting a reply on either side (matched by subject). `review_junk` reads the junk folder without moving anything. Drafts quote the original and add your signature once. Extra jobs (evening brief, junk review, follow-up digest) are off by default; due jobs catch up when the app starts or regains focus, and runs with nothing new stay quiet in Reports.

### Documents and resumes

- **Documents.** In **Agent → Documents**, grant read-only folders, then index PDF, DOCX, TXT and MD files (about 800-token chunks, `nomic-embed-text` embeddings). `search_documents` answers with file and PDF page citations, or says it cannot find the answer. `compare_documents` lists paragraphs that differ between two versions. Re-index PDFs indexed before page labels existed. No OCR for scanned files.
- **Resumes.** Save your master resume to `resumes/master.md` (it is never overwritten). `analyze_job_fit` reports keyword coverage and a GAP list. `save_resume` creates a new tailored file after approval and is refused if it claims a gap skill. `log_application` and `check_application` keep `state/applications.md` and block a second application to the same role.

### Browser review (read-only, optional)

Load the `extension` folder in Chrome (Developer mode → Load unpacked) and paste the pairing key from **Settings → Browser** into its options. Clicking the extension button (or Ctrl+Shift+Y) sends only the active tab's URL, title and text to the app on `127.0.0.1:17653`. The listener requires the key, accepts only extension origins and the local host name, and keeps only the latest page in memory. `review_current_tab` lets the agent give a FIT / NOT A FIT verdict quoting page lines. Automated job applying is not implemented.

### Cloud escalation (optional, off by default)

**Settings → Cloud escalation** takes your own key (stored in the Credential Manager), an https OpenAI-compatible endpoint and a model. When enabled, **Escalate this** shows the exact text to be sent (only your last message) and sends it only after you confirm. This contacts an external server, so it is the second approved network exception after mail.

### Backup and restore

**Settings → Export backup** writes a zip to Documents. **Restore from backup** shows how many files would be replaced and applies only after you confirm. Entries that try to leave the workspace are rejected; mail tokens and API keys are never part of a backup or touched by a restore.

## Mail (Gmail or Outlook) integration — optional

MrVilsyAgent can optionally connect to **Gmail or Outlook/Microsoft 365** (toggle in the panel) to search your inbox and draft replies with your local model, shown in a panel on the right (open it from the **✉ Mail** button in the sidebar). This is **off by default** and requires you to set it up. Personal Microsoft accounts (outlook.com / hotmail.com / live.com) use the Outlook option.

**Security model — read this first:**
- MrVilsyAgent never asks for, sees, or stores your email password. Connecting opens Google's or Microsoft's own sign-in page in your system browser (OAuth 2.0 with PKCE); the provider only hands back a limited, revocable access token.
- Access is scoped to **read** and **create drafts** only (Gmail: `gmail.readonly` + `gmail.compose`; Outlook: `Mail.Read` + `Mail.ReadWrite`). There is no "send" scope for either provider — MrVilsyAgent can never send email on your behalf. AI-drafted replies are saved as drafts for you to review and send yourself.
- Refresh tokens are stored in the Windows Credential Manager (DPAPI-protected), separately per provider, and are never written to the app's local storage. Access tokens live in memory only and are re-created at startup. Tokens left in older plaintext settings are moved into the vault on first launch. Revoke access anytime at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) or [account.live.com/consent/Manage](https://account.live.com/consent/Manage), or use "Disconnect" in the Mail panel.
- Reasoning models (Qwen3, DeepSeek-R1): `<think>` text is stripped before display, storage, or any memory write. Thinking is off by default (Settings → toggle) for faster replies.
- The inbox watch keeps a per-job watermark (newest message time + id) and reports only newer mail; a failed run does not advance it.
- Settings → Export backup saves a zip of the workspace and settings (no tokens) to Documents after you confirm the exact path.
- Tests: `npm test` (frontend) and `cargo test --lib` in `src-tauri`.
- This feature does contact external servers (the provider's OAuth and mail API endpoints) — unlike the local-only Ollama chat, it is not fully on-device.

**One-time setup (you do this, not the app):**

*Gmail:*
1. Open [console.cloud.google.com](https://console.cloud.google.com), create or select a project.
2. **APIs & Services → Credentials → Create Credentials → OAuth client ID**, type **Desktop app**.
3. **APIs & Services → Library**, enable the **Gmail API** for that project.
4. Copy the generated Client ID and paste it into the Mail panel's "Gmail OAuth Client ID" field, then click **Connect Gmail**.

*Outlook (personal Microsoft accounts, e.g. live.com/outlook.com):*
1. Open [entra.microsoft.com](https://entra.microsoft.com) (or portal.azure.com) → **App registrations → New registration**.
2. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts** (or personal only). A single-tenant registration fails with `unauthorized_client`.
3. Add a platform: **Mobile and desktop applications**, with redirect URI exactly `http://localhost`, and turn on **Allow public client flows**.
4. Under **API permissions**, add Microsoft Graph delegated permissions `Mail.Read` and `Mail.ReadWrite` (plus `offline_access`).
5. Copy the **Application (client) ID** and paste it into the Mail panel's "Outlook OAuth Client ID" field, then click **Connect Outlook**.

Once connected, search your inbox, open a message, give MrVilsyAgent an instruction (e.g. "write a short, polite decline"), and click **Draft reply with MrVilsyAgent** — it uses your already-configured local Ollama model. Saving a draft only ever creates a draft in Gmail/Outlook; nothing is ever sent automatically.

## Build

```powershell
npm run build
```

To build and run the Tauri desktop shell for development, use `npm run tauri dev`. Windows installer bundling is not enabled in this starter; enable a Tauri bundle target and add the required app icons when preparing a distributable.

## Current scope

The app is a local chat plus a personal agent with approval-gated tools (see "Personal agent" above). It still has no unrestricted desktop control, no background monitoring when the app is closed, and no shell command execution. File access is limited to user-selected attachments and one sandboxed agent folder, and every write or draft requires your approval of the exact action first.
