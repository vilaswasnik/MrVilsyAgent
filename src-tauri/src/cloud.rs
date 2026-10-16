// Optional cloud-escalation slot. OFF unless the user enables it and supplies their own key.
// The key lives in the Windows Credential Manager. The request is made here (the webview
// is not allowed to reach the internet) and only when the user triggers it for one question.
use keyring::Entry;
use serde::Serialize;

const SERVICE: &str = "MrVilsyAgent";
const KEY_NAME: &str = "cloud_api_key";
const MAX_PROMPT_CHARS: usize = 12_000;

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, KEY_NAME).map_err(|e| e.to_string())
}

fn read_key() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(v) if !v.is_empty() => Ok(Some(v)),
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn cloud_key_set(value: String) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() {
        return cloud_key_delete();
    }
    entry()?.set_password(value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cloud_key_delete() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn cloud_key_present() -> Result<bool, String> {
    Ok(read_key()?.is_some())
}

#[derive(Serialize)]
struct Msg<'a> {
    role: &'a str,
    content: &'a str,
}

// Only https endpoints; the key is never sent anywhere else.
fn check_url(base_url: &str) -> Result<String, String> {
    let url = base_url.trim().trim_end_matches('/');
    if !url.starts_with("https://") {
        return Err("The cloud endpoint must start with https://".into());
    }
    Ok(format!("{url}/chat/completions"))
}

// OpenAI-compatible chat completion with a single user message.
#[tauri::command]
pub async fn cloud_ask(base_url: String, model: String, prompt: String) -> Result<String, String> {
    let endpoint = check_url(&base_url)?;
    if model.trim().is_empty() {
        return Err("Choose a cloud model name in Settings first.".into());
    }
    let key = read_key()?.ok_or("No cloud API key is saved.")?;
    let prompt: String = prompt.chars().take(MAX_PROMPT_CHARS).collect();
    let body = serde_json::json!({ "model": model.trim(), "messages": [Msg { role: "user", content: &prompt }] });
    let response = reqwest::Client::new()
        .post(endpoint)
        .bearer_auth(key)
        .timeout(std::time::Duration::from_secs(120))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Could not reach the cloud service: {e}"))?;
    let status = response.status();
    let value: serde_json::Value = response.json().await.map_err(|e| format!("Unreadable cloud response: {e}"))?;
    if !status.is_success() {
        let detail = value["error"]["message"].as_str().unwrap_or("request failed");
        return Err(format!("Cloud service returned {status}: {detail}"));
    }
    value["choices"][0]["message"]["content"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "The cloud response had no answer.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_https_endpoints_are_allowed() {
        assert!(check_url("http://api.example.com/v1").is_err());
        assert!(check_url("file:///x").is_err());
        assert_eq!(check_url("https://api.example.com/v1/").unwrap(), "https://api.example.com/v1/chat/completions");
    }
}
