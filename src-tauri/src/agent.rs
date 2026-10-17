use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

const MAX_READ_BYTES: u64 = 500_000;
const MAX_WRITE_BYTES: usize = 500_000;
const ALLOWED_EXTENSIONS: [&str; 5] = ["md", "txt", "json", "csv", "yaml"];

const MEMORY_TEMPLATE: &str = "# MEMORY\n\nDurable facts, preferences, people and standing rules. The agent reads this at the start of every session.\n\n## About me\n\n## People\n\n## Standing rules\n";

const SKILLS: [(&str, &str); 2] = [
    (
        "skills/triage-recruiter-email.md",
        "# Triage a recruiter email\n\n1. Read the full message (not just the preview).\n2. Note company, role, location, pay, and any deadline.\n3. Check MEMORY.md for current priorities and anything I said I would not do.\n4. Summarize in three lines and say whether it matches my priorities.\n5. If a reply is warranted, draft it on the original thread and wait for my approval.\n",
    ),
    (
        "skills/tailor-resume.md",
        "# Tailor a resume\n\n1. Read the job description and my saved profile in MEMORY.md.\n2. List the requirements I genuinely meet. Never claim skills or experience I do not have.\n3. Propose edits to wording and ordering only.\n4. Show the exact proposed text for my approval before saving anything.\n",
    ),
];

#[derive(Serialize)]
pub struct WorkspaceInfo {
    path: String,
    initialized: bool,
}

#[derive(Serialize)]
pub struct WorkspaceEntry {
    path: String,
    size: u64,
}

#[derive(Serialize)]
pub struct SearchHit {
    path: String,
    line: usize,
    text: String,
}

fn workspace_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("agent"))
}

fn has_allowed_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| ALLOWED_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

// Resolves a relative path inside the workspace. Rejects absolute paths,
// parent traversal, drive prefixes and anything that escapes via symlinks.
fn resolve(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.trim().is_empty() {
        return Err("A file path is required.".into());
    }
    let rel = Path::new(relative);
    for component in rel.components() {
        match component {
            Component::Normal(name) => {
                if name.to_string_lossy().contains(':') {
                    return Err("Invalid path.".into());
                }
            }
            _ => return Err("Paths must be relative to the agent workspace (no .. or drive letters).".into()),
        }
    }
    if !has_allowed_extension(rel) {
        return Err(format!("Only {} files are allowed in the agent workspace.", ALLOWED_EXTENSIONS.join(", ")));
    }
    let full = root.join(rel);
    let canonical_root = root.canonicalize().map_err(|_| "The agent workspace has not been set up yet.".to_string())?;
    let mut probe = full.as_path();
    while !probe.exists() {
        probe = probe.parent().ok_or("Invalid path.")?;
    }
    let canonical_probe = probe.canonicalize().map_err(|e| e.to_string())?;
    if !canonical_probe.starts_with(&canonical_root) {
        return Err("Path escapes the agent workspace.".into());
    }
    Ok(full)
}

fn collect_files(root: &Path, dir: &Path, out: &mut Vec<WorkspaceEntry>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            collect_files(root, &path, out);
        } else if has_allowed_extension(&path) {
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(WorkspaceEntry { path: rel.to_string_lossy().replace('\\', "/"), size: meta.len() });
            }
        }
    }
}

#[tauri::command]
pub fn agent_workspace_info(app: tauri::AppHandle) -> Result<WorkspaceInfo, String> {
    let root = workspace_root(&app)?;
    Ok(WorkspaceInfo { path: root.to_string_lossy().into_owned(), initialized: root.join("MEMORY.md").exists() })
}

// Only called from an explicit user click. Never overwrites existing files.
#[tauri::command]
pub fn agent_workspace_init(app: tauri::AppHandle) -> Result<WorkspaceInfo, String> {
    let root = workspace_root(&app)?;
    fs::create_dir_all(root.join("memory")).map_err(|e| e.to_string())?;
    fs::create_dir_all(root.join("skills")).map_err(|e| e.to_string())?;
    let memory = root.join("MEMORY.md");
    if !memory.exists() {
        fs::write(&memory, MEMORY_TEMPLATE).map_err(|e| e.to_string())?;
    }
    for (rel, body) in SKILLS {
        let target = root.join(rel);
        if !target.exists() {
            fs::write(&target, body).map_err(|e| e.to_string())?;
        }
    }
    agent_workspace_info(app)
}

#[tauri::command]
pub fn agent_list(app: tauri::AppHandle) -> Result<Vec<WorkspaceEntry>, String> {
    let root = workspace_root(&app)?;
    let mut out = Vec::new();
    if root.exists() {
        collect_files(&root, &root, &mut out);
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

#[tauri::command]
pub fn agent_read(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let root = workspace_root(&app)?;
    let full = resolve(&root, &path)?;
    let meta = fs::metadata(&full).map_err(|_| format!("{path} does not exist."))?;
    if meta.len() > MAX_READ_BYTES {
        return Err("File is larger than 500 KB.".into());
    }
    fs::read_to_string(&full).map_err(|e| e.to_string())
}

// Called only after the user approved the exact action in the UI.
#[tauri::command]
pub fn agent_write(app: tauri::AppHandle, path: String, content: String, append: bool) -> Result<(), String> {
    if content.len() > MAX_WRITE_BYTES {
        return Err("Content is larger than 500 KB.".into());
    }
    let root = workspace_root(&app)?;
    let full = resolve(&root, &path)?;
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        // Re-check after directory creation so a new directory can't point outside.
        resolve(&root, &path)?;
    }
    if append {
        use std::io::Write;
        let mut file = fs::OpenOptions::new().create(true).append(true).open(&full).map_err(|e| e.to_string())?;
        file.write_all(content.as_bytes()).map_err(|e| e.to_string())
    } else {
        fs::write(&full, content).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn agent_search(app: tauri::AppHandle, query: String) -> Result<Vec<SearchHit>, String> {
    let terms: Vec<String> = query.split_whitespace().map(|t| t.to_lowercase()).filter(|t| t.len() > 1).collect();
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let root = workspace_root(&app)?;
    let mut files = Vec::new();
    if root.exists() {
        collect_files(&root, &root, &mut files);
    }
    let mut scored: Vec<(usize, SearchHit)> = Vec::new();
    for entry in files {
        let Ok(text) = fs::read_to_string(root.join(&entry.path)) else { continue };
        for (index, line) in text.lines().enumerate() {
            let lower = line.to_lowercase();
            let score = terms.iter().filter(|t| lower.contains(t.as_str())).count();
            if score > 0 {
                scored.push((score, SearchHit { path: entry.path.clone(), line: index + 1, text: line.trim().chars().take(300).collect() }));
            }
        }
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(scored.into_iter().take(20).map(|(_, hit)| hit).collect())
}

#[tauri::command]
pub fn agent_open_folder(app: tauri::AppHandle) -> Result<(), String> {
    let root = workspace_root(&app)?;
    if !root.exists() {
        return Err("The agent workspace has not been set up yet.".into());
    }
    open::that(root).map_err(|e| e.to_string())
}

fn backup_destination(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().document_dir().map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(dir.join(format!("MrVilsyAgent-backup-{stamp}.zip")))
}

fn write_backup(root: &Path, dest: &Path, settings_json: &str) -> Result<usize, String> {
    use std::io::Write;
    let mut files = Vec::new();
    collect_files(root, root, &mut files);
    let file = fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut count = 0;
    for entry in &files {
        let full = resolve(root, &entry.path)?;
        let bytes = fs::read(full).map_err(|e| e.to_string())?;
        zip.start_file(format!("workspace/{}", entry.path.replace('\\', "/")), options).map_err(|e| e.to_string())?;
        zip.write_all(&bytes).map_err(|e| e.to_string())?;
        count += 1;
    }
    zip.start_file("settings.json", options).map_err(|e| e.to_string())?;
    zip.write_all(settings_json.as_bytes()).map_err(|e| e.to_string())?;
    zip.finish().map_err(|e| e.to_string())?;
    Ok(count)
}

// Shows the user exactly where a backup would be written before they confirm.
#[tauri::command]
pub fn agent_backup_target(app: tauri::AppHandle) -> Result<String, String> {
    Ok(backup_destination(&app)?.to_string_lossy().into_owned())
}

// `settings_json` is prepared by the UI and must not contain tokens.
#[tauri::command]
pub fn agent_backup(app: tauri::AppHandle, destination: String, settings_json: String) -> Result<String, String> {
    let root = workspace_root(&app)?;
    if !root.exists() {
        return Err("The agent workspace has not been set up yet.".into());
    }
    let expected = backup_destination(&app)?;
    let dest = PathBuf::from(&destination);
    if dest.parent() != expected.parent() || dest.extension().and_then(|e| e.to_str()) != Some("zip") || dest.exists() {
        return Err("Backups can only be saved as a new .zip in your Documents folder.".into());
    }
    write_backup(&root, &dest, &settings_json)?;
    Ok(destination)
}

static RESTORE_SOURCE: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);
const MAX_RESTORE_ENTRY: u64 = 10_000_000;

#[derive(Serialize)]
pub struct RestorePreview {
    pub file: String,
    pub files: usize,
    pub overwrites: usize,
    pub has_settings: bool,
}

// Validates every entry the same way as normal workspace access; nothing is written here.
fn inspect_backup(root: &Path, zip_path: &Path) -> Result<(Vec<String>, bool), String> {
    let mut archive = zip::ZipArchive::new(fs::File::open(zip_path).map_err(|e| e.to_string())?).map_err(|_| "That is not a valid backup zip.".to_string())?;
    let mut names = Vec::new();
    let mut has_settings = false;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().replace('\\', "/");
        if name == "settings.json" {
            has_settings = true;
        } else if let Some(rel) = name.strip_prefix("workspace/") {
            resolve(root, rel).map_err(|e| format!("Backup rejected ({rel}): {e}"))?;
            if entry.size() > MAX_RESTORE_ENTRY {
                return Err(format!("Backup rejected: {rel} is too large."));
            }
            names.push(rel.to_string());
        }
    }
    if names.is_empty() {
        return Err("This zip has no workspace files. Choose a MrVilsyAgent backup.".into());
    }
    Ok((names, has_settings))
}

fn apply_backup(root: &Path, zip_path: &Path) -> Result<(usize, Option<String>), String> {
    use std::io::Read;
    let (names, _) = inspect_backup(root, zip_path)?;
    let mut archive = zip::ZipArchive::new(fs::File::open(zip_path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    for rel in &names {
        let mut entry = archive.by_name(&format!("workspace/{rel}")).map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        entry.by_ref().take(MAX_RESTORE_ENTRY + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        let full = resolve(root, rel)?;
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(full, bytes).map_err(|e| e.to_string())?;
    }
    let settings = archive.by_name("settings.json").ok().and_then(|mut f| {
        let mut text = String::new();
        f.read_to_string(&mut text).ok().map(|_| text)
    });
    Ok((names.len(), settings))
}

// Step 1: the user picks a backup; nothing is changed yet.
#[tauri::command]
pub async fn agent_restore_pick(app: tauri::AppHandle) -> Result<Option<RestorePreview>, String> {
    let root = workspace_root(&app)?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let Some(handle) = rfd::AsyncFileDialog::new().set_title("Choose a MrVilsyAgent backup").add_filter("Backup", &["zip"]).pick_file().await else {
        return Ok(None);
    };
    let path = handle.path().to_path_buf();
    let (names, has_settings) = inspect_backup(&root, &path)?;
    let overwrites = names.iter().filter(|rel| resolve(&root, rel).map(|p| p.exists()).unwrap_or(false)).count();
    *RESTORE_SOURCE.lock().unwrap() = Some(path.clone());
    Ok(Some(RestorePreview { file: path.to_string_lossy().into_owned(), files: names.len(), overwrites, has_settings }))
}

// Step 2: runs only after the user confirmed the preview. Files in the backup replace files
// with the same name; files that are not in the backup are left alone.
#[tauri::command]
pub fn agent_restore_apply(app: tauri::AppHandle) -> Result<(usize, Option<String>), String> {
    let root = workspace_root(&app)?;
    let path = RESTORE_SOURCE.lock().unwrap().take().ok_or("Choose a backup first.")?;
    apply_backup(&root, &path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_restores_into_a_clean_workspace() {
        let src = temp_root("restore-src");
        fs::create_dir_all(src.join("state")).unwrap();
        fs::write(src.join("MEMORY.md"), "my facts").unwrap();
        fs::write(src.join("state").join("applications.md"), "| tracker |").unwrap();
        let zip_path = src.parent().unwrap().join(format!("mrvilsy-restore-test-{}.zip", std::process::id()));
        write_backup(&src, &zip_path, "{\"jobs\":[1]}").unwrap();

        let clean = temp_root("restore-dst");
        let (count, settings) = apply_backup(&clean, &zip_path).unwrap();
        assert_eq!(count, 2);
        assert_eq!(fs::read_to_string(clean.join("MEMORY.md")).unwrap(), "my facts");
        assert_eq!(fs::read_to_string(clean.join("state").join("applications.md")).unwrap(), "| tracker |");
        assert_eq!(settings.unwrap(), "{\"jobs\":[1]}");
        let _ = fs::remove_file(zip_path);
    }

    #[test]
    fn restore_rejects_zips_that_escape_the_workspace() {
        use std::io::Write;
        let root = temp_root("restore-evil");
        let zip_path = root.parent().unwrap().join(format!("mrvilsy-evil-test-{}.zip", std::process::id()));
        let mut zip = zip::ZipWriter::new(fs::File::create(&zip_path).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("workspace/../evil.md", options).unwrap();
        zip.write_all(b"x").unwrap();
        zip.finish().unwrap();
        assert!(apply_backup(&root, &zip_path).is_err());
        assert!(!root.parent().unwrap().join("evil.md").exists());
        let _ = fs::remove_file(zip_path);
    }

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("mrvilsy-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("memory")).unwrap();
        root
    }

    #[test]
    fn backup_contains_workspace_and_settings() {
        let root = temp_root("backup");
        fs::write(root.join("MEMORY.md"), "fact").unwrap();
        fs::write(root.join("memory").join("2026-01-01.md"), "note").unwrap();
        let dest = root.parent().unwrap().join(format!("mrvilsy-backup-test-{}.zip", std::process::id()));
        let count = write_backup(&root, &dest, "{\"model\":\"x\"}").unwrap();
        assert_eq!(count, 2);
        let mut archive = zip::ZipArchive::new(fs::File::open(&dest).unwrap()).unwrap();
        let names: Vec<String> = (0..archive.len()).map(|i| archive.by_index(i).unwrap().name().to_string()).collect();
        assert!(names.contains(&"workspace/MEMORY.md".to_string()));
        assert!(names.contains(&"workspace/memory/2026-01-01.md".to_string()));
        assert!(names.contains(&"settings.json".to_string()));
        let _ = fs::remove_file(dest);
    }

    #[test]
    fn accepts_files_inside_workspace() {
        let root = temp_root("ok");
        assert!(resolve(&root, "MEMORY.md").is_ok());
        assert!(resolve(&root, "memory/2026-10-17.md").is_ok());
        assert!(resolve(&root, "new-dir/notes.txt").is_ok());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_escapes_and_bad_types() {
        let root = temp_root("bad");
        assert!(resolve(&root, "../secret.md").is_err());
        assert!(resolve(&root, "memory/../../secret.md").is_err());
        assert!(resolve(&root, "C:\\Windows\\win.ini").is_err());
        assert!(resolve(&root, "/etc/passwd").is_err());
        assert!(resolve(&root, "C:evil.md").is_err());
        assert!(resolve(&root, "run.ps1").is_err());
        assert!(resolve(&root, "").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn requires_setup_before_use() {
        let root = std::env::temp_dir().join("mrvilsy-test-missing-root-xyz");
        let _ = fs::remove_dir_all(&root);
        assert!(resolve(&root, "MEMORY.md").is_err());
    }
}
