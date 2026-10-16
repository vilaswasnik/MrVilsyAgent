// Runs only when the user clicks the toolbar button or presses the shortcut.
// activeTab gives access to that one tab for that one invocation; nothing else is requested.
const ENDPOINT = "http://127.0.0.1:17653/tab";

function readPage() {
  const root = document.querySelector("main, article, [role=main]") || document.body;
  const pick = (node) => (node.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
  let text = pick(root);
  // Some job sites keep the posting outside <main>; fall back to the whole body when it is thin.
  if (text.length < 400 && root !== document.body) text = pick(document.body);
  return { url: location.href, title: document.title, text: text.slice(0, 60000) };
}

async function flash(tabId, text, color) {
  await chrome.action.setBadgeBackgroundColor({ color, tabId });
  await chrome.action.setBadgeText({ text, tabId });
  setTimeout(() => chrome.action.setBadgeText({ text: "", tabId }), 3000);
}

chrome.action.onClicked.addListener(async (tab) => {
  try {
    const { token } = await chrome.storage.local.get("token");
    if (!token) {
      chrome.runtime.openOptionsPage();
      return;
    }
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPage });
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-Token": token },
      body: JSON.stringify(result),
    });
    await flash(tab.id, response.ok ? "OK" : response.status === 401 ? "KEY" : "ERR", response.ok ? "#2e7d32" : "#c62828");
  } catch {
    await flash(tab.id, "ERR", "#c62828");
  }
});
