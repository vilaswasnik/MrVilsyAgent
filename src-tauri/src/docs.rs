// Read-only access to folders the user explicitly picked. Nothing in this module writes
// to, renames, or deletes anything inside those folders. The only file it writes is its
// own index/config in the app data folder.
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

const MAX_FILE_BYTES: u64 = 60_000_000;
const MAX_TEXT_CHARS: usize = 3_000_000;
const MAX_FILES: usize = 3000;
const MAX_DEPTH: usize = 8;
const MAX_INDEX_BYTES: usize = 150_000_000;
const EXTENSIONS: [&str; 4] = ["pdf", "docx", "txt", "md"];

#[derive(Serialize)]
pub struct DocFile {
    path: String,
    name: String,
    size: u64,
    modified_ms: u64,
}

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn folders_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("doc_folders.json"))
}

fn index_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("doc_index.json"))
}

fn read_folders(app: &tauri::AppHandle) -> Vec<String> {
    folders_file(app)
        .ok()
        .and_then(|f| fs::read_to_string(f).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_folders(app: &tauri::AppHandle, folders: &[String]) -> Result<(), String> {
    let json = serde_json::to_string(folders).map_err(|e| e.to_string())?;
    fs::write(folders_file(app)?, json).map_err(|e| e.to_string())
}

fn is_supported(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

// A file may be read only if, after resolving symlinks and `..`, it sits inside a folder
// the user granted.
fn inside_granted(path: &Path, folders: &[String]) -> Result<PathBuf, String> {
    let canonical = path.canonicalize().map_err(|_| "That file does not exist.".to_string())?;
    for folder in folders {
        if let Ok(root) = Path::new(folder).canonicalize() {
            if canonical.starts_with(&root) {
                return Ok(canonical);
            }
        }
    }
    Err("That file is not inside a folder you granted access to.".into())
}

fn walk(dir: &Path, depth: usize, out: &mut Vec<DocFile>) {
    if depth > MAX_DEPTH || out.len() >= MAX_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if out.len() >= MAX_FILES {
            return;
        }
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else { continue };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            walk(&path, depth + 1, out);
        } else if meta.is_file() && is_supported(&path) && meta.len() <= MAX_FILE_BYTES {
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.push(DocFile {
                path: path.to_string_lossy().into_owned(),
                name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                size: meta.len(),
                modified_ms,
            });
        }
    }
}

fn decode_entities(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

// Pulls visible text out of word/document.xml: <w:t> runs, paragraph and line breaks.
fn docx_xml_to_text(xml: &str) -> String {
    let mut out = String::new();
    let mut rest = xml;
    while let Some(start) = rest.find('<') {
        let Some(end) = rest[start..].find('>') else { break };
        let tag = &rest[start + 1..start + end];
        let after = &rest[start + end + 1..];
        if tag == "w:t" || tag.starts_with("w:t ") {
            if tag.ends_with('/') {
                rest = after;
                continue;
            }
            let close = after.find("</w:t>").unwrap_or(after.len());
            out.push_str(&decode_entities(&after[..close]));
            rest = &after[close..];
            continue;
        }
        if tag == "/w:p" || tag.starts_with("w:br") {
            out.push('\n');
        } else if tag.starts_with("w:tab") && !tag.starts_with("w:tabs") {
            out.push('\t');
        }
        rest = after;
    }
    out
}

fn extract_docx(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| "Not a valid .docx file.".to_string())?;
    let mut xml = String::new();
    archive
        .by_name("word/document.xml")
        .map_err(|_| "The .docx has no document body.".to_string())?
        .take(80_000_000)
        .read_to_string(&mut xml)
        .map_err(|e| e.to_string())?;
    Ok(docx_xml_to_text(&xml))
}

fn extract_pdf(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    // Malformed PDFs can make the parser panic; treat that as an extraction failure.
    std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem_by_pages(&bytes))
        .map_err(|_| "This PDF could not be read.".to_string())?
        .map(|pages| pages.join("\u{c}"))
        .map_err(|e| format!("This PDF could not be read ({e})."))
}

fn extract_any(path: &Path) -> Result<String, String> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let mut text = match ext.as_str() {
        "pdf" => extract_pdf(path)?,
        "docx" => extract_docx(path)?,
        "txt" | "md" => {
            let bytes = fs::read(path).map_err(|e| e.to_string())?;
            String::from_utf8_lossy(&bytes).into_owned()
        }
        _ => return Err("Unsupported file type.".into()),
    };
    if text.chars().count() > MAX_TEXT_CHARS {
        text = text.chars().take(MAX_TEXT_CHARS).collect();
    }
    Ok(text)
}

#[tauri::command]
pub fn docs_folders(app: tauri::AppHandle) -> Vec<String> {
    read_folders(&app)
}

// The folder can only be granted through this native picker, so the model can never
// grant itself access to a path.
#[tauri::command]
pub async fn docs_add_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let Some(handle) = rfd::AsyncFileDialog::new().set_title("Choose a folder the agent may READ").pick_folder().await else {
        return Ok(None);
    };
    let path = handle.path().canonicalize().map_err(|e| e.to_string())?.to_string_lossy().into_owned();
    let mut folders = read_folders(&app);
    if !folders.contains(&path) {
        folders.push(path.clone());
        write_folders(&app, &folders)?;
    }
    Ok(Some(path))
}

#[tauri::command]
pub fn docs_remove_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let folders: Vec<String> = read_folders(&app).into_iter().filter(|f| *f != path).collect();
    write_folders(&app, &folders)
}

#[tauri::command]
pub fn docs_scan(app: tauri::AppHandle) -> Vec<DocFile> {
    let mut out = Vec::new();
    for folder in read_folders(&app) {
        walk(Path::new(&folder), 0, &mut out);
    }
    out
}

#[tauri::command]
pub async fn docs_extract(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let folders = read_folders(&app);
    let canonical = inside_granted(Path::new(&path), &folders)?;
    if !is_supported(&canonical) {
        return Err("Unsupported file type.".into());
    }
    tauri::async_runtime::spawn_blocking(move || extract_any(&canonical))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn docs_index_load(app: tauri::AppHandle) -> Result<String, String> {
    let file = index_file(&app)?;
    Ok(fs::read_to_string(file).unwrap_or_default())
}

#[tauri::command]
pub fn docs_index_save(app: tauri::AppHandle, json: String) -> Result<(), String> {
    if json.len() > MAX_INDEX_BYTES {
        return Err("The document index is too large. Remove a folder or index fewer documents.".into());
    }
    fs::write(index_file(&app)?, json).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mrvilsy-docs-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn extracts_text_from_docx() {
        let dir = temp_dir("docx");
        let path = dir.join("a.docx");
        let file = fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("word/document.xml", zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(
            b"<w:document><w:body><w:p><w:r><w:t>Valid from</w:t></w:r><w:r><w:t xml:space=\"preserve\"> 10/01/2024 &amp; later</w:t></w:r></w:p><w:p><w:r><w:t>Second line</w:t></w:r></w:p></w:body></w:document>",
        )
        .unwrap();
        zip.finish().unwrap();
        let text = extract_any(&path).unwrap();
        assert_eq!(text, "Valid from 10/01/2024 & later\nSecond line\n");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn extracts_text_from_pdf() {
        let dir = temp_dir("pdf");
        let path = dir.join("a.pdf");
        let stream = "BT /F1 12 Tf 72 720 Td (Notice valid until 09/30/2027) Tj ET";
        let objects = [
            "<</Type/Catalog/Pages 2 0 R>>".to_string(),
            "<</Type/Pages/Kids[3 0 R]/Count 1>>".to_string(),
            "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>".to_string(),
            format!("<</Length {}>>\nstream\n{}\nendstream", stream.len(), stream),
            "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>".to_string(),
        ];
        let mut pdf = String::from("%PDF-1.4\n");
        let mut offsets = Vec::new();
        for (i, body) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.push_str(&format!("{} 0 obj\n{}\nendobj\n", i + 1, body));
        }
        let xref_at = pdf.len();
        pdf.push_str(&format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1));
        for offset in &offsets {
            pdf.push_str(&format!("{:010} 00000 n \n", offset));
        }
        pdf.push_str(&format!("trailer\n<</Root 1 0 R/Size {}>>\nstartxref\n{}\n%%EOF", objects.len() + 1, xref_at));
        fs::write(&path, pdf).unwrap();
        let text = extract_any(&path).unwrap();
        assert!(text.contains("09/30/2027"), "got: {text:?}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn reads_only_inside_granted_folders() {
        let granted = temp_dir("granted");
        let other = temp_dir("other");
        fs::write(granted.join("ok.txt"), "hello").unwrap();
        fs::write(other.join("secret.txt"), "nope").unwrap();
        let folders = vec![granted.to_string_lossy().into_owned()];
        assert!(inside_granted(&granted.join("ok.txt"), &folders).is_ok());
        assert!(inside_granted(&other.join("secret.txt"), &folders).is_err());
        let sneaky = granted.join("..").join(other.file_name().unwrap()).join("secret.txt");
        assert!(inside_granted(&sneaky, &folders).is_err());
        let _ = fs::remove_dir_all(granted);
        let _ = fs::remove_dir_all(other);
    }

    #[test]
    fn scan_lists_only_supported_files() {
        let dir = temp_dir("scan");
        fs::write(dir.join("a.txt"), "x").unwrap();
        fs::write(dir.join("b.exe"), "x").unwrap();
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub").join("c.md"), "x").unwrap();
        let mut out = Vec::new();
        walk(&dir, 0, &mut out);
        let mut names: Vec<_> = out.iter().map(|f| f.name.clone()).collect();
        names.sort();
        assert_eq!(names, vec!["a.txt", "c.md"]);
        let _ = fs::remove_dir_all(dir);
    }
}
