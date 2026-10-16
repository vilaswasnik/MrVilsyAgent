// Receives the single page a user chooses to share from the browser extension.
// Listens on 127.0.0.1 only, requires a pairing token kept in the Windows Credential Manager,
// accepts only requests from a browser extension, and holds just the latest page in memory.
use keyring::Entry;
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tiny_http::{Header, Method, Response, Server};

pub const PORT: u16 = 17653;
const MAX_BODY: u64 = 400_000;
const MAX_TEXT_CHARS: usize = 60_000;
const SERVICE: &str = "MrVilsyAgent";
const TOKEN_NAME: &str = "tab_share_token";

#[derive(Clone, Serialize, Deserialize)]
pub struct SharedTab {
    pub url: String,
    pub title: String,
    pub text: String,
    #[serde(default)]
    pub received_ms: u64,
}

static LATEST: Mutex<Option<SharedTab>> = Mutex::new(None);

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, TOKEN_NAME).map_err(|e| e.to_string())
}

fn new_token() -> String {
    rand::thread_rng().sample_iter(&Alphanumeric).take(32).map(char::from).collect()
}

fn token() -> Result<String, String> {
    match entry()?.get_password() {
        Ok(value) => Ok(value),
        Err(keyring::Error::NoEntry) => {
            let value = new_token();
            entry()?.set_password(&value).map_err(|e| e.to_string())?;
            Ok(value)
        }
        Err(e) => Err(e.to_string()),
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn header<'a>(request: &'a tiny_http::Request, name: &str) -> Option<&'a str> {
    request.headers().iter().find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name)).map(|h| h.value.as_str())
}

// The Host check blocks DNS-rebinding; the Origin check keeps ordinary web pages out.
fn allowed(request: &tiny_http::Request) -> bool {
    let host_ok = matches!(header(request, "Host"), Some(h) if h == format!("127.0.0.1:{PORT}") || h == format!("localhost:{PORT}"));
    let origin_ok = matches!(header(request, "Origin"), Some(o) if o.starts_with("chrome-extension://") || o.starts_with("moz-extension://") || o.starts_with("extension://"));
    host_ok && origin_ok
}

fn sanitize(mut tab: SharedTab) -> Result<SharedTab, &'static str> {
    if !(tab.url.starts_with("http://") || tab.url.starts_with("https://")) {
        return Err("Only http and https pages can be shared.");
    }
    tab.url = tab.url.chars().take(2000).collect();
    tab.title = tab.title.chars().take(300).collect();
    tab.text = tab.text.chars().take(MAX_TEXT_CHARS).collect();
    tab.received_ms = now_ms();
    Ok(tab)
}

fn respond(request: tiny_http::Request, status: u16, body: &str) {
    let mut response = Response::from_string(body).with_status_code(status);
    if let Ok(h) = Header::from_bytes("Content-Type", "application/json") {
        response.add_header(h);
    }
    if let Some(origin) = header(&request, "Origin").map(str::to_string) {
        for (k, v) in [
            ("Access-Control-Allow-Origin", origin.as_str()),
            ("Access-Control-Allow-Headers", "content-type, x-agent-token"),
            ("Access-Control-Allow-Methods", "POST, OPTIONS"),
        ] {
            if let Ok(h) = Header::from_bytes(k, v) {
                response.add_header(h);
            }
        }
    }
    let _ = request.respond(response);
}

fn handle(mut request: tiny_http::Request) {
    if !allowed(&request) {
        return respond(request, 403, r#"{"error":"forbidden"}"#);
    }
    if *request.method() == Method::Options {
        return respond(request, 204, "");
    }
    if *request.method() != Method::Post || request.url() != "/tab" {
        return respond(request, 404, r#"{"error":"not found"}"#);
    }
    let expected = token().unwrap_or_default();
    if expected.is_empty() || header(&request, "X-Agent-Token") != Some(expected.as_str()) {
        return respond(request, 401, r#"{"error":"bad token"}"#);
    }
    let mut body = String::new();
    if request.as_reader().take(MAX_BODY + 1).read_to_string(&mut body).is_err() || body.len() as u64 > MAX_BODY {
        return respond(request, 413, r#"{"error":"page too large"}"#);
    }
    match serde_json::from_str::<SharedTab>(&body).map_err(|_| "invalid body").and_then(|t| sanitize(t).map_err(|e| e)) {
        Ok(tab) => {
            *LATEST.lock().unwrap() = Some(tab);
            respond(request, 200, r#"{"ok":true}"#)
        }
        Err(message) => respond(request, 400, &format!(r#"{{"error":"{message}"}}"#)),
    }
}

pub fn start() {
    std::thread::spawn(|| {
        let Ok(server) = Server::http(("127.0.0.1", PORT)) else { return };
        for request in server.incoming_requests() {
            handle(request);
        }
    });
}

#[tauri::command]
pub fn tab_pairing_token() -> Result<String, String> {
    token()
}

#[tauri::command]
pub fn tab_regenerate_token() -> Result<String, String> {
    let value = new_token();
    entry()?.set_password(&value).map_err(|e| e.to_string())?;
    Ok(value)
}

#[tauri::command]
pub fn tab_latest() -> Option<SharedTab> {
    LATEST.lock().unwrap().clone()
}

#[tauri::command]
pub fn tab_clear() {
    *LATEST.lock().unwrap() = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn post(origin: Option<&str>, token: Option<&str>, host: &str, body: &str) -> String {
        use std::io::{Read, Write};
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", PORT)).unwrap();
        let mut req = format!("POST /tab HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n", body.len());
        if let Some(o) = origin { req += &format!("Origin: {o}\r\n"); }
        if let Some(t) = token { req += &format!("X-Agent-Token: {t}\r\n"); }
        stream.write_all(format!("{req}\r\n{body}").as_bytes()).unwrap();
        let mut out = String::new();
        stream.read_to_string(&mut out).unwrap();
        out.lines().next().unwrap_or("").to_string()
    }

    #[test]
    fn listener_enforces_origin_host_and_token() {
        start();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let host = format!("127.0.0.1:{PORT}");
        let ext = Some("chrome-extension://abc");
        let body = r#"{"url":"https://example.com/job","title":"Job","text":"Contract role"}"#;
        let key = token().unwrap();
        assert!(post(None, Some(&key), &host, body).contains("403"), "no origin");
        assert!(post(Some("https://evil.example"), Some(&key), &host, body).contains("403"), "web origin");
        assert!(post(ext, Some(&key), "evil.example:80", body).contains("403"), "bad host");
        assert!(post(ext, Some("wrong"), &host, body).contains("401"), "bad token");
        assert!(post(ext, Some(&key), &host, r#"{"url":"file:///x","title":"","text":""}"#).contains("400"), "file url");
        assert!(tab_latest().is_none());
        assert!(post(ext, Some(&key), &host, body).contains("200"), "valid");
        assert_eq!(tab_latest().unwrap().title, "Job");
        tab_clear();
    }

    #[test]
    fn only_web_pages_are_accepted_and_text_is_capped() {
        let tab = |url: &str, text: String| SharedTab { url: url.into(), title: "t".into(), text, received_ms: 0 };
        assert!(sanitize(tab("file:///C:/secret.txt", "x".into())).is_err());
        assert!(sanitize(tab("chrome://settings", "x".into())).is_err());
        let ok = sanitize(tab("https://example.com/job", "a".repeat(MAX_TEXT_CHARS + 500))).unwrap();
        assert_eq!(ok.text.chars().count(), MAX_TEXT_CHARS);
    }
}
