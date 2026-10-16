# MrVilsyAgent project instructions

- MrVilsyAgent is a Windows desktop app using Tauri 2, React, TypeScript, Vite, and Ollama.
- Keep model inference local by default; never add cloud APIs, analytics, or telemetry without explicit approval.
- Keep filesystem and process access opt-in. Attachments must be explicitly selected by the user; never write files or run shell commands automatically.
- Any future file edits or command execution must present the exact action and require user approval first.
- Keep conversation persistence local and document any privacy or security limitations.
- An optional Gmail integration exists (see README "Mail (Gmail) integration"): OAuth+PKCE only (no password fields), read + draft-only scopes, no send capability. Treat this as the one approved exception to "no cloud APIs"; any further cloud/network integrations still need explicit approval first.
- Use `npm run build` for the frontend build and `npm run tauri dev` to launch the desktop app after prerequisites are installed.
