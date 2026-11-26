//! One part of a file a sent message carries, for the iPhone's Quick Look (`attachment-files`, ADR-0131, October 25
//! amendment), read for the `attachment-file` host operation as Node's `AttachmentPreviews.filePart`
//! (`src/main/agents/attachmentPreviews.ts`) reads it.
//!
//! A file is found by its message, so a client reads only what a thread it reads carries: the user message this host
//! recorded when it sent the handles staged for it, by its ID, in a thread this host holds. Only an attachment that
//! message carries is read, never an image (which `preview` serves) and never a video larger than a file may be. Its
//! bytes come from the attachment store's file for the handle's digest, read whole and checked against that digest
//! before any part of it is answered, so a part is never cut from bytes that are not the file the message sent.

use std::fs;
use std::io::{ErrorKind, Read};
use std::path::Path;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use chrono::DateTime;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::attachment_store::{is_image_type, is_mime_type, MAX_FILE_ATTACHMENT_BYTES};
use crate::file_uploads::{HOST_FILE_PARTS_MAX, HOST_FILE_PART_BYTES};
use crate::protocol_fields::{hex, is_digest, protocol_id, utf16_len, whole_number};
use crate::stores::StoredMessage;

/// How long a sent message's attachments may be read, as Node's `ATTACHMENT_PREVIEW_RETENTION_MS`: seven days.
pub const ATTACHMENT_PREVIEW_RETENTION_MS: i64 = 7 * 86_400_000;

/// An `attachment-file` request as Node's strict `hostAttachmentFileRequestSchema` reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentFileRequest {
    pub thread_id: String,
    pub message_id: String,
    pub attachment_id: String,
    pub part: u64,
}

impl AttachmentFileRequest {
    /// The feature a host offers for this read.
    pub fn feature(&self) -> &'static str {
        "attachment-files"
    }
}

/// The `request` of an `attachment-file` operation, or `None` when Node's strict schema refuses it.
pub fn attachment_file_request(value: Option<&Value>) -> Option<AttachmentFileRequest> {
    let fields = value?.as_object()?;
    if fields.keys().any(|key| !matches!(key.as_str(), "threadId" | "messageId" | "attachmentId" | "part")) {
        return None;
    }
    Some(AttachmentFileRequest {
        thread_id: protocol_id(fields.get("threadId"))?,
        message_id: protocol_id(fields.get("messageId"))?,
        attachment_id: protocol_id(fields.get("attachmentId"))?,
        part: whole_number(fields.get("part")?).filter(|part| *part < HOST_FILE_PARTS_MAX)?,
    })
}

/// A file a sent message carries, as its handle names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SentFile {
    pub name: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub digest: String,
}

/// The file `attachment_id` names among the attachments `message` was sent with, when a client may read it: a user
/// message this host sent, within the seven days Node keeps what a message carried, whose handle is a file, not an
/// image, of no more than a file's 25 MiB. `now_ms` is the time of the read.
pub fn sent_file(message: &StoredMessage, attachment_id: &str, now_ms: i64) -> Option<SentFile> {
    // Only the user message that submitted the handles names them: this host records them on its own sends alone.
    if message.role != "user" || message.command_id.is_none() {
        return None;
    }
    let sent_at = DateTime::parse_from_rfc3339(&message.created_at).ok()?.timestamp_millis();
    if sent_at <= now_ms - ATTACHMENT_PREVIEW_RETENTION_MS || sent_at > now_ms {
        return None;
    }
    let handle = message.attachments.as_ref()?.as_array()?.iter().find(|item| {
        item.get("id").and_then(Value::as_str) == Some(attachment_id)
            && item.get("mimeType").and_then(Value::as_str).is_some_and(|mime| !is_image_type(mime))
    })?;
    let name = handle.get("name")?.as_str().filter(|name| (1..=255).contains(&utf16_len(name)))?;
    let mime_type = handle.get("mimeType")?.as_str().filter(|mime| is_mime_type(mime))?;
    // A video larger than a file may be stays on its computer: the phone shows a sent video and never fetches it back.
    let size_bytes = whole_number(handle.get("sizeBytes")?).filter(|size| (1..=MAX_FILE_ATTACHMENT_BYTES as u64).contains(size))?;
    let digest = handle.get("digest")?.as_str().filter(|digest| is_digest(digest))?;
    Some(SentFile { name: name.to_string(), mime_type: mime_type.to_string(), size_bytes, digest: digest.to_string() })
}

/// A part read the host failed at, which Node's socket server answers as `unavailable`.
#[derive(Debug, PartialEq, Eq)]
pub struct AttachmentReadFailed;

/// Part `part` of a sent file whose content the store keeps at `path` (`None` when it keeps none): at most 8 MiB of its
/// bytes in base64, with what the whole file is so the client can check it once every part is in. Null for a part past
/// the last, and for content that is gone, has another size, or whose bytes are no longer the file's digest.
pub fn read_part(path: Option<&Path>, file: &SentFile, part: u64) -> Result<Value, AttachmentReadFailed> {
    let parts = file.size_bytes.div_ceil(HOST_FILE_PART_BYTES).max(1);
    let Some(path) = path.filter(|_| part < parts) else {
        return Ok(Value::Null);
    };
    let mut opened = match fs::File::open(path) {
        Ok(opened) => opened,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(Value::Null),
        // A folder of that name is no content the store keeps; Windows refuses to open one as a file.
        Err(_) if path.is_dir() => return Ok(Value::Null),
        Err(_) => return Err(AttachmentReadFailed),
    };
    let metadata = opened.metadata().map_err(|_| AttachmentReadFailed)?;
    if !metadata.is_file() || metadata.len() != file.size_bytes {
        return Ok(Value::Null);
    }
    // At most one byte more than its size: a file that grew is not its digest, and is never read past the limit.
    let mut bytes = Vec::with_capacity(file.size_bytes as usize + 1);
    (&mut opened).take(file.size_bytes + 1).read_to_end(&mut bytes).map_err(|_| AttachmentReadFailed)?;
    if hex(&Sha256::digest(&bytes)) != file.digest {
        return Ok(Value::Null);
    }
    let start = (part * HOST_FILE_PART_BYTES) as usize;
    let end = (start + HOST_FILE_PART_BYTES as usize).min(bytes.len());
    Ok(json!({
        "name": file.name,
        "mimeType": file.mime_type,
        "sizeBytes": file.size_bytes,
        "digest": file.digest,
        "part": part,
        "parts": parts,
        "data": STANDARD.encode(&bytes[start..end]),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};
    use tempfile::tempdir;

    const NOW: i64 = 1_795_000_000_000;

    fn at(ms: i64) -> String {
        Utc.timestamp_millis_opt(ms).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    fn message(attachments: Value) -> StoredMessage {
        StoredMessage {
            id: "m1".into(),
            role: "user".into(),
            text: "Here".into(),
            created_at: at(NOW - 60_000),
            command_id: Some("c1".into()),
            turn_message_id: None,
            attachments: Some(attachments),
            watcher_own_change: None,
            watcher_observed_changes: None,
            provider_error: None,
        }
    }

    fn handle(id: &str, mime: &str, size: u64, digest: &str) -> Value {
        json!({ "id": id, "name": "notes.txt", "mimeType": mime, "sizeBytes": size, "digest": digest })
    }

    #[test]
    fn requests_are_read_as_nodes_schema_reads_them() {
        let good = json!({ "threadId": "t", "messageId": "m", "attachmentId": "a", "part": 3 });
        assert_eq!(attachment_file_request(Some(&good)).unwrap().part, 3);
        for bad in [
            json!({ "threadId": "t", "messageId": "m", "attachmentId": "a", "part": 4 }),
            json!({ "threadId": "t", "messageId": "m", "attachmentId": "a", "part": 1.5 }),
            json!({ "threadId": "t", "messageId": "m", "attachmentId": "", "part": 0 }),
            json!({ "threadId": "t", "messageId": "m", "part": 0 }),
            json!({ "threadId": "t", "messageId": "m", "attachmentId": "a", "part": 0, "digest": "x" }),
        ] {
            assert_eq!(attachment_file_request(Some(&bad)), None, "{bad}");
        }
    }

    /// Only a file the named user message was sent with is read: never an image, a large video, another message's
    /// attachment, a reply's, or one older than seven days.
    #[test]
    fn only_a_file_the_message_carries_is_read() {
        let digest = "d".repeat(64);
        let sent = message(json!([handle("img", "image/png", 5, &digest), handle("doc", "text/plain", 5, &digest)]));
        let file = sent_file(&sent, "doc", NOW).unwrap();
        assert_eq!((file.mime_type.as_str(), file.size_bytes, file.digest.as_str()), ("text/plain", 5, digest.as_str()));
        assert_eq!(sent_file(&sent, "img", NOW), None, "an image is preview's");
        assert_eq!(sent_file(&sent, "other", NOW), None);

        let video = message(json!([handle("v", "video/mp4", MAX_FILE_ATTACHMENT_BYTES as u64 + 1, &digest)]));
        assert_eq!(sent_file(&video, "v", NOW), None);
        let small_video = message(json!([handle("v", "video/mp4", 5, &digest)]));
        assert!(sent_file(&small_video, "v", NOW).is_some());

        let mut reply = sent.clone();
        reply.role = "assistant".into();
        assert_eq!(sent_file(&reply, "doc", NOW), None);
        let mut unsent = sent.clone();
        unsent.command_id = None;
        assert_eq!(sent_file(&unsent, "doc", NOW), None, "a message this host did not send names nothing it keeps");
        let mut old = sent.clone();
        old.created_at = at(NOW - ATTACHMENT_PREVIEW_RETENTION_MS);
        assert_eq!(sent_file(&old, "doc", NOW), None);
        old.created_at = at(NOW - ATTACHMENT_PREVIEW_RETENTION_MS + 1);
        assert!(sent_file(&old, "doc", NOW).is_some());
        // A handle without a digest, as a reference Node keeps on its messages, names no content.
        let reference = message(json!([{ "id": "doc", "name": "notes.txt", "mimeType": "text/plain", "sizeBytes": 5 }]));
        assert_eq!(sent_file(&reference, "doc", NOW), None);
    }

    /// A file is answered in 8 MiB parts with its last part shorter, and nothing past its last part.
    #[test]
    fn a_file_is_read_in_parts() {
        let dir = tempdir().unwrap();
        let bytes: Vec<u8> = (0..(HOST_FILE_PART_BYTES as usize * 2 + 10)).map(|i| (i % 251) as u8).collect();
        let path = dir.path().join("content.bin");
        fs::write(&path, &bytes).unwrap();
        let file = SentFile { name: "big.log".into(), mime_type: "text/plain".into(), size_bytes: bytes.len() as u64, digest: hex(&Sha256::digest(&bytes)) };
        let mut joined = Vec::new();
        for part in 0..3 {
            let answer = read_part(Some(&path), &file, part).unwrap();
            assert_eq!((answer["part"].as_u64(), answer["parts"].as_u64()), (Some(part), Some(3)));
            assert_eq!(answer["sizeBytes"], bytes.len());
            joined.extend(STANDARD.decode(answer["data"].as_str().unwrap()).unwrap());
        }
        assert_eq!(joined.len(), bytes.len());
        assert_eq!(joined, bytes);
        assert_eq!(read_part(Some(&path), &file, 3), Ok(Value::Null), "a part past the end");

        let small = dir.path().join("small.bin");
        fs::write(&small, b"12345").unwrap();
        let file = SentFile { name: "s".into(), mime_type: "text/plain".into(), size_bytes: 5, digest: hex(&Sha256::digest(b"12345")) };
        let answer = read_part(Some(&small), &file, 0).unwrap();
        assert_eq!((answer["parts"].as_u64(), answer["data"].as_str()), (Some(1), Some("MTIzNDU=")));
        assert_eq!(read_part(Some(&small), &file, 1), Ok(Value::Null));
    }

    /// Content that is gone, that changed, or that has another size is no part of the file the message sent.
    #[test]
    fn a_changed_or_missing_file_answers_nothing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("content.bin");
        let file = SentFile { name: "s".into(), mime_type: "text/plain".into(), size_bytes: 5, digest: hex(&Sha256::digest(b"12345")) };
        assert_eq!(read_part(None, &file, 0), Ok(Value::Null), "the store keeps no content of that digest");
        assert_eq!(read_part(Some(&path), &file, 0), Ok(Value::Null), "its file is gone");
        fs::write(&path, b"12346").unwrap();
        assert_eq!(read_part(Some(&path), &file, 0), Ok(Value::Null), "same size, other bytes");
        fs::write(&path, b"123456").unwrap();
        assert_eq!(read_part(Some(&path), &file, 0), Ok(Value::Null), "another size");
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert_eq!(read_part(Some(&path), &file, 0), Ok(Value::Null), "a folder");
    }
}
