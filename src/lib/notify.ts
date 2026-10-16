// Local desktop notification through the webview's own Notification API; nothing leaves the device.
export function notifyDesktop(title: string, body: string): void {
  try {
    if (typeof Notification === "undefined") return;
    const show = () => new Notification(title, { body: body.replace(/\s+/g, " ").slice(0, 180) });
    if (Notification.permission === "granted") show();
    else if (Notification.permission === "default") void Notification.requestPermission().then((p) => p === "granted" && show());
  } catch {
    /* notifications are best effort */
  }
}
