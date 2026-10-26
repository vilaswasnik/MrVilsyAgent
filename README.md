# MrVilsyAgent

**A local-first personal AI agent for Windows.** Chat, triage email, question your documents, and tailor resumes — with the model running on your own machine through Ollama, and every action that changes something waiting for your approval first.

Built with Tauri 2, React, TypeScript, and Rust. No cloud model API, analytics, or telemetry is configured by default.

![MrVilsyAgent — streaming chat UI](docs/images/chat.png)
<!-- TODO(author): add real screenshots/GIF here before publishing — chat UI, Approvals panel, Mail panel. -->

## What it does

- **Local chat with memory** — streaming replies against your Ollama models, a context meter, automatic compaction of long chats, a persistent `MEMORY.md` and daily notes, and a skippable onboarding interview that learns who you are. Memory writes need your approval.
- **Email, read and draft only** — optional Gmail or Outlook connection (OAuth in your own browser; the app never sees your password). Search and read the inbox, label threads, and draft threaded replies. The provider scopes granted are read + compose/draft only — **there is no send scope, so the agent cannot send email**.
- **Documents** — grant folders read-only, index PDF/DOCX/TXT/MD files, and ask questions answered with file and page citations. Compare two versions of a document paragraph by paragraph. (No OCR for scanned PDFs.)
- **Resumes and applications** — keyword-coverage and GAP analysis against a job description, tailored resumes saved as new files (the master is never overwritten, and a save is refused if it claims a skill listed as a gap), and an application tracker that blocks duplicate applications to the same role.
- **Scheduled jobs and reminders** — hourly inbox watch, morning/evening briefs, junk review, follow-up digest. Off by default, they run only while the app is open and file their reports inside the app.
- **Browser review** — a Chrome extension (in `extension/`) that shares the active tab with the app only when you press Ctrl+Shift+Y, for a read-only FIT / NOT A FIT style review quoting page lines.
- **Local MCP servers** — add stdio MCP servers in Settings to give the agent extra tools; every MCP tool call needs your approval with the exact arguments shown.
- **Optional cloud escalation** — off by default; if you configure your own key and an OpenAI-compatible endpoint, the exact text to be sent is shown and sent only after you confirm.

## Safety model

This is the design constraint the project is built around:

- **Read tools run freely; write tools never run silently.** Each write (`draft_email`, `save_memory`, `write_file`, `add_reminder`, `save_resume`, `log_application`) shows the exact action first and waits for Approve or Reject.
- The agent writes only inside its own sandboxed workspace folder. It does not run shell commands.
- Every tool call is schema-validated and written to an audit log (Agent → Audit). Malformed calls are fed back once; a second in a row stops the task. A task is capped at 25 steps.
- Text from mail, documents, files, and web pages is wrapped as untrusted data — instructions inside content are never followed.
- After tasks that read external content, a deterministic check flags concrete claims (dates, amounts, IDs) that don't appear in the tool results.
- Mail tokens are stored in the Windows Credential Manager; backups never include tokens or API keys.

## Quickstart (Windows)

Prerequisites: Node.js LTS, Rust (rustup), Microsoft C++ Build Tools with the *Desktop development with C++* workload, WebView2 Runtime, and Ollama with a tool-capable model downloaded (for example `qwen2.5:7b`).

```powershell
git clone https://github.com/vilaswasnik/MrVilsyAgent.git
cd MrVilsyAgent
npm install
ollama pull qwen2.5:7b
npm run tauri dev
```

Ollama normally serves on port 11434. In the app, open **Settings** to verify the Ollama address and select your model, then **Agent → Memory → Set up agent workspace** to create your `MEMORY.md`, daily notes, and skills folder.

If the app can't connect to Ollama on an older Ollama release, quit the tray app and start it from PowerShell with the local origins allowed:

```powershell
$env:OLLAMA_ORIGINS="tauri://*,http://tauri.localhost,http://localhost:1420"
ollama serve
```

Only allow the local origins shown — do not expose Ollama to public networks.

### Optional: connect mail

Mail is off by default and the setup is yours to do (the app never asks for your password):

- **Gmail:** create a Google Cloud project, enable the Gmail API, create a *Desktop app* OAuth client, paste its Client ID into the Mail panel, and connect. Scopes: `gmail.readonly` + `gmail.compose`.
- **Outlook (personal accounts):** register an app in Entra/Azure with platform *Mobile and desktop applications*, redirect URI `http://localhost`, public client flows on, and delegated permissions `Mail.Read` + `Mail.ReadWrite` (+ `offline_access`). Paste the Application (client) ID into the Mail panel and connect.

Revoke access any time from your Google/Microsoft account pages or with Disconnect in the Mail panel.

## Try it / run a POC

You don't need the mail integration to evaluate the agent:

1. Build and run with the quickstart above, using any tool-capable local model.
2. Run the onboarding interview (or skip it and edit `MEMORY.md` by hand).
3. Open **Settings → Self-test** and run the offline safety checks (writes gated, outside-workspace reads refused, no send tool, malformed calls rejected).
4. Point the Documents panel at a folder of your own PDFs and ask questions — check the page citations.
5. Paste a job description into the resume flow and read the GAP analysis before letting it tailor anything.

Good POC questions: Does the approval gate hold for every write? Does claim verification catch invented details from your own documents? Does the duplicate-application block work on your real job search?

## Architecture, briefly

- `src/` — React/TypeScript frontend (`App.tsx`, `components/`, `lib/`): chat UI, agent panels, settings.
- `src-tauri/` — Rust/Tauri 2 backend: local HTTP listener for the browser extension, credential storage (keyring), PDF text extraction, backup/restore (zip).
- `extension/` — the Chrome extension (background script, options page, pairing key) that shares the active tab on demand.
- Agent data (memory, skills, reports, resumes) lives in the app's data folder, in plain local text files you can read and edit.

## Screenshots / demo

<!-- TODO(author): record a 60–90 second demo — ask a question of an indexed PDF, approve a draft reply, run the self-test — and link it here. -->

_Planned:_ chat with a local model · the Approvals queue · document Q&A with page citations · resume GAP analysis.

## Current limitations (stated up front)

- Windows only, and no packaged installer yet — build from source with `npm run tauri dev`; `npm run build` produces the frontend/Tauri build.
- Jobs and reminders only run while the app is open.
- Workspace files and reports are unencrypted local text.
- No web search tool (it would be a new cloud integration), no OCR, no automatic job applying, no junk-mail moving/blocking.
- Small local models can make mistakes with multi-step tool use — the approval gate is there for that reason.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, tests (`npm test`, `cargo test --lib` in `src-tauri`), and a list of good first issues.

## Talk to the author

Questions, POC ideas, or feedback: open a GitHub Issue, or start a Discussion if it's enabled on the repo. I'm particularly interested in hearing from people running local models on modest hardware, and from anyone testing the approval-gate model against their own workflows.

— Vilas Wasnik, Senior Linux & DevOps Engineer · GitHub [@vilaswasnik](https://github.com/vilaswasnik)

## License

No license file has been added yet, so the code is not licensed for reuse at this time. If you want to build on it, open an issue and ask — and watch this space.
