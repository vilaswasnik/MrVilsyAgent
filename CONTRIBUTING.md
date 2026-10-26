# Contributing to MrVilsyAgent

Thanks for looking. MrVilsyAgent is a local-first personal AI agent (Tauri 2 + React/TypeScript + Rust, Ollama for inference), and contributions of code, docs, tests, and bug reports are all welcome.

## Run it locally

Prerequisites (Windows): Node.js LTS, Rust via rustup, Microsoft C++ Build Tools with the *Desktop development with C++* workload, WebView2 Runtime, and Ollama with a tool-capable model (e.g. `qwen2.5:7b`).

```powershell
git clone https://github.com/vilaswasnik/MrVilsyAgent.git
cd MrVilsyAgent
npm install
ollama pull qwen2.5:7b
npm run tauri dev
```

Frontend-only work can usually be done with `npm run dev` (Vite) plus `npm run build` to type-check (`tsc --noEmit && vite build`).

Tests:

```powershell
npm test                    # vitest, frontend
cd src-tauri; cargo test --lib   # Rust backend
```

Please run both suites relevant to your change before opening a PR, and also run the in-app **Settings → Self-test** if your change touches tools, approvals, or memory — those checks encode the project's safety rules.

## Non-negotiable design rules

PRs that weaken these will be asked to rework:

1. **Write tools are approval-gated.** Any new tool that changes state must present the exact action and wait for Approve/Reject. There is no silent-write path.
2. **Email is read + draft only.** Do not add a send scope or a send tool for Gmail/Outlook.
3. **No workspace escapes.** The agent reads/writes only its sandboxed workspace, user-granted document folders (read-only), and user-selected attachments.
4. **Content is untrusted.** Text arriving from mail, documents, files, web pages, or MCP servers must be wrapped/handled as data, never followed as instructions.
5. **No telemetry or cloud calls by default.** New network integrations need an explicit, off-by-default setting and a discussion first.

## Filing an issue

Use GitHub Issues. A useful bug report includes: what you did, what you expected, what happened, your Ollama model and version, and the relevant lines from **Agent → Audit** (that log exists precisely for this). For safety-model concerns (an approval that didn't fire, a claim that slipped through verification), say so in the title — those get priority.

Feature ideas: open an issue or a Discussion describing the workflow you're trying to support, not just the feature — the approval/memory model means workflow fit matters more than raw capability.

## PR process

1. Fork, branch from `main`, keep the change focused.
2. Match the surrounding code style; TypeScript is strict (`tsc --noEmit` must pass via `npm run build`).
3. Add or update tests where the change has logic (vitest for frontend, cargo tests for `src-tauri`).
4. In the PR description: what changed, how you tested it, and screenshots for UI changes.
5. One approval from the maintainer merges; expect questions on anything touching tools, memory, or mail scopes.

## Good first issues

Concrete, evidence-based starting points (each cites where the gap is):

1. **Add screenshots and a short demo to the README.** The README currently contains no images at all, so a new visitor can't see the chat UI, Approvals panel, or Mail panel before building from source. Capture the main screens from a local run and wire them into the README's Screenshots section.
2. **Issue and PR templates.** `.github/` currently contains only `copilot-instructions.md`. Add `.github/ISSUE_TEMPLATE/` (bug report asking for model/Ollama version + Audit log excerpt, and a feature template) and a PR template reflecting the checklist above.
3. **Start splitting `src/App.tsx`.** At ~57 KB it holds the whole app shell. Extract one self-contained panel (Settings or Reports are good candidates) into `src/components/` with no behavior change, covered by the existing vitest suite.
4. **A "models that work well" field guide.** The README names only `qwen2.5:7b` as a starting point, while Settings has a hardware probe that recommends model sets. Document a small tested matrix (model, RAM, tool-calling reliability notes) in a `docs/models.md` so first-time users pick a workable model.
5. **Installer/bundling spike.** The README notes Windows installer bundling is not enabled. Investigate enabling a Tauri bundle target with the required icons, and report what a distributable build needs — even a findings-only PR/issue write-up helps.
