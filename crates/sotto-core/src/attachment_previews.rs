//! What each sent message carried, kept so a client can see its pictures and open its files (ADR-0031, ADR-0131), in
//! Node's `attachment-previews.json` (`AttachmentPreviews`, `src/main/agents/attachmentPreviews.ts`) in the same data
//! folder, so a message sent on either host program is found on the other after a switch.
//!
//! An entry names one user message, the command that sent it, when it was stored, and the handles of the attachments
//! it carried: never their bytes, which are the attachment store's. Only the exact user message that submitted them may
//! show them, and only for seven days: an entry older than that, or one dated later than now, names nothing. The
//! entries' pictures may hold 100 MiB between them; past that the oldest go. What Node wrote is kept as it wrote it:
//! an entry this host cannot read, such as an inline picture from before ADR-0031 that Node stages at its next start,
//! is written back unchanged.
//!
//! The store also places the markers a pane asks for previews by: a published user message's attachments are the
//! entry's handles without their digests, each picture with `preview: { available: true }`, as Node's `decorate` places
//! them; a marker no entry stands behind is taken off.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Map, Value};

use crate::attachment_store::{attachment_limit_bytes, has_raster_signature, is_image_type, is_mime_type, read_checked, ReadFailed, StagedAttachmentHandle, MAX_FILE_ATTACHMENT_BYTES};
use crate::attachment_files::{SentFile, SentRead};
use crate::protocol_fields::{is_digest, protocol_id, utf16_len, whole_number};
use crate::stores::StoredMessage;
use crate::workspace::{corrupt_copy_path, write_atomic_json};

/// How long a sent message's attachments may be shown and read, as Node's `ATTACHMENT_PREVIEW_RETENTION_MS`.
pub const ATTACHMENT_PREVIEW_RETENTION_MS: f64 = 7.0 * 86_400_000.0;
/// The most the kept entries' pictures may hold between them, as Node's `MAX_ATTACHMENT_PREVIEW_BYTES`.
pub const MAX_ATTACHMENT_PREVIEW_BYTES: u64 = 100 * 1024 * 1024;
/// The most attachments one message carries, as Node's `AGENT_MAX_ATTACHMENTS`.
const AGENT_MAX_ATTACHMENTS: usize = 8;
/// The most bytes one message's pictures may hold, as Node's `AGENT_MAX_ATTACHMENT_BYTES`.
const AGENT_MAX_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;
/// The longest edges a client that accepted `thread-media-edge` may ask a picture at, as Node's `HOST_PICTURE_EDGES`.
const HOST_PICTURE_EDGES: [u64; 3] = [320, 640, 1280];
const FILE: &str = "attachment-previews.json";

/// One attachment an entry names, as Node's `agentAttachmentHandleSchema` reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewHandle {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub digest: String,
}

/// One sent message's entry, as Node's `entrySchema` reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct PreviewEntry {
    pub thread_id: String,
    pub message_id: String,
    pub command_id: String,
    pub stored_at: f64,
    pub attachments: Vec<PreviewHandle>,
}

impl PreviewEntry {
    fn live(&self, now: f64) -> bool {
        self.stored_at > now - ATTACHMENT_PREVIEW_RETENTION_MS && self.stored_at <= now
    }

    /// Only the exact user message that submitted these handles may show them, as Node's `permits`.
    fn permits(&self, message: &StoredMessage) -> bool {
        message.role == "user" && message.command_id.as_ref().is_none_or(|command| *command == self.command_id)
    }

    fn picture_bytes(&self) -> u64 {
        self.attachments.iter().filter(|handle| is_image_type(&handle.mime_type)).map(|handle| handle.size_bytes).sum()
    }
}

/// A whole number of pixels at least 1, as Node's `agentImageSizeSchema` reads each side.
fn image_size(value: Option<&Value>) -> bool {
    value.and_then(Value::as_object).is_some_and(|size| {
        size.len() == 2 && ["width", "height"].iter().all(|side| size.get(*side).and_then(whole_number).is_some_and(|n| n >= 1))
    })
}

/// A handle as Node's strict `agentAttachmentHandleSchema` reads one, or `None` when it refuses it.
fn handle_of(value: &Value) -> Option<PreviewHandle> {
    let fields = value.as_object()?;
    if fields.keys().any(|key| !matches!(key.as_str(), "id" | "name" | "mimeType" | "sizeBytes" | "digest" | "dimensions" | "browserFeedback")) {
        return None;
    }
    let id = fields.get("id")?.as_str().filter(|id| {
        (1..=128).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })?;
    let name = fields.get("name")?.as_str()?.trim();
    let mime_type = fields.get("mimeType")?.as_str().filter(|mime| is_mime_type(mime))?;
    let size_bytes = whole_number(fields.get("sizeBytes")?).filter(|size| *size >= 1 && *size <= attachment_limit_bytes(mime_type))?;
    let digest = fields.get("digest")?.as_str().filter(|digest| is_digest(digest))?;
    if !(1..=255).contains(&utf16_len(name)) {
        return None;
    }
    if let Some(dimensions) = fields.get("dimensions") {
        let sizes = dimensions.as_object()?;
        if sizes.len() != 2 || !image_size(sizes.get("original")) || !image_size(sizes.get("sent")) {
            return None;
        }
    }
    if let Some(feedback) = fields.get("browserFeedback") {
        let feedback = feedback.as_object()?;
        let text = |key: &str, max: usize| feedback.get(key).and_then(Value::as_str).filter(|text| utf16_len(text) <= max);
        let label = text("label", 600).map(str::trim).filter(|label| !label.is_empty());
        if feedback.len() != 3 || label.is_none() || text("comment", 8000).is_none() || text("context", 4000).is_none() {
            return None;
        }
    }
    Some(PreviewHandle { id: id.into(), name: name.into(), mime_type: mime_type.into(), size_bytes, digest: digest.into() })
}

/// An entry as Node's `entrySchema` reads one, which takes the fields it names and passes over any other.
fn entry_of(value: &Value) -> Option<PreviewEntry> {
    let fields = value.as_object()?;
    let list = fields.get("attachments")?.as_array()?;
    if list.len() > AGENT_MAX_ATTACHMENTS {
        return None;
    }
    let attachments: Vec<PreviewHandle> = list.iter().map(handle_of).collect::<Option<_>>()?;
    let unique = attachments.iter().enumerate().all(|(n, handle)| attachments[..n].iter().all(|earlier| earlier.id != handle.id));
    let entry = PreviewEntry {
        thread_id: protocol_id(fields.get("threadId"))?,
        message_id: protocol_id(fields.get("messageId"))?,
        command_id: protocol_id(fields.get("commandId"))?,
        stored_at: fields.get("storedAt")?.as_f64().filter(|at| at.is_finite())?,
        attachments,
    };
    (unique && entry.picture_bytes() <= AGENT_MAX_ATTACHMENT_BYTES).then_some(entry)
}

/// One entry of the file: as it was written, and what this host reads of it, if it reads it.
struct Item {
    raw: Value,
    entry: Option<PreviewEntry>,
}

/// The sent messages' entries this host keeps (see the module's words).
pub struct AttachmentPreviews {
    path: PathBuf,
    /// The version the file was written at, kept while it holds entries this host cannot read.
    version: Value,
    items: Vec<Item>,
    /// The file could not be read at all, so it is never written over.
    unreadable: bool,
}

/// A send whose attachments were not recorded: refused, as one recorded otherwise already or one Node's schema would
/// not read, or not written. It costs the message its markers alone; the message was already sent.
#[derive(Debug, PartialEq, Eq)]
pub struct NotRecorded;

/// What a preview or file read asks of a sent message's attachment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wanted {
    Picture,
    File,
}

impl AttachmentPreviews {
    /// The entries in `data_directory`'s `attachment-previews.json`, each read as Node's schema reads it. A file Node's
    /// schema refuses whole is set aside as `attachment-previews.json.corrupt-<millis>` rather than written over.
    pub fn new(data_directory: &Path) -> Self {
        let path = data_directory.join(FILE);
        let mut store = Self { path, version: json!(2), items: Vec::new(), unreadable: false };
        let text = match fs::read_to_string(&store.path) {
            Ok(text) => text,
            Err(err) if err.kind() == ErrorKind::NotFound => return store,
            Err(_) => {
                store.unreadable = true;
                return store;
            }
        };
        let saved = serde_json::from_str::<Map<String, Value>>(&text).ok().and_then(|saved| {
            let version = saved.get("version").filter(|version| matches!(version.as_f64(), Some(v) if v == 1.0 || v == 2.0))?.clone();
            Some((version, saved.get("entries")?.as_array()?.clone()))
        });
        match saved {
            Some((version, entries)) => {
                store.version = version;
                store.items = entries.into_iter().map(|raw| Item { entry: entry_of(&raw), raw }).collect();
            }
            None => {
                let _ = fs::rename(&store.path, corrupt_copy_path(&store.path));
            }
        }
        store
    }

    /// The live entry of a thread's message: the first the file names, as Node keeps the first of two for one message.
    pub fn live(&self, thread_id: &str, message_id: &str, now: f64) -> Option<&PreviewEntry> {
        self.items
            .iter()
            .filter_map(|item| item.entry.as_ref())
            .find(|entry| entry.thread_id == thread_id && entry.message_id == message_id)
            .filter(|entry| entry.live(now))
    }

    /// Records the attachments a user message was sent with, as Node's `remember`, and writes the file before it
    /// answers. A message already recorded with the same command and handles changes nothing; one recorded otherwise is
    /// refused. Answers whether an entry stands for the message, so its pictures carry markers.
    pub fn remember(&mut self, thread_id: &str, message_id: &str, command_id: &str, handles: &[StagedAttachmentHandle], now: f64) -> Result<bool, NotRecorded> {
        let raw = json!({
            "threadId": thread_id,
            "messageId": message_id,
            "commandId": command_id,
            "storedAt": now as u64,
            "attachments": handles.iter().map(|handle| json!({
                "id": handle.id, "name": handle.name, "mimeType": handle.mime_type, "sizeBytes": handle.size_bytes, "digest": handle.digest,
            })).collect::<Vec<_>>(),
        });
        let entry = entry_of(&raw).ok_or(NotRecorded)?;
        self.prune(now);
        if let Some(existing) = self.items.iter().filter_map(|item| item.entry.as_ref()).find(|e| e.thread_id == thread_id && e.message_id == message_id) {
            // A retry never extends retention or changes identity.
            return if existing.command_id == entry.command_id && existing.attachments == entry.attachments { Ok(true) } else { Err(NotRecorded) };
        }
        if handles.is_empty() || self.unreadable {
            return Ok(false);
        }
        self.items.push(Item { raw, entry: Some(entry) });
        self.prune(now);
        if self.write().is_err() {
            // Only this entry goes; what it pushed out under the size limit stays out, as Node's does.
            self.items.retain(|item| item.entry.as_ref().is_none_or(|e| e.thread_id != thread_id || e.message_id != message_id));
            return Err(NotRecorded);
        }
        Ok(self.live(thread_id, message_id, now).is_some())
    }

    /// Lets go of entries past their seven days, and of the oldest while the pictures they name hold more than 100 MiB,
    /// as Node's `prune`. An entry this host cannot read is Node's to keep or let go.
    fn prune(&mut self, now: f64) {
        self.items.retain(|item| item.entry.as_ref().is_none_or(|entry| entry.live(now)));
        let mut bytes: u64 = self.items.iter().filter_map(|item| item.entry.as_ref()).map(PreviewEntry::picture_bytes).sum();
        while bytes > MAX_ATTACHMENT_PREVIEW_BYTES {
            let oldest = self
                .items
                .iter()
                .enumerate()
                .filter_map(|(n, item)| item.entry.as_ref().map(|entry| (n, entry.stored_at)))
                .min_by(|a, b| a.1.total_cmp(&b.1))
                .map(|(n, _)| n);
            let Some(oldest) = oldest else { break };
            bytes -= self.items.remove(oldest).entry.map_or(0, |entry| entry.picture_bytes());
        }
    }

    fn write(&self) -> std::io::Result<()> {
        let unread = self.items.iter().any(|item| item.entry.is_none());
        let version = if unread { self.version.clone() } else { json!(2) };
        let entries: Vec<&Value> = self.items.iter().map(|item| &item.raw).collect();
        write_atomic_json(&self.path, &json!({ "version": version, "entries": entries }))
    }

    /// Writes the file as it is now, as a host's save does.
    pub fn save(&self) -> std::io::Result<()> {
        if self.unreadable {
            return Ok(());
        }
        self.write()
    }

    /// The attachment `attachment_id` of a thread's user message, when a client may read it: a picture for `preview`, or
    /// a file of no more than 25 MiB for `attachment-file`, as Node's `preview` and `filePart` find one.
    pub fn sent(&self, thread_id: &str, message: &StoredMessage, attachment_id: &str, wanted: Wanted, now: f64) -> Option<SentFile> {
        let entry = self.live(thread_id, &message.id, now).filter(|entry| entry.permits(message))?;
        let handle = entry.attachments.iter().find(|handle| handle.id == attachment_id && is_image_type(&handle.mime_type) == (wanted == Wanted::Picture))?;
        // A video larger than a file may be stays on its computer: the phone shows a sent video and never fetches it back.
        if wanted == Wanted::File && handle.size_bytes > MAX_FILE_ATTACHMENT_BYTES as u64 {
            return None;
        }
        Some(SentFile { name: handle.name.clone(), mime_type: handle.mime_type.clone(), size_bytes: handle.size_bytes, digest: handle.digest.clone() })
    }

    /// Places each message's markers as Node's `decorate` places them: a marker no live entry stands behind comes off, and
    /// a user message an entry permits carries the entry's handles, without digests, each picture marked, before any other
    /// attachment it has.
    pub fn decorate(&self, thread_id: &str, messages: &mut [StoredMessage], now: f64) {
        for message in messages.iter_mut() {
            self.decorate_one(thread_id, message, now);
        }
    }

    /// `decorate` for one message.
    pub fn decorate_one(&self, thread_id: &str, message: &mut StoredMessage, now: f64) {
        let entry = self.live(thread_id, &message.id, now).filter(|entry| entry.permits(message));
        let Some(Value::Array(attachments)) = message.attachments.as_mut() else {
            if let Some(entry) = entry {
                message.attachments = Some(Value::Array(entry.attachments.iter().map(marked).collect()));
            }
            return;
        };
        for attachment in attachments.iter_mut().filter_map(Value::as_object_mut) {
            attachment.remove("preview");
        }
        if let Some(entry) = entry {
            let others = std::mem::take(attachments).into_iter().filter(|other| {
                !entry.attachments.iter().any(|handle| other.get("id").and_then(Value::as_str) == Some(handle.id.as_str()))
            });
            *attachments = entry.attachments.iter().map(marked).chain(others).collect();
        }
    }
}

/// A handle as a published message carries it, as Node's `decorate` writes it.
fn marked(handle: &PreviewHandle) -> Value {
    let mut shown = json!({ "id": handle.id, "name": handle.name, "mimeType": handle.mime_type, "sizeBytes": handle.size_bytes });
    if is_image_type(&handle.mime_type) {
        shown["preview"] = json!({ "available": true });
    }
    shown
}

/// A `preview` request as Node's strict `hostPreviewRequestSchema` reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewRequest {
    pub thread_id: String,
    pub message_id: String,
    pub attachment_id: String,
    /// Whether it named a longest edge, which only a client that accepted `thread-media-edge` may.
    pub edge: bool,
}

/// The `request` of a `preview` operation, or `None` when Node's strict schema refuses it.
pub fn preview_request(value: Option<&Value>) -> Option<PreviewRequest> {
    let fields = value?.as_object()?;
    if fields.keys().any(|key| !matches!(key.as_str(), "threadId" | "messageId" | "attachmentId" | "edge")) {
        return None;
    }
    let edge = match fields.get("edge") {
        None => false,
        Some(edge) => {
            whole_number(edge).filter(|edge| HOST_PICTURE_EDGES.contains(edge))?;
            true
        }
    };
    Some(PreviewRequest {
        thread_id: protocol_id(fields.get("threadId"))?,
        message_id: protocol_id(fields.get("messageId"))?,
        attachment_id: protocol_id(fields.get("attachmentId"))?,
        edge,
    })
}

/// A sent picture whose content the store keeps at `path` (`None` when it keeps none), as Node's `preview` answers it:
/// `{ dataUrl }` of its type, once its bytes are checked against its digest and its type's signature, as Node's
/// `agentAttachmentPreviewDataSchema` takes only a picture that is the type it says.
pub fn read_preview(path: Option<&Path>, picture: &SentFile) -> Result<SentRead, ReadFailed> {
    let Some(path) = path else { return Ok(SentRead::Nothing) };
    let Some(bytes) = read_checked(path, picture.size_bytes, &picture.digest)? else {
        return Ok(SentRead::Gone);
    };
    if !has_raster_signature(&picture.mime_type, &bytes) {
        return Ok(SentRead::Nothing);
    }
    Ok(SentRead::Answer(json!({ "dataUrl": format!("data:{};base64,{}", picture.mime_type, STANDARD.encode(&bytes)) })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::sha256_hex;
    use tempfile::tempdir;

    const NOW: f64 = 1_795_000_000_000.0;
    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    fn handle(id: &str, mime: &str, size: usize) -> StagedAttachmentHandle {
        StagedAttachmentHandle { id: id.into(), name: format!("{id}.file"), mime_type: mime.into(), size_bytes: size, digest: sha256_hex(id.as_bytes()), dimensions: None }
    }

    fn message(id: &str, role: &str, command: Option<&str>) -> StoredMessage {
        StoredMessage {
            id: id.into(),
            role: role.into(),
            text: "Here".into(),
            created_at: "2026-11-26T10:00:00.000Z".into(),
            command_id: command.map(Into::into),
            turn_message_id: None,
            attachments: None,
            watcher_own_change: None,
            watcher_observed_changes: None,
            provider_error: None,
        }
    }

    fn saved(dir: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(dir.join(FILE)).unwrap()).unwrap()
    }

    /// A send is recorded as Node records one: its fields, no bytes and no dimensions, and written before it answers.
    #[test]
    fn a_send_is_recorded_as_node_records_it() {
        let dir = tempdir().unwrap();
        let mut previews = AttachmentPreviews::new(dir.path());
        let picture = StagedAttachmentHandle { dimensions: Some(json!({ "width": 1 })), ..handle("p", "image/png", 5) };
        assert_eq!(previews.remember("t", "m", "c", &[picture, handle("f", "text/plain", 9)], NOW), Ok(true));
        let file = saved(dir.path());
        assert_eq!(file["version"], 2);
        let entry = &file["entries"][0];
        assert_eq!((entry["threadId"].as_str(), entry["messageId"].as_str(), entry["commandId"].as_str()), (Some("t"), Some("m"), Some("c")));
        assert_eq!(entry["storedAt"], NOW as u64);
        assert_eq!(entry["attachments"][0], json!({ "id": "p", "name": "p.file", "mimeType": "image/png", "sizeBytes": 5, "digest": sha256_hex(b"p") }));
        // The same send again changes nothing; another command for the same message is refused.
        assert_eq!(previews.remember("t", "m", "c", &[handle("p", "image/png", 5), handle("f", "text/plain", 9)], NOW + 5.0), Ok(true));
        assert_eq!(saved(dir.path())["entries"].as_array().unwrap().len(), 1);
        assert_eq!(previews.remember("t", "m", "other", &[handle("p", "image/png", 5)], NOW), Err(NotRecorded));
        // A send with nothing attached, or more than a message carries, records nothing.
        assert_eq!(previews.remember("t", "m2", "c", &[], NOW), Ok(false));
        let nine: Vec<_> = (0..9).map(|n| handle(&format!("h{n}"), "text/plain", 1)).collect();
        assert_eq!(previews.remember("t", "m3", "c", &nine, NOW), Err(NotRecorded));
        assert_eq!(saved(dir.path())["entries"].as_array().unwrap().len(), 1);
    }

    /// Node's entries are read one by one as Node's schema reads them, and what this host cannot read is written back
    /// as Node wrote it.
    #[test]
    fn nodes_entries_are_read_one_by_one_and_kept_whole() {
        let dir = tempdir().unwrap();
        let good = json!({ "threadId": "t", "messageId": "m", "commandId": "c", "storedAt": NOW - 1000.0, "nodeOnly": "kept",
            "attachments": [{ "id": "f", "name": " notes.txt ", "mimeType": "text/plain", "sizeBytes": 9, "digest": "a".repeat(64),
                "dimensions": { "original": { "width": 2, "height": 3 }, "sent": { "width": 1, "height": 1 } } }] });
        let inline = json!({ "threadId": "t", "messageId": "old", "commandId": "c", "storedAt": NOW - 2000.0,
            "attachments": [{ "id": "i", "name": "shot.png", "mimeType": "image/png", "dataUrl": format!("data:image/png;base64,{PNG}") }] });
        let bad_handle = json!({ "threadId": "t", "messageId": "x", "commandId": "c", "storedAt": NOW, "attachments": [{ "id": "has space" }] });
        fs::write(dir.path().join(FILE), json!({ "version": 1, "entries": [good, inline, bad_handle] }).to_string()).unwrap();
        let mut previews = AttachmentPreviews::new(dir.path());
        let found = previews.live("t", "m", NOW).unwrap();
        assert_eq!(found.attachments[0].name, "notes.txt", "Node's schema trims a name");
        assert!(previews.live("t", "old", NOW).is_none(), "an inline picture is Node's to stage");
        assert!(previews.live("t", "x", NOW).is_none());
        previews.remember("t", "new", "c", &[handle("f", "text/plain", 1)], NOW).unwrap();
        let file = saved(dir.path());
        assert_eq!(file["version"], 1, "kept while it holds entries Node reads at that version");
        assert_eq!(file["entries"][0], good);
        assert_eq!(file["entries"][1], inline);
        assert_eq!(file["entries"][2], bad_handle);
        assert_eq!(file["entries"][3]["messageId"], "new");
    }

    /// An entry names nothing after seven days, nor before it was stored, and the oldest go past 100 MiB of pictures.
    #[test]
    fn entries_are_kept_seven_days_and_100_mib_of_pictures() {
        let dir = tempdir().unwrap();
        let mut previews = AttachmentPreviews::new(dir.path());
        previews.remember("t", "m", "c", &[handle("f", "text/plain", 1)], NOW).unwrap();
        assert!(previews.live("t", "m", NOW + ATTACHMENT_PREVIEW_RETENTION_MS - 1.0).is_some());
        assert!(previews.live("t", "m", NOW + ATTACHMENT_PREVIEW_RETENTION_MS).is_none());
        assert!(previews.live("t", "m", NOW - 1.0).is_none(), "an entry dated after now names nothing");
        // Each message's pictures may hold 20 MiB; the entries' together 100 MiB, past which the oldest go, whatever they
        // hold, as Node's prune lets them go.
        let ten = 10 * 1024 * 1024;
        for n in 0..5 {
            let pictures = [handle(&format!("a{n}"), "image/png", ten), handle(&format!("b{n}"), "image/jpeg", ten)];
            previews.remember("t", &format!("p{n}"), "c", &pictures, NOW + 1.0 + n as f64).unwrap();
        }
        assert!(previews.live("t", "m", NOW + 10.0).is_some(), "100 MiB of pictures fit, and a file's bytes are not counted");
        let pictures = [handle("a5", "image/png", ten), handle("b5", "image/jpeg", ten)];
        previews.remember("t", "p5", "c", &pictures, NOW + 6.0).unwrap();
        assert!(previews.live("t", "m", NOW + 10.0).is_none(), "the oldest goes first");
        assert!(previews.live("t", "p0", NOW + 10.0).is_none());
        assert!(previews.live("t", "p1", NOW + 10.0).is_some());
        // A file written after seven days lets the old entries go.
        previews.remember("t", "late", "c", &[handle("f", "text/plain", 1)], NOW + ATTACHMENT_PREVIEW_RETENTION_MS + 100.0).unwrap();
        assert_eq!(saved(dir.path())["entries"].as_array().unwrap().len(), 1);
    }

    /// Only the exact user message that sent the handles finds them: a picture for a preview, a file of no more than
    /// 25 MiB for a file read.
    #[test]
    fn only_the_message_that_sent_them_finds_its_attachments() {
        let dir = tempdir().unwrap();
        let mut previews = AttachmentPreviews::new(dir.path());
        let large = handle("v", "video/mp4", MAX_FILE_ATTACHMENT_BYTES + 1);
        previews.remember("t", "m", "c", &[handle("p", "image/png", 5), handle("f", "text/plain", 9), large], NOW).unwrap();
        let sent = message("m", "user", Some("c"));
        assert_eq!(previews.sent("t", &sent, "p", Wanted::Picture, NOW).unwrap().mime_type, "image/png");
        assert_eq!(previews.sent("t", &sent, "f", Wanted::File, NOW).unwrap().size_bytes, 9);
        assert!(previews.sent("t", &sent, "p", Wanted::File, NOW).is_none(), "a picture is preview's");
        assert!(previews.sent("t", &sent, "f", Wanted::Picture, NOW).is_none(), "a file has no preview");
        assert!(previews.sent("t", &sent, "v", Wanted::File, NOW).is_none(), "a video larger than a file stays");
        assert!(previews.sent("other", &sent, "f", Wanted::File, NOW).is_none());
        assert!(previews.sent("t", &message("m", "assistant", Some("c")), "f", Wanted::File, NOW).is_none());
        assert!(previews.sent("t", &message("m", "user", Some("other")), "f", Wanted::File, NOW).is_none());
        assert!(previews.sent("t", &message("m", "user", None), "f", Wanted::File, NOW).is_some(), "Node's permits takes a message with no command");
    }

    /// A published message carries the entry's markers, as Node's `decorate` places them, and loses any no entry backs.
    #[test]
    fn markers_are_placed_as_node_places_them() {
        let dir = tempdir().unwrap();
        let mut previews = AttachmentPreviews::new(dir.path());
        previews.remember("t", "m", "c", &[handle("p", "image/png", 5), handle("f", "text/plain", 9)], NOW).unwrap();
        let mut sent = message("m", "user", Some("c"));
        sent.attachments = Some(json!([{ "id": "p", "name": "p.file", "mimeType": "image/png", "sizeBytes": 5, "digest": "d" }, { "id": "o", "name": "other", "mimeType": "text/plain", "sizeBytes": 1, "preview": { "available": true } }]));
        let mut reply = message("r", "assistant", None);
        reply.attachments = Some(json!([{ "id": "x", "name": "x", "mimeType": "image/png", "sizeBytes": 1, "preview": { "available": true } }]));
        let mut messages = [sent, reply, message("plain", "user", Some("c"))];
        previews.decorate("t", &mut messages, NOW);
        assert_eq!(messages[0].attachments, Some(json!([
            { "id": "p", "name": "p.file", "mimeType": "image/png", "sizeBytes": 5, "preview": { "available": true } },
            { "id": "f", "name": "f.file", "mimeType": "text/plain", "sizeBytes": 9 },
            { "id": "o", "name": "other", "mimeType": "text/plain", "sizeBytes": 1 },
        ])));
        assert_eq!(messages[1].attachments, Some(json!([{ "id": "x", "name": "x", "mimeType": "image/png", "sizeBytes": 1 }])), "provider content mints no preview");
        assert_eq!(messages[2].attachments, None);
        let mut late = [message("m", "user", Some("c"))];
        previews.decorate("t", &mut late, NOW + ATTACHMENT_PREVIEW_RETENTION_MS);
        assert_eq!(late[0].attachments, None, "an entry past its seven days places nothing");
    }

    #[test]
    fn preview_requests_are_read_as_nodes_schema_reads_them() {
        let good = json!({ "threadId": "t", "messageId": "m", "attachmentId": "a" });
        assert_eq!(preview_request(Some(&good)).map(|r| r.edge), Some(false));
        assert_eq!(preview_request(Some(&json!({ "threadId": "t", "messageId": "m", "attachmentId": "a", "edge": 640 }))).map(|r| r.edge), Some(true));
        for bad in [
            json!({ "threadId": "t", "messageId": "m", "attachmentId": "a", "edge": 100 }),
            json!({ "threadId": "t", "messageId": "m" }),
            json!({ "threadId": "t", "messageId": "m", "attachmentId": "", }),
            json!({ "threadId": "t", "messageId": "m", "attachmentId": "a", "part": 0 }),
        ] {
            assert_eq!(preview_request(Some(&bad)), None, "{bad}");
        }
    }

    /// A preview is the picture's bytes as a data URL of its type, only while they are its digest and of its type.
    #[test]
    fn a_preview_answers_the_picture_or_nothing() {
        let dir = tempdir().unwrap();
        let bytes = STANDARD.decode(PNG).unwrap();
        let path = dir.path().join("dot.png");
        fs::write(&path, &bytes).unwrap();
        let picture = SentFile { name: "dot.png".into(), mime_type: "image/png".into(), size_bytes: bytes.len() as u64, digest: sha256_hex(&bytes) };
        assert_eq!(read_preview(Some(&path), &picture), Ok(SentRead::Answer(json!({ "dataUrl": format!("data:image/png;base64,{PNG}") }))));
        assert_eq!(read_preview(None, &picture), Ok(SentRead::Nothing));
        let as_gif = SentFile { mime_type: "image/gif".into(), ..picture.clone() };
        assert_eq!(read_preview(Some(&path), &as_gif), Ok(SentRead::Nothing), "a picture that is not its type");
        fs::write(&path, b"changed").unwrap();
        assert_eq!(read_preview(Some(&path), &picture), Ok(SentRead::Gone));
    }

    /// What Node keeps for one sent message in the fixture below: a picture and a file, each with its bytes.
    fn node_sent() -> Vec<(&'static str, &'static str, Vec<u8>)> {
        vec![("picture-1", "image/png", STANDARD.decode(PNG).unwrap()), ("file-1", "text/plain", b"Node's sent notes\n".to_vec())]
    }

    /// `attachment-previews.json` as Node's store writes it for `node_sent`, stored a moment ago.
    fn node_previews() -> Value {
        let attachments: Vec<Value> = node_sent()
            .iter()
            .map(|(id, mime, bytes)| json!({ "id": id, "name": format!("{id}.bin"), "mimeType": mime, "sizeBytes": bytes.len(), "digest": sha256_hex(bytes) }))
            .collect();
        let stored_at = crate::workspace::now_ms() - 1000;
        json!({ "version": 2, "entries": [{ "threadId": "thread-1", "messageId": "message-1", "commandId": "command-1", "storedAt": stored_at, "attachments": attachments }] })
    }

    /// Node's entries survive a Rust load and save, and every attachment they name is found and read on this host: a
    /// file sent on Node opens after a switch, and its picture shows. With `SOTTO_SHARED_STORES_DIR`, the folder is one
    /// Node's own stores wrote.
    #[test]
    fn node_attachment_previews_survive_a_rust_load_and_save() {
        crate::store_trip::round_trip(FILE, node_previews, |dir| {
            if crate::store_trip::shared_dir().is_none() {
                let mut staged = crate::attachment_store::StagedAttachments::new(dir);
                for (_, mime, bytes) in node_sent() {
                    staged.stage_received_bytes("sent", mime, &bytes).unwrap();
                }
            }
            let staged = crate::attachment_store::StagedAttachments::new(dir);
            let previews = AttachmentPreviews::new(dir);
            let now = crate::workspace::now_ms() as f64;
            let entries: Vec<PreviewEntry> = previews.items.iter().filter_map(|item| item.entry.clone()).collect();
            assert!(!entries.is_empty(), "Node's entries read");
            for entry in &entries {
                let sent = message(&entry.message_id, "user", Some(&entry.command_id));
                for handle in &entry.attachments {
                    let picture = is_image_type(&handle.mime_type);
                    let wanted = if picture { Wanted::Picture } else { Wanted::File };
                    let found = previews.sent(&entry.thread_id, &sent, &handle.id, wanted, now).unwrap_or_else(|| panic!("{} is found", handle.id));
                    let path = staged.content_path(&found.digest);
                    let read = if picture { read_preview(path.as_deref(), &found) } else { crate::attachment_files::read_part(path.as_deref(), &found, 0) };
                    assert!(matches!(read, Ok(SentRead::Answer(_))), "{} reads: {read:?}", handle.id);
                }
            }
            previews.save().unwrap();
        });
    }

    /// What `rust_created_attachment_previews_reads_in_node` sends, which the TypeScript test reads back in Node.
    const RUST_SENT_NOTES: &[u8] = b"Notes a Rust host sent\n";

    /// A send on this host is recorded so Node finds it: Node's store reads the entry, shows its picture and opens its file.
    #[test]
    fn rust_created_attachment_previews_reads_in_node() {
        let written = crate::store_trip::created(FILE, |dir| {
            let mut staged = crate::attachment_store::StagedAttachments::new(dir);
            let picture = staged.stage_image("dot.png", "image/png", PNG, None).unwrap();
            let file = staged.stage_received_bytes("notes.txt", "text/plain", RUST_SENT_NOTES).unwrap();
            let mut previews = AttachmentPreviews::new(dir);
            let now = crate::workspace::now_ms() as f64;
            assert_eq!(previews.remember("rust-thread", "rust-message", "rust-command", &[picture, file], now), Ok(true));
        });
        assert_eq!(written["entries"][0]["attachments"].as_array().unwrap().len(), 2);
    }

    /// An unreadable file is set aside rather than written over.
    #[test]
    fn a_file_node_refuses_whole_is_set_aside() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(FILE), "{ \"version\": 3, \"entries\": [] }").unwrap();
        let mut previews = AttachmentPreviews::new(dir.path());
        previews.remember("t", "m", "c", &[handle("f", "text/plain", 1)], NOW).unwrap();
        let aside: Vec<_> = fs::read_dir(dir.path()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("attachment-previews.json.corrupt-")).collect();
        assert_eq!(aside.len(), 1);
        assert_eq!(saved(dir.path())["entries"].as_array().unwrap().len(), 1);
    }
}
