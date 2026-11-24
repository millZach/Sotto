use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::sync::{broadcast, watch, Mutex as AsyncMutex};
use tokio::task::JoinHandle;
use uuid::Uuid;

use sotto_core::{
    phone_access_summary, tailnet_address_of, DesktopClients, HostPhoneAccessSummary, MemoryStore,
    PairedClients, PairedPhoneView, PairingCode, PhoneAccessBrief, PhoneAccessListenerFactory,
    PhoneAccessManager, PhoneAccessSettings, PhonesCommand, PhonesState, ServeCheck,
    SystemTailscaleCli, TailscaleBackend, TailscaleCheck,
};

use crate::server::{start_tailnet_listener, HostState};

const NO_PAGE: &str =
    "Tailscale did not give a page to open. Open the Tailscale admin console to turn on Serve.";
const NOT_SAVED: &str =
    "Phone access could not be saved on this host. Nothing was changed. Try again.";
const ALWAYS_ANSWERS: &str =
    "A paired phone can always answer now. To stop a phone answering, remove it. Nothing was changed.";
const TAILNET_NOT_SAVED: &str =
    "Tailnet connections could not be saved on this host. Nothing was changed. Try again.";

/// For the first 5 minutes after a host starts, its phone access retries missing Tailscale or
/// transient Serve failures (matching `HOST_START_RETRY_WINDOW_MS` in `src/host/phones.ts`).
pub const HOST_START_RETRY_WINDOW: Duration = Duration::from_secs(5 * 60);
pub const DEFAULT_PHONE_RETRY_INTERVAL: Duration = Duration::from_secs(30);
const PHONE_ACCESS_CLOSE_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum HostAdminPhonesCommand {
    Retry,
    ShowCode,
    CancelCode,
    #[serde(rename_all = "camelCase")]
    Remove {
        client_id: String,
    },
    OpenServeSetup,
    #[serde(rename_all = "camelCase")]
    SetEnabled {
        enabled: bool,
    },
    #[serde(rename_all = "camelCase")]
    SetCanAnswer {
        client_id: String,
        allowed: bool,
    },
}

impl HostAdminPhonesCommand {
    pub fn validate(&self) -> bool {
        match self {
            HostAdminPhonesCommand::Remove { client_id }
            | HostAdminPhonesCommand::SetCanAnswer { client_id, .. } => {
                !client_id.is_empty() && client_id.len() <= 512
            }
            _ => true,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostPhonesAnswer {
    pub state: PhonesState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostTailnetAnswer {
    pub enabled: bool,
    pub state: PhonesState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn phones_off_message(computer_name: Option<&str>) -> String {
    let host = computer_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("this computer");
    format!(
        "Phone access is off on {host}. Your pairing is kept. In Sotto on your main computer, open Settings > Hosts & phones, press Phones\u{2026} on {host}'s row and turn on Let phones reach {host}, then try again."
    )
}

/// Reads `phoneAccess`, `phoneAccessName`, and `tailnetConnections` from `settings.json`
/// in the host data directory, falling back to safe defaults if the file is absent or unreadable.
pub fn read_phone_settings(data_directory: &Path) -> PhoneAccessSettings {
    let path = data_directory.join("settings.json");
    let Ok(text) = fs::read_to_string(&path) else {
        return PhoneAccessSettings::default();
    };
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&text) else {
        return PhoneAccessSettings::default();
    };
    let phone_access = map
        .get("phoneAccess")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let phone_access_name = map
        .get("phoneAccessName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let tailnet_connections = map
        .get("tailnetConnections")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    PhoneAccessSettings {
        phone_access,
        phone_access_name,
        tailnet_connections,
    }
}

/// Atomically merges `patch` into `settings.json`, preserving every other saved setting so
/// Node and Rust hosts share the same settings file cleanly.
pub fn update_host_settings(data_directory: &Path, patch: &[(&str, Value)]) -> std::io::Result<()> {
    let path = data_directory.join("settings.json");
    let mut map: Map<String, Value> = match fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(obj)) => obj,
            _ => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "settings.json is not a JSON object",
                ));
            }
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let mut obj = Map::new();
            obj.insert("version".into(), json!(1));
            obj
        }
        Err(err) => return Err(err),
    };

    for (key, value) in patch {
        map.insert((*key).to_string(), value.clone());
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut body = serde_json::to_string_pretty(&Value::Object(map)).map_err(std::io::Error::other)?;
    body.push('\n');
    let temp = data_directory.join(format!("settings.json.tmp-{}", Uuid::new_v4()));
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
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, &path)
    })();
    if write_res.is_err() {
        let _ = fs::remove_file(&temp);
    }
    write_res
}

/// Headless host Phone Access and Tailnet (`:8443` / `:10000`) controller mirroring `src/host/phones.ts`.
pub struct HostPhoneAccess {
    data_directory: PathBuf,
    memory_db_path: PathBuf,
    pairing: Arc<StdMutex<PairedClients>>,
    desktops: Arc<StdMutex<DesktopClients>>,
    revoked_tx: broadcast::Sender<String>,
    phone_ids: Arc<StdMutex<HashSet<String>>>,
    active_code: Arc<StdMutex<Option<PairingCode>>>,
    connected_clients: Arc<StdMutex<HashMap<String, usize>>>,
    manager: Arc<AsyncMutex<PhoneAccessManager>>,
    snapshot_tx: watch::Sender<(PhoneAccessBrief, PhonesState)>,
    snapshot_rx: watch::Receiver<(PhoneAccessBrief, PhonesState)>,
    started_tx: watch::Sender<bool>,
    started_rx: watch::Receiver<bool>,
    revoking: Arc<AsyncMutex<()>>,
    startup_settings: PhoneAccessSettings,
    retry_interval: Duration,
    bg_tasks: StdMutex<Vec<JoinHandle<()>>>,
    bg_stop_tx: watch::Sender<bool>,
}

impl HostPhoneAccess {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        data_directory: PathBuf,
        host_id: String,
        pairing: Arc<StdMutex<PairedClients>>,
        desktops: Arc<StdMutex<DesktopClients>>,
        coordinator: sotto_core::CoordinatorHandle,
        revoked_tx: broadcast::Sender<String>,
        tailscale: Option<Arc<dyn TailscaleBackend>>,
        retry_interval: Option<Duration>,
    ) -> Arc<Self> {
        let startup_settings = read_phone_settings(&data_directory);
        let memory_db_path = data_directory.join("memory.sqlite");
        let ts = tailscale.unwrap_or_else(|| Arc::new(SystemTailscaleCli::new()));

        let initial_brief = PhoneAccessBrief {
            enabled: startup_settings.phone_access,
            phase: "off".to_string(),
            address: None,
            phones: 0,
        };
        let initial_state = PhonesState {
            enabled: startup_settings.phone_access,
            local_host_running: true,
            phase: "off".to_string(),
            tailscale: TailscaleCheck::Waiting,
            serve: ServeCheck::Waiting,
            serve_port: None,
            address: None,
            computer_name: startup_settings.phone_access_name.clone(),
            default_name: String::new(),
            code: None,
            phones: Vec::new(),
            answers_available: true,
        };
        let (snapshot_tx, snapshot_rx) = watch::channel((initial_brief, initial_state));
        let (started_tx, started_rx) = watch::channel(false);
        let (bg_stop_tx, _) = watch::channel(false);

        let snap_for_cb = snapshot_tx.clone();
        let on_change = Arc::new(move |brief: PhoneAccessBrief, state: PhonesState| {
            let _ = snap_for_cb.send((brief, state));
        });

        let mgr = PhoneAccessManager::new(
            data_directory.clone(),
            host_id,
            true,
            Some(coordinator),
            ts,
        )
        .with_shared_pairing(Arc::clone(&pairing))
        .with_tailnet_desktops(true)
        .with_on_change(on_change)
        .with_start_retry_window(HOST_START_RETRY_WINDOW);

        let active_code = mgr.active_code_handle();
        let phone_ids = mgr
            .phone_ids_handle()
            .unwrap_or_else(|| Arc::new(StdMutex::new(HashSet::new())));

        Arc::new(Self {
            data_directory,
            memory_db_path,
            pairing,
            desktops,
            revoked_tx,
            phone_ids,
            active_code,
            connected_clients: Arc::new(StdMutex::new(HashMap::new())),
            manager: Arc::new(AsyncMutex::new(mgr)),
            snapshot_tx,
            snapshot_rx,
            started_tx,
            started_rx,
            revoking: Arc::new(AsyncMutex::new(())),
            startup_settings,
            retry_interval: retry_interval.unwrap_or(DEFAULT_PHONE_RETRY_INTERVAL),
            bg_tasks: StdMutex::new(Vec::new()),
            bg_stop_tx,
        })
    }

    /// Starts `PhoneAccessManager` in the background (matching `src/host/phones.ts:114` so slow
    /// Tailscale checks never block the main loopback listener from becoming ready) and starts the
    /// bounded background retry task.
    pub fn start_background(
        self: &Arc<Self>,
        host_state: Weak<HostState>,
        shutdown_rx: watch::Receiver<bool>,
    ) {
        let self_for_factory = Arc::clone(self);
        let state_for_factory = host_state.clone();
        let connected_for_factory = Arc::clone(&self.connected_clients);
        let shutdown_for_factory = shutdown_rx.clone();
        let factory: PhoneAccessListenerFactory = Arc::new(move |spawn_cfg| {
            let weak_state = state_for_factory.clone();
            let connected = Arc::clone(&connected_for_factory);
            let shutdown = shutdown_for_factory.clone();
            Box::pin(async move {
                let Some(state) = weak_state.upgrade() else {
                    return Err(std::io::Error::other("host is shutting down"));
                };
                start_tailnet_listener(spawn_cfg, state, connected, shutdown).await
            })
        });

        let self_for_revoke = Arc::clone(self);
        let on_revoked: Arc<dyn Fn(String) + Send + Sync> = Arc::new(move |client_id| {
            self_for_revoke.handle_client_revoked(client_id);
        });

        let startup = self.startup_settings.clone();
        let start_task = tokio::spawn(async move {
            let mut mgr = self_for_factory.manager.lock().await;
            let current = std::mem::replace(
                &mut *mgr,
                PhoneAccessManager::new(
                    self_for_factory.data_directory.clone(),
                    String::new(),
                    false,
                    None,
                    Arc::new(SystemTailscaleCli::new()),
                ),
            );
            *mgr = current
                .with_listener_factory(factory)
                .with_on_revoked(on_revoked);
            mgr.start(startup).await;
            let _ = self_for_factory.started_tx.send(true);
        });

        let self_for_retry = Arc::clone(self);
        let mut stop_rx = self.bg_stop_tx.subscribe();
        let retry_interval = self.retry_interval;
        let retry_task = tokio::spawn(async move {
            self_for_retry.wait_started().await;
            loop {
                tokio::select! {
                    _ = stop_rx.changed() => {
                        if *stop_rx.borrow() {
                            break;
                        }
                    }
                    _ = tokio::time::sleep(retry_interval) => {
                        if *stop_rx.borrow() {
                            break;
                        }
                        let mut mgr = self_for_retry.manager.lock().await;
                        if mgr.should_retry() {
                            mgr.retry_if_needed().await;
                        }
                    }
                }
            }
        });

        if let Ok(mut tasks) = self.bg_tasks.lock() {
            tasks.push(start_task);
            tasks.push(retry_task);
        }
    }

    pub async fn wait_started(&self) {
        let mut rx = self.started_rx.clone();
        while !*rx.borrow() {
            if rx.changed().await.is_err() {
                break;
            }
        }
    }

    pub fn subscribe(&self) -> watch::Receiver<(PhoneAccessBrief, PhonesState)> {
        self.snapshot_rx.clone()
    }

    /// Lock-free brief state used by `/v1/health`, `hello`, and `host-listener.json`.
    pub fn brief(&self) -> PhoneAccessBrief {
        let mut brief = self.snapshot_rx.borrow().0.clone();
        brief.phones = self.paired_phone_count();
        brief
    }

    /// Current Tailscale Serve address (`https://<dns>:<port>`) while Serve is on, else `None`.
    pub fn address(&self) -> Option<String> {
        tailnet_address_of(&self.brief())
    }

    /// Summary sent in WebSocket `hello` to desktops (`{ status, phones }`).
    pub fn summary(&self) -> HostPhoneAccessSummary {
        phone_access_summary(&self.brief())
    }

    /// Whether `client_id` paired as a phone (and not as a desktop over SSH).
    pub fn is_phone(&self, client_id: &str) -> bool {
        let is_paired = self
            .pairing
            .lock()
            .map(|g| g.is_paired(client_id))
            .unwrap_or(false);
        if !is_paired {
            return false;
        }
        self.phone_ids
            .lock()
            .map(|g| g.contains(client_id))
            .unwrap_or(false)
    }

    /// Non-blocking snapshot of `PhonesState` for `POST /v1/admin/phones`, overlaid with live
    /// paired phone records, connection status, and pairing-code expiry so polling never blocks
    /// on slow Tailscale CLI calls.
    pub fn get_state(&self) -> PhonesState {
        let mut state = self.snapshot_rx.borrow().1.clone();
        state.code = self.live_active_code();
        state.phones = self.live_paired_phones(&state.phase);
        let mem_available = if self.memory_db_path.exists() {
            MemoryStore::open_read_only(&self.memory_db_path).is_ok()
        } else {
            true
        };
        state.answers_available = mem_available;
        state
    }

    pub async fn command(&self, cmd: HostAdminPhonesCommand) -> HostPhonesAnswer {
        self.wait_started().await;
        let mut mgr = self.manager.lock().await;
        match cmd {
            HostAdminPhonesCommand::SetEnabled { enabled } => {
                if update_host_settings(&self.data_directory, &[("phoneAccess", Value::Bool(enabled))])
                    .is_err()
                {
                    return HostPhonesAnswer {
                        state: mgr.get(),
                        url: None,
                        error: Some(NOT_SAVED.to_string()),
                    };
                }
                let mut next = mgr.settings().clone();
                next.phone_access = enabled;
                let state = mgr.settings_changed(next).await;
                HostPhonesAnswer {
                    state,
                    url: None,
                    error: None,
                }
            }
            HostAdminPhonesCommand::OpenServeSetup => {
                let url = mgr.serve_setup_url();
                let state = mgr.get();
                match url {
                    Some(u) => HostPhonesAnswer {
                        state,
                        url: Some(u),
                        error: None,
                    },
                    None => HostPhonesAnswer {
                        state,
                        url: None,
                        error: Some(NO_PAGE.to_string()),
                    },
                }
            }
            HostAdminPhonesCommand::SetCanAnswer { allowed, .. } => {
                let state = mgr.get();
                if allowed {
                    HostPhonesAnswer {
                        state,
                        url: None,
                        error: None,
                    }
                } else {
                    HostPhonesAnswer {
                        state,
                        url: None,
                        error: Some(ALWAYS_ANSWERS.to_string()),
                    }
                }
            }
            HostAdminPhonesCommand::Retry => match mgr.command(PhonesCommand::Retry).await {
                Ok(out) => HostPhonesAnswer {
                    state: out.state,
                    url: out.open_external_url,
                    error: None,
                },
                Err(err) => HostPhonesAnswer {
                    state: mgr.get(),
                    url: None,
                    error: Some(err),
                },
            },
            HostAdminPhonesCommand::ShowCode => match mgr.command(PhonesCommand::ShowCode).await {
                Ok(out) => HostPhonesAnswer {
                    state: out.state,
                    url: out.open_external_url,
                    error: None,
                },
                Err(err) => HostPhonesAnswer {
                    state: mgr.get(),
                    url: None,
                    error: Some(err),
                },
            },
            HostAdminPhonesCommand::CancelCode => {
                match mgr.command(PhonesCommand::CancelCode).await {
                    Ok(out) => HostPhonesAnswer {
                        state: out.state,
                        url: out.open_external_url,
                        error: None,
                    },
                    Err(err) => HostPhonesAnswer {
                        state: mgr.get(),
                        url: None,
                        error: Some(err),
                    },
                }
            }
            HostAdminPhonesCommand::Remove { client_id } => {
                match mgr
                    .command(PhonesCommand::Remove {
                        client_id: client_id.clone(),
                    })
                    .await
                {
                    Ok(out) => {
                        let _ = self.revoked_tx.send(client_id);
                        HostPhonesAnswer {
                            state: out.state,
                            url: out.open_external_url,
                            error: None,
                        }
                    }
                    Err(err) => HostPhonesAnswer {
                        state: mgr.get(),
                        url: None,
                        error: Some(err),
                    },
                }
            }
        }
    }

    /// Reads `tailnetConnections` (when `enabled` is `None`) or updates it and waits for
    /// Tailscale Serve to settle (matching `src/host/phones.ts:135-151`).
    pub async fn tailnet(&self, enabled: Option<bool>) -> HostTailnetAnswer {
        self.wait_started().await;
        // Wait for any in-flight desktop revocation deciding whether it was the last desktop.
        let _rev_guard = self.revoking.lock().await;
        let mut mgr = self.manager.lock().await;
        if let Some(target) = enabled {
            if mgr.settings().tailnet_connections != target {
                if update_host_settings(
                    &self.data_directory,
                    &[("tailnetConnections", Value::Bool(target))],
                )
                .is_err()
                {
                    return HostTailnetAnswer {
                        enabled: mgr.settings().tailnet_connections,
                        state: mgr.get(),
                        error: Some(TAILNET_NOT_SAVED.to_string()),
                    };
                }
                let mut next = mgr.settings().clone();
                next.tailnet_connections = target;
                let state = mgr.settings_changed(next).await;
                return HostTailnetAnswer {
                    enabled: target,
                    state,
                    error: None,
                };
            }
        }
        HostTailnetAnswer {
            enabled: mgr.settings().tailnet_connections,
            state: mgr.get(),
            error: None,
        }
    }

    /// Called after a client is revoked on either listener (`/v1/admin/revoke-client` or
    /// `/v1/revoke`): removes it from `desktop-clients.json` and, if it was the last paired
    /// desktop while `tailnetConnections` is on, turns `tailnetConnections` off so Forget leaves
    /// no Tailscale Serve setting behind (ADR-0053).
    pub fn handle_client_revoked(self: &Arc<Self>, client_id: String) {
        let _ = self.revoked_tx.send(client_id.clone());
        // If it was a phone, clean up `phone-clients.json` atomically too.
        if let Ok(mut ids) = self.phone_ids.lock() {
            if ids.remove(&client_id) {
                let mut list: Vec<&String> = ids.iter().collect();
                list.sort();
                let path = self.data_directory.join(sotto_core::PHONE_CLIENTS_FILE);
                if let Ok(mut body) = serde_json::to_string_pretty(&list) {
                    body.push('\n');
                    let temp = self
                        .data_directory
                        .join(format!("phone-clients.json.tmp-{}", Uuid::new_v4()));
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
                        file.sync_all()?;
                        drop(file);
                        fs::rename(&temp, &path)
                    })();
                    if write_res.is_err() {
                        let _ = fs::remove_file(&temp);
                    }
                }
            }
        }
        let this = Arc::clone(self);
        let task = tokio::spawn(async move {
            let _rev_guard = this.revoking.lock().await;
            let remaining_desktops = this
                .desktops
                .lock()
                .ok()
                .and_then(|mut d| d.remove_and_remaining(&client_id));
            let Some(remaining) = remaining_desktops else {
                return;
            };
            let any_desktop_left = this
                .pairing
                .lock()
                .ok()
                .is_some_and(|p| p.list().iter().any(|c| remaining.contains(&c.client_id)));
            if any_desktop_left {
                return;
            }
            this.wait_started().await;
            let mut mgr = this.manager.lock().await;
            if !mgr.settings().tailnet_connections {
                return;
            }
            if update_host_settings(
                &this.data_directory,
                &[("tailnetConnections", Value::Bool(false))],
            )
            .is_ok()
            {
                let mut next = mgr.settings().clone();
                next.tailnet_connections = false;
                let _ = mgr.settings_changed(next).await;
            }
        });
        if let Ok(mut tasks) = self.bg_tasks.lock() {
            tasks.retain(|h| !h.is_finished());
            tasks.push(task);
        }
    }

    pub async fn close(&self) {
        let _ = self.bg_stop_tx.send(true);
        self.wait_started().await;
        let _rev_guard = self.revoking.lock().await;
        let _ = tokio::time::timeout(PHONE_ACCESS_CLOSE_TIMEOUT, async {
            let mut mgr = self.manager.lock().await;
            mgr.close().await;
        })
        .await;
        let handles: Vec<JoinHandle<()>> = self
            .bg_tasks
            .lock()
            .map(|mut v| v.drain(..).collect())
            .unwrap_or_default();
        for handle in handles {
            handle.abort();
            let _ = handle.await;
        }
        let brief = self.brief();
        let state = self.get_state();
        let _ = self.snapshot_tx.send((brief, state));
    }

    fn paired_phone_count(&self) -> usize {
        let Ok(pairing) = self.pairing.lock() else {
            return 0;
        };
        let Ok(ids) = self.phone_ids.lock() else {
            return 0;
        };
        pairing
            .list()
            .iter()
            .filter(|c| ids.contains(&c.client_id))
            .count()
    }

    fn live_active_code(&self) -> Option<PairingCode> {
        let mut guard = self.active_code.lock().ok()?;
        if let Some(ref code) = *guard {
            if DateTime::parse_from_rfc3339(&code.expires_at)
                .is_ok_and(|dt| dt.timestamp_millis() <= Utc::now().timestamp_millis())
            {
                *guard = None;
            }
        }
        guard.clone()
    }

    fn live_paired_phones(&self, phase: &str) -> Vec<PairedPhoneView> {
        let clients: Vec<sotto_core::PairedClient> = {
            let Ok(pairing) = self.pairing.lock() else {
                return Vec::new();
            };
            let Ok(ids) = self.phone_ids.lock() else {
                return Vec::new();
            };
            pairing
                .list()
                .iter()
                .filter(|c| ids.contains(&c.client_id))
                .cloned()
                .collect()
        };
        let connected: HashSet<String> = if phase == "on" {
            self.connected_clients
                .lock()
                .map(|m| {
                    m.iter()
                        .filter(|&(_, &count)| count > 0)
                        .map(|(k, _)| k.clone())
                        .collect()
                })
                .unwrap_or_default()
        } else {
            HashSet::new()
        };
        let mem = if self.memory_db_path.exists() {
            MemoryStore::open_read_only(&self.memory_db_path).ok()
        } else {
            None
        };
        clients
            .into_iter()
            .map(|c| {
                let can_answer = mem
                    .as_ref()
                    .and_then(|m| m.may_grant_remote(&c.client_id).ok())
                    .unwrap_or(false);
                let is_connected = connected.contains(&c.client_id);
                PairedPhoneView {
                    client_id: c.client_id,
                    name: c.name,
                    paired_at: c.paired_at,
                    connected: is_connected,
                    can_answer,
                }
            })
            .collect()
    }
}
