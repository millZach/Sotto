//! The attachments this host keeps for drafts and sends (ADR-0031, ADR-0131), in Node's `AttachmentStore` layout
//! (`src/main/agents/attachmentStore.ts`) in the same data folder, so a rollback to Node finds every file this host kept.
//!
//! Each distinct content is one file in `attachments/`, named by its SHA-256: `<digest>.<png|jpg|gif|webp>` for an image,
//! `<digest>.bin` for any other file, beside `attachments/index.json`, which names each content's digest, type, size and
//! staging time and nothing else. A video's parts on their way here are written to `attachments/uploads/<uuid>.part` and
//! moved in once they check out. At start the folder is squared with the index as Node's `load` squares it, and a part
//! file a stopped host left behind is removed. Content a read finds missing or no longer its digest is let go, file and
//! entry, as Node's `read` lets it go. Handles, which name the content a draft or a send carries, are this run's: a
//! handle's ID finds its entry here.

use std::collections::HashMap;
use std::fs;
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::protocol_fields::{hex, is_digest, utf16_len, whole_number};
use crate::workspace::{corrupt_copy_path, now_ms, rename_retrying, sha256_hex, write_atomic, write_atomic_json};

pub const MAX_IMAGE_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_FILE_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;
pub const MAX_VIDEO_ATTACHMENT_BYTES: usize = 500 * 1024 * 1024;

/// The folder under the data folder Node's store keeps content in, its index, and where a video's parts are written.
const FOLDER: &str = "attachments";
const INDEX_FILE: &str = "index.json";
const UPLOADS: &str = "uploads";
/// The image types Node's stores keep, by the extension each one's file has (`EXTENSIONS` in Node's attachment store).
pub const IMAGE_EXTENSIONS: [(&str, &str); 4] =
    [("image/png", "png"), ("image/jpeg", "jpg"), ("image/gif", "gif"), ("image/webp", "webp")];
/// Any file that is not an image is kept as `<digest>.bin`, its type in the index alone.
const FILE_EXTENSION: &str = "bin";
/// The type a file the index lost comes back as, as Node's `AGENT_GENERIC_FILE_MIME_TYPE`.
const GENERIC_FILE_MIME_TYPE: &str = "application/octet-stream";

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

/// The extension an image type's file has, or `None` for a type that is not one of the four images.
pub fn image_extension(mime_type: &str) -> Option<&'static str> {
    IMAGE_EXTENSIONS.iter().find(|(mime, _)| *mime == mime_type).map(|(_, extension)| *extension)
}

/// Whether a type is one of the four image types, as Node's `isImageAttachment`.
pub fn is_image_type(mime_type: &str) -> bool {
    image_extension(mime_type).is_some()
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
pub(crate) fn has_raster_signature(mime_type: &str, bytes: &[u8]) -> bool {
    match mime_type {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP".as_slice()),
        _ => false,
    }
}

/// A read of a kept file the host failed at: not a file that is gone or changed, which reads as `Ok(None)`.
#[derive(Debug, PartialEq, Eq)]
pub struct ReadFailed;

/// The bytes of the file at `path` when it is still the content of `digest` it was kept as: a file of `size_bytes`
/// whose SHA-256 is `digest`. `None` when it is gone, is a folder, has another size or other bytes; never reads more than
/// one byte past `size_bytes`. A failure to read a file that is there is the host's.
pub fn read_checked(path: &Path, size_bytes: u64, digest: &str) -> Result<Option<Vec<u8>>, ReadFailed> {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(None),
        // A folder of that name is no content a store keeps; Windows refuses to open one as a file.
        Err(_) if path.is_dir() => return Ok(None),
        Err(_) => return Err(ReadFailed),
    };
    let metadata = file.metadata().map_err(|_| ReadFailed)?;
    if !metadata.is_file() || metadata.len() != size_bytes {
        return Ok(None);
    }
    // At most one byte more than its size: a file that grew is not its digest, and is never read past the limit.
    let mut bytes = Vec::with_capacity(size_bytes as usize + 1);
    (&mut file).take(size_bytes + 1).read_to_end(&mut bytes).map_err(|_| ReadFailed)?;
    Ok((hex(&Sha256::digest(&bytes)) == digest).then_some(bytes))
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

/// Why content, or a part of it on its way here, was not kept: refused for what it is, in words the client is shown,
/// or the host's failure to keep it, which a client is told as `unavailable`.
#[derive(Debug, PartialEq, Eq)]
pub enum AttachmentError {
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

/// The file a content is kept in, by its digest and the type it is kept as.
fn content_file(folder: &Path, digest: &str, mime_type: &str) -> PathBuf {
    folder.join(format!("{digest}.{}", image_extension(mime_type).unwrap_or(FILE_EXTENSION)))
}

/// The attachments this host keeps, in Node's layout (see the module's words).
pub struct StagedAttachments {
    folder: PathBuf,
    entries: HashMap<String, StagedAttachmentEntry>,
    kept: HashMap<String, Kept>,
    /// The kept digests in the order the index names them, so a save keeps Node's order.
    order: Vec<String>,
}

impl StagedAttachments {
    /// The store in `data_directory`, squared with its folder as Node's `load` squares it, with no upload a stopped host
    /// left behind.
    pub fn new(data_directory: &Path) -> Self {
        let folder = data_directory.join(FOLDER);
        let mut store = Self { folder, entries: HashMap::new(), kept: HashMap::new(), order: Vec::new() };
        store.load();
        if let Ok(names) = fs::read_dir(upload_folder(data_directory)) {
            for name in names.flatten() {
                if name.file_name().to_string_lossy().ends_with(".part") {
                    let _ = fs::remove_file(name.path());
                }
            }
        }
        store
    }

    /// Reads the index and squares it with the folder, as Node's `load`: every content file the index names, or that a
    /// crash left out of it, is kept at the size it has, an image's own file before a `.bin` of the same digest, and
    /// anything else in the folder that is not a folder is removed: temporary files, copies, files over their type's
    /// limit. The index is written again when it no longer says what is kept. An index Node's schema refuses whole is set
    /// aside as `index.json.corrupt-<millis>` first; one that cannot be read at all is left as it is, and not written.
    fn load(&mut self) {
        let Ok(listing) = fs::read_dir(&self.folder) else { return };
        let mut names: Vec<String> = listing.flatten().filter_map(|entry| entry.file_name().into_string().ok()).collect();
        let index = read_index(&self.folder.join(INDEX_FILE));
        let saved: &[(String, String, Value)] = match &index {
            Index::Read(entries) => entries,
            Index::Corrupt => {
                let path = self.folder.join(INDEX_FILE);
                let _ = fs::rename(&path, corrupt_copy_path(&path));
                &[]
            }
            Index::Missing | Index::Unreadable => &[],
        };
        let indexed: HashMap<&str, (&str, &Value)> =
            saved.iter().map(|(digest, mime, at)| (digest.as_str(), (mime.as_str(), at))).collect();
        // The index's order first, then what a crash left out of it, an image's file before a file's of the same digest.
        let position = |name: &str| saved.iter().position(|(digest, _, _)| name.starts_with(digest.as_str())).unwrap_or(saved.len());
        names.sort_by_key(|name| (position(name), name.ends_with(".bin")));
        let now = json!(now_ms());
        for name in names {
            if name == INDEX_FILE {
                continue;
            }
            let path = self.folder.join(&name);
            let found = content_name(&name).and_then(|(digest, extension)| {
                let entry = indexed.get(digest);
                let mime_type = if extension == FILE_EXTENSION {
                    entry.map(|(mime, _)| *mime).filter(|mime| !is_image_type(mime)).unwrap_or(GENERIC_FILE_MIME_TYPE)
                } else {
                    IMAGE_EXTENSIONS.iter().find(|(_, ext)| *ext == extension)?.0
                };
                let size = fs::metadata(&path).ok().filter(fs::Metadata::is_file).map_or(0, |metadata| metadata.len());
                let keep = size >= 1 && size <= attachment_limit_bytes(mime_type) && !self.kept.contains_key(digest);
                let staged_at = entry.map_or_else(|| now.clone(), |(_, at)| (*at).clone());
                keep.then(|| (digest.to_string(), Kept { mime_type: mime_type.to_string(), size_bytes: size, staged_at }))
            });
            match found {
                Some((digest, kept)) => {
                    self.order.push(digest.clone());
                    self.kept.insert(digest, kept);
                }
                // A folder, such as `uploads`, is left where it is, as Node's unlink of one fails and is passed over.
                None if path.is_dir() => {}
                None => {
                    let _ = fs::remove_file(&path);
                }
            }
        }
        let stale = match &index {
            Index::Read(entries) => entries.len() != self.kept.len() || entries.iter().any(|(digest, _, _)| !self.kept.contains_key(digest)),
            Index::Missing | Index::Corrupt => !self.kept.is_empty(),
            Index::Unreadable => false,
        };
        if stale {
            let _ = self.write_index();
        }
    }

    /// The file a digest's content is kept in, or `None` when the store does not keep it.
    pub fn content_path(&self, digest: &str) -> Option<PathBuf> {
        self.kept.get(digest).map(|kept| content_file(&self.folder, digest, &kept.mime_type))
    }

    fn write_index(&self) -> Result<(), AttachmentError> {
        let entries: Vec<Value> = self
            .order
            .iter()
            .filter_map(|digest| {
                let kept = self.kept.get(digest)?;
                Some(json!({ "digest": digest, "mimeType": kept.mime_type, "sizeBytes": kept.size_bytes, "stagedAt": kept.staged_at }))
            })
            .collect();
        write_atomic_json(&self.folder.join(INDEX_FILE), &json!({ "version": 1, "entries": entries })).map_err(|_| AttachmentError::Failed)
    }

    /// The file a digest's content is kept in while it is still there at the size it was kept at. Content whose file is
    /// gone, or has another size, is let go, so staging it again writes it afresh.
    fn kept_file(&mut self, digest: &str) -> Option<(PathBuf, Kept)> {
        let kept = self.kept.get(digest)?.clone();
        let path = content_file(&self.folder, digest, &kept.mime_type);
        if fs::metadata(&path).is_ok_and(|metadata| metadata.is_file() && metadata.len() == kept.size_bytes) {
            return Some((path, kept));
        }
        self.drop_content(digest);
        None
    }

    /// Records content just written or moved to `target` and writes the index; if the index cannot be written, the store
    /// is as it was and `target` goes, so nothing is ever named that is not on disk, nor kept that nothing names.
    fn commit(&mut self, digest: &str, kept: Kept, target: &Path) -> Result<(), AttachmentError> {
        let previous = self.kept.insert(digest.to_string(), kept);
        if previous.is_none() {
            self.order.push(digest.to_string());
        }
        if let Err(err) = self.write_index() {
            match previous {
                Some(previous) => {
                    self.kept.insert(digest.to_string(), previous);
                }
                None => {
                    self.kept.remove(digest);
                    self.order.retain(|kept| kept != digest);
                }
            }
            let _ = fs::remove_file(target);
            return Err(err);
        }
        Ok(())
    }

    /// Keeps bytes under their digest once and answers the file they are in. Content already kept is not written again,
    /// unless it was kept as a file and is now an image, whose signature was checked: it is kept as that image from now
    /// on, as Node's `keepAsImage`, and the file's copy goes once the image's is written and indexed.
    fn keep_bytes(&mut self, digest: &str, mime_type: &str, bytes: &[u8]) -> Result<PathBuf, AttachmentError> {
        let existing = self.kept_file(digest);
        if let Some((path, kept)) = &existing {
            if !(is_image_type(mime_type) && !is_image_type(&kept.mime_type)) {
                return Ok(path.clone());
            }
        }
        let target = content_file(&self.folder, digest, mime_type);
        write_atomic(&target, bytes).map_err(|_| AttachmentError::Failed)?;
        let staged_at = existing.as_ref().map_or_else(|| json!(now_ms()), |(_, kept)| kept.staged_at.clone());
        self.commit(digest, Kept { mime_type: mime_type.to_string(), size_bytes: bytes.len() as u64, staged_at }, &target)?;
        if let Some((replaced, _)) = existing {
            let _ = fs::remove_file(&replaced);
            for entry in self.entries.values_mut().filter(|entry| entry.handle.digest == digest) {
                entry.path = target.clone();
            }
        }
        Ok(target)
    }

    fn add_entry(&mut self, handle: StagedAttachmentHandle, path: PathBuf) -> StagedAttachmentHandle {
        self.entries.insert(handle.id.clone(), StagedAttachmentEntry { handle: handle.clone(), path });
        handle
    }

    /// Keeps an image sent whole (`stage-attachment`). Its signature is checked for its type before anything is written,
    /// as Node's `stage` checks it, so bytes that are not the image they claim are never kept as one.
    pub fn stage_image(
        &mut self,
        name: &str,
        mime_type: &str,
        data_b64: &str,
        dimensions: Option<Value>,
    ) -> Result<StagedAttachmentHandle, AttachmentError> {
        if !is_image_type(mime_type) {
            return Err(AttachmentError::Refused("Only PNG, JPEG, WebP, and GIF images can be attached."));
        }
        let max_b64 = MAX_IMAGE_ATTACHMENT_BYTES.div_ceil(3) * 4;
        if data_b64.len() > max_b64 {
            return Err(AttachmentError::Refused("Attachment image size is out of bounds."));
        }
        let bytes = STANDARD.decode(data_b64).map_err(|_| AttachmentError::Refused("Attachment image data is not valid base64."))?;
        if bytes.is_empty() || bytes.len() > MAX_IMAGE_ATTACHMENT_BYTES {
            return Err(AttachmentError::Refused("Attachment image size is out of bounds."));
        }
        if !has_raster_signature(mime_type, &bytes) {
            return Err(AttachmentError::Refused(SCREENSHOT_NOT_ITS_TYPE));
        }
        let digest = sha256_hex(&bytes);
        let path = self.keep_bytes(&digest, mime_type, &bytes)?;
        let handle = StagedAttachmentHandle {
            id: Uuid::new_v4().to_string(),
            name: name.to_string(),
            mime_type: mime_type.to_string(),
            size_bytes: bytes.len(),
            digest,
            dimensions,
        };
        Ok(self.add_entry(handle, path))
    }

    /// Keeps a file whose every part has arrived and checks out, as Node's `AttachmentStore.stage` keeps one: an image's
    /// size and signature are checked for its type, any other file's size for its type, and its bytes are not inspected.
    pub fn stage_received_bytes(&mut self, name: &str, mime_type: &str, bytes: &[u8]) -> Result<StagedAttachmentHandle, AttachmentError> {
        let image = is_image_type(mime_type);
        if !image && !is_mime_type(mime_type) {
            return Err(AttachmentError::Refused(SCREENSHOT_WRONG_TYPE));
        }
        if bytes.is_empty() || bytes.len() as u64 > attachment_limit_bytes(mime_type) {
            return Err(AttachmentError::Refused(if image { SCREENSHOT_TOO_LARGE } else { ATTACHED_FILE_TOO_LARGE }));
        }
        if image && !has_raster_signature(mime_type, bytes) {
            return Err(AttachmentError::Refused(SCREENSHOT_NOT_ITS_TYPE));
        }
        let name = handle_name(name, if image { "Screenshot" } else { "File" })?;
        let digest = sha256_hex(bytes);
        let path = self.keep_bytes(&digest, mime_type, bytes)?;
        let handle = StagedAttachmentHandle { id: Uuid::new_v4().to_string(), name, mime_type: mime_type.to_string(), size_bytes: bytes.len(), digest, dimensions: None };
        Ok(self.add_entry(handle, path))
    }

    /// Keeps a video whose parts a host wrote to disk and has just checked against `digest`, moved in from `path`, as
    /// Node's `AttachmentStore.stageFile` with `move`. Content already kept stays as it is and the upload's file goes.
    pub fn stage_received_file(&mut self, name: &str, mime_type: &str, path: &Path, digest: &str) -> Result<StagedAttachmentHandle, AttachmentError> {
        let video = is_video_type(mime_type);
        if is_image_type(mime_type) || !is_mime_type(mime_type) || !is_digest(digest) {
            return Err(AttachmentError::Refused(SCREENSHOT_WRONG_TYPE));
        }
        let size = fs::metadata(path).map_err(|_| AttachmentError::Failed)?;
        if !size.is_file() || size.len() < 1 || size.len() > attachment_limit_bytes(mime_type) {
            return Err(AttachmentError::Refused(if video { VIDEO_TOO_LARGE } else { ATTACHED_FILE_TOO_LARGE }));
        }
        let size_bytes = size.len();
        let name = handle_name(name, "File")?;
        let target = match self.kept_file(digest) {
            Some((existing, _)) => {
                let _ = fs::remove_file(path);
                existing
            }
            None => {
                fs::create_dir_all(&self.folder).map_err(|_| AttachmentError::Failed)?;
                let target = content_file(&self.folder, digest, mime_type);
                rename_retrying(path, &target).map_err(|_| AttachmentError::Failed)?;
                self.commit(digest, Kept { mime_type: mime_type.to_string(), size_bytes, staged_at: json!(now_ms()) }, &target)?;
                target
            }
        };
        let handle = StagedAttachmentHandle {
            id: Uuid::new_v4().to_string(),
            name,
            mime_type: mime_type.to_string(),
            size_bytes: size_bytes as usize,
            digest: digest.to_string(),
            dimensions: None,
        };
        Ok(self.add_entry(handle, target))
    }

    /// Lets go of a digest's content, its index entry and its file, as Node's `read` does for content that is no longer
    /// its digest. Staging the same content again writes it afresh.
    fn drop_content(&mut self, digest: &str) {
        let Some(kept) = self.kept.remove(digest) else { return };
        self.order.retain(|kept| kept != digest);
        let _ = self.write_index();
        let _ = fs::remove_file(content_file(&self.folder, digest, &kept.mime_type));
    }

    /// A reader outside the store found a digest's content missing or changed: it is let go unless its file, read again
    /// now in turn with staging, is its digest after all, as content staged again meanwhile would be.
    pub fn forget_unreadable(&mut self, digest: &str) {
        let Some(kept) = self.kept.get(digest) else { return };
        let path = content_file(&self.folder, digest, &kept.mime_type);
        if !matches!(read_checked(&path, kept.size_bytes, digest), Ok(Some(_))) {
            self.drop_content(digest);
        }
    }

    /// A kept image's type and bytes by digest, for a composer restoring a chip it holds no copy of, as Node's
    /// `attachmentContent`: never a file, which draws no chip, and `None` once the store no longer keeps it. An image whose
    /// bytes are gone or no longer its digest is let go.
    pub fn read_image(&mut self, digest: &str) -> Option<(String, Vec<u8>)> {
        let kept = self.kept.get(digest).filter(|kept| is_image_type(&kept.mime_type))?.clone();
        match read_checked(&content_file(&self.folder, digest, &kept.mime_type), kept.size_bytes, digest) {
            Ok(Some(bytes)) => Some((kept.mime_type, bytes)),
            Ok(None) => {
                self.drop_content(digest);
                None
            }
            Err(ReadFailed) => None,
        }
    }

    pub fn get(&self, id: &str) -> Option<&StagedAttachmentEntry> {
        self.entries.get(id)
    }
}

/// A content file's digest and extension, as Node's `CONTENT_FILE` (`^([a-f0-9]{64})\.(png|jpg|gif|webp|bin)$`) reads its name.
fn content_name(name: &str) -> Option<(&str, &str)> {
    let (digest, extension) = name.split_once('.')?;
    let known = extension == FILE_EXTENSION || IMAGE_EXTENSIONS.iter().any(|(_, ext)| *ext == extension);
    (is_digest(digest) && known).then_some((digest, extension))
}

/// A handle's name as Node's `agentAttachmentHandleSchema` takes it: trimmed, or `fallback` when nothing is left, and
/// at most 255 UTF-16 code units.
fn handle_name(name: &str, fallback: &str) -> Result<String, AttachmentError> {
    let trimmed = name.trim();
    let name = if trimmed.is_empty() { fallback } else { trimmed };
    if utf16_len(name) > 255 {
        return Err(AttachmentError::Refused(FILE_NAME_UNREADABLE));
    }
    Ok(name.to_string())
}

/// What the index holds, as Node's `AtomicJsonStore` reads it.
enum Index {
    Missing,
    /// It could not be read at all; Node's load would stop there.
    Unreadable,
    /// It is not JSON, or not `{ version: 1, entries: [...] }`.
    Corrupt,
    /// Each entry Node's strict `entrySchema` reads, as its digest, type and staging time, in the index's order.
    Read(Vec<(String, String, Value)>),
}

fn read_index(path: &Path) -> Index {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == ErrorKind::NotFound => return Index::Missing,
        Err(_) => return Index::Unreadable,
    };
    let Ok(index) = serde_json::from_str::<Map<String, Value>>(&text) else { return Index::Corrupt };
    let entries = match (index.get("version").and_then(Value::as_f64), index.get("entries").and_then(Value::as_array)) {
        (Some(1.0), Some(entries)) => entries,
        _ => return Index::Corrupt,
    };
    let read = entries
        .iter()
        .filter_map(|entry| {
            let fields = entry.as_object()?;
            if fields.keys().any(|key| !matches!(key.as_str(), "digest" | "mimeType" | "sizeBytes" | "stagedAt")) {
                return None;
            }
            let digest = fields.get("digest")?.as_str().filter(|digest| is_digest(digest))?;
            let mime_type = fields.get("mimeType")?.as_str().filter(|mime| is_mime_type(mime))?;
            let size = whole_number(fields.get("sizeBytes")?)?;
            let staged_at = fields.get("stagedAt").filter(|at| at.as_f64().is_some_and(f64::is_finite))?;
            (size >= 1 && size <= attachment_limit_bytes(mime_type)).then(|| (digest.to_string(), mime_type.to_string(), staged_at.clone()))
        })
        .collect();
    Index::Read(read)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    fn png() -> Vec<u8> {
        STANDARD.decode(PNG).unwrap()
    }

    fn index(data: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(data.join("attachments").join("index.json")).unwrap()).unwrap()
    }

    fn names(folder: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(folder).unwrap().flatten().map(|e| e.file_name().into_string().unwrap()).collect();
        names.sort();
        names
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
        let uploads = upload_folder(dir.path());
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
        assert_eq!(staged.stage_received_bytes("a.png", "image/png", b"not a png").unwrap_err(), AttachmentError::Refused(SCREENSHOT_NOT_ITS_TYPE));
        assert_eq!(staged.stage_received_bytes("a", "Text/Plain", b"x").unwrap_err(), AttachmentError::Refused(SCREENSHOT_WRONG_TYPE));
        let large = vec![0u8; MAX_FILE_ATTACHMENT_BYTES + 1];
        assert_eq!(staged.stage_received_bytes("a.log", "text/plain", &large).unwrap_err(), AttachmentError::Refused(ATTACHED_FILE_TOO_LARGE));
        let image = vec![0u8; MAX_IMAGE_ATTACHMENT_BYTES + 1];
        assert_eq!(staged.stage_received_bytes("a.png", "image/png", &image).unwrap_err(), AttachmentError::Refused(SCREENSHOT_TOO_LARGE));
        // An image sent whole is checked for its type before anything is written.
        let gif_as_png = STANDARD.encode(b"GIF89a not a png");
        assert_eq!(staged.stage_image("a.png", "image/png", &gif_as_png, None).unwrap_err(), AttachmentError::Refused(SCREENSHOT_NOT_ITS_TYPE));
        assert!(!dir.path().join("attachments").exists());
    }

    /// Content first kept as a file and then attached as an image is kept as that image, and the file's copy goes once
    /// the image's own file is written and indexed; handles of either point at the image's file.
    #[test]
    fn an_image_replaces_the_file_copy_of_its_bytes() {
        let dir = tempdir().unwrap();
        let mut staged = StagedAttachments::new(dir.path());
        let as_file = staged.stage_received_bytes("dot.bin", "application/octet-stream", &png()).unwrap();
        let bin = staged.get(&as_file.id).unwrap().path.clone();
        assert_eq!(bin.extension().unwrap(), "bin");
        let as_image = staged.stage_image("dot.png", "image/png", PNG, None).unwrap();
        let image_file = bin.with_extension("png");
        assert!(image_file.exists() && !bin.exists());
        assert_eq!(staged.get(&as_file.id).unwrap().path, image_file);
        assert_eq!(staged.get(&as_image.id).unwrap().path, image_file);
        assert_eq!(index(dir.path())["entries"][0]["mimeType"], "image/png");
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
        assert_eq!(staged.stage_received_file("a.png", "image/png", &kept, &digest).unwrap_err(), AttachmentError::Refused(SCREENSHOT_WRONG_TYPE));

        // Content whose file was lost is not counted as kept: the next upload of it is moved in afresh.
        fs::remove_file(&kept).unwrap();
        let third = uploads.join("three.part");
        fs::write(&third, bytes).unwrap();
        let again = staged.stage_received_file("clip.mp4", "video/mp4", &third, &digest).unwrap();
        assert_eq!(fs::read(&staged.get(&again.id).unwrap().path).unwrap(), bytes);
    }

    /// Content a read finds gone or changed is let go, file and index entry, and staging it again writes it afresh.
    #[test]
    fn content_a_read_finds_changed_is_let_go() {
        let dir = tempdir().unwrap();
        let mut staged = StagedAttachments::new(dir.path());
        let image = staged.stage_image("dot.png", "image/png", PNG, None).unwrap();
        let path = staged.content_path(&image.digest).unwrap();
        assert_eq!(staged.read_image(&image.digest), Some(("image/png".into(), png())));

        let mut changed = png();
        *changed.last_mut().unwrap() ^= 1;
        fs::write(&path, &changed).unwrap();
        assert_eq!(staged.read_image(&image.digest), None);
        assert_eq!(staged.content_path(&image.digest), None);
        assert!(!path.exists());
        assert_eq!(index(dir.path())["entries"].as_array().unwrap().len(), 0);
        staged.stage_image("dot.png", "image/png", PNG, None).unwrap();
        assert_eq!(fs::read(&path).unwrap(), png());

        // A reader outside the store reports content it found changed; content that reads as its digest is kept.
        staged.forget_unreadable(&image.digest);
        assert!(staged.content_path(&image.digest).is_some());
        fs::write(&path, b"changed").unwrap();
        staged.forget_unreadable(&image.digest);
        assert_eq!(staged.content_path(&image.digest), None);

        // Only an image is read back as content; a file draws no chip.
        let file = staged.stage_received_bytes("notes.txt", "text/plain", b"notes").unwrap();
        assert_eq!(staged.read_image(&file.digest), None);
        assert!(staged.content_path(&file.digest).is_some());
    }

    /// The folder is squared with Node's index at start as Node's `load` squares it.
    #[test]
    fn the_folder_is_squared_with_the_index_at_start() {
        let dir = tempdir().unwrap();
        let folder = dir.path().join("attachments");
        fs::create_dir_all(folder.join("uploads")).unwrap();
        let image = png();
        let image_digest = sha256_hex(&image);
        let video = b"a video Node kept".to_vec();
        let video_digest = sha256_hex(&video);
        let lost = b"a file a crash left out of the index".to_vec();
        let lost_digest = sha256_hex(&lost);
        let gone = "b".repeat(64);
        fs::write(folder.join(format!("{image_digest}.png")), &image).unwrap();
        fs::write(folder.join(format!("{image_digest}.bin")), &image).unwrap();
        fs::write(folder.join(format!("{video_digest}.bin")), &video).unwrap();
        fs::write(folder.join(format!("{lost_digest}.bin")), &lost).unwrap();
        fs::write(folder.join(format!("{}.png", "e".repeat(64))), b"").unwrap();
        fs::write(folder.join(format!("{video_digest}.bin.tmp-1-0f8c1d2e-3b4a-4c5d-8e6f-001122334455")), b"half").unwrap();
        fs::write(folder.join("stray.txt"), b"stray").unwrap();
        let saved = json!({ "version": 1, "entries": [
            { "digest": video_digest, "mimeType": "video/mp4", "sizeBytes": video.len(), "stagedAt": 1_700_000_000_000_u64 },
            { "digest": image_digest, "mimeType": "image/png", "sizeBytes": image.len(), "stagedAt": 1_700_000_000_001_u64 },
            { "digest": gone, "mimeType": "text/plain", "sizeBytes": 5, "stagedAt": 1 },
        ] });
        fs::write(folder.join("index.json"), saved.to_string()).unwrap();

        let staged = StagedAttachments::new(dir.path());
        assert_eq!(staged.content_path(&video_digest), Some(folder.join(format!("{video_digest}.bin"))));
        assert_eq!(staged.kept[&video_digest].mime_type, "video/mp4", "a video Node kept stays the video it was");
        assert_eq!(staged.content_path(&image_digest), Some(folder.join(format!("{image_digest}.png"))));
        assert_eq!(staged.kept[&lost_digest].mime_type, GENERIC_FILE_MIME_TYPE, "a file the index lost comes back with no type");
        assert_eq!(staged.content_path(&gone), None);
        let mut kept = vec!["index.json".to_string(), format!("{image_digest}.png"), format!("{video_digest}.bin"), format!("{lost_digest}.bin"), "uploads".into()];
        kept.sort();
        assert_eq!(names(&folder), kept, "copies, empty files, temporary and stray files go; folders stay");
        let rewritten = index(dir.path());
        let digests: Vec<&str> = rewritten["entries"].as_array().unwrap().iter().map(|e| e["digest"].as_str().unwrap()).collect();
        assert_eq!(digests, [video_digest.as_str(), image_digest.as_str(), lost_digest.as_str()], "the index's order, then what it lost");
        assert_eq!(rewritten["entries"][0]["stagedAt"], 1_700_000_000_000_u64);
    }

    /// An index Node's schema refuses whole is set aside rather than written over, and the folder's content is kept.
    #[test]
    fn an_unreadable_index_is_set_aside() {
        let dir = tempdir().unwrap();
        let folder = dir.path().join("attachments");
        fs::create_dir_all(&folder).unwrap();
        let notes = b"notes".to_vec();
        let digest = sha256_hex(&notes);
        fs::write(folder.join(format!("{digest}.bin")), &notes).unwrap();
        fs::write(folder.join("index.json"), "{ not json").unwrap();
        let staged = StagedAttachments::new(dir.path());
        assert!(staged.content_path(&digest).is_some());
        let aside: Vec<String> = names(&folder).into_iter().filter(|name| name.starts_with("index.json.corrupt-")).collect();
        assert_eq!(aside.len(), 1);
        assert_eq!(fs::read_to_string(folder.join(&aside[0])).unwrap(), "{ not json");
        assert_eq!(index(dir.path())["entries"][0]["digest"], digest);
    }

    /// Node's index is read as Node's schema reads each entry: one it refuses names nothing, and sizes are the files'.
    #[test]
    fn nodes_index_is_read_entry_by_entry() {
        let dir = tempdir().unwrap();
        let folder = dir.path().join("attachments");
        fs::create_dir_all(&folder).unwrap();
        let good = "a".repeat(64);
        let extra = "c".repeat(64);
        fs::write(folder.join(format!("{good}.bin")), b"12345").unwrap();
        fs::write(folder.join(format!("{extra}.bin")), b"12345").unwrap();
        let saved = json!({ "version": 1, "entries": [
            { "digest": good, "mimeType": "application/pdf", "sizeBytes": 9, "stagedAt": 1.5 },
            { "digest": extra, "mimeType": "text/plain", "sizeBytes": 5, "stagedAt": 1, "name": "secret" },
        ] });
        fs::write(folder.join("index.json"), saved.to_string()).unwrap();
        let staged = StagedAttachments::new(dir.path());
        assert_eq!(staged.kept[&good].mime_type, "application/pdf");
        assert_eq!(staged.kept[&good].size_bytes, 5, "the size the file has, as Node's load takes it");
        assert_eq!(staged.kept[&extra].mime_type, GENERIC_FILE_MIME_TYPE, "an entry Node refuses names no type");
        assert!(is_mime_type("application/vnd.ms-excel") && !is_mime_type("text") && !is_mime_type("/plain") && !is_mime_type("Text/plain"));
    }

    const NODE_STAGED_AT: u64 = 1_795_000_000_000;

    /// What Node's own store keeps in the fixture below: a picture, a file, and a video, each with the bytes it holds.
    fn node_content() -> Vec<(&'static str, Vec<u8>)> {
        vec![("image/png", png()), ("text/plain", b"Node's notes\n".to_vec()), ("video/mp4", b"Node's video bytes".to_vec())]
    }

    /// `attachments/index.json` as Node's store writes it for `node_content`.
    fn node_index() -> Value {
        let entries: Vec<Value> = node_content()
            .iter()
            .map(|(mime, bytes)| json!({ "digest": sha256_hex(bytes), "mimeType": mime, "sizeBytes": bytes.len(), "stagedAt": NODE_STAGED_AT }))
            .collect();
        json!({ "version": 1, "entries": entries })
    }

    /// Node's attachments survive a Rust load and save: every content stays, under its type, at its size, its staging
    /// time and its place in the index. With `SOTTO_SHARED_STORES_DIR`, the folder is the one Node's own store wrote.
    #[test]
    fn node_attachments_survive_a_rust_load_and_save() {
        crate::store_trip::round_trip("attachments/index.json", node_index, |dir| {
            if crate::store_trip::shared_dir().is_none() {
                for (mime, bytes) in node_content() {
                    fs::write(content_file(&dir.join("attachments"), &sha256_hex(&bytes), mime), bytes).unwrap();
                }
            }
            let staged = StagedAttachments::new(dir);
            let saved = read_index(&dir.join("attachments").join(INDEX_FILE));
            let Index::Read(entries) = saved else { panic!("Node's index reads") };
            for (digest, mime, _) in &entries {
                assert_eq!(staged.kept.get(digest).map(|kept| kept.mime_type.as_str()), Some(mime.as_str()), "{digest} is kept");
            }
            staged.write_index().unwrap();
        });
    }

    /// What `rust_created_attachments_reads_in_node` stages, which the TypeScript test checks Node reads back.
    const RUST_NOTES: &[u8] = b"Rust staged these notes\n";
    const RUST_VIDEO: &[u8] = b"Rust staged this video";

    /// A picture, a file and a video this host stages read in Node's own store, as the same content of the same types.
    #[test]
    fn rust_created_attachments_reads_in_node() {
        let written = crate::store_trip::created("attachments/index.json", |dir| {
            let mut staged = StagedAttachments::new(dir);
            staged.stage_image("dot.png", "image/png", PNG, None).unwrap();
            staged.stage_received_bytes("notes.txt", "text/plain", RUST_NOTES).unwrap();
            let part = upload_folder(dir).join("video.part");
            fs::create_dir_all(part.parent().unwrap()).unwrap();
            fs::write(&part, RUST_VIDEO).unwrap();
            staged.stage_received_file("clip.mp4", "video/mp4", &part, &sha256_hex(RUST_VIDEO)).unwrap();
        });
        let types: Vec<&str> = written["entries"].as_array().unwrap().iter().map(|e| e["mimeType"].as_str().unwrap()).collect();
        assert_eq!(types, ["image/png", "text/plain", "video/mp4"]);
    }
}
