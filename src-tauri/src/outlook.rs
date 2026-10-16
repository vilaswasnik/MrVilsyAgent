//! Outlook / Microsoft 365 OAuth (PKCE, loopback redirect) + minimal Microsoft
//! Graph mail client. Mirrors `gmail.rs`'s security model:
//!
//! - We never see the user's Microsoft password. Authentication happens in
//!   the user's real system browser against Microsoft's own sign-in page.
//! - Scopes are limited to `Mail.Read` + `Mail.ReadWrite` (needed to create
//!   drafts). There is no send permission anywhere in this module; drafts
//!   are left for the user to review and send themselves from Outlook.
//! - The `consumers` tenant is used, matching personal Microsoft accounts
//!   (outlook.com / hotmail.com / live.com).

use serde::{Deserialize, Serialize};

const AUTH_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize";
const TOKEN_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const SCOPES: &str = "offline_access Mail.Read Mail.ReadWrite";

#[derive(Serialize, Deserialize, Clone)]
pub struct OutlookTokens {
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
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use rand::RngCore;
    use sha2::{Digest, Sha256};

    let mut bytes = [0u8; 64];
    rand::thread_rng().fill_bytes(&mut bytes);
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let challenge = URL_SAFE_NO_PAD.encode(hasher.finalize());
    (verifier, challenge)
}

/// Opens the user's system browser to Microsoft's real sign-in page (PKCE,
/// no client secret required) and waits for the single loopback redirect
/// that carries the authorization code, then exchanges it for tokens.
///
/// Note: the Azure app registration's redirect URI must be registered
/// exactly as `http://localhost` under the "Mobile and desktop applications"
/// platform — Microsoft matches that entry to any local port automatically
/// (RFC 8252 loopback redirect), so no port needs to be pre-registered.
#[tauri::command]
pub async fn outlook_connect(client_id: String) -> Result<OutlookTokens, String> {
    let listener = tiny_http::Server::http("127.0.0.1:0")
        .map_err(|e| format!("Could not start local OAuth listener: {e}"))?;
    let port = listener
        .server_addr()
        .to_ip()
        .ok_or_else(|| "Could not determine local listener port.".to_string())?
        .port();
    let redirect_uri = format!("http://localhost:{port}");

    let (verifier, challenge) = pkce_pair();

    let auth_url = format!(
        "{AUTH_URL}?client_id={client_id}&redirect_uri={redirect}&response_type=code&response_mode=query&scope={scope}&code_challenge={challenge}&code_challenge_method=S256",
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
            "<html><body style=\"font-family:sans-serif\"><h3>MrVilsyAgent connected to Outlook.</h3><p>You can close this window and return to the app.</p></body></html>"
        } else {
            "<html><body style=\"font-family:sans-serif\"><h3>Outlook connection failed or was cancelled.</h3><p>You can close this window and return to the app.</p></body></html>"
        };
        let response = tiny_http::Response::from_string(body).with_header(
            tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..])
                .expect("static header is valid"),
        );
        let _ = request.respond(response);

        if let Some(err) = error {
            return Err(format!("Microsoft returned an error: {err}"));
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
) -> Result<OutlookTokens, String> {
    let client = reqwest::Client::new();
    let params = [
        ("client_id", client_id),
        ("code", code),
        ("code_verifier", verifier),
        ("grant_type", "authorization_code"),
        ("redirect_uri", redirect_uri),
        ("scope", SCOPES),
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
        .json::<OutlookTokens>()
        .await
        .map_err(|e| format!("Could not parse token response: {e}"))
}

/// Exchanges a stored refresh token for a fresh access token.
#[tauri::command]
pub async fn outlook_refresh(client_id: String, refresh_token: String) -> Result<OutlookTokens, String> {
    let client = reqwest::Client::new();
    let params = [
        ("client_id", client_id.as_str()),
        ("refresh_token", refresh_token.as_str()),
        ("grant_type", "refresh_token"),
        ("scope", SCOPES),
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
    let mut tokens: OutlookTokens = response
        .json()
        .await
        .map_err(|e| format!("Could not parse refresh response: {e}"))?;
    if tokens.refresh_token.is_none() {
        tokens.refresh_token = Some(refresh_token);
    }
    Ok(tokens)
}

/// Searches the connected Outlook account using Graph's free-text `$search`
/// and returns lightweight summaries for the matching messages.
#[tauri::command]
pub async fn outlook_search(access_token: String, query: String) -> Result<Vec<EmailSummary>, String> {
    let client = reqwest::Client::new();
    let url = format!(
        "https://graph.microsoft.com/v1.0/me/messages?$search=\"{}\"&$top=15&$select=subject,from,receivedDateTime,bodyPreview",
        urlencoding::encode(&query)
    );
    let response = client
        .get(&url)
        .bearer_auth(&access_token)
        .header("ConsistencyLevel", "eventual")
        .send()
        .await
        .map_err(|e| format!("Outlook search request failed: {e}"))?;
    if !response.status().is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Outlook search failed: {text}"));
    }
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Could not parse Outlook search response: {e}"))?;
    let items = value["value"].as_array().cloned().unwrap_or_default();

    let summaries = items
        .into_iter()
        .map(|item| EmailSummary {
            id: item["id"].as_str().unwrap_or("").to_string(),
            subject: item["subject"].as_str().unwrap_or("").to_string(),
            from: item["from"]["emailAddress"]["address"]
                .as_str()
                .unwrap_or("")
                .to_string(),
            date: item["receivedDateTime"].as_str().unwrap_or("").to_string(),
            snippet: item["bodyPreview"].as_str().unwrap_or("").to_string(),
        })
        .collect();
    Ok(summaries)
}

/// Lists inbox messages received at or after `since_iso` (UTC, e.g.
/// `2026-10-16T14:00:00Z`), newest first. Read-only.
#[tauri::command]
pub async fn outlook_recent(access_token: String, since_iso: String, folder: Option<String>) -> Result<Vec<EmailSummary>, String> {
    if !since_iso.chars().all(|c| c.is_ascii_digit() || matches!(c, '-' | ':' | 'T' | 'Z' | '.')) {
        return Err("Invalid timestamp.".into());
    }
    // Only these well-known folders can be read; the value is never interpolated as given.
    let folder = match folder.as_deref().unwrap_or("inbox") {
        "inbox" => "inbox",
        "sent" => "sentitems",
        "junk" => "junkemail",
        _ => return Err("Unsupported mail folder.".into()),
    };
    let client = reqwest::Client::new();
    let url = format!(
        "https://graph.microsoft.com/v1.0/me/mailFolders/{folder}/messages?$filter=receivedDateTime%20ge%20{}&$orderby=receivedDateTime%20desc&$top=40&$select=subject,from,receivedDateTime,bodyPreview",
        since_iso
    );
    let response = client
        .get(&url)
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|e| format!("Outlook request failed: {e}"))?;
    if !response.status().is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Outlook inbox read failed: {text}"));
    }
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Could not parse Outlook response: {e}"))?;
    let items = value["value"].as_array().cloned().unwrap_or_default();
    Ok(items
        .into_iter()
        .map(|item| EmailSummary {
            id: item["id"].as_str().unwrap_or("").to_string(),
            subject: item["subject"].as_str().unwrap_or("").to_string(),
            from: item["from"]["emailAddress"]["address"].as_str().unwrap_or("").to_string(),
            date: item["receivedDateTime"].as_str().unwrap_or("").to_string(),
            snippet: item["bodyPreview"].as_str().unwrap_or("").to_string(),
        })
        .collect())
}

/// Fetches the full subject/sender/body of a single message as plain text.
#[tauri::command]
pub async fn outlook_get_message(access_token: String, id: String) -> Result<EmailDetail, String> {
    let client = reqwest::Client::new();
    let url = format!(
        "https://graph.microsoft.com/v1.0/me/messages/{id}?$select=subject,from,toRecipients,receivedDateTime,body"
    );
    let response = client
        .get(&url)
        .bearer_auth(&access_token)
        // Ask Graph to return the body as plain text instead of HTML.
        .header("Prefer", "outlook.body-content-type=\"text\"")
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
    let to = value["toRecipients"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|r| r["emailAddress"]["address"].as_str())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    Ok(EmailDetail {
        id,
        subject: value["subject"].as_str().unwrap_or("").to_string(),
        from: value["from"]["emailAddress"]["address"].as_str().unwrap_or("").to_string(),
        to,
        date: value["receivedDateTime"].as_str().unwrap_or("").to_string(),
        body: value["body"]["content"].as_str().unwrap_or("").to_string(),
    })
}

/// Creates a draft reply to `message_id` with the given body (never sends).
/// Microsoft Graph's `createReply` automatically fills in the correct
/// recipient, subject ("RE: ...") and thread headers.
#[tauri::command]
pub async fn outlook_create_draft(
    access_token: String,
    message_id: String,
    body: String,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let create_url = format!("https://graph.microsoft.com/v1.0/me/messages/{message_id}/createReply");
    let create_response = client
        .post(&create_url)
        .bearer_auth(&access_token)
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|e| format!("Failed to create draft: {e}"))?;
    if !create_response.status().is_success() {
        let text = create_response.text().await.unwrap_or_default();
        return Err(format!("Failed to create draft: {text}"));
    }
    let draft: serde_json::Value = create_response
        .json()
        .await
        .map_err(|e| format!("Could not parse draft response: {e}"))?;
    let draft_id = draft["id"].as_str().unwrap_or("").to_string();

    let patch_url = format!("https://graph.microsoft.com/v1.0/me/messages/{draft_id}");
    let patch_response = client
        .patch(&patch_url)
        .bearer_auth(&access_token)
        .json(&serde_json::json!({ "body": { "contentType": "Text", "content": body } }))
        .send()
        .await
        .map_err(|e| format!("Failed to set draft body: {e}"))?;
    if !patch_response.status().is_success() {
        let text = patch_response.text().await.unwrap_or_default();
        return Err(format!("Failed to set draft body: {text}"));
    }
    Ok(draft_id)
}
