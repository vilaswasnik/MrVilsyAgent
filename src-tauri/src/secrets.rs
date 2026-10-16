// Stores OAuth refresh tokens in the Windows Credential Manager (DPAPI-protected),
// never in files. Values are split into chunks because a credential blob is small.
use keyring::Entry;

const SERVICE: &str = "MrVilsyAgent";
const CHUNK_CHARS: usize = 800;
const MAX_CHUNKS: usize = 32;
const ALLOWED_KEYS: [&str; 2] = ["gmail_refresh_token", "outlook_refresh_token"];

fn check_key(key: &str) -> Result<(), String> {
    if ALLOWED_KEYS.contains(&key) {
        Ok(())
    } else {
        Err("Unknown secret name.".into())
    }
}

fn entry(name: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, name).map_err(|e| e.to_string())
}

fn read_entry(name: &str) -> Result<Option<String>, String> {
    match entry(name)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn clear(key: &str) -> Result<(), String> {
    let count = read_entry(key)?.and_then(|v| v.parse::<usize>().ok()).unwrap_or(0).min(MAX_CHUNKS);
    for index in 0..count {
        match entry(&format!("{key}.{index}"))?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    match entry(key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn store(key: &str, value: &str) -> Result<(), String> {
    clear(key)?;
    if value.is_empty() {
        return Ok(());
    }
    let chars: Vec<char> = value.chars().collect();
    let chunks: Vec<String> = chars.chunks(CHUNK_CHARS).map(|c| c.iter().collect()).collect();
    if chunks.len() > MAX_CHUNKS {
        return Err("Secret is too large.".into());
    }
    for (index, chunk) in chunks.iter().enumerate() {
        entry(&format!("{key}.{index}"))?.set_password(chunk).map_err(|e| e.to_string())?;
    }
    entry(key)?.set_password(&chunks.len().to_string()).map_err(|e| e.to_string())
}

fn load(key: &str) -> Result<String, String> {
    let Some(count) = read_entry(key)?.and_then(|v| v.parse::<usize>().ok()) else {
        return Ok(String::new());
    };
    let mut out = String::new();
    for index in 0..count.min(MAX_CHUNKS) {
        out.push_str(&read_entry(&format!("{key}.{index}"))?.ok_or("Stored secret is incomplete.")?);
    }
    Ok(out)
}

#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    check_key(&key)?;
    store(&key, &value)
}

#[tauri::command]
pub fn secret_get(key: String) -> Result<String, String> {
    check_key(&key)?;
    load(&key)
}

#[tauri::command]
pub fn secret_delete(key: String) -> Result<(), String> {
    check_key(&key)?;
    clear(&key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_long_values_through_credential_manager() {
        let key = format!("test_tmp_{}", std::process::id());
        let value: String = (0..3000).map(|i| char::from(b'a' + (i % 26) as u8)).collect();
        store(&key, &value).unwrap();
        assert_eq!(load(&key).unwrap(), value);
        clear(&key).unwrap();
        assert_eq!(load(&key).unwrap(), "");
    }

    #[test]
    fn rejects_unknown_key_names() {
        assert!(secret_get("something_else".into()).is_err());
    }
}
