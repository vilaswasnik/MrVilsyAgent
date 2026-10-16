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

## Personal agent (memory, tools, scheduled jobs)

MrVilsyAgent can act as a local personal agent. Everything runs on your Ollama model, and every action that changes something needs your approval.

- **System prompt.** In **Settings → Agent persona**, set the agent name, your name, timezone, role, priorities, email signature and extra rules. These build the system prompt, which includes your hard rules (draft but never send email, never invent facts about you, irreversible actions need your OK) and the current contents of `MEMORY.md`.
- **Memory.** Open **Agent → Memory** and click **Set up agent workspace**. This creates `MEMORY.md`, `system_prompt.md` (your editable prompt template), `memory/` (daily notes) and `skills/` (markdown playbooks) in the app's data folder. You can edit them in the panel. The agent gets `MEMORY.md` and the last two daily notes in its prompt (capped in size) and searches the rest with `search_memory`. Search is keyword-based; if you run `ollama pull nomic-embed-text`, it also finds facts by meaning (for example "who looks after my teeth" finds your dentist). Embeddings are computed locally and kept in memory only. The agent cannot read or write anything outside that folder.
- **Context window.** Settings → Context window sets Ollama's `num_ctx` (default 8192). Without it Ollama may silently truncate long prompts. Older chat turns are dropped automatically to fit. Use the **■** button to stop a reply.
- **Tools.** With a tool-capable model (for example `qwen2.5:7b`), the agent can call read tools freely: `read_inbox`, `search_mail`, `read_email`, `search_memory`, `list_files`, `read_file`, `list_skills`, `read_skill`, `list_reminders`, `get_time`. Write tools always show the exact action first and wait for your **Approve** or **Reject**: `draft_email` (saves a draft, never sends), `save_memory`, `write_file`, `add_reminder`. Turn tools off in Settings if you prefer plain chat.
- **Scheduled jobs.** **Agent → Jobs** has an hourly inbox watch and a morning brief, both off by default. They run only while the app is open, use read tools only, and put their reports under **Reports**. If a job proposes a write, it is queued under **Approvals** and nothing runs until you approve it. Reminders fire as entries in **Reports** while the app is open.
- **Skills.** Add your own `skills/*.md` playbooks; the agent reads one when a task matches.

Limitations: there is no web search tool (it would be a new cloud integration and needs explicit approval first), jobs do not run when the app is closed, workspace files and reports are unencrypted local text, and small local models can make mistakes with multi-step tool use, so review what they propose.

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
2. Supported account types: **Personal Microsoft accounts only**.
3. Add a platform: **Mobile and desktop applications**, with redirect URI exactly `http://localhost`.
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
