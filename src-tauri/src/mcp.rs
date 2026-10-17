use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::thread;
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(45);
const MAX_OUTPUT: usize = 20_000;

struct Session {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
    next_id: u64,
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn spawn(command: &str, args: &[String]) -> Result<Session, String> {
    if command.trim().is_empty() {
        return Err("No command configured for this server.".into());
    }
    // cmd /C lets launchers such as npx (a .cmd file) resolve on Windows.
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(command);
        c
    } else {
        Command::new(command)
    };
    cmd.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("Could not start the server: {e}"))?;
    let stdin = child.stdin.take().ok_or("No stdin")?;
    let stdout = child.stdout.take().ok_or("No stdout")?;
    let (tx, rx) = channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    Ok(Session { child, stdin, lines: rx, next_id: 1 })
}

impl Session {
    fn send(&mut self, value: &Value) -> Result<(), String> {
        let mut text = value.to_string();
        text.push('\n');
        self.stdin.write_all(text.as_bytes()).and_then(|_| self.stdin.flush()).map_err(|e| format!("Server closed the connection: {e}"))
    }

    fn request(&mut self, method: &str, params: Value, deadline: Instant) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))?;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err("The server did not answer in time.".into());
            }
            let line = self.lines.recv_timeout(left).map_err(|_| "The server did not answer in time.".to_string())?;
            let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
            if msg.get("id").and_then(Value::as_u64) != Some(id) || msg.get("method").is_some() {
                continue;
            }
            if let Some(err) = msg.get("error") {
                return Err(err.get("message").and_then(Value::as_str).unwrap_or("Server error").to_string());
            }
            return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    fn handshake(&mut self, deadline: Instant) -> Result<(), String> {
        self.request(
            "initialize",
            json!({ "protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": { "name": "MrVilsyAgent", "version": "0.1.0" } }),
            deadline,
        )?;
        self.send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
    }
}

fn run<T>(command: String, args: Vec<String>, work: impl FnOnce(&mut Session, Instant) -> Result<T, String>) -> Result<T, String> {
    let deadline = Instant::now() + TIMEOUT;
    let mut session = spawn(&command, &args)?;
    session.handshake(deadline)?;
    work(&mut session, deadline)
}

// Starts the server the user configured, lists its tools, then stops it.
#[tauri::command]
pub async fn mcp_discover(command: String, args: Vec<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run(command, args, |s, d| {
            let result = s.request("tools/list", json!({}), d)?;
            Ok(result.get("tools").cloned().unwrap_or(json!([])))
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// Runs one tool call the user has approved. The server is stopped afterwards.
#[tauri::command]
pub async fn mcp_call(command: String, args: Vec<String>, tool: String, arguments: Value) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run(command, args, |s, d| {
            let result = s.request("tools/call", json!({ "name": tool, "arguments": arguments }), d)?;
            Ok(flatten(&result))
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn flatten(result: &Value) -> String {
    let mut text = result
        .get("content")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| match item.get("text").and_then(Value::as_str) {
                    Some(t) => t.to_string(),
                    None => format!("[{} content omitted]", item.get("type").and_then(Value::as_str).unwrap_or("non-text")),
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_else(|| result.to_string());
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        text = format!("Tool reported an error: {text}");
    }
    if text.len() > MAX_OUTPUT {
        let mut end = MAX_OUTPUT;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push_str("\n…(truncated)");
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flattens_text_and_marks_errors() {
        let ok = json!({ "content": [{ "type": "text", "text": "hi" }, { "type": "image" }] });
        assert_eq!(flatten(&ok), "hi\n[image content omitted]");
        let bad = json!({ "isError": true, "content": [{ "type": "text", "text": "nope" }] });
        assert!(flatten(&bad).starts_with("Tool reported an error"));
    }

    #[test]
    fn empty_command_is_rejected() {
        assert!(spawn("  ", &[]).is_err());
    }

    const FAKE: &str = "const rl=require('readline').createInterface({input:process.stdin});rl.on('line',l=>{const m=JSON.parse(l);if(m.id===undefined)return;const r=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{}}:m.method==='tools/list'?{tools:[{name:'echo',description:'d',inputSchema:{type:'object',properties:{t:{type:'string'}}}}]}:{content:[{type:'text',text:'got '+m.params.arguments.t}]};console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:r}))})";

    #[test]
    fn talks_to_a_stdio_server() {
        let path = std::env::temp_dir().join("mrvilsy_fake_mcp.cjs");
        std::fs::write(&path, FAKE).unwrap();
        let args = vec![path.to_string_lossy().to_string()];
        let tools = run("node".into(), args.clone(), |s, d| s.request("tools/list", json!({}), d)).unwrap();
        assert_eq!(tools["tools"][0]["name"], "echo");
        let out = run("node".into(), args, |s, d| {
            let r = s.request("tools/call", json!({ "name": "echo", "arguments": { "t": "yo" } }), d)?;
            Ok(flatten(&r))
        })
        .unwrap();
        assert_eq!(out, "got yo");
    }
}
