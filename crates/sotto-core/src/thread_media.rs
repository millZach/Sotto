//! A picture or a part of a video a thread's activity record names (ADR-0170), read for the `thread-media` and
//! `thread-media-part` host operations as Node's `AgentControl.threadMedia` and `threadMediaPart`
//! (`src/main/agents/control.ts`) read them from Node's `ThreadMediaStore` (`src/main/agents/threadMedia.ts`).
//!
//! The store is Node's, in the same data folder: a picture's bytes are `thread-media/<digest>.<ext>`, kept once by the
//! SHA-256 of its bytes, and a video is never copied, so `thread-media.json` remembers where each video an agent showed
//! is, by its digest, with the size and last change its file had when it was found. A read follows only a handle the
//! record carries: a picture is read from the store's own file of that digest and answered only when its bytes are still
//! that digest, and a video's part is read from the file the store remembers for that digest only while the file still
//! has the size and last change it was found with. Nothing else is ever read, and this host never writes the store.

use std::fs;
use std::io::{ErrorKind, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::protocol_fields::{hex, is_digest, on_network, protocol_id, utf16_len, whole_number};

/// The largest picture Sotto keeps or shows, as Node's `AGENT_MAX_IMAGE_BYTES`.
pub const AGENT_MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
/// The largest video a tile plays, as Node's `AGENT_VIDEO_MAX_BYTES`.
pub const AGENT_VIDEO_MAX_BYTES: u64 = 200 * 1024 * 1024;
/// How much of a video one `thread-media-part` read hands back, as Node's `AGENT_VIDEO_PART_BYTES`.
pub const AGENT_VIDEO_PART_BYTES: u64 = 8 * 1024 * 1024;
/// The most parts a video takes, as Node's `AGENT_VIDEO_PARTS_MAX`.
pub const AGENT_VIDEO_PARTS_MAX: u64 = AGENT_VIDEO_MAX_BYTES.div_ceil(AGENT_VIDEO_PART_BYTES);
/// The longest edges a client may ask a picture at, as Node's `HOST_PICTURE_EDGES`.
const HOST_PICTURE_EDGES: [u64; 3] = [320, 640, 1280];

/// The folder under the data folder Node's store keeps pictures in, and the index beside it that remembers videos.
const MEDIA_FOLDER: &str = "thread-media";
const MEDIA_INDEX: &str = "thread-media.json";

/// The picture types the store keeps, by the extension its file of each has (`EXTENSIONS` in Node's attachment store).
const PICTURE_EXTENSIONS: [(&str, &str); 4] =
    [("image/png", "png"), ("image/jpeg", "jpg"), ("image/gif", "gif"), ("image/webp", "webp")];
/// The video types a tile plays, as Node's `AGENT_VIDEO_MIME_TYPES`.
const VIDEO_TYPES: [&str; 3] = ["video/mp4", "video/webm", "video/quicktime"];

/// What a media request reads: the picture whole, or one part of a video.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaRead {
    Picture,
    VideoPart(u64),
}

/// A `thread-media` or `thread-media-part` request as Node's strict schema reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaRequest {
    pub thread_id: String,
    pub activity_id: String,
    pub media_id: String,
    pub read: MediaRead,
    /// Whether a picture request named a longest edge (`thread-media-edge`), which only a client that accepted it may.
    pub edge: bool,
}

impl MediaRequest {
    /// The feature a host offers for this read, as Node's socket server checks it.
    pub fn feature(&self) -> &'static str {
        match self.read {
            MediaRead::Picture => "thread-media",
            MediaRead::VideoPart(_) => "thread-media-video",
        }
    }
}

/// A media ID as Node's schema reads one: `m0` to `m7`.
fn media_id(value: Option<&Value>) -> Option<String> {
    let id = value?.as_str()?;
    let bytes = id.as_bytes();
    (bytes.len() == 2 && bytes[0] == b'm' && (b'0'..=b'7').contains(&bytes[1])).then(|| id.to_string())
}

/// The request of a `thread-media` (`hostThreadMediaRequestSchema`) or `thread-media-part`
/// (`agentThreadMediaPartRequestSchema`) operation, or `None` when Node's strict schema refuses it.
pub fn media_request(op: &str, value: Option<&Value>) -> Option<MediaRequest> {
    let fields = value?.as_object()?;
    let allowed: &[&str] = match op {
        "thread-media" => &["threadId", "activityId", "mediaId", "edge"],
        "thread-media-part" => &["threadId", "activityId", "mediaId", "part"],
        _ => return None,
    };
    if fields.keys().any(|key| !allowed.contains(&key.as_str())) {
        return None;
    }
    let thread_id = protocol_id(fields.get("threadId"))?;
    let activity_id = protocol_id(fields.get("activityId"))?;
    let media_id = media_id(fields.get("mediaId"))?;
    let (read, edge) = if op == "thread-media" {
        let edge = match fields.get("edge") {
            None => false,
            Some(edge) => {
                whole_number(edge).filter(|edge| HOST_PICTURE_EDGES.contains(edge))?;
                true
            }
        };
        (MediaRead::Picture, edge)
    } else {
        let part = whole_number(fields.get("part")?).filter(|part| *part < AGENT_VIDEO_PARTS_MAX)?;
        (MediaRead::VideoPart(part), false)
    };
    Some(MediaRequest { thread_id, activity_id, media_id, read, edge })
}

/// What a media handle names, as Node's `agentActivityMediaSchema` reads its `kind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MediaKind {
    Image,
    Video,
}

impl MediaKind {
    fn of(kind: &str) -> Option<Self> {
        match kind {
            "image" => Some(Self::Image),
            "video" => Some(Self::Video),
            _ => None,
        }
    }
}

/// A media handle as a record carries it, with the fields a read needs, each as Node's `agentActivityMediaSchema` reads it.
struct Handle {
    digest: String,
    kind: MediaKind,
    mime_type: String,
    size_bytes: u64,
    name: String,
}

/// The first handle of `media_id` the record carries, as Node's `record.media.find(item => item.id === mediaId)`, or
/// `None` when it carries none or that handle is not one Node's schema reads.
fn handle_of(record: &Value, media_id: &str) -> Option<Handle> {
    let item = record
        .get("media")?
        .as_array()?
        .iter()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(media_id))?;
    let digest = item.get("digest")?.as_str().filter(|digest| is_digest(digest))?;
    let kind = MediaKind::of(item.get("kind")?.as_str()?)?;
    let mime_type = item.get("mimeType")?.as_str()?;
    let size_bytes = whole_number(item.get("sizeBytes")?).filter(|size| *size >= 1)?;
    let name = item.get("name")?.as_str().filter(|name| (1..=200).contains(&utf16_len(name)))?;
    Some(Handle {
        digest: digest.to_string(),
        kind,
        mime_type: mime_type.to_string(),
        size_bytes,
        name: name.to_string(),
    })
}

/// A media read the host failed at, which Node's socket server answers as `unavailable`.
#[derive(Debug, PartialEq, Eq)]
pub struct MediaReadFailed;

/// What a media request answers, from the record of `request.activity_id` the thread holds (`record`, or `None` when it
/// holds none) and Node's store in `data_directory`: `{ dataUrl }` for a picture, a part with what the whole video is,
/// or null when the record names no such media or the store no longer has it as the record names it.
pub fn read_media(data_directory: &Path, record: Option<&Value>, request: &MediaRequest) -> Result<Value, MediaReadFailed> {
    let Some(handle) = record.and_then(|record| handle_of(record, &request.media_id)) else {
        return Ok(Value::Null);
    };
    match request.read {
        MediaRead::Picture => read_picture(data_directory, &handle),
        MediaRead::VideoPart(part) => Ok(read_video_part(data_directory, &handle, part).unwrap_or(Value::Null)),
    }
}

/// A picture a handle names, as Node's `ThreadMediaStore.read` answers it: the store's file of its digest, of the type
/// and size the handle says, whose bytes are still that digest. A file the store does not keep as the handle describes
/// it, or whose bytes changed, is null; a failure to read one it keeps is the host's, as Node's `readFile` throws it.
fn read_picture(data_directory: &Path, handle: &Handle) -> Result<Value, MediaReadFailed> {
    let Some((_, extension)) = PICTURE_EXTENSIONS.iter().find(|(mime, _)| *mime == handle.mime_type) else {
        return Ok(Value::Null);
    };
    // Node's store never keeps an empty picture or one over the image limit, and keeps each by its digest and type.
    if handle.size_bytes > AGENT_MAX_IMAGE_BYTES {
        return Ok(Value::Null);
    }
    let path = data_directory.join(MEDIA_FOLDER).join(format!("{}.{extension}", handle.digest));
    let mut file = match fs::File::open(&path) {
        Ok(file) => file,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(Value::Null),
        // A folder of that name is no picture the store keeps; Windows refuses to open one as a file.
        Err(_) if path.is_dir() => return Ok(Value::Null),
        Err(_) => return Err(MediaReadFailed),
    };
    let metadata = file.metadata().map_err(|_| MediaReadFailed)?;
    if !metadata.is_file() || metadata.len() != handle.size_bytes {
        return Ok(Value::Null);
    }
    // At most one byte more than the handle's size: a file that grew is not its digest, and is never read past the limit.
    let mut bytes = Vec::with_capacity(handle.size_bytes as usize + 1);
    (&mut file).take(handle.size_bytes + 1).read_to_end(&mut bytes).map_err(|_| MediaReadFailed)?;
    if hex(&Sha256::digest(&bytes)) != handle.digest {
        return Ok(Value::Null);
    }
    Ok(json!({ "dataUrl": format!("data:{};base64,{}", handle.mime_type, STANDARD.encode(&bytes)) }))
}

/// Where Node's store remembers a video of this digest is, as `ThreadMediaStore.videoFile`: its `thread-media.json` as
/// Node's `keptSchema` reads it, or nothing when that file is missing, unreadable or not what the schema reads.
struct VideoFile {
    path: PathBuf,
    size_bytes: u64,
    modified_ms: f64,
}

fn finite(value: Option<&Value>) -> Option<f64> {
    value?.as_f64().filter(|n| n.is_finite())
}

/// Node's `keptSchema` takes a whole index or none of it, so one entry it would refuse means no video is remembered.
fn remembered_video(data_directory: &Path, digest: &str, size_bytes: u64) -> Option<VideoFile> {
    let text = fs::read_to_string(data_directory.join(MEDIA_INDEX)).ok()?;
    let index: Map<String, Value> = serde_json::from_str(&text).ok()?;
    if index.get("version").and_then(Value::as_f64) != Some(1.0) {
        return None;
    }
    let kept = index.get("kept")?.as_object()?;
    for (key, entry) in kept {
        let size = entry.get("sizeBytes").and_then(whole_number).filter(|size| *size >= 1);
        if !is_digest(key) || size.is_none() || finite(entry.get("at")).is_none() {
            return None;
        }
    }
    let videos = index.get("videos")?.as_object()?;
    let mut found = None;
    for (key, entry) in videos {
        let path = entry.get("path").and_then(Value::as_str).filter(|path| (1..=4096).contains(&utf16_len(path)));
        let size = entry.get("sizeBytes").and_then(whole_number).filter(|size| *size >= 1);
        let modified = finite(entry.get("modifiedMs"));
        let (Some(path), Some(size), Some(modified)) = (path, size, modified) else {
            return None;
        };
        if !is_digest(key) || finite(entry.get("at")).is_none() {
            return None;
        }
        if key == digest {
            found = Some(VideoFile { path: PathBuf::from(path), size_bytes: size, modified_ms: modified });
        }
    }
    found.filter(|file| file.size_bytes == size_bytes)
}

/// A file's last change in milliseconds, as Node's `Stats.mtimeMs` reads it; `None` when the system reports none.
pub fn modified_ms(metadata: &fs::Metadata) -> Option<f64> {
    metadata.modified().ok().map(millis_of)
}

/// A time in milliseconds from the epoch as Node's `Stats.mtimeMs` makes it from the seconds and nanoseconds libuv
/// reports: `sec * 1000 + nsec / 1e6`, in the same double arithmetic, so the two compare exactly. Before the epoch the
/// seconds are the whole second at or before the time and the nanoseconds count forward from it, as a `timespec` holds
/// them on Linux and macOS and as libuv makes one from a Windows file time: 0.25 s before is `-1 s + 750 000 000 ns`.
/// On Windows Node reads libuv's seconds as an unsigned 32-bit count (`SET_FIELD_WITH_TIME_STAMP` in its
/// `node_file-inl.h`, against libuv's 32-bit `long` overflowing in 2038), so there a time before the epoch reads 2^32
/// seconds later: 1.5 s before is 4 294 967 294 500 ms, as Node 24 reads it on Windows 11.
pub fn millis_of(time: SystemTime) -> f64 {
    let (sec, nsec): (i64, u32) = match time.duration_since(UNIX_EPOCH) {
        Ok(after) => (after.as_secs() as i64, after.subsec_nanos()),
        Err(before) => {
            let before = before.duration();
            match before.subsec_nanos() {
                0 => (-(before.as_secs() as i64), 0),
                nanos => (-(before.as_secs() as i64) - 1, 1_000_000_000 - nanos),
            }
        }
    };
    #[cfg(windows)]
    let sec = sec.rem_euclid(1 << 32);
    sec as f64 * 1000.0 + f64::from(nsec) / 1_000_000.0
}

/// One part of a video a handle names, as Node's `threadMediaVideo` and `readVideo` (`src/main/agents/shownMedia.ts`)
/// read it: from the file the store remembers for its digest and size, only while that file still has the size and
/// last change it was found with, and never past its end. `None` otherwise.
fn read_video_part(data_directory: &Path, handle: &Handle, part: u64) -> Option<Value> {
    if handle.kind != MediaKind::Video || !VIDEO_TYPES.contains(&handle.mime_type.as_str()) || handle.size_bytes > AGENT_VIDEO_MAX_BYTES {
        return None;
    }
    let video = remembered_video(data_directory, &handle.digest, handle.size_bytes)?;
    // Node's capture never remembers a video on another computer; a network path would reach it before the file is read.
    if on_network(&video.path.to_string_lossy()) {
        return None;
    }
    let parts = handle.size_bytes.div_ceil(AGENT_VIDEO_PART_BYTES);
    if part >= parts {
        return None;
    }
    let start = part * AGENT_VIDEO_PART_BYTES;
    let mut file = fs::File::open(&video.path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() != video.size_bytes || modified_ms(&metadata)? != video.modified_ms {
        return None;
    }
    let length = AGENT_VIDEO_PART_BYTES.min(video.size_bytes - start) as usize;
    let mut bytes = vec![0; length];
    file.seek(SeekFrom::Start(start)).ok()?;
    // A file that ended before the part did changed since it was found.
    file.read_exact(&mut bytes).ok()?;
    Some(json!({
        "name": handle.name,
        "mimeType": handle.mime_type,
        "sizeBytes": handle.size_bytes,
        "digest": handle.digest,
        "part": part,
        "parts": parts,
        "data": STANDARD.encode(&bytes),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    fn digest_of(bytes: &[u8]) -> String {
        hex(&Sha256::digest(bytes))
    }

    fn picture_request(media_id: &str) -> MediaRequest {
        MediaRequest { thread_id: "t".into(), activity_id: "a".into(), media_id: media_id.into(), read: MediaRead::Picture, edge: false }
    }

    fn part_request(part: u64) -> MediaRequest {
        MediaRequest { read: MediaRead::VideoPart(part), ..picture_request("m0") }
    }

    fn png(size: usize) -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        bytes.resize(size, 7);
        bytes
    }

    /// A data folder with one picture in Node's store, and a record naming it as `m0`.
    fn kept_picture(bytes: &[u8]) -> (tempfile::TempDir, Value) {
        let data = tempfile::tempdir().unwrap();
        fs::create_dir_all(data.path().join(MEDIA_FOLDER)).unwrap();
        let digest = digest_of(bytes);
        fs::write(data.path().join(MEDIA_FOLDER).join(format!("{digest}.png")), bytes).unwrap();
        let record = json!({ "id": "a", "kind": "tool", "media": [
            { "id": "m0", "digest": digest, "kind": "image", "mimeType": "image/png", "sizeBytes": bytes.len(), "name": "picture-1.png", "source": "tool" }
        ] });
        (data, record)
    }

    /// A video file outside the data folder, remembered in Node's index as it was found, and a record naming it.
    fn remembered(size: usize) -> (tempfile::TempDir, PathBuf, Value) {
        let data = tempfile::tempdir().unwrap();
        let path = data.path().join("written").join("clip.mp4");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut bytes = vec![0, 0, 0, 0x18, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm'];
        bytes.extend((0..size - bytes.len()).map(|i| (i % 251) as u8));
        fs::write(&path, &bytes).unwrap();
        let digest = digest_of(&bytes);
        let modified = modified_ms(&fs::metadata(&path).unwrap()).unwrap();
        let index = json!({ "version": 1, "kept": {}, "videos": {
            digest.clone(): { "path": path.to_string_lossy(), "sizeBytes": size, "modifiedMs": modified, "at": 1 }
        } });
        fs::write(data.path().join(MEDIA_INDEX), serde_json::to_string(&index).unwrap()).unwrap();
        let record = json!({ "id": "a", "kind": "tool", "media": [
            { "id": "m0", "digest": digest, "kind": "video", "mimeType": "video/mp4", "sizeBytes": size, "name": "clip.mp4", "source": "file" }
        ] });
        (data, path, record)
    }

    #[test]
    fn a_request_is_read_as_nodes_strict_schema_reads_it() {
        let picture = |value: Value| media_request("thread-media", Some(&value));
        let part = |value: Value| media_request("thread-media-part", Some(&value));
        assert_eq!(picture(json!({ "threadId": "t", "activityId": "a", "mediaId": "m0" })), Some(picture_request("m0")));
        assert_eq!(
            picture(json!({ "threadId": "t", "activityId": "a", "mediaId": "m7", "edge": 640 })).map(|r| r.edge),
            Some(true)
        );
        assert_eq!(picture(json!({ "threadId": "t", "activityId": "a", "mediaId": "m0", "edge": 500 })), None);
        assert_eq!(picture(json!({ "threadId": "t", "activityId": "a", "mediaId": "m8" })), None);
        assert_eq!(picture(json!({ "threadId": "t", "activityId": "a", "mediaId": "m0", "part": 0 })), None);
        assert_eq!(picture(json!({ "threadId": "", "activityId": "a", "mediaId": "m0" })), None);
        assert_eq!(part(json!({ "threadId": "t", "activityId": "a", "mediaId": "m0", "part": 3.0 })).map(|r| r.read), Some(MediaRead::VideoPart(3)));
        assert_eq!(part(json!({ "threadId": "t", "activityId": "a", "mediaId": "m0", "part": AGENT_VIDEO_PARTS_MAX })), None);
        assert_eq!(part(json!({ "threadId": "t", "activityId": "a", "mediaId": "m0", "part": 1.5 })), None);
        assert_eq!(part(json!({ "threadId": "t", "activityId": "a", "mediaId": "m0" })), None);
        assert_eq!(part(json!({ "threadId": "t", "activityId": "a", "mediaId": "m0", "part": 0, "edge": 320 })), None);
        assert_eq!(media_request("thread-media", Some(&json!("t"))), None);
        assert_eq!(AGENT_VIDEO_PARTS_MAX, 25);
    }

    #[test]
    fn a_picture_the_record_names_is_answered_as_a_data_url() {
        let bytes = png(64);
        let (data, record) = kept_picture(&bytes);
        let answer = read_media(data.path(), Some(&record), &picture_request("m0")).unwrap();
        assert_eq!(answer, json!({ "dataUrl": format!("data:image/png;base64,{}", STANDARD.encode(&bytes)) }));
    }

    #[test]
    fn only_what_the_record_names_is_read() {
        let bytes = png(64);
        let (data, record) = kept_picture(&bytes);
        // The store keeps the picture, but no record names it, or the record names another media ID.
        assert_eq!(read_media(data.path(), None, &picture_request("m0")), Ok(Value::Null));
        assert_eq!(read_media(data.path(), Some(&json!({ "id": "a" })), &picture_request("m0")), Ok(Value::Null));
        assert_eq!(read_media(data.path(), Some(&record), &picture_request("m1")), Ok(Value::Null));
        // A record whose digest is not a digest names no file, so nothing outside the store is reached through it.
        let mut escaping = record.clone();
        escaping["media"][0]["digest"] = json!("../../secret");
        assert_eq!(read_media(data.path(), Some(&escaping), &picture_request("m0")), Ok(Value::Null));
        // A record that names the picture as another type, or another size, does not describe what the store keeps.
        let mut jpeg = record.clone();
        jpeg["media"][0]["mimeType"] = json!("image/jpeg");
        assert_eq!(read_media(data.path(), Some(&jpeg), &picture_request("m0")), Ok(Value::Null));
        let mut larger = record.clone();
        larger["media"][0]["sizeBytes"] = json!(65);
        assert_eq!(read_media(data.path(), Some(&larger), &picture_request("m0")), Ok(Value::Null));
        // A picture handle never reads a video part, nor a video handle a picture.
        assert_eq!(read_media(data.path(), Some(&record), &part_request(0)), Ok(Value::Null));
        let (video_data, _, video) = remembered(64);
        assert_eq!(read_media(video_data.path(), Some(&video), &picture_request("m0")), Ok(Value::Null));
    }

    #[test]
    fn a_picture_whose_bytes_changed_or_are_over_the_limit_is_null() {
        let bytes = png(64);
        let (data, record) = kept_picture(&bytes);
        let file = data.path().join(MEDIA_FOLDER).join(format!("{}.png", digest_of(&bytes)));
        let mut changed = bytes.clone();
        changed[20] = 9;
        fs::write(&file, &changed).unwrap();
        assert_eq!(read_media(data.path(), Some(&record), &picture_request("m0")), Ok(Value::Null));

        let mut over = record.clone();
        over["media"][0]["sizeBytes"] = json!(AGENT_MAX_IMAGE_BYTES + 1);
        assert_eq!(read_media(data.path(), Some(&over), &picture_request("m0")), Ok(Value::Null));
        fs::remove_file(&file).unwrap();
        assert_eq!(read_media(data.path(), Some(&record), &picture_request("m0")), Ok(Value::Null));
    }

    #[test]
    fn a_video_is_answered_in_parts_with_what_the_whole_is() {
        let size = AGENT_VIDEO_PART_BYTES as usize + 100;
        let (data, path, record) = remembered(size);
        let bytes = fs::read(&path).unwrap();
        let first = read_media(data.path(), Some(&record), &part_request(0)).unwrap();
        assert_eq!(first["parts"], json!(2));
        assert_eq!(first["part"], json!(0));
        assert_eq!(first["sizeBytes"], json!(size));
        assert_eq!(first["name"], json!("clip.mp4"));
        assert_eq!(first["mimeType"], json!("video/mp4"));
        assert_eq!(first["digest"], json!(digest_of(&bytes)));
        assert_eq!(STANDARD.decode(first["data"].as_str().unwrap()).unwrap(), &bytes[..AGENT_VIDEO_PART_BYTES as usize]);
        let last = read_media(data.path(), Some(&record), &part_request(1)).unwrap();
        assert_eq!(STANDARD.decode(last["data"].as_str().unwrap()).unwrap(), &bytes[AGENT_VIDEO_PART_BYTES as usize..]);
        let mut keys = last.as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>();
        keys.sort_unstable();
        assert_eq!(keys, ["data", "digest", "mimeType", "name", "part", "parts", "sizeBytes"]);
    }

    #[test]
    fn a_part_past_the_end_is_null() {
        let (data, _, record) = remembered(1000);
        assert!(read_media(data.path(), Some(&record), &part_request(0)).unwrap().is_object());
        assert_eq!(read_media(data.path(), Some(&record), &part_request(1)), Ok(Value::Null));
        assert_eq!(read_media(data.path(), Some(&record), &part_request(24)), Ok(Value::Null));
    }

    #[test]
    fn a_video_that_changed_between_parts_is_refused() {
        let size = AGENT_VIDEO_PART_BYTES as usize + 100;
        let (data, path, record) = remembered(size);
        assert!(read_media(data.path(), Some(&record), &part_request(0)).unwrap().is_object());
        // The same size, changed later: no longer the video the store found.
        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_modified(SystemTime::now() + Duration::from_secs(5)).unwrap();
        drop(file);
        assert_eq!(read_media(data.path(), Some(&record), &part_request(1)), Ok(Value::Null));

        // Another size: the same.
        let (data, path, record) = remembered(size);
        assert!(read_media(data.path(), Some(&record), &part_request(0)).unwrap().is_object());
        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(size as u64 - 1).unwrap();
        drop(file);
        assert_eq!(read_media(data.path(), Some(&record), &part_request(1)), Ok(Value::Null));
    }

    /// What Node 24's `mtimeMs` reads for a file 1.5 s before the epoch, on Windows 11 and elsewhere.
    #[cfg(windows)]
    const NODE_BEFORE_EPOCH_MS: f64 = 4_294_967_294_500.0;
    #[cfg(not(windows))]
    const NODE_BEFORE_EPOCH_MS: f64 = -1500.0;

    /// Node's `mtimeMs` for times before the epoch, which a video's file can have (an archive's, or a copy that kept one).
    /// The Windows values are what Node 24 read on Windows 11 for files whose times Rust set to these.
    #[test]
    fn a_time_before_the_epoch_is_counted_as_node_counts_it() {
        let at = |forward: bool, secs: u64, nanos: u32| {
            let span = Duration::new(secs, nanos);
            millis_of(if forward { UNIX_EPOCH + span } else { UNIX_EPOCH - span })
        };
        assert_eq!(at(true, 1, 500_000_000), 1500.0);
        assert_eq!(at(true, 0, 0), 0.0);
        assert_eq!(at(false, 1, 500_000_000), NODE_BEFORE_EPOCH_MS);
        #[cfg(windows)]
        let before = [4_294_967_295_750.0, 4_294_967_294_000.0, 4_294_967_295_000.0, 4_293_967_295_876.543_5, 4_263_431_295_012.345_7, 4_294_967_296_000.0];
        // -1.0000001 s is -2 s and 999 999 900 ns, in Node's arithmetic.
        #[cfg(not(windows))]
        let before = [-250.0, -2000.0, -1000.0001, -1_000_000_123.456_7, -31_536_000_987.654_3, -0.000_099_999_999_974_897_95];
        let spans = [(0, 250_000_000), (2, 0), (1, 100), (1_000_000, 123_456_700), (31_536_000, 987_654_300), (0, 100)];
        for ((secs, nanos), node) in spans.into_iter().zip(before) {
            assert_eq!(at(false, secs, nanos), node, "{secs} s {nanos} ns before the epoch");
        }
    }

    #[test]
    fn a_video_whose_file_dates_from_before_the_epoch_is_read() {
        let (data, path, record) = remembered(1000);
        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_modified(UNIX_EPOCH - Duration::from_millis(1500)).unwrap();
        drop(file);
        // As Node remembered it: its `mtimeMs` of that file.
        let mut index: Value = serde_json::from_str(&fs::read_to_string(data.path().join(MEDIA_INDEX)).unwrap()).unwrap();
        let digest = record["media"][0]["digest"].as_str().unwrap().to_string();
        index["videos"][&digest]["modifiedMs"] = json!(NODE_BEFORE_EPOCH_MS);
        fs::write(data.path().join(MEDIA_INDEX), index.to_string()).unwrap();
        assert_eq!(modified_ms(&fs::metadata(&path).unwrap()), Some(NODE_BEFORE_EPOCH_MS));
        assert!(read_media(data.path(), Some(&record), &part_request(0)).unwrap().is_object());
    }

    #[test]
    fn a_video_is_read_only_from_where_the_store_remembers_it() {
        let (data, path, record) = remembered(1000);
        // A record naming a size the store did not remember the video at reads nothing.
        let mut resized = record.clone();
        resized["media"][0]["sizeBytes"] = json!(999);
        assert_eq!(read_media(data.path(), Some(&resized), &part_request(0)), Ok(Value::Null));
        // Over the largest a tile plays.
        let mut over = record.clone();
        over["media"][0]["sizeBytes"] = json!(AGENT_VIDEO_MAX_BYTES + 1);
        assert_eq!(read_media(data.path(), Some(&over), &part_request(0)), Ok(Value::Null));
        // An index Node's schema would refuse as a whole remembers no video.
        let index: Value = serde_json::from_str(&fs::read_to_string(data.path().join(MEDIA_INDEX)).unwrap()).unwrap();
        let mut refused = index.clone();
        refused["kept"] = json!({ "not-a-digest": { "sizeBytes": 1, "at": 1 } });
        fs::write(data.path().join(MEDIA_INDEX), refused.to_string()).unwrap();
        assert_eq!(read_media(data.path(), Some(&record), &part_request(0)), Ok(Value::Null));
        // A network path is never opened.
        let mut network = index.clone();
        let digest = record["media"][0]["digest"].as_str().unwrap().to_string();
        network["videos"][&digest]["path"] = json!("\\\\server\\share\\clip.mp4");
        fs::write(data.path().join(MEDIA_INDEX), network.to_string()).unwrap();
        assert_eq!(read_media(data.path(), Some(&record), &part_request(0)), Ok(Value::Null));
        // No index at all: nothing is remembered.
        fs::remove_file(data.path().join(MEDIA_INDEX)).unwrap();
        assert_eq!(read_media(data.path(), Some(&record), &part_request(0)), Ok(Value::Null));
        assert!(path.exists());
    }
}
