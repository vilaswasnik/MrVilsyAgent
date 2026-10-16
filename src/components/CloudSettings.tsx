import { useEffect, useState } from "react";
import { askCloud, cloudKeyPresent, deleteCloudKey, saveCloudKey } from "../lib/cloud";
import { runSelfTests, type TestResult } from "../lib/selftest";
import type { Settings } from "../lib/storage";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}

export function CloudSettings({ settings, onChange }: Props) {
  const [hasKey, setHasKey] = useState(false);
  const [key, setKey] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    cloudKeyPresent().then(setHasKey);
  }, []);

  async function saveKey() {
    await saveCloudKey(key);
    setKey("");
    setHasKey(await cloudKeyPresent());
    setMessage("Key saved to the Windows Credential Manager.");
  }

  async function removeKey() {
    await deleteCloudKey();
    setHasKey(false);
    onChange({ cloudEnabled: false });
    setMessage("Key removed and escalation turned off.");
  }

  async function test() {
    setMessage("Sending a one-word test to the cloud service…");
    try {
      await askCloud(settings, "Reply with the single word: ok");
      setMessage("Connected.");
    } catch (error) {
      setMessage(String(error));
    }
  }

  return (
    <div className="settings-section">
      <label>Cloud escalation (optional, off by default)</label>
      <p>
        An escape hatch for a hard question, never a dependency. When on, an “Escalate this” button appears under a chat. It shows you the exact text, sends only your last message to the service below, and only after you confirm. Nothing else leaves this computer, and nothing is sent automatically.
      </p>
      <label className="check-row">
        <input type="checkbox" checked={settings.cloudEnabled} disabled={!hasKey} onChange={(event) => onChange({ cloudEnabled: event.target.checked })} /> Enable escalation {!hasKey && "(save a key first)"}
      </label>
      <input aria-label="Cloud endpoint" value={settings.cloudBaseUrl} onChange={(event) => onChange({ cloudBaseUrl: event.target.value })} placeholder="https://api.openai.com/v1 (OpenAI-compatible)" />
      <input aria-label="Cloud model" value={settings.cloudModel} onChange={(event) => onChange({ cloudModel: event.target.value })} placeholder="Model name" />
      <div className="model-select-row">
        <input aria-label="Cloud API key" type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} placeholder={hasKey ? "Key saved (type to replace)" : "Your API key"} />
        <button className="secondary-button" disabled={!key.trim()} onClick={saveKey}>Save key</button>
      </div>
      <div className="model-select-row">
        <button className="secondary-button" disabled={!hasKey || !settings.cloudModel} onClick={test}>Test connection</button>
        {hasKey && <button className="secondary-button" onClick={removeKey}>Remove key</button>}
      </div>
      {message && <p>{message}</p>}
    </div>
  );
}

export function SelfTest() {
  const [results, setResults] = useState<TestResult[]>([]);
  const [running, setRunning] = useState(false);

  async function run() {
    setResults([]);
    setRunning(true);
    await runSelfTests((result) => setResults((previous) => [...previous, result]));
    setRunning(false);
  }

  const failed = results.filter((result) => !result.pass).length;

  return (
    <div className="settings-section">
      <label>Self-test</label>
      <p>Checks the safety rules on this install (no network, nothing written). Run it after updates.</p>
      <button className="secondary-button" disabled={running} onClick={run}>{running ? "Running…" : "Run self-test"}</button>
      {results.length > 0 && (
        <>
          <p>{running ? "" : failed ? `${failed} of ${results.length} failed.` : `All ${results.length} checks passed.`}</p>
          <ul className="selftest-list">
            {results.map((result) => (
              <li key={result.id}>{result.pass ? "✅" : "❌"} {result.name}{result.detail ? ` — ${result.detail}` : ""}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
