//! A file a thread's message links to, read on the machine the thread runs on (ADR-0120, November 3 and November 12
//! amendments), as Node's `FilesService.previewLink` and `FilesService.linkedFile` (`src/main/files/service.ts`) read it
//! for the `thread-file-link` and `thread-linked-file` host operations.
//!
//! An absolute or `~/` path may name anything on this machine; a path written relative to the thread is read from the
//! thread's working folder and must stay inside it. These reads open nothing: they answer a Markdown file's text, where a
//! file is, its preview, or one part of its bytes, and a file that changed while it was read is refused.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::ops::{
    is_markdown_file_name, is_valid_relative_path, open_preview_file, preview_content, text_of, tools_err, tools_ok,
    verify_open_handle_inside, ThreadWorkspace, MAX_IMAGE_PREVIEW_BYTES, MAX_TEXT_PREVIEW_BYTES,
};
use crate::protocol_fields::{hex, is_digest, on_network, protocol_id, utf16_len, whole_number};

/// One part of a linked file a host sends for a download, as Node's `FILES_DOWNLOAD_PART_BYTES`.
pub const FILES_DOWNLOAD_PART_BYTES: usize = 4 * 1024 * 1024;

const NOT_HERE: &str = "This file is not on the computer this thread runs on, or it has moved. Nothing was opened.";
const OUTSIDE: &str = "This link points outside the thread\u{2019}s folder. Nothing was opened.";
const NOT_A_FILE: &str = "This link is not a file. Nothing was opened.";
const CHANGED: &str = "This file changed. Read it again.";
const CHANGED_IN_DOWNLOAD: &str = "This file changed while it was being downloaded. Nothing was saved.";

type Answer<T> = Result<T, Value>;

/// What a `thread-linked-file` request asks of a linked file, as Node's `linkedFileRequestSchema`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkedWant {
    /// Where it is, so Files can show it.
    Place,
    /// Its text or picture within Files' own limits.
    Preview,
    /// One part of its bytes from `offset`, for a download; `revision` is the one the first part answered.
    Part { offset: u64, revision: Option<String> },
}

/// Which of the two link reads a request asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkRead {
    /// `thread-file-link`: a Markdown file's text, for the side panel.
    MarkdownLink,
    /// `thread-linked-file`: where a linked file is, its preview, or one part of it.
    LinkedFile(LinkedWant),
}

impl LinkRead {
    /// The feature a host offers for this read.
    pub fn feature(&self) -> &'static str {
        match self {
            LinkRead::MarkdownLink => "thread-file-links",
            LinkRead::LinkedFile(_) => "thread-linked-files",
        }
    }
}

/// A `thread-file-link` or `thread-linked-file` request as Node's strict schema reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkRequest {
    pub thread_id: String,
    pub path: String,
    pub read: LinkRead,
}

/// A path as Node's `fileLinkPathSchema` takes one: never a network share or device path (`\\host\share`, `//host`,
/// `\\?\`), whose resolving reaches the network, nor a drive-relative `C:file`.
fn is_link_path(path: &str) -> bool {
    let len = utf16_len(path);
    let bytes = path.as_bytes();
    (1..=4096).contains(&len)
        && !path.chars().any(|c| matches!(c, '\x00'..='\x1f' | '\x7f'))
        && !on_network(path)
        && !(bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && !matches!(bytes.get(2), Some(b'\\' | b'/')))
}

/// The thread and path every link request names, and no field but `allowed`.
fn link_fields<'a>(value: Option<&'a Value>, allowed: &[&str]) -> Option<(&'a serde_json::Map<String, Value>, String, String)> {
    let fields = value?.as_object()?;
    if fields.keys().any(|key| key != "threadId" && key != "path" && !allowed.contains(&key.as_str())) {
        return None;
    }
    let thread_id = protocol_id(fields.get("threadId"))?;
    let path = fields.get("path")?.as_str().filter(|path| is_link_path(path))?;
    Some((fields, thread_id, path.to_string()))
}

/// What a `thread-linked-file` request asks for (`linkedFileRequestSchema`), or `None` when Node's schema refuses it.
fn linked_want(fields: &serde_json::Map<String, Value>) -> Option<LinkedWant> {
    match fields.get("want")?.as_str()? {
        "place" | "preview" if fields.contains_key("offset") || fields.contains_key("revision") => None,
        "place" => Some(LinkedWant::Place),
        "preview" => Some(LinkedWant::Preview),
        "part" => {
            let offset = whole_number(fields.get("offset")?)?;
            let revision = match fields.get("revision") {
                None => None,
                Some(revision) => Some(
                    revision.as_str().filter(|r| is_digest(r))?.to_string(),
                ),
            };
            Some(LinkedWant::Part { offset, revision })
        }
        _ => None,
    }
}

/// The request a `thread-file-link` (`fileLinkRequestSchema`) or `thread-linked-file` (`linkedFileRequestSchema`)
/// operation carries, or `None` when Node's schema refuses it or `op` is neither.
pub fn link_request(op: &str, value: Option<&Value>) -> Option<LinkRequest> {
    let markdown = match op {
        "thread-file-link" => true,
        "thread-linked-file" => false,
        _ => return None,
    };
    let (fields, thread_id, path) = link_fields(value, if markdown { &[] } else { &["want", "offset", "revision"] })?;
    let read = if markdown { LinkRead::MarkdownLink } else { LinkRead::LinkedFile(linked_want(fields)?) };
    Some(LinkRequest { thread_id, path, read })
}

/// Answers a link read on this machine, for the thread's working copy when the host knows the thread.
pub fn read_link(workspace: Option<&ThreadWorkspace>, request: &LinkRequest) -> Value {
    let answer = match &request.read {
        LinkRead::MarkdownLink => markdown_link(workspace, &request.path),
        LinkRead::LinkedFile(want) => linked_file(workspace, &request.path, want),
    };
    answer.map_or_else(|refused| refused, tools_ok)
}

/// A path as a link wrote it, without a trailing location, as Node's `withoutLinkLocation`: a line such as `:12` or
/// `#L12`, a page such as `#page=2`, or a heading. A fragment holding a folder separator is part of a name, as in
/// `C#/notes.md`.
pub fn without_link_location(path: &str) -> &str {
    // `#` followed by anything but `#`, `/` or `\` to the end.
    if let Some(at) = path.rfind('#') {
        if !path[at + 1..].contains(['/', '\\']) {
            return &path[..at];
        }
    }
    // `:` and digits, optionally `:` or `-` and digits, to the end.
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
    if let Some(at) = path.rfind(':') {
        let tail = &path[at + 1..];
        if digits(tail) {
            // `:12-14` or `:12:3`: the line's own colon comes before.
            let before = &path[..at];
            if let Some(line_at) = before.rfind(':') {
                if digits(&before[line_at + 1..]) {
                    return &path[..line_at];
                }
            }
            return before;
        }
        if let Some(dash) = tail.find('-') {
            if digits(&tail[..dash]) && digits(&tail[dash + 1..]) {
                return &path[..at];
            }
        }
    }
    path
}

/// A Windows path with the drive first, as Node's `withDriveFirst`: a `file:` URL's path and Codex's links write
/// `/D:/Projects/notes.md`.
pub fn with_drive_first(path: &str) -> &str {
    let bytes = path.as_bytes();
    if bytes.len() >= 4 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b':' && matches!(bytes[3], b'/' | b'\\') {
        &path[1..]
    } else {
        path
    }
}

/// A file's own name, whichever separator its path is written with, as Node's `nameOf`.
fn name_of(path: &str) -> &str {
    path.rfind(['/', '\\']).map_or(path, |at| &path[at + 1..])
}

fn is_separator(c: char) -> bool {
    c == '/' || (cfg!(windows) && c == '\\')
}

/// How much of an absolute path is its root, as Node's `path.isAbsolute` reads one on this platform: on Windows a drive
/// with its separator (`C:\`) or a rooted path's separator alone (`\x`, `/x`), elsewhere the leading `/`. 0 for a
/// relative path.
fn root_length(path: &str) -> usize {
    let bytes = path.as_bytes();
    if cfg!(windows) && bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'/' | b'\\') {
        3
    } else if path.starts_with(is_separator) {
        1
    } else {
        0
    }
}

fn is_absolute(path: &str) -> bool {
    root_length(path) > 0
}

/// A path under the home folder, `~` alone or `~/...`.
fn is_home(path: &str) -> bool {
    path == "~" || path.starts_with("~/") || path.starts_with("~\\")
}

/// The home folder Node's `os.homedir()` names: `USERPROFILE` first on Windows and `HOME` first elsewhere, or `None`
/// when neither is set.
fn home_folder() -> Option<PathBuf> {
    let order: [&str; 2] = if cfg!(windows) { ["USERPROFILE", "HOME"] } else { ["HOME", "USERPROFILE"] };
    order
        .iter()
        .find_map(|name| std::env::var_os(name).filter(|home| !home.is_empty()))
        .map(PathBuf::from)
}

/// Adds one name to a path. On Windows `PathBuf::push` takes a segment such as `D:` for a drive and starts again from
/// it; Node's `path.resolve` reads it as a name, so it is written after a separator instead.
fn push_name(out: &mut PathBuf, name: &str) {
    if cfg!(windows) {
        let text = out.as_mut_os_string();
        if !matches!(text.as_encoded_bytes().last(), Some(b'\\' | b'/')) {
            text.push("\\");
        }
        text.push(name);
    } else {
        out.push(name);
    }
}

/// `path` resolved from `base` as Node's `path.resolve(base, path)` does, by its words alone before anything is
/// followed, so a `sub/../x` names `base/x` whatever `sub` links to. An absolute `path` stands on its own, a rooted one
/// on Windows on `base`'s drive.
fn resolve_from(base: &Path, path: &str) -> PathBuf {
    let root = root_length(path);
    let mut out = if root == 0 {
        base.to_path_buf()
    } else if root == 1 && cfg!(windows) {
        base.components()
            .take_while(|part| matches!(part, Component::Prefix(_) | Component::RootDir))
            .collect()
    } else {
        PathBuf::from(&path[..root])
    };
    for part in path[root..].split(is_separator) {
        match part {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            name => push_name(&mut out, name),
        }
    }
    out
}

/// Whether `target` is `root` or inside it. Both are real paths, so no link can lead out between them.
fn inside(root: &Path, target: &Path) -> bool {
    target.starts_with(root)
}

/// The failure an OS error is answered with, as Node's `run` answers it: never the raw error, which can disclose a
/// link's target outside.
fn io_failure(error: &std::io::Error) -> Value {
    use std::io::ErrorKind;
    let lost = matches!(error.kind(), ErrorKind::NotFound | ErrorKind::PermissionDenied | ErrorKind::NotADirectory) || {
        #[cfg(target_os = "linux")]
        let looped = error.raw_os_error() == Some(40);
        #[cfg(target_os = "macos")]
        let looped = error.raw_os_error() == Some(62);
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        let looped = false;
        looped
    };
    tools_err(
        if lost { "path-unavailable" } else { "unavailable" },
        "This path is unavailable or changed. Refresh Files and try again.",
    )
}

/// Which version of a file a read saw, as Node's `sameRevision` compares one: the file it is (device and inode, and
/// when it was made), its size, and when its contents and its record last changed. Every field is read from the
/// system; where one cannot be, there is no revision and the read is refused, so none is ever made from missing fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Revision {
    dev: u64,
    ino: u64,
    birth: i128,
    size: u64,
    mtime: i128,
    ctime: i128,
}

impl Revision {
    /// A file's record as `stat` gives it. Where the file system keeps no birth time, 0 stands for it, as Node's
    /// `birthtimeNs` is 0 there, so the revision of an unchanged file stays the same.
    #[cfg(unix)]
    fn of_metadata(meta: &fs::Metadata) -> Self {
        use std::os::unix::fs::MetadataExt;
        let birth = meta
            .created()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |since| since.as_nanos() as i128);
        Self {
            dev: meta.dev(),
            ino: meta.ino(),
            birth,
            size: meta.size(),
            mtime: i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec()),
            ctime: i128::from(meta.ctime()) * 1_000_000_000 + i128::from(meta.ctime_nsec()),
        }
    }

    /// The revision of the file a real path names, as Node's `stat` reads it.
    fn of_path(path: &Path) -> Option<Self> {
        #[cfg(unix)]
        {
            fs::metadata(path).ok().map(|meta| Self::of_metadata(&meta))
        }
        #[cfg(windows)]
        {
            // Stable Rust's record of a path holds no volume, file index or change time, so the path is opened to read
            // its attributes alone and asked through its handle, as for an open file.
            use std::os::windows::fs::OpenOptionsExt;
            const FILE_READ_ATTRIBUTES: u32 = 0x80;
            const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
            fs::OpenOptions::new()
                .access_mode(FILE_READ_ATTRIBUTES)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
                .open(path)
                .ok()
                .and_then(|file| Self::of_file(&file))
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = path;
            None
        }
    }

    /// The revision of an open file, as Node's `fstat` reads it.
    fn of_file(file: &fs::File) -> Option<Self> {
        #[cfg(unix)]
        {
            file.metadata().ok().map(|meta| Self::of_metadata(&meta))
        }
        #[cfg(windows)]
        {
            windows_revision(file)
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = file;
            None
        }
    }

    /// The download's revision: sha256 of `dev:ino:birthtimeNs:size:mtimeNs:ctimeNs`, as Node's `linkedFile` names it.
    fn hash(&self) -> String {
        let words = format!("{}:{}:{}:{}:{}:{}", self.dev, self.ino, self.birth, self.size, self.mtime, self.ctime);
        hex(&Sha256::digest(words.as_bytes()))
    }
}

/// An open file's revision through kernel32, as Node's `fstat` reads it on Windows: the volume serial number and file
/// index as `dev` and `ino`, and NTFS's creation, last write and change times (in its own 100 ns ticks, which only need
/// to stay the same for an unchanged file). `None` when either call fails.
#[cfg(windows)]
fn windows_revision(file: &fs::File) -> Option<Revision> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    #[derive(Default)]
    #[allow(dead_code)] // kernel32 writes every field; Sotto reads the volume, size and index.
    struct ByHandleFileInformation {
        attributes: u32,
        creation: [u32; 2],
        last_access: [u32; 2],
        last_write: [u32; 2],
        volume_serial_number: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    #[allow(dead_code)] // kernel32 writes every field; Sotto reads the times.
    struct FileBasicInfo {
        creation: i64,
        last_access: i64,
        last_write: i64,
        change: i64,
        attributes: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileInformationByHandle(handle: *mut std::ffi::c_void, info: *mut ByHandleFileInformation) -> i32;
        fn GetFileInformationByHandleEx(handle: *mut std::ffi::c_void, class: i32, info: *mut std::ffi::c_void, size: u32) -> i32;
    }
    const FILE_BASIC_INFO_CLASS: i32 = 0;
    let mut info = ByHandleFileInformation::default();
    let mut basic = FileBasicInfo::default();
    // SAFETY: both structures are the size and layout kernel32 writes, and the handle is open for as long as `file` is.
    let read = unsafe {
        GetFileInformationByHandle(file.as_raw_handle(), &mut info) != 0
            && GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FILE_BASIC_INFO_CLASS,
                (&mut basic as *mut FileBasicInfo).cast(),
                std::mem::size_of::<FileBasicInfo>() as u32,
            ) != 0
    };
    read.then(|| Revision {
        dev: u64::from(info.volume_serial_number),
        ino: (u64::from(info.index_high) << 32) | u64::from(info.index_low),
        birth: i128::from(basic.creation),
        size: (u64::from(info.size_high) << 32) | u64::from(info.size_low),
        mtime: i128::from(basic.last_write),
        ctime: i128::from(basic.change),
    })
}

/// Where a link's path led: the real file, its record, the path as written that found it, whether that path was
/// written relative to the thread, and for a regular file its revision when it was found.
struct Located {
    absolute: PathBuf,
    meta: fs::Metadata,
    written: String,
    relative_to_thread: bool,
    revision: Option<Revision>,
}

fn located(root: &Path, home: Option<&Path>, candidate: &str) -> Option<Located> {
    let is_home = is_home(candidate);
    let relative_to_thread = !is_home && !is_absolute(candidate);
    let absolute = if relative_to_thread {
        resolve_from(root, candidate)
    } else if is_home {
        // With no home folder known, a `~/` path names nothing here. As Node's `resolve(homedir(), candidate.slice(2))`,
        // `~//x` is the absolute `/x`.
        resolve_from(home?, candidate.get(2..).unwrap_or(""))
    } else {
        PathBuf::from(candidate)
    };
    let absolute = fs::canonicalize(absolute).ok()?;
    let meta = fs::metadata(&absolute).ok()?;
    let revision = if meta.is_file() { Revision::of_path(&absolute) } else { None };
    Some(Located { absolute, meta, written: candidate.to_string(), relative_to_thread, revision })
}

/// Where a link's path leads, as Node's `locateLink`: the path as written wins, then with the drive first for a Windows
/// path written `/D:/...`, then each of those without a trailing location.
fn locate_link(root: &Path, home: Option<&Path>, path: &str) -> Option<Located> {
    let bare = without_link_location(path);
    let mut tried: Vec<&str> = Vec::with_capacity(4);
    for candidate in [path, with_drive_first(path), bare, with_drive_first(bare)] {
        if candidate.is_empty() || tried.contains(&candidate) {
            continue;
        }
        tried.push(candidate);
        if let Some(found) = located(root, home, candidate) {
            return Some(found);
        }
    }
    None
}

/// The thread's working folder as a real path, as Node's `FilesService.workspace` finds it.
fn workspace_root(workspace: Option<&ThreadWorkspace>) -> Answer<PathBuf> {
    let Some(workspace) = workspace else {
        return Err(tools_err("thread-unavailable", "This thread is unavailable. Select a thread and refresh Files."));
    };
    if !is_absolute(&workspace.working_directory) {
        return Err(tools_err("workspace-unavailable", "The thread working directory is unavailable."));
    }
    fs::canonicalize(&workspace.working_directory)
        .ok()
        .filter(|root| fs::metadata(root).is_ok_and(|meta| meta.is_dir()))
        .ok_or_else(|| {
            tools_err(
                "workspace-unavailable",
                "The thread working directory is unavailable. Restore the folder and refresh Files.",
            )
        })
}

/// Where a link's path leads, held inside the thread's folder when it is written relative to it, as Node's `linked`.
fn found_link(root: &Path, path: &str) -> Answer<Located> {
    let found = locate_link(root, home_folder().as_deref(), path).ok_or_else(|| tools_err("path-unavailable", NOT_HERE))?;
    if found.relative_to_thread && !inside(root, &found.absolute) {
        return Err(tools_err("path-outside-workspace", OUTSIDE));
    }
    Ok(found)
}

/// Opens a linked regular file to read, refused in Node's words when it is no longer the file found at its path: another
/// revision, or for a link written relative to the thread a file outside its folder. When the system cannot say which
/// file it is, the read is refused with `unread`, the words for a file that changed.
fn open_unchanged(root: &Path, found: &Located, unread: &str) -> Answer<(fs::File, Revision)> {
    let file = open_preview_file(&found.absolute).map_err(|error| io_failure(&error))?;
    let before = file.metadata().map_err(|error| io_failure(&error))?;
    let (Some(recorded), Some(revision)) = (found.revision, Revision::of_file(&file)) else {
        return Err(tools_err("path-unavailable", unread));
    };
    if !before.is_file() || revision != recorded || (found.relative_to_thread && !verify_open_handle_inside(root, &file)) {
        return Err(tools_err("path-unavailable", CHANGED));
    }
    Ok((file, revision))
}

/// A file's whole contents, refused when it changed during the read, as Node's `wholeFile`.
fn whole_file(file: &fs::File, before: &Revision) -> Answer<Vec<u8>> {
    let mut bytes = Vec::new();
    file.take(before.size.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| io_failure(&error))?;
    if bytes.len() as u64 != before.size || Revision::of_file(file).as_ref() != Some(before) {
        return Err(tools_err(
            "path-unavailable",
            "This file changed while it was being read. Refresh Files and try again.",
        ));
    }
    Ok(bytes)
}

/// A Markdown file a thread's message links to, for the side panel, as Node's `FilesService.previewLink`. Both the path
/// as written and the file it really is must be Markdown, so a link named `notes.md` that leads to a key is refused. It
/// answers the file's text and the link's own name, never where the path led.
fn markdown_link(workspace: Option<&ThreadWorkspace>, path: &str) -> Answer<Value> {
    let root = workspace_root(workspace)?;
    let found = found_link(&root, path)?;
    if !found.meta.is_file() {
        return Err(tools_err("not-file", NOT_A_FILE));
    }
    if !is_markdown_file_name(&found.written) || !is_markdown_file_name(&found.absolute.to_string_lossy()) {
        return Err(tools_err("invalid-request", "This link does not lead to a Markdown file. Nothing was opened."));
    }
    if found.meta.len() > MAX_TEXT_PREVIEW_BYTES as u64 {
        return Err(tools_err("too-large", "Markdown files open here up to 512 KB. Nothing was opened."));
    }
    let (file, before) = open_unchanged(&root, &found, CHANGED)?;
    let bytes = whole_file(&file, &before)?;
    let text = text_of(&bytes)?;
    Ok(json!({ "name": name_of(&found.written), "size": bytes.len(), "text": text }))
}

/// The thread folder's relative path to `target`, slash-separated as Files names it, when it is one Files can name.
fn path_within(root: &Path, target: &Path) -> Option<String> {
    let rest = target.strip_prefix(root).ok()?;
    let parts = rest.components().map(|part| part.as_os_str().to_str()).collect::<Option<Vec<_>>>()?;
    let path = parts.join("/");
    is_valid_relative_path(&path).then_some(path)
}

/// A file a thread's message links to, for Files on another computer, as Node's `FilesService.linkedFile`: where it is,
/// its preview within Files' own limits, or one part of its bytes for a download. A file that changed between two parts
/// is refused rather than saved in halves.
fn linked_file(workspace: Option<&ThreadWorkspace>, path: &str, want: &LinkedWant) -> Answer<Value> {
    let root = workspace_root(workspace)?;
    let found = found_link(&root, path)?;
    if !found.meta.is_file() && !found.meta.is_dir() {
        return Err(tools_err("path-unavailable", "This link is not a file or folder. Nothing was opened."));
    }
    // The link's own name, as a linked Markdown file's is; where the path led stays here.
    let name = match name_of(found.written.trim_end_matches(['/', '\\'])) {
        "" => found.absolute.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default(),
        name => name.to_string(),
    };
    let regular_file = || if found.meta.is_file() { Ok(()) } else { Err(tools_err("not-file", NOT_A_FILE)) };
    match want {
        LinkedWant::Place => {
            // A place Files cannot name, such as one its listing would show as unavailable, is shown alone as a file
            // outside is.
            let within = path_within(&root, &found.absolute);
            Ok(json!({
                "is": "place",
                "name": name,
                "kind": if found.meta.is_dir() { "directory" } else { "file" },
                "size": if found.meta.is_file() { found.meta.len() } else { 0 },
                "inside": within.map(|path| json!({ "workspace": workspace, "path": path })),
            }))
        }
        LinkedWant::Preview => {
            regular_file()?;
            if found.meta.len() > MAX_IMAGE_PREVIEW_BYTES as u64 {
                return Err(tools_err("too-large", "This file exceeds the 8 MiB preview limit."));
            }
            let (file, before) = open_unchanged(&root, &found, CHANGED)?;
            let bytes = whole_file(&file, &before)?;
            let content = preview_content(&bytes, &name)?;
            Ok(json!({ "is": "preview", "name": name, "size": bytes.len(), "content": content }))
        }
        LinkedWant::Part { offset, revision } => {
            regular_file()?;
            let (mut file, before) = open_unchanged(&root, &found, CHANGED_IN_DOWNLOAD)?;
            let hash = before.hash();
            if revision.as_ref().is_some_and(|asked| *asked != hash) {
                return Err(tools_err("path-unavailable", CHANGED_IN_DOWNLOAD));
            }
            let (offset, size) = (*offset, before.size);
            if offset > size {
                return Err(tools_err("invalid-request", "This part is past the end of the file. Nothing was saved."));
            }
            let length = (FILES_DOWNLOAD_PART_BYTES as u64).min(size - offset);
            let mut bytes = Vec::with_capacity(length as usize);
            file.seek(SeekFrom::Start(offset)).map_err(|error| io_failure(&error))?;
            (&file).take(length).read_to_end(&mut bytes).map_err(|error| io_failure(&error))?;
            if bytes.len() as u64 != length || Revision::of_file(&file) != Some(before) {
                return Err(tools_err("path-unavailable", CHANGED_IN_DOWNLOAD));
            }
            Ok(json!({ "is": "part", "name": name, "size": size, "offset": offset, "data": STANDARD.encode(&bytes), "revision": hash }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace_at(folder: &Path) -> ThreadWorkspace {
        ThreadWorkspace::build("thread-1", "project-1", &folder.to_string_lossy())
    }

    fn code(answer: &Value) -> Option<&str> {
        answer.pointer("/error/code").and_then(Value::as_str)
    }

    fn message(answer: &Value) -> Option<&str> {
        answer.pointer("/error/message").and_then(Value::as_str)
    }

    fn request(path: &str, read: LinkRead) -> LinkRequest {
        LinkRequest { thread_id: "thread-1".into(), path: path.into(), read }
    }

    fn thread_file_link(workspace: Option<&ThreadWorkspace>, path: &str) -> Value {
        read_link(workspace, &request(path, LinkRead::MarkdownLink))
    }

    fn thread_linked_file(workspace: Option<&ThreadWorkspace>, path: &str, want: &LinkedWant) -> Value {
        read_link(workspace, &request(path, LinkRead::LinkedFile(want.clone())))
    }

    #[test]
    fn strips_a_trailing_location_as_node_does() {
        assert_eq!(without_link_location("notes.md:12"), "notes.md");
        assert_eq!(without_link_location("notes.md:12:3"), "notes.md");
        assert_eq!(without_link_location("notes.md:12-14"), "notes.md");
        assert_eq!(without_link_location("notes.md#L12"), "notes.md");
        assert_eq!(without_link_location("guide.pdf#page=2"), "guide.pdf");
        assert_eq!(without_link_location("docs/ci.md#reading-a-failure"), "docs/ci.md");
        // A fragment holding a folder separator is part of a name.
        assert_eq!(without_link_location("C#/notes.md"), "C#/notes.md");
        assert_eq!(without_link_location("notes.md"), "notes.md");
        assert_eq!(without_link_location("D:/notes.md"), "D:/notes.md");
        assert_eq!(without_link_location("notes.md:"), "notes.md:");
        assert_eq!(without_link_location("notes.md:a"), "notes.md:a");
    }

    #[test]
    fn puts_the_drive_first_only_for_a_slashed_windows_path() {
        assert_eq!(with_drive_first("/D:/Projects/notes.md"), "D:/Projects/notes.md");
        assert_eq!(with_drive_first("/d:\\notes.md"), "d:\\notes.md");
        assert_eq!(with_drive_first("/home/notes.md"), "/home/notes.md");
        assert_eq!(with_drive_first("/D:notes.md"), "/D:notes.md");
        assert_eq!(with_drive_first("D:/notes.md"), "D:/notes.md");
    }

    #[test]
    fn reads_requests_as_nodes_schemas_do() {
        let link = |value: Value| link_request("thread-file-link", Some(&value));
        assert_eq!(link(json!({ "threadId": "t", "path": "README.md" })).map(|r| r.path), Some("README.md".into()));
        assert!(link(json!({ "threadId": "t", "path": "README.md", "want": "place" })).is_none());
        assert!(link(json!({ "threadId": "", "path": "README.md" })).is_none());
        assert!(link(json!({ "threadId": "t", "path": "" })).is_none());
        assert!(link(json!({ "threadId": "t", "path": "//host/share/notes.md" })).is_none());
        assert!(link(json!({ "threadId": "t", "path": "\\\\?\\C:\\notes.md" })).is_none());
        assert!(link(json!({ "threadId": "t", "path": "C:notes.md" })).is_none());
        assert!(link(json!({ "threadId": "t", "path": "notes\u{7}.md" })).is_none());
        assert!(link(json!({ "threadId": "t", "path": "C:/notes.md" })).is_some());

        assert!(link_request("thread-files", Some(&json!({ "threadId": "t", "path": "a" }))).is_none());
        assert_eq!(link(json!({ "threadId": "t", "path": "a" })).map(|r| r.read.feature()), Some("thread-file-links"));
        let linked = |value: Value| {
            link_request("thread-linked-file", Some(&value)).and_then(|r| match r.read {
                LinkRead::LinkedFile(want) => Some(want),
                LinkRead::MarkdownLink => None,
            })
        };
        assert_eq!(LinkRead::LinkedFile(LinkedWant::Place).feature(), "thread-linked-files");
        assert_eq!(linked(json!({ "threadId": "t", "path": "a", "want": "place" })), Some(LinkedWant::Place));
        assert_eq!(linked(json!({ "threadId": "t", "path": "a", "want": "preview" })), Some(LinkedWant::Preview));
        assert_eq!(
            linked(json!({ "threadId": "t", "path": "a", "want": "part", "offset": 4.0 })),
            Some(LinkedWant::Part { offset: 4, revision: None })
        );
        assert!(linked(json!({ "threadId": "t", "path": "a", "want": "place", "offset": 0 })).is_none());
        assert!(linked(json!({ "threadId": "t", "path": "a", "want": "part" })).is_none());
        assert!(linked(json!({ "threadId": "t", "path": "a", "want": "part", "offset": -1 })).is_none());
        assert!(linked(json!({ "threadId": "t", "path": "a", "want": "part", "offset": 1.5 })).is_none());
        assert!(linked(json!({ "threadId": "t", "path": "a", "want": "part", "offset": 0, "revision": "ABC" })).is_none());
        assert!(linked(json!({ "threadId": "t", "path": "a", "want": "open" })).is_none());
    }

    #[test]
    fn keeps_a_relative_link_inside_the_threads_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("thread");
        fs::create_dir(&root).unwrap();
        fs::write(dir.path().join("secret.md"), "# outside").unwrap();
        fs::write(root.join("notes.md"), "# inside").unwrap();
        let ws = workspace_at(&root);

        let outside = thread_file_link(Some(&ws), "../secret.md");
        assert_eq!(code(&outside), Some("path-outside-workspace"));
        assert_eq!(message(&outside), Some("This link points outside the thread\u{2019}s folder. Nothing was opened."));
        // `sub/..` is read by its words, as Node's `path.resolve` reads it.
        fs::create_dir(root.join("sub")).unwrap();
        assert_eq!(thread_file_link(Some(&ws), "sub/../notes.md").pointer("/value/text"), Some(&json!("# inside")));

        // Written absolute, a link may name a file anywhere on this machine.
        let absolute = fs::canonicalize(dir.path().join("secret.md")).unwrap();
        let answer = thread_file_link(Some(&ws), &absolute.to_string_lossy());
        assert_eq!(answer.pointer("/value/text"), Some(&json!("# outside")));
        assert_eq!(answer.pointer("/value/name"), Some(&json!("secret.md")));

        let place = thread_linked_file(Some(&ws), &absolute.to_string_lossy(), &LinkedWant::Place);
        assert_eq!(place.pointer("/value/inside"), Some(&Value::Null));
        let place = thread_linked_file(Some(&ws), "notes.md:3", &LinkedWant::Place);
        assert_eq!(place.pointer("/value/inside/path"), Some(&json!("notes.md")));
        assert_eq!(place.pointer("/value/inside/workspace/workspaceId"), Some(&json!(ws.workspace_id)));
        // The name is the link's own, as the path that found the file wrote it.
        assert_eq!(place.pointer("/value/name"), Some(&json!("notes.md")));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_relative_link_that_leads_out_through_a_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("thread");
        fs::create_dir(&root).unwrap();
        fs::write(dir.path().join("secret.md"), "# outside").unwrap();
        std::os::unix::fs::symlink(dir.path().join("secret.md"), root.join("notes.md")).unwrap();
        let answer = thread_file_link(Some(&workspace_at(&root)), "notes.md");
        assert_eq!(code(&answer), Some("path-outside-workspace"));
    }

    #[test]
    fn previews_only_markdown_within_512_kb() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        fs::write(root.join("notes.md"), "\u{feff}# Notes\n").unwrap();
        fs::write(root.join("notes.txt"), "plain").unwrap();
        fs::write(root.join("big.md"), "a".repeat(MAX_TEXT_PREVIEW_BYTES + 1)).unwrap();
        fs::write(root.join("edge.md"), "a".repeat(MAX_TEXT_PREVIEW_BYTES)).unwrap();
        fs::write(root.join("binary.md"), [0u8, 1, 2]).unwrap();
        fs::create_dir(root.join("folder.md")).unwrap();
        let ws = workspace_at(&root);

        let answer = thread_file_link(Some(&ws), "notes.md#heading");
        assert_eq!(answer, json!({ "ok": true, "value": { "name": "notes.md", "size": 11, "text": "# Notes\n" } }));
        assert_eq!(code(&thread_file_link(Some(&ws), "notes.txt")), Some("invalid-request"));
        let big = thread_file_link(Some(&ws), "big.md");
        assert_eq!(code(&big), Some("too-large"));
        assert_eq!(message(&big), Some("Markdown files open here up to 512 KB. Nothing was opened."));
        assert_eq!(thread_file_link(Some(&ws), "edge.md").pointer("/value/size"), Some(&json!(MAX_TEXT_PREVIEW_BYTES)));
        assert_eq!(code(&thread_file_link(Some(&ws), "binary.md")), Some("binary"));
        assert_eq!(code(&thread_file_link(Some(&ws), "folder.md")), Some("not-file"));
        let gone = thread_file_link(Some(&ws), "gone.md");
        assert_eq!(code(&gone), Some("path-unavailable"));
        assert_eq!(message(&gone), Some(NOT_HERE));
        assert_eq!(code(&thread_file_link(None, "notes.md")), Some("thread-unavailable"));
        let missing = workspace_at(&root.join("missing"));
        assert_eq!(code(&thread_file_link(Some(&missing), "notes.md")), Some("workspace-unavailable"));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_markdown_name_that_leads_to_another_kind_of_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        fs::write(root.join("key.pem"), "secret").unwrap();
        std::os::unix::fs::symlink(root.join("key.pem"), root.join("notes.md")).unwrap();
        assert_eq!(code(&thread_file_link(Some(&workspace_at(&root)), "notes.md")), Some("invalid-request"));
    }

    #[test]
    fn answers_place_preview_and_part() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        fs::create_dir(root.join("docs")).unwrap();
        fs::write(root.join("docs").join("guide.md"), "# Guide").unwrap();
        fs::write(root.join("data.bin"), [0u8; 10]).unwrap();
        let ws = workspace_at(&root);

        let place = thread_linked_file(Some(&ws), "docs/guide.md", &LinkedWant::Place);
        assert_eq!(
            place,
            json!({ "ok": true, "value": { "is": "place", "name": "guide.md", "kind": "file", "size": 7,
                "inside": { "workspace": ws, "path": "docs/guide.md" } } })
        );
        let folder = thread_linked_file(Some(&ws), "docs/", &LinkedWant::Place);
        assert_eq!(folder.pointer("/value/kind"), Some(&json!("directory")));
        assert_eq!(folder.pointer("/value/name"), Some(&json!("docs")));
        assert_eq!(folder.pointer("/value/size"), Some(&json!(0)));
        assert_eq!(code(&thread_linked_file(Some(&ws), "docs", &LinkedWant::Preview)), Some("not-file"));

        let preview = thread_linked_file(Some(&ws), "docs/guide.md", &LinkedWant::Preview);
        assert_eq!(
            preview,
            json!({ "ok": true, "value": { "is": "preview", "name": "guide.md", "size": 7, "content": { "kind": "markdown", "text": "# Guide" } } })
        );
        assert_eq!(code(&thread_linked_file(Some(&ws), "data.bin", &LinkedWant::Preview)), Some("binary"));

        let part = thread_linked_file(Some(&ws), "data.bin", &LinkedWant::Part { offset: 4, revision: None });
        assert_eq!(part.pointer("/value/is"), Some(&json!("part")));
        assert_eq!(part.pointer("/value/size"), Some(&json!(10)));
        assert_eq!(part.pointer("/value/offset"), Some(&json!(4)));
        assert_eq!(part.pointer("/value/data"), Some(&json!(STANDARD.encode([0u8; 6]))));
        let revision = part.pointer("/value/revision").and_then(Value::as_str).unwrap().to_string();
        assert_eq!(revision.len(), 64);
        // An unchanged file keeps its revision, and the end itself is an empty part.
        let end = thread_linked_file(Some(&ws), "data.bin", &LinkedWant::Part { offset: 10, revision: Some(revision.clone()) });
        assert_eq!(end.pointer("/value/data"), Some(&json!("")));
        assert_eq!(end.pointer("/value/revision"), Some(&json!(revision)));

        let past = thread_linked_file(Some(&ws), "data.bin", &LinkedWant::Part { offset: 11, revision: None });
        assert_eq!(code(&past), Some("invalid-request"));
        assert_eq!(message(&past), Some("This part is past the end of the file. Nothing was saved."));
    }

    #[test]
    fn refuses_a_part_of_a_file_that_changed() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        fs::write(root.join("data.bin"), [1u8; 10]).unwrap();
        let ws = workspace_at(&root);
        let first = thread_linked_file(Some(&ws), "data.bin", &LinkedWant::Part { offset: 0, revision: None });
        let revision = first.pointer("/value/revision").and_then(Value::as_str).unwrap().to_string();
        fs::write(root.join("data.bin"), [2u8; 12]).unwrap();
        let next = thread_linked_file(Some(&ws), "data.bin", &LinkedWant::Part { offset: 10, revision: Some(revision) });
        assert_eq!(code(&next), Some("path-unavailable"));
        assert_eq!(message(&next), Some(CHANGED_IN_DOWNLOAD));
        let wrong = thread_linked_file(Some(&ws), "data.bin", &LinkedWant::Part { offset: 0, revision: Some("0".repeat(64)) });
        assert_eq!(code(&wrong), Some("path-unavailable"));
    }

    #[test]
    fn refuses_a_preview_over_8_mib() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let file = fs::File::create(root.join("huge.md")).unwrap();
        file.set_len(MAX_IMAGE_PREVIEW_BYTES as u64 + 1).unwrap();
        let answer = thread_linked_file(Some(&workspace_at(&root)), "huge.md", &LinkedWant::Preview);
        assert_eq!(code(&answer), Some("too-large"));
        assert_eq!(message(&answer), Some("This file exceeds the 8 MiB preview limit."));
    }

    #[test]
    fn finds_a_windows_drive_path_and_a_home_path() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        fs::write(root.join("notes.md"), "# Notes").unwrap();
        let ws = workspace_at(&root);
        if cfg!(windows) {
            let plain = dir.path().join("notes.md").to_string_lossy().replace('\\', "/");
            let slashed = format!("/{plain}:4");
            assert_eq!(thread_file_link(Some(&ws), &slashed).pointer("/value/text"), Some(&json!("# Notes")));
        }
        // `~/` reads from the home folder, never from the thread's.
        let answer = thread_file_link(Some(&ws), "~/sotto-linked-files-test-missing.md");
        assert_eq!(code(&answer), Some("path-unavailable"));
    }

    #[test]
    fn resolves_paths_as_nodes_path_resolve_does() {
        if cfg!(windows) {
            let base = Path::new(r"C:\root");
            // A `D:` among a relative path's segments is a name, not a new drive.
            assert_eq!(resolve_from(base, "a/D:/x"), PathBuf::from(r"C:\root\a\D:\x"));
            assert_eq!(resolve_from(Path::new(r"\\?\C:\root"), "a/D:"), PathBuf::from(r"\\?\C:\root\a\D:"));
            assert_eq!(resolve_from(base, "a\\..\\b"), PathBuf::from(r"C:\root\b"));
            // A rooted path is on the base's drive, and one with its drive stands alone.
            assert_eq!(resolve_from(base, "/x/y"), PathBuf::from(r"C:\x\y"));
            assert_eq!(resolve_from(base, "D:/x"), PathBuf::from(r"D:\x"));
        } else {
            let base = Path::new("/root");
            assert_eq!(resolve_from(base, "a/D:/x"), PathBuf::from("/root/a/D:/x"));
            assert_eq!(resolve_from(base, "a/../b"), PathBuf::from("/root/b"));
            assert_eq!(resolve_from(base, "/x/y"), PathBuf::from("/x/y"));
            assert_eq!(resolve_from(base, "../../.."), PathBuf::from("/"));
        }
    }

    #[test]
    fn reads_a_home_path_from_the_home_folder_alone() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let home = root.join("home");
        fs::create_dir(&home).unwrap();
        fs::write(home.join("notes.md"), "# Home").unwrap();
        fs::write(root.join("notes.md"), "# Thread").unwrap();

        let found = locate_link(&root, Some(&home), "~/notes.md").unwrap();
        assert_eq!(found.absolute, fs::canonicalize(home.join("notes.md")).unwrap());
        assert!(!found.relative_to_thread);
        // With no home folder known, a `~/` path names nothing, never the process's own folder.
        assert!(locate_link(&root, None, "~/notes.md").is_none());
        assert!(locate_link(&root, None, "~").is_none());
        // `~//x` is the absolute `/x`, as Node's `resolve(homedir(), '/x')` reads it; on Windows on the home's drive.
        let plain = dir.path().join("notes.md").to_string_lossy().into_owned();
        let rooted = if cfg!(windows) { plain[2..].to_string() } else { plain };
        let found = locate_link(&root, Some(&home), &format!("~/{rooted}")).unwrap();
        assert_eq!(found.absolute, fs::canonicalize(root.join("notes.md")).unwrap());
    }

    #[test]
    fn a_files_revision_is_the_same_by_path_and_by_handle_and_notices_a_swap() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let first = root.join("data.bin");
        fs::write(&first, [7u8; 8]).unwrap();
        let by_path = Revision::of_path(&first).unwrap();
        assert_eq!(Revision::of_file(&fs::File::open(&first).unwrap()), Some(by_path));
        assert_eq!(Revision::of_path(&first).map(|again| again.hash()), Some(by_path.hash()));

        // Another file with the same size and times moved into its place is another revision.
        let second = root.join("swap.bin");
        fs::write(&second, [7u8; 8]).unwrap();
        let recorded = fs::metadata(&first).unwrap();
        let times = fs::FileTimes::new().set_modified(recorded.modified().unwrap());
        #[cfg(windows)]
        let times = {
            use std::os::windows::fs::FileTimesExt;
            times.set_created(recorded.created().unwrap())
        };
        fs::File::options().write(true).open(&second).unwrap().set_times(times).unwrap();
        fs::rename(&second, &first).unwrap();
        let swapped = Revision::of_path(&first).unwrap();
        assert_eq!((swapped.size, swapped.mtime), (by_path.size, by_path.mtime));
        if cfg!(windows) {
            assert_eq!(swapped.birth, by_path.birth);
        }
        assert_ne!((swapped.dev, swapped.ino), (by_path.dev, by_path.ino));
        assert_ne!(swapped.hash(), by_path.hash());
    }

    #[test]
    fn refuses_an_opened_file_outside_the_folder_for_a_relative_link() {
        let dir = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(dir.path()).unwrap();
        let root = base.join("thread");
        fs::create_dir(&root).unwrap();
        let outside = base.join("secret.md");
        fs::write(&outside, "# outside").unwrap();
        let located = |relative_to_thread| Located {
            absolute: outside.clone(),
            meta: fs::metadata(&outside).unwrap(),
            written: "notes.md".into(),
            relative_to_thread,
            revision: Revision::of_path(&outside),
        };
        // A link written relative to the thread whose file is found outside its folder once opened, as after a swap.
        let refused = open_unchanged(&root, &located(true), CHANGED).unwrap_err();
        assert_eq!(code(&refused), Some("path-unavailable"));
        assert_eq!(message(&refused), Some(CHANGED));
        assert!(open_unchanged(&root, &located(false), CHANGED).is_ok());
        // A file whose revision the system could not say is refused with the words it is given, never read.
        let unnamed = Located { revision: None, ..located(false) };
        assert_eq!(message(&open_unchanged(&root, &unnamed, CHANGED_IN_DOWNLOAD).unwrap_err()), Some(CHANGED_IN_DOWNLOAD));
    }
}
