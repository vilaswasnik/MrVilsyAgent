import { useEffect, useState } from "react";
import { clearTab, latestTab, tabPairingToken, tabRegenerateToken, type SharedTab } from "../lib/tabs";

export function BrowserSettings() {
  const [token, setToken] = useState("");
  const [shown, setShown] = useState(false);
  const [tab, setTab] = useState<SharedTab | null>(null);
  const [desktop, setDesktop] = useState(true);

  const refresh = () => latestTab().then(setTab).catch(() => undefined);

  useEffect(() => {
    tabPairingToken().then(setToken).catch(() => setDesktop(false));
    refresh();
  }, []);

  if (!desktop) return <div className="settings-section"><label>Browser</label><p>Tab sharing is only available in the desktop app.</p></div>;

  return (
    <div className="settings-section">
      <label>Browser (read-only tab sharing)</label>
      <p>
        Load the <code>extension</code> folder in Chrome (chrome://extensions → Developer mode → Load unpacked), then paste this pairing key into its options. The extension sends only the page you click it on (or Ctrl+Shift+Y), only to this computer, and the app keeps only the latest page in memory.
      </p>
      <div className="model-select-row">
        <input readOnly type={shown ? "text" : "password"} value={token} aria-label="Pairing key" />
        <button className="secondary-button" onClick={() => setShown(!shown)}>{shown ? "Hide" : "Show"}</button>
        <button className="secondary-button" onClick={() => tabRegenerateToken().then(setToken)}>New key</button>
      </div>
      <p>{tab ? `Shared page: ${tab.title || tab.url}` : "No page shared yet."}</p>
      <div className="model-select-row">
        <button className="secondary-button" onClick={refresh}>Check</button>
        {tab && <button className="secondary-button" onClick={() => clearTab().then(() => setTab(null))}>Forget shared page</button>}
      </div>
    </div>
  );
}
