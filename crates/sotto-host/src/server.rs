use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc, watch, Semaphore};

use sotto_core::attachment_files::AttachmentFileRequest;
use sotto_core::attachment_files::{SentAttachment, SentRead};
use sotto_core::attachment_previews::{PreviewRequest, Wanted};
use sotto_core::attachment_store::AttachmentError;
use sotto_core::file_uploads::{FilePart, FileUploads, PartTaken, Received, HOST_CANNOT_STAGE_VIDEOS};
use sotto_core::workspace::now_ms;
use sotto_core::linked_files::LinkRequest;
use sotto_core::pairing::constant_time_eq;
use sotto_core::answered_requests::{answer_decision_id, AnswerTarget};
use sotto_core::command_receipts::{ended_receipt, keeps_receipt, unknown_receipt, CommandReceipts, Receipt};
use sotto_core::pull_requests::{
    valid_pull_request_command_shape, ConfirmedPullRequestAction, GitPullRequestActionCommand,
    GitPullRequestListRequest, GitPullRequestRequest, PullRequestConfirmationRequest,
    PullRequestConfirmations,
};
use sotto_core::remote_commands::validate_remote_command;
use sotto_core::protocol_fields::protocol_id;
use sotto_core::workspace::sha256_hex;
use sotto_core::thread_media::MediaRequest;
use sotto_core::{
    parse_watcher_host_read, watcher_progress_change, watcher_record_digest, BoxFuture,
    ClientContext, CoordinatorBroadcast, CoordinatorHandle, DesktopClients, HostCredentials,
    HostDescriptor, HostErrorCode, HostRequestEnvelope, HostResponseEnvelope, MemoryStore,
    PairedClients, PairingError, PhoneAccessListener, PhoneAccessListenerSpawn, ProviderAdapter,
    SubagentStore, TailscaleBackend, WatcherHostProgress, WatcherHostProjection,
    WatcherHostService, WatcherIdentity, WatcherProgressEntry, HOST_PROTOCOL_VERSION,
};

use crate::phones::{phones_off_message, HostAdminPhonesCommand, HostPhoneAccess};
use crate::wire_codec::ClientWireState;
use crate::ws::{
    deflate_offered, is_valid_websocket_key, read_ws_message, websocket_accept, write_ws_close,
    write_ws_pong, write_ws_text, WsMessage, WsReaderState, DEFLATE_RESPONSE,
};

const MAX_HTTP_BODY_BYTES: usize = 256 * 1024;
const MAX_HTTP_HEADER_BYTES: usize = 16 * 1024;
const HTTP_READ_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_CONCURRENT_CONNECTIONS: usize = 64;
const ACCEPT_ERROR_BACKOFF: Duration = Duration::from_millis(50);
const REMOTE_ANSWER_GRANT_NOTE: &str =
    "The user allowed this paired device to answer permission requests on the host.";

pub const DEFAULT_SOTTO_VERSION: &str = match option_env!("SOTTO_HOST_VERSION") {
    Some(v) if !v.is_empty() => v,
    _ => env!("CARGO_PKG_VERSION"),
};

/// Protocol v1 features truthfully implemented by this host build.
/// Never advertise a feature whose protocol ops or wire semantics are stubbed or missing.
pub fn advertised_features() -> Vec<String> {
    vec![
        "client-liveness".into(),
        "message-aliases".into(),
        "detail-delta".into(),
        "attachment-staging".into(),
        "file-staging".into(),
        // With file staging, as Node lists them: videos up to 500 MiB staged in parts on disk (ADR-0131, November 9
        // amendment), and a sent file's bytes for the iPhone's Quick Look (October 25 amendment).
        "video-staging".into(),
        "attachment-files".into(),
        "activity-summaries".into(),
        "model-catalog-revision".into(),
        "changed-thread-records".into(),
        "reply-thread-records".into(),
        "command-changed-thread-records".into(),
        "kept-parts".into(),
        "draft-revisions".into(),
        // `refresh-thread-worktree` takes `background`, the window's own refresh, as Node offers it to every client.
        "background-refresh".into(),
        "detail-read-held".into(),
        "provider-opencode".into(),
        "provider-cursor".into(),
        "provider-hermes".into(),
        "provider-antigravity".into(),
        "git-refs".into(),
        "git-changed-files".into(),
        "git-pull-request".into(),
        "git-pull-request-list".into(),
        "pull-request-confirmation".into(),
        "pull-request-view".into(),
        "host-folders".into(),
        "thread-files".into(),
        "thread-file-links".into(),
        "thread-linked-files".into(),
        "thread-media".into(),
        "thread-media-video".into(),
        "thread-changes".into(),
        "thread-snooze".into(),
        "failure-seen".into(),
        "host-facts".into(),
        "project-origins".into(),
        "project-setup".into(),
        "project-git-init".into(),
        "thread-words".into(),
        "thread-prompts".into(),
        "activity-bodies".into(),
        "subagents".into(),
        "usage-dashboard".into(),
        "usage-history".into(),
        "usage-muse-opencode".into(),
        "usage-antigravity".into(),
        "usage-antigravity-no-limits".into(),
        "watcher-control".into(),
        "watcher-reads".into(),
        "watcher-progress".into(),
        "watcher-standing-watch".into(),
        "watcher-work-settled".into(),
        "watcher-outcomes".into(),
        "watcher-new-owner".into(),
        "watcher-check-queue".into(),
        "watcher-check-stop".into(),
        "watcher-muse".into(),
        "watcher-cursor".into(),
        "watcher-antigravity".into(),
        // A command's receipt, with whether its answer was taken, and a held answer's question checked again, as Node
        // offers them to every client.
        "answer-receipts".into(),
        "answer-check".into(),
        // Deleting a settled thread (ADR-0140), where Node's host offers it: its Owl answer `clear-threads` has gone to
        // stable, so it is on in every build, and both of this host's listeners serve desktops. It is not one of
        // `HOST_DESKTOP_FEATURES`, so every client on them is offered it, as Node offers it.
        "thread-delete".into(),
    ]
}


/// The sentence an answer too large to send is refused with, by what was asked, as Node's `TOO_LARGE`
/// (`src/host/socketServer.ts`).
fn too_large_words(op: &str) -> &'static str {
    match op {
        "detail" => HostErrorCode::TooLarge.default_message(),
        "activity-body" => "This activity is too large to send to this device. Nothing on the host was lost, and the row keeps the part it was sent.",
        "preview" | "thread-media" | "thread-media-part" | "plugin-meshy-model-bytes" | "plugin-elevenlabs-sound-bytes" | "attachment-content" | "attachment-file" => {
            "This attachment is too large to preview on this device. Nothing on the host was lost, and the attachment is unchanged there."
        }
        "thread-files" | "thread-file-preview" | "thread-file-link" | "thread-linked-file" | "thread-changes" | "thread-changes-review" | "subagent-page" | "subagent-assignments" => {
            "This file or comparison is too large to send to this device. Nothing on the host was lost or changed. Open it on the host machine."
        }
        _ => "The thread list on this host is too large to send to this device. Nothing on the host was lost, and this device keeps the last list it received.",
    }
}

/// A thread read's `threadId` and its one other ID field, `other`, as Node's strict schema takes them: both IDs, and no
/// other field.
fn thread_read_ids(fields: &serde_json::Map<String, Value>, other: &str) -> Option<(String, String)> {
    if fields.keys().any(|key| key != "threadId" && key != other) {
        return None;
    }
    Some((protocol_id(fields.get("threadId"))?, protocol_id(fields.get(other))?))
}

/// A read of one thread's files or media that Node's socket server checks before it reads anything: the thread it names,
/// the feature the host offers for it, if it has one, and whether it is refused even where that feature is offered.
trait ThreadRead {
    fn thread_id(&self) -> &str;
    /// The feature this read needs, or none for one every host answers, as `preview`.
    fn feature(&self) -> Option<&'static str>;
    /// Refused once offered: a picture at a longest edge. This host offers no picture edges, since it has no picture
    /// maker (ADR-0203), so no client of it accepted `thread-media-edge`, and Node refuses an edge from such a client.
    fn refused_when_offered(&self) -> bool {
        false
    }
}

impl ThreadRead for LinkRequest {
    fn thread_id(&self) -> &str {
        &self.thread_id
    }
    fn feature(&self) -> Option<&'static str> {
        Some(self.read.feature())
    }
}

impl ThreadRead for MediaRequest {
    fn thread_id(&self) -> &str {
        &self.thread_id
    }
    fn feature(&self) -> Option<&'static str> {
        Some(MediaRequest::feature(self))
    }
    fn refused_when_offered(&self) -> bool {
        self.edge
    }
}

impl ThreadRead for AttachmentFileRequest {
    fn thread_id(&self) -> &str {
        &self.thread_id
    }
    fn feature(&self) -> Option<&'static str> {
        Some(AttachmentFileRequest::feature(self))
    }
}

impl ThreadRead for PreviewRequest {
    fn thread_id(&self) -> &str {
        &self.thread_id
    }
    fn feature(&self) -> Option<&'static str> {
        None
    }
    fn refused_when_offered(&self) -> bool {
        self.edge
    }
}

/// A read of a sent attachment (`preview` or `attachment-file`) once its request is checked: the attachment the
/// message's preview entry names as `wanted`, null when it names none, then `read` on a blocking task from where the
/// store keeps its content, answering the picture or the part, or null. Content found gone or no longer its digest is
/// let go, as Node's read lets it go, and answers null; a failure to read content the store keeps is the host's.
async fn read_sent_attachment(
    state: &HostState,
    id: String,
    (thread_id, message_id, attachment_id): (String, String, String),
    wanted: Wanted,
    read: impl FnOnce(Option<&Path>, &SentAttachment) -> Result<SentRead, sotto_core::attachment_store::ReadFailed> + Send + 'static,
) -> HostResponseEnvelope {
    let found = match state.coordinator.sent_attachment(thread_id, message_id, attachment_id, wanted).await {
        Ok(found) => found,
        Err(err) => return HostResponseEnvelope::err(id, err.code, err.message),
    };
    let Some((attachment, path)) = found else {
        return HostResponseEnvelope::ok(id, Value::Null);
    };
    let digest = attachment.digest.clone();
    match tokio::task::spawn_blocking(move || read(path.as_deref(), &attachment)).await {
        Ok(Ok(SentRead::Answer(answer))) => HostResponseEnvelope::ok(id, answer),
        Ok(Ok(SentRead::Nothing)) => HostResponseEnvelope::ok(id, Value::Null),
        Ok(Ok(SentRead::Gone)) => {
            state.coordinator.forget_unreadable(digest);
            HostResponseEnvelope::ok(id, Value::Null)
        }
        _ => HostResponseEnvelope::err(id, HostErrorCode::Unavailable, HostErrorCode::Unavailable.default_message()),
    }
}

/// A `receipt` request as Node's strict schema reads it: the command ID it asks about and the answer it names, if any.
fn receipt_request(fields: &serde_json::Map<String, Value>) -> Option<(String, Option<AnswerTarget>)> {
    if fields.keys().any(|key| key != "commandId" && key != "answer") {
        return None;
    }
    let answer = match fields.get("answer") {
        None => None,
        Some(answer) => Some(AnswerTarget::parse(answer)?),
    };
    Some((protocol_id(fields.get("commandId"))?, answer))
}

/// A `check-answer` request after the checks Node's socket server makes before the coordinator's own, in its order: the
/// request's shape, then whether this client is offered `answer-check`, then whether it may answer.
fn checked_answer_check(fields: &serde_json::Map<String, Value>, offered: impl Fn(&str) -> bool, may_answer: bool) -> Result<AnswerTarget, HostErrorCode> {
    let target = fields.keys().all(|key| key == "answer").then(|| fields.get("answer").and_then(AnswerTarget::parse)).flatten();
    let target = target.ok_or(HostErrorCode::InvalidRequest)?;
    if !offered("answer-check") {
        return Err(HostErrorCode::InvalidRequest);
    }
    if !may_answer {
        return Err(HostErrorCode::Forbidden);
    }
    Ok(target)
}

/// The features this host offers a client on this listener, as Node's `offers` reads them.
fn offered_features(state: &HostState, mode: &ListenerMode, client_id: &str) -> Vec<String> {
    let recorded = state.desktops.lock().unwrap().has(client_id);
    features_for_client(&state.features, recorded, desktop_on_listener(mode, recorded))
}

/// A `stage-file-part` request after the checks Node's socket server makes before it takes the part, in its order: the
/// part's shape as Node's schema reads it, then whether the host offers this client `file-staging`, then a video larger
/// than a file from a client the host does not offer `video-staging`, which is told why.
fn checked_file_part(fields: &serde_json::Map<String, Value>, offered: impl Fn(&str) -> bool) -> Result<FilePart, (HostErrorCode, &'static str)> {
    let invalid = (HostErrorCode::InvalidRequest, HostErrorCode::InvalidRequest.default_message());
    let part = if fields.keys().any(|key| key != "part") { None } else { sotto_core::file_uploads::file_part(fields.get("part")) };
    let part = part.ok_or(invalid)?;
    if !offered("file-staging") {
        return Err(invalid);
    }
    if part.is_large_video() && !offered("video-staging") {
        return Err((HostErrorCode::InvalidRequest, HOST_CANNOT_STAGE_VIDEOS));
    }
    Ok(part)
}

/// A `file-upload-progress` request's upload after Node's checks, in its order: its shape, then `video-staging` offered.
fn checked_upload_progress(fields: &serde_json::Map<String, Value>, offered: impl Fn(&str) -> bool) -> Result<String, HostErrorCode> {
    let upload_id = sotto_core::file_uploads::progress_request(fields).ok_or(HostErrorCode::InvalidRequest)?;
    if !offered("video-staging") {
        return Err(HostErrorCode::InvalidRequest);
    }
    Ok(upload_id)
}

/// One paired client's read of a sent file's part, held while it runs so the client has one at a time across its
/// sockets, as Node's `fileReads`.
struct FileRead<'a> {
    state: &'a HostState,
    client_id: String,
}

impl<'a> FileRead<'a> {
    fn start(state: &'a HostState, client_id: &str) -> Option<Self> {
        state.file_reads.lock().unwrap().insert(client_id.to_string()).then(|| Self { state, client_id: client_id.to_string() })
    }
}

impl Drop for FileRead<'_> {
    fn drop(&mut self) {
        self.state.file_reads.lock().unwrap().remove(&self.client_id);
    }
}

/// One open socket of a paired client. When its client's last socket closes, the client's file upload goes, and a
/// video's stays for its own wait, as Node's `leave` (ADR-0131).
struct ClientSocket {
    state: Arc<HostState>,
    client_id: String,
}

impl ClientSocket {
    fn open(state: Arc<HostState>, client_id: &str) -> Self {
        *state.client_sockets.lock().unwrap().entry(client_id.to_string()).or_insert(0) += 1;
        Self { state, client_id: client_id.to_string() }
    }
}

impl Drop for ClientSocket {
    fn drop(&mut self) {
        let last = {
            let mut sockets = self.state.client_sockets.lock().unwrap();
            let count = sockets.get_mut(&self.client_id).map(|count| {
                *count = count.saturating_sub(1);
                *count
            });
            if count == Some(0) {
                sockets.remove(&self.client_id);
            }
            count == Some(0)
        };
        if !last {
            return;
        }
        let state = Arc::clone(&self.state);
        let client_id = std::mem::take(&mut self.client_id);
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let mut uploads = state.uploads.lock().await;
                // A socket the client opened again meanwhile keeps its upload.
                if !state.client_sockets.lock().unwrap().contains_key(&client_id) {
                    uploads.leave(&client_id);
                }
            });
        }
    }
}

/// A thread read's request (`thread-file-link`, `thread-linked-file`, `thread-media` or `thread-media-part`) after the
/// checks Node's socket server makes before it reads anything, in its order: the request's shape as Node's schema
/// reads it (`parse`), then a thread the client may not see (`hidden`), then whether the host offers this client the
/// read (`offered`, as Node's `offers`: offered, whether or not the client accepted it) and whether it is refused there.
async fn checked_thread_read<Request: ThreadRead, Hidden: std::future::Future<Output = bool>>(
    fields: &serde_json::Map<String, Value>,
    parse: impl FnOnce(Option<&Value>) -> Option<Request>,
    hidden: impl FnOnce(String) -> Hidden,
    offered: impl FnOnce(&str) -> bool,
) -> Result<Request, HostErrorCode> {
    let request = if fields.keys().any(|key| key != "request") { None } else { parse(fields.get("request")) };
    let request = request.ok_or(HostErrorCode::InvalidRequest)?;
    if hidden(request.thread_id().to_string()).await {
        return Err(HostErrorCode::Forbidden);
    }
    if request.feature().is_some_and(|feature| !offered(feature)) || request.refused_when_offered() {
        return Err(HostErrorCode::InvalidRequest);
    }
    Ok(request)
}

/// `checked_thread_read` for this client: what the host offers it on this listener, and the providers it knows.
async fn offered_thread_read<Request: ThreadRead>(
    state: &HostState,
    mode: &ListenerMode,
    client_id: &str,
    wire: &ClientWireState,
    fields: &serde_json::Map<String, Value>,
    parse: impl FnOnce(Option<&Value>) -> Option<Request>,
) -> Result<Request, HostErrorCode> {
    let offered = offered_features(state, mode, client_id);
    checked_thread_read(
        fields,
        parse,
        |thread_id| async move { hides_thread(state, wire, &thread_id).await },
        |feature| offered.iter().any(|name| name == feature),
    )
    .await
}

/// Whether a thread is of a provider this client does not know, so it is not this client's to read or act on.
async fn hides_thread(state: &HostState, wire: &ClientWireState, thread_id: &str) -> bool {
    matches!(state.coordinator.thread_provider(thread_id.to_string()).await, Ok(Some(provider)) if wire.hides_provider(&provider))
}

/// The features a tailnet listener offers only to a client the launch script recorded as a desktop, as Node's
/// `HOST_DESKTOP_FEATURES` (`src/shared/hostProtocol.ts`, ADR-0053). The loopback listener offers them to every client.
const HOST_DESKTOP_FEATURES: &[&str] = &[
    "detached-runs-elsewhere", "thread-file-links", "thread-linked-files", "provider-sign-in", "client-updates",
    "client-update-outcomes", "client-update-not-listed", "watcher-control", "watcher-reads", "watcher-standing-watch",
    "watcher-work-settled", "watcher-outcomes", "host-facts", "watcher-muse", "watcher-cursor", "watcher-antigravity",
    "host-update", "opencode-sign-in", "activity-bodies", "thread-prompts", "project-origins", "host-delegation",
    "delegation-views", "branch-moves", "delegation-relay", "check-queue-views", "project-setup", "delegation-relay-send",
    "delegation-remote", "delegation-branch-starts", "watcher-new-owner", "thread-move", "worker-swarms",
    "every-agent-picture", "thread-move-source", "thread-move-keep", "next-prompts", "watcher-tell", "watcher-ready",
    "browser", "plugin-account-copies", "plugin-github-sign-in", "plugin-mail-copies", "plugin-meshy-copies",
    "watcher-progress", "plugin-meshy-spending", "plugin-meshy-models", "plugin-elevenlabs-copies",
    "plugin-elevenlabs-spending", "plugin-elevenlabs-sounds", "detail-read-held", "thread-coordination-views",
    "thread-coordination-relay",
];

/// Whether this listener counts a client as a desktop, as Node's socket server does: every client on the loopback
/// listener, and on a tailnet listener only one the launch script recorded.
fn desktop_on_listener(mode: &ListenerMode, recorded: bool) -> bool {
    matches!(mode, ListenerMode::Admin) || recorded
}

/// The threads an `observe-threads` command names, as Node's schema reads them: at most 100 thread IDs and nothing else.
fn observed_thread_ids(command: &serde_json::Map<String, Value>) -> Option<Vec<String>> {
    if command.keys().any(|key| key != "type" && key != "threadIds") {
        return None;
    }
    let items = command.get("threadIds")?.as_array()?;
    if items.len() > 100 {
        return None;
    }
    items
        .iter()
        .map(|item| protocol_id(Some(item)))
        .collect()
}

/// Filters host-advertised features per authenticated client: `HOST_DESKTOP_FEATURES` (including
/// `project-origins` and `project-setup`) require `desktop_on_listener` (every client on the loopback
/// listener, and recorded desktops on a tailnet listener), while `watcher-*` (non-phone) are offered
/// ONLY to authenticated paired desktops recorded in `desktop-clients.json` (ADR-0053, ADR-0073, ADR-0082).
fn features_for_client(features: &[String], is_desktop: bool, desktop_on_listener: bool) -> Vec<String> {
    let features: Vec<String> = features
        .iter()
        .filter(|feat| desktop_on_listener || !HOST_DESKTOP_FEATURES.contains(&feat.as_str()))
        .cloned()
        .collect();
    if is_desktop {
        return features;
    }
    features
        .iter()
        .filter(|feat| {
            let s = feat.as_str();
            let is_desktop_watcher = s.starts_with("watcher-") && !s.starts_with("watcher-phone");
            !is_desktop_watcher
        })
        .cloned()
        .collect()
}

pub struct HostState {
    pub data_directory: PathBuf,
    pub host_id: String,
    pub port: u16,
    pub sotto_version: String,
    pub features: Vec<String>,
    pub admin_token: String,
    pub started_by: Option<String>,
    pub pairing: Arc<Mutex<PairedClients>>,
    pub desktops: Arc<Mutex<DesktopClients>>,
    pub memory: Mutex<MemoryStore>,
    pub subagents: Mutex<SubagentStore>,
    pub credentials: Mutex<HostCredentials>,
    pub coordinator: CoordinatorHandle,
    pub phones: Arc<HostPhoneAccess>,
    pub watcher: Arc<WatcherHostService>,
    pub revoked_tx: broadcast::Sender<String>,
    pub capabilities_tx: broadcast::Sender<String>,
    /// Each paired client's file on its way here, by its client ID, however many sockets it opens (ADR-0131).
    pub uploads: Arc<tokio::sync::Mutex<FileUploads>>,
    /// The paired clients with a sent file's part being read for them, so each has one such read at a time.
    pub file_reads: Mutex<HashSet<String>>,
    /// How many sockets each paired client has open here, so its file upload goes when the last one closes.
    pub client_sockets: Mutex<HashMap<String, usize>>,
    /// Each paired client's commands by its request ID, shared by both listeners, as Node's `CommandReceipts`.
    pub receipts: Arc<Mutex<CommandReceipts>>,
    /// Paired-client pull request confirmation receipts and reading IDs, shared by both listeners (#1691).
    pub pull_request_confirmations: Arc<Mutex<PullRequestConfirmations>>,
    /// Single-flight project copy setups (`project-setup`, #1690), shared by both listeners.
    pub project_copies: sotto_core::project_setup::ProjectCopies,
}

impl HostState {
    pub fn descriptor(&self) -> HostDescriptor {
        self.descriptor_for_port(self.port)
    }

    pub fn descriptor_for_port(&self, port: u16) -> HostDescriptor {
        HostDescriptor {
            v: HOST_PROTOCOL_VERSION,
            host_id: self.host_id.clone(),
            port,
            pid: std::process::id(),
            sotto_version: self.sotto_version.clone(),
            features: self.features.clone(),
            admin_token: Some(self.admin_token.clone()),
            started_by: self.started_by.clone(),
            tailnet_address: self.phones.address(),
        }
    }
}

pub struct TailnetListenerControl {
    serving: AtomicBool,
    allow_phones: AtomicBool,
    computer_name: Mutex<String>,
    connected: Arc<Mutex<HashMap<String, usize>>>,
    drop_tx: broadcast::Sender<()>,
    on_paired: Arc<dyn Fn(String) + Send + Sync>,
    on_peers_changed: Arc<dyn Fn() + Send + Sync>,
}

impl TailnetListenerControl {
    fn computer_name(&self) -> String {
        self.computer_name
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default()
    }
}

#[derive(Clone)]
pub enum ListenerMode {
    Admin,
    Tailnet(Arc<TailnetListenerControl>),
}

struct ConnectedPeerGuard {
    ctrl: Arc<TailnetListenerControl>,
    client_id: String,
}

impl ConnectedPeerGuard {
    fn new(ctrl: Arc<TailnetListenerControl>, client_id: String) -> Self {
        if let Ok(mut map) = ctrl.connected.lock() {
            *map.entry(client_id.clone()).or_insert(0) += 1;
        }
        (ctrl.on_peers_changed)();
        Self { ctrl, client_id }
    }
}

impl Drop for ConnectedPeerGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = self.ctrl.connected.lock() {
            if let Some(count) = map.get_mut(&self.client_id) {
                if *count <= 1 {
                    map.remove(&self.client_id);
                } else {
                    *count -= 1;
                }
            }
        }
        (self.ctrl.on_peers_changed)();
    }
}

struct HostTailnetListener {
    port: u16,
    ctrl: Arc<TailnetListenerControl>,
    shutdown_tx: watch::Sender<bool>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl PhoneAccessListener for HostTailnetListener {
    fn port(&self) -> u16 {
        self.port
    }

    fn set_computer_name(&self, name: String) {
        if let Ok(mut g) = self.ctrl.computer_name.lock() {
            *g = name;
        }
    }

    fn set_allow_pairing(&self, allow: bool) {
        self.ctrl.allow_phones.store(allow, Ordering::SeqCst);
    }

    fn stop_serving(&self) {
        self.ctrl.serving.store(false, Ordering::SeqCst);
        let _ = self.ctrl.drop_tx.send(());
    }

    fn is_serving(&self) -> bool {
        self.ctrl.serving.load(Ordering::SeqCst)
    }

    fn connected_clients(&self) -> Vec<String> {
        self.ctrl
            .connected
            .lock()
            .map(|map| {
                map.iter()
                    .filter(|&(_, &v)| v > 0)
                    .map(|(k, _)| k.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn drop_revoked(&self) {
        let _ = self.ctrl.drop_tx.send(());
    }

    fn close(&mut self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.stop_serving();
            let _ = self.shutdown_tx.send(true);
            if let Some(task) = self.task.take() {
                let _ = task.await;
            }
        })
    }
}

impl Drop for HostTailnetListener {
    fn drop(&mut self) {
        self.stop_serving();
        let _ = self.shutdown_tx.send(true);
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

/// Starts the full protocol v1 HTTP+WebSocket tailnet loopback listener (`admin: false`, ADR-0053)
/// that Tailscale Serve proxies `:8443` / `:10000` to.
pub async fn start_tailnet_listener(
    spawn_cfg: PhoneAccessListenerSpawn,
    state: Arc<HostState>,
    connected: Arc<Mutex<HashMap<String, usize>>>,
    mut host_shutdown_rx: watch::Receiver<bool>,
) -> std::io::Result<Box<dyn PhoneAccessListener>> {
    let listener = match spawn_cfg.preferred_port {
        Some(p) if p > 0 => match TcpListener::bind(("127.0.0.1", p)).await {
            Ok(l) => l,
            Err(_) => TcpListener::bind(("127.0.0.1", 0)).await?,
        },
        _ => TcpListener::bind(("127.0.0.1", 0)).await?,
    };
    let bound_port = listener.local_addr()?.port();
    let (drop_tx, _) = broadcast::channel(32);
    let ctrl = Arc::new(TailnetListenerControl {
        serving: AtomicBool::new(true),
        allow_phones: AtomicBool::new(spawn_cfg.allow_pairing),
        computer_name: Mutex::new(spawn_cfg.computer_name),
        connected,
        drop_tx,
        on_paired: spawn_cfg.on_paired,
        on_peers_changed: spawn_cfg.on_peers_changed,
    });
    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    let task_ctrl = Arc::clone(&ctrl);
    let conn_limit = Arc::new(Semaphore::new(MAX_CONCURRENT_CONNECTIONS));
    let task = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() {
                        break;
                    }
                }
                _ = host_shutdown_rx.changed() => {
                    if *host_shutdown_rx.borrow() {
                        break;
                    }
                }
                accepted = listener.accept() => {
                    match accepted {
                        Ok((stream, _addr)) => {
                            if !task_ctrl.serving.load(Ordering::SeqCst) {
                                drop(stream);
                                continue;
                            }
                            let Ok(permit) = Arc::clone(&conn_limit).try_acquire_owned() else {
                                drop(stream);
                                continue;
                            };
                            let peer_state = Arc::clone(&state);
                            let peer_mode = ListenerMode::Tailnet(Arc::clone(&task_ctrl));
                            let peer_shutdown = shutdown_rx.clone();
                            tokio::spawn(async move {
                                let _permit = permit;
                                let _ = handle_connection(
                                    stream,
                                    bound_port,
                                    peer_state,
                                    peer_mode,
                                    peer_shutdown,
                                )
                                .await;
                            });
                        }
                        Err(_) => {
                            tokio::time::sleep(ACCEPT_ERROR_BACKOFF).await;
                        }
                    }
                }
            }
        }
    });

    Ok(Box::new(HostTailnetListener {
        port: bound_port,
        ctrl,
        shutdown_tx,
        task: Some(task),
    }))
}

pub fn generate_admin_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn write_descriptor(directory: &Path, descriptor: &HostDescriptor) -> std::io::Result<PathBuf> {
    let path = directory.join("host-listener.json");
    let temp = directory.join(format!("host-listener.json.tmp-{}", uuid::Uuid::new_v4()));
    let body = serde_json::to_string_pretty(descriptor).map_err(std::io::Error::other)?;
    let write_res = (|| -> std::io::Result<()> {
        let mut opts = OpenOptions::new();
        opts.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&temp)?;
        file.write_all(body.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, &path)
    })();
    if write_res.is_err() {
        let _ = fs::remove_file(&temp);
    }
    write_res?;
    Ok(path)
}

pub fn cleanup_descriptor(directory: &Path, admin_token: &str) {
    let path = directory.join("host-listener.json");
    if let Ok(text) = fs::read_to_string(&path) {
        if let Ok(parsed) = serde_json::from_str::<Value>(&text) {
            if parsed.get("adminToken").and_then(Value::as_str) == Some(admin_token) {
                let _ = fs::remove_file(&path);
            }
        }
    }
}

pub struct ServerConfig {
    pub data_directory: PathBuf,
    pub host_id: String,
    pub port: u16,
    pub sotto_version: String,
    pub started_by: Option<String>,
    pub credentials: HostCredentials,
    pub providers: BTreeMap<String, Arc<dyn ProviderAdapter>>,
    pub tailscale: Option<Arc<dyn TailscaleBackend>>,
    pub phone_retry_interval: Option<Duration>,
}

pub struct RunningServer {
    pub state: Arc<HostState>,
    descriptor_stop_tx: watch::Sender<bool>,
    descriptor_task: tokio::task::JoinHandle<()>,
    shutdown_tx: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

impl RunningServer {
    pub async fn start(config: ServerConfig) -> std::io::Result<Self> {
        let pairing = Arc::new(Mutex::new(
            PairedClients::load(&config.data_directory)
                .map_err(|err| std::io::Error::other(err.to_string()))?,
        ));
        let mut desktops_inner = DesktopClients::new(&config.data_directory);
        desktops_inner.refresh();
        let desktops = Arc::new(Mutex::new(desktops_inner));
        let memory = MemoryStore::open(&config.data_directory.join("memory.sqlite"))
            .map_err(|err| std::io::Error::other(err.to_string()))?;
        let subagents = SubagentStore::open(&config.data_directory.join("subagents.sqlite"))
            .map_err(|err| std::io::Error::other(err.to_string()))?;
        let credentials_secure = config.credentials.is_secure();
        let coordinator = CoordinatorHandle::spawn(
            config.data_directory.clone(),
            config.host_id.clone(),
            credentials_secure,
            config.providers,
        )
        .map_err(std::io::Error::other)?;
        let watcher = Arc::new(
            WatcherHostService::open(
                config.data_directory.clone(),
                config.host_id.clone(),
                coordinator.clone(),
            )
            .map_err(std::io::Error::other)?
            .with_desktops(Arc::clone(&desktops)),
        );
        if let Ok(initial_shell) = coordinator.shell(false).await {
            let _ = watcher.observe_shell(&initial_shell);
        }
        // A thread Watcher watches is kept back from deleting (ADR-0140 decision 3), as Node's coordinator asks its
        // Watcher hooks. The coordinator holds the service weakly, so neither keeps the other alive.
        let watching = Arc::downgrade(&watcher);
        coordinator.set_watched_threads(Arc::new(move || watching.upgrade().map(|watcher| watcher.watched_local_thread_ids()).unwrap_or_default()));

        let listener = TcpListener::bind(("127.0.0.1", config.port)).await?;
        let bound_port = listener.local_addr()?.port();
        let admin_token = generate_admin_token();
        let (revoked_tx, _) = broadcast::channel(64);
        let (capabilities_tx, _) = broadcast::channel(64);
        let phones = HostPhoneAccess::new(
            config.data_directory.clone(),
            config.host_id.clone(),
            Arc::clone(&pairing),
            Arc::clone(&desktops),
            coordinator.clone(),
            revoked_tx.clone(),
            config.tailscale,
            config.phone_retry_interval,
        );

        let state = Arc::new(HostState {
            data_directory: config.data_directory.clone(),
            host_id: config.host_id,
            port: bound_port,
            sotto_version: config.sotto_version,
            features: advertised_features(),
            admin_token,
            started_by: config.started_by,
            pairing,
            desktops,
            memory: Mutex::new(memory),
            subagents: Mutex::new(subagents),
            credentials: Mutex::new(config.credentials),
            coordinator,
            phones: Arc::clone(&phones),
            watcher,
            revoked_tx,
            capabilities_tx,
            // A video's parts go to the attachment store's own `uploads` folder, as Node's host writes them.
            uploads: Arc::new(tokio::sync::Mutex::new(FileUploads::new(Some(
                sotto_core::attachment_store::upload_folder(&config.data_directory),
            )))),
            file_reads: Mutex::new(HashSet::new()),
            client_sockets: Mutex::new(HashMap::new()),
            receipts: Arc::new(Mutex::new(CommandReceipts::default())),
            pull_request_confirmations: Arc::new(Mutex::new(PullRequestConfirmations::new())),
            project_copies: sotto_core::project_setup::ProjectCopies::new(),
        });

        let initial_descriptor = state.descriptor();
        let mut last_recorded_address = initial_descriptor.tailnet_address.clone();
        write_descriptor(&config.data_directory, &initial_descriptor)?;

        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let (descriptor_stop_tx, mut descriptor_stop_rx) = watch::channel(false);
        let mut phones_rx = state.phones.subscribe();
        let desc_state = Arc::clone(&state);
        let descriptor_task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = descriptor_stop_rx.changed() => {
                        if *descriptor_stop_rx.borrow() {
                            break;
                        }
                    }
                    changed = phones_rx.changed() => {
                        if changed.is_err() || *descriptor_stop_rx.borrow() {
                            break;
                        }
                        let next_addr = desc_state.phones.address();
                        if next_addr != last_recorded_address {
                            let descriptor = desc_state.descriptor();
                            if write_descriptor(&desc_state.data_directory, &descriptor).is_ok() {
                                last_recorded_address = descriptor.tailnet_address;
                            }
                        }
                    }
                }
            }
        });

        // Start Tailscale Serve / phone access alongside the main listener so slow Tailscale
        // checks never hold up startup readiness (matching `src/host/index.ts:432-464`).
        state
            .phones
            .start_background(Arc::downgrade(&state), shutdown_rx.clone());

        // Background observer feeding coordinator shell broadcasts into WatcherHostService so
        // outcomes, standing watches, native takeovers, evidence, and queued checks stay live.
        {
            let observer_watcher = Arc::clone(&state.watcher);
            let observer_coord = state.coordinator.clone();
            let mut observer_rx = observer_coord.subscribe();
            let mut observer_shutdown = shutdown_rx.clone();
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        _ = observer_shutdown.changed() => {
                            if *observer_shutdown.borrow() {
                                break;
                            }
                        }
                        bcast = observer_rx.recv() => {
                            match bcast {
                                Ok(CoordinatorBroadcast::Shell(shell)) => {
                                    let to_launch = observer_watcher.observe_shell(&shell);
                                    for (op_id, payload) in to_launch {
                                        let w = Arc::clone(&observer_watcher);
                                        tokio::spawn(async move {
                                            w.launch_queued_check(op_id, payload).await;
                                        });
                                    }
                                }
                                Ok(CoordinatorBroadcast::Detail(_)) => {}
                                Err(broadcast::error::RecvError::Lagged(_)) => {
                                    if let Ok(shell) = observer_coord.shell(false).await {
                                        let to_launch = observer_watcher.observe_shell(&shell);
                                        for (op_id, payload) in to_launch {
                                            let w = Arc::clone(&observer_watcher);
                                            tokio::spawn(async move {
                                                w.launch_queued_check(op_id, payload).await;
                                            });
                                        }
                                    }
                                }
                                Err(broadcast::error::RecvError::Closed) => break,
                            }
                        }
                    }
                }
            });
        }
        let server_state = Arc::clone(&state);
        let conn_limit = Arc::new(Semaphore::new(MAX_CONCURRENT_CONNECTIONS));
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = shutdown_rx.changed() => {
                        if *shutdown_rx.borrow() {
                            break;
                        }
                    }
                    accepted = listener.accept() => {
                        match accepted {
                            Ok((stream, _addr)) => {
                                let Ok(permit) = Arc::clone(&conn_limit).try_acquire_owned() else {
                                    drop(stream);
                                    continue;
                                };
                                let peer_state = Arc::clone(&server_state);
                                let peer_shutdown = shutdown_rx.clone();
                                tokio::spawn(async move {
                                    let _permit = permit;
                                    let _ = handle_connection(
                                        stream,
                                        bound_port,
                                        peer_state,
                                        ListenerMode::Admin,
                                        peer_shutdown,
                                    )
                                    .await;
                                });
                            }
                            Err(_) => {
                                tokio::time::sleep(ACCEPT_ERROR_BACKOFF).await;
                            }
                        }
                    }
                }
            }
        });

        Ok(Self {
            state,
            descriptor_stop_tx,
            descriptor_task,
            shutdown_tx,
            task,
        })
    }

    pub async fn close(self) {
        // Close phone access first so Tailscale Serve removes its mapping before the host stops
        // and no descriptor rewrite races with `cleanup_descriptor` (matching `src/host/index.ts:488-503`).
        self.state.phones.close().await;
        let _ = self.descriptor_stop_tx.send(true);
        let _ = self.descriptor_task.await;
        let _ = self.shutdown_tx.send(true);
        let _ = self.task.await;
        self.state.coordinator.shutdown().await;
        cleanup_descriptor(&self.state.data_directory, &self.state.admin_token);
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PairBody {
    v: u8,
    code: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClientIdBody {
    #[serde(rename = "clientId")]
    client_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyBody {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PhonesCommandBody {
    command: HostAdminPhonesCommand,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TailnetBody {
    #[serde(default)]
    enabled: Option<bool>,
}

enum HeaderReadError {
    TooLarge,
    Io(std::io::Error),
}

async fn read_bounded_line<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    remaining: &mut usize,
) -> Result<Option<String>, HeaderReadError> {
    let mut line = Vec::new();
    loop {
        let buf = reader.fill_buf().await.map_err(HeaderReadError::Io)?;
        if buf.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Ok(Some(String::from_utf8_lossy(&line).into_owned()))
            };
        }
        if let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let take = pos + 1;
            if take > *remaining {
                return Err(HeaderReadError::TooLarge);
            }
            line.extend_from_slice(&buf[..take]);
            reader.consume(take);
            *remaining -= take;
            return Ok(Some(String::from_utf8_lossy(&line).into_owned()));
        }
        let len = buf.len();
        if len > *remaining {
            return Err(HeaderReadError::TooLarge);
        }
        line.extend_from_slice(buf);
        reader.consume(len);
        *remaining -= len;
    }
}

async fn handle_connection(
    stream: TcpStream,
    listener_port: u16,
    state: Arc<HostState>,
    mode: ListenerMode,
    shutdown: watch::Receiver<bool>,
) -> std::io::Result<()> {
    if let ListenerMode::Tailnet(ref ctrl) = mode {
        if !ctrl.serving.load(Ordering::SeqCst) {
            return Ok(());
        }
    }
    let _ = stream.set_nodelay(true);
    let mut reader = BufReader::new(stream);
    let mut remaining_header_bytes = MAX_HTTP_HEADER_BYTES;

    let read_head = tokio::time::timeout(HTTP_READ_TIMEOUT, async {
        let Some(request_line) =
            read_bounded_line(&mut reader, &mut remaining_header_bytes).await?
        else {
            return Ok::<_, HeaderReadError>(None);
        };
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or("").to_string();
        let path = parts.next().unwrap_or("").to_string();

        let mut headers: HashMap<String, String> = HashMap::new();
        loop {
            let Some(line) = read_bounded_line(&mut reader, &mut remaining_header_bytes).await?
            else {
                break;
            };
            if line == "\r\n" || line == "\n" {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
            }
            if headers.len() > 64 {
                return Err(HeaderReadError::TooLarge);
            }
        }
        Ok(Some((method, path, headers)))
    })
    .await;

    let (method, path, headers) = match read_head {
        Ok(Ok(Some(head))) => head,
        Ok(Ok(None)) | Err(_) => return Ok(()),
        Ok(Err(HeaderReadError::TooLarge)) => {
            let mut stream = reader.into_inner();
            let _ = send_http_error(&mut stream, HostErrorCode::TooLarge, None).await;
            return Ok(());
        }
        Ok(Err(HeaderReadError::Io(err))) => return Err(err),
    };

    if !is_allowed_origin(headers.get("origin").map(String::as_str)) {
        let mut stream = reader.into_inner();
        send_http_error(&mut stream, HostErrorCode::Forbidden, None).await?;
        return Ok(());
    }

    if method == "GET"
        && path == "/v1/socket"
        && headers
            .get("upgrade")
            .map(|v| v.eq_ignore_ascii_case("websocket"))
            .unwrap_or(false)
    {
        return handle_websocket_upgrade(reader.into_inner(), &headers, state, mode, shutdown)
            .await;
    }

    let content_length = headers
        .get("content-length")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > MAX_HTTP_BODY_BYTES {
        let mut stream = reader.into_inner();
        send_http_error(&mut stream, HostErrorCode::TooLarge, None).await?;
        return Ok(());
    }
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        match tokio::time::timeout(HTTP_READ_TIMEOUT, reader.read_exact(&mut body)).await {
            Ok(Ok(_)) => {}
            Ok(Err(err)) => return Err(err),
            Err(_) => return Ok(()),
        }
    }

    let mut stream = reader.into_inner();
    let bearer = extract_bearer(&headers);

    if method == "GET" && path == "/v1/health" {
        let mut payload = state.descriptor_for_port(listener_port).public_health();
        if let ListenerMode::Tailnet(ref ctrl) = mode {
            let name = ctrl.computer_name();
            let trimmed = name.trim();
            if !trimmed.is_empty() {
                if let Some(obj) = payload.as_object_mut() {
                    obj.insert("name".into(), Value::String(trimmed.to_string()));
                }
            }
        }
        send_http_json(&mut stream, 200, &payload).await?;
        return Ok(());
    }

    if method != "POST" {
        send_http_error(&mut stream, HostErrorCode::InvalidRequest, None).await?;
        return Ok(());
    }

    if path.starts_with("/v1/admin/") {
        if matches!(mode, ListenerMode::Tailnet(_)) {
            send_http_error(&mut stream, HostErrorCode::InvalidRequest, None).await?;
            return Ok(());
        }
        if !constant_time_eq(bearer.as_bytes(), state.admin_token.as_bytes()) {
            send_http_error(&mut stream, HostErrorCode::Unauthenticated, None).await?;
            return Ok(());
        }
        if path == "/v1/admin/pairing-code" {
            let issued = state.pairing.lock().unwrap().issue_pairing_code();
            let payload = json!({
                "v": HOST_PROTOCOL_VERSION,
                "hostId": state.host_id,
                "code": issued.code,
                "expiresAt": issued.expires_at,
            });
            send_http_json(&mut stream, 200, &payload).await?;
            return Ok(());
        }
        if path == "/v1/admin/phones" {
            let parsed = if body.is_empty() {
                Ok(EmptyBody {})
            } else {
                serde_json::from_slice::<EmptyBody>(&body)
            };
            if parsed.is_err() {
                send_http_error(&mut stream, HostErrorCode::InvalidRequest, None).await?;
                return Ok(());
            }
            let phones_state = state.phones.get_state();
            send_http_json(
                &mut stream,
                200,
                &json!({
                    "v": HOST_PROTOCOL_VERSION,
                    "hostId": state.host_id,
                    "state": phones_state,
                }),
            )
            .await?;
            return Ok(());
        }
        if path == "/v1/admin/phones-command" {
            let parsed: PhonesCommandBody = match serde_json::from_slice::<PhonesCommandBody>(&body) {
                Ok(v) if v.command.validate() => v,
                _ => {
                    send_http_error(&mut stream, HostErrorCode::InvalidRequest, None).await?;
                    return Ok(());
                }
            };
            let answer = state.phones.command(parsed.command).await;
            let mut payload = json!({
                "v": HOST_PROTOCOL_VERSION,
                "hostId": state.host_id,
                "state": answer.state,
            });
            if let Some(obj) = payload.as_object_mut() {
                if let Some(url) = answer.url {
                    obj.insert("url".into(), Value::String(url));
                }
                if let Some(error) = answer.error {
                    obj.insert("error".into(), Value::String(error));
                }
            }
            send_http_json(&mut stream, 200, &payload).await?;
            return Ok(());
        }
        if path == "/v1/admin/tailnet" {
            let parsed: TailnetBody = if body.is_empty() {
                TailnetBody { enabled: None }
            } else {
                match serde_json::from_slice(&body) {
                    Ok(v) => v,
                    Err(_) => {
                        send_http_error(&mut stream, HostErrorCode::InvalidRequest, None).await?;
                        return Ok(());
                    }
                }
            };
            let answer = state.phones.tailnet(parsed.enabled).await;
            let mut payload = json!({
                "v": HOST_PROTOCOL_VERSION,
                "hostId": state.host_id,
                "enabled": answer.enabled,
                "state": answer.state,
            });
            if let Some(obj) = payload.as_object_mut() {
                if let Some(error) = answer.error {
                    obj.insert("error".into(), Value::String(error));
                }
            }
            send_http_json(&mut stream, 200, &payload).await?;
            return Ok(());
        }
        if path == "/v1/admin/revoke-client" {
            let parsed: ClientIdBody = match serde_json::from_slice(&body) {
                Ok(v) => v,
                Err(_) => {
                    send_http_error(&mut stream, HostErrorCode::InvalidRequest, None).await?;
                    return Ok(());
                }
            };
            let revoke_result = state.pairing.lock().unwrap().revoke(&parsed.client_id);
            match revoke_result {
                Ok(revoked) => {
                    state.phones.handle_client_revoked(parsed.client_id);
                    send_http_json(
                        &mut stream,
                        200,
                        &json!({ "v": HOST_PROTOCOL_VERSION, "hostId": state.host_id, "revoked": revoked }),
                    )
                    .await?;
                }
                Err(_) => {
                    send_http_error(&mut stream, HostErrorCode::Unavailable, None).await?;
                }
            }
            return Ok(());
        }
        if path == "/v1/admin/allow-answers" || path == "/v1/admin/deny-answers" {
            let parsed: ClientIdBody = match serde_json::from_slice(&body) {
                Ok(v) => v,
                Err(_) => {
                    send_http_error(&mut stream, HostErrorCode::InvalidRequest, None).await?;
                    return Ok(());
                }
            };
            let is_paired = state.pairing.lock().unwrap().is_paired(&parsed.client_id);
            if !is_paired {
                send_http_error(&mut stream, HostErrorCode::InvalidRequest, None).await?;
                return Ok(());
            }
            let allowed = path.ends_with("/allow-answers");
            if !allowed && state.phones.is_phone(&parsed.client_id) {
                send_http_error(
                    &mut stream,
                    HostErrorCode::InvalidRequest,
                    Some("Remove a phone to stop it answering."),
                )
                .await?;
                return Ok(());
            }
            let write_res = state.memory.lock().unwrap().set_remote_answers(
                &parsed.client_id,
                allowed,
                REMOTE_ANSWER_GRANT_NOTE,
            );
            match write_res {
                Ok(()) => {
                    let _ = state.capabilities_tx.send(parsed.client_id);
                    send_http_json(
                        &mut stream,
                        200,
                        &json!({ "v": HOST_PROTOCOL_VERSION, "hostId": state.host_id, "ok": true }),
                    )
                    .await?;
                }
                Err(_) => {
                    send_http_error(&mut stream, HostErrorCode::Unavailable, None).await?;
                }
            }
            return Ok(());
        }
        send_http_error(&mut stream, HostErrorCode::InvalidRequest, None).await?;
        return Ok(());
    }

    if path == "/v1/pair" {
        if let ListenerMode::Tailnet(ref ctrl) = mode {
            if !ctrl.allow_phones.load(Ordering::SeqCst) {
                let msg = phones_off_message(Some(&ctrl.computer_name()));
                send_http_error(&mut stream, HostErrorCode::Forbidden, Some(&msg)).await?;
                return Ok(());
            }
        }
        let parsed: PairBody = match serde_json::from_slice::<PairBody>(&body) {
            Ok(v) if v.v == HOST_PROTOCOL_VERSION => v,
            _ => {
                send_http_error(&mut stream, HostErrorCode::InvalidRequest, None).await?;
                return Ok(());
            }
        };
        let result = state
            .pairing
            .lock()
            .unwrap()
            .redeem_pairing_code(&parsed.code, &parsed.name);
        match result {
            Ok(paired) => {
                if let ListenerMode::Tailnet(ref ctrl) = mode {
                    (ctrl.on_paired)(paired.client_id.clone());
                }
                send_http_json(
                    &mut stream,
                    200,
                    &json!({
                        "v": HOST_PROTOCOL_VERSION,
                        "hostId": state.host_id,
                        "clientId": paired.client_id,
                        "token": paired.token,
                    }),
                )
                .await?;
            }
            Err(PairingError::CodeRejected) => {
                send_http_error(
                    &mut stream,
                    HostErrorCode::Unauthenticated,
                    Some(sotto_core::PAIRING_CODE_REJECTED),
                )
                .await?;
            }
            Err(_) => {
                send_http_error(&mut stream, HostErrorCode::Unavailable, None).await?;
            }
        }
        return Ok(());
    }

    if path == "/v1/session" {
        let client_id = state.pairing.lock().unwrap().verify_token(bearer);
        let Some(client_id) = client_id else {
            send_http_error(&mut stream, HostErrorCode::Unauthenticated, None).await?;
            return Ok(());
        };
        if let ListenerMode::Tailnet(ref ctrl) = mode {
            if !ctrl.allow_phones.load(Ordering::SeqCst) {
                let is_desktop = {
                    let mut desktops = state.desktops.lock().unwrap();
                    desktops.refresh();
                    desktops.has(&client_id)
                };
                if !is_desktop {
                    let msg = phones_off_message(Some(&ctrl.computer_name()));
                    send_http_error(&mut stream, HostErrorCode::Forbidden, Some(&msg)).await?;
                    return Ok(());
                }
            }
        }
        let issued = state.pairing.lock().unwrap().issue_session(&client_id);
        let Some(session) = issued else {
            send_http_error(&mut stream, HostErrorCode::Unauthenticated, None).await?;
            return Ok(());
        };
        send_http_json(
            &mut stream,
            200,
            &json!({
                "v": HOST_PROTOCOL_VERSION,
                "hostId": state.host_id,
                "clientId": client_id,
                "session": session.session,
                "expiresAt": session.expires_at,
            }),
        )
        .await?;
        return Ok(());
    }

    if path == "/v1/revoke" {
        let client_id = state.pairing.lock().unwrap().verify_token(bearer);
        let Some(client_id) = client_id else {
            send_http_error(&mut stream, HostErrorCode::Unauthenticated, None).await?;
            return Ok(());
        };
        let revoke_result = state.pairing.lock().unwrap().revoke(&client_id);
        match revoke_result {
            Ok(revoked) => {
                state.phones.handle_client_revoked(client_id);
                if let ListenerMode::Tailnet(ref ctrl) = mode {
                    (ctrl.on_peers_changed)();
                }
                send_http_json(
                    &mut stream,
                    200,
                    &json!({ "v": HOST_PROTOCOL_VERSION, "hostId": state.host_id, "revoked": revoked }),
                )
                .await?;
            }
            Err(_) => {
                send_http_error(&mut stream, HostErrorCode::Unavailable, None).await?;
            }
        }
        return Ok(());
    }

    send_http_error(&mut stream, HostErrorCode::InvalidRequest, None).await?;
    Ok(())
}

enum OutboundFrame {
    Text(String),
    Pong(Vec<u8>),
    Close,
}

#[derive(Debug, Clone)]
struct WatcherWritten {
    revision: String,
    record: String,
    progress: Vec<WatcherProgressEntry>,
}

#[derive(Default)]
struct WatcherPeerState {
    scope: Option<WatcherIdentity>,
    last_revision: Option<String>,
    written: Option<WatcherWritten>,
}

impl WatcherPeerState {
    fn reset(&mut self) {
        self.scope = None;
        self.last_revision = None;
        self.written = None;
    }

    fn record_written(&mut self, projection: &WatcherHostProjection, track_progress: bool) {
        self.last_revision = Some(projection.revision.clone());
        if track_progress {
            self.written = Some(WatcherWritten {
                revision: projection.revision.clone(),
                record: watcher_record_digest(projection),
                progress: projection.progress.clone().unwrap_or_default(),
            });
        } else {
            self.written = None;
        }
    }
}

fn push_watcher_projection(
    state: &HostState,
    client_id: &str,
    wire: &ClientWireState,
    watcher_peer: &mut WatcherPeerState,
    out_tx: &mpsc::UnboundedSender<OutboundFrame>,
) -> bool {
    if !wire.hello_done || !wire.has("watcher-reads") {
        return true;
    }
    let Some(master) = watcher_peer.scope.clone() else {
        return true;
    };
    let is_desktop = {
        let mut desktops = state.desktops.lock().unwrap();
        desktops.refresh();
        desktops.has(client_id)
    };
    if !is_desktop {
        return true;
    }
    let projection = state.watcher.remote_projection(&master, client_id);
    if watcher_peer.last_revision.as_deref() == Some(projection.revision.as_str()) {
        return true;
    }
    let track_progress = wire.has("watcher-progress");
    if track_progress {
        let record_digest = watcher_record_digest(&projection);
        if let Some(ref written) = watcher_peer.written {
            if written.record == record_digest
                && watcher_peer.last_revision.as_deref() == Some(written.revision.as_str())
            {
                let change = watcher_progress_change(
                    &written.progress,
                    projection.progress.as_deref().unwrap_or(&[]),
                );
                let progress = WatcherHostProgress {
                    base_revision: written.revision.clone(),
                    revision: projection.revision.clone(),
                    observed_at: projection.observed_at.clone(),
                    changed: change.changed,
                    removed: change.removed,
                    whole: change.whole,
                };
                let frame = json!({
                    "v": HOST_PROTOCOL_VERSION,
                    "event": "watcher-progress",
                    "progress": progress,
                });
                if let Ok(encoded) = serde_json::to_string(&frame) {
                    if out_tx.send(OutboundFrame::Text(encoded)).is_err() {
                        return false;
                    }
                    watcher_peer.record_written(&projection, true);
                }
                return true;
            }
        }
    }
    let frame = json!({
        "v": HOST_PROTOCOL_VERSION,
        "event": "watcher-state",
        "projection": projection,
    });
    if let Ok(encoded) = serde_json::to_string(&frame) {
        if out_tx.send(OutboundFrame::Text(encoded)).is_err() {
            return false;
        }
        watcher_peer.record_written(&projection, track_progress);
    }
    true
}

async fn handle_websocket_upgrade(
    mut stream: TcpStream,
    headers: &HashMap<String, String>,
    state: Arc<HostState>,
    mode: ListenerMode,
    mut shutdown: watch::Receiver<bool>,
) -> std::io::Result<()> {
    let session = extract_bearer(headers).to_string();
    let auth = {
        let mut pairing = state.pairing.lock().unwrap();
        pairing
            .verify_session_with_expiry(&session)
            .map(|(cid, expiry_ms)| {
                let name = pairing
                    .list()
                    .iter()
                    .find(|c| c.client_id == cid)
                    .map(|c| c.name.clone())
                    .unwrap_or_else(|| "Paired client".into());
                (cid, name, expiry_ms)
            })
    };
    let Some((client_id, client_name, expiry_ms)) = auth else {
        stream
            .write_all(
                b"HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
            )
            .await?;
        return Ok(());
    };
    if let ListenerMode::Tailnet(ref ctrl) = mode {
        if !ctrl.serving.load(Ordering::SeqCst) {
            return Ok(());
        }
        let admitted = ctrl.allow_phones.load(Ordering::SeqCst)
            || state.desktops.lock().unwrap().has(&client_id)
            || {
                let mut desktops = state.desktops.lock().unwrap();
                desktops.refresh();
                desktops.has(&client_id)
            };
        if !admitted {
            stream
                .write_all(
                    b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
                )
                .await?;
            return Ok(());
        }
    }
    let key = headers.get("sec-websocket-key").map(String::as_str);
    let version = headers.get("sec-websocket-version").map(String::as_str);

    let Some(key) = key else {
        stream
            .write_all(b"HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
            .await?;
        return Ok(());
    };
    if version != Some("13") || !is_valid_websocket_key(key) {
        stream
            .write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
            .await?;
        return Ok(());
    }

    let deflate = deflate_offered(headers.get("sec-websocket-extensions").map(String::as_str));
    let accept = websocket_accept(key);
    let mut response = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n"
    );
    if deflate {
        response.push_str(&format!("Sec-WebSocket-Extensions: {DEFLATE_RESPONSE}\r\n"));
    }
    response.push_str("\r\n");
    stream.write_all(response.as_bytes()).await?;
    stream.flush().await?;

    let _connected_guard = match mode {
        ListenerMode::Tailnet(ref ctrl) => {
            Some(ConnectedPeerGuard::new(Arc::clone(ctrl), client_id.clone()))
        }
        ListenerMode::Admin => None,
    };
    let _client_socket = ClientSocket::open(Arc::clone(&state), &client_id);

    let (mut read_half, mut write_half) = tokio::io::split(stream);
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<OutboundFrame>();
    let (in_tx, mut in_rx) = mpsc::channel(64);

    // Dedicated cancel-safe reader task: `read_ws_message` is never cancelled mid-frame by
    // coordinator broadcasts, revocations, or timers.
    let reader_task = tokio::spawn(async move {
        let mut reader_state = WsReaderState::default();
        loop {
            let res = read_ws_message(&mut read_half, deflate, &mut reader_state).await;
            let done = matches!(&res, Ok(WsMessage::Close) | Err(_));
            if in_tx.send(res).await.is_err() || done {
                break;
            }
        }
    });

    let writer_task = tokio::spawn(async move {
        while let Some(frame) = out_rx.recv().await {
            let res = match frame {
                OutboundFrame::Text(text) => write_ws_text(&mut write_half, &text, deflate).await,
                OutboundFrame::Pong(payload) => write_ws_pong(&mut write_half, &payload).await,
                OutboundFrame::Close => {
                    let _ = write_ws_close(&mut write_half).await;
                    break;
                }
            };
            if res.is_err() {
                break;
            }
        }
    });

    let mut wire = ClientWireState::default();
    let mut watcher_peer = WatcherPeerState::default();
    let mut revoked_rx = state.revoked_tx.subscribe();
    let mut drop_rx = match mode {
        ListenerMode::Tailnet(ref ctrl) => Some(ctrl.drop_tx.subscribe()),
        ListenerMode::Admin => None,
    };
    let mut capabilities_rx = state.capabilities_tx.subscribe();
    let mut coord_rx = state.coordinator.subscribe();
    let mut watcher_rx = state.watcher.subscribe();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let remaining_ms = (expiry_ms - now_ms).max(0) as u64;
    let expiry_sleep = tokio::time::sleep(Duration::from_millis(remaining_ms));
    tokio::pin!(expiry_sleep);

    loop {
        tokio::select! {
            _ = shutdown.changed() => {
                let _ = out_tx.send(OutboundFrame::Close);
                break;
            }
            revoked_id = revoked_rx.recv() => {
                if matches!(revoked_id, Ok(ref id) if id == &client_id)
                    || state.pairing.lock().unwrap().verify_session(&session).as_deref() != Some(client_id.as_str())
                {
                    let _ = out_tx.send(OutboundFrame::Close);
                    break;
                }
            }
            _ = async {
                match drop_rx.as_mut() {
                    Some(rx) => {
                        let _ = rx.recv().await;
                    }
                    None => std::future::pending::<()>().await,
                }
            } => {
                let keep = if let ListenerMode::Tailnet(ref ctrl) = mode {
                    ctrl.serving.load(Ordering::SeqCst)
                        && state.pairing.lock().unwrap().verify_session(&session).as_deref()
                            == Some(client_id.as_str())
                        && (ctrl.allow_phones.load(Ordering::SeqCst)
                            || state.desktops.lock().unwrap().has(&client_id))
                } else {
                    true
                };
                if !keep {
                    let _ = out_tx.send(OutboundFrame::Close);
                    break;
                }
            }
            cap_id = capabilities_rx.recv() => {
                if wire.hello_done && matches!(cap_id, Ok(ref id) if id == &client_id) {
                    let may_answer = state
                        .memory
                        .lock()
                        .unwrap()
                        .may_grant_remote(&client_id)
                        .unwrap_or(false);
                    if let Ok(shell) = state.coordinator.shell(may_answer).await {
                        let frame = wire.encode_shell_push(shell);
                        if let Ok(encoded) = serde_json::to_string(&frame) {
                            if out_tx.send(OutboundFrame::Text(encoded)).is_err() {
                                break;
                            }
                        }
                    }
                }
            }
            _ = &mut expiry_sleep => {
                let _ = out_tx.send(OutboundFrame::Close);
                break;
            }
            bcast = coord_rx.recv() => {
                if !wire.hello_done {
                    continue;
                }
                if !forward_coordinator_broadcast(&state, &client_id, &mut wire, &out_tx, bcast).await {
                    break;
                }
            }
            watcher_ev = watcher_rx.recv() => {
                match watcher_ev {
                    Ok(()) | Err(broadcast::error::RecvError::Lagged(_)) => {
                        if !push_watcher_projection(&state, &client_id, &wire, &mut watcher_peer, &out_tx) {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => {}
                }
            }
            maybe_msg = in_rx.recv() => {
                let Some(msg) = maybe_msg else {
                    let _ = out_tx.send(OutboundFrame::Close);
                    break;
                };
                match msg {
                    Ok(WsMessage::Text(text)) => {
                        if state.pairing.lock().unwrap().verify_session(&session).as_deref()
                            != Some(client_id.as_str())
                        {
                            let _ = out_tx.send(OutboundFrame::Close);
                            break;
                        }
                        let reply = handle_ws_request(
                            &state,
                            &mode,
                            &client_id,
                            &client_name,
                            &session,
                            &mut wire,
                            &mut watcher_peer,
                            &out_tx,
                            &text,
                        )
                        .await;
                        let mut encoded = serde_json::to_string(&reply).map_err(std::io::Error::other)?;
                        // An answer too large for one frame is refused in its place, as Node's socket server refuses it,
                        // rather than closing the socket, which would only have the client ask again.
                        if encoded.len() > sotto_core::HOST_MAX_FRAME_BYTES {
                            let op = serde_json::from_str::<Value>(&text).ok().and_then(|req| req.get("op").and_then(Value::as_str).map(ToString::to_string));
                            let refused = HostResponseEnvelope::err(reply.id.clone(), HostErrorCode::TooLarge, too_large_words(op.as_deref().unwrap_or("")));
                            encoded = serde_json::to_string(&refused).map_err(std::io::Error::other)?;
                        }
                        if out_tx.send(OutboundFrame::Text(encoded)).is_err() {
                            break;
                        }
                    }
                    Ok(WsMessage::Ping(payload)) => {
                        if out_tx.send(OutboundFrame::Pong(payload)).is_err() {
                            break;
                        }
                    }
                    Ok(WsMessage::Pong(_)) => {}
                    Ok(WsMessage::Close) | Err(_) => {
                        let _ = out_tx.send(OutboundFrame::Close);
                        break;
                    }
                }
            }
        }
    }

    reader_task.abort();
    drop(out_tx);
    let _ = writer_task.await;
    // A client that went shows nothing now (ADR-0092).
    state.coordinator.forget_observer(wire.observer.clone());
    Ok(())
}

/// Sends one connection what the coordinator published: its shell, a thread's update, or the whole shell again after
/// this connection fell behind. Each shell, and a lag that may have skipped one, first tells it of each answer it watches
/// that a provider took, as Node checks `answerWatches` on every publication. False when the socket is gone.
async fn forward_coordinator_broadcast(
    state: &HostState,
    client_id: &str,
    wire: &mut ClientWireState,
    out_tx: &mpsc::UnboundedSender<OutboundFrame>,
    bcast: Result<CoordinatorBroadcast, broadcast::error::RecvError>,
) -> bool {
    match bcast {
        Ok(CoordinatorBroadcast::Shell(mut shell)) => {
            if !push_answer_receipts(state, client_id, wire, out_tx).await {
                return false;
            }
            let may_answer = state.memory.lock().unwrap().may_grant_remote(client_id).unwrap_or(false);
            if let Some(obj) = shell.as_object_mut() {
                obj.insert("clientCapabilities".into(), json!({ "mayAnswer": may_answer }));
            }
            let frame = wire.encode_shell_push(shell);
            if let Ok(encoded) = serde_json::to_string(&frame) {
                if out_tx.send(OutboundFrame::Text(encoded)).is_err() {
                    return false;
                }
            }
        }
        Ok(CoordinatorBroadcast::Detail(detail)) => {
            if let Some(frame) = wire.encode_detail_update_push(&detail) {
                if let Ok(encoded) = serde_json::to_string(&frame) {
                    if out_tx.send(OutboundFrame::Text(encoded)).is_err() {
                        return false;
                    }
                }
            }
        }
        Err(broadcast::error::RecvError::Lagged(_)) => {
            if !push_answer_receipts(state, client_id, wire, out_tx).await {
                return false;
            }
            // On lag, resend whole shell cleanly so the client stays in sync.
            let may_answer = state.memory.lock().unwrap().may_grant_remote(client_id).unwrap_or(false);
            if let Ok(shell) = state.coordinator.shell(may_answer).await {
                let frame = wire.encode_shell_push(shell);
                if let Ok(encoded) = serde_json::to_string(&frame) {
                    let _ = out_tx.send(OutboundFrame::Text(encoded));
                }
            }
        }
        Err(broadcast::error::RecvError::Closed) => return false,
    }
    true
}

/// One paired client's command under its own request ID, as Node's socket server keeps its receipt (`CommandReceipts`):
/// a command sent again under that ID is answered from its first run, and one that passed every check is kept while it
/// runs and once it ended. The digest is of the command alone, kept in memory only.
struct CommandReceipt<'a> {
    state: &'a HostState,
    client_id: &'a str,
    request_id: String,
    digest: String,
}

struct PullRequestConfirmRedeem {
    thread_id: String,
    url: String,
    action: ConfirmedPullRequestAction,
    method: Option<sotto_core::pull_requests::GitPullRequestMergeMethod>,
    confirmation: Option<String>,
}

impl<'a> CommandReceipt<'a> {
    fn new(state: &'a HostState, client_id: &'a str, request_id: &str, command: &serde_json::Map<String, Value>) -> Self {
        let digest = sha256_hex(serde_json::to_string(command).unwrap_or_default().as_bytes());
        Self { state, client_id, request_id: request_id.to_string(), digest }
    }

    /// The answer to a command this client already sent under this request ID, before any other check, as Node answers
    /// it: refused if it says something else, waited on while it runs, and then answered as it ended, a failure in its
    /// code's own words. None when this client sent no command under the ID, or none the host still keeps.
    async fn replay(&self, wire: &mut ClientWireState, may_answer: bool) -> Option<HostResponseEnvelope> {
        let previous = self.state.receipts.lock().unwrap().get(self.client_id, &self.request_id)?;
        let id = self.request_id.clone();
        if previous.digest != self.digest {
            return Some(HostResponseEnvelope::err(id, HostErrorCode::InvalidRequest, HostErrorCode::InvalidRequest.default_message()));
        }
        Some(match previous.settled().await {
            None => HostResponseEnvelope::err(id, HostErrorCode::Unavailable, HostErrorCode::Unavailable.default_message()),
            Some(Receipt { error: Some(code), .. }) => HostResponseEnvelope::err(id, code, code.default_message()),
            Some(_) => match self.state.coordinator.shell(may_answer).await {
                Ok(raw_shell) => HostResponseEnvelope::ok(id, wire.encode_command_shell(raw_shell)),
                Err(err) => HostResponseEnvelope::err(id, err.code, err.message),
            },
        })
    }

    /// Runs a command that passed every check, its receipt kept first, as Node keeps one only after every refusal: busy
    /// when the store is full of pending work. The command runs to its end and settles its receipt whether or not the
    /// socket stays to hear it.
    async fn run(
        self,
        client: ClientContext,
        command: serde_json::Map<String, Value>,
        confirm_redeem: Option<PullRequestConfirmRedeem>,
        wire: &mut ClientWireState,
    ) -> HostResponseEnvelope {
        let CommandReceipt { state, client_id, request_id, digest } = self;
        let match_head_commit: Option<String>;
        {
            // Only pending work is busy: settled receipts make room. Check room BEFORE redeeming any single-use
            // pull request confirmation receipt so a `busy` refusal never burns the client's receipt (Node socketServer.ts:1703).
            let mut receipts = state.receipts.lock().unwrap();
            if !receipts.make_room() {
                return HostResponseEnvelope::err(request_id, HostErrorCode::Busy, HostErrorCode::Busy.default_message());
            }
            match_head_commit = if let Some(redeem) = confirm_redeem {
                let redeemed = state
                    .pull_request_confirmations
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .redeem(client_id, redeem.confirmation.as_deref(), &redeem.thread_id, &redeem.url, redeem.action, redeem.method);
                match redeemed {
                    Ok(head) => head,
                    Err(message) => return HostResponseEnvelope::err(request_id, HostErrorCode::Forbidden, message),
                }
            } else {
                None
            };
            receipts.record(client_id, &request_id, digest);
        }
        let is_answer = command.get("type").and_then(Value::as_str) == Some("answer");
        // An answer is given under this client's own decision ID, so its receipt can say whether it was taken.
        let decision_id = is_answer.then(|| answer_decision_id(client_id, &request_id));
        let queued = state.coordinator.enqueue_command_with_meta(client, command, decision_id, match_head_commit);
        let receipts = Arc::clone(&state.receipts);
        let (client_key, request_key) = (client_id.to_string(), request_id.clone());
        let (ended_tx, ended_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let outcome = match queued {
                Ok(reply) => reply.await.unwrap_or_else(|_| Err(sotto_core::CoordinatorError::unavailable("Host coordinator stopped."))),
                Err(err) => Err(err),
            };
            receipts.lock().unwrap().settle(&client_key, &request_key, ended_receipt(is_answer, &outcome));
            let _ = ended_tx.send(outcome);
        });
        match ended_rx.await {
            Ok(Ok(raw_shell)) => HostResponseEnvelope::ok(request_id, wire.encode_command_shell(raw_shell)),
            Ok(Err(err)) => HostResponseEnvelope::err(request_id, err.code, err.message),
            Err(_) => HostResponseEnvelope::err(request_id, HostErrorCode::Unavailable, HostErrorCode::Unavailable.default_message()),
        }
    }
}

/// Tells a client that takes `answer-receipts` of each answer it watches that a provider has now taken, as Node's
/// socket server does on each of the host's publications, and stops watching each one it was told of. False when the
/// socket is gone.
async fn push_answer_receipts(
    state: &HostState,
    client_id: &str,
    wire: &mut ClientWireState,
    out_tx: &mpsc::UnboundedSender<OutboundFrame>,
) -> bool {
    if !wire.has("answer-receipts") || wire.answer_watches.is_empty() {
        return true;
    }
    let watched = wire.answer_watches.watched().to_vec();
    let accepted = state.coordinator.accepted_answers(client_id.to_string(), watched.clone()).await.unwrap_or_default();
    for (command_id, target) in watched.iter().filter(|(command_id, _)| accepted.contains(command_id)) {
        let frame = json!({ "v": HOST_PROTOCOL_VERSION, "event": "answer-receipt", "acceptedAnswer": target.accepted(command_id) });
        let Ok(encoded) = serde_json::to_string(&frame) else {
            continue;
        };
        if out_tx.send(OutboundFrame::Text(encoded)).is_err() {
            return false;
        }
        wire.answer_watches.forget(command_id);
    }
    true
}

#[allow(clippy::too_many_arguments)]
async fn handle_ws_request(
    state: &HostState,
    mode: &ListenerMode,
    client_id: &str,
    client_name: &str,
    upgrade_session: &str,
    wire: &mut ClientWireState,
    watcher_peer: &mut WatcherPeerState,
    out_tx: &mpsc::UnboundedSender<OutboundFrame>,
    raw: &str,
) -> HostResponseEnvelope {
    let req: HostRequestEnvelope = match serde_json::from_str(raw) {
        Ok(r) => r,
        Err(_) => {
            return HostResponseEnvelope::err(
                String::new(),
                HostErrorCode::InvalidRequest,
                HostErrorCode::InvalidRequest.default_message(),
            );
        }
    };
    if req.v != HOST_PROTOCOL_VERSION {
        return HostResponseEnvelope::err(
            req.id,
            HostErrorCode::InvalidRequest,
            HostErrorCode::InvalidRequest.default_message(),
        );
    }
    if let Some(ref msg_session) = req.session {
        if !constant_time_eq(msg_session.as_bytes(), upgrade_session.as_bytes())
            && state
                .pairing
                .lock()
                .unwrap()
                .verify_session(msg_session)
                .as_deref()
                != Some(client_id)
        {
            return HostResponseEnvelope::err(
                req.id,
                HostErrorCode::Unauthenticated,
                HostErrorCode::Unauthenticated.default_message(),
            );
        }
    }

    let may_answer = state
        .memory
        .lock()
        .unwrap()
        .may_grant_remote(client_id)
        .unwrap_or(false);

    match req.op.as_str() {
        "hello" => {
            let is_desktop = {
                let mut desktops = state.desktops.lock().unwrap();
                desktops.refresh();
                desktops.has(client_id)
            };
            let client_features = features_for_client(&state.features, is_desktop, desktop_on_listener(mode, is_desktop));
            let advertised: std::collections::HashSet<&str> =
                client_features.iter().map(String::as_str).collect();
            let accepts: Vec<String> = req
                .fields
                .get("accepts")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .filter(|feat| advertised.contains(feat))
                        .map(ToString::to_string)
                        .collect()
                })
                .unwrap_or_default();
            wire.apply_hello(accepts);
            watcher_peer.reset();

            let after_seq = req
                .fields
                .get("afterSeq")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let raw_shell = match state.coordinator.shell(may_answer).await {
                Ok(s) => s,
                Err(err) => return HostResponseEnvelope::err(req.id, err.code, err.message),
            };
            let shell = wire.encode_reply_shell(raw_shell);
            let (raw_events, has_more, latest_seq) = state
                .coordinator
                .events(None, after_seq, 200)
                .await
                .unwrap_or_default();
            let allow_aliases = wire.has("message-aliases");
            let events: Vec<_> = raw_events
                .into_iter()
                .filter(|ev| {
                    allow_aliases
                        || ev.event.get("kind").and_then(Value::as_str) != Some("message-aliased")
                })
                .collect();
            let memory_version = state.memory.lock().unwrap().schema_version().unwrap_or(0);
            let subagents_ok = state
                .subagents
                .lock()
                .unwrap()
                .quick_check()
                .map(|s| s == "ok")
                .unwrap_or(false);
            let credentials_secure = state.credentials.lock().unwrap().is_secure();

            let phone_access_visible = match mode {
                ListenerMode::Admin => true,
                ListenerMode::Tailnet(_) => is_desktop,
            };
            let mut result = json!({
                "hostId": state.host_id,
                "clientId": client_id,
                "sottoVersion": state.sotto_version,
                "features": client_features,
                "capabilities": { "mayAnswer": may_answer },
                // The host program this host is (ADR-0214), for a desktop row's Node | Rust control.
                "hostProgram": "rust",
                "events": events,
                "hasMore": has_more,
                "latestSeq": latest_seq.max(after_seq),
                "shell": shell,
                "stores": {
                    "memorySchemaVersion": memory_version,
                    "subagentsOk": subagents_ok,
                    "credentialsSecure": credentials_secure,
                },
            });
            if let Some(obj) = result.as_object_mut() {
                if let Some(ref started_by) = state.started_by {
                    obj.insert("startedBy".into(), Value::String(started_by.clone()));
                }
                if let Some(tailnet_address) = state.phones.address() {
                    obj.insert("tailnetAddress".into(), Value::String(tailnet_address));
                }
                if phone_access_visible {
                    let summary = state.phones.summary();
                    obj.insert(
                        "phoneAccess".into(),
                        serde_json::to_value(summary)
                            .unwrap_or_else(|_| json!({ "status": "off", "phones": 0 })),
                    );
                }
            }
            HostResponseEnvelope::ok(req.id, result)
        }
        "ping" => HostResponseEnvelope::ok(req.id, json!({ "pong": true })),
        "shell" | "state" => match state.coordinator.shell(may_answer).await {
            Ok(raw_shell) => HostResponseEnvelope::ok(req.id, wire.encode_reply_shell(raw_shell)),
            Err(err) => HostResponseEnvelope::err(req.id, err.code, err.message),
        },
        "observe" => {
            let Some(arr) = req.fields.get("threadIds").and_then(Value::as_array) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            // `shown: false`: a desktop whose window is behind another app. Its threads stay observed, but none counts as
            // shown, which sees a failure (ADR-0092). Node's schema takes only `false`.
            let shown = match req.fields.get("shown") {
                None => true,
                Some(Value::Bool(false)) => false,
                Some(_) => {
                    return HostResponseEnvelope::err(
                        req.id,
                        HostErrorCode::InvalidRequest,
                        HostErrorCode::InvalidRequest.default_message(),
                    );
                }
            };
            let thread_ids: Vec<String> = arr
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect();
            wire.hidden = !shown;
            let previously_observed = wire.observed.clone();
            wire.set_observed(&thread_ids);

            let details = match state.coordinator.observe(wire.observer.clone(), thread_ids.clone(), shown).await {
                Ok(list) => list,
                Err(err) => return HostResponseEnvelope::err(req.id, err.code, err.message),
            };
            // Protocol v1 promise: push every newly observed thread's detail BEFORE answering `observe`
            // (unless `detail-read-held` confirmed the client already holds this exact revision).
            for (tid, detail) in details {
                if !previously_observed.contains(&tid) {
                    if let Some(push_frame) = wire.encode_observe_detail_push(&tid, detail.as_ref()) {
                        if let Ok(encoded) = serde_json::to_string(&push_frame) {
                            let _ = out_tx.send(OutboundFrame::Text(encoded));
                        }
                    }
                }
            }
            HostResponseEnvelope::ok(req.id, Value::Null)
        }
        "detail" => {
            let Some(thread_id) = req.fields.get("threadId").and_then(Value::as_str) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            match state.coordinator.detail(thread_id.to_string()).await {
                Ok(Some(detail)) => {
                    let formatted = wire.record_detail_read(&detail);
                    HostResponseEnvelope::ok(
                        req.id,
                        serde_json::to_value(formatted).unwrap_or(Value::Null),
                    )
                }
                Ok(None) => HostResponseEnvelope::ok(req.id, Value::Null),
                Err(err) => HostResponseEnvelope::err(req.id, err.code, err.message),
            }
        }
        "events" => {
            let thread_id = req
                .fields
                .get("threadId")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            let after_seq = req
                .fields
                .get("afterSeq")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let limit = req
                .fields
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(200)
                .min(500) as usize;
            match state.coordinator.events(thread_id, after_seq, limit).await {
                Ok((raw_events, has_more, latest_seq)) => {
                    let allow_aliases = wire.has("message-aliases");
                    let events: Vec<_> = raw_events
                        .into_iter()
                        .filter(|ev| {
                            allow_aliases
                                || ev.event.get("kind").and_then(Value::as_str)
                                    != Some("message-aliased")
                        })
                        .collect();
                    HostResponseEnvelope::ok(
                        req.id,
                        json!({
                            "events": events,
                            "hasMore": has_more,
                            "latestSeq": latest_seq,
                        }),
                    )
                }
                Err(err) => HostResponseEnvelope::err(req.id, err.code, err.message),
            }
        }
        "stage-attachment" => {
            let Some(img) = req.fields.get("image").and_then(Value::as_object) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let (Some(name), Some(mime), Some(data)) = (
                img.get("name").and_then(Value::as_str),
                img.get("mimeType").and_then(Value::as_str),
                img.get("data").and_then(Value::as_str),
            ) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let dimensions = img.get("dimensions").cloned();
            match state
                .coordinator
                .stage_image(name.into(), mime.into(), data.into(), dimensions)
                .await
            {
                Ok(handle) => HostResponseEnvelope::ok(
                    req.id,
                    serde_json::to_value(handle).unwrap_or(Value::Null),
                ),
                Err(err) => HostResponseEnvelope::err(req.id, err.code, err.message),
            }
        }
        "attachment-content" => {
            let Some(digest) = req.fields.get("digest").and_then(Value::as_str) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            match state
                .coordinator
                .attachment_content(digest.to_string())
                .await
            {
                Ok(Some((mime, bytes))) => HostResponseEnvelope::ok(
                    req.id,
                    json!({
                        "mimeType": mime,
                        "data": base64::engine::general_purpose::STANDARD.encode(bytes),
                    }),
                ),
                Ok(None) => HostResponseEnvelope::ok(req.id, Value::Null),
                Err(err) => HostResponseEnvelope::err(req.id, err.code, err.message),
            }
        }
        // One part of a file for a draft on this host (`file-staging`, ADR-0131), the last part's answer its handle, as
        // Node's host takes it: one upload per paired client across its sockets, a video's parts on disk with
        // `video-staging`. Node takes one part at a time per socket; this host answers a socket's requests in turn.
        "stage-file-part" => {
            let offered = offered_features(state, mode, client_id);
            let part = match checked_file_part(&req.fields, |feature| offered.iter().any(|name| name == feature)) {
                Ok(part) => part,
                Err((code, words)) => return HostResponseEnvelope::err(req.id, code, words),
            };
            let uploads = Arc::clone(&state.uploads).lock_owned().await;
            let client = client_id.to_string();
            let now = now_ms();
            let taken = tokio::task::spawn_blocking(move || {
                let mut uploads = uploads;
                uploads.receive_part(&client, &part, now)
            })
            .await
            .unwrap_or(Err(AttachmentError::Failed));
            let received = match taken {
                Ok(PartTaken::Whole(received)) => received,
                Ok(PartTaken::More { wait_ms }) => {
                    // The upload goes once its wait after this part is over, unless another part came, as Node's timer
                    // after each part lets it go; a video's part file goes with it.
                    let uploads = Arc::clone(&state.uploads);
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(wait_ms)).await;
                        uploads.lock().await.sweep(now_ms());
                    });
                    return HostResponseEnvelope::ok(req.id, Value::Null);
                }
                Err(AttachmentError::Refused(words)) => return HostResponseEnvelope::err(req.id, HostErrorCode::InvalidRequest, words),
                Err(AttachmentError::Failed) => {
                    return HostResponseEnvelope::err(req.id, HostErrorCode::Unavailable, HostErrorCode::Unavailable.default_message())
                }
            };
            let upload_file = match &received {
                Received::Video { path, .. } => Some(path.clone()),
                Received::File { .. } => None,
            };
            let staged = state.coordinator.stage_received(received).await;
            // Moved into the store, or not kept: the upload's file goes either way.
            if let Some(path) = upload_file {
                let _ = fs::remove_file(path);
            }
            match staged {
                Ok(handle) => HostResponseEnvelope::ok(req.id, serde_json::to_value(handle).unwrap_or(Value::Null)),
                // A file refused for what it is says so; anything else is the host's failure to keep it.
                Err(AttachmentError::Refused(words)) => HostResponseEnvelope::err(req.id, HostErrorCode::InvalidRequest, words),
                Err(AttachmentError::Failed) => {
                    HostResponseEnvelope::err(req.id, HostErrorCode::Unavailable, HostErrorCode::Unavailable.default_message())
                }
            }
        }
        // How many parts of an upload the host holds for this client (`video-staging`), so it can carry on where it
        // stopped, or null when it holds none.
        "file-upload-progress" => {
            let offered = offered_features(state, mode, client_id);
            let upload_id = match checked_upload_progress(&req.fields, |feature| offered.iter().any(|name| name == feature)) {
                Ok(upload_id) => upload_id,
                Err(code) => return HostResponseEnvelope::err(req.id, code, code.default_message()),
            };
            let parts = state.uploads.lock().await.progress(client_id, &upload_id, now_ms());
            HostResponseEnvelope::ok(req.id, parts.map_or(Value::Null, |parts| json!({ "parts": parts })))
        }
        // One part of a file a sent message carries, for the iPhone's Quick Look (ADR-0131, October 25 amendment), as
        // Node's host answers it: only a file that user message carries and the store still keeps. Node reads one at a
        // time per socket, which this host does by answering a socket's requests in turn, and one per paired client
        // across its sockets.
        "attachment-file" => {
            let checked = offered_thread_read(state, mode, client_id, wire, &req.fields, sotto_core::attachment_files::attachment_file_request).await;
            let request = match checked {
                Ok(request) => request,
                Err(code) => return HostResponseEnvelope::err(req.id, code, code.default_message()),
            };
            let Some(_reading) = FileRead::start(state, client_id) else {
                return HostResponseEnvelope::err(req.id, HostErrorCode::Busy, HostErrorCode::Busy.default_message());
            };
            let part = request.part;
            let named = (request.thread_id, request.message_id, request.attachment_id);
            read_sent_attachment(state, req.id, named, Wanted::File, move |path, file| sotto_core::attachment_files::read_part(path, file, part)).await
        }
        // A picture a sent message carries, as Node's host answers `preview` (ADR-0031): only one that user message's
        // preview entry names and the store still keeps, as a data URL. An edge is refused, since this host offers no
        // picture edges. Node reads one at a time per socket, which this host does by answering a socket's requests in turn.
        "preview" => {
            let checked = offered_thread_read(state, mode, client_id, wire, &req.fields, sotto_core::attachment_previews::preview_request).await;
            let request = match checked {
                Ok(request) => request,
                Err(code) => return HostResponseEnvelope::err(req.id, code, code.default_message()),
            };
            let named = (request.thread_id, request.message_id, request.attachment_id);
            read_sent_attachment(state, req.id, named, Wanted::Picture, sotto_core::attachment_previews::read_preview).await
        }
        "command" => {
            let Some(cmd) = req.fields.get("command").and_then(Value::as_object) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            // A command sent again under the same request ID is answered from its first run, before any other check.
            let receipt = CommandReceipt::new(state, client_id, &req.id, cmd);
            if let Some(reply) = receipt.replay(wire, may_answer).await {
                return reply;
            }
            // Deleting a thread is read as Node's strict schema reads it (`commandFromProtocolV1`) before anything turns it
            // down or keeps its receipt, so one in the wrong shape is invalid_request whatever this client may do.
            let deleting = matches!(cmd.get("type").and_then(Value::as_str), Some("delete-thread" | "preview-delete-thread"));
            if deleting && !sotto_core::thread_clearing::delete_command_shape(cmd) {
                return HostResponseEnvelope::err(req.id, HostErrorCode::InvalidRequest, HostErrorCode::InvalidRequest.default_message());
            }
            // So is removing a thread's own worktree folder (ADR-0041), with its confirmations as Delete thread… limits them.
            let reclaiming = matches!(cmd.get("type").and_then(Value::as_str), Some("reclaim-thread-worktree" | "preview-reclaim-thread-worktree"));
            if reclaiming && !sotto_core::worktree_reclaim::reclaim_command_shape(cmd) {
                return HostResponseEnvelope::err(req.id, HostErrorCode::InvalidRequest, HostErrorCode::InvalidRequest.default_message());
            }
            // And so are Retry, Refresh and Restore branch of a thread's working copy.
            let working_copy = matches!(cmd.get("type").and_then(Value::as_str), Some("retry-thread-worktree" | "refresh-thread-worktree" | "restore-thread-branch"));
            if working_copy && !sotto_core::worktree_reclaim::working_copy_command_shape(cmd) {
                return HostResponseEnvelope::err(req.id, HostErrorCode::InvalidRequest, HostErrorCode::InvalidRequest.default_message());
            }
            // And so is choosing a thread's working copy before its first send.
            let choosing = cmd.get("type").and_then(Value::as_str) == Some("configure-thread-working-copy");
            if choosing && sotto_core::worktree_reclaim::WorkingCopySelection::from_command(cmd).is_none() {
                return HostResponseEnvelope::err(req.id, HostErrorCode::InvalidRequest, HostErrorCode::InvalidRequest.default_message());
            }
            // And so are Pull, Switch branch, Initialize Git, and Publish.
            let local_git = matches!(cmd.get("type").and_then(Value::as_str), Some("git-pull" | "git-switch-branch" | "git-init" | "git-publish"));
            if local_git && sotto_core::git_local::LocalGitCommand::from_command(cmd).is_none() {
                return HostResponseEnvelope::err(req.id, HostErrorCode::InvalidRequest, HostErrorCode::InvalidRequest.default_message());
            }
            // And so are the GitHub pull request commands (ADR-0027, #1691).
            let pr_cmd = matches!(
                cmd.get("type").and_then(Value::as_str),
                Some("git-pull-request-action" | "git-link-pull-request" | "git-unlink-pull-request" | "git-checkout-pull-request")
            );
            if pr_cmd && !valid_pull_request_command_shape(cmd) {
                return HostResponseEnvelope::err(req.id, HostErrorCode::InvalidRequest, HostErrorCode::InvalidRequest.default_message());
            }
            // A command for a thread of a provider this client does not know is not this client's to send, as Node's
            // socket server refuses it.
            if let Some(thread_id) = cmd.get("threadId").and_then(Value::as_str) {
                if hides_thread(state, wire, thread_id).await {
                    return HostResponseEnvelope::err(
                        req.id,
                        HostErrorCode::Forbidden,
                        HostErrorCode::Forbidden.default_message(),
                    );
                }
            }
            // A save naming the revision it saw is a `draft-revisions` client's, as Node's socket server allows it.
            if cmd.get("type").and_then(Value::as_str) == Some("save-thread-draft") && cmd.contains_key("expectedDraftId") && !wire.has("draft-revisions") {
                return HostResponseEnvelope::err(req.id, HostErrorCode::InvalidRequest, HostErrorCode::InvalidRequest.default_message());
            }
            // A socket client's own `observe-threads` is what its connection observes, as an `observe` is, and goes with
            // the connection (`src/host/socketServer.ts`).
            if cmd.get("type").and_then(Value::as_str) == Some("observe-threads") {
                let Some(thread_ids) = observed_thread_ids(cmd) else {
                    return HostResponseEnvelope::err(
                        req.id,
                        HostErrorCode::InvalidRequest,
                        HostErrorCode::InvalidRequest.default_message(),
                    );
                };
                wire.set_observed(&thread_ids);
                if let Err(err) = state.coordinator.observe(wire.observer.clone(), thread_ids, !wire.hidden).await {
                    return HostResponseEnvelope::err(req.id, err.code, err.message);
                }
                return match state.coordinator.shell(may_answer).await {
                    Ok(raw_shell) => HostResponseEnvelope::ok(req.id, wire.encode_command_shell(raw_shell)),
                    Err(err) => HostResponseEnvelope::err(req.id, err.code, err.message),
                };
            }
            let client = ClientContext {
                client_id: client_id.to_string(),
                user: client_name.to_string(),
                may_answer,
            };
            let kind = cmd.get("type").and_then(Value::as_str).unwrap_or_default();
            // Then Node's `remoteCommandRefusal`: deleting is only for a listener that offers `thread-delete` (ADR-0140),
            // and a delete takes the remote-answer policy. Both are turned down before the preview answers and before a
            // delete's receipt is kept.
            if deleting {
                if !offered_features(state, mode, client_id).iter().any(|f| f == "thread-delete") {
                    return HostResponseEnvelope::err(req.id, HostErrorCode::Forbidden, HostErrorCode::Forbidden.default_message());
                }
                if let Err(refusal) = validate_remote_command(cmd, may_answer) {
                    let message = refusal.message.unwrap_or_else(|| refusal.code.default_message().to_string());
                    return HostResponseEnvelope::err(req.id, refusal.code, message);
                }
            }
            // A preview keeps no receipt: Node's socket server answers it before it keeps one, with its own outcome, once
            // `remoteCommandRefusal` has passed it.
            if kind == "preview-reclaim-thread-worktree" {
                if let Err(refusal) = validate_remote_command(cmd, may_answer) {
                    let message = refusal.message.unwrap_or_else(|| refusal.code.default_message().to_string());
                    return HostResponseEnvelope::err(req.id, refusal.code, message);
                }
            }
            if !keeps_receipt(kind) || kind == "preview-delete-thread" || kind == "preview-reclaim-thread-worktree" {
                return match state.coordinator.run_command(client, cmd.clone()).await {
                    Ok(raw_shell) => HostResponseEnvelope::ok(req.id, wire.encode_command_shell(raw_shell)),
                    Err(err) => HostResponseEnvelope::err(req.id, err.code, err.message),
                };
            }
            // What the coordinator turns down before acting (the allow-list, its fields and ADR-0004's answer policy) is
            // turned down here before a receipt is kept, as Node's socket server refuses a management command and
            // `remoteCommandRefusal`'s before it keeps one.
            if let Err(refusal) = validate_remote_command(cmd, may_answer) {
                let message = refusal.message.unwrap_or_else(|| refusal.code.default_message().to_string());
                return HostResponseEnvelope::err(req.id, refusal.code, message);
            }
            // An answer to a request its thread no longer waits on is stale and keeps no receipt, as Node refuses it.
            if kind == "answer" {
                if let (Some(thread_id), Some(request_id)) = (cmd.get("threadId").and_then(Value::as_str), cmd.get("requestId").and_then(Value::as_str)) {
                    match state.coordinator.request_waiting(thread_id.to_string(), request_id.to_string()).await {
                        Ok(true) => {}
                        Ok(false) => return HostResponseEnvelope::err(req.id, HostErrorCode::StaleRequest, HostErrorCode::StaleRequest.default_message()),
                        Err(err) => return HostResponseEnvelope::err(req.id, err.code, err.message),
                    }
                }
            }
            // A merge, close or auto-merge runs only on this client's own confirmation receipt for exactly this press,
            // spent inside `receipt.run` AFTER `make_room()` succeeds so a `busy` refusal never burns the receipt (#1691).
            // The coordinator is told the head commit the receipt was given on, never the receipt.
            let mut dispatched_cmd = cmd.clone();
            let mut confirm_redeem = None;
            if kind == "git-pull-request-action" {
                let Some(parsed) = GitPullRequestActionCommand::parse(cmd) else {
                    return HostResponseEnvelope::err(req.id, HostErrorCode::InvalidRequest, HostErrorCode::InvalidRequest.default_message());
                };
                dispatched_cmd.remove("confirmation");
                if let Some(confirmed_action) = ConfirmedPullRequestAction::from_action(parsed.action) {
                    confirm_redeem = Some(PullRequestConfirmRedeem {
                        thread_id: parsed.thread_id,
                        url: parsed.url,
                        action: confirmed_action,
                        method: parsed.method,
                        confirmation: parsed.confirmation,
                    });
                }
            }
            receipt.run(client, dispatched_cmd, confirm_redeem, wire).await
        }
        "receipt" => {
            // What became of one of this client's commands, as Node's socket server answers it. With an answer named,
            // the answer's own acceptance is read too, which outlives a restart; a client that takes `answer-receipts`
            // and is told it is not accepted yet is told once it is.
            let Some((command_id, answer)) = receipt_request(&req.fields) else {
                return HostResponseEnvelope::err(req.id, HostErrorCode::InvalidRequest, HostErrorCode::InvalidRequest.default_message());
            };
            let receipt = state.receipts.lock().unwrap().receipt(client_id, &command_id).map_or_else(unknown_receipt, |receipt| receipt.to_value());
            if let Some(target) = answer {
                match state.coordinator.accepted_answers(client_id.to_string(), vec![(command_id.clone(), target.clone())]).await {
                    Ok(accepted) if !accepted.is_empty() => {
                        wire.answer_watches.forget(&command_id);
                        return HostResponseEnvelope::ok(
                            req.id,
                            json!({ "status": "completed", "answerDelivered": true, "acceptedAnswer": target.accepted(&command_id) }),
                        );
                    }
                    Ok(_) => {}
                    Err(err) => return HostResponseEnvelope::err(req.id, err.code, err.message),
                }
                if wire.has("answer-receipts") {
                    wire.answer_watches.watch(&command_id, target);
                }
            }
            HostResponseEnvelope::ok(req.id, receipt)
        }
        "check-answer" => {
            // Whether a question this client holds an answer for still waits as it was asked, as Node's socket server
            // answers it: the request's shape, then the feature, then the client may answer, then the coordinator's own
            // check, then the session still holds and the client may still answer.
            let offered = offered_features(state, mode, client_id);
            let target = match checked_answer_check(&req.fields, |feature| offered.iter().any(|f| f == feature), may_answer) {
                Ok(target) => target,
                Err(code) => return HostResponseEnvelope::err(req.id, code, code.default_message()),
            };
            let client = ClientContext { client_id: client_id.to_string(), user: client_name.to_string(), may_answer };
            if let Err(err) = state.coordinator.check_request_answer(client, target).await {
                return HostResponseEnvelope::err(req.id, err.code, err.message);
            }
            // The provider's read may have outlasted this connection's session or the client's leave to answer.
            if state.pairing.lock().unwrap().verify_session(upgrade_session).as_deref() != Some(client_id) {
                return HostResponseEnvelope::err(req.id, HostErrorCode::Unauthenticated, HostErrorCode::Unauthenticated.default_message());
            }
            let may_answer = state.memory.lock().unwrap().may_grant_remote(client_id).unwrap_or(false);
            if !may_answer {
                return HostResponseEnvelope::err(req.id, HostErrorCode::Forbidden, HostErrorCode::Forbidden.default_message());
            }
            // Node answers with its plain `shell(peer)`, which moves neither the thread records nor the catalog a later
            // push or command answer is measured from.
            match state.coordinator.shell(may_answer).await {
                Ok(raw_shell) => HostResponseEnvelope::ok(req.id, wire.encode_plain_shell(raw_shell)),
                Err(err) => HostResponseEnvelope::err(req.id, err.code, err.message),
            }
        }
        "host-facts" => {
            let running = state
                .coordinator
                .running_threads_count()
                .await
                .unwrap_or(0);
            let facts = tokio::task::spawn_blocking(move || sotto_core::ops::host_facts(running))
                .await
                .unwrap_or_else(|_| json!({}));
            HostResponseEnvelope::ok(req.id, facts)
        }
        "host-folders" => {
            let req_obj = req.fields.get("request").and_then(Value::as_object);
            let requested: Option<Option<String>> = match req_obj.and_then(|r| r.get("path")) {
                Some(Value::Null) => Some(None),
                Some(Value::String(s)) => Some(Some(s.clone())),
                _ => None,
            };
            let fallback = state.data_directory.clone();
            match tokio::task::spawn_blocking(move || {
                let borrowed = requested.as_ref().map(|opt| opt.as_deref());
                sotto_core::ops::host_folders(borrowed, &fallback)
            })
            .await
            {
                Ok(val) => HostResponseEnvelope::ok(req.id, val),
                Err(_) => HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::Unavailable,
                    HostErrorCode::Unavailable.default_message(),
                ),
            }
        }
        "git-refs" => {
            let Some(r) = req.fields.get("request").and_then(Value::as_object) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let Some(tid) = r.get("threadId").and_then(Value::as_str) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let Ok(Some(ws)) = state.coordinator.thread_workspace(tid.to_string()).await else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::Unavailable,
                    "This thread is unavailable.",
                );
            };
            let query = r.get("query").and_then(Value::as_str).map(ToString::to_string);
            let cursor = r.get("cursor").and_then(Value::as_u64).map(|v| v as usize);
            let limit = r.get("limit").and_then(Value::as_u64).map(|v| v as usize);
            let include_matching_remote = r
                .get("includeMatchingRemoteRefs")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let folder = ws.working_directory;
            match tokio::task::spawn_blocking(move || {
                sotto_core::ops::git_refs(
                    &folder,
                    query.as_deref(),
                    cursor,
                    limit,
                    include_matching_remote,
                )
            })
            .await
            {
                Ok(Ok(val)) => HostResponseEnvelope::ok(req.id, val),
                _ => HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::Unavailable,
                    HostErrorCode::Unavailable.default_message(),
                ),
            }
        }
        "git-changed-files" => {
            let Some(tid) = req
                .fields
                .get("request")
                .and_then(|r| r.get("threadId"))
                .and_then(Value::as_str)
            else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let Ok(Some(ws)) = state.coordinator.thread_workspace(tid.to_string()).await else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::Unavailable,
                    "This thread is unavailable.",
                );
            };
            let folder = ws.working_directory;
            match tokio::task::spawn_blocking(move || sotto_core::ops::git_changed_files(&folder))
                .await
            {
                Ok(Ok(val)) => HostResponseEnvelope::ok(req.id, val),
                _ => HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::Unavailable,
                    HostErrorCode::Unavailable.default_message(),
                ),
            }
        }
        "git-pull-request" => {
            let parsed = req
                .fields
                .keys()
                .all(|k| k == "request")
                .then(|| GitPullRequestRequest::parse(req.fields.get("request")))
                .flatten();
            let Some(parsed) = parsed else {
                return HostResponseEnvelope::err(req.id, HostErrorCode::InvalidRequest, HostErrorCode::InvalidRequest.default_message());
            };
            if hides_thread(state, wire, &parsed.thread_id).await {
                return HostResponseEnvelope::err(req.id, HostErrorCode::Forbidden, HostErrorCode::Forbidden.default_message());
            }
            let thread_id = parsed.thread_id.clone();
            match state.coordinator.git_pull_request(parsed).await {
                Ok(mut val) => {
                    if let Some(obj) = val.as_object_mut() {
                        if !obj.contains_key("limited") {
                            let url = obj.get("url").and_then(Value::as_str).map(ToString::to_string);
                            let head_id = obj.get("headId").and_then(Value::as_str).map(ToString::to_string);
                            if let Some(url) = url {
                                if let Some(read_id) = state
                                    .pull_request_confirmations
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner())
                                    .read(client_id, &thread_id, &url, head_id.as_deref())
                                {
                                    obj.insert("readId".into(), Value::String(read_id));
                                }
                            }
                        }
                    }
                    HostResponseEnvelope::ok(req.id, val)
                }
                Err(err) => HostResponseEnvelope::err_with_reason(req.id, err.code, err.message, err.reason),
            }
        }
        "git-pull-request-list" => {
            let parsed = req
                .fields
                .keys()
                .all(|k| k == "request")
                .then(|| GitPullRequestListRequest::parse(req.fields.get("request")))
                .flatten();
            let Some(parsed) = parsed else {
                return HostResponseEnvelope::err(req.id, HostErrorCode::InvalidRequest, HostErrorCode::InvalidRequest.default_message());
            };
            if hides_thread(state, wire, &parsed.thread_id).await {
                return HostResponseEnvelope::err(req.id, HostErrorCode::Forbidden, HostErrorCode::Forbidden.default_message());
            }
            match state.coordinator.git_pull_request_list(parsed).await {
                Ok(val) => HostResponseEnvelope::ok(req.id, val),
                Err(err) => HostResponseEnvelope::err_with_reason(req.id, err.code, err.message, err.reason),
            }
        }
        "pull-request-confirmation" => {
            let parsed = req
                .fields
                .keys()
                .all(|k| k == "request")
                .then(|| PullRequestConfirmationRequest::parse(req.fields.get("request")))
                .flatten();
            let Some(parsed) = parsed else {
                return HostResponseEnvelope::err(req.id, HostErrorCode::InvalidRequest, HostErrorCode::InvalidRequest.default_message());
            };
            if hides_thread(state, wire, &parsed.thread_id).await {
                return HostResponseEnvelope::err(req.id, HostErrorCode::Forbidden, HostErrorCode::Forbidden.default_message());
            }
            if !offered_features(state, mode, client_id).iter().any(|f| f == "pull-request-confirmation") {
                return HostResponseEnvelope::err(req.id, HostErrorCode::InvalidRequest, HostErrorCode::InvalidRequest.default_message());
            }
            match state
                .pull_request_confirmations
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .issue(client_id, &parsed)
            {
                Ok(receipt) => HostResponseEnvelope::ok(req.id, receipt.to_json()),
                Err(message) => HostResponseEnvelope::err(req.id, HostErrorCode::Forbidden, message),
            }
        }
        "thread-files" => {
            let Some(r) = req.fields.get("request").and_then(Value::as_object) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let Some(tid) = r.get("threadId").and_then(Value::as_str) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let rel = r.get("path").and_then(Value::as_str).unwrap_or("").to_string();
            let req_ws_id = r.get("workspaceId").and_then(Value::as_str);
            if !rel.is_empty() && req_ws_id.is_none() {
                return HostResponseEnvelope::ok(
                    req.id,
                    sotto_core::ops::tools_err("invalid-request", "Refresh the workspace first."),
                );
            }
            let Ok(Some(ws)) = state.coordinator.thread_workspace(tid.to_string()).await else {
                return HostResponseEnvelope::ok(
                    req.id,
                    sotto_core::ops::tools_err("thread-unavailable", "This thread is unavailable."),
                );
            };
            if let Some(expected_ws) = req_ws_id {
                if expected_ws != ws.workspace_id {
                    return HostResponseEnvelope::ok(
                        req.id,
                        sotto_core::ops::tools_err(
                            "workspace-changed",
                            "This thread's working folder changed. Refresh and try again.",
                        ),
                    );
                }
            }
            let res = tokio::task::spawn_blocking(move || sotto_core::ops::thread_files(&ws, &rel))
                .await
                .unwrap_or_else(|_| sotto_core::ops::tools_err("unavailable", "Could not read files."));
            HostResponseEnvelope::ok(req.id, res)
        }
        "thread-file-preview" => {
            let Some(r) = req.fields.get("request").and_then(Value::as_object) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let (Some(tid), Some(rel), Some(expected_ws)) = (
                r.get("threadId").and_then(Value::as_str),
                r.get("path").and_then(Value::as_str),
                r.get("workspaceId").and_then(Value::as_str),
            ) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let Ok(Some(ws)) = state.coordinator.thread_workspace(tid.to_string()).await else {
                return HostResponseEnvelope::ok(
                    req.id,
                    sotto_core::ops::tools_err("thread-unavailable", "This thread is unavailable."),
                );
            };
            if expected_ws != ws.workspace_id {
                return HostResponseEnvelope::ok(
                    req.id,
                    sotto_core::ops::tools_err(
                        "workspace-changed",
                        "This thread's working folder changed. Refresh and try again.",
                    ),
                );
            }
            let rel_owned = rel.to_string();
            let res = tokio::task::spawn_blocking(move || {
                sotto_core::ops::thread_file_preview(&ws, &rel_owned)
            })
            .await
            .unwrap_or_else(|_| sotto_core::ops::tools_err("unavailable", "Could not preview file."));
            HostResponseEnvelope::ok(req.id, res)
        }
        // A Markdown file a thread's message links to, for the side panel (ADR-0120, November 3 amendment), and where a
        // linked file is, its preview or one 4 MiB part of it for a download (November 12 amendment), as Node's host
        // answers them. As Node: the request's shape first, then a thread the client may not see, then whether it was
        // offered the read. Node reads one of these at a time per socket; this host answers a socket's requests in turn,
        // so it never has two.
        "thread-file-link" | "thread-linked-file" => {
            let op = req.op.as_str();
            let checked = offered_thread_read(state, mode, client_id, wire, &req.fields, |value| {
                sotto_core::linked_files::link_request(op, value)
            })
            .await;
            let request = match checked {
                Ok(request) => request,
                Err(code) => return HostResponseEnvelope::err(req.id, code, code.default_message()),
            };
            let Ok(workspace) = state.coordinator.thread_workspace(request.thread_id.clone()).await else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::Unavailable,
                    HostErrorCode::Unavailable.default_message(),
                );
            };
            let read =
                tokio::task::spawn_blocking(move || sotto_core::linked_files::read_link(workspace.as_ref(), &request)).await;
            match read {
                Ok(answer) => HostResponseEnvelope::ok(req.id, answer),
                // A read that failed outright is the host's failure to read, as Node's `toolRead` answers it.
                Err(_) => HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::Unavailable,
                    HostErrorCode::Unavailable.default_message(),
                ),
            }
        }
        // A picture, or one 8 MiB part of a video, that a thread's activity record names (ADR-0170), read from Node's
        // thread media store in this data folder as Node's host answers it. Node reads one of these at a time per
        // socket; this host answers a socket's requests in turn, so it never has two.
        "thread-media" | "thread-media-part" => {
            let op = req.op.as_str();
            let checked = offered_thread_read(state, mode, client_id, wire, &req.fields, |value| {
                sotto_core::thread_media::media_request(op, value)
            })
            .await;
            let request = match checked {
                Ok(request) => request,
                Err(code) => return HostResponseEnvelope::err(req.id, code, code.default_message()),
            };
            // The record as a pane is sent it, of a thread this host holds: only a handle it carries is read, and a thread
            // it does not hold, whatever rows its store keeps, names nothing.
            let record = match state.coordinator.thread_activity(request.thread_id.clone(), request.activity_id.clone()).await {
                Ok(record) => record,
                Err(err) => return HostResponseEnvelope::err(req.id, err.code, err.message),
            };
            let data = state.data_directory.clone();
            let read = tokio::task::spawn_blocking(move || {
                sotto_core::thread_media::read_media(&data, record.as_ref(), &request)
            })
            .await;
            match read {
                Ok(Ok(answer)) => HostResponseEnvelope::ok(req.id, answer),
                // A picture the store keeps but could not be read is the host's failure, as Node's read throws it.
                _ => HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::Unavailable,
                    HostErrorCode::Unavailable.default_message(),
                ),
            }
        }
        "thread-changes" => {
            let Some(r) = req.fields.get("request").and_then(Value::as_object) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let Some(tid) = r.get("threadId").and_then(Value::as_str) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let req_ws_id = r.get("workspaceId").and_then(Value::as_str);
            let Ok(Some(ws)) = state.coordinator.thread_workspace(tid.to_string()).await else {
                return HostResponseEnvelope::ok(
                    req.id,
                    sotto_core::ops::tools_err("thread-unavailable", "This thread is unavailable."),
                );
            };
            if let Some(expected_ws) = req_ws_id {
                if expected_ws != ws.workspace_id {
                    return HostResponseEnvelope::ok(
                        req.id,
                        sotto_core::ops::tools_err(
                            "workspace-changed",
                            "This thread's working folder changed. Refresh and try again.",
                        ),
                    );
                }
            }
            let res = tokio::task::spawn_blocking(move || sotto_core::ops::thread_changes(&ws))
                .await
                .unwrap_or_else(|_| sotto_core::ops::tools_err("unavailable", "Could not read changes."));
            HostResponseEnvelope::ok(req.id, res)
        }
        "thread-changes-review" => {
            let Some(r) = req.fields.get("request").and_then(Value::as_object) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let (Some(tid), Some(expected_ws)) = (
                r.get("threadId").and_then(Value::as_str),
                r.get("workspaceId").and_then(Value::as_str),
            ) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let scope = r
                .get("scope")
                .cloned()
                .unwrap_or_else(|| json!({ "kind": "working" }));
            let ignore_whitespace = r
                .get("ignoreWhitespace")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let Ok(Some(ws)) = state.coordinator.thread_workspace(tid.to_string()).await else {
                return HostResponseEnvelope::ok(
                    req.id,
                    sotto_core::ops::tools_err("thread-unavailable", "This thread is unavailable."),
                );
            };
            if expected_ws != ws.workspace_id {
                return HostResponseEnvelope::ok(
                    req.id,
                    sotto_core::ops::tools_err(
                        "workspace-changed",
                        "This thread's working folder changed. Refresh and try again.",
                    ),
                );
            }
            let res = tokio::task::spawn_blocking(move || {
                sotto_core::ops::thread_changes_review(&ws, &scope, ignore_whitespace)
            })
            .await
            .unwrap_or_else(|_| sotto_core::ops::tools_err("unavailable", "Could not read review."));
            HostResponseEnvelope::ok(req.id, res)
        }
        "activity-body" => {
            // One record whole, for the row a desktop opened (ADR-0025, October 18 amendment), as Node's host answers it.
            // As Node: the request's shape first, then a thread the client may not see, then whether it takes cut bodies.
            let Some((thread_id, activity_id)) = thread_read_ids(&req.fields, "activityId") else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            if hides_thread(state, wire, &thread_id).await {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::Forbidden,
                    HostErrorCode::Forbidden.default_message(),
                );
            }
            if !wire.takes_cut_bodies() {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            }
            // Of a thread this host holds, as Node's `threadActivity`: a thread it does not hold has no record.
            let record = match state.coordinator.thread_activity(thread_id, activity_id).await {
                Ok(record) => record.as_ref().map(sotto_core::activity_bodies::strip_agent_steps),
                Err(err) => return HostResponseEnvelope::err(req.id, err.code, err.message),
            };
            HostResponseEnvelope::ok(req.id, record.unwrap_or(Value::Null))
        }
        "thread-prompts" => {
            // The prompts above a pane's window for the message scrubber (ADR-0109), as Node's host answers them.
            // Offered to a desktop alone (`HOST_DESKTOP_FEATURES`), and its request is refused for any other client.
            let recorded = state.desktops.lock().unwrap().has(client_id);
            let ids = thread_read_ids(&req.fields, "beforeMessageId");
            // As Node: a thread the client may not see is refused before whether it is offered the read.
            if let Some((thread_id, _)) = &ids {
                if hides_thread(state, wire, thread_id).await {
                    return HostResponseEnvelope::err(
                        req.id,
                        HostErrorCode::Forbidden,
                        HostErrorCode::Forbidden.default_message(),
                    );
                }
            }
            let Some((thread_id, before)) = ids.filter(|_| desktop_on_listener(mode, recorded)) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let provider = match state.coordinator.thread_provider(thread_id.clone()).await {
                Ok(provider) => provider,
                Err(err) => return HostResponseEnvelope::err(req.id, err.code, err.message),
            };
            // A thread the host does not hold has no prompts it can say; one of a provider this client does not know is
            // not this client's to read.
            let Some(provider) = provider else {
                return HostResponseEnvelope::ok(req.id, Value::Null);
            };
            if wire.hides_provider(&provider) {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::Forbidden,
                    HostErrorCode::Forbidden.default_message(),
                );
            }
            let dir = state.data_directory.clone();
            let prompts = tokio::task::spawn_blocking(move || sotto_core::ops::thread_prompts(&dir, &thread_id, &before))
                .await
                .ok()
                .flatten();
            HostResponseEnvelope::ok(req.id, prompts.unwrap_or(Value::Null))
        }
        "thread-words" => {
            let Some(query) = req
                .fields
                .get("query")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|q| !q.is_empty())
                .map(ToString::to_string)
            else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let dir = state.data_directory.clone();
            let res = tokio::task::spawn_blocking(move || {
                sotto_core::ops::search_thread_words(&dir, &query)
            })
            .await
            .unwrap_or_else(|_| json!({ "found": [] }));
            HostResponseEnvelope::ok(req.id, res)
        }
        "subagent-page" => {
            let Some(r) = req.fields.get("request").and_then(Value::as_object) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let Some(tid) = r
                .get("threadId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(ToString::to_string)
            else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let before = match r.get("before") {
                None | Some(Value::Null) => None,
                Some(v) => match v.as_i64() {
                    Some(n) if n > 0 => Some(n),
                    _ => {
                        return HostResponseEnvelope::err(
                            req.id,
                            HostErrorCode::InvalidRequest,
                            HostErrorCode::InvalidRequest.default_message(),
                        );
                    }
                },
            };
            let dir = state.data_directory.clone();
            let tid_fallback = tid.clone();
            let res = tokio::task::spawn_blocking(move || {
                sotto_core::ops::read_subagent_page(&dir, &tid, before)
            })
            .await
            .unwrap_or_else(|_| {
                json!({
                    "threadId": tid_fallback,
                    "revision": 0,
                    "rows": [],
                    "summary": { "total": 0, "working": 0, "completed": 0, "failed": 0, "interrupted": 0, "unknown": 0 }
                })
            });
            HostResponseEnvelope::ok(req.id, res)
        }
        "subagent-assignments" => {
            let Some(r) = req.fields.get("request").and_then(Value::as_object) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let (Some(tid), Some(aid)) = (
                r.get("threadId")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(ToString::to_string),
                r.get("agentId")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(ToString::to_string),
            ) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let before = match r.get("before") {
                None | Some(Value::Null) => None,
                Some(v) => match v.as_i64() {
                    Some(n) if n > 0 => Some(n),
                    _ => {
                        return HostResponseEnvelope::err(
                            req.id,
                            HostErrorCode::InvalidRequest,
                            HostErrorCode::InvalidRequest.default_message(),
                        );
                    }
                },
            };
            let dir = state.data_directory.clone();
            let tid_fallback = tid.clone();
            let aid_fallback = aid.clone();
            let res = tokio::task::spawn_blocking(move || {
                sotto_core::ops::read_subagent_assignments(&dir, &tid, &aid, before)
            })
            .await
            .unwrap_or_else(|_| {
                json!({
                    "threadId": tid_fallback,
                    "agentId": aid_fallback,
                    "assignments": [],
                })
            });
            HostResponseEnvelope::ok(req.id, res)
        }
        "usage-read" => {
            let q = req.fields.get("query").and_then(Value::as_object);
            let time_zone = q
                .and_then(|o| o.get("timeZone"))
                .and_then(Value::as_str)
                .map(ToString::to_string);
            if let Some(ref tz) = time_zone {
                if sotto_core::ops::parse_usage_time_zone(Some(tz.as_str())).is_err() {
                    return HostResponseEnvelope::err(
                        req.id,
                        HostErrorCode::InvalidRequest,
                        HostErrorCode::InvalidRequest.default_message(),
                    );
                }
            }
            let from = q
                .and_then(|o| o.get("from"))
                .and_then(Value::as_str)
                .map(ToString::to_string);
            let to = q
                .and_then(|o| o.get("to"))
                .and_then(Value::as_str)
                .map(ToString::to_string);
            if let (Some(ref f), Some(ref t)) = (&from, &to) {
                if f > t {
                    return HostResponseEnvelope::err(
                        req.id,
                        HostErrorCode::InvalidRequest,
                        HostErrorCode::InvalidRequest.default_message(),
                    );
                }
            }
            let parse_str_list = |key: &str| -> Option<Vec<String>> {
                q.and_then(|o| o.get(key))
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(Value::as_str)
                            .map(ToString::to_string)
                            .collect()
                    })
            };
            let accepts_history = wire.has("usage-history");
            let accepts_muse_opencode = wire.has("usage-muse-opencode");
            let accepts_antigravity = wire.has("usage-antigravity");
            let mut provider_ids = parse_str_list("providerIds");
            if !accepts_muse_opencode {
                let allowed = sotto_core::usage_ops::USAGE_PROVIDERS_BEFORE_MUSE;
                provider_ids = Some(match provider_ids {
                    Some(list) => list.into_iter().filter(|p| allowed.contains(&p.as_str())).collect(),
                    None => allowed.iter().map(|&s| s.to_string()).collect(),
                });
            } else if !accepts_antigravity {
                let allowed = sotto_core::usage_ops::USAGE_PROVIDERS_BEFORE_ANTIGRAVITY;
                provider_ids = Some(match provider_ids {
                    Some(list) => list.into_iter().filter(|p| allowed.contains(&p.as_str())).collect(),
                    None => allowed.iter().map(|&s| s.to_string()).collect(),
                });
            }
            let query = sotto_core::ops::UsageReadQuery {
                from,
                to,
                time_zone,
                provider_ids,
                model_ids: parse_str_list("modelIds"),
                include_daily: q.and_then(|o| o.get("includeDaily")).and_then(Value::as_bool),
                sources: if accepts_history {
                    parse_str_list("sources")
                } else {
                    None
                },
                since: if accepts_history {
                    q.and_then(|o| o.get("since"))
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                } else {
                    None
                },
            };
            let connected = state
                .coordinator
                .connected_providers()
                .await
                .unwrap_or_default();
            let dir = state.data_directory.clone();
            let raw = tokio::task::spawn_blocking(move || {
                sotto_core::ops::usage_read(&dir, &query, &connected)
            })
            .await
            .unwrap_or_else(|_| json!({ "status": "error", "quotas": [] }));
            let filtered = sotto_core::ops::filter_usage_read_for_peer(
                raw,
                accepts_history,
                accepts_muse_opencode,
                accepts_antigravity,
            );
            HostResponseEnvelope::ok(req.id, filtered)
        }
        "usage-refresh" => {
            let accepts_history = wire.has("usage-history");
            let accepts_muse_opencode = wire.has("usage-muse-opencode");
            let accepts_antigravity = wire.has("usage-antigravity");
            let provider_ids: Option<Vec<String>> = req
                .fields
                .get("providerIds")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(ToString::to_string)
                        .collect()
                });
            let connected = state
                .coordinator
                .connected_providers()
                .await
                .unwrap_or_default();
            let raw = sotto_core::ops::usage_refresh(provider_ids.as_deref(), &connected);
            let filtered = sotto_core::ops::filter_usage_read_for_peer(
                raw,
                accepts_history,
                accepts_muse_opencode,
                accepts_antigravity,
            );
            HostResponseEnvelope::ok(req.id, filtered)
        }
        "watcher-control" => {
            let is_desktop = {
                let mut desktops = state.desktops.lock().unwrap();
                desktops.refresh();
                desktops.has(client_id)
            };
            if !is_desktop {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::Forbidden,
                    HostErrorCode::Forbidden.default_message(),
                );
            }
            if !wire.hello_done {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            }
            let Some(request_val) = req.fields.get("request").cloned() else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            // Reject swarm starts since this host does not advertise `worker-swarms`.
            if request_val.get("call").and_then(|c| c.get("name")).and_then(Value::as_str)
                == Some("start_thread")
            {
                let input = request_val.get("call").and_then(|c| c.get("input"));
                if input.and_then(|i| i.get("count")).is_some()
                    || input.and_then(|i| i.get("prompts")).is_some()
                {
                    return HostResponseEnvelope::err(
                        req.id,
                        HostErrorCode::InvalidRequest,
                        HostErrorCode::InvalidRequest.default_message(),
                    );
                }
            }
            let result = state
                .watcher
                .admit_remote(request_val, client_id, client_name, may_answer)
                .await;
            HostResponseEnvelope::ok(req.id, result)
        }
        "watcher-read" => {
            let is_desktop = {
                let mut desktops = state.desktops.lock().unwrap();
                desktops.refresh();
                desktops.has(client_id)
            };
            if !is_desktop {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::Forbidden,
                    HostErrorCode::Forbidden.default_message(),
                );
            }
            if !wire.hello_done {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            }
            let Some(request_val) = req.fields.get("request").cloned() else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let parsed_scope = parse_watcher_host_read(&request_val)
                .ok()
                .filter(|r| r.call.is_none());
            let result = state
                .watcher
                .read_remote(request_val, client_id, may_answer)
                .await;
            if let Some(scope_req) = parsed_scope {
                if result.get("status").and_then(Value::as_str) != Some("refused") {
                    if wire.has("watcher-reads") {
                        watcher_peer.scope = Some(scope_req.master);
                    }
                    if let Ok(proj) = serde_json::from_value::<WatcherHostProjection>(result.clone()) {
                        watcher_peer.record_written(&proj, wire.has("watcher-progress"));
                    }
                }
            }
            HostResponseEnvelope::ok(req.id, result)
        }
        "project-origins" => {
            if !req.fields.is_empty() || !wire.hello_done {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            }
            if !offered_features(state, mode, client_id).iter().any(|f| f == "project-origins") {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            }
            let projects = match state.coordinator.projects_for_origins().await {
                Ok(list) => list
                    .into_iter()
                    .filter(|(_, _, provider)| provider.as_deref().is_none_or(|p| !wire.hides_provider(p)))
                    .map(|(id, path, _)| (id, path))
                    .collect::<Vec<_>>(),
                Err(err) => return HostResponseEnvelope::err(req.id, err.code, err.message),
            };
            match tokio::task::spawn_blocking(move || sotto_core::ops::project_origins(&projects))
                .await
            {
                Ok(val) => HostResponseEnvelope::ok(req.id, val),
                Err(_) => HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::Unavailable,
                    HostErrorCode::Unavailable.default_message(),
                ),
            }
        }
        "project-setup" => {
            let parsed = req
                .fields
                .keys()
                .all(|k| k == "request")
                .then(|| sotto_core::project_setup::ProjectSetupRequest::parse(req.fields.get("request")))
                .flatten();
            let Some(parsed) = parsed else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            if !wire.hello_done || !offered_features(state, mode, client_id).iter().any(|f| f == "project-setup") {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            }
            let (projects_directory, project_paths, own_folder) = match state.coordinator.project_setup_context().await {
                Ok(ctx) => ctx,
                Err(err) => return HostResponseEnvelope::err(req.id, err.code, err.message),
            };
            let home = std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(PathBuf::from)
                .unwrap_or_else(|| own_folder.clone());
            let context = sotto_core::project_setup::ProjectSetupContext {
                projects_directory,
                project_paths,
                home,
                own_folder: Some(own_folder),
            };
            let coordinator = state.coordinator.clone();
            let result = state
                .project_copies
                .set_up(parsed, context, move |title, path| async move {
                    coordinator.add_project_for_setup(title, path).await
                })
                .await;
            HostResponseEnvelope::ok(req.id, result.to_json())
        }
        "usage-clear" => {
            if !may_answer {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::Forbidden,
                    HostErrorCode::Forbidden.default_message(),
                );
            }
            let Some(expected_rev) = req
                .fields
                .get("request")
                .and_then(|r| r.get("expectedRevision"))
                .and_then(Value::as_i64)
                .filter(|&v| v >= 0)
            else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let dir = state.data_directory.clone();
            match tokio::task::spawn_blocking(move || {
                sotto_core::ops::usage_clear(&dir, expected_rev)
            })
            .await
            {
                Ok(Ok(res)) => HostResponseEnvelope::ok(req.id, res),
                _ => HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::Unavailable,
                    HostErrorCode::Unavailable.default_message(),
                ),
            }
        }
        _ => HostResponseEnvelope::err(
            req.id,
            HostErrorCode::InvalidRequest,
            HostErrorCode::InvalidRequest.default_message(),
        ),
    }
}

fn is_allowed_origin(origin: Option<&str>) -> bool {
    let Some(raw) = origin else {
        return true;
    };
    let rest = raw
        .strip_prefix("http://")
        .or_else(|| raw.strip_prefix("https://"));
    let Some(host_port) = rest else {
        return false;
    };
    if host_port.contains('/') || host_port.contains('@') || host_port.contains('?') {
        return false;
    }
    let host = if let Some(after_bracket) = host_port.strip_prefix('[') {
        let Some((ipv6, tail)) = after_bracket.split_once(']') else {
            return false;
        };
        if !tail.is_empty() && !tail.strip_prefix(':').is_some_and(|p| p.parse::<u16>().is_ok()) {
            return false;
        }
        ipv6
    } else if let Some((h, p)) = host_port.split_once(':') {
        if p.parse::<u16>().is_err() {
            return false;
        }
        h
    } else {
        host_port
    };
    host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1"
}

fn extract_bearer(headers: &HashMap<String, String>) -> &str {
    headers
        .get("authorization")
        .and_then(|value| {
            value
                .strip_prefix("Bearer ")
                .or_else(|| value.strip_prefix("bearer "))
        })
        .map(str::trim)
        .unwrap_or("")
}

async fn send_http_json(stream: &mut TcpStream, status: u16, body: &Value) -> std::io::Result<()> {
    let payload = serde_json::to_vec(body).map_err(std::io::Error::other)?;
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        409 => "Conflict",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        _ => "Service Unavailable",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        payload.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(&payload).await?;
    stream.flush().await
}

async fn send_http_error(
    stream: &mut TcpStream,
    code: HostErrorCode,
    message: Option<&str>,
) -> std::io::Result<()> {
    let body = json!({
        "v": HOST_PROTOCOL_VERSION,
        "error": {
            "code": code,
            "message": message.unwrap_or_else(|| code.default_message()),
        }
    });
    send_http_json(stream, code.http_status(), &body).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The parser of a link read's request.
    fn link(op: &'static str) -> impl FnOnce(Option<&Value>) -> Option<LinkRequest> {
        move |value: Option<&Value>| sotto_core::linked_files::link_request(op, value)
    }

    /// The parser of a media read's request.
    fn media(op: &'static str) -> impl FnOnce(Option<&Value>) -> Option<MediaRequest> {
        move |value: Option<&Value>| sotto_core::thread_media::media_request(op, value)
    }

    /// A link read is refused as Node's socket server refuses it, and in its order: a malformed request before the thread
    /// is looked at, a hidden provider's thread before whether the read is offered, and then a read not offered.
    #[tokio::test]
    async fn a_link_read_is_checked_in_nodes_order() {
        use sotto_core::linked_files::{LinkRead, LinkedWant};
        use std::cell::Cell;
        let fields = |value: Value| value.as_object().unwrap().clone();
        let good = json!({ "request": { "threadId": "t", "path": "notes.md", "want": "place" } });
        let asked = Cell::new(false);
        let hidden = |answer: bool| {
            let asked = &asked;
            move |_: String| {
                asked.set(true);
                async move { answer }
            }
        };

        let malformed = fields(json!({ "request": { "threadId": "t" } }));
        assert_eq!(checked_thread_read(&malformed, link("thread-linked-file"), hidden(true), |_| true).await, Err(HostErrorCode::InvalidRequest));
        let extra = fields(json!({ "request": { "threadId": "t", "path": "notes.md" }, "more": 1 }));
        assert_eq!(checked_thread_read(&extra, link("thread-file-link"), hidden(true), |_| true).await, Err(HostErrorCode::InvalidRequest));
        assert!(!asked.get(), "a malformed request is refused before its thread is looked at");

        assert_eq!(checked_thread_read(&fields(good.clone()), link("thread-linked-file"), hidden(true), |_| false).await, Err(HostErrorCode::Forbidden));
        assert!(asked.get());
        let mut named = None;
        let refused = checked_thread_read(&fields(good.clone()), link("thread-linked-file"), hidden(false), |feature: &str| {
            named = Some(feature.to_string());
            false
        })
        .await;
        assert_eq!(refused, Err(HostErrorCode::InvalidRequest));
        assert_eq!(named.as_deref(), Some("thread-linked-files"));

        let request = checked_thread_read(&fields(good), link("thread-linked-file"), hidden(false), |feature| feature == "thread-linked-files").await.unwrap();
        assert_eq!(request.read, LinkRead::LinkedFile(LinkedWant::Place));
        let markdown = fields(json!({ "request": { "threadId": "t", "path": "notes.md" } }));
        assert!(checked_thread_read(&markdown, link("thread-file-link"), hidden(false), |feature| feature == "thread-file-links").await.is_ok());
    }

    /// A media read is refused as Node's socket server refuses it, and in its order: a malformed request before the thread
    /// is looked at, a hidden provider's thread before whether the read is offered, then a read not offered, and then a
    /// picture at an edge, which no client of this host accepted.
    #[tokio::test]
    async fn a_media_read_is_checked_in_nodes_order() {
        use sotto_core::thread_media::MediaRead;
        use std::cell::Cell;
        let fields = |value: Value| value.as_object().unwrap().clone();
        let picture = json!({ "request": { "threadId": "t", "activityId": "a", "mediaId": "m0" } });
        let part = json!({ "request": { "threadId": "t", "activityId": "a", "mediaId": "m0", "part": 1 } });
        let asked = Cell::new(false);
        let hidden = |answer: bool| {
            let asked = &asked;
            move |_: String| {
                asked.set(true);
                async move { answer }
            }
        };

        for malformed in [
            json!({ "request": { "threadId": "t", "activityId": "a" } }),
            json!({ "request": { "threadId": "t", "activityId": "a", "mediaId": "m9" } }),
            json!({ "request": { "threadId": "t", "activityId": "a", "mediaId": "m0", "edge": 100 } }),
            json!({ "request": { "threadId": "t", "activityId": "a", "mediaId": "m0" }, "more": 1 }),
        ] {
            assert_eq!(checked_thread_read(&fields(malformed), media("thread-media"), hidden(true), |_| true).await, Err(HostErrorCode::InvalidRequest));
        }
        let past = json!({ "request": { "threadId": "t", "activityId": "a", "mediaId": "m0", "part": 25 } });
        assert_eq!(checked_thread_read(&fields(past), media("thread-media-part"), hidden(true), |_| true).await, Err(HostErrorCode::InvalidRequest));
        assert!(!asked.get(), "a malformed request is refused before its thread is looked at");

        assert_eq!(checked_thread_read(&fields(part.clone()), media("thread-media-part"), hidden(true), |_| false).await, Err(HostErrorCode::Forbidden));
        assert!(asked.get());
        let mut named = None;
        let refused = checked_thread_read(&fields(part.clone()), media("thread-media-part"), hidden(false), |feature: &str| {
            named = Some(feature.to_string());
            false
        })
        .await;
        assert_eq!(refused, Err(HostErrorCode::InvalidRequest));
        assert_eq!(named.as_deref(), Some("thread-media-video"));
        let edge = json!({ "request": { "threadId": "t", "activityId": "a", "mediaId": "m0", "edge": 640 } });
        assert_eq!(checked_thread_read(&fields(edge.clone()), media("thread-media"), hidden(true), |_| true).await, Err(HostErrorCode::Forbidden));
        assert_eq!(checked_thread_read(&fields(edge), media("thread-media"), hidden(false), |_| true).await, Err(HostErrorCode::InvalidRequest));

        let request = checked_thread_read(&fields(part), media("thread-media-part"), hidden(false), |feature| feature == "thread-media-video").await.unwrap();
        assert_eq!(request.read, MediaRead::VideoPart(1));
        let request = checked_thread_read(&fields(picture), media("thread-media"), hidden(false), |feature| feature == "thread-media").await.unwrap();
        assert_eq!(request.read, MediaRead::Picture);
    }

    /// Both media features are offered to every client, as Node offers them, a phone on a tailnet listener too, and
    /// picture edges to none.
    #[test]
    fn media_is_offered_to_every_client_without_picture_edges() {
        let all = advertised_features();
        // A desktop and a client on loopback, where every client counts as a desktop (`desktop_on_listener`), and a phone
        // on a tailnet listener, which does not.
        assert!(desktop_on_listener(&ListenerMode::Admin, false));
        for (desktop, on_listener) in [(true, true), (false, true), (false, false)] {
            let offered = features_for_client(&all, desktop, on_listener);
            assert!(offered.iter().any(|f| f == "thread-media") && offered.iter().any(|f| f == "thread-media-video"));
            assert!(!offered.iter().any(|f| f == "thread-media-edge"));
        }
    }

    /// A preview is refused as Node's socket server refuses it, and in its order: a malformed request before the thread is
    /// looked at, a hidden provider's thread before anything else, and then an edge, which no client of this host accepted.
    /// No feature is asked of a preview: every host answers one.
    #[tokio::test]
    async fn a_preview_is_checked_in_nodes_order() {
        use std::cell::Cell;
        let fields = |value: Value| value.as_object().unwrap().clone();
        let parse = sotto_core::attachment_previews::preview_request;
        let good = json!({ "request": { "threadId": "t", "messageId": "m", "attachmentId": "a" } });
        let edge = json!({ "request": { "threadId": "t", "messageId": "m", "attachmentId": "a", "edge": 640 } });
        let asked = Cell::new(false);
        let hidden = |answer: bool| {
            let asked = &asked;
            move |_: String| {
                asked.set(true);
                async move { answer }
            }
        };
        for malformed in [
            json!({ "request": { "threadId": "t", "messageId": "m" } }),
            json!({ "request": { "threadId": "t", "messageId": "m", "attachmentId": "a", "edge": 500 } }),
            json!({ "request": { "threadId": "t", "messageId": "m", "attachmentId": "a", "part": 0 } }),
            json!({ "request": { "threadId": "t", "messageId": "m", "attachmentId": "a" }, "more": 1 }),
        ] {
            assert_eq!(checked_thread_read(&fields(malformed), parse, hidden(true), |_| true).await, Err(HostErrorCode::InvalidRequest));
        }
        assert!(!asked.get(), "a malformed request is refused before its thread is looked at");
        assert_eq!(checked_thread_read(&fields(edge.clone()), parse, hidden(true), |_| true).await, Err(HostErrorCode::Forbidden));
        assert!(asked.get());
        assert_eq!(checked_thread_read(&fields(edge), parse, hidden(false), |_| true).await, Err(HostErrorCode::InvalidRequest));
        let mut named = None;
        let request = checked_thread_read(&fields(good), parse, hidden(false), |feature: &str| {
            named = Some(feature.to_string());
            false
        })
        .await
        .unwrap();
        assert_eq!(named, None, "a preview needs no feature");
        assert_eq!((request.message_id.as_str(), request.attachment_id.as_str(), request.edge), ("m", "a", false));
    }

    /// A sent file's part is refused as Node's socket server refuses it, and in its order: a malformed request before the
    /// thread is looked at, a hidden provider's thread before whether the read is offered, then a read not offered.
    #[tokio::test]
    async fn an_attachment_file_read_is_checked_in_nodes_order() {
        use std::cell::Cell;
        let fields = |value: Value| value.as_object().unwrap().clone();
        let parse = sotto_core::attachment_files::attachment_file_request;
        let good = json!({ "request": { "threadId": "t", "messageId": "m", "attachmentId": "a", "part": 0 } });
        let asked = Cell::new(false);
        let hidden = |answer: bool| {
            let asked = &asked;
            move |_: String| {
                asked.set(true);
                async move { answer }
            }
        };

        for malformed in [
            json!({ "request": { "threadId": "t", "messageId": "m", "attachmentId": "a" } }),
            json!({ "request": { "threadId": "t", "messageId": "m", "attachmentId": "a", "part": 4 } }),
            json!({ "request": { "threadId": "t", "messageId": "m", "attachmentId": "a", "part": 0, "digest": "d" } }),
            json!({ "request": { "threadId": "t", "messageId": "m", "attachmentId": "a", "part": 0 }, "more": 1 }),
        ] {
            assert_eq!(checked_thread_read(&fields(malformed), parse, hidden(true), |_| true).await, Err(HostErrorCode::InvalidRequest));
        }
        assert!(!asked.get(), "a malformed request is refused before its thread is looked at");

        assert_eq!(checked_thread_read(&fields(good.clone()), parse, hidden(true), |_| false).await, Err(HostErrorCode::Forbidden));
        assert!(asked.get());
        let mut named = None;
        let refused = checked_thread_read(&fields(good.clone()), parse, hidden(false), |feature: &str| {
            named = Some(feature.to_string());
            false
        })
        .await;
        assert_eq!(refused, Err(HostErrorCode::InvalidRequest));
        assert_eq!(named.as_deref(), Some("attachment-files"));
        let request = checked_thread_read(&fields(good), parse, hidden(false), |feature| feature == "attachment-files").await.unwrap();
        assert_eq!((request.message_id.as_str(), request.attachment_id.as_str(), request.part), ("m", "a", 0));
    }

    /// A file part is refused in Node's order: a malformed part, then a host that does not offer file staging, then a
    /// video larger than a file from a client it does not offer video staging, in Node's words.
    #[test]
    fn a_file_part_is_checked_in_nodes_order() {
        let fields = |value: Value| value.as_object().unwrap().clone();
        let part = |mime: &str, size: u64, count: u64| {
            json!({ "part": { "uploadId": "3f0c8a52-6c1e-4f5d-9b7a-2d4e6f8a0b1c", "index": 0, "count": count, "name": "clip",
                "mimeType": mime, "sizeBytes": size, "digest": "a".repeat(64), "data": "cHJvYmU=" } })
        };
        let invalid = (HostErrorCode::InvalidRequest, HostErrorCode::InvalidRequest.default_message());
        let large = part("video/mp4", 30 * 1024 * 1024, 4);
        let mut extra = large.clone();
        extra["more"] = json!(1);
        assert_eq!(checked_file_part(&fields(extra), |_| true), Err(invalid));
        assert_eq!(checked_file_part(&fields(part("text/plain", 30 * 1024 * 1024, 4)), |_| true), Err(invalid), "only a video may be larger than a file");
        assert_eq!(checked_file_part(&fields(large.clone()), |_| false), Err(invalid), "file staging is asked of first");
        let staging = |feature: &str| feature == "file-staging";
        assert_eq!(checked_file_part(&fields(large.clone()), staging), Err((HostErrorCode::InvalidRequest, HOST_CANNOT_STAGE_VIDEOS)));
        assert_eq!(checked_file_part(&fields(part("video/mp4", 5, 5)), staging), Err((HostErrorCode::InvalidRequest, HOST_CANNOT_STAGE_VIDEOS)));
        assert!(checked_file_part(&fields(part("video/mp4", 5, 1)), staging).is_ok(), "a video no larger than a file needs no video staging");
        assert!(checked_file_part(&fields(large), |feature| feature == "file-staging" || feature == "video-staging").unwrap().is_large_video());

        let upload = json!({ "uploadId": "3f0c8a52-6c1e-4f5d-9b7a-2d4e6f8a0b1c" });
        assert_eq!(checked_upload_progress(&fields(json!({ "uploadId": "x" })), |_| false), Err(HostErrorCode::InvalidRequest));
        assert_eq!(checked_upload_progress(&fields(upload.clone()), |feature| feature == "file-staging"), Err(HostErrorCode::InvalidRequest));
        assert!(checked_upload_progress(&fields(upload), |feature| feature == "video-staging").is_ok());
    }

    /// Video staging and sent files go with file staging to every client, as Node offers them, a phone on a tailnet
    /// listener too.
    #[test]
    fn file_staging_features_are_offered_to_every_client() {
        let all = advertised_features();
        for (desktop, on_listener) in [(true, true), (false, true), (false, false)] {
            let offered = features_for_client(&all, desktop, on_listener);
            for feature in ["file-staging", "video-staging", "attachment-files"] {
                assert!(offered.iter().any(|f| f == feature), "{feature} to desktop={desktop} on_listener={on_listener}");
            }
        }
    }

    /// A tailnet listener offers Node's desktop-only features to a recorded desktop alone, as Node's `featuresFor`; the
    /// loopback listener counts every client as a desktop.
    #[test]
    fn a_tailnet_phone_is_not_offered_the_desktop_features() {
        let all = advertised_features();
        assert!(all.iter().any(|f| f == "thread-prompts"));
        let phone = features_for_client(&all, false, desktop_on_listener(&ListenerMode::Admin, false));
        assert!(phone.iter().any(|f| f == "thread-prompts"), "on loopback every client is a desktop");
        let tailnet_phone = features_for_client(&all, false, false);
        for desktop_only in ["thread-prompts", "activity-bodies", "host-facts", "detail-read-held"] {
            assert!(!tailnet_phone.iter().any(|f| f == desktop_only), "{desktop_only} went to a tailnet phone");
        }
        assert!(tailnet_phone.iter().any(|f| f == "thread-snooze"), "a feature for every client still goes");
        let tailnet_desktop = features_for_client(&all, true, true);
        assert!(tailnet_desktop.iter().any(|f| f == "thread-prompts") && tailnet_desktop.iter().any(|f| f == "activity-bodies"));
    }

    fn answer_target() -> Value {
        json!({ "threadId": "t", "providerId": "codex", "requestId": "r", "questionsDigest": "a".repeat(64) })
    }

    const ASKING_THREAD: &str = "00000000-0000-4000-8000-00000000000a";

    /// A host on a mock Codex, one paired client that may answer and its session, and a thread whose provider asks one
    /// question, once the host has published it.
    struct AskingHost {
        server: RunningServer,
        mock: Arc<sotto_core::MockProviderAdapter>,
        client_id: String,
        session: String,
        question: Value,
        _dir: tempfile::TempDir,
    }

    /// One connection's own state, as its socket holds it.
    struct Connection {
        wire: ClientWireState,
        watcher_peer: WatcherPeerState,
        out_tx: mpsc::UnboundedSender<OutboundFrame>,
        out_rx: mpsc::UnboundedReceiver<OutboundFrame>,
    }

    impl AskingHost {
        async fn start() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let mock = Arc::new(sotto_core::MockProviderAdapter::new("codex"));
            let mut providers: BTreeMap<String, Arc<dyn ProviderAdapter>> = BTreeMap::new();
            providers.insert("codex".into(), mock.clone());
            let server = RunningServer::start(ServerConfig {
                data_directory: dir.path().to_path_buf(),
                host_id: "00000000-0000-4000-8000-000000000001".into(),
                port: 0,
                sotto_version: "0.1.0".into(),
                started_by: None,
                credentials: HostCredentials::open(dir.path(), None).unwrap(),
                providers,
                tailscale: None,
                phone_retry_interval: None,
            })
            .await
            .unwrap();
            let state = &server.state;
            let code = state.pairing.lock().unwrap().issue_pairing_code().code;
            let client_id = state.pairing.lock().unwrap().redeem_pairing_code(&code, "Test Desktop").unwrap().client_id;
            let session = state.pairing.lock().unwrap().issue_session(&client_id).unwrap().session;
            state.memory.lock().unwrap().set_remote_answers(&client_id, true, "test").unwrap();
            let client = ClientContext { client_id: client_id.clone(), user: "Test Desktop".into(), may_answer: true };
            let run = |command: Value| state.coordinator.run_command(client.clone(), command.as_object().unwrap().clone());
            let shell = run(json!({ "type": "create-project", "provider": "codex", "title": "P", "path": dir.path().to_string_lossy(), "useExisting": true })).await.unwrap();
            let project_id = shell["host"]["projects"][0]["id"].as_str().unwrap().to_string();
            run(json!({ "type": "create-thread", "threadId": ASKING_THREAD, "projectId": project_id, "title": "T", "titleSource": "user",
                "modelId": "native:codex:model:fixture-model", "workingCopy": "shared", "managed": false })).await.unwrap();
            run(json!({ "type": "manual-send", "threadId": ASKING_THREAD, "text": "Go" })).await.unwrap();
            let question = json!({ "id": "req-1", "kind": "question", "text": "Which colour?", "options": [{ "id": "blue", "label": "Blue" }] });
            let mut published = state.coordinator.subscribe();
            mock.emit_request(ASKING_THREAD, question.clone());
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    if let Ok(CoordinatorBroadcast::Shell(shell)) = published.recv().await {
                        if shell["host"]["threads"][0]["requests"].as_array().is_some_and(|requests| requests.contains(&question)) {
                            return;
                        }
                    }
                }
            })
            .await
            .expect("the question was never published");
            Self { server, mock, client_id, session, question, _dir: dir }
        }

        /// A connection whose hello accepted `accepts`.
        async fn connect(&self, accepts: &[&str]) -> Connection {
            let (out_tx, out_rx) = mpsc::unbounded_channel();
            let mut connection = Connection { wire: ClientWireState::default(), watcher_peer: WatcherPeerState::default(), out_tx, out_rx };
            let hello = self.ask(&mut connection, json!({ "v": 1, "id": "hello", "op": "hello", "accepts": accepts })).await;
            assert_eq!(hello["ok"], true, "{hello}");
            connection
        }

        /// One request on `connection`, answered as its socket answers it.
        async fn ask(&self, connection: &mut Connection, request: Value) -> Value {
            let Connection { wire, watcher_peer, out_tx, .. } = connection;
            let reply = handle_ws_request(&self.server.state, &ListenerMode::Admin, &self.client_id, "Test Desktop", &self.session, wire, watcher_peer, out_tx, &request.to_string()).await;
            serde_json::to_value(reply).unwrap()
        }

        fn target(&self) -> Value {
            let questions_digest = sotto_core::answered_requests::request_questions_digest(&self.question).unwrap();
            json!({ "threadId": ASKING_THREAD, "providerId": "codex", "requestId": "req-1", "questionsDigest": questions_digest })
        }
    }

    /// The session is checked again once the coordinator's answer check returns, as Node checks `authenticated(peer)`:
    /// a client revoked while its provider read the thread is unauthenticated, before whether it may answer.
    #[tokio::test]
    async fn an_answer_check_that_outlives_its_session_is_unauthenticated() {
        let host = AskingHost::start().await;
        let mut connection = host.connect(&[]).await;
        let check = json!({ "v": 1, "id": "check-1", "op": "check-answer", "answer": host.target() });
        let checked = host.ask(&mut connection, check.clone()).await;
        assert_eq!(checked["ok"], true, "the question still waits: {checked}");

        let sotto_core::provider::HeldThreadRead { started, finish } = host.mock.hold_next_thread_read();
        let revoke = async {
            started.await.unwrap();
            assert!(host.server.state.pairing.lock().unwrap().revoke(&host.client_id).unwrap());
            finish.send(Ok(None)).unwrap();
        };
        let (refused, ()) = tokio::join!(host.ask(&mut connection, check), revoke);
        assert_eq!(refused["error"]["code"], "unauthenticated", "{refused}");
        assert_eq!(refused["error"]["message"], HostErrorCode::Unauthenticated.default_message());
        host.server.close().await;
    }

    /// A command turned down before it acts keeps no receipt, as Node turns each one down before `receipts.record`: one
    /// the allow-list refuses, a save naming a revision from a client without `draft-revisions`, and an answer to a
    /// question no longer waiting. A receipt of a command that failed says only the host's `unavailable`, and a retry
    /// is answered in those words alone.
    #[tokio::test]
    async fn refused_commands_keep_no_receipt_and_a_receipt_keeps_only_the_hosts_words() {
        let host = AskingHost::start().await;
        let mut connection = host.connect(&["answer-receipts"]).await;
        let command = |id: &str, command: Value| json!({ "v": 1, "id": id, "op": "command", "command": command });
        let receipt = |id: &str| json!({ "v": 1, "id": format!("read-{id}"), "op": "receipt", "commandId": id });

        let refusals = [
            ("cmd-fields", json!({ "type": "rename-thread", "threadId": ASKING_THREAD, "title": "X", "later": 1 }), "invalid_request"),
            ("cmd-revision", json!({ "type": "save-thread-draft", "threadId": ASKING_THREAD, "text": "Hi", "expectedDraftId": "d" }), "invalid_request"),
            ("cmd-stale", json!({ "type": "answer", "threadId": ASKING_THREAD, "requestId": "req-9", "answer": "Blue" }), "stale_request"),
        ];
        for (id, refused, code) in refusals {
            let reply = host.ask(&mut connection, command(id, refused)).await;
            assert_eq!(reply["error"]["code"], code, "{id}: {reply}");
            assert_eq!(host.ask(&mut connection, receipt(id)).await["result"], json!({ "status": "unknown" }), "{id} kept no receipt");
        }
        // With no receipt kept, the same ID may carry another command, which runs.
        let renamed = host.ask(&mut connection, command("cmd-fields", json!({ "type": "rename-thread", "threadId": ASKING_THREAD, "title": "Renamed" }))).await;
        assert_eq!(renamed["ok"], true, "{renamed}");
        assert_eq!(host.ask(&mut connection, receipt("cmd-fields")).await["result"], json!({ "status": "completed" }));

        // The coordinator's own words answer the command, but its receipt and any retry say only the host's.
        let unknown = command("cmd-unknown", json!({ "type": "rename-thread", "threadId": "00000000-0000-4000-8000-0000000000ff", "title": "X" }));
        let first = host.ask(&mut connection, unknown.clone()).await;
        assert_eq!(first["ok"], false, "{first}");
        let words = HostErrorCode::Unavailable.default_message();
        let kept = host.ask(&mut connection, receipt("cmd-unknown")).await;
        assert_eq!(kept["result"], json!({ "status": "completed", "error": { "code": "unavailable", "message": words } }));
        let again = host.ask(&mut connection, unknown).await;
        assert_eq!(again["error"], json!({ "code": "unavailable", "message": words }));

        let answered = host.ask(&mut connection, command("cmd-answer", json!({ "type": "answer", "threadId": ASKING_THREAD, "requestId": "req-1", "answer": "Blue" }))).await;
        assert_eq!(answered["ok"], true, "{answered}");
        assert_eq!(host.ask(&mut connection, receipt("cmd-answer")).await["result"], json!({ "status": "completed", "answerDelivered": true }));
        host.server.close().await;
    }

    /// A delete or a preview in the wrong shape is invalid_request before anything turns it down, and keeps no receipt, as
    /// Node's socket server parses a command (`commandFromProtocolV1`) before `remoteCommandRefusal` and both before
    /// `receipts.record`. A well-formed delete from a client that may not answer is then forbidden and keeps none either,
    /// and a preview, which takes no answer policy, is answered with what deleting would do and keeps none.
    #[tokio::test]
    async fn a_delete_is_read_before_it_is_refused_and_keeps_no_receipt() {
        let host = AskingHost::start().await;
        let mut connection = host.connect(&["answer-receipts"]).await;
        let command = |id: &str, command: Value| json!({ "v": 1, "id": id, "op": "command", "command": command });
        let receipt = |id: &str| json!({ "v": 1, "id": format!("read-{id}"), "op": "receipt", "commandId": id });
        let malformed = [
            ("delete-empty-id", json!({ "type": "delete-thread", "threadId": "" })),
            ("delete-bad-items", json!({ "type": "delete-thread", "threadId": ASKING_THREAD, "confirmedItems": [{ "path": "a", "fileCount": -1 }] })),
            ("delete-bad-repositories", json!({ "type": "delete-thread", "threadId": ASKING_THREAD, "confirmedRepositories": [{ "path": "r", "changeCount": 0, "kind": "folder" }] })),
            ("delete-extra-field", json!({ "type": "delete-thread", "threadId": ASKING_THREAD, "later": 1 })),
            ("preview-extra-field", json!({ "type": "preview-delete-thread", "threadId": ASKING_THREAD, "confirmedIgnored": [] })),
        ];
        for may_answer in [true, false] {
            host.server.state.memory.lock().unwrap().set_remote_answers(&host.client_id, may_answer, "test").unwrap();
            for (name, refused) in &malformed {
                let id = format!("{name}-{may_answer}");
                let reply = host.ask(&mut connection, command(&id, refused.clone())).await;
                assert_eq!(reply["error"]["code"], "invalid_request", "{id}: {reply}");
                assert_eq!(host.ask(&mut connection, receipt(&id)).await["result"], json!({ "status": "unknown" }), "{id} kept no receipt");
            }
        }
        let refused = host.ask(&mut connection, command("delete-no-policy", json!({ "type": "delete-thread", "threadId": ASKING_THREAD }))).await;
        assert_eq!(refused["error"]["code"], "forbidden", "{refused}");
        assert_eq!(host.ask(&mut connection, receipt("delete-no-policy")).await["result"], json!({ "status": "unknown" }));
        let preview = host.ask(&mut connection, command("preview", json!({ "type": "preview-delete-thread", "threadId": ASKING_THREAD }))).await;
        assert_eq!(preview["ok"], true, "{preview}");
        assert_eq!(preview["result"]["error"], Value::Null);
        assert_eq!(preview["result"]["threadDeletePreview"], json!({ "threadId": ASKING_THREAD, "kept": "not-settled", "worktree": null }));
        assert_eq!(host.ask(&mut connection, receipt("preview")).await["result"], json!({ "status": "unknown" }), "a preview keeps no receipt");
        host.server.close().await;
    }

    /// Remove worktree is read as Node's schema reads it before anything turns it down (ADR-0041); its confirmations then
    /// take the remote-answer policy, before a receipt is kept; and its preview keeps no receipt and answers with its own
    /// outcome, here Node's words for a thread with no folder of its own.
    #[tokio::test]
    async fn a_worktree_removal_is_read_before_it_is_refused_and_its_preview_keeps_no_receipt() {
        let host = AskingHost::start().await;
        let mut connection = host.connect(&["answer-receipts"]).await;
        let command = |id: &str, command: Value| json!({ "v": 1, "id": id, "op": "command", "command": command });
        let receipt = |id: &str| json!({ "v": 1, "id": format!("read-{id}"), "op": "receipt", "commandId": id });
        let malformed = [
            ("reclaim-after-settle-false", json!({ "type": "reclaim-thread-worktree", "threadId": ASKING_THREAD, "afterSettle": false })),
            ("reclaim-bad-items", json!({ "type": "reclaim-thread-worktree", "threadId": ASKING_THREAD, "confirmedItems": [{ "path": "a", "fileCount": -1 }] })),
            ("preview-reclaim-extra-field", json!({ "type": "preview-reclaim-thread-worktree", "threadId": ASKING_THREAD, "withUncommittedChanges": true })),
        ];
        for may_answer in [true, false] {
            host.server.state.memory.lock().unwrap().set_remote_answers(&host.client_id, may_answer, "test").unwrap();
            for (name, refused) in &malformed {
                let id = format!("{name}-{may_answer}");
                let reply = host.ask(&mut connection, command(&id, refused.clone())).await;
                assert_eq!(reply["error"]["code"], "invalid_request", "{id}: {reply}");
                assert_eq!(host.ask(&mut connection, receipt(&id)).await["result"], json!({ "status": "unknown" }), "{id} kept no receipt");
            }
        }
        let refused = host.ask(&mut connection, command("reclaim-no-policy", json!({ "type": "reclaim-thread-worktree", "threadId": ASKING_THREAD, "withUncommittedChanges": true }))).await;
        assert_eq!(refused["error"]["code"], "forbidden", "{refused}");
        assert_eq!(host.ask(&mut connection, receipt("reclaim-no-policy")).await["result"], json!({ "status": "unknown" }));
        let preview = host.ask(&mut connection, command("preview", json!({ "type": "preview-reclaim-thread-worktree", "threadId": ASKING_THREAD }))).await;
        assert_eq!(preview["ok"], true, "{preview}");
        assert_eq!(preview["result"]["error"], "The folder could not be checked. Nothing was removed. Check the host connection and try again.");
        assert!(preview["result"].get("worktreeReclaimPreview").is_none());
        assert_eq!(host.ask(&mut connection, receipt("preview")).await["result"], json!({ "status": "unknown" }), "a preview keeps no receipt");
        host.server.close().await;
    }

    /// A connection that fell behind the host's publications is still told of each answer it watches that a provider took,
    /// as Node checks `answerWatches` on every publication, before the whole shell it is sent again.
    #[tokio::test]
    async fn a_connection_that_lagged_is_told_of_its_accepted_answers() {
        let host = AskingHost::start().await;
        let mut connection = host.connect(&["answer-receipts"]).await;
        let watch = json!({ "v": 1, "id": "read-1", "op": "receipt", "commandId": "cmd-answer", "answer": host.target() });
        assert_eq!(host.ask(&mut connection, watch).await["result"], json!({ "status": "unknown" }), "not given yet, so watched");
        let answer = json!({ "v": 1, "id": "cmd-answer", "op": "command",
            "command": { "type": "answer", "threadId": ASKING_THREAD, "requestId": "req-1", "answer": "Blue" } });
        assert_eq!(host.ask(&mut connection, answer).await["ok"], true);
        while connection.out_rx.try_recv().is_ok() {}

        let Connection { wire, out_tx, out_rx, .. } = &mut connection;
        let lagged = Err(broadcast::error::RecvError::Lagged(3));
        assert!(forward_coordinator_broadcast(&host.server.state, &host.client_id, wire, out_tx, lagged).await);
        let Ok(OutboundFrame::Text(first)) = out_rx.try_recv() else { panic!("nothing was pushed") };
        let pushed: Value = serde_json::from_str(&first).unwrap();
        assert_eq!(pushed["event"], "answer-receipt", "{pushed}");
        assert_eq!(pushed["acceptedAnswer"]["decisionId"], "cmd-answer");
        assert_eq!(pushed["acceptedAnswer"]["requestId"], "req-1");
        let Ok(OutboundFrame::Text(next)) = out_rx.try_recv() else { panic!("the shell was not sent again") };
        assert_eq!(serde_json::from_str::<Value>(&next).unwrap()["event"], "shell");
        assert!(wire.answer_watches.is_empty(), "an answer it was told of is no longer watched");
        host.server.close().await;
    }

    /// A `receipt` names a command ID and, if it likes, one exact answer, and nothing else, as Node's strict schema reads it.
    #[test]
    fn a_receipt_request_is_read_as_nodes_schema_reads_it() {
        let read = |value: Value| receipt_request(value.as_object().unwrap());
        assert_eq!(read(json!({ "commandId": "c" })).map(|(id, answer)| (id, answer.is_none())), Some(("c".into(), true)));
        let (id, answer) = read(json!({ "commandId": "c", "answer": answer_target() })).unwrap();
        assert_eq!((id.as_str(), answer.unwrap().request_id.as_str()), ("c", "r"));
        assert!(read(json!({})).is_none(), "no command ID");
        assert!(read(json!({ "commandId": "" })).is_none());
        assert!(read(json!({ "commandId": "c", "later": 1 })).is_none(), "a field Node's strict schema does not name");
        assert!(read(json!({ "commandId": "c", "answer": { "threadId": "t" } })).is_none(), "a malformed answer is not left out");
    }

    /// A `check-answer` is refused as Node's socket server refuses it, and in its order: a malformed request, then a
    /// client not offered `answer-check`, then a client that may not answer.
    #[test]
    fn an_answer_check_is_checked_in_nodes_order() {
        let fields = |value: Value| value.as_object().unwrap().clone();
        let good = fields(json!({ "answer": answer_target() }));
        assert_eq!(checked_answer_check(&good, |_| true, true).map(|target| target.thread_id), Ok("t".into()));
        let bad = fields(json!({ "answer": { "threadId": "t" } }));
        assert_eq!(checked_answer_check(&bad, |_| false, false), Err(HostErrorCode::InvalidRequest), "the shape comes first");
        let extra = fields(json!({ "answer": answer_target(), "commandId": "c" }));
        assert_eq!(checked_answer_check(&extra, |_| true, true), Err(HostErrorCode::InvalidRequest));
        assert_eq!(checked_answer_check(&good, |_| false, false), Err(HostErrorCode::InvalidRequest), "then the feature");
        assert_eq!(checked_answer_check(&good, |_| true, false), Err(HostErrorCode::Forbidden), "then whether it may answer");
    }

    /// Answer receipts and the answer check go to every client, a phone on a tailnet listener too, as Node offers them.
    #[test]
    fn answer_receipts_and_the_answer_check_are_offered_to_every_client() {
        let all = advertised_features();
        for (desktop, on_listener) in [(true, true), (false, true), (false, false)] {
            let offered = features_for_client(&all, desktop, on_listener);
            for feature in ["answer-receipts", "answer-check"] {
                assert!(offered.iter().any(|f| f == feature), "{feature} to desktop={desktop} on_listener={on_listener}");
            }
        }
    }

    /// A thread read takes its thread and its one other ID and nothing else, as Node's strict schema does.
    #[test]
    fn a_thread_read_takes_exactly_its_two_ids() {
        let fields = |value: Value| value.as_object().unwrap().clone();
        assert_eq!(thread_read_ids(&fields(json!({ "threadId": "t", "activityId": "a" })), "activityId"), Some(("t".into(), "a".into())));
        assert_eq!(thread_read_ids(&fields(json!({ "threadId": "t", "activityId": "a", "extra": 1 })), "activityId"), None);
        assert_eq!(thread_read_ids(&fields(json!({ "threadId": "", "activityId": "a" })), "activityId"), None);
        assert_eq!(thread_read_ids(&fields(json!({ "threadId": "t" })), "activityId"), None);
        assert_eq!(thread_read_ids(&fields(json!({ "threadId": "t", "activityId": "x".repeat(513) })), "activityId"), None);
    }

    /// An answer too large to send is refused with the sentence for what was asked, as Node's socket server words it.
    #[test]
    fn a_too_large_answer_says_what_was_too_large() {
        assert!(too_large_words("activity-body").starts_with("This activity is too large"));
        assert!(too_large_words("thread-media").starts_with("This attachment is too large"));
        assert!(too_large_words("thread-changes").starts_with("This file or comparison"));
        assert_eq!(too_large_words("detail"), HostErrorCode::TooLarge.default_message());
        assert!(too_large_words("shell").starts_with("The thread list on this host"));
    }

    #[test]
    fn advertised_features_truthfully_match_implemented_watcher_ops() {
        let feats = advertised_features();
        for required in [
            "watcher-control",
            "watcher-reads",
            "watcher-progress",
            "watcher-standing-watch",
            "watcher-work-settled",
            "watcher-outcomes",
            "watcher-new-owner",
            "watcher-check-queue",
            "watcher-check-stop",
            "watcher-muse",
            "watcher-cursor",
            "watcher-antigravity",
            "project-origins",
            "project-setup",
            "project-git-init",
        ] {
            assert!(
                feats.iter().any(|f| f == required),
                "expected advertised feature {required}"
            );
        }
        // Never advertise unimplemented host-side MCP or swarm features.
        for unimplemented in ["watcher-tell", "watcher-ready", "worker-swarms", "branch-moves"] {
            assert!(
                !feats.iter().any(|f| f == unimplemented),
                "must not advertise unimplemented feature {unimplemented}"
            );
        }
    }

    #[test]
    fn non_desktop_clients_receive_zero_watcher_or_project_origins_features() {
        let all = advertised_features();
        // Loopback unrecorded client: zero watcher-* features, but loopback desktop features (`project-origins`, `project-setup`) are offered as on Node.
        let loopback_unrecorded = features_for_client(&all, false, true);
        assert!(!loopback_unrecorded.iter().any(|f| f.starts_with("watcher-")));
        assert!(loopback_unrecorded.iter().any(|f| f == "project-origins"));
        assert!(loopback_unrecorded.iter().any(|f| f == "project-setup"));
        assert!(loopback_unrecorded.iter().any(|f| f == "detail-delta"));

        // Tailnet phone (not recorded desktop, not loopback): zero watcher-*, zero project-origins, zero project-setup.
        let tailnet_phone = features_for_client(&all, false, false);
        assert!(!tailnet_phone.iter().any(|f| f.starts_with("watcher-")));
        assert!(!tailnet_phone.iter().any(|f| f == "project-origins"));
        assert!(!tailnet_phone.iter().any(|f| f == "project-setup"));

        let desktop = features_for_client(&all, true, true);
        assert!(desktop.iter().any(|f| f == "watcher-control"));
        assert!(desktop.iter().any(|f| f == "watcher-reads"));
        assert!(desktop.iter().any(|f| f == "project-origins"));
        assert!(desktop.iter().any(|f| f == "project-setup"));
    }

    #[test]
    fn pull_request_features_are_offered_to_both_desktop_and_mobile_clients() {
        let all = advertised_features();
        for (desktop, on_listener) in [(true, true), (false, true), (false, false)] {
            let offered = features_for_client(&all, desktop, on_listener);
            for feature in [
                "git-pull-request",
                "git-pull-request-list",
                "pull-request-confirmation",
                "pull-request-view",
            ] {
                assert!(
                    offered.iter().any(|f| f == feature),
                    "expected {feature} for desktop={desktop} on_listener={on_listener}"
                );
            }
        }
    }
}
