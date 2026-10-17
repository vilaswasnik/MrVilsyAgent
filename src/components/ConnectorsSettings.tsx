import { useState } from "react";
import { discoverMcp, type McpServer } from "../lib/mcp";
import { mailConnected } from "../lib/mail";
import type { Settings } from "../lib/storage";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}

const EXAMPLES = [
  { name: "Files (read a folder)", command: "npx", args: "-y @modelcontextprotocol/server-filesystem C:\\path\\to\\folder" },
  { name: "Fetch", command: "uvx", args: "mcp-server-fetch" },
];

export function ConnectorsSettings({ settings, onChange }: Props) {
  const servers = settings.mcpServers ?? [];
  const [draft, setDraft] = useState({ name: "", command: "", args: "" });
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");

  const update = (id: string, patch: Partial<McpServer>) => onChange({ mcpServers: servers.map((server) => (server.id === id ? { ...server, ...patch } : server)) });

  function add() {
    if (!draft.name.trim() || !draft.command.trim()) {
      setMessage("Give the server a name and a command.");
      return;
    }
    onChange({ mcpServers: [...servers, { id: crypto.randomUUID(), name: draft.name.trim(), command: draft.command.trim(), args: draft.args.trim(), enabled: false, tools: [] }] });
    setDraft({ name: "", command: "", args: "" });
    setMessage("Added, but not running. Press Connect to start it once and list its tools.");
  }

  async function connect(server: McpServer) {
    const exact = `${server.command} ${server.args}`.trim();
    if (!window.confirm(`This will start a program on your computer:\n\n${exact}\n\nOnly continue if you trust it. It is stopped again right after its tools are listed.`)) return;
    setBusyId(server.id);
    setMessage("");
    try {
      const tools = await discoverMcp(server);
      update(server.id, { tools, enabled: tools.length > 0 });
      setMessage(`${server.name}: ${tools.length} tool${tools.length === 1 ? "" : "s"} found. You will be asked before each tool runs.`);
    } catch (error) {
      setMessage(`${server.name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusyId("");
    }
  }

  const builtin = [
    { name: "Local model (Ollama)", state: "On", detail: settings.baseUrl },
    { name: "Mail", state: mailConnected(settings) ? "Connected" : "Not connected", detail: `${settings.mailProvider === "outlook" ? "Outlook" : "Gmail"} · read and draft only, never sends` },
    { name: "Browser tabs", state: "Local only", detail: "Receives pages you share from the extension on 127.0.0.1" },
    { name: "Cloud escalation", state: settings.cloudEnabled ? "On, per request" : "Off", detail: "Sends only your last question, after you confirm" },
  ];

  return (
    <div className="settings-section">
      <label>Connectors</label>
      <p>Built in:</p>
      <ul className="connector-list">
        {builtin.map((item) => <li key={item.name}><strong>{item.name}</strong> — {item.state}<br /><span>{item.detail}</span></li>)}
      </ul>
      <label>MCP servers (advanced)</label>
      <p>An MCP server is a program that gives the agent extra tools. Each one runs <em>as you</em> on this computer, so add only servers you trust. They start only when you press Connect or approve a tool call, and every tool call asks for approval first, showing the exact arguments. Their output is treated as untrusted data.</p>
      {servers.length === 0 && <p>No servers added.</p>}
      {servers.map((server) => (
        <div className="mcp-server" key={server.id}>
          <div className="mcp-head">
            <strong>{server.name}</strong>
            <label className="mcp-toggle"><input type="checkbox" checked={server.enabled} disabled={!server.tools.length} onChange={(event) => update(server.id, { enabled: event.target.checked })} /> Enabled</label>
          </div>
          <code>{server.command} {server.args}</code>
          <p>{server.tools.length ? `Tools: ${server.tools.map((tool) => tool.name).join(", ")}` : "Not connected yet."}</p>
          <div className="mcp-actions">
            <button className="secondary-button" disabled={busyId === server.id} onClick={() => connect(server)}>{busyId === server.id ? "Connecting…" : server.tools.length ? "Reconnect" : "Connect"}</button>
            <button className="secondary-button" onClick={() => { if (window.confirm(`Remove ${server.name}?`)) onChange({ mcpServers: servers.filter((item) => item.id !== server.id) }); }}>Remove</button>
          </div>
        </div>
      ))}
      <div className="persona-grid">
        <input aria-label="MCP server name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Name" />
        <input aria-label="MCP server command" value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} placeholder="Command, e.g. npx" />
      </div>
      <input aria-label="MCP server arguments" value={draft.args} onChange={(event) => setDraft({ ...draft, args: event.target.value })} placeholder="Arguments, e.g. -y @modelcontextprotocol/server-filesystem C:\folder" />
      <div className="mcp-actions">
        <button className="secondary-button" onClick={add}>Add server</button>
        {EXAMPLES.map((example) => <button key={example.name} className="secondary-button" onClick={() => setDraft({ name: example.name, command: example.command, args: example.args })}>Example: {example.name}</button>)}
      </div>
      <p>Do not put passwords or API keys in the arguments: settings are stored unencrypted on this device. Remote (HTTP) MCP servers are not supported.</p>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
