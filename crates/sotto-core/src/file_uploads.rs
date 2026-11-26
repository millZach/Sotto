//! The parts of attached files on their way to this host (`file-staging` and `video-staging`, ADR-0131 and its
//! November 9 amendment), as Node's `FileUploads` (`src/host/fileUploads.ts`) takes them.
//!
//! A paired client holds one upload at a time, however many sockets it opens: a first part starts it, replacing any
//! other that client had under way, and parts come in order. A file's parts are kept in memory and let go two minutes
//! after the last one, when the client's last socket closes (`leave`), or once the last part arrives and the size and
//! digest are checked. A video's parts are written instead to a file of its own in the store's `uploads` folder, hashed
//! as they arrive, and the upload is kept ten minutes after its last part, its client gone or not, so the client can ask
//! `progress` and carry on. A part of one upload never joins another: each part names its whole file, and one that names
//! another file, or comes out of order, ends the upload. Nothing here reaches a log.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

use base64::alphabet;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use base64::Engine;
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::attachment_store::{is_mime_type, is_video_type, MAX_FILE_ATTACHMENT_BYTES, MAX_VIDEO_ATTACHMENT_BYTES};
use crate::protocol_fields::{hex, is_digest, utf16_len, whole_number};

/// The raw bytes one part carries at most, as Node's `HOST_FILE_PART_BYTES`.
pub const HOST_FILE_PART_BYTES: u64 = 8 * 1024 * 1024;
/// The most parts a file may take, as Node's `HOST_FILE_PARTS_MAX`: a 25 MiB file in 8 MiB parts.
pub const HOST_FILE_PARTS_MAX: u64 = (MAX_FILE_ATTACHMENT_BYTES as u64).div_ceil(HOST_FILE_PART_BYTES);
/// The most parts a video may take with `video-staging`, as Node's `HOST_VIDEO_PARTS_MAX`: 500 MiB in 8 MiB parts.
pub const HOST_VIDEO_PARTS_MAX: u64 = (MAX_VIDEO_ATTACHMENT_BYTES as u64).div_ceil(HOST_FILE_PART_BYTES);
/// The most base64 characters a part's `data` may have, as Node's schema allows.
const PART_DATA_MAX: usize = (HOST_FILE_PART_BYTES as usize).div_ceil(3) * 4;

/// How long a file's upload waits for its next part, as Node's `FILE_UPLOAD_IDLE_MS`.
pub const FILE_UPLOAD_IDLE_MS: u64 = 2 * 60_000;
/// How long a video's upload is kept after its last part, as Node's `VIDEO_UPLOAD_IDLE_MS`.
pub const VIDEO_UPLOAD_IDLE_MS: u64 = 10 * 60_000;

/// Node's refusals of an upload (`src/shared/agents.ts`), which the client is shown.
pub const FILE_UPLOAD_INCOMPLETE: &str = "This file did not reach the host whole. Nothing was attached. Attach it again.";
pub const FILE_UPLOAD_MISMATCH: &str = "This file changed on its way to the host. Nothing was attached. Attach it again.";
/// What a host that does not offer `video-staging` answers a video larger than a file, as Node's `HOST_CANNOT_STAGE_VIDEOS`.
pub const HOST_CANNOT_STAGE_VIDEOS: &str =
    "This host cannot keep videos over 25 MB yet. Update Sotto there, then attach this one again. Nothing was attached.";

/// An upload ID as Node's `z.uuid()` reads one: an RFC 9562 UUID of versions 1 to 8, or the nil or max UUID.
pub fn is_upload_id(text: &str) -> bool {
    if text == "00000000-0000-0000-0000-000000000000" || text.eq_ignore_ascii_case("ffffffff-ffff-ffff-ffff-ffffffffffff") {
        return true;
    }
    let bytes = text.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (at, byte) in bytes.iter().enumerate() {
        let dash = matches!(at, 8 | 13 | 18 | 23);
        if dash != (*byte == b'-') || (!dash && !byte.is_ascii_hexdigit()) {
            return false;
        }
    }
    matches!(bytes[14], b'1'..=b'8') && matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
}

/// One part of a file on its way here, as Node's `hostFilePartSchema` reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilePart {
    pub upload_id: String,
    pub index: u64,
    pub count: u64,
    /// The name as the schema leaves it: trimmed.
    pub name: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub digest: String,
    pub data: String,
}

impl FilePart {
    /// Whether this is a part of a video larger than a file may be, which only a host offering `video-staging` takes,
    /// as Node's `isLargeVideoPart`.
    pub fn is_large_video(&self) -> bool {
        self.size_bytes > MAX_FILE_ATTACHMENT_BYTES as u64 || self.count > HOST_FILE_PARTS_MAX
    }
}

/// The `part` of a `stage-file-part` request, or `None` when Node's strict schema refuses it.
pub fn file_part(value: Option<&Value>) -> Option<FilePart> {
    let fields = value?.as_object()?;
    let allowed = ["uploadId", "index", "count", "name", "mimeType", "sizeBytes", "digest", "data"];
    if fields.keys().any(|key| !allowed.contains(&key.as_str())) {
        return None;
    }
    let upload_id = fields.get("uploadId")?.as_str().filter(|id| is_upload_id(id))?;
    let index = whole_number(fields.get("index")?).filter(|index| *index < HOST_VIDEO_PARTS_MAX)?;
    let count = whole_number(fields.get("count")?).filter(|count| (1..=HOST_VIDEO_PARTS_MAX).contains(count))?;
    // zod's `trim()` trims the JavaScript way, and its lengths count UTF-16 code units.
    let name = fields.get("name")?.as_str()?.trim_matches(is_js_space);
    if !(1..=255).contains(&utf16_len(name)) {
        return None;
    }
    let mime_type = fields.get("mimeType")?.as_str().filter(|mime| is_mime_type(mime))?;
    let size_bytes = whole_number(fields.get("sizeBytes")?).filter(|size| (1..=MAX_VIDEO_ATTACHMENT_BYTES as u64).contains(size))?;
    let digest = fields.get("digest")?.as_str().filter(|digest| is_digest(digest))?;
    let data = fields.get("data")?.as_str().filter(|data| is_part_data(data))?;
    if index >= count {
        return None;
    }
    if !is_video_type(mime_type) && (size_bytes > MAX_FILE_ATTACHMENT_BYTES as u64 || count > HOST_FILE_PARTS_MAX) {
        return None;
    }
    Some(FilePart {
        upload_id: upload_id.to_string(),
        index,
        count,
        name: name.to_string(),
        mime_type: mime_type.to_string(),
        size_bytes,
        digest: digest.to_string(),
        data: data.to_string(),
    })
}

/// The `uploadId` of a `file-upload-progress` request, which names nothing else, or `None` when Node's schema refuses it.
pub fn progress_request(fields: &serde_json::Map<String, Value>) -> Option<String> {
    if fields.keys().any(|key| key != "uploadId") {
        return None;
    }
    fields.get("uploadId")?.as_str().filter(|id| is_upload_id(id)).map(ToString::to_string)
}

/// The white space JavaScript's `trim` removes: what `char::is_whitespace` calls white space, and the byte order mark.
fn is_js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// A part's `data` as Node's schema takes it: 1 to `PART_DATA_MAX` characters of base64, padded or not.
fn is_part_data(data: &str) -> bool {
    if data.is_empty() || data.len() > PART_DATA_MAX {
        return false;
    }
    let body = data.trim_end_matches('=');
    data.len() - body.len() <= 2 && body.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

/// The bytes of base64 as Node's `Buffer.from(data, 'base64')` reads them, which takes padding or none and a dangling
/// last character, which carries no whole byte.
fn node_base64(data: &str) -> Vec<u8> {
    const LENIENT: GeneralPurpose = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true).with_decode_padding_mode(DecodePaddingMode::RequireNone),
    );
    let mut body = data.trim_end_matches('=');
    if body.len() % 4 == 1 {
        body = &body[..body.len() - 1];
    }
    LENIENT.decode(body).unwrap_or_default()
}

/// A file whose every part has arrived and checks out.
#[derive(Debug, PartialEq, Eq)]
pub enum Received {
    /// A file's bytes, held in memory.
    File { name: String, mime_type: String, bytes: Vec<u8> },
    /// A video on disk at `path`, whose size and digest were checked; the store moves it in.
    Video { name: String, mime_type: String, path: PathBuf, digest: String },
}

/// Why a part was not taken: refused, in words the client is shown, or the host's failure to keep it.
#[derive(Debug, PartialEq, Eq)]
pub enum PartFailed {
    Refused(&'static str),
    Failed,
}

/// The whole file an upload's parts name.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Whole {
    upload_id: String,
    count: u64,
    name: String,
    mime_type: String,
    size_bytes: u64,
    digest: String,
}

impl Whole {
    fn of(part: &FilePart) -> Self {
        Self {
            upload_id: part.upload_id.clone(),
            count: part.count,
            name: part.name.clone(),
            mime_type: part.mime_type.clone(),
            size_bytes: part.size_bytes,
            digest: part.digest.clone(),
        }
    }

    /// Whether a part names this same file, as Node's `sameFile`.
    fn names(&self, part: &FilePart) -> bool {
        self.count == part.count
            && self.name == part.name
            && self.mime_type == part.mime_type
            && self.size_bytes == part.size_bytes
            && self.digest == part.digest
    }
}

/// A video's parts on disk: the file they go to and their hash so far.
struct Disk {
    path: PathBuf,
    file: fs::File,
    hash: Sha256,
}

struct Upload {
    whole: Whole,
    next: u64,
    received: u64,
    last_part_at: u64,
    chunks: Vec<u8>,
    disk: Option<Disk>,
}

impl Upload {
    fn idle_ms(&self) -> u64 {
        if self.disk.is_some() {
            VIDEO_UPLOAD_IDLE_MS
        } else {
            FILE_UPLOAD_IDLE_MS
        }
    }
}

/// Every paired client's upload, by its client ID (see the module's words). Times are milliseconds, given by the caller.
pub struct FileUploads {
    uploads: HashMap<String, Upload>,
    video_folder: Option<PathBuf>,
}

impl FileUploads {
    /// Uploads whose videos' parts go to `video_folder`; without one, a video's parts are held in memory as a file's are.
    pub fn new(video_folder: Option<PathBuf>) -> Self {
        Self { uploads: HashMap::new(), video_folder }
    }

    /// Takes one part of a client's upload: `None` while parts are still to come, the whole file once the last has
    /// arrived and its size and digest are the ones its parts named.
    pub fn receive_part(&mut self, client: &str, part: &FilePart, now: u64) -> Result<Option<Received>, PartFailed> {
        let to_disk = self.video_folder.is_some() && is_video_type(&part.mime_type);
        if let Some(upload) = self.uploads.get(client) {
            let idle = if to_disk { upload.idle_ms() } else { FILE_UPLOAD_IDLE_MS };
            if now.saturating_sub(upload.last_part_at) >= idle {
                self.drop_upload(client);
            }
        }
        if part.index == 0 {
            self.drop_upload(client);
            let disk = if to_disk { Some(self.open_part_file()?) } else { None };
            self.uploads.insert(
                client.to_string(),
                Upload { whole: Whole::of(part), next: 0, received: 0, last_part_at: now, chunks: Vec::new(), disk },
            );
        } else {
            let Some(upload) = self.uploads.get(client) else {
                return Err(PartFailed::Refused(FILE_UPLOAD_INCOMPLETE));
            };
            // A stray part of an upload this host no longer holds leaves the one under way alone.
            if upload.whole.upload_id != part.upload_id || (to_disk && upload.disk.is_none()) {
                return Err(PartFailed::Refused(FILE_UPLOAD_INCOMPLETE));
            }
            if part.index != upload.next || !upload.whole.names(part) {
                self.drop_upload(client);
                return Err(PartFailed::Refused(FILE_UPLOAD_INCOMPLETE));
            }
        }
        let data = node_base64(&part.data);
        let upload = self.uploads.get_mut(client).expect("the upload was just found or made");
        if data.len() as u64 > HOST_FILE_PART_BYTES || upload.received + data.len() as u64 > upload.whole.size_bytes {
            self.drop_upload(client);
            return Err(PartFailed::Refused(FILE_UPLOAD_INCOMPLETE));
        }
        match upload.disk.as_mut() {
            Some(disk) => {
                if disk.file.write_all(&data).is_err() {
                    self.drop_upload(client);
                    return Err(PartFailed::Failed);
                }
                disk.hash.update(&data);
            }
            None => upload.chunks.extend_from_slice(&data),
        }
        upload.received += data.len() as u64;
        upload.next += 1;
        upload.last_part_at = now;
        if upload.next < upload.whole.count {
            return Ok(None);
        }
        let upload = self.uploads.remove(client).expect("the upload is held");
        let whole = upload.whole;
        match upload.disk {
            Some(disk) => {
                let synced = disk.file.sync_all();
                drop(disk.file);
                if synced.is_err() {
                    let _ = fs::remove_file(&disk.path);
                    return Err(PartFailed::Failed);
                }
                if upload.received != whole.size_bytes || hex(&disk.hash.finalize()) != whole.digest {
                    let _ = fs::remove_file(&disk.path);
                    return Err(PartFailed::Refused(FILE_UPLOAD_MISMATCH));
                }
                Ok(Some(Received::Video { name: whole.name, mime_type: whole.mime_type, path: disk.path, digest: whole.digest }))
            }
            None => {
                if upload.chunks.len() as u64 != whole.size_bytes || hex(&Sha256::digest(&upload.chunks)) != whole.digest {
                    return Err(PartFailed::Refused(FILE_UPLOAD_MISMATCH));
                }
                Ok(Some(Received::File { name: whole.name, mime_type: whole.mime_type, bytes: upload.chunks }))
            }
        }
    }

    /// A new file for a video's parts, of a random name in the uploads folder, readable by this user alone.
    fn open_part_file(&self) -> Result<Disk, PartFailed> {
        let folder = self.video_folder.as_ref().ok_or(PartFailed::Failed)?;
        fs::create_dir_all(folder).map_err(|_| PartFailed::Failed)?;
        let path = folder.join(format!("{}.part", Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&path).map_err(|_| PartFailed::Failed)?;
        Ok(Disk { path, file, hash: Sha256::new() })
    }

    /// How many parts of `upload_id` the host holds for this client, the next part it should send, or `None` when it
    /// holds none of them, as Node's `progress`.
    pub fn progress(&self, client: &str, upload_id: &str, now: u64) -> Option<u64> {
        let upload = self.uploads.get(client)?;
        if upload.whole.upload_id != upload_id || upload.next < 1 || now.saturating_sub(upload.last_part_at) >= upload.idle_ms() {
            return None;
        }
        Some(upload.next)
    }

    /// A client's last socket closed: a file's upload goes, and a video's is kept until its own wait is over.
    pub fn leave(&mut self, client: &str) {
        if self.uploads.get(client).is_some_and(|upload| upload.disk.is_none()) {
            self.drop_upload(client);
        }
    }

    /// Lets go of every upload whose wait is over, as Node's timer after each part does; a video's part file goes with it.
    pub fn sweep(&mut self, now: u64) {
        let idle: Vec<String> = self
            .uploads
            .iter()
            .filter(|(_, upload)| now.saturating_sub(upload.last_part_at) >= upload.idle_ms())
            .map(|(client, _)| client.clone())
            .collect();
        for client in idle {
            self.drop_upload(&client);
        }
    }

    /// Lets go of a client's upload; a video's part file goes with it.
    fn drop_upload(&mut self, client: &str) {
        if let Some(upload) = self.uploads.remove(client) {
            if let Some(disk) = upload.disk {
                drop(disk.file);
                let _ = fs::remove_file(&disk.path);
            }
        }
    }

    /// Whether a client has an upload under way.
    pub fn holds(&self, client: &str) -> bool {
        self.uploads.contains_key(client)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;
    use serde_json::json;
    use tempfile::tempdir;

    const UPLOAD: &str = "3f0c8a52-6c1e-4f5d-9b7a-2d4e6f8a0b1c";
    const OTHER: &str = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";

    fn part(upload_id: &str, index: u64, count: u64, mime: &str, whole: &[u8], data: &[u8]) -> FilePart {
        FilePart {
            upload_id: upload_id.into(),
            index,
            count,
            name: "clip".into(),
            mime_type: mime.into(),
            size_bytes: whole.len() as u64,
            digest: hex(&Sha256::digest(whole)),
            data: STANDARD.encode(data),
        }
    }

    fn part_files(folder: &std::path::Path) -> usize {
        fs::read_dir(folder).map(|names| names.count()).unwrap_or(0)
    }

    #[test]
    fn parts_are_read_as_nodes_schema_reads_them() {
        let good = json!({ "uploadId": UPLOAD, "index": 0, "count": 1, "name": "  notes.txt ", "mimeType": "text/plain",
            "sizeBytes": 5, "digest": "a".repeat(64), "data": "cHJvYmU=" });
        let read = file_part(Some(&good)).unwrap();
        assert_eq!(read.name, "notes.txt");
        assert!(!read.is_large_video());
        let with = |key: &str, value: Value| {
            let mut changed = good.clone();
            changed[key] = value;
            file_part(Some(&changed))
        };
        assert_eq!(with("uploadId", json!("not-a-uuid")), None);
        assert_eq!(with("uploadId", json!("3f0c8a52-6c1e-9f5d-9b7a-2d4e6f8a0b1c")), None, "version 9 is no UUID to zod");
        assert_eq!(with("index", json!(1)), None, "a part must be one of its upload's parts");
        assert_eq!(with("name", json!("   ")), None);
        assert_eq!(with("mimeType", json!("Text/Plain")), None);
        assert_eq!(with("digest", json!("A".repeat(64))), None);
        assert_eq!(with("data", json!("")), None);
        assert_eq!(with("data", json!("cH=JvYmU")), None);
        assert_eq!(with("more", json!(1)), None);
        // Only a video may be larger than a file, and in more than four parts.
        assert_eq!(with("sizeBytes", json!(MAX_FILE_ATTACHMENT_BYTES + 1)), None);
        let mut video = good.clone();
        video["mimeType"] = json!("video/mp4");
        video["sizeBytes"] = json!(MAX_FILE_ATTACHMENT_BYTES + 1);
        video["count"] = json!(4);
        assert!(file_part(Some(&video)).unwrap().is_large_video());
        video["sizeBytes"] = json!(5);
        video["count"] = json!(5);
        assert!(file_part(Some(&video)).unwrap().is_large_video());
        video["count"] = json!(HOST_VIDEO_PARTS_MAX + 1);
        assert_eq!(file_part(Some(&video)), None);
        assert_eq!(HOST_FILE_PARTS_MAX, 4);
        assert_eq!(HOST_VIDEO_PARTS_MAX, 63);

        let progress = |value: Value| progress_request(value.as_object().unwrap());
        assert_eq!(progress(json!({ "uploadId": UPLOAD })), Some(UPLOAD.into()));
        assert_eq!(progress(json!({ "uploadId": "x" })), None);
        assert_eq!(progress(json!({ "uploadId": UPLOAD, "more": 1 })), None);
        assert!(is_upload_id("00000000-0000-0000-0000-000000000000") && is_upload_id("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"));
        assert_eq!(node_base64("cHJvYmU"), b"probe", "Node reads base64 without its padding");
    }

    /// A file arrives in parts in memory, and comes out whole only when its size and digest are the ones it named.
    #[test]
    fn a_file_arrives_in_parts_and_is_checked() {
        let mut uploads = FileUploads::new(None);
        let whole = b"first-second";
        assert_eq!(uploads.receive_part("c", &part(UPLOAD, 0, 2, "text/plain", whole, b"first-"), 0), Ok(None));
        assert_eq!(uploads.progress("c", UPLOAD, 1), Some(1));
        let done = uploads.receive_part("c", &part(UPLOAD, 1, 2, "text/plain", whole, b"second"), 2).unwrap();
        assert_eq!(done, Some(Received::File { name: "clip".into(), mime_type: "text/plain".into(), bytes: whole.to_vec() }));
        assert!(!uploads.holds("c"));

        // The same size but other bytes is not the file the parts named.
        let other = b"first-SECOND";
        uploads.receive_part("c", &part(UPLOAD, 0, 2, "text/plain", whole, b"first-"), 0).unwrap();
        let mismatch = uploads.receive_part("c", &part(UPLOAD, 1, 2, "text/plain", whole, &other[6..]), 1);
        assert_eq!(mismatch, Err(PartFailed::Refused(FILE_UPLOAD_MISMATCH)));
        assert!(!uploads.holds("c"));
    }

    /// No upload takes a part of another file: a stray part is refused and leaves the upload alone, and a part that names
    /// another file or comes out of order ends it.
    #[test]
    fn parts_of_two_files_never_mix() {
        let mut uploads = FileUploads::new(None);
        let whole = b"aaaabbbbcccc";
        uploads.receive_part("c", &part(UPLOAD, 0, 3, "text/plain", whole, b"aaaa"), 0).unwrap();
        assert_eq!(uploads.receive_part("c", &part(OTHER, 1, 3, "text/plain", whole, b"bbbb"), 1), Err(PartFailed::Refused(FILE_UPLOAD_INCOMPLETE)));
        assert_eq!(uploads.progress("c", UPLOAD, 1), Some(1), "a stray part leaves the upload under way alone");
        let mut renamed = part(UPLOAD, 1, 3, "text/plain", whole, b"bbbb");
        renamed.name = "other".into();
        assert_eq!(uploads.receive_part("c", &renamed, 2), Err(PartFailed::Refused(FILE_UPLOAD_INCOMPLETE)));
        assert!(!uploads.holds("c"));

        uploads.receive_part("c", &part(UPLOAD, 0, 3, "text/plain", whole, b"aaaa"), 0).unwrap();
        assert_eq!(uploads.receive_part("c", &part(UPLOAD, 2, 3, "text/plain", whole, b"cccc"), 1), Err(PartFailed::Refused(FILE_UPLOAD_INCOMPLETE)));
        assert!(!uploads.holds("c"));

        // A part carrying more than the file named ends the upload; a first part starts again, replacing any other.
        uploads.receive_part("c", &part(UPLOAD, 0, 3, "text/plain", whole, b"aaaa"), 0).unwrap();
        assert_eq!(uploads.receive_part("c", &part(UPLOAD, 1, 3, "text/plain", whole, b"bbbbbbbbbb"), 1), Err(PartFailed::Refused(FILE_UPLOAD_INCOMPLETE)));
        uploads.receive_part("c", &part(UPLOAD, 0, 3, "text/plain", whole, b"aaaa"), 0).unwrap();
        uploads.receive_part("c", &part(OTHER, 0, 1, "text/plain", b"x", b"x"), 1).unwrap();
        assert_eq!(uploads.progress("c", UPLOAD, 1), None);
        // Each client holds its own upload.
        uploads.receive_part("d", &part(UPLOAD, 0, 3, "text/plain", whole, b"aaaa"), 0).unwrap();
        assert_eq!(uploads.progress("d", UPLOAD, 1), Some(1));
        assert_eq!(uploads.progress("c", UPLOAD, 1), None);
    }

    /// A file's upload goes when its client leaves or two minutes after its last part.
    #[test]
    fn a_files_upload_goes_when_its_client_leaves_or_waits_too_long() {
        let mut uploads = FileUploads::new(None);
        let whole = b"aaaabbbb";
        uploads.receive_part("c", &part(UPLOAD, 0, 2, "text/plain", whole, b"aaaa"), 0).unwrap();
        uploads.leave("c");
        assert!(!uploads.holds("c"));
        uploads.receive_part("c", &part(UPLOAD, 0, 2, "text/plain", whole, b"aaaa"), 0).unwrap();
        assert_eq!(uploads.progress("c", UPLOAD, FILE_UPLOAD_IDLE_MS - 1), Some(1));
        assert_eq!(uploads.progress("c", UPLOAD, FILE_UPLOAD_IDLE_MS), None);
        assert_eq!(uploads.receive_part("c", &part(UPLOAD, 1, 2, "text/plain", whole, b"bbbb"), FILE_UPLOAD_IDLE_MS), Err(PartFailed::Refused(FILE_UPLOAD_INCOMPLETE)));
        assert!(!uploads.holds("c"));
    }

    /// A video's parts go to a file of their own, its progress can be asked after its client left, it is kept ten minutes
    /// after its last part, and once every part is in it comes out on disk, checked.
    #[test]
    fn a_video_is_staged_in_parts_on_disk() {
        let dir = tempdir().unwrap();
        let folder = dir.path().join("attachments").join("uploads");
        let mut uploads = FileUploads::new(Some(folder.clone()));
        let whole = b"frame-one|frame-two|frame-three";
        let pieces: [&[u8]; 3] = [&whole[..10], &whole[10..20], &whole[20..]];
        uploads.receive_part("c", &part(UPLOAD, 0, 3, "video/mp4", whole, pieces[0]), 0).unwrap();
        assert_eq!(part_files(&folder), 1);
        uploads.leave("c");
        assert_eq!(uploads.progress("c", UPLOAD, 1), Some(1), "a video's upload outlasts its client's sockets");
        assert_eq!(uploads.progress("c", OTHER, 1), None);
        uploads.receive_part("c", &part(UPLOAD, 1, 3, "video/mp4", whole, pieces[1]), FILE_UPLOAD_IDLE_MS + 5).unwrap();
        assert_eq!(uploads.progress("c", UPLOAD, VIDEO_UPLOAD_IDLE_MS), Some(2));
        let done = uploads.receive_part("c", &part(UPLOAD, 2, 3, "video/mp4", whole, pieces[2]), VIDEO_UPLOAD_IDLE_MS).unwrap();
        let Some(Received::Video { path, digest, .. }) = done else { panic!("the video comes out on disk") };
        assert_eq!(fs::read(&path).unwrap(), whole);
        assert_eq!(digest, hex(&Sha256::digest(whole)));
        assert_eq!(path.parent(), Some(folder.as_path()));
        fs::remove_file(path).unwrap();

        // One that changed on its way is refused and its file goes.
        uploads.receive_part("c", &part(UPLOAD, 0, 2, "video/mp4", b"aaaabbbb", b"aaaa"), 0).unwrap();
        let changed = part(UPLOAD, 1, 2, "video/mp4", b"aaaabbbb", b"bbbX");
        assert_eq!(uploads.receive_part("c", &changed, 1), Err(PartFailed::Refused(FILE_UPLOAD_MISMATCH)));
        assert_eq!(part_files(&folder), 0);

        // One whose wait is over goes, its file with it.
        uploads.receive_part("c", &part(UPLOAD, 0, 2, "video/mp4", b"aaaabbbb", b"aaaa"), 0).unwrap();
        uploads.sweep(VIDEO_UPLOAD_IDLE_MS - 1);
        assert!(uploads.holds("c"));
        uploads.sweep(VIDEO_UPLOAD_IDLE_MS);
        assert!(!uploads.holds("c"));
        assert_eq!(part_files(&folder), 0);
    }
}
