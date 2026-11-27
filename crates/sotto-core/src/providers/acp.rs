use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use crate::provider::{
    AnswerRequestInput, BoxFuture, ProviderAdapter, ProviderEvent, SendMessageAck,
    SendMessageRequest,
};
use crate::stores::StoredMessage;
use crate::workspace::{
    now_iso, provider_label, public_provider_entity_id, AgentCapabilities,
    AgentModel, AgentProviderStatus, ClientUpdateRow,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcpFlavor {
    Grok,
    Devin,
    Cursor,
    Antigravity,
    Hermes,
}

impl AcpFlavor {
    pub fn id(self) -> &'static str {
        match self {
            Self::Grok => "grok",
            Self::Devin => "devin",
            Self::Cursor => "cursor",
            Self::Antigravity => "antigravity",
            Self::Hermes => "hermes",
        }
    }

    pub fn name(self) -> &'static str {
        provider_label(self.id())
    }

    pub fn threads_file(self) -> &'static str {
        match self {
            Self::Grok => "grok-threads.json",
            Self::Devin => "devin-threads.json",
            Self::Cursor => "cursor-threads.json",
            Self::Antigravity => "antigravity-threads.json",
            Self::Hermes => "hermes-threads.json",
        }
    }

    /// What Node's schema for this provider's store requires of a record beyond the thread's own facts, with the value
    /// Node gives a session this host made (ADR-0214). Node confirms the model and settings again when it next loads the
    /// session. The thread's permission mode is kept where Node's store allows it; elsewhere Node's default applies.
    pub(crate) fn node_record_defaults(self, model_id: String, runtime_mode: Option<&str>) -> Vec<(&'static str, Value)> {
        let mut defaults = vec![("modelId", Value::String(model_id))];
        let modes: &[&str] = match self {
            Self::Grok | Self::Cursor => &["approval-required", "auto", "full-access"],
            Self::Antigravity => &["approval-required", "auto-accept-edits", "auto", "full-access"],
            Self::Devin | Self::Hermes => &[],
        };
        if let Some(mode) = runtime_mode.filter(|mode| modes.contains(mode)) {
            defaults.push(("runtimeMode", Value::String(mode.to_string())));
        }
        if matches!(self, Self::Grok | Self::Devin) {
            defaults.push(("settingsConfirmed", Value::Bool(false)));
        }
        defaults
    }

    pub fn session_id_field(self) -> &'static str {
        match self {
            Self::Grok => "grokSessionId",
            Self::Devin => "devinSessionId",
            Self::Cursor => "cursorSessionId",
            Self::Antigravity => "antigravitySessionId",
            Self::Hermes => "hermesSessionId",
        }
    }

    pub fn supports_images(self) -> bool {
        matches!(self, Self::Cursor | Self::Antigravity)
    }

    pub fn default_executable(self) -> &'static str {
        match self {
            Self::Grok => "grok",
            Self::Devin => "devin",
            Self::Cursor => "agent",
            Self::Antigravity => "agy",
            Self::Hermes => "hermes",
        }
    }

    pub fn default_args(self) -> Vec<String> {
        match self {
            Self::Grok => vec![
                "--permission-mode".into(),
                "default".into(),
                "agent".into(),
                "--no-leader".into(),
                "stdio".into(),
            ],
            Self::Devin => vec!["acp".into()],
            Self::Cursor => vec!["acp".into()],
            Self::Antigravity => vec!["acp".into()],
            Self::Hermes => vec!["acp".into()],
        }
    }
}

#[derive(Debug, Clone)]
pub struct AcpAdapterConfig {
    pub flavor: AcpFlavor,
    pub data_directory: PathBuf,
    pub executable: String,
    /// Node's `options.args` for Grok: what a test launch puts before everything else, a session's arguments and a side
    /// call's alike. A native launch has none.
    pub prefix_args: Vec<String>,
    /// A session's own arguments, after `prefix_args`.
    pub args: Vec<String>,
    pub request_timeout_ms: u64,
    pub use_cli_lookup: bool,
    /// How long a side call has (Node's `SIDE_WRITING_TIMEOUT_MS`); a test shortens it.
    pub side_writing_deadline: Duration,
}

impl AcpAdapterConfig {
    pub fn native(flavor: AcpFlavor, data_directory: PathBuf) -> Self {
        let mut args = flavor.default_args();
        if flavor == AcpFlavor::Antigravity {
            let gemini_dir = data_directory.join("antigravity").join("gemini");
            args.push("--gemini-dir".into());
            args.push(gemini_dir.to_string_lossy().into_owned());
            args.push("--app-data-dir".into());
            args.push("antigravity-acp".into());
        }
        Self {
            flavor,
            data_directory,
            executable: flavor.default_executable().into(),
            prefix_args: Vec::new(),
            args,
            request_timeout_ms: 30_000,
            use_cli_lookup: true,
            side_writing_deadline: crate::side_writing::SIDE_WRITING_DEADLINE,
        }
    }

    pub fn fake(flavor: AcpFlavor, data_directory: PathBuf, fake_script: PathBuf) -> Self {
        let prefix_args = vec![
            fake_script.to_string_lossy().into_owned(),
            data_directory.to_string_lossy().into_owned(),
        ];
        let args = if matches!(flavor, AcpFlavor::Cursor | AcpFlavor::Antigravity) { vec!["acp".into()] } else { Vec::new() };
        Self {
            flavor,
            data_directory,
            executable: std::env::var("SOTTO_NODE_BIN").unwrap_or_else(|_| "node".into()),
            prefix_args,
            args,
            request_timeout_ms: 5_000,
            use_cli_lookup: false,
            side_writing_deadline: crate::side_writing::SIDE_WRITING_DEADLINE,
        }
    }

    /// The provider's client as the CLI lookup finds it, or the configured client when no lookup is made; `None` when the
    /// lookup finds none. The configured leading arguments are the caller's to add.
    fn launch(&self) -> Option<crate::cli_lookup::ResolvedCli> {
        if !self.use_cli_lookup {
            return Some(crate::cli_lookup::ResolvedCli { executable: PathBuf::from(&self.executable), prefix_args: Vec::new(), augmented_path: String::new() });
        }
        let options = crate::cli_lookup::CliLookupOptions::from_process_env();
        crate::cli_lookup::resolve_provider_cli(self.flavor.id(), &self.data_directory, &options)
    }
}

#[derive(Debug, Clone)]
struct InboundAcpRequest {
    raw_id: Value,
    method: String,
    sotto_thread_id: String,
    params: Value,
    stdin_tx: mpsc::UnboundedSender<String>,
}

type PendingAcpMap = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;

struct AcpProcess {
    stdin_tx: mpsc::UnboundedSender<String>,
    pending_outbound: PendingAcpMap,
    next_id: AtomicI64,
    child: Mutex<Option<Child>>,
}

impl AcpProcess {
    fn spawn(
        config: &AcpAdapterConfig,
        shared: Arc<AcpSharedState>,
        cwd: &Path,
    ) -> Result<Arc<Self>, String> {
        let launch = config.launch().ok_or_else(|| {
            format!(
                "Install {} and sign in before connecting this provider.",
                config.flavor.name()
            )
        })?;
        let mut cmd = Command::new(&launch.executable);
        // Node starts every Grok thread's process on `grokEnvironment`, a test's fake included.
        if config.flavor == AcpFlavor::Grok {
            super::grok_side::session_environment(&mut cmd);
        }
        cmd.args(&launch.prefix_args);
        launch.apply_tokio(&mut cmd);
        cmd.args(&config.prefix_args)
            .args(&config.args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        if config.use_cli_lookup {
            match config.flavor {
                AcpFlavor::Cursor => {
                    let cfg_dir = config.data_directory.join("cursor").join("config");
                    let _ = fs::create_dir_all(&cfg_dir);
                    cmd.env("CURSOR_CONFIG_DIR", cfg_dir);
                    cmd.env("CURSOR_INVOKED_AS", "agent");
                    cmd.env("NO_OPEN_BROWSER", "1");
                }
                AcpFlavor::Hermes => {
                    let hermes_home = config.data_directory.join("hermes");
                    let _ = fs::create_dir_all(&hermes_home);
                    cmd.env("HERMES_HOME", hermes_home);
                }
                AcpFlavor::Antigravity => {
                    let agy_root = config.data_directory.join("antigravity");
                    let gemini_dir = agy_root.join("gemini");
                    let tmp_dir = agy_root.join("tmp");
                    let _ = fs::create_dir_all(&gemini_dir);
                    let _ = fs::create_dir_all(&tmp_dir);
                    cmd.env("GEMINI_HOME", &gemini_dir);
                    cmd.env("AGY_ACP_FORCE_FILE_STORAGE", "1");
                    cmd.env("AGY_CLI_DISABLE_AUTO_UPDATE", "1");
                    cmd.env("PYTHONUNBUFFERED", "1");
                    if std::env::var("SSH_CONNECTION").is_err() {
                        cmd.env("SSH_CONNECTION", "127.0.0.1 0 127.0.0.1 0");
                    }
                    #[cfg(windows)]
                    {
                        cmd.env("TEMP", &tmp_dir);
                        cmd.env("TMP", &tmp_dir);
                    }
                    #[cfg(not(windows))]
                    {
                        cmd.env("TMPDIR", &tmp_dir);
                    }
                }
                AcpFlavor::Grok | AcpFlavor::Devin => {}
            }
        }
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd.spawn().map_err(|_| {
            format!(
                "Could not start {}. Check its installation and try again.",
                config.flavor.name()
            )
        })?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("{} stdin unavailable.", config.flavor.name()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("{} stdout unavailable.", config.flavor.name()))?;

        let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            while let Some(line) = stdin_rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                if stdin.write_all(b"\n").await.is_err() {
                    break;
                }
                let _ = stdin.flush().await;
            }
        });

        let pending_outbound: PendingAcpMap = Arc::new(Mutex::new(HashMap::new()));
        let reader_pending = Arc::clone(&pending_outbound);
        let reader_shared = Arc::clone(&shared);
        let reader_stdin = stdin_tx.clone();

        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(val) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };
                let has_method = val.get("method").and_then(Value::as_str).is_some();
                let has_id = val.get("id").is_some();

                if !has_method && has_id {
                    if let Some(id_num) = val.get("id").and_then(Value::as_i64) {
                        if let Some(tx) = reader_pending.lock().unwrap().remove(&id_num) {
                            if let Some(err) = val.get("error") {
                                let msg = err
                                    .get("message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("ACP provider rejected request.")
                                    .to_string();
                                let _ = tx.send(Err(msg));
                            } else {
                                let _ = tx.send(Ok(val.get("result").cloned().unwrap_or(Value::Null)));
                            }
                        }
                    }
                } else if has_method && has_id {
                    let method = val["method"].as_str().unwrap_or("");
                    let raw_id = val["id"].clone();
                    let params = val.get("params").cloned().unwrap_or(Value::Null);
                    reader_shared.handle_server_request(raw_id, method, params, reader_stdin.clone());
                } else if has_method {
                    let method = val["method"].as_str().unwrap_or("");
                    let params = val.get("params").cloned().unwrap_or(Value::Null);
                    reader_shared.handle_notification(method, params);
                }
            }

            let drained: Vec<_> = reader_pending.lock().unwrap().drain().collect();
            for (_, tx) in drained {
                let _ = tx.send(Err("ACP process exited before answering.".into()));
            }
        });

        Ok(Arc::new(Self {
            stdin_tx,
            pending_outbound,
            next_id: AtomicI64::new(1),
            child: Mutex::new(Some(child)),
        }))
    }

    async fn call(&self, method: &str, params: Value, timeout_ms: u64) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending_outbound.lock().unwrap().insert(id, tx);
        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let encoded = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
        if self.stdin_tx.send(encoded).is_err() {
            self.pending_outbound.lock().unwrap().remove(&id);
            return Err("ACP process is not running.".into());
        }
        match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Err("ACP process closed before answering.".into()),
            Err(_) => {
                self.pending_outbound.lock().unwrap().remove(&id);
                Err(format!("timeout:{method}"))
            }
        }
    }

    /// Sends a long-running RPC (`session/prompt`) whose completion arrives asynchronously when the
    /// turn finishes, returning the receiver so a background task can emit `TurnCompleted`.
    fn send_async_call(&self, method: &str, params: Value) -> Result<oneshot::Receiver<Result<Value, String>>, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending_outbound.lock().unwrap().insert(id, tx);
        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let encoded = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
        if self.stdin_tx.send(encoded).is_err() {
            self.pending_outbound.lock().unwrap().remove(&id);
            return Err("ACP process is not running.".into());
        }
        Ok(rx)
    }

    async fn initialize(&self, flavor: AcpFlavor, timeout_ms: u64) -> Result<Value, String> {
        let mut caps = json!({
            "fs": { "readTextFile": false, "writeTextFile": false },
            "terminal": false,
        });
        if flavor == AcpFlavor::Cursor {
            caps.as_object_mut()
                .unwrap()
                .insert("_meta".into(), json!({ "parameterizedModelPicker": true }));
        } else if flavor == AcpFlavor::Antigravity {
            caps.as_object_mut()
                .unwrap()
                .insert("elicitation".into(), json!({ "form": {} }));
        }

        let res = self
            .call(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientInfo": {
                        "name": "sotto",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                    "clientCapabilities": caps,
                }),
                timeout_ms,
            )
            .await?;

        if flavor == AcpFlavor::Grok {
            let _ = self
                .call(
                    "authenticate",
                    json!({ "methodId": "cached_token", "_meta": { "headless": true } }),
                    timeout_ms,
                )
                .await;
        } else if flavor == AcpFlavor::Antigravity {
            let method = if std::env::var("GEMINI_API_KEY").is_ok() {
                "gemini-api-key"
            } else {
                "oauth-personal"
            };
            let _ = self
                .call("authenticate", json!({ "methodId": method }), timeout_ms)
                .await;
        }
        Ok(res)
    }

    async fn shutdown(&self) {
        let child = self.child.lock().unwrap().take();
        if let Some(mut c) = child {
            let _ = c.kill().await;
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct AcpThreadRecord {
    session_id: String,
    cwd: String,
    model_id: Option<String>,
    reasoning_effort: Option<String>,
    /// The whole record as Node wrote it (`projectId`, `title`, `createdAt`, `origins` and the rest), which a save
    /// writes back with the fields above set, so a rollback to Node finds its record whole (ADR-0214).
    extra: Map<String, Value>,
}

impl AcpThreadRecord {
    /// A record as Node's `*-threads.json` holds it, under this provider's own session ID field; none without one.
    pub(crate) fn parse(flavor: AcpFlavor, value: &Value) -> Option<Self> {
        let obj = value.as_object()?;
        let session_id = obj.get(flavor.session_id_field())?.as_str()?.to_string();
        let text = |key: &str| obj.get(key).and_then(Value::as_str).map(ToString::to_string);
        Some(Self {
            session_id,
            cwd: text("cwd").unwrap_or_default(),
            model_id: text("modelId"),
            reasoning_effort: text("reasoningEffort"),
            extra: obj.clone(),
        })
    }

    /// The record for a session this host just made for `req`'s thread. It carries what Node's schema for the store
    /// requires, so Node reads it after a rollback (ADR-0214); the model is the one the thread asked for, which Node
    /// confirms again when it next loads the session.
    pub(crate) fn created(flavor: AcpFlavor, data_directory: &std::path::Path, req: &SendMessageRequest, session_id: String) -> Self {
        let requested_model = req
            .model_id
            .as_deref()
            .map(|m| {
                crate::workspace::parse_public_provider_entity_id(m)
                    .map(|(_, _, raw)| raw.to_string())
                    .unwrap_or_else(|| m.to_string())
            })
            .unwrap_or_default();
        let extra = crate::providers::node_record_fields(
            &data_directory.join(flavor.threads_file()),
            &req.thread_id,
            &req.record_seed,
            &flavor.node_record_defaults(requested_model, req.runtime_mode.as_deref()),
        );
        Self { session_id, cwd: req.cwd.clone(), model_id: None, reasoning_effort: None, extra }
    }

    pub(crate) fn encode(&self, flavor: AcpFlavor) -> Value {
        let mut entry = self.extra.clone();
        entry.insert(flavor.session_id_field().into(), Value::String(self.session_id.clone()));
        entry.insert("cwd".into(), Value::String(self.cwd.clone()));
        if let Some(model_id) = &self.model_id {
            entry.insert("modelId".into(), Value::String(model_id.clone()));
        }
        if let Some(effort) = &self.reasoning_effort {
            entry.insert("reasoningEffort".into(), Value::String(effort.clone()));
        }
        Value::Object(entry)
    }
}

struct AcpStreamingMessage {
    msg_id: String,
    text: String,
}

struct AcpSharedState {
    flavor: AcpFlavor,
    data_directory: PathBuf,
    events_tx: Mutex<Option<mpsc::UnboundedSender<ProviderEvent>>>,
    status: Mutex<AgentProviderStatus>,
    models: Mutex<Vec<AgentModel>>,
    client_update: Mutex<Option<ClientUpdateRow>>,
    /// Sotto thread ID -> native ACP session ID.
    records: Mutex<HashMap<String, AcpThreadRecord>>,
    /// Native ACP session ID -> Sotto thread ID.
    native_to_sotto: Mutex<HashMap<String, String>>,
    /// Sotto thread ID -> active turn ID + activity JSON.
    active_turns: Mutex<HashMap<String, (String, Value)>>,
    /// Sotto thread ID -> currently streaming assistant message.
    streaming_msg: Mutex<HashMap<String, AcpStreamingMessage>>,
    /// Pending inbound requests (permission / question / elicitation).
    pending_requests: Mutex<HashMap<String, InboundAcpRequest>>,
}

impl AcpSharedState {
    fn new(flavor: AcpFlavor, data_directory: PathBuf) -> Self {
        let records = load_acp_records(&data_directory, flavor);
        let mut native_to_sotto = HashMap::new();
        for (sotto_id, rec) in &records {
            native_to_sotto.insert(rec.session_id.clone(), sotto_id.clone());
        }
        Self {
            flavor,
            data_directory,
            events_tx: Mutex::new(None),
            status: Mutex::new(AgentProviderStatus {
                id: flavor.id().into(),
                name: flavor.name().into(),
                connection: "disconnected".into(),
                version: String::new(),
                capabilities: acp_capabilities(),
                error: None,
            }),
            models: Mutex::new(Vec::new()),
            client_update: Mutex::new(None),
            records: Mutex::new(records),
            native_to_sotto: Mutex::new(native_to_sotto),
            active_turns: Mutex::new(HashMap::new()),
            streaming_msg: Mutex::new(HashMap::new()),
            pending_requests: Mutex::new(HashMap::new()),
        }
    }

    fn emit(&self, ev: ProviderEvent) {
        if let Some(tx) = self.events_tx.lock().unwrap().as_ref() {
            let _ = tx.send(ev);
        }
    }

    fn save_records(&self) {
        // Held while the file is written, so a record `forget_thread` let go is never written back from an earlier copy.
        let records = self.records.lock().unwrap();
        let flavor = self.flavor;
        let path = self.data_directory.join(flavor.threads_file());
        crate::providers::save_thread_records(&path, &*records, |value| AcpThreadRecord::parse(flavor, value), |record| record.encode(flavor));
    }

    fn resolve_sotto_thread(&self, native_session_id: &str) -> Option<String> {
        let map = self.native_to_sotto.lock().unwrap();
        if let Some(id) = map.get(native_session_id) {
            return Some(id.clone());
        }
        // Cursor `cursor/ask_question` omits sessionId on a per-thread process; fall back to the
        // single active thread when unambiguous.
        if native_session_id.is_empty() && map.len() == 1 {
            return map.values().next().cloned();
        }
        None
    }

    fn finish_turn(&self, sotto_tid: &str, stop_reason: &str) {
        let status = match stop_reason {
            "cancelled" => "interrupted",
            "error" => "failed",
            _ => "completed",
        };
        let title = match status {
            "interrupted" => "Turn interrupted",
            "failed" => "Turn failed",
            _ => "Turn completed",
        };
        // Finalize any open streamed assistant message.
        if let Some(stream) = self.streaming_msg.lock().unwrap().remove(sotto_tid) {
            self.emit(ProviderEvent::MessageReplaced {
                thread_id: sotto_tid.to_string(),
                message: StoredMessage {
                    id: stream.msg_id,
                    role: "assistant".into(),
                    text: stream.text,
                    created_at: now_iso(),
                    command_id: None,
                    turn_message_id: None,
                    attachments: None,
                    watcher_own_change: None,
                    watcher_observed_changes: None,
                    provider_error: None,
                },
            });
        }
        if let Some((turn_id, mut act)) = self.active_turns.lock().unwrap().remove(sotto_tid) {
            if let Some(obj) = act.as_object_mut() {
                obj.insert("status".into(), Value::String(status.into()));
                obj.insert("title".into(), Value::String(title.into()));
                obj.insert("completedAt".into(), Value::String(now_iso()));
            }
            self.emit(ProviderEvent::ActivityUpserted {
                thread_id: sotto_tid.to_string(),
                activity: act,
            });
            self.emit(ProviderEvent::TurnCompleted {
                thread_id: sotto_tid.to_string(),
                turn_id,
                status: status.into(),
            });
        }
    }

    fn handle_notification(&self, method: &str, params: Value) {
        if method != "session/update" && method != "_x.ai/session/update" {
            return;
        }
        let native_sid = params
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let Some(sotto_tid) = self.resolve_sotto_thread(native_sid) else {
            return;
        };
        let Some(update) = params.get("update") else {
            return;
        };
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or("");

        match kind {
            "agent_message_chunk" => {
                let text = update
                    .get("content")
                    .and_then(|c| c.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if text.is_empty() {
                    return;
                }
                let mut map = self.streaming_msg.lock().unwrap();
                if let Some(existing) = map.get_mut(&sotto_tid) {
                    existing.text.push_str(text);
                    let msg_id = existing.msg_id.clone();
                    drop(map);
                    self.emit(ProviderEvent::MessageTextAppended {
                        thread_id: sotto_tid,
                        message_id: msg_id,
                        append_text: text.to_string(),
                    });
                } else {
                    let msg_id = Uuid::new_v4().to_string();
                    map.insert(
                        sotto_tid.clone(),
                        AcpStreamingMessage {
                            msg_id: msg_id.clone(),
                            text: text.to_string(),
                        },
                    );
                    drop(map);
                    self.emit(ProviderEvent::MessageAdded {
                        thread_id: sotto_tid,
                        message: StoredMessage {
                            id: msg_id,
                            role: "assistant".into(),
                            text: text.to_string(),
                            created_at: now_iso(),
                            command_id: None,
                            turn_message_id: None,
                            attachments: None,
                            watcher_own_change: None,
                            watcher_observed_changes: None,
                            provider_error: None,
                        },
                    });
                }
            }
            "tool_call" | "tool_call_update" => {
                let call_id = update
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or("tool");
                let title = update
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("Tool call");
                let status = match update.get("status").and_then(Value::as_str) {
                    Some("completed") => "completed",
                    Some("failed") => "failed",
                    _ => "running",
                };
                let act = json!({
                    "id": acp_activity_id(self.flavor.id(), native_sid, call_id),
                    "kind": "command",
                    "title": title,
                    "command": title,
                    "status": status,
                    "startedAt": now_iso(),
                });
                self.emit(ProviderEvent::ActivityUpserted {
                    thread_id: sotto_tid,
                    activity: act,
                });
            }
            "turn_completed" => {
                let reason = update
                    .get("stop_reason")
                    .and_then(Value::as_str)
                    .unwrap_or("end_turn");
                self.finish_turn(&sotto_tid, reason);
            }
            _ => {}
        }
    }

    fn handle_server_request(
        &self,
        raw_id: Value,
        method: &str,
        params: Value,
        stdin_tx: mpsc::UnboundedSender<String>,
    ) {
        // Immediate acks for Cursor informational extension requests.
        if matches!(
            method,
            "cursor/update_todos" | "cursor/task" | "cursor/generate_image"
        ) {
            let reply = json!({ "jsonrpc": "2.0", "id": raw_id, "result": {} });
            if let Ok(encoded) = serde_json::to_string(&reply) {
                let _ = stdin_tx.send(encoded);
            }
            return;
        }

        let native_sid = params
            .get("sessionId")
            .or_else(|| params.get("params").and_then(|p| p.get("sessionId")))
            .and_then(Value::as_str)
            .unwrap_or("");
        let Some(sotto_tid) = self.resolve_sotto_thread(native_sid) else {
            return;
        };

        let req_id = format!(
            "{}-request-{}",
            self.flavor.id(),
            acp_digest(&format!("{native_sid}:{raw_id}:{method}"))
        );
        let card = build_acp_request_card(self.flavor, &req_id, method, &params);
        self.pending_requests.lock().unwrap().insert(
            req_id,
            InboundAcpRequest {
                raw_id,
                method: method.to_string(),
                sotto_thread_id: sotto_tid.clone(),
                params,
                stdin_tx,
            },
        );
        self.emit(ProviderEvent::RequestOpened {
            thread_id: sotto_tid,
            request: card,
        });
    }
}

pub struct AcpAdapter {
    config: AcpAdapterConfig,
    shared: Arc<AcpSharedState>,
    thread_procs: tokio::sync::Mutex<HashMap<String, Arc<AcpProcess>>>,
}

impl AcpAdapter {
    pub fn new(config: AcpAdapterConfig) -> Self {
        if config.flavor == AcpFlavor::Grok {
            super::grok_side::note_start();
        }
        let shared = Arc::new(AcpSharedState::new(
            config.flavor,
            config.data_directory.clone(),
        ));
        Self {
            config,
            shared,
            thread_procs: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    async fn ensure_thread_process(
        &self,
        sotto_thread_id: &str,
        cwd: &Path,
    ) -> Result<Arc<AcpProcess>, String> {
        let mut map = self.thread_procs.lock().await;
        if let Some(existing) = map.get(sotto_thread_id) {
            return Ok(Arc::clone(existing));
        }
        let proc = AcpProcess::spawn(&self.config, Arc::clone(&self.shared), cwd)?;
        proc.initialize(self.config.flavor, self.config.request_timeout_ms)
            .await?;
        map.insert(sotto_thread_id.to_string(), Arc::clone(&proc));
        Ok(proc)
    }

    async fn apply_session_settings(
        &self,
        proc: &AcpProcess,
        thread_id: &str,
        session_id: &str,
        model_id: Option<&str>,
        reasoning_effort: Option<&str>,
    ) -> Result<(), String> {
        let flavor = self.config.flavor;
        let raw_model = model_id.map(|m| {
            crate::workspace::parse_public_provider_entity_id(m)
                .map(|(_, _, raw)| raw.to_string())
                .unwrap_or_else(|| m.to_string())
        });
        let raw_effort = reasoning_effort
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string);

        let (prev_model, prev_effort) = self
            .shared
            .records
            .lock()
            .unwrap()
            .get(thread_id)
            .map(|r| (r.model_id.clone(), r.reasoning_effort.clone()))
            .unwrap_or((None, None));

        let model_changed = raw_model.is_some() && raw_model != prev_model;
        let effort_changed = raw_effort.is_some() && raw_effort != prev_effort;
        if !model_changed && !effort_changed {
            return Ok(());
        }

        match flavor {
            AcpFlavor::Grok => {
                if let Some(ref mid) = raw_model {
                    let mut params = json!({
                        "sessionId": session_id,
                        "modelId": mid,
                    });
                    if let Some(ref eff) = raw_effort {
                        params.as_object_mut().unwrap().insert(
                            "_meta".into(),
                            json!({ "reasoningEffort": eff }),
                        );
                    }
                    proc.call("session/set_model", params, self.config.request_timeout_ms)
                        .await?;
                }
            }
            AcpFlavor::Devin | AcpFlavor::Cursor | AcpFlavor::Antigravity | AcpFlavor::Hermes => {
                if let Some(ref mid) = raw_model {
                    if model_changed {
                        proc.call(
                            "session/set_config_option",
                            json!({
                                "sessionId": session_id,
                                "configId": "model",
                                "value": mid,
                            }),
                            self.config.request_timeout_ms,
                        )
                        .await?;
                    }
                }
                if let Some(ref eff) = raw_effort {
                    if effort_changed {
                        let _ = proc
                            .call(
                                "session/set_config_option",
                                json!({
                                    "sessionId": session_id,
                                    "configId": "reasoning_effort",
                                    "value": eff,
                                }),
                                self.config.request_timeout_ms,
                            )
                            .await;
                    }
                }
            }
        }

        if let Some(rec) = self.shared.records.lock().unwrap().get_mut(thread_id) {
            if raw_model.is_some() {
                rec.model_id = raw_model;
            }
            if raw_effort.is_some() {
                rec.reasoning_effort = raw_effort;
            }
        }
        self.shared.save_records();
        Ok(())
    }
}

impl ProviderAdapter for AcpAdapter {
    /// Lets go of a deleted thread's alias record (ADR-0140 decision 4), as Node's adapter `forgetThread` removes it:
    /// its entry in this provider's `*-threads.json` goes, under the records lock so no save from an earlier copy
    /// writes it back, and so does the adapter's own map to it.
    fn forget_thread(&self, thread_id: &str) {
        let shared = &self.shared;
        let mut records = shared.records.lock().unwrap();
        records.remove(thread_id);
        crate::providers::forget_thread_record(&shared.data_directory.join(shared.flavor.threads_file()), thread_id);
        drop(records);
        shared.native_to_sotto.lock().unwrap().retain(|_, sotto| sotto != thread_id);
    }

    fn id(&self) -> &str {
        self.config.flavor.id()
    }

    fn name(&self) -> &str {
        self.config.flavor.name()
    }

    fn status(&self) -> AgentProviderStatus {
        self.shared.status.lock().unwrap().clone()
    }

    fn models(&self) -> Vec<AgentModel> {
        self.shared.models.lock().unwrap().clone()
    }

    fn client_update(&self) -> Option<ClientUpdateRow> {
        self.shared.client_update.lock().unwrap().clone()
    }

    fn connect(&self, events: mpsc::UnboundedSender<ProviderEvent>) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            *self.shared.events_tx.lock().unwrap() = Some(events);
            let flavor = self.config.flavor;
            let record_err = |err: String| {
                let status = AgentProviderStatus {
                    id: flavor.id().into(),
                    name: flavor.name().into(),
                    connection: "error".into(),
                    version: String::new(),
                    capabilities: acp_capabilities(),
                    error: Some(err.clone()),
                };
                *self.shared.status.lock().unwrap() = status.clone();
                let models = self.shared.models.lock().unwrap().clone();
                let upd = self.shared.client_update.lock().unwrap().clone();
                self.shared.emit(ProviderEvent::StatusChanged {
                    provider_id: flavor.id().into(),
                    status,
                    models,
                    client_update: upd,
                });
                err
            };
            let probe = AcpProcess::spawn(
                &self.config,
                Arc::clone(&self.shared),
                &self.config.data_directory,
            )
            .map_err(record_err)?;
            let init = probe
                .initialize(flavor, self.config.request_timeout_ms)
                .await;
            let init = match init {
                Ok(v) => v,
                Err(e) => {
                    probe.shutdown().await;
                    return Err(record_err(e));
                }
            };

            let version = init
                .get("_meta")
                .and_then(|m| m.get("agentVersion"))
                .or_else(|| init.get("agentInfo").and_then(|a| a.get("version")))
                .and_then(Value::as_str)
                .unwrap_or("1.0.0")
                .to_string();

            let models = match flavor {
                AcpFlavor::Grok => extract_grok_models(&init),
                AcpFlavor::Cursor => {
                    let res = probe
                        .call(
                            "cursor/list_available_models",
                            json!({}),
                            self.config.request_timeout_ms,
                        )
                        .await
                        .unwrap_or_default();
                    extract_cursor_models(&res)
                }
                AcpFlavor::Devin | AcpFlavor::Antigravity => {
                    let created = probe
                        .call(
                            "session/new",
                            json!({
                                "cwd": self.config.data_directory.to_string_lossy(),
                                "mcpServers": [],
                            }),
                            self.config.request_timeout_ms,
                        )
                        .await
                        .unwrap_or_default();
                    extract_config_option_models(flavor, &created)
                }
                AcpFlavor::Hermes => vec![AgentModel {
                    id: public_provider_entity_id("hermes", "model", "default"),
                    name: "Hermes Default".into(),
                    provider: "Hermes".into(),
                    provider_id: "hermes".into(),
                    ready: true,
                    default_reasoning_effort: None,
                    reasoning_efforts: None,
                    runtime_modes: Some(vec![
                        "approval-required".into(),
                        "auto-accept-edits".into(),
                        "full-access".into(),
                    ]),
                    provider_modes: None,
                    supports_images: Some(false),
                }],
            };
            probe.shutdown().await;

            let status = AgentProviderStatus {
                id: flavor.id().into(),
                name: flavor.name().into(),
                connection: "connected".into(),
                version: version.clone(),
                capabilities: acp_capabilities(),
                error: None,
            };
            let upd = ClientUpdateRow {
                id: flavor.id().into(),
                installed: version,
                behind: false,
                can_install: false,
                channel: "unknown".into(),
                checked_at: Some(now_iso()),
                state: "idle".into(),
            };
            *self.shared.status.lock().unwrap() = status.clone();
            *self.shared.models.lock().unwrap() = models.clone();
            *self.shared.client_update.lock().unwrap() = Some(upd.clone());

            self.shared.emit(ProviderEvent::StatusChanged {
                provider_id: flavor.id().into(),
                status,
                models,
                client_update: Some(upd),
            });
            Ok(())
        })
    }

    fn disconnect(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let procs: Vec<_> = self.thread_procs.lock().await.drain().collect();
            for (_, p) in procs {
                p.shutdown().await;
            }
            let mut status = self.shared.status.lock().unwrap().clone();
            status.connection = "disconnected".into();
            *self.shared.status.lock().unwrap() = status.clone();
            let models = self.shared.models.lock().unwrap().clone();
            let upd = self.shared.client_update.lock().unwrap().clone();
            self.shared.emit(ProviderEvent::StatusChanged {
                provider_id: self.config.flavor.id().into(),
                status,
                models,
                client_update: upd,
            });
            Ok(())
        })
    }

    fn create_thread(
        &self,
        _thread_id: String,
        _cwd: String,
        _model_id: Option<String>,
        _runtime_mode: Option<String>,
        _reasoning_effort: Option<String>,
    ) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }

    fn send_message(&self, req: SendMessageRequest) -> BoxFuture<'_, Result<SendMessageAck, String>> {
        Box::pin(async move {
            let started = Instant::now();
            let flavor = self.config.flavor;
            let cwd_path = PathBuf::from(&req.cwd);
            let proc = self.ensure_thread_process(&req.thread_id, &cwd_path).await?;

            let existing = self
                .shared
                .records
                .lock()
                .unwrap()
                .get(&req.thread_id)
                .cloned();
            let session_id = match existing {
                None => {
                    let mut params = json!({
                        "cwd": req.cwd,
                        "mcpServers": [],
                    });
                    if flavor == AcpFlavor::Grok {
                        params.as_object_mut().unwrap().insert(
                            "_meta".into(),
                            grok_policy_meta(req.runtime_mode.as_deref()),
                        );
                    }
                    let created = proc
                        .call("session/new", params, self.config.request_timeout_ms)
                        .await?;
                    let sid = created
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .ok_or_else(|| format!("{} session/new returned no sessionId.", flavor.name()))?
                        .to_string();
                    // The record carries what Node's schema requires, so Node reads it after a rollback (ADR-0214).
                    // The model is the one the thread asked for; Node confirms it again when it next loads the session.
                    let record = AcpThreadRecord::created(flavor, &self.shared.data_directory, &req, sid.clone());
                    self.shared.records.lock().unwrap().insert(req.thread_id.clone(), record);
                    self.shared
                        .native_to_sotto
                        .lock()
                        .unwrap()
                        .insert(sid.clone(), req.thread_id.clone());
                    self.shared.save_records();
                    sid
                }
                Some(rec) => {
                    // Ensure loaded on this process (e.g. after restart).
                    let load_method = if flavor == AcpFlavor::Antigravity {
                        "session/resume"
                    } else {
                        "session/load"
                    };
                    let mut params = json!({
                        "sessionId": rec.session_id,
                        "cwd": req.cwd,
                        "mcpServers": [],
                    });
                    if flavor == AcpFlavor::Grok {
                        params.as_object_mut().unwrap().insert(
                            "_meta".into(),
                            grok_policy_meta(req.runtime_mode.as_deref()),
                        );
                    }
                    let _ = proc
                        .call(load_method, params, self.config.request_timeout_ms)
                        .await;
                    rec.session_id
                }
            };

            // Apply requested model and reasoning effort via this ACP flavor's session call before sending.
            self.apply_session_settings(
                &proc,
                &req.thread_id,
                &session_id,
                req.model_id.as_deref(),
                req.reasoning_effort.as_deref(),
            )
            .await?;

            let message_id = req.message_id.clone();
            let turn_id = Uuid::new_v4().to_string();
            let act = json!({
                "id": acp_activity_id(flavor.id(), &session_id, &turn_id),
                "kind": "turn",
                "sequence": 0,
                "startedAt": now_iso(),
                "status": "running",
                "timingSource": "provider",
                "title": "Working",
                "turnId": turn_id,
                "afterMessageId": message_id,
            });
            self.shared
                .active_turns
                .lock()
                .unwrap()
                .insert(req.thread_id.clone(), (turn_id.clone(), act.clone()));
            self.shared.emit(ProviderEvent::TurnStarted {
                thread_id: req.thread_id.clone(),
                turn_id: turn_id.clone(),
                after_message_id: Some(message_id.clone()),
                activity: act,
            });

            let mut prompt_blocks = vec![json!({ "type": "text", "text": req.text })];
            if flavor != AcpFlavor::Devin {
                for att in &req.attachments {
                    if att.handle.is_image() && flavor.supports_images() {
                        if let Ok(bytes) = fs::read(&att.path) {
                            prompt_blocks.push(json!({
                                "type": "image",
                                "mimeType": att.handle.mime_type,
                                "data": STANDARD.encode(bytes),
                            }));
                        }
                    } else if !att.handle.is_image() {
                        prompt_blocks.push(json!({
                            "type": "text",
                            "text": format!("Attached file: {} ({})", att.handle.name, att.path.to_string_lossy()),
                        }));
                    }
                }
            }

            let mut prompt_params = json!({
                "sessionId": session_id,
                "prompt": prompt_blocks,
            });
            if flavor == AcpFlavor::Devin {
                prompt_params.as_object_mut().unwrap().insert(
                    "_meta".into(),
                    json!({ "cognition.ai/clientMessageId": message_id }),
                );
            }

            let prompt_rx = proc.send_async_call("session/prompt", prompt_params)?;
            let shared_done = Arc::clone(&self.shared);
            let tid_done = req.thread_id.clone();
            tokio::spawn(async move {
                match prompt_rx.await {
                    Ok(Ok(res)) => {
                        let stop = res
                            .get("stopReason")
                            .and_then(Value::as_str)
                            .unwrap_or("end_turn");
                        shared_done.finish_turn(&tid_done, stop);
                    }
                    Ok(Err(_)) | Err(_) => {
                        shared_done.finish_turn(&tid_done, "error");
                    }
                }
            });

            Ok(SendMessageAck {
                message_id,
                turn_id,
                status: "accepted".into(),
                provider_latency_ms: started.elapsed().as_millis() as u64,
            })
        })
    }

    fn answer_request(&self, req: AnswerRequestInput) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let pending = self
                .shared
                .pending_requests
                .lock()
                .unwrap()
                .remove(&req.request_id)
                .ok_or_else(|| format!("No pending {} request matches that ID.", self.config.flavor.name()))?;

            let result = build_acp_response_payload(
                self.config.flavor,
                &pending.method,
                &pending.params,
                &req,
            );
            let frame = json!({
                "jsonrpc": "2.0",
                "id": pending.raw_id,
                "result": result,
            });
            let encoded = serde_json::to_string(&frame).map_err(|e| e.to_string())?;
            pending
                .stdin_tx
                .send(encoded)
                .map_err(|_| format!("{} process closed before receiving the answer.", self.config.flavor.name()))?;

            self.shared.emit(ProviderEvent::RequestCleared {
                thread_id: pending.sotto_thread_id,
                request_id: req.request_id,
            });
            Ok(())
        })
    }

    fn interrupt(&self, thread_id: String) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let sid = self
                .shared
                .records
                .lock()
                .unwrap()
                .get(&thread_id)
                .map(|r| r.session_id.clone())
                .ok_or_else(|| format!("{} has no active session for this thread.", self.config.flavor.name()))?;
            let proc = {
                let map = self.thread_procs.lock().await;
                map.get(&thread_id).cloned()
            }
            .ok_or_else(|| format!("{} thread process is not running.", self.config.flavor.name()))?;

            // `session/cancel` is a notification in ACP (Devin also accepts an id; sending as
            // notification/call completes the pending `session/prompt`).
            let frame = json!({
                "jsonrpc": "2.0",
                "id": proc.next_id.fetch_add(1, Ordering::Relaxed),
                "method": "session/cancel",
                "params": { "sessionId": sid },
            });
            if let Ok(encoded) = serde_json::to_string(&frame) {
                let _ = proc.stdin_tx.send(encoded);
            }
            Ok(())
        })
    }

    /// Node's Grok `writeShortText`: a side call on this thread's model in its folder, as its own short-lived Grok
    /// process on a throwaway home, so the thread's session is never loaded for it. Nothing is written while Grok is not
    /// connected, for a personal thread or one with no confirmed Grok session, or by the other clients this adapter
    /// drives: Node's Devin and Hermes write nothing, and Cursor's and Antigravity's side calls are not ported yet.
    fn write_short_text(&self, thread_id: String, prompt: crate::side_writing::ShortTextPrompt) -> BoxFuture<'_, Result<Option<String>, String>> {
        Box::pin(async move {
            if self.config.flavor != AcpFlavor::Grok || self.shared.status.lock().unwrap().connection != "connected" {
                return Ok(None);
            }
            // A record is kept only for a thread with a Grok session, as Node asks for `grokSessionId`.
            let Some(record) = self.shared.records.lock().unwrap().get(&thread_id).cloned() else {
                return Ok(None);
            };
            if record.extra.get("kind").and_then(Value::as_str) == Some("personal") {
                return Ok(None);
            }
            // Node's `nativeModelId ?? modelId`.
            let native_model = record.extra.get("nativeModelId").and_then(Value::as_str).map(String::from);
            let Some(model) = native_model.or(record.model_id) else {
                return Ok(None);
            };
            let cwd = crate::worktree_reclaim::existing_folder(&record.cwd)?;
            let writing = self.config.data_directory.join("writing").join("grok");
            let run = super::grok_side::SideRun { prompt: &prompt, model: &model, cwd: Path::new(&cwd), deadline: self.config.side_writing_deadline, writing: &writing };
            super::grok_side::write(self.config.launch().as_ref(), &self.config.prefix_args, run).await.map(Some)
        })
    }

    fn compact(&self, _thread_id: String) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }

    fn configure_thread(
        &self,
        thread_id: String,
        model_id: Option<String>,
        _runtime_mode: Option<String>,
        reasoning_effort: Option<String>,
    ) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let sid = self
                .shared
                .records
                .lock()
                .unwrap()
                .get(&thread_id)
                .map(|r| r.session_id.clone());
            let proc = {
                let map = self.thread_procs.lock().await;
                map.get(&thread_id).cloned()
            };
            if let (Some(proc), Some(sid)) = (proc, sid) {
                self.apply_session_settings(
                    &proc,
                    &thread_id,
                    &sid,
                    model_id.as_deref(),
                    reasoning_effort.as_deref(),
                )
                .await?;
            }
            Ok(())
        })
    }
}

fn acp_capabilities() -> AgentCapabilities {
    AgentCapabilities {
        compact: Some(false),
        configure_thread: Some(true),
        interrupt: true,
        message_origin: true,
        observe: true,
        permissions: true,
        projects: true,
        questions: true,
        reconcile: true,
        skills: Some(true),
        steer: Some(false),
        submit: true,
        threads: true,
    }
}

fn grok_policy_meta(runtime_mode: Option<&str>) -> Value {
    match runtime_mode.unwrap_or("approval-required") {
        "full-access" => json!({ "yoloMode": true, "autoMode": false }),
        "auto" => json!({ "yoloMode": false, "autoMode": true }),
        _ => json!({ "yoloMode": false, "autoMode": false }),
    }
}

fn acp_digest(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    crate::providers::hex_encode(&hasher.finalize())
}

fn acp_activity_id(provider: &str, native_sid: &str, key: &str) -> String {
    format!("{provider}-activity-{}", acp_digest(&format!("{provider}:{native_sid}:{key}")))
}

fn load_acp_records(data_directory: &Path, flavor: AcpFlavor) -> HashMap<String, AcpThreadRecord> {
    crate::providers::load_thread_records(&data_directory.join(flavor.threads_file()), |value| AcpThreadRecord::parse(flavor, value))
}

fn extract_grok_models(init: &Value) -> Vec<AgentModel> {
    let mut out = Vec::new();
    if let Some(arr) = init
        .get("_meta")
        .and_then(|m| m.get("modelState"))
        .and_then(|s| s.get("availableModels"))
        .and_then(Value::as_array)
    {
        for entry in arr {
            let raw_id = entry
                .get("modelId")
                .and_then(Value::as_str)
                .unwrap_or("fixture-model");
            let name = entry.get("name").and_then(Value::as_str).unwrap_or(raw_id);
            let default_effort = entry
                .get("_meta")
                .and_then(|m| m.get("reasoningEffort"))
                .and_then(Value::as_str)
                .map(ToString::to_string);
            let efforts: Vec<String> = entry
                .get("_meta")
                .and_then(|m| m.get("reasoningEfforts"))
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(|e| e.get("id").and_then(Value::as_str).map(ToString::to_string))
                        .collect()
                })
                .unwrap_or_default();
            out.push(AgentModel {
                id: public_provider_entity_id("grok", "model", raw_id),
                name: name.to_string(),
                provider: "Grok Build".into(),
                provider_id: "grok".into(),
                ready: true,
                default_reasoning_effort: default_effort,
                reasoning_efforts: (!efforts.is_empty()).then_some(efforts),
                runtime_modes: Some(vec![
                    "approval-required".into(),
                    "auto".into(),
                    "full-access".into(),
                ]),
                provider_modes: None,
                supports_images: Some(false),
            });
        }
    }
    out
}

fn extract_cursor_models(res: &Value) -> Vec<AgentModel> {
    let mut out = Vec::new();
    if let Some(arr) = res.get("models").and_then(Value::as_array) {
        for entry in arr {
            let raw_id = entry
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or("default");
            let name = entry.get("name").and_then(Value::as_str).unwrap_or(raw_id);
            out.push(AgentModel {
                id: public_provider_entity_id("cursor", "model", raw_id),
                name: name.to_string(),
                provider: "Cursor".into(),
                provider_id: "cursor".into(),
                ready: true,
                default_reasoning_effort: None,
                reasoning_efforts: None,
                runtime_modes: Some(vec![
                    "approval-required".into(),
                    "auto-accept-edits".into(),
                    "full-access".into(),
                ]),
                provider_modes: None,
                supports_images: Some(true),
            });
        }
    }
    out
}

fn extract_config_option_models(flavor: AcpFlavor, created: &Value) -> Vec<AgentModel> {
    let mut out = Vec::new();
    let Some(opts) = created.get("configOptions").and_then(Value::as_array) else {
        return out;
    };
    let Some(model_opt) = opts
        .iter()
        .find(|o| o.get("id").and_then(Value::as_str) == Some("model"))
    else {
        return out;
    };
    let Some(entries) = model_opt.get("options").and_then(Value::as_array) else {
        return out;
    };
    let mut flat = Vec::new();
    for item in entries {
        if let Some(group_opts) = item.get("options").and_then(Value::as_array) {
            flat.extend(group_opts.iter().cloned());
        } else {
            flat.push(item.clone());
        }
    }
    for entry in flat {
        let raw_id = entry
            .get("value")
            .and_then(Value::as_str)
            .unwrap_or("fixture-model");
        let name = entry.get("name").and_then(Value::as_str).unwrap_or(raw_id);
        out.push(AgentModel {
            id: public_provider_entity_id(flavor.id(), "model", raw_id),
            name: name.to_string(),
            provider: flavor.name().into(),
            provider_id: flavor.id().into(),
            ready: true,
            default_reasoning_effort: None,
            reasoning_efforts: None,
            runtime_modes: Some(vec![
                "approval-required".into(),
                "auto-accept-edits".into(),
                "auto".into(),
                "full-access".into(),
            ]),
            provider_modes: None,
            supports_images: Some(flavor.supports_images()),
        });
    }
    out
}

fn build_acp_request_card(flavor: AcpFlavor, req_id: &str, method: &str, params: &Value) -> Value {
    match method {
        "_x.ai/ask_user_question" => {
            let inner = params.get("params").unwrap_or(params);
            let q = inner
                .get("questions")
                .and_then(Value::as_array)
                .and_then(|a| a.first());
            let text = q
                .and_then(|x| x.get("question"))
                .and_then(Value::as_str)
                .unwrap_or("Answer question");
            json!({
                "id": req_id,
                "kind": "question",
                "text": text,
                "since": now_iso(),
                "options": [],
                "context": { "toolName": method },
            })
        }
        "cursor/ask_question" => {
            let q = params
                .get("questions")
                .and_then(Value::as_array)
                .and_then(|a| a.first());
            let text = q
                .and_then(|x| x.get("prompt"))
                .and_then(Value::as_str)
                .or_else(|| params.get("title").and_then(Value::as_str))
                .unwrap_or("Answer question");
            let opts: Vec<Value> = q
                .and_then(|x| x.get("options"))
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .map(|o| {
                            let id = o.get("id").and_then(Value::as_str).unwrap_or("");
                            let lbl = o.get("label").and_then(Value::as_str).unwrap_or(id);
                            json!({ "id": id, "label": lbl })
                        })
                        .collect()
                })
                .unwrap_or_default();
            json!({
                "id": req_id,
                "kind": "question",
                "text": text,
                "since": now_iso(),
                "options": opts,
                "context": { "toolName": method },
            })
        }
        "elicitation/create" => {
            let text = params
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Provide input");
            json!({
                "id": req_id,
                "kind": "question",
                "text": text,
                "since": now_iso(),
                "options": [],
                "context": { "toolName": method },
            })
        }
        "cursor/create_plan" => {
            let text = params
                .get("overview")
                .and_then(Value::as_str)
                .unwrap_or("Approve plan?");
            json!({
                "id": req_id,
                "kind": "permission",
                "text": text,
                "since": now_iso(),
                "options": [
                    { "id": "allow", "label": "Accept" },
                    { "id": "deny", "label": "Reject" }
                ],
                "context": { "toolName": method },
            })
        }
        _ => {
            // `session/request_permission` (including Antigravity `interaction_` questions).
            let tool_call = params.get("toolCall").cloned().unwrap_or(Value::Null);
            let call_id = tool_call
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let title = tool_call
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Approve action?");
            if flavor == AcpFlavor::Antigravity && call_id.starts_with("interaction_") {
                let opts: Vec<Value> = params
                    .get("options")
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .map(|o| {
                                let id = o.get("optionId").and_then(Value::as_str).unwrap_or("");
                                let lbl = o.get("name").and_then(Value::as_str).unwrap_or(id);
                                json!({ "id": id, "label": lbl })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                return json!({
                    "id": req_id,
                    "kind": "question",
                    "text": title,
                    "since": now_iso(),
                    "options": opts,
                    "context": { "toolCallId": call_id, "toolName": method },
                });
            }
            json!({
                "id": req_id,
                "kind": "permission",
                "text": title,
                "since": now_iso(),
                "options": [
                    { "id": "allow", "label": "Allow" },
                    { "id": "deny", "label": "Deny" }
                ],
                "permissionChoices": [
                    { "id": "allow", "kind": "allow-once", "label": "Allow once" },
                    { "id": "deny", "kind": "deny", "label": "Deny" }
                ],
                "context": { "toolCallId": call_id, "toolName": method },
            })
        }
    }
}

fn build_acp_response_payload(
    flavor: AcpFlavor,
    method: &str,
    params: &Value,
    req: &AnswerRequestInput,
) -> Value {
    match method {
        "_x.ai/ask_user_question" => {
            let inner = params.get("params").unwrap_or(params);
            let mut answers = Map::new();
            if let Some(arr) = inner.get("questions").and_then(Value::as_array) {
                for q in arr {
                    if let Some(qtext) = q.get("question").and_then(Value::as_str) {
                        answers.insert(qtext.to_string(), json!([req.answer]));
                    }
                }
            }
            json!({
                "outcome": "accepted",
                "answers": Value::Object(answers),
            })
        }
        "cursor/ask_question" => {
            let mut answers = Vec::new();
            if let Some(arr) = params.get("questions").and_then(Value::as_array) {
                for q in arr {
                    let qid = q.get("id").and_then(Value::as_str).unwrap_or("0");
                    answers.push(json!({
                        "questionId": qid,
                        "selectedOptionIds": [req.answer],
                    }));
                }
            }
            json!({
                "outcome": {
                    "outcome": "answered",
                    "answers": answers,
                }
            })
        }
        "cursor/create_plan" => {
            let outcome = if req.approved.unwrap_or(false) {
                "accepted"
            } else {
                "rejected"
            };
            json!({ "outcome": { "outcome": outcome } })
        }
        "elicitation/create" => {
            if req.approved == Some(false) {
                return json!({ "action": "decline" });
            }
            if flavor == AcpFlavor::Devin {
                return json!({
                    "action": "accept",
                    "content": { "answer": req.answer },
                });
            }
            let mut content = Map::new();
            if let Some(props) = params
                .get("requestedSchema")
                .and_then(|s| s.get("properties"))
                .and_then(Value::as_object)
            {
                if let Some((first_key, _)) = props.iter().next() {
                    content.insert(first_key.clone(), Value::String(req.answer.clone()));
                }
            }
            json!({
                "action": "accept",
                "content": Value::Object(content),
            })
        }
        _ => {
            // `session/request_permission` — NEVER select `allow_always` (ADR-0004).
            let call_id = params
                .get("toolCall")
                .and_then(|tc| tc.get("toolCallId"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let options = params
                .get("options")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();

            if flavor == AcpFlavor::Antigravity && call_id.starts_with("interaction_") {
                let matched = options
                    .iter()
                    .find(|o| {
                        o.get("optionId").and_then(Value::as_str) == Some(req.answer.as_str())
                            || o.get("name").and_then(Value::as_str) == Some(req.answer.as_str())
                    })
                    .and_then(|o| o.get("optionId").and_then(Value::as_str))
                    .unwrap_or(&req.answer);
                return json!({
                    "outcome": {
                        "outcome": "selected",
                        "optionId": matched,
                    }
                });
            }

            let allow = match req.permission_choice.as_deref() {
                Some("allow") | Some("allow-once") => true,
                Some("deny") => false,
                _ => req.approved.unwrap_or(false),
            };
            let target_kind = if allow { "allow_once" } else { "reject_once" };
            let option_id = options
                .iter()
                .find(|o| o.get("kind").and_then(Value::as_str) == Some(target_kind))
                .and_then(|o| o.get("optionId").and_then(Value::as_str))
                .unwrap_or(match (flavor, allow) {
                    (AcpFlavor::Grok, true) => "yes",
                    (AcpFlavor::Grok, false) => "no",
                    (AcpFlavor::Devin, true) => "allow-once",
                    (AcpFlavor::Devin, false) => "deny-once",
                    (_, true) => "allow-once",
                    (_, false) => "reject-once",
                });
            json!({
                "outcome": {
                    "outcome": "selected",
                    "optionId": option_id,
                }
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acp_permission_responses_never_choose_allow_always() {
        let params = json!({
            "toolCall": { "toolCallId": "toolu_1", "title": "Run build" },
            "options": [
                { "optionId": "remember-this", "name": "Allow always", "kind": "allow_always" },
                { "optionId": "allow-once", "name": "Allow", "kind": "allow_once" },
                { "optionId": "reject-once", "name": "Deny", "kind": "reject_once" }
            ]
        });
        let res = build_acp_response_payload(
            AcpFlavor::Antigravity,
            "session/request_permission",
            &params,
            &AnswerRequestInput {
                thread_id: "t1".into(),
                request_id: "r1".into(),
                answer: String::new(),
                approved: Some(true),
                permission_choice: None,
                question_answers: None,
                skipped: None,
            },
        );
        assert_eq!(res["outcome"]["outcome"], "selected");
        assert_eq!(res["outcome"]["optionId"], "allow-once");
    }
}
