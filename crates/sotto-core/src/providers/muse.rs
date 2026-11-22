use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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

pub const MUSE_THREADS_FILE: &str = "muse-threads.json";

#[derive(Debug, Clone)]
pub struct MuseAdapterConfig {
    pub data_directory: PathBuf,
    pub executable: String,
    pub args: Vec<String>,
    pub request_timeout_ms: u64,
}

impl MuseAdapterConfig {
    pub fn native(data_directory: PathBuf) -> Self {
        Self {
            data_directory,
            executable: "muse".into(),
            args: vec!["serve".into()],
            request_timeout_ms: 30_000,
        }
    }

    pub fn fake(data_directory: PathBuf, fake_script: PathBuf) -> Self {
        Self {
            data_directory: data_directory.clone(),
            executable: std::env::var("SOTTO_NODE_BIN").unwrap_or_else(|_| "node".into()),
            args: vec![
                fake_script.to_string_lossy().into_owned(),
                data_directory.to_string_lossy().into_owned(),
            ],
            request_timeout_ms: 2_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MuseThreadRecord {
    muse_session_id: String,
    #[serde(default)]
    cwd: String,
}

#[derive(Debug, Clone)]
enum PendingMuseRequest {
    Approval {
        sotto_thread_id: String,
        native_session_id: String,
        approval_id: String,
        requirement_id: Value,
    },
    UserInput {
        sotto_thread_id: String,
        native_session_id: String,
        user_input_id: String,
        questions: Vec<Value>,
    },
}

type PendingMspMap = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;

struct MspProcess {
    stdin_tx: mpsc::UnboundedSender<String>,
    pending_outbound: PendingMspMap,
    next_id: AtomicI64,
    child: Mutex<Option<Child>>,
}

impl MspProcess {
    fn spawn(
        config: &MuseAdapterConfig,
        shared: Arc<MuseSharedState>,
        ephemeral: bool,
    ) -> Result<Arc<Self>, String> {
        let mut args = config.args.clone();
        if ephemeral {
            args.push("--no-session-log".into());
        }
        let mut cmd = Command::new(&config.executable);
        cmd.args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Could not start Muse ({}): {e}", config.executable))?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Muse stdin unavailable.".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Muse stdout unavailable.".to_string())?;

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

        let pending_outbound: PendingMspMap = Arc::new(Mutex::new(HashMap::new()));
        let reader_pending = Arc::clone(&pending_outbound);
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
                    if let Some(id_num) = val.get("id").and_then(Value::as_i64) {
                        if let Some(tx) = reader_pending.lock().unwrap().remove(&id_num) {
                            if let Some(err) = val.get("error") {
                                let msg = err
                                    .get("message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("Muse rejected the request.")
                                    .to_string();
                                let _ = tx.send(Err(msg));
                            } else {
                                let _ = tx.send(Ok(val.get("result").cloned().unwrap_or(Value::Null)));
                            }
                        }
                    }
                } else if has_method {
                    let method = val["method"].as_str().unwrap_or("");
                    let params = val.get("params").cloned().unwrap_or(Value::Null);
                    reader_shared.handle_notification(method, params);
                }
            }
            let drained: Vec<_> = reader_pending.lock().unwrap().drain().collect();
            for (_, tx) in drained {
                let _ = tx.send(Err("Muse exited before answering.".into()));
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
            return Err("Muse process is not running.".into());
        }
        match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Err("Muse closed before answering.".into()),
            Err(_) => {
                self.pending_outbound.lock().unwrap().remove(&id);
                Err(format!("timeout:{method}"))
            }
        }
    }

    fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        let encoded = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
        self.stdin_tx
            .send(encoded)
            .map_err(|_| "Muse process is not running.".to_string())
    }

    async fn initialize(&self, timeout_ms: u64) -> Result<Value, String> {
        let res = self
            .call(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": "sotto",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                    "capabilities": {
                        "requestedCapabilities": [],
                        "experimentalApi": false,
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

struct MuseSharedState {
    data_directory: PathBuf,
    events_tx: Mutex<Option<mpsc::UnboundedSender<ProviderEvent>>>,
    status: Mutex<AgentProviderStatus>,
    models: Mutex<Vec<AgentModel>>,
    client_update: Mutex<Option<ClientUpdateRow>>,
    records: Mutex<HashMap<String, MuseThreadRecord>>,
    native_to_sotto: Mutex<HashMap<String, String>>,
    active_turns: Mutex<HashMap<String, String>>,
    last_user_msg: Mutex<HashMap<String, String>>,
    turn_activities: Mutex<HashMap<String, Value>>,
    streaming_items: Mutex<HashMap<String, (String, String, bool)>>,
    pending_requests: Mutex<HashMap<String, PendingMuseRequest>>,
}

impl MuseSharedState {
    fn new(data_directory: PathBuf) -> Self {
        let records = load_muse_records(&data_directory);
        let mut native_to_sotto = HashMap::new();
        for (sotto_id, rec) in &records {
            native_to_sotto.insert(rec.muse_session_id.clone(), sotto_id.clone());
        }
        Self {
            data_directory,
            events_tx: Mutex::new(None),
            status: Mutex::new(AgentProviderStatus {
                id: "muse".into(),
                name: "Muse".into(),
                connection: "disconnected".into(),
                version: String::new(),
                capabilities: muse_capabilities(),
                error: None,
            }),
            models: Mutex::new(Vec::new()),
            client_update: Mutex::new(None),
            records: Mutex::new(records),
            native_to_sotto: Mutex::new(native_to_sotto),
            active_turns: Mutex::new(HashMap::new()),
            last_user_msg: Mutex::new(HashMap::new()),
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
        let path = self.data_directory.join(MUSE_THREADS_FILE);
        let _ = write_atomic_json(&path, &snapshot);
    }

    fn resolve_sotto(&self, native_sid: &str) -> Option<String> {
        self.native_to_sotto.lock().unwrap().get(native_sid).cloned()
    }

    fn handle_notification(&self, method: &str, params: Value) {
        let native_sid = params
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let Some(sotto_tid) = self.resolve_sotto(native_sid) else {
            return;
        };

        match method {
            "turn/started" => {
                let turn_id = params
                    .get("turnId")
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
                let after = self.last_user_msg.lock().unwrap().get(&sotto_tid).cloned();
                let mut act = json!({
                    "id": muse_id("activity", &format!("{native_sid}:{turn_id}")),
                    "kind": "turn",
                    "sequence": 0,
                    "startedAt": now_iso(),
                    "status": "running",
                    "timingSource": "provider",
                    "title": "Working",
                    "turnId": turn_id,
                });
                if let Some(ref a) = after {
                    act.as_object_mut()
                        .unwrap()
                        .insert("afterMessageId".into(), Value::String(a.clone()));
                }
                self.turn_activities
                    .lock()
                    .unwrap()
                    .insert(sotto_tid.clone(), act.clone());
                self.emit(ProviderEvent::TurnStarted {
                    thread_id: sotto_tid,
                    turn_id,
                    after_message_id: after,
                    activity: act,
                });
            }
            "item/started" => {
                let Some(item) = params.get("item") else {
                    return;
                };
                if item.get("kind").and_then(Value::as_str) == Some("agentMessage") {
                    if let Some(item_id) = item.get("itemId").and_then(Value::as_str) {
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
                }
            }
            "item/delta" => {
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
                if item.get("kind").and_then(Value::as_str) == Some("agentMessage") {
                    let item_id = item.get("itemId").and_then(Value::as_str).unwrap_or("");
                    let text = item.get("text").and_then(Value::as_str).unwrap_or("");
                    let prev = self.streaming_items.lock().unwrap().remove(item_id);
                    let (msg_id, was_added) = match prev {
                        Some((id, _, added)) => (id, added),
                        None => (Uuid::new_v4().to_string(), false),
                    };
                    let msg = StoredMessage {
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
            }
            "turn/completed" => {
                let turn_id = params
                    .get("turnId")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .or_else(|| self.active_turns.lock().unwrap().get(&sotto_tid).cloned())
                    .unwrap_or_default();
                let terminal = params
                    .get("terminal")
                    .and_then(Value::as_str)
                    .unwrap_or("completed");
                let status = match terminal {
                    "cancelled" | "interrupted" => "interrupted",
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
            "approval/requested" => {
                let approval_id = params
                    .get("approvalId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if approval_id.is_empty() {
                    return;
                }
                let req_id = muse_id("approval", &approval_id);
                let text = params
                    .get("subject")
                    .and_then(|s| s.get("command").or_else(|| s.get("toolName")))
                    .and_then(Value::as_str)
                    .unwrap_or("Approve Muse action?");
                let req_ref = params
                    .get("currentRequirementId")
                    .cloned()
                    .unwrap_or_else(|| json!({ "approvalId": approval_id, "sourceIndex": 0 }));
                self.pending_requests.lock().unwrap().insert(
                    req_id.clone(),
                    PendingMuseRequest::Approval {
                        sotto_thread_id: sotto_tid.clone(),
                        native_session_id: native_sid.to_string(),
                        approval_id,
                        requirement_id: req_ref,
                    },
                );
                let card = json!({
                    "id": req_id,
                    "kind": "permission",
                    "text": text,
                    "since": now_iso(),
                    "options": [
                        { "id": "allow", "label": "Allow" },
                        { "id": "deny", "label": "Deny" }
                    ],
                    "permissionChoices": [
                        { "id": "allow", "kind": "allow-once", "label": "Allow once" },
                        { "id": "deny", "kind": "deny", "label": "Deny" }
                    ],
                    "context": {
                        "toolName": params.get("toolName").and_then(Value::as_str).unwrap_or("bash"),
                        "summary": text,
                    }
                });
                self.emit(ProviderEvent::RequestOpened {
                    thread_id: sotto_tid,
                    request: card,
                });
            }
            "approval/resolved" => {
                if let Some(approval_id) = params.get("approvalId").and_then(Value::as_str) {
                    let req_id = muse_id("approval", approval_id);
                    self.pending_requests.lock().unwrap().remove(&req_id);
                    self.emit(ProviderEvent::RequestCleared {
                        thread_id: sotto_tid,
                        request_id: req_id,
                    });
                }
            }
            "userInput/requested" => {
                let user_input_id = params
                    .get("userInputId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if user_input_id.is_empty() {
                    return;
                }
                let req_id = muse_id("input", &user_input_id);
                let questions = params
                    .get("questions")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let text = questions
                    .first()
                    .and_then(|q| q.get("question"))
                    .and_then(Value::as_str)
                    .unwrap_or("Answer Muse question");
                self.pending_requests.lock().unwrap().insert(
                    req_id.clone(),
                    PendingMuseRequest::UserInput {
                        sotto_thread_id: sotto_tid.clone(),
                        native_session_id: native_sid.to_string(),
                        user_input_id,
                        questions: questions.clone(),
                    },
                );
                let card = json!({
                    "id": req_id,
                    "kind": "question",
                    "text": text,
                    "since": now_iso(),
                    "options": [],
                    "context": { "toolName": "request_user_input" },
                });
                self.emit(ProviderEvent::RequestOpened {
                    thread_id: sotto_tid,
                    request: card,
                });
            }
            "userInput/settled" => {
                if let Some(uid) = params.get("userInputId").and_then(Value::as_str) {
                    let req_id = muse_id("input", uid);
                    self.pending_requests.lock().unwrap().remove(&req_id);
                    self.emit(ProviderEvent::RequestCleared {
                        thread_id: sotto_tid,
                        request_id: req_id,
                    });
                }
            }
            _ => {}
        }
    }
}

pub struct MuseAdapter {
    config: MuseAdapterConfig,
    shared: Arc<MuseSharedState>,
    thread_procs: tokio::sync::Mutex<HashMap<String, Arc<MspProcess>>>,
}

impl MuseAdapter {
    pub fn new(config: MuseAdapterConfig) -> Self {
        let shared = Arc::new(MuseSharedState::new(config.data_directory.clone()));
        Self {
            config,
            shared,
            thread_procs: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    async fn ensure_thread_process(&self, thread_id: &str) -> Result<Arc<MspProcess>, String> {
        let mut map = self.thread_procs.lock().await;
        if let Some(existing) = map.get(thread_id) {
            return Ok(Arc::clone(existing));
        }
        let proc = MspProcess::spawn(&self.config, Arc::clone(&self.shared), false)?;
        proc.initialize(self.config.request_timeout_ms).await?;
        map.insert(thread_id.to_string(), Arc::clone(&proc));
        Ok(proc)
    }
}

impl ProviderAdapter for MuseAdapter {
    fn id(&self) -> &str {
        "muse"
    }

    fn name(&self) -> &str {
        "Muse"
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
            let probe = MspProcess::spawn(&self.config, Arc::clone(&self.shared), true)?;
            let init = probe.initialize(self.config.request_timeout_ms).await;
            let init = match init {
                Ok(v) => v,
                Err(e) => {
                    probe.shutdown().await;
                    return Err(e);
                }
            };
            let version = init
                .get("serverInfo")
                .and_then(|s| s.get("version"))
                .and_then(Value::as_str)
                .unwrap_or("1.1.1")
                .to_string();
            let listed = probe
                .call("model/list", json!({}), self.config.request_timeout_ms)
                .await
                .unwrap_or_default();
            probe.shutdown().await;

            let mut models = Vec::new();
            if let Some(arr) = listed.get("models").and_then(Value::as_array) {
                for entry in arr {
                    let raw = entry
                        .get("modelId")
                        .and_then(Value::as_str)
                        .unwrap_or("fixture-model");
                    let name = entry
                        .get("displayLabel")
                        .and_then(Value::as_str)
                        .unwrap_or(raw);
                    models.push(AgentModel {
                        id: public_provider_entity_id("muse", "model", raw),
                        name: name.to_string(),
                        provider: "Muse".into(),
                        provider_id: "muse".into(),
                        ready: true,
                        default_reasoning_effort: None,
                        reasoning_efforts: None,
                        runtime_modes: Some(vec![
                            "approval-required".into(),
                            "auto".into(),
                            "full-access".into(),
                        ]),
                        provider_modes: None,
                        supports_images: Some(true),
                    });
                }
            }

            let status = AgentProviderStatus {
                id: "muse".into(),
                name: "Muse".into(),
                connection: "connected".into(),
                version: version.clone(),
                capabilities: muse_capabilities(),
                error: None,
            };
            let upd = ClientUpdateRow {
                id: "muse".into(),
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
                provider_id: "muse".into(),
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
                provider_id: "muse".into(),
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
            let proc = self.ensure_thread_process(&req.thread_id).await?;
            let raw_model = req
                .model_id
                .as_deref()
                .and_then(|m| parse_public_provider_entity_id(m).map(|(_, _, raw)| raw.to_string()))
                .or(req.model_id.clone())
                .unwrap_or_else(|| "fixture-model".into());

            let existing = self
                .shared
                .records
                .lock()
                .unwrap()
                .get(&req.thread_id)
                .cloned();
            let muse_sid = match existing {
                None => {
                    let res = proc
                        .call(
                            "session/start",
                            json!({
                                "commandId": Uuid::new_v4().to_string(),
                                "workspaceRoot": req.cwd,
                                "modelId": raw_model,
                                "approvalMode": "promptUnmatched",
                            }),
                            self.config.request_timeout_ms,
                        )
                        .await?;
                    let sid = res
                        .get("session")
                        .and_then(|s| s.get("sessionId"))
                        .and_then(Value::as_str)
                        .ok_or_else(|| "Muse session/start returned no sessionId.".to_string())?
                        .to_string();
                    self.shared.records.lock().unwrap().insert(
                        req.thread_id.clone(),
                        MuseThreadRecord {
                            muse_session_id: sid.clone(),
                            cwd: req.cwd.clone(),
                        },
                    );
                    self.shared
                        .native_to_sotto
                        .lock()
                        .unwrap()
                        .insert(sid.clone(), req.thread_id.clone());
                    self.shared.save_records();
                    sid
                }
                Some(rec) => {
                    let _ = proc
                        .call(
                            "session/resume",
                            json!({
                                "sessionId": rec.muse_session_id,
                                "excludeItems": true,
                            }),
                            self.config.request_timeout_ms,
                        )
                        .await;
                    rec.muse_session_id
                }
            };

            let message_id = Uuid::new_v4().to_string();
            self.shared
                .last_user_msg
                .lock()
                .unwrap()
                .insert(req.thread_id.clone(), message_id.clone());

            let mut input = vec![json!({ "type": "text", "text": req.text })];
            for att in &req.attachments {
                if att.handle.kind == "image" {
                    input.push(json!({
                        "type": "image",
                        "path": att.path.to_string_lossy(),
                        "mimeType": att.handle.mime_type,
                    }));
                } else {
                    input.push(json!({
                        "type": "text",
                        "text": format!("Attached file: {} ({})", att.handle.name, att.path.to_string_lossy()),
                    }));
                }
            }

            let active = self
                .shared
                .active_turns
                .lock()
                .unwrap()
                .get(&req.thread_id)
                .cloned();
            let rpc = if let Some(expected_turn) = active {
                proc.call(
                    "turn/steer",
                    json!({
                        "sessionId": muse_sid,
                        "expectedTurnId": expected_turn,
                        "commandId": req.command_id,
                        "input": input,
                    }),
                    self.config.request_timeout_ms,
                )
                .await
            } else {
                proc.call(
                    "turn/start",
                    json!({
                        "sessionId": muse_sid,
                        "commandId": req.command_id,
                        "input": input,
                    }),
                    self.config.request_timeout_ms,
                )
                .await
            };

            let latency = started.elapsed().as_millis() as u64;
            match rpc {
                Ok(res) => {
                    let turn_id = res
                        .get("turnId")
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
                Err(e) if e.starts_with("timeout:") => Ok(SendMessageAck {
                    message_id,
                    turn_id: Uuid::new_v4().to_string(),
                    status: "uncertain".into(),
                    provider_latency_ms: latency,
                }),
                Err(e) => Err(e),
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
                .ok_or_else(|| "No pending Muse request matches that ID.".to_string())?;

            let sotto_tid = match &pending {
                PendingMuseRequest::Approval { sotto_thread_id, .. }
                | PendingMuseRequest::UserInput { sotto_thread_id, .. } => sotto_thread_id.clone(),
            };
            let proc = {
                let map = self.thread_procs.lock().await;
                map.get(&sotto_tid).cloned()
            }
            .ok_or_else(|| "Muse process is not running.".to_string())?;

            match pending {
                PendingMuseRequest::Approval {
                    native_session_id,
                    approval_id,
                    requirement_id,
                    ..
                } => {
                    let choice_id = if req.approved.unwrap_or(false) { "yes" } else { "no" };
                    proc.call(
                        "approval/decide",
                        json!({
                            "sessionId": native_session_id,
                            "commandId": Uuid::new_v4().to_string(),
                            "approvalId": approval_id,
                            "requirementId": requirement_id,
                            "choiceId": choice_id,
                        }),
                        self.config.request_timeout_ms,
                    )
                    .await?;
                }
                PendingMuseRequest::UserInput {
                    native_session_id,
                    user_input_id,
                    questions,
                    ..
                } => {
                    let answers: Vec<Value> = questions
                        .iter()
                        .map(|q| {
                            let qid = q.get("id").and_then(Value::as_str).unwrap_or("q1");
                            json!({ "questionId": qid, "text": req.answer })
                        })
                        .collect();
                    proc.call(
                        "userInput/answer",
                        json!({
                            "sessionId": native_session_id,
                            "userInputId": user_input_id,
                            "answers": answers,
                        }),
                        self.config.request_timeout_ms,
                    )
                    .await?;
                }
            }

            self.shared.emit(ProviderEvent::RequestCleared {
                thread_id: sotto_tid,
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
                .map(|r| r.muse_session_id.clone())
                .ok_or_else(|| "Muse has no active session for this thread.".to_string())?;
            let proc = {
                let map = self.thread_procs.lock().await;
                map.get(&thread_id).cloned()
            }
            .ok_or_else(|| "Muse thread process is not running.".to_string())?;
            proc.call(
                "turn/interrupt",
                json!({ "sessionId": sid }),
                self.config.request_timeout_ms,
            )
            .await?;
            Ok(())
        })
    }

    fn compact(&self, thread_id: String) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let sid = self
                .shared
                .records
                .lock()
                .unwrap()
                .get(&thread_id)
                .map(|r| r.muse_session_id.clone())
                .ok_or_else(|| "Muse has no active session for this thread.".to_string())?;
            let proc = {
                let map = self.thread_procs.lock().await;
                map.get(&thread_id).cloned()
            }
            .ok_or_else(|| "Muse thread process is not running.".to_string())?;
            proc.call(
                "session/compact",
                json!({ "sessionId": sid }),
                self.config.request_timeout_ms,
            )
            .await?;
            Ok(())
        })
    }
}

fn muse_capabilities() -> AgentCapabilities {
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
        skills: Some(false),
        steer: Some(true),
        submit: true,
        threads: true,
    }
}

fn muse_id(kind: &str, key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("muse:{kind}:{key}").as_bytes());
    format!("muse-{kind}-{}", crate::providers::hex_encode(&hasher.finalize()))
}

fn load_muse_records(data_directory: &Path) -> HashMap<String, MuseThreadRecord> {
    let path = data_directory.join(MUSE_THREADS_FILE);
    let Ok(raw) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}
