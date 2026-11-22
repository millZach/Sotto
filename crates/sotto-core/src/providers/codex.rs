use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
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
    now_iso, parse_public_provider_entity_id, public_provider_entity_id, write_atomic_json,
    AgentCapabilities, AgentModel, AgentProviderStatus, ClientUpdateRow,
};

pub const CODEX_THREADS_FILE: &str = "codex-threads.json";

#[derive(Debug, Clone)]
pub struct CodexAdapterConfig {
    pub data_directory: PathBuf,
    pub executable: String,
    pub args: Vec<String>,
    pub codex_home: Option<PathBuf>,
    pub request_timeout_ms: u64,
}

impl CodexAdapterConfig {
    pub fn native(data_directory: PathBuf) -> Self {
        Self {
            data_directory,
            executable: "codex".into(),
            args: vec!["app-server".into()],
            codex_home: None,
            request_timeout_ms: 30_000,
        }
    }

    pub fn fake(data_directory: PathBuf, fake_script: PathBuf) -> Self {
        let codex_home = data_directory.join("home");
        Self {
            data_directory: data_directory.clone(),
            executable: std::env::var("SOTTO_NODE_BIN").unwrap_or_else(|_| "node".into()),
            args: vec![
                fake_script.to_string_lossy().into_owned(),
                data_directory.to_string_lossy().into_owned(),
            ],
            codex_home: Some(codex_home),
            request_timeout_ms: 2_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexThreadRecord {
    codex_thread_id: String,
    #[serde(default)]
    cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime_mode: Option<String>,
}

#[derive(Debug, Clone)]
struct InboundCodexRequest {
    raw_id: Value,
    method: String,
    sotto_thread_id: String,
    params: Value,
    stdin_tx: mpsc::UnboundedSender<String>,
}

type PendingRpcMap = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;

struct RpcProcess {
    stdin_tx: mpsc::UnboundedSender<String>,
    pending_outbound: PendingRpcMap,
    next_id: AtomicI64,
    child: Mutex<Option<Child>>,
}

impl RpcProcess {
    fn spawn(
        config: &CodexAdapterConfig,
        shared: Arc<CodexSharedState>,
    ) -> Result<Arc<Self>, String> {
        let mut cmd = Command::new(&config.executable);
        cmd.args(&config.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        if let Some(ref home) = config.codex_home {
            let _ = fs::create_dir_all(home);
            cmd.env("CODEX_HOME", home);
        }
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Could not start Codex ({}): {e}", config.executable))?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Codex stdin unavailable.".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Codex stdout unavailable.".to_string())?;

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

        let server_id = Uuid::new_v4().to_string();
        let pending_outbound: PendingRpcMap = Arc::new(Mutex::new(HashMap::new()));

        let reader_pending = Arc::clone(&pending_outbound);
        let reader_server_id = server_id.clone();
        let reader_stdin_tx = stdin_tx.clone();
        let reader_shared = Arc::clone(&shared);

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
                    // Response to our outbound JSON-RPC request.
                    if let Some(id_num) = val.get("id").and_then(Value::as_i64) {
                        if let Some(tx) = reader_pending.lock().unwrap().remove(&id_num) {
                            if let Some(err) = val.get("error") {
                                let msg = err
                                    .get("message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("Codex rejected the request.")
                                    .to_string();
                                let _ = tx.send(Err(msg));
                            } else {
                                let result = val.get("result").cloned().unwrap_or(Value::Null);
                                let _ = tx.send(Ok(result));
                            }
                        }
                    }
                } else if has_method && has_id {
                    // Server-to-client JSON-RPC request (permission / question / elicitation).
                    let method = val["method"].as_str().unwrap_or("").to_string();
                    let raw_id = val["id"].clone();
                    let params = val.get("params").cloned().unwrap_or(Value::Null);
                    reader_shared.handle_server_request(
                        &reader_server_id,
                        raw_id,
                        &method,
                        params,
                        reader_stdin_tx.clone(),
                    );
                } else if has_method {
                    // Notification from Codex.
                    let method = val["method"].as_str().unwrap_or("");
                    let params = val.get("params").cloned().unwrap_or(Value::Null);
                    reader_shared.handle_notification(method, params);
                }
            }

            // Fail any remaining pending RPC callers on unexpected exit.
            let drained: Vec<_> = reader_pending.lock().unwrap().drain().collect();
            for (_, tx) in drained {
                let _ = tx.send(Err("Codex exited before answering.".into()));
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
            "id": id,
            "method": method,
            "params": params,
        });
        let encoded = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
        if self.stdin_tx.send(encoded).is_err() {
            self.pending_outbound.lock().unwrap().remove(&id);
            return Err("Codex process is not running.".into());
        }

        match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Codex closed before answering.".into()),
            Err(_) => {
                // Keep entry absent so late response is silently ignored, or handle timeout.
                self.pending_outbound.lock().unwrap().remove(&id);
                Err(format!("timeout:{method}"))
            }
        }
    }

    fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let payload = json!({
            "method": method,
            "params": params,
        });
        let encoded = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
        self.stdin_tx
            .send(encoded)
            .map_err(|_| "Codex process is not running.".to_string())
    }

    async fn initialize(&self, timeout_ms: u64) -> Result<Value, String> {
        let res = self
            .call(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": "sotto",
                        "title": "Sotto",
                        "version": env!("CARGO_PKG_VERSION"),
                    }
                }),
                timeout_ms,
            )
            .await?;
        self.notify("initialized", json!({}))?;
        Ok(res)
    }

    async fn shutdown(&self) {
        let child = self.child.lock().unwrap().take();
        if let Some(mut c) = child {
            let _ = c.kill().await;
        }
    }
}

struct CodexSharedState {
    data_directory: PathBuf,
    events_tx: Mutex<Option<mpsc::UnboundedSender<ProviderEvent>>>,
    status: Mutex<AgentProviderStatus>,
    models: Mutex<Vec<AgentModel>>,
    client_update: Mutex<Option<ClientUpdateRow>>,
    /// Sotto thread ID -> saved Codex thread record.
    records: Mutex<HashMap<String, CodexThreadRecord>>,
    /// Codex native thread ID -> Sotto thread ID.
    native_to_sotto: Mutex<HashMap<String, String>>,
    /// Sotto thread ID -> active Codex turn ID.
    active_turns: Mutex<HashMap<String, String>>,
    /// Sotto thread ID -> last user message ID for `afterMessageId` on turns.
    last_user_message_id: Mutex<HashMap<String, String>>,
    /// Sotto thread ID -> active turn activity JSON so completion preserves id/startedAt.
    turn_activities: Mutex<HashMap<String, Value>>,
    /// Codex item ID -> (Sotto message ID, accumulated text, added_to_store).
    streaming_items: Mutex<HashMap<String, (String, String, bool)>>,
    /// Request ID (`rpc:<serverId>:<rawId>`) -> inbound request awaiting user answer.
    pending_requests: Mutex<HashMap<String, InboundCodexRequest>>,
}

impl CodexSharedState {
    fn new(data_directory: PathBuf) -> Self {
        let records = load_codex_records(&data_directory);
        let mut native_to_sotto = HashMap::new();
        for (sotto_id, rec) in &records {
            native_to_sotto.insert(rec.codex_thread_id.clone(), sotto_id.clone());
        }
        Self {
            data_directory,
            events_tx: Mutex::new(None),
            status: Mutex::new(AgentProviderStatus {
                id: "codex".into(),
                name: "Codex".into(),
                connection: "disconnected".into(),
                version: String::new(),
                capabilities: codex_capabilities(),
                error: None,
            }),
            models: Mutex::new(Vec::new()),
            client_update: Mutex::new(None),
            records: Mutex::new(records),
            native_to_sotto: Mutex::new(native_to_sotto),
            active_turns: Mutex::new(HashMap::new()),
            last_user_message_id: Mutex::new(HashMap::new()),
            turn_activities: Mutex::new(HashMap::new()),
            streaming_items: Mutex::new(HashMap::new()),
            pending_requests: Mutex::new(HashMap::new()),
        }
    }

    fn emit(&self, ev: ProviderEvent) {
        if let Some(tx) = self.events_tx.lock().unwrap().as_ref() {
            let _ = tx.send(ev);
        }
    }

    fn save_records(&self) {
        let snapshot = self.records.lock().unwrap().clone();
        let path = self.data_directory.join(CODEX_THREADS_FILE);
        let _ = write_atomic_json(&path, &snapshot);
    }

    fn resolve_sotto_thread(&self, native_thread_id: &str) -> Option<String> {
        self.native_to_sotto
            .lock()
            .unwrap()
            .get(native_thread_id)
            .cloned()
    }

    fn handle_notification(&self, method: &str, params: Value) {
        let native_tid = params
            .get("threadId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let Some(sotto_tid) = self.resolve_sotto_thread(native_tid) else {
            return;
        };

        match method {
            "turn/started" => {
                let turn_id = params
                    .get("turn")
                    .and_then(|t| t.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if turn_id.is_empty() {
                    return;
                }
                self.active_turns
                    .lock()
                    .unwrap()
                    .insert(sotto_tid.clone(), turn_id.clone());
                let after_message_id = self
                    .last_user_message_id
                    .lock()
                    .unwrap()
                    .get(&sotto_tid)
                    .cloned();
                let act_id = codex_activity_id(native_tid, &turn_id);
                let mut act = json!({
                    "id": act_id,
                    "kind": "turn",
                    "sequence": 0,
                    "startedAt": now_iso(),
                    "status": "running",
                    "timingSource": "provider",
                    "title": "Working",
                    "turnId": turn_id,
                });
                if let Some(ref after) = after_message_id {
                    act.as_object_mut()
                        .unwrap()
                        .insert("afterMessageId".into(), Value::String(after.clone()));
                }
                self.turn_activities
                    .lock()
                    .unwrap()
                    .insert(sotto_tid.clone(), act.clone());
                self.emit(ProviderEvent::TurnStarted {
                    thread_id: sotto_tid,
                    turn_id,
                    after_message_id,
                    activity: act,
                });
            }
            "item/started" => {
                let Some(item) = params.get("item") else {
                    return;
                };
                let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
                let item_id = item.get("id").and_then(Value::as_str).unwrap_or("");
                if item_id.is_empty() {
                    return;
                }
                match item_type {
                    "agentMessage" => {
                        let initial = item.get("text").and_then(Value::as_str).unwrap_or("");
                        let msg_id = Uuid::new_v4().to_string();
                        let added = !initial.is_empty();
                        self.streaming_items.lock().unwrap().insert(
                            item_id.to_string(),
                            (msg_id.clone(), initial.to_string(), added),
                        );
                        if added {
                            self.emit(ProviderEvent::MessageAdded {
                                thread_id: sotto_tid,
                                message: StoredMessage {
                                    id: msg_id,
                                    role: "assistant".into(),
                                    text: initial.to_string(),
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
                    "commandExecution" => {
                        let command = item
                            .get("command")
                            .and_then(Value::as_str)
                            .unwrap_or("command");
                        let turn_id = params.get("turnId").and_then(Value::as_str).unwrap_or("");
                        let act = json!({
                            "id": codex_activity_id(native_tid, item_id),
                            "kind": "command",
                            "title": command,
                            "command": command,
                            "status": "running",
                            "turnId": turn_id,
                            "startedAt": now_iso(),
                        });
                        self.emit(ProviderEvent::ActivityUpserted {
                            thread_id: sotto_tid,
                            activity: act,
                        });
                    }
                    "fileChange" => {
                        let turn_id = params.get("turnId").and_then(Value::as_str).unwrap_or("");
                        let act = json!({
                            "id": codex_activity_id(native_tid, item_id),
                            "kind": "file-change",
                            "title": "Editing files",
                            "status": "running",
                            "turnId": turn_id,
                            "startedAt": now_iso(),
                        });
                        self.emit(ProviderEvent::ActivityUpserted {
                            thread_id: sotto_tid,
                            activity: act,
                        });
                    }
                    _ => {}
                }
            }
            "item/agentMessage/delta" => {
                let item_id = params.get("itemId").and_then(Value::as_str).unwrap_or("");
                let delta = params.get("delta").and_then(Value::as_str).unwrap_or("");
                if item_id.is_empty() || delta.is_empty() {
                    return;
                }
                let mut map = self.streaming_items.lock().unwrap();
                let entry = map
                    .entry(item_id.to_string())
                    .or_insert_with(|| (Uuid::new_v4().to_string(), String::new(), false));
                entry.1.push_str(delta);
                let msg_id = entry.0.clone();
                if !entry.2 {
                    entry.2 = true;
                    let text = entry.1.clone();
                    drop(map);
                    self.emit(ProviderEvent::MessageAdded {
                        thread_id: sotto_tid,
                        message: StoredMessage {
                            id: msg_id,
                            role: "assistant".into(),
                            text,
                            created_at: now_iso(),
                            command_id: None,
                            turn_message_id: None,
                            attachments: None,
                            watcher_own_change: None,
                            watcher_observed_changes: None,
                            provider_error: None,
                        },
                    });
                } else {
                    drop(map);
                    self.emit(ProviderEvent::MessageTextAppended {
                        thread_id: sotto_tid,
                        message_id: msg_id,
                        append_text: delta.to_string(),
                    });
                }
            }
            "item/completed" => {
                let Some(item) = params.get("item") else {
                    return;
                };
                let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
                let item_id = item.get("id").and_then(Value::as_str).unwrap_or("");
                if item_id.is_empty() {
                    return;
                }
                match item_type {
                    "agentMessage" => {
                        let final_text = item.get("text").and_then(Value::as_str).unwrap_or("");
                        let prev = self.streaming_items.lock().unwrap().remove(item_id);
                        let (msg_id, was_added) = match prev {
                            Some((id, _, added)) => (id, added),
                            None => (Uuid::new_v4().to_string(), false),
                        };
                        let msg = StoredMessage {
                            id: msg_id,
                            role: "assistant".into(),
                            text: final_text.to_string(),
                            created_at: now_iso(),
                            command_id: None,
                            turn_message_id: None,
                            attachments: None,
                            watcher_own_change: None,
                            watcher_observed_changes: None,
                            provider_error: None,
                        };
                        if was_added {
                            self.emit(ProviderEvent::MessageReplaced {
                                thread_id: sotto_tid,
                                message: msg,
                            });
                        } else {
                            self.emit(ProviderEvent::MessageAdded {
                                thread_id: sotto_tid,
                                message: msg,
                            });
                        }
                    }
                    "commandExecution" => {
                        let command = item
                            .get("command")
                            .and_then(Value::as_str)
                            .unwrap_or("command");
                        let turn_id = params.get("turnId").and_then(Value::as_str).unwrap_or("");
                        let act = json!({
                            "id": codex_activity_id(native_tid, item_id),
                            "kind": "command",
                            "title": command,
                            "command": command,
                            "status": "completed",
                            "turnId": turn_id,
                            "completedAt": now_iso(),
                        });
                        self.emit(ProviderEvent::ActivityUpserted {
                            thread_id: sotto_tid,
                            activity: act,
                        });
                    }
                    "fileChange" => {
                        let turn_id = params.get("turnId").and_then(Value::as_str).unwrap_or("");
                        let act = json!({
                            "id": codex_activity_id(native_tid, item_id),
                            "kind": "file-change",
                            "title": "Edited files",
                            "status": "completed",
                            "turnId": turn_id,
                            "completedAt": now_iso(),
                        });
                        self.emit(ProviderEvent::ActivityUpserted {
                            thread_id: sotto_tid,
                            activity: act,
                        });
                    }
                    _ => {}
                }
            }
            "turn/completed" => {
                let turn = params.get("turn").cloned().unwrap_or(Value::Null);
                let turn_id = turn
                    .get("id")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .or_else(|| self.active_turns.lock().unwrap().get(&sotto_tid).cloned())
                    .unwrap_or_default();
                let raw_status = turn
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("completed");
                let status = match raw_status {
                    "interrupted" => "interrupted",
                    "failed" => "failed",
                    _ => "completed",
                };
                let title = match status {
                    "interrupted" => "Turn interrupted",
                    "failed" => "Turn failed",
                    _ => "Turn completed",
                };
                self.active_turns.lock().unwrap().remove(&sotto_tid);
                if let Some(mut act) = self.turn_activities.lock().unwrap().remove(&sotto_tid) {
                    if let Some(obj) = act.as_object_mut() {
                        obj.insert("status".into(), Value::String(status.into()));
                        obj.insert("title".into(), Value::String(title.into()));
                        obj.insert("completedAt".into(), Value::String(now_iso()));
                    }
                    self.emit(ProviderEvent::ActivityUpserted {
                        thread_id: sotto_tid.clone(),
                        activity: act,
                    });
                }
                self.emit(ProviderEvent::TurnCompleted {
                    thread_id: sotto_tid,
                    turn_id,
                    status: status.into(),
                });
            }
            "serverRequest/resolved" => {
                if let Some(raw_req_id) = params.get("requestId") {
                    let matched_key = self
                        .pending_requests
                        .lock()
                        .unwrap()
                        .iter()
                        .find(|(_, r)| r.sotto_thread_id == sotto_tid && &r.raw_id == raw_req_id)
                        .map(|(k, _)| k.clone());
                    if let Some(key) = matched_key {
                        self.pending_requests.lock().unwrap().remove(&key);
                        self.emit(ProviderEvent::RequestCleared {
                            thread_id: sotto_tid,
                            request_id: key,
                        });
                    }
                }
            }
            _ => {}
        }
    }

    fn handle_server_request(
        &self,
        server_id: &str,
        raw_id: Value,
        method: &str,
        params: Value,
        stdin_tx: mpsc::UnboundedSender<String>,
    ) {
        let native_tid = params
            .get("threadId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let Some(sotto_tid) = self.resolve_sotto_thread(native_tid) else {
            return;
        };
        let req_id_str = match &raw_id {
            Value::Number(n) => format!("rpc:{server_id}:{n}"),
            Value::String(s) => format!("rpc:{server_id}:{s}"),
            other => format!("rpc:{server_id}:{other}"),
        };

        let request_card = build_codex_request_card(&req_id_str, method, &params);
        self.pending_requests.lock().unwrap().insert(
            req_id_str,
            InboundCodexRequest {
                raw_id,
                method: method.to_string(),
                sotto_thread_id: sotto_tid.clone(),
                params,
                stdin_tx,
            },
        );
        self.emit(ProviderEvent::RequestOpened {
            thread_id: sotto_tid,
            request: request_card,
        });
    }
}

pub struct CodexAdapter {
    config: CodexAdapterConfig,
    shared: Arc<CodexSharedState>,
    control_proc: tokio::sync::Mutex<Option<Arc<RpcProcess>>>,
    thread_procs: tokio::sync::Mutex<HashMap<String, Arc<RpcProcess>>>,
}

impl CodexAdapter {
    pub fn new(config: CodexAdapterConfig) -> Self {
        let shared = Arc::new(CodexSharedState::new(config.data_directory.clone()));
        Self {
            config,
            shared,
            control_proc: tokio::sync::Mutex::new(None),
            thread_procs: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    async fn ensure_thread_process(
        &self,
        sotto_thread_id: &str,
    ) -> Result<Arc<RpcProcess>, String> {
        let mut procs = self.thread_procs.lock().await;
        if let Some(existing) = procs.get(sotto_thread_id) {
            return Ok(Arc::clone(existing));
        }
        let proc = RpcProcess::spawn(&self.config, Arc::clone(&self.shared))?;
        proc.initialize(self.config.request_timeout_ms).await?;
        procs.insert(sotto_thread_id.to_string(), Arc::clone(&proc));
        Ok(proc)
    }
}

impl ProviderAdapter for CodexAdapter {
    fn id(&self) -> &str {
        "codex"
    }

    fn name(&self) -> &str {
        "Codex"
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
            let mut guard = self.control_proc.lock().await;
            if guard.is_none() {
                let proc = RpcProcess::spawn(&self.config, Arc::clone(&self.shared))?;
                let init = proc.initialize(self.config.request_timeout_ms).await?;
                let version = init
                    .get("userAgent")
                    .and_then(Value::as_str)
                    .unwrap_or("codex/0.154.0")
                    .to_string();
                let installed = version
                    .strip_prefix("codex/")
                    .unwrap_or(&version)
                    .to_string();

                let mut models = Vec::new();
                let mut cursor: Option<String> = None;
                loop {
                    let params = match &cursor {
                        Some(c) => json!({ "cursor": c }),
                        None => json!({}),
                    };
                    let page = proc
                        .call("model/list", params, self.config.request_timeout_ms)
                        .await?;
                    if let Some(arr) = page.get("data").and_then(Value::as_array) {
                        for entry in arr {
                            let raw_model = entry
                                .get("model")
                                .or_else(|| entry.get("id"))
                                .and_then(Value::as_str)
                                .unwrap_or("codex-default");
                            let display_name = entry
                                .get("displayName")
                                .and_then(Value::as_str)
                                .unwrap_or(raw_model);
                            let default_effort = entry
                                .get("defaultReasoningEffort")
                                .and_then(Value::as_str)
                                .map(ToString::to_string);
                            let efforts: Vec<String> = entry
                                .get("supportedReasoningEfforts")
                                .and_then(Value::as_array)
                                .map(|items| {
                                    items
                                        .iter()
                                        .filter_map(|e| {
                                            e.get("reasoningEffort")
                                                .and_then(Value::as_str)
                                                .map(ToString::to_string)
                                        })
                                        .collect()
                                })
                                .unwrap_or_default();
                            models.push(AgentModel {
                                id: public_provider_entity_id("codex", "model", raw_model),
                                name: display_name.to_string(),
                                provider: "Codex".into(),
                                provider_id: "codex".into(),
                                ready: true,
                                default_reasoning_effort: default_effort,
                                reasoning_efforts: (!efforts.is_empty()).then_some(efforts),
                                runtime_modes: Some(vec![
                                    "approval-required".into(),
                                    "auto-accept-edits".into(),
                                    "auto".into(),
                                    "full-access".into(),
                                ]),
                                provider_modes: None,
                                supports_images: Some(true),
                            });
                        }
                    }
                    cursor = page
                        .get("nextCursor")
                        .and_then(Value::as_str)
                        .map(ToString::to_string);
                    if cursor.is_none() {
                        break;
                    }
                }

                let status = AgentProviderStatus {
                    id: "codex".into(),
                    name: "Codex".into(),
                    connection: "connected".into(),
                    version,
                    capabilities: codex_capabilities(),
                    error: None,
                };
                let client_upd = ClientUpdateRow {
                    id: "codex".into(),
                    installed,
                    behind: false,
                    can_install: false,
                    channel: "unknown".into(),
                    checked_at: Some(now_iso()),
                    state: "idle".into(),
                };
                *self.shared.status.lock().unwrap() = status.clone();
                *self.shared.models.lock().unwrap() = models.clone();
                *self.shared.client_update.lock().unwrap() = Some(client_upd.clone());
                *guard = Some(proc);

                self.shared.emit(ProviderEvent::StatusChanged {
                    provider_id: "codex".into(),
                    status,
                    models,
                    client_update: Some(client_upd),
                });
            }
            Ok(())
        })
    }

    fn disconnect(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            if let Some(proc) = self.control_proc.lock().await.take() {
                proc.shutdown().await;
            }
            let procs: Vec<_> = self.thread_procs.lock().await.drain().collect();
            for (_, proc) in procs {
                proc.shutdown().await;
            }
            let mut status = self.shared.status.lock().unwrap().clone();
            status.connection = "disconnected".into();
            *self.shared.status.lock().unwrap() = status.clone();
            let models = self.shared.models.lock().unwrap().clone();
            let upd = self.shared.client_update.lock().unwrap().clone();
            self.shared.emit(ProviderEvent::StatusChanged {
                provider_id: "codex".into(),
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
        // Codex sessions start lazily on first send, matching Sotto's TS adapter.
        Box::pin(async { Ok(()) })
    }

    fn send_message(&self, req: SendMessageRequest) -> BoxFuture<'_, Result<SendMessageAck, String>> {
        Box::pin(async move {
            let started = Instant::now();
            let proc = self.ensure_thread_process(&req.thread_id).await?;
            let raw_model = req
                .model_id
                .as_deref()
                .map(raw_codex_model)
                .unwrap_or_else(|| "fixture-model".to_string());
            let (approval_policy, sandbox) = map_codex_runtime_mode(req.runtime_mode.as_deref());
            let effort = req.reasoning_effort.clone().unwrap_or_else(|| "low".into());

            // Start or resume the native Codex thread on this thread's app-server.
            let existing_record = self
                .shared
                .records
                .lock()
                .unwrap()
                .get(&req.thread_id)
                .cloned();
            let codex_thread_id = match existing_record {
                None => {
                    let result = proc
                        .call(
                            "thread/start",
                            json!({
                                "cwd": req.cwd,
                                "model": raw_model,
                                "approvalPolicy": approval_policy,
                                "sandbox": sandbox,
                                "config": {
                                    "model_reasoning_effort": effort,
                                    "features.default_mode_request_user_input": true,
                                }
                            }),
                            self.config.request_timeout_ms,
                        )
                        .await?;
                    let native_id = result
                        .get("thread")
                        .and_then(|t| t.get("id"))
                        .and_then(Value::as_str)
                        .ok_or_else(|| "Codex thread/start returned no thread ID.".to_string())?
                        .to_string();
                    self.shared.records.lock().unwrap().insert(
                        req.thread_id.clone(),
                        CodexThreadRecord {
                            codex_thread_id: native_id.clone(),
                            cwd: req.cwd.clone(),
                            model: Some(raw_model),
                            reasoning_effort: Some(effort),
                            runtime_mode: req.runtime_mode.clone(),
                        },
                    );
                    self.shared
                        .native_to_sotto
                        .lock()
                        .unwrap()
                        .insert(native_id.clone(), req.thread_id.clone());
                    self.shared.save_records();
                    native_id
                }
                Some(rec) => {
                    // Ensure loaded in this thread process (idempotent in Codex when already loaded).
                    let _ = proc
                        .call(
                            "thread/resume",
                            json!({
                                "threadId": rec.codex_thread_id,
                                "excludeTurns": true,
                                "model": raw_model,
                                "approvalPolicy": approval_policy,
                                "sandbox": sandbox,
                                "config": {
                                    "model_reasoning_effort": effort,
                                    "features.default_mode_request_user_input": true,
                                }
                            }),
                            self.config.request_timeout_ms,
                        )
                        .await;
                    rec.codex_thread_id
                }
            };

            let message_id = Uuid::new_v4().to_string();
            self.shared
                .last_user_message_id
                .lock()
                .unwrap()
                .insert(req.thread_id.clone(), message_id.clone());

            let mut input = vec![json!({ "type": "text", "text": req.text })];
            for att in &req.attachments {
                if att.handle.kind == "image" {
                    input.push(json!({
                        "type": "localImage",
                        "path": att.path.to_string_lossy(),
                    }));
                } else {
                    input.push(json!({
                        "type": "text",
                        "text": format!("Attached file: {} ({})", att.handle.name, att.path.to_string_lossy()),
                    }));
                }
            }

            let active_turn = self
                .shared
                .active_turns
                .lock()
                .unwrap()
                .get(&req.thread_id)
                .cloned();

            let rpc_res = if let Some(expected_turn_id) = active_turn {
                proc.call(
                    "turn/steer",
                    json!({
                        "threadId": codex_thread_id,
                        "expectedTurnId": expected_turn_id,
                        "clientUserMessageId": message_id,
                        "input": input,
                    }),
                    self.config.request_timeout_ms,
                )
                .await
            } else {
                proc.call(
                    "turn/start",
                    json!({
                        "threadId": codex_thread_id,
                        "cwd": req.cwd,
                        "clientUserMessageId": message_id,
                        "input": input,
                    }),
                    self.config.request_timeout_ms,
                )
                .await
            };

            let latency = started.elapsed().as_millis() as u64;
            match rpc_res {
                Ok(result) => {
                    let turn_id = result
                        .get("turn")
                        .and_then(|t| t.get("id"))
                        .or_else(|| result.get("turnId"))
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                        .unwrap_or_else(|| Uuid::new_v4().to_string());
                    self.shared
                        .active_turns
                        .lock()
                        .unwrap()
                        .insert(req.thread_id.clone(), turn_id.clone());
                    Ok(SendMessageAck {
                        message_id,
                        turn_id,
                        status: "accepted".into(),
                        provider_latency_ms: latency,
                    })
                }
                Err(err) if err.starts_with("timeout:") => Ok(SendMessageAck {
                    message_id,
                    turn_id: Uuid::new_v4().to_string(),
                    status: "uncertain".into(),
                    provider_latency_ms: latency,
                }),
                Err(err) => Err(err),
            }
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
                .ok_or_else(|| "No pending Codex request matches that ID.".to_string())?;

            let result = build_codex_response_payload(&pending.method, &pending.params, &req);
            let frame = json!({
                "id": pending.raw_id,
                "result": result,
            });
            let encoded = serde_json::to_string(&frame).map_err(|e| e.to_string())?;
            pending
                .stdin_tx
                .send(encoded)
                .map_err(|_| "Codex process closed before receiving the answer.".to_string())?;

            self.shared.emit(ProviderEvent::RequestCleared {
                thread_id: pending.sotto_thread_id,
                request_id: req.request_id,
            });
            Ok(())
        })
    }

    fn interrupt(&self, thread_id: String) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let codex_thread_id = self
                .shared
                .records
                .lock()
                .unwrap()
                .get(&thread_id)
                .map(|r| r.codex_thread_id.clone())
                .ok_or_else(|| "Codex has no active session for this thread.".to_string())?;
            let turn_id = self
                .shared
                .active_turns
                .lock()
                .unwrap()
                .get(&thread_id)
                .cloned()
                .unwrap_or_default();
            let proc = {
                let procs = self.thread_procs.lock().await;
                procs.get(&thread_id).cloned()
            }
            .ok_or_else(|| "Codex thread process is not running.".to_string())?;

            proc.call(
                "turn/interrupt",
                json!({
                    "threadId": codex_thread_id,
                    "turnId": turn_id,
                }),
                self.config.request_timeout_ms,
            )
            .await?;
            Ok(())
        })
    }

    fn compact(&self, thread_id: String) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let codex_thread_id = self
                .shared
                .records
                .lock()
                .unwrap()
                .get(&thread_id)
                .map(|r| r.codex_thread_id.clone())
                .ok_or_else(|| "Codex has no active session for this thread.".to_string())?;
            let proc = {
                let procs = self.thread_procs.lock().await;
                procs.get(&thread_id).cloned()
            }
            .ok_or_else(|| "Codex thread process is not running.".to_string())?;

            proc.call(
                "thread/compact/start",
                json!({ "threadId": codex_thread_id }),
                self.config.request_timeout_ms,
            )
            .await?;
            Ok(())
        })
    }
}

fn codex_capabilities() -> AgentCapabilities {
    AgentCapabilities {
        compact: Some(true),
        configure_thread: Some(true),
        interrupt: true,
        message_origin: true,
        observe: true,
        permissions: true,
        projects: true,
        questions: true,
        reconcile: true,
        skills: Some(true),
        steer: Some(true),
        submit: true,
        threads: true,
    }
}

fn raw_codex_model(model_id: &str) -> String {
    parse_public_provider_entity_id(model_id)
        .map(|(_, _, raw)| raw.to_string())
        .unwrap_or_else(|| model_id.to_string())
}

fn map_codex_runtime_mode(mode: Option<&str>) -> (&'static str, &'static str) {
    match mode.unwrap_or("approval-required") {
        "full-access" => ("never", "danger-full-access"),
        "auto" => ("on-request", "workspace-write"),
        "auto-accept-edits" => ("on-request", "workspace-write"),
        _ => ("untrusted", "workspace-write"),
    }
}

fn codex_activity_id(native_thread_id: &str, key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("codex:{native_thread_id}:{key}").as_bytes());
    let digest = crate::providers::hex_encode(&hasher.finalize());
    format!("codex-activity-{digest}")
}

fn load_codex_records(data_directory: &Path) -> HashMap<String, CodexThreadRecord> {
    let path = data_directory.join(CODEX_THREADS_FILE);
    let Ok(raw) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn build_codex_request_card(req_id: &str, method: &str, params: &Value) -> Value {
    let item_id = params
        .get("itemId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    match method {
        "item/tool/requestUserInput" => {
            let mut questions = Vec::new();
            let mut top_options = Vec::new();
            let mut text = String::new();
            if let Some(arr) = params.get("questions").and_then(Value::as_array) {
                for (idx, q) in arr.iter().enumerate() {
                    let qid = q
                        .get("id")
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                        .unwrap_or_else(|| idx.to_string());
                    let header = q.get("header").and_then(Value::as_str).unwrap_or("Question");
                    let question = q.get("question").and_then(Value::as_str).unwrap_or("");
                    if text.is_empty() {
                        text = question.to_string();
                    }
                    let opts: Vec<Value> = q
                        .get("options")
                        .and_then(Value::as_array)
                        .map(|list| {
                            list.iter()
                                .map(|o| {
                                    let label = o.get("label").and_then(Value::as_str).unwrap_or("");
                                    let desc = o.get("description").and_then(Value::as_str);
                                    let mut obj = Map::new();
                                    obj.insert("id".into(), Value::String(label.into()));
                                    obj.insert("label".into(), Value::String(label.into()));
                                    if let Some(d) = desc {
                                        obj.insert("description".into(), Value::String(d.into()));
                                    }
                                    Value::Object(obj)
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    if idx == 0 {
                        for o in &opts {
                            if let Some(lbl) = o.get("label").and_then(Value::as_str) {
                                top_options.push(json!({ "id": lbl, "label": lbl }));
                            }
                        }
                    }
                    questions.push(json!({
                        "id": qid,
                        "header": header,
                        "question": question,
                        "options": opts,
                        "allowFreeText": true,
                        "multiSelect": false,
                    }));
                }
            }
            json!({
                "id": req_id,
                "kind": "question",
                "text": text,
                "since": now_iso(),
                "options": top_options,
                "questions": questions,
                "context": {
                    "toolCallId": item_id,
                    "toolName": method,
                }
            })
        }
        "mcpServer/elicitation/request" => {
            let msg = params
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Provide input");
            json!({
                "id": req_id,
                "kind": "question",
                "text": msg,
                "since": now_iso(),
                "options": [],
                "context": {
                    "toolCallId": item_id,
                    "toolName": method,
                }
            })
        }
        _ => {
            // Permission requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, etc.).
            let command = params.get("command").and_then(Value::as_str);
            let reason = params
                .get("reason")
                .and_then(Value::as_str)
                .or(command)
                .unwrap_or("Approve Codex action?");
            let mut ctx = Map::new();
            ctx.insert("toolCallId".into(), Value::String(item_id));
            ctx.insert("toolName".into(), Value::String(method.into()));
            if let Some(cmd) = command {
                ctx.insert("command".into(), Value::String(cmd.into()));
            }
            ctx.insert("summary".into(), Value::String(reason.into()));
            json!({
                "id": req_id,
                "kind": "permission",
                "text": reason,
                "since": now_iso(),
                "options": [
                    { "id": "allow", "label": "Allow" },
                    { "id": "deny", "label": "Deny" }
                ],
                "permissionChoices": [
                    { "id": "allow", "kind": "allow-once", "label": "Allow once" },
                    { "id": "deny", "kind": "deny", "label": "Deny" }
                ],
                "context": Value::Object(ctx),
            })
        }
    }
}

fn build_codex_response_payload(method: &str, params: &Value, req: &AnswerRequestInput) -> Value {
    match method {
        "item/tool/requestUserInput" => {
            let mut answers = Map::new();
            if let Some(obj) = req.question_answers.as_ref().and_then(Value::as_object) {
                for (k, v) in obj {
                    let list = match v {
                        Value::String(s) => vec![Value::String(s.clone())],
                        Value::Array(arr) => arr
                            .iter()
                            .filter_map(|x| x.as_str().map(|s| Value::String(s.into())))
                            .collect(),
                        _ => vec![Value::String(req.answer.clone())],
                    };
                    answers.insert(k.clone(), json!({ "answers": list }));
                }
            } else if let Some(arr) = params.get("questions").and_then(Value::as_array) {
                for (idx, q) in arr.iter().enumerate() {
                    let qid = q
                        .get("id")
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                        .unwrap_or_else(|| idx.to_string());
                    answers.insert(qid, json!({ "answers": [req.answer.clone()] }));
                }
            }
            json!({ "answers": Value::Object(answers) })
        }
        "item/permissions/requestApproval" => {
            let approved = req.approved.unwrap_or(false);
            let perms = if approved {
                params.get("permissions").cloned().unwrap_or_else(|| json!({}))
            } else {
                json!({})
            };
            json!({ "permissions": perms, "scope": "turn" })
        }
        "mcpServer/elicitation/request" => {
            let action = if req.approved.unwrap_or(!req.answer.is_empty()) {
                "accept"
            } else {
                "decline"
            };
            json!({ "action": action })
        }
        "applyPatchApproval" | "execCommandApproval" => {
            let decision = if req.approved.unwrap_or(false) {
                "approved"
            } else {
                "abort"
            };
            json!({ "decision": decision })
        }
        _ => {
            // `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`.
            let decision = match req.permission_choice.as_deref() {
                Some("allow-session") | Some("acceptForSession") => "acceptForSession",
                Some("allow") | Some("allow-once") | Some("accept") => "accept",
                Some("deny") | Some("decline") => "decline",
                _ => {
                    if req.approved.unwrap_or(false) {
                        "accept"
                    } else {
                        "decline"
                    }
                }
            };
            json!({ "decision": decision })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_response_shapes_match_generated_schema() {
        let q_params = json!({
            "questions": [{ "id": "choice", "header": "Choice", "question": "Which colour?", "options": [{ "label": "Blue" }] }]
        });
        let q_res = build_codex_response_payload(
            "item/tool/requestUserInput",
            &q_params,
            &AnswerRequestInput {
                thread_id: "t1".into(),
                request_id: "rpc:s:1".into(),
                answer: "Blue".into(),
                approved: None,
                permission_choice: None,
                question_answers: None,
            },
        );
        assert_eq!(q_res["answers"]["choice"]["answers"][0], "Blue");

        let p_res = build_codex_response_payload(
            "item/commandExecution/requestApproval",
            &json!({}),
            &AnswerRequestInput {
                thread_id: "t1".into(),
                request_id: "rpc:s:2".into(),
                answer: String::new(),
                approved: Some(true),
                permission_choice: None,
                question_answers: None,
            },
        );
        assert_eq!(p_res["decision"], "accept");
    }
}
