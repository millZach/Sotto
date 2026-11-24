//! Phone access (ADR-0033) and local apps (ADR-0180) matching `src/main/phones/phoneAccess.ts`,
//! `src/main/phones/localApps.ts`, and `src/main/phones/tailscale.ts`.
//!
//! Shares exact on-disk formats (`phone-access.json`, `paired-clients.json`, `local-apps.json`,
//! `local-apps/paired-clients.json`, and `memory.sqlite` `remote-answer` policy records) so
//! TypeScript and Rust interoperate transparently over the same user-data directory.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::coordinator::CoordinatorHandle;
use crate::pairing::{PairedClients, PairingCode, PairingError};
use crate::protocol::HOST_PROTOCOL_VERSION;
use crate::stores::MemoryStore;

pub const PHONE_ACCESS_SERVE_PORTS: [u16; 2] = [8443, 10000];
pub const LOCAL_APPS_CLIENT_NAME: &str = "Apps on this computer";

const PHONE_ANSWERS_NOTE: &str =
    "The user paired this phone with a code from the Phones page, which lets it answer.";
const LOCAL_APPS_ANSWERS_NOTE: &str =
    "The user turned on Let apps on this computer connect, which lets those apps answer.";
const PEERS_MAX: usize = 50;
const MAX_HTTP_HEADER_BYTES: usize = 32 * 1024;
const MAX_HTTP_BODY_BYTES: usize = 64 * 1024;
const DEFAULT_SOTTO_VERSION: &str = match option_env!("SOTTO_HOST_VERSION") {
    Some(v) if !v.is_empty() => v,
    _ => env!("CARGO_PKG_VERSION"),
};

// ---------------------------------------------------------------------------
// Tailscale CLI & Serve config parity (`src/main/phones/tailscale.ts`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscalePeer {
    pub name: String,
    pub dns_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum TailscaleStatus {
    Missing,
    NotRunning,
    #[serde(rename_all = "camelCase")]
    Running {
        dns_name: String,
        host_name: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        others: Vec<TailscalePeer>,
    },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ServeTcpEntry {
    #[serde(rename = "HTTPS")]
    pub https: Option<bool>,
    #[serde(rename = "HTTP")]
    pub http: Option<bool>,
    #[serde(rename = "TCPForward")]
    pub tcp_forward: Option<String>,
    #[serde(rename = "TerminateTLS")]
    pub terminate_tls: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ServeHandler {
    #[serde(rename = "Proxy")]
    pub proxy: Option<String>,
    #[serde(rename = "Path")]
    pub path: Option<String>,
    #[serde(rename = "Text")]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ServeWebEntry {
    #[serde(rename = "Handlers")]
    pub handlers: Option<BTreeMap<String, Option<ServeHandler>>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ServeConfig {
    #[serde(rename = "TCP")]
    pub tcp: Option<BTreeMap<String, Option<ServeTcpEntry>>>,
    #[serde(rename = "Web")]
    pub web: Option<BTreeMap<String, Option<ServeWebEntry>>>,
    #[serde(rename = "AllowFunnel")]
    pub allow_funnel: Option<BTreeMap<String, Option<bool>>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServePortOwner {
    Free,
    Ours,
    Taken,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServeResult {
    Ok,
    NotEnabled { enable_url: Option<String> },
    Denied,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServeStatusError {
    AccessDenied,
    Failed(String),
}

pub fn serve_target(loopback_port: u16) -> String {
    format!("http://127.0.0.1:{loopback_port}")
}

fn is_valid_dns_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 253
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

/// Parses `tailscale status --json` matching `parseTailscaleStatus` (`src/main/phones/tailscale.ts`).
pub fn parse_tailscale_status(output: &str) -> TailscaleStatus {
    let Ok(Value::Object(root)) = serde_json::from_str::<Value>(output) else {
        return TailscaleStatus::NotRunning;
    };
    if root.get("BackendState").and_then(Value::as_str) != Some("Running") {
        return TailscaleStatus::NotRunning;
    }
    let self_obj = root.get("Self").and_then(Value::as_object);
    let dns_name = self_obj
        .and_then(|s| s.get("DNSName"))
        .and_then(Value::as_str)
        .map(|s| s.trim_end_matches('.'))
        .unwrap_or("");
    if !is_valid_dns_name(dns_name) {
        return TailscaleStatus::NotRunning;
    }
    let host_name = self_obj
        .and_then(|s| s.get("HostName"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| dns_name.split('.').next().unwrap_or(dns_name).to_string());
    let self_uid = self_obj.and_then(|s| s.get("UserID"));

    let mut others = Vec::new();
    if let Some(Value::Object(peers)) = root.get("Peer") {
        for peer_val in peers.values() {
            if others.len() >= PEERS_MAX {
                break;
            }
            let Some(peer) = peer_val.as_object() else {
                continue;
            };
            if peer.get("UserID") == self_uid {
                continue;
            }
            let Some(raw_dns) = peer.get("DNSName").and_then(Value::as_str) else {
                continue;
            };
            let peer_dns = raw_dns.trim_end_matches('.');
            if !is_valid_dns_name(peer_dns) {
                continue;
            }
            let peer_name = peer
                .get("HostName")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.chars().take(80).collect::<String>())
                .unwrap_or_else(|| peer_dns.split('.').next().unwrap_or(peer_dns).to_string());
            others.push(TailscalePeer {
                name: peer_name,
                dns_name: peer_dns.to_string(),
            });
        }
    }
    TailscaleStatus::Running {
        dns_name: dns_name.to_string(),
        host_name,
        others,
    }
}

/// Parses `tailscale serve status --json` matching `parseServeStatus`.
pub fn parse_serve_status(output: &str) -> Result<ServeConfig, String> {
    let trimmed = output.trim();
    if trimmed.is_empty() {
        return Ok(ServeConfig::default());
    }
    let val: Value = serde_json::from_str(trimmed)
        .map_err(|e| format!("Tailscale Serve status could not be parsed: {e}"))?;
    if !val.is_object() {
        return Err("Tailscale Serve status was not an object.".to_string());
    }
    serde_json::from_value(val)
        .map_err(|e| format!("Tailscale Serve status had unexpected shape: {e}"))
}

/// Evaluates who holds a Tailscale Serve port matching `servePortOwner`.
pub fn serve_port_owner(
    config: &ServeConfig,
    port: u16,
    our_loopback_ports: &[u16],
) -> ServePortOwner {
    let key = port.to_string();
    let suffix = format!(":{key}");
    let tcp = config
        .tcp
        .as_ref()
        .and_then(|m| m.get(&key))
        .and_then(|o| o.as_ref());
    let web_keys: Vec<&str> = config
        .web
        .as_ref()
        .map(|m| {
            m.keys()
                .filter(|k| k.ends_with(&suffix))
                .map(String::as_str)
                .collect()
        })
        .unwrap_or_default();
    let funnel = config.allow_funnel.as_ref().is_some_and(|m| {
        m.iter()
            .any(|(name, on)| *on == Some(true) && name.ends_with(&suffix))
    });
    if tcp.is_none() && web_keys.is_empty() && !funnel {
        return ServePortOwner::Free;
    }
    let Some(tcp_entry) = tcp else {
        return ServePortOwner::Taken;
    };
    if funnel
        || tcp_entry.https != Some(true)
        || tcp_entry.tcp_forward.is_some()
        || web_keys.len() != 1
    {
        return ServePortOwner::Taken;
    }
    let handlers = config
        .web
        .as_ref()
        .and_then(|m| m.get(web_keys[0]))
        .and_then(|o| o.as_ref())
        .and_then(|w| w.handlers.as_ref());
    let Some(handlers_map) = handlers else {
        return ServePortOwner::Taken;
    };
    if handlers_map.len() != 1 {
        return ServePortOwner::Taken;
    }
    let Some((path, Some(handler))) = handlers_map.iter().next() else {
        return ServePortOwner::Taken;
    };
    if path != "/" {
        return ServePortOwner::Taken;
    }
    let Some(ref proxy) = handler.proxy else {
        return ServePortOwner::Taken;
    };
    let target = proxy.trim_end_matches('/');
    if our_loopback_ports
        .iter()
        .any(|&ours| target == serve_target(ours))
    {
        ServePortOwner::Ours
    } else {
        ServePortOwner::Taken
    }
}

pub fn extract_tailscale_consent_url(output: &str) -> Option<String> {
    const PREFIX: &str = "https://login.tailscale.com/";
    let start = output.find(PREFIX)?;
    let rest = &output[start + PREFIX.len()..];
    let len = rest
        .bytes()
        .take_while(|b| {
            b.is_ascii_alphanumeric()
                || matches!(
                    b,
                    b'/' | b'?' | b'=' | b'&' | b'%' | b'.' | b'_' | b'~' | b'-'
                )
        })
        .count();
    if len == 0 {
        return None;
    }
    Some(output[start..start + PREFIX.len() + len].to_string())
}

fn contains_ascii_word_phrase(haystack: &str, phrase: &str) -> bool {
    let h = haystack.to_ascii_lowercase();
    let p = phrase.to_ascii_lowercase();
    let mut offset = 0;
    while let Some(pos) = h[offset..].find(&p) {
        let abs = offset + pos;
        let before_ok = abs == 0
            || !h.as_bytes()[abs - 1].is_ascii_alphanumeric() && h.as_bytes()[abs - 1] != b'_';
        let after_idx = abs + p.len();
        let after_ok = after_idx == h.len()
            || !h.as_bytes()[after_idx].is_ascii_alphanumeric()
                && h.as_bytes()[after_idx] != b'_';
        if before_ok && after_ok {
            return true;
        }
        offset = abs + 1;
    }
    false
}

pub fn is_tailscale_access_denied(output: &str) -> bool {
    contains_ascii_word_phrase(output, "access denied")
}

pub fn is_tailscale_serve_not_enabled(output: &str) -> bool {
    contains_ascii_word_phrase(output, "is not enabled")
        || contains_ascii_word_phrase(output, "isn't enabled")
        || contains_ascii_word_phrase(output, "not enabled")
}

pub trait TailscaleBackend: Send + Sync {
    fn status(&self) -> TailscaleStatus;
    fn serve_status(&self) -> Result<ServeConfig, ServeStatusError>;
    fn serve(&self, port: u16, loopback_port: u16) -> ServeResult;
    fn unserve(&self, port: u16) -> bool;
}

pub struct SystemTailscaleCli {
    candidates: Vec<String>,
    chosen: StdMutex<Option<String>>,
}

impl Default for SystemTailscaleCli {
    fn default() -> Self {
        Self::new()
    }
}

impl SystemTailscaleCli {
    pub fn new() -> Self {
        #[allow(unused_mut)]
        let mut candidates = vec!["tailscale".to_string()];
        #[cfg(windows)]
        {
            let pf = std::env::var("ProgramFiles")
                .unwrap_or_else(|_| r"C:\Program Files".to_string());
            candidates.push(format!(r"{pf}\Tailscale\tailscale.exe"));
        }
        #[cfg(target_os = "macos")]
        {
            candidates.push("/Applications/Tailscale.app/Contents/MacOS/Tailscale".to_string());
        }
        Self {
            candidates,
            chosen: StdMutex::new(None),
        }
    }

    pub fn with_candidates(candidates: Vec<String>) -> Self {
        Self {
            candidates,
            chosen: StdMutex::new(None),
        }
    }

    fn invoke(
        &self,
        args: &[&str],
        timeout: Duration,
        stop_on_consent: bool,
    ) -> Option<(Option<i32>, String, String)> {
        let order: Vec<String> = {
            let guard = self.chosen.lock().ok();
            if let Some(exe) = guard.as_deref().and_then(Option::as_ref) {
                vec![exe.clone()]
            } else {
                self.candidates.clone()
            }
        };
        for candidate in order {
            match run_tailscale_process(&candidate, args, timeout, stop_on_consent) {
                Ok(res) => {
                    if let Ok(mut guard) = self.chosen.lock() {
                        *guard = Some(candidate);
                    }
                    return Some(res);
                }
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Some((None, String::new(), String::new())),
            }
        }
        if let Ok(mut guard) = self.chosen.lock() {
            *guard = None;
        }
        None
    }
}

fn run_tailscale_process(
    executable: &str,
    args: &[&str],
    timeout: Duration,
    stop_on_consent: bool,
) -> std::io::Result<(Option<i32>, String, String)> {
    use std::io::Read;
    let mut cmd = std::process::Command::new(executable);
    cmd.args(args)
        .env("TAILSCALE_BE_CLI", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn()?;
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let shared_seen = Arc::new(StdMutex::new(String::new()));
    let seen_out = Arc::clone(&shared_seen);
    let seen_err = Arc::clone(&shared_seen);

    const MAX_BUF: u64 = 4 * 1024 * 1024;
    let out_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut s) = stdout_pipe {
            let mut chunk = [0u8; 4096];
            while (buf.len() as u64) < MAX_BUF {
                match s.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        buf.extend_from_slice(&chunk[..n]);
                        if stop_on_consent {
                            if let Ok(mut guard) = seen_out.lock() {
                                guard.push_str(&String::from_utf8_lossy(&chunk[..n]));
                            }
                        }
                    }
                }
            }
        }
        String::from_utf8_lossy(&buf).into_owned()
    });
    let err_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut s) = stderr_pipe {
            let mut chunk = [0u8; 4096];
            while (buf.len() as u64) < MAX_BUF {
                match s.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        buf.extend_from_slice(&chunk[..n]);
                        if stop_on_consent {
                            if let Ok(mut guard) = seen_err.lock() {
                                guard.push_str(&String::from_utf8_lossy(&chunk[..n]));
                            }
                        }
                    }
                }
            }
        }
        String::from_utf8_lossy(&buf).into_owned()
    });

    let deadline = Instant::now() + timeout;
    let mut stopped_early = false;
    let exit_code = loop {
        match child.try_wait()? {
            Some(status) => break status.code(),
            None => {
                if Instant::now() >= deadline {
                    stopped_early = true;
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                if stop_on_consent {
                    let has_consent = shared_seen
                        .lock()
                        .ok()
                        .is_some_and(|s| extract_tailscale_consent_url(&s).is_some());
                    if has_consent {
                        stopped_early = true;
                        let _ = child.kill();
                        let _ = child.wait();
                        break None;
                    }
                }
                std::thread::sleep(Duration::from_millis(15));
            }
        }
    };
    let stdout = out_thread.join().unwrap_or_default();
    let stderr = err_thread.join().unwrap_or_default();
    Ok((if stopped_early { None } else { exit_code }, stdout, stderr))
}

impl TailscaleBackend for SystemTailscaleCli {
    fn status(&self) -> TailscaleStatus {
        let Some((_, stdout, _)) = self.invoke(&["status", "--json"], Duration::from_secs(10), false)
        else {
            return TailscaleStatus::Missing;
        };
        parse_tailscale_status(&stdout)
    }

    fn serve_status(&self) -> Result<ServeConfig, ServeStatusError> {
        let Some((code, stdout, stderr)) =
            self.invoke(&["serve", "status", "--json"], Duration::from_secs(10), false)
        else {
            return Err(ServeStatusError::Failed("Tailscale is not installed.".into()));
        };
        if code != Some(0) {
            let combined = format!("{stdout}{stderr}");
            if is_tailscale_access_denied(&combined) {
                return Err(ServeStatusError::AccessDenied);
            }
            return Err(ServeStatusError::Failed(
                "Tailscale Serve status could not be read.".into(),
            ));
        }
        parse_serve_status(&stdout).map_err(ServeStatusError::Failed)
    }

    fn serve(&self, port: u16, loopback_port: u16) -> ServeResult {
        let https_arg = format!("--https={port}");
        let target = serve_target(loopback_port);
        let Some((code, stdout, stderr)) = self.invoke(
            &["serve", "--bg", &https_arg, &target],
            Duration::from_secs(20),
            true,
        ) else {
            return ServeResult::Failed;
        };
        let combined_nl = format!("{stdout}\n{stderr}");
        if let Some(url) = extract_tailscale_consent_url(&combined_nl) {
            return ServeResult::NotEnabled {
                enable_url: Some(url),
            };
        }
        if code == Some(0) {
            return ServeResult::Ok;
        }
        let combined = format!("{stdout}{stderr}");
        if is_tailscale_access_denied(&combined) {
            return ServeResult::Denied;
        }
        if is_tailscale_serve_not_enabled(&combined) {
            return ServeResult::NotEnabled { enable_url: None };
        }
        ServeResult::Failed
    }

    fn unserve(&self, port: u16) -> bool {
        let https_arg = format!("--https={port}");
        matches!(
            self.invoke(&["serve", &https_arg, "off"], Duration::from_secs(10), false),
            Some((Some(0), _, _))
        )
    }
}

// ---------------------------------------------------------------------------
// Shared file helpers & OS hostname
// ---------------------------------------------------------------------------

fn write_atomic_private_json<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut body = serde_json::to_string_pretty(value).map_err(std::io::Error::other)?;
    body.push('\n');
    let tmp = path.with_extension(format!("json.tmp-{}", Uuid::new_v4()));
    let write_res = (|| -> std::io::Result<()> {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&tmp)?;
        file.write_all(body.as_bytes())?;
        file.sync_all()?;
        Ok(())
    })();
    if let Err(err) = write_res {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    if let Err(err) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    Ok(())
}

fn system_hostname() -> String {
    #[cfg(target_os = "linux")]
    if let Ok(name) = fs::read_to_string("/proc/sys/kernel/hostname") {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    for var in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(val) = std::env::var(var) {
            let trimmed = val.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    "This computer".to_string()
}

// ---------------------------------------------------------------------------
// Loopback protocol v1 HTTP listener (admin: false, shared by PhoneAccess & LocalApps)
// ---------------------------------------------------------------------------

struct ListenerCallbacks {
    on_paired: Option<Arc<dyn Fn(String) + Send + Sync>>,
    on_revoked: Option<Arc<dyn Fn(String) + Send + Sync>>,
}

struct LoopbackListenerState {
    host_id: String,
    computer_name: StdMutex<String>,
    sotto_version: String,
    allow_pairing: StdMutex<bool>,
    serving: StdMutex<bool>,
    pairing: Arc<StdMutex<PairedClients>>,
    coordinator: Option<CoordinatorHandle>,
    memory_db_path: PathBuf,
    callbacks: ListenerCallbacks,
}

/// Loopback-only protocol v1 HTTP listener (`127.0.0.1`, `admin: false`) used by `PhoneAccessManager`
/// and `LocalAppsManager`. Supports `stop_serving()` (holding the TCP port reserved while refusing
/// protocol requests) and full `close()`.
pub struct LoopbackPhoneListener {
    pub port: u16,
    state: Arc<LoopbackListenerState>,
    stop_notify: Arc<Notify>,
    accept_task: Option<JoinHandle<()>>,
}

impl LoopbackPhoneListener {
    #[allow(clippy::too_many_arguments)]
    pub async fn bind(
        preferred_port: Option<u16>,
        host_id: String,
        computer_name: String,
        allow_pairing: bool,
        pairing: Arc<StdMutex<PairedClients>>,
        coordinator: Option<CoordinatorHandle>,
        memory_db_path: PathBuf,
        on_paired: Option<Arc<dyn Fn(String) + Send + Sync>>,
        on_revoked: Option<Arc<dyn Fn(String) + Send + Sync>>,
    ) -> std::io::Result<Self> {
        let listener = match preferred_port {
            Some(p) if p > 0 => match TcpListener::bind(("127.0.0.1", p)).await {
                Ok(l) => l,
                Err(_) => TcpListener::bind(("127.0.0.1", 0)).await?,
            },
            _ => TcpListener::bind(("127.0.0.1", 0)).await?,
        };
        let port = listener.local_addr()?.port();
        let state = Arc::new(LoopbackListenerState {
            host_id,
            computer_name: StdMutex::new(computer_name),
            sotto_version: DEFAULT_SOTTO_VERSION.to_string(),
            allow_pairing: StdMutex::new(allow_pairing),
            serving: StdMutex::new(true),
            pairing,
            coordinator,
            memory_db_path,
            callbacks: ListenerCallbacks {
                on_paired,
                on_revoked,
            },
        });
        let stop_notify = Arc::new(Notify::new());
        let task_state = Arc::clone(&state);
        let task_stop = Arc::clone(&stop_notify);
        let accept_task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = task_stop.notified() => break,
                    accepted = listener.accept() => {
                        let Ok((stream, _peer)) = accepted else {
                            continue;
                        };
                        let st = Arc::clone(&task_state);
                        tokio::spawn(async move {
                            let _ = handle_loopback_http(stream, st).await;
                        });
                    }
                }
            }
        });
        Ok(Self {
            port,
            state,
            stop_notify,
            accept_task: Some(accept_task),
        })
    }

    pub fn set_computer_name(&self, name: String) {
        if let Ok(mut guard) = self.state.computer_name.lock() {
            *guard = name;
        }
    }

    pub fn set_allow_pairing(&self, allow: bool) {
        if let Ok(mut guard) = self.state.allow_pairing.lock() {
            *guard = allow;
        }
    }

    /// Stops serving protocol responses while keeping the loopback port bound (reservation).
    pub fn stop_serving(&self) {
        if let Ok(mut guard) = self.state.serving.lock() {
            *guard = false;
        }
    }

    pub fn is_serving(&self) -> bool {
        self.state.serving.lock().map(|g| *g).unwrap_or(false)
    }

    pub async fn close(&mut self) {
        self.stop_serving();
        self.stop_notify.notify_waiters();
        if let Some(handle) = self.accept_task.take() {
            handle.abort();
            let _ = handle.await;
        }
    }
}

impl Drop for LoopbackPhoneListener {
    fn drop(&mut self) {
        self.stop_serving();
        self.stop_notify.notify_waiters();
        if let Some(handle) = self.accept_task.take() {
            handle.abort();
        }
    }
}

async fn handle_loopback_http(
    mut stream: TcpStream,
    state: Arc<LoopbackListenerState>,
) -> std::io::Result<()> {
    if !state.serving.lock().map(|g| *g).unwrap_or(false) {
        return Ok(());
    }
    let Some((method, raw_path, headers, body)) = read_http_request(&mut stream).await? else {
        return Ok(());
    };
    let path = raw_path.split('?').next().unwrap_or(&raw_path);

    let (status, payload) = match (method.as_str(), path) {
        ("GET", "/v1/health") => {
            let name = state
                .computer_name
                .lock()
                .map(|g| g.clone())
                .unwrap_or_default();
            let allow_pairing = state.allow_pairing.lock().map(|g| *g).unwrap_or(false);
            (
                200u16,
                json!({
                    "ok": true,
                    "protocolVersion": HOST_PROTOCOL_VERSION,
                    "hostId": state.host_id,
                    "name": name,
                    "sottoVersion": state.sotto_version,
                    "pairing": allow_pairing,
                }),
            )
        }
        ("POST", "/v1/pair") => {
            let allow_pairing = state.allow_pairing.lock().map(|g| *g).unwrap_or(false);
            if !allow_pairing {
                (
                    403,
                    json!({ "error": { "code": "PAIRING_DISABLED", "message": "Pairing is disabled." } }),
                )
            } else if let Ok(Value::Object(map)) = serde_json::from_slice::<Value>(&body) {
                let code = map.get("code").and_then(Value::as_str).unwrap_or("");
                let name = map.get("name").and_then(Value::as_str).unwrap_or("");
                let res = {
                    let mut guard = state.pairing.lock().unwrap();
                    guard.redeem_pairing_code(code, name)
                };
                match res {
                    Ok(paired) => {
                        if let Some(ref cb) = state.callbacks.on_paired {
                            cb(paired.client_id.clone());
                        }
                        (
                            200,
                            json!({
                                "clientId": paired.client_id,
                                "name": paired.name,
                                "token": paired.token,
                            }),
                        )
                    }
                    Err(PairingError::CodeRejected) => (
                        401,
                        json!({ "error": { "code": "PAIRING_CODE_REJECTED", "message": crate::pairing::PAIRING_CODE_REJECTED } }),
                    ),
                    Err(err) => (
                        400,
                        json!({ "error": { "code": "PAIRING_FAILED", "message": err.to_string() } }),
                    ),
                }
            } else {
                (
                    400,
                    json!({ "error": { "code": "INVALID_REQUEST", "message": "Invalid JSON body." } }),
                )
            }
        }
        ("POST", "/v1/session") => {
            let bearer = extract_bearer_token(&headers);
            let res = {
                let mut guard = state.pairing.lock().unwrap();
                bearer
                    .and_then(|tok| guard.verify_token(tok))
                    .and_then(|cid| guard.issue_session(&cid).map(|s| (cid, s)))
            };
            match res {
                Some((client_id, session)) => (
                    200,
                    json!({
                        "clientId": client_id,
                        "session": session.session,
                        "expiresAt": session.expires_at,
                    }),
                ),
                None => (
                    401,
                    json!({ "error": { "code": "UNAUTHORIZED", "message": "Invalid client token." } }),
                ),
            }
        }
        ("POST", "/v1/revoke") => {
            let bearer = extract_bearer_token(&headers);
            let revoked_id = {
                let mut guard = state.pairing.lock().unwrap();
                let cid = bearer.and_then(|tok| guard.verify_token(tok));
                if let Some(ref id) = cid {
                    let _ = guard.revoke(id);
                }
                cid
            };
            match revoked_id {
                Some(client_id) => {
                    if let Some(ref cb) = state.callbacks.on_revoked {
                        cb(client_id);
                    }
                    (200, json!({ "ok": true }))
                }
                None => (
                    401,
                    json!({ "error": { "code": "UNAUTHORIZED", "message": "Invalid client token." } }),
                ),
            }
        }
        ("GET", "/v1/state") => {
            let bearer = extract_bearer_token(&headers);
            let verified = {
                let mut guard = state.pairing.lock().unwrap();
                bearer.and_then(|sess| guard.verify_session(sess))
            };
            match verified {
                Some(client_id) => {
                    let db = state.memory_db_path.clone();
                    let cid = client_id.clone();
                    let may_answer = tokio::task::spawn_blocking(move || {
                        MemoryStore::open_read_only(&db)
                            .ok()
                            .and_then(|m| m.may_grant_remote(&cid).ok())
                            .unwrap_or(false)
                    })
                    .await
                    .unwrap_or(false);
                    if let Some(ref coord) = state.coordinator {
                        match coord.shell(may_answer).await {
                            Ok(shell) => (200, shell),
                            Err(err) => (
                                500,
                                json!({ "error": { "code": "UNAVAILABLE", "message": err.message } }),
                            ),
                        }
                    } else {
                        (
                            200,
                            json!({
                                "hostId": state.host_id,
                                "mayAnswer": may_answer,
                                "clientId": client_id,
                            }),
                        )
                    }
                }
                None => (
                    401,
                    json!({ "error": { "code": "UNAUTHORIZED", "message": "Invalid session." } }),
                ),
            }
        }
        _ => (
            404,
            json!({ "error": { "code": "NOT_FOUND", "message": "Route not found." } }),
        ),
    };

    write_json_response(&mut stream, status, &payload).await
}

async fn read_http_request(
    stream: &mut TcpStream,
) -> std::io::Result<Option<(String, String, HashMap<String, String>, Vec<u8>)>> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 2048];
    let header_end = loop {
        let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut chunk))
            .await
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "http read timeout"))??;
        if n == 0 {
            return Ok(None);
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos;
        }
        if buf.len() > MAX_HTTP_HEADER_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "http headers too large",
            ));
        }
    };
    let head_str = String::from_utf8_lossy(&buf[..header_end]);
    let mut lines = head_str.split("\r\n");
    let first = lines.next().unwrap_or("");
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    if method.is_empty() || path.is_empty() {
        return Ok(None);
    }
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    let content_len: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if content_len > MAX_HTTP_BODY_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "http body too large",
        ));
    }
    let mut body = buf[header_end + 4..].to_vec();
    while body.len() < content_len {
        let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut chunk))
            .await
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "http body timeout"))??;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
        if body.len() > MAX_HTTP_BODY_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "http body too large",
            ));
        }
    }
    body.truncate(content_len);
    Ok(Some((method, path, headers, body)))
}

fn extract_bearer_token(headers: &HashMap<String, String>) -> Option<&str> {
    let auth = headers.get("authorization")?;
    let (scheme, tok) = auth.split_once(' ')?;
    if scheme.eq_ignore_ascii_case("bearer") && !tok.trim().is_empty() {
        Some(tok.trim())
    } else {
        None
    }
}

async fn write_json_response(
    stream: &mut TcpStream,
    status: u16,
    payload: &Value,
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Internal Server Error",
    };
    let body = serde_json::to_vec(payload).unwrap_or_else(|_| b"{}".to_vec());
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes()).await?;
    stream.write_all(&body).await?;
    stream.flush().await
}

// ---------------------------------------------------------------------------
// PhoneAccessManager (`src/main/phones/phoneAccess.ts`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhoneAccessRecord {
    pub port: Option<u16>,
    pub mapped: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serve_port: Option<u16>,
}

impl PhoneAccessRecord {
    fn serve_port_or_default(&self) -> u16 {
        match self.serve_port {
            Some(10000) => 10000,
            _ => 8443,
        }
    }

    fn with_port(port: Option<u16>, mapped: bool, serve_port: u16) -> Self {
        Self {
            port,
            mapped,
            serve_port: if serve_port == 8443 {
                None
            } else {
                Some(serve_port)
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum TailscaleCheck {
    Waiting,
    #[serde(rename_all = "camelCase")]
    Ok {
        host_name: String,
        dns_name: String,
    },
    Failed {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum ServeCheck {
    Waiting,
    Ok,
    #[serde(rename_all = "camelCase")]
    Failed {
        reason: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        can_open_setup: Option<bool>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedPhoneView {
    pub client_id: String,
    pub name: String,
    pub paired_at: String,
    pub connected: bool,
    pub can_answer: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhonesState {
    pub enabled: bool,
    pub local_host_running: bool,
    pub phase: String,
    pub tailscale: TailscaleCheck,
    pub serve: ServeCheck,
    pub serve_port: Option<u16>,
    pub address: Option<String>,
    pub computer_name: String,
    pub default_name: String,
    pub code: Option<PairingCode>,
    pub phones: Vec<PairedPhoneView>,
    pub answers_available: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneAccessBrief {
    pub enabled: bool,
    pub phase: String,
    pub address: Option<String>,
    pub phones: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneAccessSettings {
    #[serde(default)]
    pub phone_access: bool,
    #[serde(default)]
    pub phone_access_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum PhonesCommand {
    Retry,
    ShowCode,
    CancelCode,
    #[serde(rename_all = "camelCase")]
    Remove {
        client_id: String,
    },
    OpenServeSetup,
}

pub struct PhoneAccessCommandOutcome {
    pub state: PhonesState,
    pub open_external_url: Option<String>,
}

pub struct PhoneAccessManager {
    directory: PathBuf,
    record_path: PathBuf,
    memory_db_path: PathBuf,
    host_id: String,
    local_host_running: bool,
    coordinator: Option<CoordinatorHandle>,
    tailscale: Arc<dyn TailscaleBackend>,
    hostname: String,
    settings: PhoneAccessSettings,
    pairing: Option<Arc<StdMutex<PairedClients>>>,
    record: PhoneAccessRecord,
    record_uncertain: bool,
    former_ports: HashSet<u16>,
    listener: Option<LoopbackPhoneListener>,
    reserved_listener: Option<TcpListener>,
    listener_stopped: bool,
    phase: String,
    tailscale_check: TailscaleCheck,
    serve_check: ServeCheck,
    serve_port: Option<u16>,
    address: Option<String>,
    enable_url: Option<String>,
    active_code: Arc<StdMutex<Option<PairingCode>>>,
    closed: bool,
}

impl PhoneAccessManager {
    pub fn new(
        directory: PathBuf,
        host_id: String,
        local_host_running: bool,
        coordinator: Option<CoordinatorHandle>,
        tailscale: Arc<dyn TailscaleBackend>,
    ) -> Self {
        let record_path = directory.join("phone-access.json");
        let memory_db_path = directory.join("memory.sqlite");
        Self {
            directory,
            record_path,
            memory_db_path,
            host_id,
            local_host_running,
            coordinator,
            tailscale,
            hostname: system_hostname(),
            settings: PhoneAccessSettings::default(),
            pairing: None,
            record: PhoneAccessRecord::default(),
            record_uncertain: false,
            former_ports: HashSet::new(),
            listener: None,
            reserved_listener: None,
            listener_stopped: false,
            phase: "off".to_string(),
            tailscale_check: TailscaleCheck::Waiting,
            serve_check: ServeCheck::Waiting,
            serve_port: None,
            address: None,
            enable_url: None,
            active_code: Arc::new(StdMutex::new(None)),
            closed: false,
        }
    }

    pub fn with_hostname(mut self, hostname: impl Into<String>) -> Self {
        self.hostname = hostname.into();
        self
    }

    pub async fn start(&mut self, settings: PhoneAccessSettings) {
        self.settings = settings;
        if self.record_path.exists() {
            match fs::read_to_string(&self.record_path)
                .ok()
                .and_then(|t| serde_json::from_str::<PhoneAccessRecord>(&t).ok())
            {
                Some(rec) => {
                    if rec.serve_port.is_some_and(|p| p != 10000)
                        || rec.port == Some(0)
                    {
                        self.record_uncertain = true;
                    } else {
                        self.record = rec;
                    }
                }
                None => {
                    self.record_uncertain = true;
                }
            }
        }
        if self.record.mapped && self.record.port.is_none() {
            self.record_uncertain = true;
        }
        if self.record_uncertain {
            self.record.mapped = true;
        }
        if self.record.mapped {
            self.reserve_port().await;
            self.phase = "cleanup-failed".to_string();
        }
        if self.local_host_running {
            let _ = self.load_pairing();
        }
        self.answer_paired_phones();
        self.reconcile().await;
    }

    pub async fn settings_changed(&mut self, settings: PhoneAccessSettings) -> PhonesState {
        self.settings = settings;
        if let Some(ref listener) = self.listener {
            listener.set_computer_name(self.computer_name());
            listener.set_allow_pairing(self.phones_wanted());
        }
        if !self.phones_wanted() {
            self.cancel_code();
            if let Some(ref listener) = self.listener {
                listener.stop_serving();
                self.listener_stopped = true;
            }
        }
        self.reconcile().await;
        self.get()
    }

    pub fn page_port(&self) -> Option<u16> {
        self.listener
            .as_ref()
            .filter(|l| !self.listener_stopped && self.phones_wanted() && l.is_serving())
            .map(|l| l.port)
    }

    pub fn serve_setup_url(&self) -> Option<String> {
        match &self.serve_check {
            ServeCheck::Failed { reason, .. } if reason == "not-enabled" => self.enable_url.clone(),
            _ => None,
        }
    }

    pub fn brief(&self) -> PhoneAccessBrief {
        let count = self
            .pairing
            .as_ref()
            .and_then(|p| p.lock().ok())
            .map(|g| g.list().len())
            .unwrap_or(0);
        let phase = if self.listener_stopped && self.phase == "on" && self.phones_wanted() {
            "starting".to_string()
        } else {
            self.phase.clone()
        };
        PhoneAccessBrief {
            enabled: self.settings.phone_access,
            phase,
            address: if self.listener_stopped {
                None
            } else {
                self.address.clone()
            },
            phones: count,
        }
    }

    pub fn get(&mut self) -> PhonesState {
        // Expire in-memory pairing code once past `expiresAt`.
        let active_code = {
            let mut guard = self.active_code.lock().unwrap();
            if let Some(ref code) = *guard {
                if DateTime::parse_from_rfc3339(&code.expires_at)
                    .is_ok_and(|dt| dt.timestamp_millis() <= Utc::now().timestamp_millis())
                {
                    *guard = None;
                }
            }
            guard.clone()
        };
        let policy_store = self.open_memory_read_only();
        let answers_available = policy_store.is_some() || !self.memory_db_path.exists();
        let phones: Vec<PairedPhoneView> = match self.pairing.as_ref().and_then(|p| p.lock().ok()) {
            Some(guard) => guard
                .list()
                .iter()
                .map(|client| {
                    let can_answer = policy_store
                        .as_ref()
                        .and_then(|store| store.may_grant_remote(&client.client_id).ok())
                        .unwrap_or(false);
                    PairedPhoneView {
                        client_id: client.client_id.clone(),
                        name: client.name.clone(),
                        paired_at: client.paired_at.clone(),
                        connected: false,
                        can_answer,
                    }
                })
                .collect(),
            None => Vec::new(),
        };
        let phase = if self.listener_stopped && self.phase == "on" && self.phones_wanted() {
            "starting".to_string()
        } else {
            self.phase.clone()
        };
        PhonesState {
            enabled: self.settings.phone_access,
            local_host_running: self.local_host_running,
            phase,
            tailscale: self.tailscale_check.clone(),
            serve: self.serve_check.clone(),
            serve_port: self.serve_port,
            address: if self.listener_stopped {
                None
            } else {
                self.address.clone()
            },
            computer_name: self.computer_name(),
            default_name: self.default_name(),
            code: active_code,
            phones,
            answers_available,
        }
    }

    pub async fn command(&mut self, cmd: PhonesCommand) -> Result<PhoneAccessCommandOutcome, String> {
        let mut open_external_url = None;
        match cmd {
            PhonesCommand::Retry => {
                if self.phase == "cleanup-failed" {
                    self.reconcile().await;
                } else if self.phones_wanted() {
                    self.turn_on().await;
                }
            }
            PhonesCommand::ShowCode => {
                if self.phase != "on"
                    || !self.phones_wanted()
                    || self.listener_stopped
                    || self.pairing.is_none()
                {
                    return Err(
                        "Turn on Let phones connect first, then show a pairing code.".to_string(),
                    );
                }
                self.cancel_code();
                let code = {
                    let pairing = self.pairing.as_ref().unwrap();
                    let mut guard = pairing.lock().unwrap();
                    guard.issue_pairing_code()
                };
                *self.active_code.lock().unwrap() = Some(code);
            }
            PhonesCommand::CancelCode => {
                self.cancel_code();
            }
            PhonesCommand::Remove { client_id } => {
                let Some(ref pairing) = self.pairing else {
                    return Err(
                        "Paired phones could not be read. Nothing was changed. Restart Sotto and try again."
                            .to_string(),
                    );
                };
                {
                    let mut guard = pairing.lock().unwrap();
                    guard
                        .revoke(&client_id)
                        .map_err(|e| format!("Could not remove paired phone: {e}"))?;
                }
                if let Ok(store) = MemoryStore::open(&self.memory_db_path) {
                    let _ = store.set_remote_answers(&client_id, false, PHONE_ANSWERS_NOTE);
                }
            }
            PhonesCommand::OpenServeSetup => {
                let Some(url) = self.serve_setup_url() else {
                    return Err(
                        "Tailscale did not give a page to open. Open the Tailscale admin console to turn on Serve."
                            .to_string(),
                    );
                };
                open_external_url = Some(url);
            }
        }
        Ok(PhoneAccessCommandOutcome {
            state: self.get(),
            open_external_url,
        })
    }

    pub async fn close(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        self.cancel_code();
        self.reserve_port().await;
        self.turn_off().await;
        if !self.record.mapped {
            self.close_listener().await;
            self.release_port().await;
        }
    }

    fn phones_wanted(&self) -> bool {
        !self.closed && self.settings.phone_access && self.local_host_running
    }

    fn default_name(&self) -> String {
        match &self.tailscale_check {
            TailscaleCheck::Ok { host_name, .. } => host_name.clone(),
            _ => self.hostname.clone(),
        }
    }

    fn computer_name(&self) -> String {
        let trimmed = self.settings.phone_access_name.trim();
        if trimmed.is_empty() {
            self.default_name()
        } else {
            trimmed.to_string()
        }
    }

    fn open_memory_read_only(&self) -> Option<MemoryStore> {
        if !self.memory_db_path.exists() {
            return None;
        }
        MemoryStore::open_read_only(&self.memory_db_path).ok()
    }

    fn load_pairing(&mut self) -> bool {
        if self.pairing.is_some() {
            return true;
        }
        match PairedClients::load(&self.directory) {
            Ok(store) => {
                self.pairing = Some(Arc::new(StdMutex::new(store)));
                self.answer_paired_phones();
                true
            }
            Err(_) => false,
        }
    }

    fn answer_paired_phones(&self) {
        let Some(ref pairing) = self.pairing else {
            return;
        };
        let client_ids: Vec<String> = pairing
            .lock()
            .map(|g| g.list().iter().map(|c| c.client_id.clone()).collect())
            .unwrap_or_default();
        if client_ids.is_empty() {
            return;
        }
        if let Ok(store) = MemoryStore::open(&self.memory_db_path) {
            for cid in client_ids {
                let _ = store.ensure_remote_answers(&cid, PHONE_ANSWERS_NOTE);
            }
        }
    }

    fn cancel_code(&mut self) {
        let taken = self.active_code.lock().ok().and_then(|mut g| g.take());
        if let Some(code) = taken {
            if let Some(ref pairing) = self.pairing {
                if let Ok(mut guard) = pairing.lock() {
                    guard.cancel_pairing_code(&code.code);
                }
            }
        }
    }

    fn our_ports(&self) -> Vec<u16> {
        let mut set: HashSet<u16> = self.former_ports.clone();
        if let Some(p) = self.record.port {
            set.insert(p);
        }
        if let Some(ref l) = self.listener {
            set.insert(l.port);
        }
        set.into_iter().collect()
    }

    fn save_record(&mut self, rec: PhoneAccessRecord) -> bool {
        if write_atomic_private_json(&self.record_path, &rec).is_err() {
            return false;
        }
        if let Some(prev) = self.record.port {
            if Some(prev) != rec.port {
                self.former_ports.insert(prev);
            }
        }
        self.record = rec;
        true
    }

    fn reset(&mut self, phase: &str) {
        if phase == "off" {
            self.listener_stopped = false;
        }
        self.phase = phase.to_string();
        self.tailscale_check = TailscaleCheck::Waiting;
        self.serve_check = ServeCheck::Waiting;
        self.address = None;
        self.serve_port = None;
        self.enable_url = None;
    }

    async fn reconcile(&mut self) {
        if self.phase == "cleanup-failed"
            && !self.listener_stopped
            && !self.record_uncertain
            && self.phones_wanted()
        {
            self.turn_on().await;
            return;
        }
        if self.phase == "cleanup-failed" || self.listener_stopped {
            self.turn_off().await;
            if self.phase == "cleanup-failed" {
                return;
            }
        }
        if self.phones_wanted() {
            if self.phase == "off" {
                self.turn_on().await;
            }
        } else if self.phase != "off" || self.listener.is_some() || self.record.mapped {
            self.turn_off().await;
        }
    }

    async fn turn_on(&mut self) {
        if self.listener_stopped || !self.phones_wanted() {
            self.turn_off().await;
            if self.phase == "cleanup-failed" || !self.phones_wanted() {
                return;
            }
        }
        self.reset("starting");
        let ts_backend = Arc::clone(&self.tailscale);
        let status = tokio::task::spawn_blocking(move || ts_backend.status())
            .await
            .unwrap_or(TailscaleStatus::NotRunning);
        let (dns_name, host_name) = match status {
            TailscaleStatus::Running {
                dns_name,
                host_name,
                ..
            } => (dns_name, host_name),
            TailscaleStatus::Missing => {
                self.tailscale_check = TailscaleCheck::Failed {
                    reason: "missing".to_string(),
                };
                self.fail().await;
                return;
            }
            TailscaleStatus::NotRunning => {
                self.tailscale_check = TailscaleCheck::Failed {
                    reason: "not-running".to_string(),
                };
                self.fail().await;
                return;
            }
        };
        self.tailscale_check = TailscaleCheck::Ok {
            host_name,
            dns_name: dns_name.clone(),
        };

        let ts_backend = Arc::clone(&self.tailscale);
        let serve_cfg = match tokio::task::spawn_blocking(move || ts_backend.serve_status()).await {
            Ok(Ok(cfg)) => cfg,
            Ok(Err(ServeStatusError::AccessDenied)) => {
                self.fail_serve("denied").await;
                return;
            }
            _ => {
                self.fail_serve("failed").await;
                return;
            }
        };

        let last = self.record.serve_port_or_default();
        let mut ports = vec![last];
        for &p in &PHONE_ACCESS_SERVE_PORTS {
            if p != last {
                ports.push(p);
            }
        }
        let our_ports = self.our_ports();
        let owners: Vec<(u16, ServePortOwner)> = ports
            .into_iter()
            .map(|p| (p, serve_port_owner(&serve_cfg, p, &our_ports)))
            .collect();
        let chosen = owners
            .iter()
            .find(|(_, o)| *o == ServePortOwner::Ours)
            .or_else(|| owners.iter().find(|(_, o)| *o == ServePortOwner::Free))
            .copied();
        let Some((serve_port, owner)) = chosen else {
            self.fail_serve("port-taken").await;
            return;
        };
        self.serve_port = Some(serve_port);
        if owner == ServePortOwner::Ours {
            self.record = PhoneAccessRecord::with_port(self.record.port, true, serve_port);
        }
        if self.listener.is_none() {
            if !self.load_pairing() {
                self.fail_serve("listener").await;
                return;
            }
            self.release_port().await;
            let pairing = Arc::clone(self.pairing.as_ref().unwrap());
            let mem_db = self.memory_db_path.clone();
            let active_code_slot = Arc::clone(&self.active_code);
            let on_paired: Arc<dyn Fn(String) + Send + Sync> = Arc::new(move |client_id| {
                if let Ok(store) = MemoryStore::open(&mem_db) {
                    let _ = store.ensure_remote_answers(&client_id, PHONE_ANSWERS_NOTE);
                }
                if let Ok(mut g) = active_code_slot.lock() {
                    *g = None;
                }
            });
            match LoopbackPhoneListener::bind(
                self.record.port,
                self.host_id.clone(),
                self.computer_name(),
                true,
                pairing,
                self.coordinator.clone(),
                self.memory_db_path.clone(),
                Some(on_paired),
                None,
            )
            .await
            {
                Ok(l) => self.listener = Some(l),
                Err(_) => {
                    self.fail_serve("listener").await;
                    return;
                }
            }
        }
        let port = self.listener.as_ref().unwrap().port;
        if !self.save_record(PhoneAccessRecord::with_port(Some(port), true, serve_port)) {
            self.fail_serve("record").await;
            return;
        }
        let already_carries =
            owner == ServePortOwner::Ours && serve_port_owner(&serve_cfg, serve_port, &[port]) == ServePortOwner::Ours;
        let result = if already_carries {
            ServeResult::Ok
        } else {
            let ts_backend = Arc::clone(&self.tailscale);
            tokio::task::spawn_blocking(move || ts_backend.serve(serve_port, port))
                .await
                .unwrap_or(ServeResult::Failed)
        };
        match result {
            ServeResult::Ok => {
                self.serve_check = ServeCheck::Ok;
                self.address = Some(format!("https://{dns_name}:{serve_port}"));
                self.phase = "on".to_string();
            }
            ServeResult::NotEnabled { enable_url } => {
                self.enable_url = enable_url;
                let _ = self.save_record(PhoneAccessRecord::with_port(
                    Some(port),
                    owner == ServePortOwner::Ours,
                    serve_port,
                ));
                self.fail_serve("not-enabled").await;
            }
            ServeResult::Denied => {
                let _ = self.save_record(PhoneAccessRecord::with_port(
                    Some(port),
                    owner == ServePortOwner::Ours,
                    serve_port,
                ));
                self.fail_serve("denied").await;
            }
            ServeResult::Failed => {
                self.fail_serve("failed").await;
            }
        }
    }

    async fn fail_serve(&mut self, reason: &str) {
        self.serve_check = ServeCheck::Failed {
            reason: reason.to_string(),
            can_open_setup: self.enable_url.as_ref().map(|_| true),
        };
        self.fail().await;
    }

    async fn fail(&mut self) {
        self.phase = "failed".to_string();
        self.reserve_port().await;
        if !self.remove_mapping().await {
            self.cleanup_failed();
            return;
        }
        self.release_port().await;
        self.close_listener().await;
    }

    async fn turn_off(&mut self) {
        self.cancel_code();
        self.reserve_port().await;
        if !self.remove_mapping().await {
            self.cleanup_failed();
            return;
        }
        self.release_port().await;
        self.close_listener().await;
        self.reset("off");
    }

    async fn remove_mapping(&mut self) -> bool {
        if !self.record.mapped {
            return true;
        }
        if self.record_uncertain {
            if let Ok(text) = fs::read_to_string(&self.record_path) {
                if let Ok(rec) = serde_json::from_str::<PhoneAccessRecord>(&text) {
                    if rec.port.is_some() {
                        self.record = PhoneAccessRecord {
                            port: rec.port,
                            mapped: true,
                            serve_port: rec.serve_port,
                        };
                        self.record_uncertain = false;
                        self.reserve_port().await;
                    }
                }
            }
        }
        let ts_backend = Arc::clone(&self.tailscale);
        let Ok(Ok(config)) =
            tokio::task::spawn_blocking(move || ts_backend.serve_status()).await
        else {
            return false;
        };
        let ports: Vec<u16> = if self.record_uncertain {
            PHONE_ACCESS_SERVE_PORTS.to_vec()
        } else {
            vec![self.record.serve_port_or_default()]
        };
        let our_ports = self.our_ports();
        let mut unattributed = false;
        for port in ports {
            match serve_port_owner(&config, port, &our_ports) {
                ServePortOwner::Ours => {
                    let ts_backend = Arc::clone(&self.tailscale);
                    let ok = tokio::task::spawn_blocking(move || ts_backend.unserve(port))
                        .await
                        .unwrap_or(false);
                    if !ok {
                        return false;
                    }
                }
                ServePortOwner::Taken => unattributed = true,
                ServePortOwner::Free => {}
            }
        }
        if self.record_uncertain && unattributed {
            return false;
        }
        let next = PhoneAccessRecord {
            mapped: false,
            ..self.record.clone()
        };
        if !self.save_record(next) {
            return false;
        }
        self.record_uncertain = false;
        true
    }

    fn cleanup_failed(&mut self) {
        self.phase = "cleanup-failed".to_string();
        self.address = None;
        self.cancel_code();
        self.serve_check = ServeCheck::Failed {
            reason: if self.record_uncertain {
                "cleanup-record".to_string()
            } else {
                "cleanup".to_string()
            },
            can_open_setup: None,
        };
    }

    async fn reserve_port(&mut self) {
        if let Some(ref listener) = self.listener {
            listener.stop_serving();
            return;
        }
        if self.reserved_listener.is_some() || !self.record.mapped {
            return;
        }
        let Some(port) = self.record.port else {
            return;
        };
        if let Ok(l) = TcpListener::bind(("127.0.0.1", port)).await {
            self.reserved_listener = Some(l);
        }
    }

    async fn release_port(&mut self) {
        self.reserved_listener = None;
    }

    async fn close_listener(&mut self) {
        if let Some(mut listener) = self.listener.take() {
            listener.close().await;
        }
    }
}

// ---------------------------------------------------------------------------
// LocalAppsManager (`src/main/phones/localApps.ts`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalAppsFile {
    pub version: u32,
    pub port: u16,
    pub token: String,
    pub client_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAppsState {
    pub phase: String,
    pub local_host_running: bool,
}

pub struct LocalAppsManager {
    file_path: PathBuf,
    pairing_dir: PathBuf,
    store_path: PathBuf,
    memory_db_path: PathBuf,
    host_id: String,
    local_host_running: bool,
    coordinator: Option<CoordinatorHandle>,
    enabled: bool,
    pairing: Option<Arc<StdMutex<PairedClients>>>,
    listener: Option<LoopbackPhoneListener>,
    phase: String,
    closed: bool,
}

impl LocalAppsManager {
    pub fn new(
        directory: PathBuf,
        host_id: String,
        local_host_running: bool,
        coordinator: Option<CoordinatorHandle>,
    ) -> Self {
        let file_path = directory.join("local-apps.json");
        let pairing_dir = directory.join("local-apps");
        let store_path = pairing_dir.join("paired-clients.json");
        let memory_db_path = directory.join("memory.sqlite");
        Self {
            file_path,
            pairing_dir,
            store_path,
            memory_db_path,
            host_id,
            local_host_running,
            coordinator,
            enabled: false,
            pairing: None,
            listener: None,
            phase: "off".to_string(),
            closed: false,
        }
    }

    pub fn get(&self) -> LocalAppsState {
        LocalAppsState {
            phase: self.phase.clone(),
            local_host_running: self.local_host_running,
        }
    }

    pub async fn start(&mut self, enabled: bool) -> LocalAppsState {
        self.enabled = enabled;
        self.reconcile().await;
        self.get()
    }

    pub async fn settings_changed(&mut self, enabled: bool) -> LocalAppsState {
        self.enabled = enabled;
        self.reconcile().await;
        self.get()
    }

    /// On quit: closes the listener only; keeps `local-apps.json` and `local-apps/paired-clients.json`
    /// so the next start keeps the same client, token, and preferred port (ADR-0180).
    pub async fn close(&mut self) {
        self.closed = true;
        self.close_listener().await;
    }

    async fn reconcile(&mut self) {
        if self.closed {
            return;
        }
        if !self.enabled {
            self.turn_off().await;
            return;
        }
        if self.local_host_running && self.phase == "off" {
            self.turn_on().await;
        }
    }

    async fn turn_on(&mut self) {
        let Some(pairing) = self.load_pairing() else {
            self.phase = "failed".to_string();
            return;
        };
        let saved = self.read_file();
        let preferred_port = saved.as_ref().map(|f| f.port);

        let pairing_for_revoke = Arc::clone(&pairing);
        let file_path_for_revoke = self.file_path.clone();
        let mem_db_for_revoke = self.memory_db_path.clone();
        let port_cell: Arc<StdMutex<u16>> = Arc::new(StdMutex::new(0));
        let port_for_revoke = Arc::clone(&port_cell);
        let on_revoked: Arc<dyn Fn(String) + Send + Sync> = Arc::new(move |revoked_client_id| {
            let port = port_for_revoke.lock().map(|g| *g).unwrap_or(0);
            if port == 0 {
                return;
            }
            if let Ok(store) = MemoryStore::open(&mem_db_for_revoke) {
                let _ = store.set_remote_answers(&revoked_client_id, false, LOCAL_APPS_ANSWERS_NOTE);
            }
            let new_pair = {
                let mut guard = pairing_for_revoke.lock().unwrap();
                let ids: Vec<String> = guard.list().iter().map(|c| c.client_id.clone()).collect();
                for id in ids {
                    let _ = guard.revoke(&id);
                }
                let code = guard.issue_pairing_code();
                guard.redeem_pairing_code(&code.code, LOCAL_APPS_CLIENT_NAME).ok()
            };
            if let Some(paired) = new_pair {
                if let Ok(store) = MemoryStore::open(&mem_db_for_revoke) {
                    let _ = store.ensure_remote_answers(&paired.client_id, LOCAL_APPS_ANSWERS_NOTE);
                }
                let _ = write_atomic_private_json(
                    &file_path_for_revoke,
                    &LocalAppsFile {
                        version: 1,
                        port,
                        token: paired.token,
                        client_id: paired.client_id,
                    },
                );
            }
        });

        let listener = match LoopbackPhoneListener::bind(
            preferred_port,
            self.host_id.clone(),
            LOCAL_APPS_CLIENT_NAME.to_string(),
            false,
            Arc::clone(&pairing),
            self.coordinator.clone(),
            self.memory_db_path.clone(),
            None,
            Some(on_revoked),
        )
        .await
        {
            Ok(l) => l,
            Err(_) => {
                self.phase = "failed".to_string();
                return;
            }
        };
        let port = listener.port;
        if let Ok(mut g) = port_cell.lock() {
            *g = port;
        }
        self.listener = Some(listener);

        let kept = saved.as_ref().and_then(|f| {
            let guard = pairing.lock().ok()?;
            if f.port == port && guard.verify_token(&f.token).as_deref() == Some(f.client_id.as_str())
            {
                Some((f.client_id.clone(), f.token.clone()))
            } else {
                None
            }
        });

        let granted = match kept {
            Some(pair) => Some(pair),
            None => self.pair_again(&pairing, saved.as_ref().map(|f| f.client_id.as_str())),
        };
        if !self.admit(&pairing, port, granted) {
            self.close_listener().await;
            self.phase = "failed".to_string();
            return;
        }
        self.phase = "on".to_string();
    }

    fn pair_again(
        &self,
        pairing: &Arc<StdMutex<PairedClients>>,
        named: Option<&str>,
    ) -> Option<(String, String)> {
        if !self.revoke_all(Some(pairing), named) {
            return None;
        }
        let mut guard = pairing.lock().ok()?;
        let code = guard.issue_pairing_code();
        guard
            .redeem_pairing_code(&code.code, LOCAL_APPS_CLIENT_NAME)
            .ok()
            .map(|p| (p.client_id, p.token))
    }

    fn admit(
        &self,
        pairing: &Arc<StdMutex<PairedClients>>,
        port: u16,
        granted: Option<(String, String)>,
    ) -> bool {
        let Some((client_id, token)) = granted else {
            return false;
        };
        let paired_ok = pairing
            .lock()
            .map(|g| g.is_paired(&client_id))
            .unwrap_or(false);
        if !paired_ok {
            return false;
        }
        if let Ok(store) = MemoryStore::open(&self.memory_db_path) {
            let _ = store.ensure_remote_answers(&client_id, LOCAL_APPS_ANSWERS_NOTE);
        }
        write_atomic_private_json(
            &self.file_path,
            &LocalAppsFile {
                version: 1,
                port,
                token,
                client_id,
            },
        )
        .is_ok()
    }

    async fn turn_off(&mut self) {
        self.close_listener().await;
        let saved = self.read_file();
        let pairing = if let Some(ref existing) = self.pairing {
            Some(Arc::clone(existing))
        } else if self.store_path.exists() {
            self.load_pairing()
        } else {
            None
        };
        self.revoke_all(pairing.as_ref(), saved.as_ref().map(|f| f.client_id.as_str()));
        let _ = fs::remove_file(&self.file_path);
        self.phase = "off".to_string();
    }

    fn revoke_all(
        &self,
        pairing: Option<&Arc<StdMutex<PairedClients>>>,
        named: Option<&str>,
    ) -> bool {
        let mut ids: HashSet<String> = HashSet::new();
        if let Some(p) = pairing {
            if let Ok(g) = p.lock() {
                for c in g.list() {
                    ids.insert(c.client_id.clone());
                }
            }
        }
        if let Some(n) = named {
            ids.insert(n.to_string());
        }
        let mut done = true;
        let mem = MemoryStore::open(&self.memory_db_path).ok();
        for cid in ids {
            // Revoke policy record BEFORE unpairing client (matching `localApps.ts:177`).
            if let Some(ref store) = mem {
                if store
                    .set_remote_answers(&cid, false, LOCAL_APPS_ANSWERS_NOTE)
                    .is_err()
                {
                    done = false;
                    continue;
                }
            }
            if let Some(p) = pairing {
                if p.lock().map(|mut g| g.revoke(&cid).is_err()).unwrap_or(true) {
                    done = false;
                }
            }
        }
        done
    }

    fn load_pairing(&mut self) -> Option<Arc<StdMutex<PairedClients>>> {
        if let Some(ref existing) = self.pairing {
            return Some(Arc::clone(existing));
        }
        let store = match PairedClients::load(&self.pairing_dir) {
            Ok(s) => s,
            Err(_) => {
                let _ = fs::remove_file(&self.store_path);
                PairedClients::load(&self.pairing_dir).ok()?
            }
        };
        let arc = Arc::new(StdMutex::new(store));
        self.pairing = Some(Arc::clone(&arc));
        Some(arc)
    }

    fn read_file(&self) -> Option<LocalAppsFile> {
        let text = fs::read_to_string(&self.file_path).ok()?;
        let parsed: LocalAppsFile = serde_json::from_str(&text).ok()?;
        if parsed.version != 1
            || parsed.port == 0
            || parsed.token.is_empty()
            || parsed.token.len() > 512
            || parsed.client_id.is_empty()
            || parsed.client_id.len() > 512
        {
            return None;
        }
        Some(parsed)
    }

    async fn close_listener(&mut self) {
        if let Some(mut listener) = self.listener.take() {
            listener.close().await;
        }
    }
}

/// Strictly read-only inspection of `phone-access.json`, `paired-clients.json`, `local-apps.json`,
/// and `memory.sqlite` remote-answer policies (safe for `--accelerator` mode).
pub fn read_phone_access_readonly(data_directory: &Path) -> Value {
    let record = fs::read_to_string(data_directory.join("phone-access.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<PhoneAccessRecord>(&t).ok());
    let local_apps = fs::read_to_string(data_directory.join("local-apps.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<LocalAppsFile>(&t).ok())
        .filter(|f| f.version == 1 && f.port > 0);
    let mem = {
        let p = data_directory.join("memory.sqlite");
        if p.exists() {
            MemoryStore::open_read_only(&p).ok()
        } else {
            None
        }
    };
    let phones: Vec<Value> = PairedClients::load(data_directory)
        .map(|store| {
            store
                .list()
                .iter()
                .map(|c| {
                    let can_answer = mem
                        .as_ref()
                        .and_then(|m| m.may_grant_remote(&c.client_id).ok())
                        .unwrap_or(false);
                    json!({
                        "clientId": c.client_id,
                        "name": c.name,
                        "pairedAt": c.paired_at,
                        "canAnswer": can_answer,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    json!({
        "record": record,
        "phones": phones,
        "localApps": local_apps.map(|f| json!({ "version": f.version, "port": f.port, "clientId": f.client_id })),
    })
}

/// Async helper to run `tailscale status --json` off the caller's thread.
pub async fn probe_tailscale_status() -> TailscaleStatus {
    let cli = SystemTailscaleCli::new();
    tokio::task::spawn_blocking(move || cli.status())
        .await
        .unwrap_or(TailscaleStatus::NotRunning)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serializes loopback port-binding tests in this module so a concurrent test binding
    /// `127.0.0.1:0` on macOS cannot steal an ephemeral port between `close()` and restart (#2850).
    static LOOPBACK_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    struct MockTailscale {
        state: StdMutex<MockTailscaleState>,
    }

    struct MockTailscaleState {
        status: TailscaleStatus,
        serve_config: ServeConfig,
        serve_result: ServeResult,
        serve_calls: Vec<(u16, u16)>,
        unserve_calls: Vec<u16>,
        unserve_ok: bool,
    }

    impl MockTailscale {
        fn running(dns_name: &str, host_name: &str) -> Arc<Self> {
            Arc::new(Self {
                state: StdMutex::new(MockTailscaleState {
                    status: TailscaleStatus::Running {
                        dns_name: dns_name.into(),
                        host_name: host_name.into(),
                        others: Vec::new(),
                    },
                    serve_config: ServeConfig::default(),
                    serve_result: ServeResult::Ok,
                    serve_calls: Vec::new(),
                    unserve_calls: Vec::new(),
                    unserve_ok: true,
                }),
            })
        }
    }

    impl TailscaleBackend for MockTailscale {
        fn status(&self) -> TailscaleStatus {
            self.state.lock().unwrap().status.clone()
        }

        fn serve_status(&self) -> Result<ServeConfig, ServeStatusError> {
            Ok(self.state.lock().unwrap().serve_config.clone())
        }

        fn serve(&self, port: u16, loopback_port: u16) -> ServeResult {
            let mut st = self.state.lock().unwrap();
            st.serve_calls.push((port, loopback_port));
            if st.serve_result == ServeResult::Ok {
                let mut tcp = st.serve_config.tcp.take().unwrap_or_default();
                tcp.insert(
                    port.to_string(),
                    Some(ServeTcpEntry {
                        https: Some(true),
                        ..Default::default()
                    }),
                );
                st.serve_config.tcp = Some(tcp);

                let mut web = st.serve_config.web.take().unwrap_or_default();
                let mut handlers = BTreeMap::new();
                handlers.insert(
                    "/".to_string(),
                    Some(ServeHandler {
                        proxy: Some(serve_target(loopback_port)),
                        ..Default::default()
                    }),
                );
                web.insert(
                    format!("forge.tail.ts.net:{port}"),
                    Some(ServeWebEntry {
                        handlers: Some(handlers),
                    }),
                );
                st.serve_config.web = Some(web);
            }
            st.serve_result.clone()
        }

        fn unserve(&self, port: u16) -> bool {
            let mut st = self.state.lock().unwrap();
            st.unserve_calls.push(port);
            if st.unserve_ok {
                if let Some(ref mut tcp) = st.serve_config.tcp {
                    tcp.remove(&port.to_string());
                }
                if let Some(ref mut web) = st.serve_config.web {
                    let suffix = format!(":{port}");
                    web.retain(|k, _| !k.ends_with(&suffix));
                }
            }
            st.unserve_ok
        }
    }

    #[test]
    fn parses_tailscale_status_and_serve_port_ownership_with_ts_parity() {
        let status = parse_tailscale_status(
            r#"{
                "BackendState": "Running",
                "Self": { "DNSName": "forge.tail123.ts.net.", "HostName": "forge", "UserID": 10 },
                "Peer": {
                    "a": { "UserID": 10, "HostName": "laptop", "DNSName": "laptop.tail123.ts.net." },
                    "b": { "UserID": 20, "HostName": "teammate", "DNSName": "teammate.tail123.ts.net." }
                }
            }"#,
        );
        assert_eq!(
            status,
            TailscaleStatus::Running {
                dns_name: "forge.tail123.ts.net".into(),
                host_name: "forge".into(),
                others: vec![TailscalePeer {
                    name: "teammate".into(),
                    dns_name: "teammate.tail123.ts.net".into(),
                }],
            }
        );

        let cfg = parse_serve_status(
            r#"{
                "TCP": { "8443": { "HTTPS": true }, "10000": { "HTTPS": true } },
                "Web": {
                    "forge.tail.ts.net:8443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:41234/" } } },
                    "forge.tail.ts.net:10000": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:9999" } } }
                }
            }"#,
        )
        .unwrap();
        assert_eq!(serve_port_owner(&cfg, 8443, &[41234]), ServePortOwner::Ours);
        assert_eq!(serve_port_owner(&cfg, 10000, &[41234]), ServePortOwner::Taken);
        assert_eq!(serve_port_owner(&cfg, 443, &[41234]), ServePortOwner::Free);

        // Funnel on our port must be treated as Taken (Sotto never runs Funnel).
        let funnel_cfg = parse_serve_status(
            r#"{
                "TCP": { "8443": { "HTTPS": true } },
                "Web": { "forge.tail.ts.net:8443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:41234" } } } },
                "AllowFunnel": { "forge.tail.ts.net:8443": true }
            }"#,
        )
        .unwrap();
        assert_eq!(
            serve_port_owner(&funnel_cfg, 8443, &[41234]),
            ServePortOwner::Taken
        );

        assert_eq!(
            extract_tailscale_consent_url(
                "Serve is not enabled on your tailnet.\nTo enable, visit:\n  https://login.tailscale.com/f/serve?node=abc123\n"
            )
            .as_deref(),
            Some("https://login.tailscale.com/f/serve?node=abc123")
        );
        assert!(is_tailscale_access_denied("Error: Access denied: serve config denied"));
        assert!(is_tailscale_serve_not_enabled("Serve is not enabled on your tailnet."));
    }

    #[tokio::test]
    async fn phone_access_lifecycle_falls_back_to_10000_pairs_grants_policy_and_removes() {
        let _guard = LOOPBACK_TEST_LOCK.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let ts = MockTailscale::running("forge.tail.ts.net", "forge");
        // Occupy 8443 with another app so PhoneAccess must pick 10000.
        ts.state.lock().unwrap().serve_config = parse_serve_status(
            r#"{
                "TCP": { "8443": { "HTTPS": true } },
                "Web": { "forge.tail.ts.net:8443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:8080" } } } }
            }"#,
        )
        .unwrap();

        let mut mgr = PhoneAccessManager::new(
            dir.path().to_path_buf(),
            "host-1".into(),
            true,
            None,
            ts.clone(),
        )
        .with_hostname("forge");

        mgr.start(PhoneAccessSettings {
            phone_access: true,
            phone_access_name: "Forge Box".into(),
        })
        .await;

        let state = mgr.get();
        assert_eq!(state.phase, "on");
        assert_eq!(state.serve_port, Some(10000));
        assert_eq!(state.address.as_deref(), Some("https://forge.tail.ts.net:10000"));
        assert_eq!(state.computer_name, "Forge Box");
        let port = mgr.page_port().expect("listener port should be exposed");

        // Issue a pairing code and redeem it over real loopback HTTP `/v1/pair`.
        let show = mgr.command(PhonesCommand::ShowCode).await.unwrap();
        let code = show.state.code.expect("pairing code should exist").code;

        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let body = serde_json::to_string(&json!({ "code": code, "name": "Zach's iPhone" })).unwrap();
        let req = format!(
            "POST /v1/pair HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(req.as_bytes()).await.unwrap();
        let mut resp = Vec::new();
        stream.read_to_end(&mut resp).await.unwrap();
        let resp_str = String::from_utf8_lossy(&resp);
        assert!(resp_str.starts_with("HTTP/1.1 200 OK"), "unexpected: {resp_str}");
        let json_body: Value =
            serde_json::from_str(resp_str.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        let client_id = json_body["clientId"].as_str().unwrap().to_string();

        // Pairing granted `remote-answer` policy in `memory.sqlite`.
        let after_pair = mgr.get();
        assert_eq!(after_pair.phones.len(), 1);
        assert_eq!(after_pair.phones[0].client_id, client_id);
        assert!(after_pair.phones[0].can_answer);

        // Removing revokes both `paired-clients.json` and `memory.sqlite`.
        let after_remove = mgr
            .command(PhonesCommand::Remove {
                client_id: client_id.clone(),
            })
            .await
            .unwrap();
        assert!(after_remove.state.phones.is_empty());
        let mem = MemoryStore::open_read_only(&dir.path().join("memory.sqlite")).unwrap();
        assert!(!mem.may_grant_remote(&client_id).unwrap());

        // Closing removes our 10000 Serve mapping without touching 8443.
        mgr.close().await;
        assert_eq!(ts.state.lock().unwrap().unserve_calls, vec![10000]);
        let saved: PhoneAccessRecord =
            serde_json::from_str(&fs::read_to_string(dir.path().join("phone-access.json")).unwrap())
                .unwrap();
        assert!(!saved.mapped);
        assert_eq!(saved.serve_port, Some(10000));
    }

    #[tokio::test]
    async fn local_apps_pairs_reuses_token_on_restart_repairs_on_self_revoke_and_cleans_on_off() {
        let _guard = LOOPBACK_TEST_LOCK.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let mut mgr = LocalAppsManager::new(dir.path().to_path_buf(), "host-la".into(), true, None);
        let st = mgr.start(true).await;
        assert_eq!(st.phase, "on");

        let file1: LocalAppsFile =
            serde_json::from_str(&fs::read_to_string(dir.path().join("local-apps.json")).unwrap())
                .unwrap();
        assert_eq!(file1.version, 1);
        assert!(file1.port > 0);
        let mem = MemoryStore::open_read_only(&dir.path().join("memory.sqlite")).unwrap();
        assert!(mem.may_grant_remote(&file1.client_id).unwrap());

        // Close (quit) keeps local-apps.json; a new manager reuses the exact same port, clientId & token.
        mgr.close().await;
        assert!(dir.path().join("local-apps.json").exists());

        let mut mgr2 =
            LocalAppsManager::new(dir.path().to_path_buf(), "host-la".into(), true, None);
        let st2 = mgr2.start(true).await;
        assert_eq!(st2.phase, "on");
        let file2: LocalAppsFile =
            serde_json::from_str(&fs::read_to_string(dir.path().join("local-apps.json")).unwrap())
                .unwrap();
        assert_eq!(file2, file1);

        // Self-revoke over `/v1/revoke` while enabled replaces clientId & token on the same port.
        let mut stream = TcpStream::connect(("127.0.0.1", file2.port)).await.unwrap();
        let req = format!(
            "POST /v1/revoke HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {}\r\nContent-Length: 0\r\n\r\n",
            file2.token
        );
        stream.write_all(req.as_bytes()).await.unwrap();
        let mut resp = Vec::new();
        stream.read_to_end(&mut resp).await.unwrap();
        assert!(String::from_utf8_lossy(&resp).starts_with("HTTP/1.1 200 OK"));

        let file3: LocalAppsFile =
            serde_json::from_str(&fs::read_to_string(dir.path().join("local-apps.json")).unwrap())
                .unwrap();
        assert_eq!(file3.port, file2.port);
        assert_ne!(file3.client_id, file2.client_id);
        assert!(!mem.may_grant_remote(&file2.client_id).unwrap());
        assert!(mem.may_grant_remote(&file3.client_id).unwrap());

        // Turning switch off revokes policy + deletes local-apps.json.
        let st_off = mgr2.settings_changed(false).await;
        assert_eq!(st_off.phase, "off");
        assert!(!dir.path().join("local-apps.json").exists());
        assert!(!mem.may_grant_remote(&file3.client_id).unwrap());
    }
}
