use std::collections::{BTreeMap, HashMap};
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

use sotto_core::pairing::constant_time_eq;
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
        "activity-summaries".into(),
        "model-catalog-revision".into(),
        "changed-thread-records".into(),
        "reply-thread-records".into(),
        "command-changed-thread-records".into(),
        "kept-parts".into(),
        "draft-revisions".into(),
        "detail-read-held".into(),
        "provider-opencode".into(),
        "provider-cursor".into(),
        "provider-hermes".into(),
        "provider-antigravity".into(),
        "git-refs".into(),
        "git-changed-files".into(),
        "host-folders".into(),
        "thread-files".into(),
        "thread-changes".into(),
        "thread-snooze".into(),
        "failure-seen".into(),
        "host-facts".into(),
        "project-origins".into(),
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
    ]
}

/// The longest ID Node's protocol reads (`id` in `src/shared/agents.ts`), in UTF-16 code units as zod counts.
const ID_MAX: usize = 512;

/// An ID as Node's schema reads one: not empty and at most `ID_MAX` UTF-16 code units.
fn protocol_id(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.encode_utf16().count() <= ID_MAX)
        .map(ToString::to_string)
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

/// Filters host-advertised features per authenticated client: `watcher-*` (non-phone) and
/// `project-origins` are offered ONLY to authenticated paired desktops recorded in
/// `desktop-clients.json` (ADR-0073, ADR-0082).
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
            !is_desktop_watcher && s != "project-origins"
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
                match bcast {
                    Ok(CoordinatorBroadcast::Shell(mut shell)) => {
                        let may_answer = state
                            .memory
                            .lock()
                            .unwrap()
                            .may_grant_remote(&client_id)
                            .unwrap_or(false);
                        if let Some(obj) = shell.as_object_mut() {
                            obj.insert(
                                "clientCapabilities".into(),
                                json!({ "mayAnswer": may_answer }),
                            );
                        }
                        let frame = wire.encode_shell_push(shell);
                        if let Ok(encoded) = serde_json::to_string(&frame) {
                            if out_tx.send(OutboundFrame::Text(encoded)).is_err() {
                                break;
                            }
                        }
                    }
                    Ok(CoordinatorBroadcast::Detail(detail)) => {
                        if let Some(frame) = wire.encode_detail_update_push(&detail) {
                            if let Ok(encoded) = serde_json::to_string(&frame) {
                                if out_tx.send(OutboundFrame::Text(encoded)).is_err() {
                                    break;
                                }
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // On lag, resend whole shell cleanly so the client stays in sync.
                        let may_answer = state
                            .memory
                            .lock()
                            .unwrap()
                            .may_grant_remote(&client_id)
                            .unwrap_or(false);
                        if let Ok(shell) = state.coordinator.shell(may_answer).await {
                            let frame = wire.encode_shell_push(shell);
                            if let Ok(encoded) = serde_json::to_string(&frame) {
                                let _ = out_tx.send(OutboundFrame::Text(encoded));
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
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
        "stage-file-part" => {
            let Some(part) = req.fields.get("part").and_then(Value::as_object) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let (
                Some(upload_id),
                Some(index),
                Some(count),
                Some(name),
                Some(mime),
                Some(size_bytes_u64),
                Some(digest),
                Some(data),
            ) = (
                part.get("uploadId").and_then(Value::as_str),
                part.get("index").and_then(Value::as_u64),
                part.get("count").and_then(Value::as_u64),
                part.get("name").and_then(Value::as_str),
                part.get("mimeType").and_then(Value::as_str),
                part.get("sizeBytes").and_then(Value::as_u64),
                part.get("digest").and_then(Value::as_str),
                part.get("data").and_then(Value::as_str),
            )
            else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
            let Ok(size_bytes) = usize::try_from(size_bytes_u64) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    "Uploaded file exceeds the allowed size limit.",
                );
            };
            let Ok(index_usize) = usize::try_from(index) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    "Invalid file upload part index.",
                );
            };
            let Ok(count_usize) = usize::try_from(count) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    "Invalid file upload part count.",
                );
            };
            match state
                .coordinator
                .stage_file_part(
                    upload_id.into(),
                    index_usize,
                    count_usize,
                    name.into(),
                    mime.into(),
                    size_bytes,
                    digest.into(),
                    data.into(),
                )
                .await
            {
                Ok(Some(handle)) => HostResponseEnvelope::ok(
                    req.id,
                    serde_json::to_value(handle).unwrap_or(Value::Null),
                ),
                Ok(None) => HostResponseEnvelope::ok(req.id, Value::Null),
                Err(err) => HostResponseEnvelope::err(req.id, err.code, err.message),
            }
        }
        "command" => {
            let Some(cmd) = req.fields.get("command").and_then(Value::as_object) else {
                return HostResponseEnvelope::err(
                    req.id,
                    HostErrorCode::InvalidRequest,
                    HostErrorCode::InvalidRequest.default_message(),
                );
            };
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
            match state.coordinator.run_command(client, cmd.clone()).await {
                Ok(raw_shell) => {
                    HostResponseEnvelope::ok(req.id, wire.encode_command_shell(raw_shell))
                }
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
            let record = match state.coordinator.detail(thread_id).await {
                Ok(detail) => detail.and_then(|detail| {
                    detail
                        .activities
                        .iter()
                        .find(|record| record.get("id").and_then(Value::as_str) == Some(activity_id.as_str()))
                        .map(sotto_core::activity_bodies::strip_agent_steps)
                }),
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
            let projects = match state.coordinator.projects_for_origins().await {
                Ok(list) => list
                    .into_iter()
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
        let non_desktop = features_for_client(&all, false, true);
        assert!(!non_desktop.iter().any(|f| f.starts_with("watcher-")));
        assert!(!non_desktop.iter().any(|f| f == "project-origins"));
        // Normal non-watcher features remain available.
        assert!(non_desktop.iter().any(|f| f == "detail-delta"));

        let desktop = features_for_client(&all, true, true);
        assert!(desktop.iter().any(|f| f == "watcher-control"));
        assert!(desktop.iter().any(|f| f == "watcher-reads"));
        assert!(desktop.iter().any(|f| f == "project-origins"));
    }
}
