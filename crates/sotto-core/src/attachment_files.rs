//! One part of a file a sent message carries, for the iPhone's Quick Look (`attachment-files`, ADR-0131, October 25
//! amendment), read for the `attachment-file` host operation as Node's `AttachmentPreviews.filePart`
//! (`src/main/agents/attachmentPreviews.ts`) reads it.
//!
//! A file is found by its message, so a client reads only what a thread it reads carries: the preview store's entry
//! for that user message (`attachment_previews.rs`), which Node or this host wrote when the message was sent. Its bytes
//! come from the attachment store's file for the handle's digest, read whole and checked against that digest before
//! any part of it is answered, so a part is never cut from bytes that are not the file the message sent.

use std::path::Path;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};

use crate::attachment_store::{read_checked, ReadFailed};
use crate::file_uploads::{HOST_FILE_PARTS_MAX, HOST_FILE_PART_BYTES};
use crate::protocol_fields::{protocol_id, whole_number};

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

/// A file or picture a sent message carries, as its handle names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SentAttachment {
    pub name: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub digest: String,
}

/// What a read of a sent attachment found.
#[derive(Debug, PartialEq)]
pub enum SentRead {
    /// The answer: a file's part, in base64, with what the whole file is, or a picture's data URL.
    Answer(Value),
    /// Nothing to answer: a part past the last, content the store does not keep, or a picture not of its type.
    Nothing,
    /// The content the store keeps for the digest is gone, has another size, or is no longer the digest's bytes: nothing
    /// to answer, and the store lets it go, as Node's `read` does.
    Gone,
}

/// Part `part` of a sent file whose content the store keeps at `path` (`None` when it keeps none), at most 8 MiB of its
/// bytes. The content is read whole and checked against the file's digest before any part of it is answered.
pub fn read_part(path: Option<&Path>, file: &SentAttachment, part: u64) -> Result<SentRead, ReadFailed> {
    let parts = file.size_bytes.div_ceil(HOST_FILE_PART_BYTES).max(1);
    let Some(path) = path.filter(|_| part < parts) else {
        return Ok(SentRead::Nothing);
    };
    let Some(bytes) = read_checked(path, file.size_bytes, &file.digest)? else {
        return Ok(SentRead::Gone);
    };
    let start = (part * HOST_FILE_PART_BYTES) as usize;
    let end = (start + HOST_FILE_PART_BYTES as usize).min(bytes.len());
    Ok(SentRead::Answer(json!({
        "name": file.name,
        "mimeType": file.mime_type,
        "sizeBytes": file.size_bytes,
        "digest": file.digest,
        "part": part,
        "parts": parts,
        "data": STANDARD.encode(&bytes[start..end]),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol_fields::hex;
    use sha2::{Digest, Sha256};
    use std::fs;
    use tempfile::tempdir;

    fn part_of(read: SentRead) -> Value {
        match read {
            SentRead::Answer(answer) => answer,
            other => panic!("expected a part, read {other:?}"),
        }
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

    /// A file is answered in 8 MiB parts with its last part shorter, and nothing past its last part.
    #[test]
    fn a_file_is_read_in_parts() {
        let dir = tempdir().unwrap();
        let bytes: Vec<u8> = (0..(HOST_FILE_PART_BYTES as usize * 2 + 10)).map(|i| (i % 251) as u8).collect();
        let path = dir.path().join("content.bin");
        fs::write(&path, &bytes).unwrap();
        let file = SentAttachment { name: "big.log".into(), mime_type: "text/plain".into(), size_bytes: bytes.len() as u64, digest: hex(&Sha256::digest(&bytes)) };
        let mut joined = Vec::new();
        for part in 0..3 {
            let answer = part_of(read_part(Some(&path), &file, part).unwrap());
            assert_eq!((answer["part"].as_u64(), answer["parts"].as_u64()), (Some(part), Some(3)));
            assert_eq!(answer["sizeBytes"], bytes.len());
            joined.extend(STANDARD.decode(answer["data"].as_str().unwrap()).unwrap());
        }
        assert_eq!(joined.len(), bytes.len());
        assert_eq!(joined, bytes);
        assert_eq!(read_part(Some(&path), &file, 3), Ok(SentRead::Nothing), "a part past the end");

        let small = dir.path().join("small.bin");
        fs::write(&small, b"12345").unwrap();
        let file = SentAttachment { name: "s".into(), mime_type: "text/plain".into(), size_bytes: 5, digest: hex(&Sha256::digest(b"12345")) };
        let answer = part_of(read_part(Some(&small), &file, 0).unwrap());
        assert_eq!((answer["parts"].as_u64(), answer["data"].as_str()), (Some(1), Some("MTIzNDU=")));
        assert_eq!(read_part(Some(&small), &file, 1), Ok(SentRead::Nothing));
    }

    /// Content that is gone, that changed, or that has another size is no part of the file the message sent, and is gone.
    #[test]
    fn a_changed_or_missing_file_answers_nothing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("content.bin");
        let file = SentAttachment { name: "s".into(), mime_type: "text/plain".into(), size_bytes: 5, digest: hex(&Sha256::digest(b"12345")) };
        assert_eq!(read_part(None, &file, 0), Ok(SentRead::Nothing), "the store keeps no content of that digest");
        assert_eq!(read_part(Some(&path), &file, 0), Ok(SentRead::Gone), "its file is gone");
        fs::write(&path, b"12346").unwrap();
        assert_eq!(read_part(Some(&path), &file, 0), Ok(SentRead::Gone), "same size, other bytes");
        fs::write(&path, b"123456").unwrap();
        assert_eq!(read_part(Some(&path), &file, 0), Ok(SentRead::Gone), "another size");
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert_eq!(read_part(Some(&path), &file, 0), Ok(SentRead::Gone), "a folder");
    }
}
