//! Gmail OAuth (PKCE, loopback redirect) + minimal Gmail API client.
//!
//! Security notes:
//! - We never see the user's Gmail password. Authentication happens in the
//!   user's real system browser against Google's own login page.
//! - Scopes are limited to read + compose (draft creation). Sending email is
//!   intentionally NOT implemented; drafts are left for the user to review
//!   and send themselves from Gmail.
//! - Tokens are returned to the frontend, which is responsible for storing
//!   them (currently in this app's local settings) and must treat them like
//!   a password: they grant access to the connected Gmail account until
//!   revoked from https://myaccount.google.com/permissions.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const SCOPES: &str = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose";

#[derive(Serialize, Deserialize, Clone)]
pub struct GmailTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: u64,
}

#[derive(Serialize)]
pub struct EmailSummary {
    pub id: String,
    pub subject: String,
    pub from: String,
    pub date: String,
    pub snippet: String,
}

#[derive(Serialize)]
pub struct EmailDetail {
    pub id: String,
    pub subject: String,
    pub from: String,
    pub to: String,
    pub date: String,
    pub body: String,
}

fn pkce_pair() -> (String, String) {
    use rand::RngCore;
    let mut bytes = [0u8; 64];
    rand::thread_rng().fill_bytes(&mut bytes);
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let challenge = URL_SAFE_NO_PAD.encode(hasher.finalize());
    (verifier, challenge)
}

/// Opens the user's system browser to Google's real sign-in page (PKCE, no
/// client secret required) and waits for the single loopback redirect that
/// carries the authorization code, then exchanges it for tokens.
#[tauri::command]
pub async fn gmail_connect(client_id: String) -> Result<GmailTokens, String> {
    let listener = tiny_http::Server::http("127.0.0.1:0")
        .map_err(|e| format!("Could not start local OAuth listener: {e}"))?;
    let port = listener
        .server_addr()
        .to_ip()
        .ok_or_else(|| "Could not determine local listener port.".to_string())?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    let (verifier, challenge) = pkce_pair();

    let auth_url = format!(
        "{AUTH_URL}?client_id={client_id}&redirect_uri={redirect}&response_type=code&scope={scope}&code_challenge={challenge}&code_challenge_method=S256&access_type=offline&prompt=consent",
        client_id = urlencoding::encode(&client_id),
        redirect = urlencoding::encode(&redirect_uri),
        scope = urlencoding::encode(SCOPES),
    );

    open::that(&auth_url).map_err(|e| format!("Failed to open your browser: {e}"))?;

    let code = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let request = listener
            .recv()
            .map_err(|e| format!("OAuth callback failed: {e}"))?;
        let url = request.url().to_string();
        let query = url.splitn(2, '?').nth(1).unwrap_or("");

        let mut code = None;
        let mut error = None;
        for pair in query.split('&') {
            let mut kv = pair.splitn(2, '=');
            let key = kv.next().unwrap_or("");
            let raw_value = kv.next().unwrap_or("");
            let value = urlencoding::decode(raw_value)
                .map(|c| c.into_owned())
                .unwrap_or_default();
            match key {
                "code" => code = Some(value),
                "error" => error = Some(value),
                _ => {}
            }
        }

        let body = if code.is_some() {
            "<html><body style=\"font-family:sans-serif\"><h3>MrVilsyAgent connected to Gmail.</h3><p>You can close this window and return to the app.</p></body></html>"
        } else {
            "<html><body style=\"font-family:sans-serif\"><h3>Gmail connection failed or was cancelled.</h3><p>You can close this window and return to the app.</p></body></html>"
        };
        let response = tiny_http::Response::from_string(body).with_header(
            tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..])
                .expect("static header is valid"),
        );
        let _ = request.respond(response);

        if let Some(err) = error {
            return Err(format!("Google returned an error: {err}"));
        }
        code.ok_or_else(|| "No authorization code was received.".to_string())
    })
    .await
    .map_err(|e| format!("OAuth listener task failed: {e}"))??;

    exchange_code(&client_id, &code, &verifier, &redirect_uri).await
}

async fn exchange_code(
    client_id: &str,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<GmailTokens, String> {
    let client = reqwest::Client::new();
    let params = [
        ("client_id", client_id),
        ("code", code),
        ("code_verifier", verifier),
        ("grant_type", "authorization_code"),
        ("redirect_uri", redirect_uri),
    ];
    let response = client
        .post(TOKEN_URL)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token exchange request failed: {e}"))?;
    if !response.status().is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Token exchange failed: {text}"));
    }
    response
        .json::<GmailTokens>()
        .await
        .map_err(|e| format!("Could not parse token response: {e}"))
}

/// Exchanges a stored refresh token for a fresh access token.
#[tauri::command]
pub async fn gmail_refresh(client_id: String, refresh_token: String) -> Result<GmailTokens, String> {
    let client = reqwest::Client::new();
    let params = [
        ("client_id", client_id.as_str()),
        ("refresh_token", refresh_token.as_str()),
        ("grant_type", "refresh_token"),
    ];
    let response = client
        .post(TOKEN_URL)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token refresh request failed: {e}"))?;
    if !response.status().is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Token refresh failed: {text}"));
    }
    let mut tokens: GmailTokens = response
        .json()
        .await
        .map_err(|e| format!("Could not parse refresh response: {e}"))?;
    // Google omits refresh_token on refresh responses; keep the original.
    if tokens.refresh_token.is_none() {
        tokens.refresh_token = Some(refresh_token);
    }
    Ok(tokens)
}

fn header_value(headers: &[serde_json::Value], name: &str) -> String {
    headers
        .iter()
        .find(|h| h["name"].as_str() == Some(name))
        .and_then(|h| h["value"].as_str())
        .unwrap_or("")
        .to_string()
}

fn extract_plain_text(payload: &serde_json::Value) -> Option<String> {
    let mime = payload["mimeType"].as_str().unwrap_or("");
    if mime.starts_with("text/plain") {
        if let Some(data) = payload["body"]["data"].as_str() {
            if let Ok(bytes) = URL_SAFE_NO_PAD.decode(data) {
                if let Ok(text) = String::from_utf8(bytes) {
                    return Some(text);
                }
            }
        }
    }
    if let Some(parts) = payload["parts"].as_array() {
        for part in parts {
            if let Some(text) = extract_plain_text(part) {
                return Some(text);
            }
        }
    }
    None
}

/// Searches the connected Gmail account (Gmail search syntax, e.g.
/// `newer_than:3d` or `from:someone@example.com`) and returns lightweight
/// summaries for the matching messages.
#[tauri::command]
pub async fn gmail_search(access_token: String, query: String) -> Result<Vec<EmailSummary>, String> {
    let client = reqwest::Client::new();
    let list_url = format!(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages?q={}&maxResults=15",
        urlencoding::encode(&query)
    );
    let list_response = client
        .get(&list_url)
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|e| format!("Gmail search request failed: {e}"))?;
    if !list_response.status().is_success() {
        let text = list_response.text().await.unwrap_or_default();
        return Err(format!("Gmail search failed: {text}"));
    }
    let list: serde_json::Value = list_response
        .json()
        .await
        .map_err(|e| format!("Could not parse Gmail search response: {e}"))?;
    let ids = list["messages"].as_array().cloned().unwrap_or_default();

    let mut summaries = Vec::with_capacity(ids.len());
    for entry in ids {
        let Some(id) = entry["id"].as_str() else { continue };
        let detail_url = format!(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date"
        );
        let Ok(detail_response) = client.get(&detail_url).bearer_auth(&access_token).send().await else {
            continue;
        };
        if !detail_response.status().is_success() {
            continue;
        }
        let Ok(value) = detail_response.json::<serde_json::Value>().await else {
            continue;
        };
        let headers = value["payload"]["headers"].as_array().cloned().unwrap_or_default();
        summaries.push(EmailSummary {
            id: id.to_string(),
            subject: header_value(&headers, "Subject"),
            from: header_value(&headers, "From"),
            date: header_value(&headers, "Date"),
            snippet: value["snippet"].as_str().unwrap_or("").to_string(),
        });
    }
    Ok(summaries)
}

/// Fetches the full subject/sender/body of a single message.
#[tauri::command]
pub async fn gmail_get_message(access_token: String, id: String) -> Result<EmailDetail, String> {
    let client = reqwest::Client::new();
    let url = format!("https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}?format=full");
    let response = client
        .get(&url)
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|e| format!("Failed to load message: {e}"))?;
    if !response.status().is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Failed to load message: {text}"));
    }
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Could not parse message response: {e}"))?;
    let headers = value["payload"]["headers"].as_array().cloned().unwrap_or_default();
    let body = extract_plain_text(&value["payload"])
        .unwrap_or_else(|| value["snippet"].as_str().unwrap_or("").to_string());
    Ok(EmailDetail {
        id,
        subject: header_value(&headers, "Subject"),
        from: header_value(&headers, "From"),
        to: header_value(&headers, "To"),
        date: header_value(&headers, "Date"),
        body,
    })
}

/// Creates a Gmail draft (never sends). The user reviews and sends it
/// themselves from Gmail.
#[tauri::command]
pub async fn gmail_create_draft(
    access_token: String,
    to: String,
    subject: String,
    body: String,
    thread_id: Option<String>,
) -> Result<String, String> {
    let raw_message = format!(
        "To: {to}\r\nSubject: {subject}\r\nContent-Type: text/plain; charset=\"UTF-8\"\r\n\r\n{body}"
    );
    let encoded = URL_SAFE_NO_PAD.encode(raw_message.as_bytes());

    let mut message = serde_json::json!({ "raw": encoded });
    if let Some(tid) = thread_id {
        message["threadId"] = serde_json::json!(tid);
    }
    let payload = serde_json::json!({ "message": message });

    let client = reqwest::Client::new();
    let response = client
        .post("https://gmail.googleapis.com/gmail/v1/users/me/drafts")
        .bearer_auth(&access_token)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed to create draft: {e}"))?;
    if !response.status().is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Failed to create draft: {text}"));
    }
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Could not parse draft response: {e}"))?;
    Ok(value["id"].as_str().unwrap_or("").to_string())
}
