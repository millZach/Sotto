use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
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

pub const OPENCODE_THREADS_FILE: &str = "opencode-threads.json";

#[derive(Debug, Clone)]
pub struct OpenCodeAdapterConfig {
    pub data_directory: PathBuf,
    pub executable: String,
    pub args: Vec<String>,
    pub request_timeout_ms: u64,
}

impl OpenCodeAdapterConfig {
    pub fn native(data_directory: PathBuf) -> Self {
        Self {
            data_directory,
            executable: "opencode".into(),
            args: vec!["serve".into(), "--port=0".into()],
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
                "--port=0".into(),
            ],
            request_timeout_ms: 3_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenCodeThreadRecord {
    session_id: String,
    #[serde(default)]
    cwd: String,
}

#[derive(Debug, Clone)]
enum PendingOpenCodeRequest {
    Permission {
        sotto_thread_id: String,
        native_session_id: String,
        permission_id: String,
    },
    Form {
        sotto_thread_id: String,
        native_session_id: String,
        form_id: String,
        field_keys: Vec<String>,
    },
}

struct OpenCodeServerHandle {
    port: u16,
    auth_header: String,
    child: Mutex<Option<Child>>,
    sse_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl OpenCodeServerHandle {
    async fn start(
        config: &OpenCodeAdapterConfig,
        shared: Arc<OpenCodeSharedState>,
    ) -> Result<Arc<Self>, String> {
        let mut pw_bytes = [0u8; 18];
        rand::thread_rng().fill_bytes(&mut pw_bytes);
        let password = URL_SAFE_NO_PAD.encode(pw_bytes);
        let auth_header = format!(
            "Basic {}",
            STANDARD.encode(format!("opencode:{password}").as_bytes())
        );

        let xdg_data = config.data_directory.join("xdg-data");
        let _ = fs::create_dir_all(&xdg_data);

        let mut cmd = Command::new(&config.executable);
        cmd.args(&config.args)
            .env("OPENCODE_PASSWORD", &password)
            .env("XDG_DATA_HOME", &xdg_data)
            .stdin(Stdio::null())
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
            .map_err(|e| format!("Could not start OpenCode ({}): {e}", config.executable))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "OpenCode stdout unavailable.".to_string())?;

        let mut lines = BufReader::new(stdout).lines();
        let port = tokio::time::timeout(Duration::from_secs(15), async {
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(pos) = line.find("http://127.0.0.1:") {
                    let rest = &line[pos + "http://127.0.0.1:".len()..];
                    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                    if let Ok(p) = digits.parse::<u16>() {
                        return Ok(p);
                    }
                }
            }
            Err("OpenCode exited before printing its listener port.".to_string())
        })
        .await
        .map_err(|_| "OpenCode did not start listening in time.".to_string())??;

        // Keep draining stdout so the child never blocks on a full stdout pipe.
        tokio::spawn(async move {
            while let Ok(Some(_)) = lines.next_line().await {}
        });

        let sse_auth = auth_header.clone();
        let sse_shared = Arc::clone(&shared);
        let sse_task = tokio::spawn(async move {
            let _ = run_sse_loop(port, &sse_auth, sse_shared).await;
        });

        Ok(Arc::new(Self {
            port,
            auth_header,
            child: Mutex::new(Some(child)),
            sse_task: Mutex::new(Some(sse_task)),
        }))
    }

    async fn http_json(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        timeout_ms: u64,
    ) -> Result<(u16, Value), String> {
        let req_fut = http_request_loopback(self.port, method, path, &self.auth_header, body);
        match tokio::time::timeout(Duration::from_millis(timeout_ms), req_fut).await {
            Ok(Ok(res)) => Ok(res),
            Ok(Err(e)) => Err(e),
            Err(_) => Err(format!("timeout:{method}:{path}")),
        }
    }

    async fn shutdown(&self) {
        if let Some(task) = self.sse_task.lock().unwrap().take() {
            task.abort();
        }
        let child = self.child.lock().unwrap().take();
        if let Some(mut c) = child {
            let _ = c.kill().await;
        }
    }
}

struct OpenCodeSharedState {
    data_directory: PathBuf,
    events_tx: Mutex<Option<mpsc::UnboundedSender<ProviderEvent>>>,
    status: Mutex<AgentProviderStatus>,
    models: Mutex<Vec<AgentModel>>,
    client_update: Mutex<Option<ClientUpdateRow>>,
    records: Mutex<HashMap<String, OpenCodeThreadRecord>>,
    native_to_sotto: Mutex<HashMap<String, String>>,
    active_turns: Mutex<HashMap<String, (String, Value)>>,
    last_user_msg: Mutex<HashMap<String, String>>,
    streaming_msgs: Mutex<HashMap<String, (String, String, bool)>>,
    pending_requests: Mutex<HashMap<String, PendingOpenCodeRequest>>,
}

impl OpenCodeSharedState {
    fn new(data_directory: PathBuf) -> Self {
        let records = load_opencode_records(&data_directory);
        let mut native_to_sotto = HashMap::new();
        for (sotto_id, rec) in &records {
            native_to_sotto.insert(rec.session_id.clone(), sotto_id.clone());
        }
        Self {
            data_directory,
            events_tx: Mutex::new(None),
            status: Mutex::new(AgentProviderStatus {
                id: "opencode".into(),
                name: "OpenCode".into(),
                connection: "disconnected".into(),
                version: String::new(),
                capabilities: opencode_capabilities(),
                error: None,
            }),
            models: Mutex::new(Vec::new()),
            client_update: Mutex::new(None),
            records: Mutex::new(records),
            native_to_sotto: Mutex::new(native_to_sotto),
            active_turns: Mutex::new(HashMap::new()),
            last_user_msg: Mutex::new(HashMap::new()),
            streaming_msgs: Mutex::new(HashMap::new()),
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
        let path = self.data_directory.join(OPENCODE_THREADS_FILE);
        let _ = write_atomic_json(&path, &snapshot);
    }

    fn resolve_sotto(&self, native_sid: &str) -> Option<String> {
        self.native_to_sotto.lock().unwrap().get(native_sid).cloned()
    }

    fn handle_sse_event(&self, event: &Value) {
        let etype = event.get("type").and_then(Value::as_str).unwrap_or("");
        let data = event.get("data").cloned().unwrap_or(Value::Null);
        let native_sid = data
            .get("sessionID")
            .or_else(|| data.get("form").and_then(|f| f.get("sessionID")))
            .and_then(Value::as_str)
            .unwrap_or("");
        let Some(sotto_tid) = self.resolve_sotto(native_sid) else {
            return;
        };

        match etype {
            "session.execution.started" => {
                let turn_id = Uuid::new_v4().to_string();
                let after = self.last_user_msg.lock().unwrap().get(&sotto_tid).cloned();
                let mut act = json!({
                    "id": opencode_id("turn", &format!("{native_sid}:{turn_id}")),
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
                self.active_turns
                    .lock()
                    .unwrap()
                    .insert(sotto_tid.clone(), (turn_id.clone(), act.clone()));
                self.emit(ProviderEvent::TurnStarted {
                    thread_id: sotto_tid,
                    turn_id,
                    after_message_id: after,
                    activity: act,
                });
            }
            "session.text.delta" => {
                let msg_key = data
                    .get("assistantMessageID")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let delta = data.get("delta").and_then(Value::as_str).unwrap_or("");
                if msg_key.is_empty() || delta.is_empty() {
                    return;
                }
                let mut map = self.streaming_msgs.lock().unwrap();
                let entry = map
                    .entry(msg_key.to_string())
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
            "session.text.ended" => {
                let msg_key = data
                    .get("assistantMessageID")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let text = data.get("text").and_then(Value::as_str).unwrap_or("");
                if msg_key.is_empty() {
                    return;
                }
                let prev = self.streaming_msgs.lock().unwrap().remove(msg_key);
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
            "session.execution.succeeded"
            | "session.execution.interrupted"
            | "session.execution.failed" => {
                let status = if etype.ends_with("interrupted") {
                    "interrupted"
                } else if etype.ends_with("failed") {
                    "failed"
                } else {
                    "completed"
                };
                let title = match status {
                    "interrupted" => "Turn interrupted",
                    "failed" => "Turn failed",
                    _ => "Turn completed",
                };
                let (turn_id, act_opt) = match self.active_turns.lock().unwrap().remove(&sotto_tid)
                {
                    Some((tid, mut act)) => {
                        if let Some(obj) = act.as_object_mut() {
                            obj.insert("status".into(), Value::String(status.into()));
                            obj.insert("title".into(), Value::String(title.into()));
                            obj.insert("completedAt".into(), Value::String(now_iso()));
                        }
                        (tid, Some(act))
                    }
                    None => (Uuid::new_v4().to_string(), None),
                };
                if let Some(act) = act_opt {
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
            "permission.asked" => {
                let perm_id = data.get("id").and_then(Value::as_str).unwrap_or("");
                if perm_id.is_empty() {
                    return;
                }
                let text = data
                    .get("resources")
                    .and_then(Value::as_array)
                    .and_then(|a| a.first())
                    .and_then(Value::as_str)
                    .unwrap_or("Approve OpenCode action?");
                let req_id = opencode_id("permission", perm_id);
                self.pending_requests.lock().unwrap().insert(
                    req_id.clone(),
                    PendingOpenCodeRequest::Permission {
                        sotto_thread_id: sotto_tid.clone(),
                        native_session_id: native_sid.to_string(),
                        permission_id: perm_id.to_string(),
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
                        "toolName": data.get("action").and_then(Value::as_str).unwrap_or("shell"),
                        "summary": text,
                    }
                });
                self.emit(ProviderEvent::RequestOpened {
                    thread_id: sotto_tid,
                    request: card,
                });
            }
            "permission.replied" => {
                if let Some(pid) = data.get("requestID").and_then(Value::as_str) {
                    let req_id = opencode_id("permission", pid);
                    self.pending_requests.lock().unwrap().remove(&req_id);
                    self.emit(ProviderEvent::RequestCleared {
                        thread_id: sotto_tid,
                        request_id: req_id,
                    });
                }
            }
            "form.created" => {
                let Some(form) = data.get("form") else {
                    return;
                };
                let form_id = form.get("id").and_then(Value::as_str).unwrap_or("");
                if form_id.is_empty() {
                    return;
                }
                let fields = form
                    .get("fields")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let keys: Vec<String> = fields
                    .iter()
                    .filter_map(|f| f.get("key").and_then(Value::as_str).map(ToString::to_string))
                    .collect();
                let text = fields
                    .first()
                    .and_then(|f| f.get("description").or_else(|| f.get("title")))
                    .and_then(Value::as_str)
                    .unwrap_or("Answer OpenCode question");
                let req_id = opencode_id("form", form_id);
                self.pending_requests.lock().unwrap().insert(
                    req_id.clone(),
                    PendingOpenCodeRequest::Form {
                        sotto_thread_id: sotto_tid.clone(),
                        native_session_id: native_sid.to_string(),
                        form_id: form_id.to_string(),
                        field_keys: keys,
                    },
                );
                let card = json!({
                    "id": req_id,
                    "kind": "question",
                    "text": text,
                    "since": now_iso(),
                    "options": [],
                    "context": { "toolName": "question" },
                });
                self.emit(ProviderEvent::RequestOpened {
                    thread_id: sotto_tid,
                    request: card,
                });
            }
            "form.replied" | "form.cancelled" => {
                if let Some(fid) = data.get("id").and_then(Value::as_str) {
                    let req_id = opencode_id("form", fid);
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

pub struct OpenCodeAdapter {
    config: OpenCodeAdapterConfig,
    shared: Arc<OpenCodeSharedState>,
    server: tokio::sync::Mutex<Option<Arc<OpenCodeServerHandle>>>,
}

impl OpenCodeAdapter {
    pub fn new(config: OpenCodeAdapterConfig) -> Self {
        let shared = Arc::new(OpenCodeSharedState::new(config.data_directory.clone()));
        Self {
            config,
            shared,
            server: tokio::sync::Mutex::new(None),
        }
    }

    async fn get_server(&self) -> Result<Arc<OpenCodeServerHandle>, String> {
        self.server
            .lock()
            .await
            .clone()
            .ok_or_else(|| "OpenCode server is not connected.".to_string())
    }
}

impl ProviderAdapter for OpenCodeAdapter {
    fn id(&self) -> &str {
        "opencode"
    }

    fn name(&self) -> &str {
        "OpenCode"
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
            let mut guard = self.server.lock().await;
            if guard.is_none() {
                let srv = OpenCodeServerHandle::start(&self.config, Arc::clone(&self.shared)).await?;
                let (_, info) = srv
                    .http_json("GET", "/api/info", None, self.config.request_timeout_ms)
                    .await?;
                let version = info
                    .get("version")
                    .and_then(Value::as_str)
                    .unwrap_or("2.0.31")
                    .to_string();
                let (_, model_res) = srv
                    .http_json("GET", "/api/model", None, self.config.request_timeout_ms)
                    .await?;

                let mut models = Vec::new();
                if let Some(arr) = model_res.get("data").and_then(Value::as_array) {
                    for entry in arr {
                        let pid = entry
                            .get("providerID")
                            .and_then(Value::as_str)
                            .unwrap_or("opencode");
                        let mid = entry
                            .get("modelID")
                            .or_else(|| entry.get("id"))
                            .and_then(Value::as_str)
                            .unwrap_or("fixture-model");
                        let full_raw = format!("{pid}/{mid}");
                        let name = entry.get("name").and_then(Value::as_str).unwrap_or(&full_raw);
                        let supports_images = entry
                            .get("capabilities")
                            .and_then(|c| c.get("input"))
                            .and_then(Value::as_array)
                            .is_some_and(|inputs| inputs.iter().any(|v| v.as_str() == Some("image")));
                        let efforts: Vec<String> = entry
                            .get("variants")
                            .and_then(Value::as_array)
                            .map(|v| {
                                v.iter()
                                    .filter_map(|x| x.get("id").and_then(Value::as_str).map(ToString::to_string))
                                    .collect()
                            })
                            .unwrap_or_default();
                        models.push(AgentModel {
                            id: public_provider_entity_id("opencode", "model", &full_raw),
                            name: name.to_string(),
                            provider: "OpenCode".into(),
                            provider_id: "opencode".into(),
                            ready: true,
                            default_reasoning_effort: efforts.first().cloned(),
                            reasoning_efforts: (!efforts.is_empty()).then_some(efforts),
                            runtime_modes: Some(vec![
                                "approval-required".into(),
                                "auto".into(),
                                "full-access".into(),
                            ]),
                            provider_modes: None,
                            supports_images: Some(supports_images),
                        });
                    }
                }

                let status = AgentProviderStatus {
                    id: "opencode".into(),
                    name: "OpenCode".into(),
                    connection: "connected".into(),
                    version: version.clone(),
                    capabilities: opencode_capabilities(),
                    error: None,
                };
                let upd = ClientUpdateRow {
                    id: "opencode".into(),
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
                *guard = Some(srv);

                self.shared.emit(ProviderEvent::StatusChanged {
                    provider_id: "opencode".into(),
                    status,
                    models,
                    client_update: Some(upd),
                });
            }
            Ok(())
        })
    }

    fn disconnect(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            if let Some(srv) = self.server.lock().await.take() {
                srv.shutdown().await;
            }
            let mut status = self.shared.status.lock().unwrap().clone();
            status.connection = "disconnected".into();
            *self.shared.status.lock().unwrap() = status.clone();
            let models = self.shared.models.lock().unwrap().clone();
            let upd = self.shared.client_update.lock().unwrap().clone();
            self.shared.emit(ProviderEvent::StatusChanged {
                provider_id: "opencode".into(),
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
            let srv = self.get_server().await?;

            let existing = self
                .shared
                .records
                .lock()
                .unwrap()
                .get(&req.thread_id)
                .cloned();
            let native_sid = match existing {
                Some(rec) => rec.session_id,
                None => {
                    let raw = req
                        .model_id
                        .as_deref()
                        .and_then(|m| parse_public_provider_entity_id(m).map(|(_, _, r)| r))
                        .unwrap_or("opencode/fixture-model");
                    let (pid, mid) = raw.split_once('/').unwrap_or(("opencode", raw));
                    // OpenCode Zen refuses client-chosen session IDs; omit `id` on session.create.
                    let (_, created) = srv
                        .http_json(
                            "POST",
                            "/api/session",
                            Some(&json!({
                                "title": "Sotto thread",
                                "location": { "directory": req.cwd },
                                "model": { "providerID": pid, "modelID": mid },
                            })),
                            self.config.request_timeout_ms,
                        )
                        .await?;
                    let sid = created
                        .get("data")
                        .and_then(|d| d.get("id"))
                        .and_then(Value::as_str)
                        .ok_or_else(|| "OpenCode session.create returned no id.".to_string())?
                        .to_string();
                    self.shared.records.lock().unwrap().insert(
                        req.thread_id.clone(),
                        OpenCodeThreadRecord {
                            session_id: sid.clone(),
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
            };

            let message_id = Uuid::new_v4().to_string();
            self.shared
                .last_user_msg
                .lock()
                .unwrap()
                .insert(req.thread_id.clone(), message_id.clone());

            let mut files = Vec::new();
            for att in &req.attachments {
                if let Ok(bytes) = fs::read(&att.path) {
                    let uri = format!("data:{};base64,{}", att.handle.mime_type, STANDARD.encode(bytes));
                    files.push(json!({
                        "uri": uri,
                        "name": att.handle.name,
                    }));
                }
            }
            let mut body = json!({
                "text": req.text,
                "delivery": "steer",
            });
            if !files.is_empty() {
                body.as_object_mut().unwrap().insert("files".into(), Value::Array(files));
            }

            let path = format!("/api/session/{native_sid}/prompt");
            let res = srv
                .http_json("POST", &path, Some(&body), self.config.request_timeout_ms)
                .await;
            let latency = started.elapsed().as_millis() as u64;

            match res {
                Ok((status, _)) if (200..300).contains(&status) => Ok(SendMessageAck {
                    message_id,
                    turn_id: Uuid::new_v4().to_string(),
                    status: "accepted".into(),
                    provider_latency_ms: latency,
                }),
                Ok((status, _)) => Err(format!("OpenCode refused prompt (HTTP {status}).")),
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
                .ok_or_else(|| "No pending OpenCode request matches that ID.".to_string())?;
            let srv = self.get_server().await?;

            let sotto_tid = match pending {
                PendingOpenCodeRequest::Permission {
                    sotto_thread_id,
                    native_session_id,
                    permission_id,
                } => {
                    // NEVER send `"always"` (ADR-0004).
                    let decision = if req.approved.unwrap_or(false) { "once" } else { "reject" };
                    let path = format!("/api/session/{native_session_id}/permission/{permission_id}/reply");
                    srv.http_json(
                        "POST",
                        &path,
                        Some(&json!({ "decision": decision })),
                        self.config.request_timeout_ms,
                    )
                    .await?;
                    sotto_thread_id
                }
                PendingOpenCodeRequest::Form {
                    sotto_thread_id,
                    native_session_id,
                    form_id,
                    field_keys,
                } => {
                    let mut answer = Map::new();
                    for k in field_keys {
                        answer.insert(k, Value::String(req.answer.clone()));
                    }
                    let path = format!("/api/session/{native_session_id}/form/{form_id}/reply");
                    srv.http_json(
                        "POST",
                        &path,
                        Some(&json!({ "answer": Value::Object(answer) })),
                        self.config.request_timeout_ms,
                    )
                    .await?;
                    sotto_thread_id
                }
            };

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
                .map(|r| r.session_id.clone())
                .ok_or_else(|| "OpenCode has no active session for this thread.".to_string())?;
            let srv = self.get_server().await?;
            let path = format!("/api/session/{sid}/interrupt");
            srv.http_json("POST", &path, Some(&json!({})), self.config.request_timeout_ms)
                .await?;
            Ok(())
        })
    }

    fn compact(&self, _thread_id: String) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}

async fn http_request_loopback(
    port: u16,
    method: &str,
    path: &str,
    auth_header: &str,
    body: Option<&Value>,
) -> Result<(u16, Value), String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .map_err(|e| format!("Could not connect to OpenCode: {e}"))?;
    let body_bytes = match body {
        Some(v) => serde_json::to_vec(v).map_err(|e| e.to_string())?,
        None => Vec::new(),
    };
    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: {auth_header}\r\nConnection: close\r\nContent-Length: {}\r\n",
        body_bytes.len()
    );
    if !body_bytes.is_empty() {
        req.push_str("Content-Type: application/json\r\n");
    }
    req.push_str("\r\n");
    stream
        .write_all(req.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    if !body_bytes.is_empty() {
        stream
            .write_all(&body_bytes)
            .await
            .map_err(|e| e.to_string())?;
    }
    stream.flush().await.map_err(|e| e.to_string())?;

    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .await
        .map_err(|e| e.to_string())?;
    let sep = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| "Malformed HTTP response from OpenCode.".to_string())?;
    let head = String::from_utf8_lossy(&raw[..sep]);
    let status: u16 = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(500);
    let body_slice = &raw[sep + 4..];
    let parsed = if body_slice.is_empty() {
        Value::Null
    } else if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        let decoded = decode_chunked(body_slice);
        serde_json::from_slice(&decoded).unwrap_or(Value::Null)
    } else {
        serde_json::from_slice(body_slice).unwrap_or(Value::Null)
    };
    Ok((status, parsed))
}

fn decode_chunked(mut input: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(pos) = input.windows(2).position(|w| w == b"\r\n") {
        let size_str = String::from_utf8_lossy(&input[..pos]);
        let Ok(size) = usize::from_str_radix(size_str.trim(), 16) else {
            break;
        };
        input = &input[pos + 2..];
        if size == 0 || input.len() < size {
            break;
        }
        out.extend_from_slice(&input[..size]);
        input = &input[size..];
        if input.starts_with(b"\r\n") {
            input = &input[2..];
        }
    }
    out
}

async fn run_sse_loop(
    port: u16,
    auth_header: &str,
    shared: Arc<OpenCodeSharedState>,
) -> Result<(), String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .map_err(|e| e.to_string())?;
    let req = format!(
        "GET /api/event HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: {auth_header}\r\nAccept: text/event-stream\r\n\r\n"
    );
    stream
        .write_all(req.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stream.flush().await.map_err(|e| e.to_string())?;

    let mut reader = BufReader::new(stream);
    // Skip HTTP response headers.
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).await.map_err(|e| e.to_string())?;
        if n == 0 || line == "\r\n" || line == "\n" {
            break;
        }
    }

    let mut data_buf = String::new();
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            if !data_buf.is_empty() {
                if let Ok(val) = serde_json::from_str::<Value>(&data_buf) {
                    shared.handle_sse_event(&val);
                }
                data_buf.clear();
            }
            continue;
        }
        if let Some(payload) = trimmed.strip_prefix("data:") {
            if !data_buf.is_empty() {
                data_buf.push('\n');
            }
            data_buf.push_str(payload.trim_start());
        }
    }
    Ok(())
}

fn opencode_capabilities() -> AgentCapabilities {
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
        skills: Some(false),
        steer: Some(true),
        submit: true,
        threads: true,
    }
}

fn opencode_id(kind: &str, key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("opencode:{kind}:{key}").as_bytes());
    format!("opencode-{kind}-{}", crate::providers::hex_encode(&hasher.finalize()))
}

fn load_opencode_records(data_directory: &Path) -> HashMap<String, OpenCodeThreadRecord> {
    let path = data_directory.join(OPENCODE_THREADS_FILE);
    let Ok(raw) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}
