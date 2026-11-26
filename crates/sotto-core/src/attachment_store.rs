//! The attachments this host keeps for drafts and sends (ADR-0031, ADR-0131), in Node's `AttachmentStore` layout
//! (`src/main/agents/attachmentStore.ts`) in the same data folder, so a rollback to Node finds every file this host kept.
//!
//! Each distinct content is one file in `attachments/`, named by its SHA-256: `<digest>.<png|jpg|gif|webp>` for an image,
//! `<digest>.bin` for any other file, beside `attachments/index.json`, which names each content's digest, type, size and
//! staging time and nothing else. A video's parts on their way here are written to `attachments/uploads/<uuid>.part` and
//! moved in once they check out. What Node kept before this host started is read from its index; a part file a stopped
//! host left behind is removed at start, as Node's `load` removes it. Handles, which name the content a draft or a send
//! carries, are this run's: a handle's ID finds its entry here.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::protocol_fields::{is_digest, utf16_len, whole_number};
use crate::workspace::{sha256_hex, write_atomic_json};

pub const MAX_IMAGE_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_FILE_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;
pub const MAX_VIDEO_ATTACHMENT_BYTES: usize = 500 * 1024 * 1024;

/// The folder under the data folder Node's store keeps content in, its index, and where a video's parts are written.
const FOLDER: &str = "attachments";
const INDEX_FILE: &str = "index.json";
const UPLOADS: &str = "uploads";
/// The image types the store keeps, by the extension its file of each has (`EXTENSIONS` in Node's store).
const IMAGE_EXTENSIONS: [(&str, &str); 4] =
    [("image/png", "png"), ("image/jpeg", "jpg"), ("image/gif", "gif"), ("image/webp", "webp")];
/// Any file that is not an image is kept as `<digest>.bin`, its type in the index alone.
const FILE_EXTENSION: &str = "bin";

/// Node's refusals of content for what it is (`src/shared/agents.ts`), which a client is shown.
pub const SCREENSHOT_WRONG_TYPE: &str =
    "Only PNG, JPEG, GIF, and WebP screenshots can be attached. Nothing was attached. Choose files of those types.";
pub const SCREENSHOT_TOO_LARGE: &str = "Each screenshot must be 10 MB or smaller. Nothing was attached. Choose a smaller file.";
pub const SCREENSHOT_NOT_ITS_TYPE: &str = "This screenshot\u{2019}s content does not match its file type. Nothing was attached. Save it again as PNG, JPEG, GIF, or WebP, then attach it.";
pub const ATTACHED_FILE_TOO_LARGE: &str = "Each file must be 25 MB or smaller. Nothing was attached. Choose a smaller file.";
pub const VIDEO_TOO_LARGE: &str = "Each video must be 500 MB or smaller. Nothing was attached. Trim it, or choose a shorter one.";
const FILE_NAME_UNREADABLE: &str = "Could not read this file\u{2019}s name or size. Nothing was attached. Try again.";

/// Where a host writes a video's parts on their way to the store in `data_directory`: inside the store's folder, so the
/// finished file moves in, as Node's `AttachmentStore.uploadFolder`.
pub fn upload_folder(data_directory: &Path) -> PathBuf {
    data_directory.join(FOLDER).join(UPLOADS)
}

/// Whether a type is one of the four image types, as Node's `isImageAttachment`.
pub fn is_image_type(mime_type: &str) -> bool {
    IMAGE_EXTENSIONS.iter().any(|(mime, _)| *mime == mime_type)
}

/// Whether a type is a video's, as Node's `isVideoAttachment`.
pub fn is_video_type(mime_type: &str) -> bool {
    mime_type.starts_with("video/")
}

/// The most bytes content of a type may hold, as Node's `attachmentLimitBytes`.
pub fn attachment_limit_bytes(mime_type: &str) -> u64 {
    let limit = if is_image_type(mime_type) {
        MAX_IMAGE_ATTACHMENT_BYTES
    } else if is_video_type(mime_type) {
        MAX_VIDEO_ATTACHMENT_BYTES
    } else {
        MAX_FILE_ATTACHMENT_BYTES
    };
    limit as u64
}

/// A type as Node's `agentMimeTypeSchema` reads one: at most 127 characters of `type/subtype`, lowercase.
pub fn is_mime_type(text: &str) -> bool {
    fn token(part: &str) -> bool {
        let mut bytes = part.bytes();
        matches!(bytes.next(), Some(b'a'..=b'z' | b'0'..=b'9'))
            && bytes.all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'!' | b'#' | b'$' | b'&' | b'^' | b'_' | b'.' | b'+' | b'-'))
    }
    text.len() <= 127 && text.split_once('/').is_some_and(|(kind, subtype)| token(kind) && token(subtype))
}

/// Whether an image's first bytes are of its type, as Node's `bytesHaveRasterSignature`.
fn has_raster_signature(mime_type: &str, bytes: &[u8]) -> bool {
    match mime_type {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP".as_slice()),
        _ => false,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedAttachmentHandle {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size_bytes: usize,
    pub digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dimensions: Option<Value>,
}

impl StagedAttachmentHandle {
    pub fn is_image(&self) -> bool {
        self.mime_type.to_ascii_lowercase().starts_with("image/")
    }
}

#[derive(Debug, Clone)]
pub struct StagedAttachmentEntry {
    pub handle: StagedAttachmentHandle,
    pub path: PathBuf,
}

/// Why content was not kept: refused for what it is, in words the client is shown, or the host's failure to keep it.
#[derive(Debug, PartialEq, Eq)]
pub enum StageError {
    Refused(&'static str),
    Failed,
}

/// One content the store keeps, as an entry of Node's index names it.
#[derive(Debug, Clone)]
struct Kept {
    mime_type: String,
    size_bytes: u64,
    /// When it was staged, in milliseconds, as the index had it: Node's `stagedAt`, kept exactly as written.
    staged_at: Value,
}

/// The attachments this host keeps, in Node's layout (see the module's words).
pub struct StagedAttachments {
    folder: PathBuf,
    entries: HashMap<String, StagedAttachmentEntry>,
    kept: HashMap<String, Kept>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl StagedAttachments {
    /// The store in `data_directory`: what Node's index names and its folder still holds, and no upload a stopped host
    /// left behind.
    pub fn new(data_directory: &Path) -> Self {
        let folder = data_directory.join(FOLDER);
        let kept = read_index(&folder);
        if let Ok(names) = fs::read_dir(upload_folder(data_directory)) {
            for name in names.flatten() {
                if name.file_name().to_string_lossy().ends_with(".part") {
                    let _ = fs::remove_file(name.path());
                }
            }
        }
        Self { folder, entries: HashMap::new(), kept }
    }

    fn content_file(&self, digest: &str, mime_type: &str) -> PathBuf {
        let extension = IMAGE_EXTENSIONS
            .iter()
            .find(|(mime, _)| *mime == mime_type)
            .map_or(FILE_EXTENSION, |(_, extension)| extension);
        self.folder.join(format!("{digest}.{extension}"))
    }

    /// The file a digest's content is kept in, or `None` when the store does not keep it.
    pub fn content_path(&self, digest: &str) -> Option<PathBuf> {
        self.kept.get(digest).map(|kept| self.content_file(digest, &kept.mime_type))
    }

    fn write_index(&self) -> Result<(), StageError> {
        let mut digests: Vec<&String> = self.kept.keys().collect();
        digests.sort();
        let entries: Vec<Value> = digests
            .into_iter()
            .map(|digest| {
                let kept = &self.kept[digest];
                json!({ "digest": digest, "mimeType": kept.mime_type, "sizeBytes": kept.size_bytes, "stagedAt": kept.staged_at })
            })
            .collect();
        write_atomic_json(&self.folder.join(INDEX_FILE), &json!({ "version": 1, "entries": entries })).map_err(|_| StageError::Failed)
    }

    /// Keeps bytes under their digest once and answers the file they are in. Content already kept is not written again,
    /// unless it was kept as a file and is now an image, whose signature was checked: it is kept as that image from now
    /// on, as Node's `keepAsImage`. The file and the index are written before this answers.
    fn keep_bytes(&mut self, digest: &str, mime_type: &str, bytes: &[u8]) -> Result<PathBuf, StageError> {
        let existing = self.kept.get(digest).cloned();
        if let Some(kept) = &existing {
            if !(is_image_type(mime_type) && !is_image_type(&kept.mime_type)) {
                return Ok(self.content_file(digest, &kept.mime_type));
            }
        }
        let target = self.content_file(digest, mime_type);
        write_content(&self.folder, &target, bytes)?;
        let staged_at = existing.as_ref().map_or_else(|| json!(now_ms()), |kept| kept.staged_at.clone());
        self.kept.insert(digest.to_string(), Kept { mime_type: mime_type.to_string(), size_bytes: bytes.len() as u64, staged_at });
        if let Err(err) = self.write_index() {
            match existing {
                Some(kept) => {
                    self.kept.insert(digest.to_string(), kept);
                }
                None => {
                    self.kept.remove(digest);
                }
            }
            let _ = fs::remove_file(&target);
            return Err(err);
        }
        Ok(target)
    }

    fn add_entry(&mut self, name: String, mime_type: &str, size_bytes: usize, digest: String, dimensions: Option<Value>, path: PathBuf) -> StagedAttachmentHandle {
        let handle = StagedAttachmentHandle {
            id: Uuid::new_v4().to_string(),
            name,
            mime_type: mime_type.to_string(),
            size_bytes,
            digest,
            dimensions,
        };
        self.entries.insert(handle.id.clone(), StagedAttachmentEntry { handle: handle.clone(), path });
        handle
    }

    pub fn stage_image(
        &mut self,
        name: &str,
        mime_type: &str,
        data_b64: &str,
        dimensions: Option<Value>,
    ) -> Result<StagedAttachmentHandle, String> {
        if !is_image_type(mime_type) {
            return Err("Only PNG, JPEG, WebP, and GIF images can be attached.".into());
        }
        let max_b64 = MAX_IMAGE_ATTACHMENT_BYTES.div_ceil(3) * 4;
        if data_b64.len() > max_b64 {
            return Err("Attachment image size is out of bounds.".into());
        }
        let bytes = STANDARD
            .decode(data_b64)
            .map_err(|_| "Attachment image data is not valid base64.".to_string())?;
        if bytes.is_empty() || bytes.len() > MAX_IMAGE_ATTACHMENT_BYTES {
            return Err("Attachment image size is out of bounds.".into());
        }
        let digest = sha256_hex(&bytes);
        let path = self.keep_bytes(&digest, mime_type, &bytes).map_err(|_| "Could not keep this image on the host.".to_string())?;
        Ok(self.add_entry(name.to_string(), mime_type, bytes.len(), digest, dimensions, path))
    }

    /// Keeps a file whose every part has arrived and checks out, as Node's `AttachmentStore.stage` keeps one: an image's
    /// size and signature are checked for its type, any other file's size for its type, and its bytes are not inspected.
    pub fn stage_received_bytes(&mut self, name: &str, mime_type: &str, bytes: &[u8]) -> Result<StagedAttachmentHandle, StageError> {
        let image = is_image_type(mime_type);
        if !image && !is_mime_type(mime_type) {
            return Err(StageError::Refused(SCREENSHOT_WRONG_TYPE));
        }
        if bytes.is_empty() || bytes.len() as u64 > attachment_limit_bytes(mime_type) {
            return Err(StageError::Refused(if image { SCREENSHOT_TOO_LARGE } else { ATTACHED_FILE_TOO_LARGE }));
        }
        if image && !has_raster_signature(mime_type, bytes) {
            return Err(StageError::Refused(SCREENSHOT_NOT_ITS_TYPE));
        }
        let name = handle_name(name, if image { "Screenshot" } else { "File" })?;
        let digest = sha256_hex(bytes);
        let path = self.keep_bytes(&digest, mime_type, bytes)?;
        Ok(self.add_entry(name, mime_type, bytes.len(), digest, None, path))
    }

    /// Keeps a video whose parts a host wrote to disk and has just checked against `digest`, moved in from `path`, as
    /// Node's `AttachmentStore.stageFile` with `move`. Content already kept stays as it is and the upload's file goes.
    pub fn stage_received_file(&mut self, name: &str, mime_type: &str, path: &Path, digest: &str) -> Result<StagedAttachmentHandle, StageError> {
        let video = is_video_type(mime_type);
        if is_image_type(mime_type) || !is_mime_type(mime_type) || !is_digest(digest) {
            return Err(StageError::Refused(SCREENSHOT_WRONG_TYPE));
        }
        let size = fs::metadata(path).map_err(|_| StageError::Failed)?;
        if !size.is_file() || size.len() < 1 || size.len() > attachment_limit_bytes(mime_type) {
            return Err(StageError::Refused(if video { VIDEO_TOO_LARGE } else { ATTACHED_FILE_TOO_LARGE }));
        }
        let size_bytes = size.len();
        let name = handle_name(name, "File")?;
        let target = match self.kept.get(digest) {
            Some(kept) => {
                let existing = self.content_file(digest, &kept.mime_type);
                let _ = fs::remove_file(path);
                existing
            }
            None => {
                fs::create_dir_all(&self.folder).map_err(|_| StageError::Failed)?;
                let target = self.content_file(digest, mime_type);
                fs::rename(path, &target).map_err(|_| StageError::Failed)?;
                self.kept.insert(digest.to_string(), Kept { mime_type: mime_type.to_string(), size_bytes, staged_at: json!(now_ms()) });
                if let Err(err) = self.write_index() {
                    self.kept.remove(digest);
                    let _ = fs::remove_file(&target);
                    return Err(err);
                }
                target
            }
        };
        Ok(self.add_entry(name, mime_type, size_bytes as usize, digest.to_string(), None, target))
    }

    pub fn get(&self, id: &str) -> Option<&StagedAttachmentEntry> {
        self.entries.get(id)
    }

    pub fn get_by_digest(&self, digest: &str) -> Option<&StagedAttachmentEntry> {
        self.entries.values().find(|e| e.handle.digest.eq_ignore_ascii_case(digest))
    }
}

/// A handle's name as Node's `agentAttachmentHandleSchema` takes it: trimmed, or `fallback` when nothing is left, and
/// at most 255 UTF-16 code units.
fn handle_name(name: &str, fallback: &str) -> Result<String, StageError> {
    let trimmed = name.trim();
    let name = if trimmed.is_empty() { fallback } else { trimmed };
    if utf16_len(name) > 255 {
        return Err(StageError::Refused(FILE_NAME_UNREADABLE));
    }
    Ok(name.to_string())
}

/// Writes content to a file of its own beside its place and renames it there, so no reader sees part of it.
fn write_content(folder: &Path, target: &Path, bytes: &[u8]) -> Result<(), StageError> {
    fs::create_dir_all(folder).map_err(|_| StageError::Failed)?;
    let file_name = target.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let temporary = target.with_file_name(format!("{file_name}.tmp-{}-{}", std::process::id(), Uuid::new_v4()));
    let written = (|| -> std::io::Result<()> {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, target)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(StageError::Failed);
    }
    Ok(())
}

/// What Node's index names and the folder still holds, as Node's `load` takes it back: each entry its strict schema reads,
/// whose file is there as a file within its type's limit, at the size the file has. An index that is missing or that
/// Node's schema refuses whole names nothing; it is left where it is.
fn read_index(folder: &Path) -> HashMap<String, Kept> {
    let mut kept = HashMap::new();
    let Ok(text) = fs::read_to_string(folder.join(INDEX_FILE)) else {
        return kept;
    };
    let Ok(index) = serde_json::from_str::<Map<String, Value>>(&text) else {
        return kept;
    };
    if index.get("version").and_then(Value::as_f64) != Some(1.0) {
        return kept;
    }
    let Some(entries) = index.get("entries").and_then(Value::as_array) else {
        return kept;
    };
    for entry in entries {
        let Some(fields) = entry.as_object() else { continue };
        if fields.keys().any(|key| !matches!(key.as_str(), "digest" | "mimeType" | "sizeBytes" | "stagedAt")) {
            continue;
        }
        let digest = fields.get("digest").and_then(Value::as_str).filter(|digest| is_digest(digest));
        let mime_type = fields.get("mimeType").and_then(Value::as_str).filter(|mime| is_mime_type(mime));
        let size = fields.get("sizeBytes").and_then(whole_number);
        let staged_at = fields.get("stagedAt").filter(|at| at.as_f64().is_some_and(f64::is_finite));
        let (Some(digest), Some(mime_type), Some(size), Some(staged_at)) = (digest, mime_type, size, staged_at) else { continue };
        if size < 1 || size > attachment_limit_bytes(mime_type) || kept.contains_key(digest) {
            continue;
        }
        let extension = IMAGE_EXTENSIONS.iter().find(|(mime, _)| *mime == mime_type).map_or(FILE_EXTENSION, |(_, extension)| extension);
        let on_disk = match fs::metadata(folder.join(format!("{digest}.{extension}"))) {
            Ok(metadata) if metadata.is_file() => metadata.len(),
            Ok(_) => continue,
            Err(err) if err.kind() == ErrorKind::NotFound => continue,
            Err(_) => continue,
        };
        if on_disk < 1 || on_disk > attachment_limit_bytes(mime_type) {
            continue;
        }
        kept.insert(digest.to_string(), Kept { mime_type: mime_type.to_string(), size_bytes: on_disk, staged_at: staged_at.clone() });
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    fn index(data: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(data.join("attachments").join("index.json")).unwrap()).unwrap()
    }

    /// An image and a file are kept as Node keeps them: each once, under its digest and type, and named in the index.
    #[test]
    fn content_is_kept_in_nodes_layout() {
        let dir = tempdir().unwrap();
        let mut staged = StagedAttachments::new(dir.path());
        let image = staged.stage_image("Referee.png", "image/png", PNG, None).unwrap();
        assert_eq!(staged.get(&image.id).unwrap().path, dir.path().join("attachments").join(format!("{}.png", image.digest)));
        assert!(serde_json::to_value(&image).unwrap().get("kind").is_none());

        let notes = b"Referee notes\nsecond line\n";
        let file = staged.stage_received_bytes("  Referee notes.txt ", "text/plain", notes).unwrap();
        assert_eq!(file.name, "Referee notes.txt");
        let path = staged.get(&file.id).unwrap().path.clone();
        assert_eq!(path, dir.path().join("attachments").join(format!("{}.bin", file.digest)));
        assert_eq!(fs::read(&path).unwrap(), notes);
        // The same bytes again are the same content, under a handle of their own.
        let again = staged.stage_received_bytes("again.txt", "text/plain", notes).unwrap();
        assert_ne!(again.id, file.id);
        assert_eq!(staged.get(&again.id).unwrap().path, path);

        let saved = index(dir.path());
        assert_eq!(saved["version"], 1);
        let entries = saved["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        for entry in entries {
            let fields = entry.as_object().unwrap();
            assert_eq!(fields.keys().cloned().collect::<Vec<_>>(), ["digest", "mimeType", "sizeBytes", "stagedAt"]);
        }
        assert!(entries.iter().any(|e| e["digest"] == file.digest && e["mimeType"] == "text/plain" && e["sizeBytes"] == notes.len()));

        // A store started later reads what was kept, and a part file left behind goes.
        let uploads = dir.path().join("attachments").join("uploads");
        fs::create_dir_all(&uploads).unwrap();
        fs::write(uploads.join("left.part"), b"half").unwrap();
        let next = StagedAttachments::new(dir.path());
        assert_eq!(next.content_path(&file.digest), Some(path));
        assert_eq!(next.content_path(&image.digest).unwrap().extension().unwrap(), "png");
        assert!(!uploads.join("left.part").exists());
    }

    /// Content is refused for what it is in Node's words, and nothing of it is kept.
    #[test]
    fn content_is_refused_as_node_refuses_it() {
        let dir = tempdir().unwrap();
        let mut staged = StagedAttachments::new(dir.path());
        assert_eq!(staged.stage_received_bytes("a.png", "image/png", b"not a png").unwrap_err(), StageError::Refused(SCREENSHOT_NOT_ITS_TYPE));
        assert_eq!(staged.stage_received_bytes("a", "Text/Plain", b"x").unwrap_err(), StageError::Refused(SCREENSHOT_WRONG_TYPE));
        let large = vec![0u8; MAX_FILE_ATTACHMENT_BYTES + 1];
        assert_eq!(staged.stage_received_bytes("a.log", "text/plain", &large).unwrap_err(), StageError::Refused(ATTACHED_FILE_TOO_LARGE));
        let image = vec![0u8; MAX_IMAGE_ATTACHMENT_BYTES + 1];
        assert_eq!(staged.stage_received_bytes("a.png", "image/png", &image).unwrap_err(), StageError::Refused(SCREENSHOT_TOO_LARGE));
        assert!(!dir.path().join("attachments").join("index.json").exists());
    }

    /// A finished video upload is moved in under its digest, and one already kept lets the upload's file go.
    #[test]
    fn a_received_video_is_moved_in() {
        let dir = tempdir().unwrap();
        let mut staged = StagedAttachments::new(dir.path());
        let uploads = upload_folder(dir.path());
        fs::create_dir_all(&uploads).unwrap();
        let bytes = b"a video's bytes";
        let digest = sha256_hex(bytes);
        let part = uploads.join("one.part");
        fs::write(&part, bytes).unwrap();
        let handle = staged.stage_received_file("clip.mp4", "video/mp4", &part, &digest).unwrap();
        assert_eq!((handle.size_bytes, handle.digest.as_str()), (bytes.len(), digest.as_str()));
        let kept = dir.path().join("attachments").join(format!("{digest}.bin"));
        assert_eq!(fs::read(&kept).unwrap(), bytes);
        assert!(!part.exists());

        let second = uploads.join("two.part");
        fs::write(&second, bytes).unwrap();
        staged.stage_received_file("clip.mp4", "video/mp4", &second, &digest).unwrap();
        assert!(!second.exists());
        assert_eq!(index(dir.path())["entries"].as_array().unwrap().len(), 1);
        assert_eq!(staged.stage_received_file("a.png", "image/png", &kept, &digest).unwrap_err(), StageError::Refused(SCREENSHOT_WRONG_TYPE));
    }

    /// Node's index is read as Node's schema reads each entry: one it refuses, or whose file is gone, names nothing.
    #[test]
    fn nodes_index_is_read_entry_by_entry() {
        let dir = tempdir().unwrap();
        let folder = dir.path().join("attachments");
        fs::create_dir_all(&folder).unwrap();
        let good = "a".repeat(64);
        let gone = "b".repeat(64);
        let extra = "c".repeat(64);
        fs::write(folder.join(format!("{good}.bin")), b"12345").unwrap();
        fs::write(folder.join(format!("{extra}.bin")), b"12345").unwrap();
        let saved = json!({ "version": 1, "entries": [
            { "digest": good, "mimeType": "application/pdf", "sizeBytes": 9, "stagedAt": 1.5 },
            { "digest": gone, "mimeType": "text/plain", "sizeBytes": 5, "stagedAt": 1 },
            { "digest": extra, "mimeType": "text/plain", "sizeBytes": 5, "stagedAt": 1, "name": "secret" },
        ] });
        fs::write(folder.join("index.json"), saved.to_string()).unwrap();
        let staged = StagedAttachments::new(dir.path());
        assert_eq!(staged.content_path(&good), Some(folder.join(format!("{good}.bin"))));
        assert_eq!(staged.kept[&good].size_bytes, 5, "the size the file has, as Node's load takes it");
        assert_eq!(staged.content_path(&gone), None);
        assert_eq!(staged.content_path(&extra), None);
        assert!(is_mime_type("application/vnd.ms-excel") && !is_mime_type("text") && !is_mime_type("/plain") && !is_mime_type("Text/plain"));
    }
}
