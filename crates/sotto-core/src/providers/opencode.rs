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
    now_iso, parse_public_provider_entity_id, public_provider_entity_id,
    AgentCapabilities, AgentModel, AgentProviderStatus, ClientUpdateRow,
};

pub const OPENCODE_THREADS_FILE: &str = "opencode-threads.json";

#[derive(Debug, Clone)]
pub struct OpenCodeAdapterConfig {
    pub data_directory: PathBuf,
    pub executable: String,
    pub args: Vec<String>,
    pub request_timeout_ms: u64,
    pub use_cli_lookup: bool,
    /// How long a side call has (Node's `SIDE_WRITING_TIMEOUT_MS`); a test shortens it.
    pub side_writing_deadline: Duration,
}

impl OpenCodeAdapterConfig {
    pub fn native(data_directory: PathBuf) -> Self {
        Self {
            data_directory,
            executable: "opencode".into(),
            args: vec![
                "serve".into(),
                "--hostname=127.0.0.1".into(),
                "--port=0".into(),
            ],
            request_timeout_ms: 30_000,
            use_cli_lookup: true,
            side_writing_deadline: crate::side_writing::SIDE_WRITING_DEADLINE,
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
            use_cli_lookup: false,
            side_writing_deadline: crate::side_writing::SIDE_WRITING_DEADLINE,
        }
    }
}

/// What Node's `opencode-threads.json` requires of a record beyond the thread's own facts (ADR-0214): a `createToken`,
/// which Node uses only to find a session whose creation answer was lost, and the thread's permission mode where Node
/// allows it.
fn opencode_node_record_defaults(runtime_mode: Option<&str>) -> Vec<(&'static str, Value)> {
    let mut defaults = vec![("createToken", Value::String(Uuid::new_v4().to_string()))];
    if let Some(mode) = runtime_mode.filter(|mode| ["approval-required", "auto-accept-edits", "full-access"].contains(mode)) {
        defaults.push(("runtimeMode", Value::String(mode.to_string())));
    }
    defaults
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenCodeThreadRecord {
    session_id: String,
    #[serde(default)]
    cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<String>,
    /// Every field Node's record has that this one does not model, kept as they were so a rollback to Node finds its
    /// record whole (ADR-0214).
    #[serde(default, flatten)]
    extra: Map<String, Value>,
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

        let resolved = if config.use_cli_lookup {
            let opts = crate::cli_lookup::CliLookupOptions::from_process_env();
            Some(
                crate::cli_lookup::resolve_provider_cli("opencode", &config.data_directory, &opts)
                    .ok_or_else(|| {
                        "Install OpenCode and sign in before connecting this provider.".to_string()
                    })?,
            )
        } else {
            None
        };
        let mut cmd = match &resolved {
            Some(res) => {
                let mut c = Command::new(&res.executable);
                c.args(&res.prefix_args);
                res.apply_tokio(&mut c);
                c
            }
            None => Command::new(&config.executable),
        };
        if config.use_cli_lookup {
            let oc_base = config.data_directory.join("opencode");
            let oc_data = oc_base.join("data");
            let oc_config = oc_base.join("config");
            let oc_state = oc_base.join("state");
            let oc_cache = oc_base.join("cache");
            for d in [&oc_data, &oc_config, &oc_state, &oc_cache] {
                let _ = fs::create_dir_all(d);
            }
            cmd.env("XDG_DATA_HOME", &oc_data)
                .env("XDG_CONFIG_HOME", &oc_config)
                .env("XDG_STATE_HOME", &oc_state)
                .env("XDG_CACHE_HOME", &oc_cache)
                .env("OPENCODE_CONFIG_CONTENT", r#"{"share":"disabled","update":"disable"}"#)
                .env("OPENCODE_DISABLE_AUTOUPDATE", "1");
        } else {
            let xdg_data = config.data_directory.join("xdg-data");
            let _ = fs::create_dir_all(&xdg_data);
            cmd.env("XDG_DATA_HOME", &xdg_data);
        }
        cmd.args(&config.args)
            .env("OPENCODE_PASSWORD", &password)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd.spawn().map_err(|_| {
            "Could not start OpenCode. Check its installation and try again.".to_string()
        })?;
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
        let started = Instant::now();
        let total = Duration::from_millis(timeout_ms);
        let wait_limit = total.min(Duration::from_secs(30));
        let mut attempt: u64 = 0;
        loop {
            let remaining = total.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                return Err(format!("timeout:{method}:{path}"));
            }
            let req_fut = http_request_loopback(self.port, method, path, &self.auth_header, body);
            let (status, parsed) = match tokio::time::timeout(remaining, req_fut).await {
                Ok(Ok(res)) => res,
                Ok(Err(e)) => return Err(e),
                Err(_) => return Err(format!("timeout:{method}:{path}")),
            };
            if is_wait_503(status, &parsed) && started.elapsed() < wait_limit {
                let delay = Duration::from_millis((250 * (attempt + 1)).min(1_000));
                let sleep_for = delay.min(wait_limit.saturating_sub(started.elapsed()));
                if !sleep_for.is_zero() {
                    tokio::time::sleep(sleep_for).await;
                    attempt += 1;
                    continue;
                }
            }
            return Ok((status, parsed));
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
        // Held while the file is written, so a record `forget_thread` let go is never written back from an earlier copy.
        let snapshot = self.records.lock().unwrap();
        let path = self.data_directory.join(OPENCODE_THREADS_FILE);
        crate::providers::save_thread_records(&path, &*snapshot, crate::providers::parse_serde_record::<OpenCodeThreadRecord>, crate::providers::encode_serde_record);
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
    /// Lets go of a deleted thread's alias record (ADR-0140 decision 4), as Node's adapter `forgetThread` removes it:
    /// its entry in this provider's `*-threads.json` goes, under the records lock so no save from an earlier copy
    /// writes it back, and so does the adapter's own map to it.
    fn forget_thread(&self, thread_id: &str) {
        let mut records = self.shared.records.lock().unwrap();
        records.remove(thread_id);
        crate::providers::forget_thread_record(&self.shared.data_directory.join(OPENCODE_THREADS_FILE), thread_id);
        drop(records);
        self.shared.native_to_sotto.lock().unwrap().retain(|_, sotto| sotto != thread_id);
    }

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
                let record_err = |err: String| {
                    let status = AgentProviderStatus {
                        id: "opencode".into(),
                        name: "OpenCode".into(),
                        connection: "error".into(),
                        version: String::new(),
                        capabilities: opencode_capabilities(),
                        error: Some(err.clone()),
                    };
                    *self.shared.status.lock().unwrap() = status.clone();
                    let models = self.shared.models.lock().unwrap().clone();
                    let upd = self.shared.client_update.lock().unwrap().clone();
                    self.shared.emit(ProviderEvent::StatusChanged {
                        provider_id: "opencode".into(),
                        status,
                        models,
                        client_update: upd,
                    });
                    err
                };
                let srv = OpenCodeServerHandle::start(&self.config, Arc::clone(&self.shared))
                    .await
                    .map_err(record_err)?;
                let (_, info) = match srv
                    .http_json("GET", "/api/info", None, self.config.request_timeout_ms)
                    .await
                {
                    Ok(v) => v,
                    Err(e) => {
                        srv.shutdown().await;
                        return Err(record_err(e));
                    }
                };
                let version = info
                    .get("version")
                    .and_then(Value::as_str)
                    .unwrap_or("2.0.31")
                    .to_string();
                let (_, model_res) = match srv
                    .http_json("GET", "/api/model", None, self.config.request_timeout_ms)
                    .await
                {
                    Ok(v) => v,
                    Err(e) => {
                        srv.shutdown().await;
                        return Err(record_err(e));
                    }
                };

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
                                let raw: Vec<String> = v
                                    .iter()
                                    .filter_map(|x| x.get("id").and_then(Value::as_str).map(ToString::to_string))
                                    .collect();
                                super::order_reasoning_efforts(&raw)
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

            let raw_model = req
                .model_id
                .as_deref()
                .and_then(|m| parse_public_provider_entity_id(m).map(|(_, _, r)| r.to_string()))
                .or(req.model_id.clone())
                .unwrap_or_else(|| "opencode/fixture-model".to_string());

            let models = self.models();
            let existing = self
                .shared
                .records
                .lock()
                .unwrap()
                .get(&req.thread_id)
                .cloned();
            let native_sid = match existing {
                Some(rec) => {
                    if rec.model_id.as_deref() != Some(raw_model.as_str())
                        || rec.reasoning_effort != req.reasoning_effort
                    {
                        let model_obj = opencode_model_ref(&models, &raw_model, req.reasoning_effort.as_deref())?;
                        let path = format!("/api/session/{}/model", rec.session_id);
                        let (status, _) = srv
                            .http_json("POST", &path, Some(&json!({ "model": model_obj })), self.config.request_timeout_ms)
                            .await?;
                        if !(200..300).contains(&status) {
                            return Err(format!("OpenCode refused model change (HTTP {status})."));
                        }
                        if let Some(entry) = self.shared.records.lock().unwrap().get_mut(&req.thread_id) {
                            entry.model_id = Some(raw_model.clone());
                            entry.reasoning_effort = req.reasoning_effort.clone();
                        }
                        self.shared.save_records();
                    }
                    rec.session_id
                }
                None => {
                    // Build Node-compatible record fields first so `createToken` marks the provider session (`CREATE_MARK`)
                    // as Sotto-created, preventing `opencode_unmarked_sessions` from mistaking concurrent threads for
                    // unexpected side-call sessions.
                    let fields = crate::providers::node_record_fields(
                        &self.shared.data_directory.join(OPENCODE_THREADS_FILE),
                        &req.thread_id,
                        &req.record_seed,
                        &opencode_node_record_defaults(req.runtime_mode.as_deref()),
                    );
                    let create_token = fields
                        .get("createToken")
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                        .unwrap_or_else(|| Uuid::new_v4().to_string());
                    let model_obj = opencode_model_ref(&models, &raw_model, req.reasoning_effort.as_deref())?;
                    // OpenCode Zen refuses client-chosen session IDs; omit `id` on session.create.
                    let (_, created) = srv
                        .http_json(
                            "POST",
                            "/api/session",
                            Some(&json!({
                                "title": "Sotto thread",
                                "location": { "directory": req.cwd },
                                "model": model_obj,
                                "metadata": { "sotto": { "thread": create_token } },
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
                    let mut record = crate::providers::with_node_fields(
                        OpenCodeThreadRecord {
                            session_id: sid.clone(),
                            cwd: req.cwd.clone(),
                            model_id: Some(raw_model.clone()),
                            reasoning_effort: req.reasoning_effort.clone(),
                            extra: Map::new(),
                        },
                        fields,
                    );
                    record.extra.insert("sessionConfirmed".into(), Value::Bool(true));
                    self.shared.records.lock().unwrap().insert(req.thread_id.clone(), record);
                    self.shared
                        .native_to_sotto
                        .lock()
                        .unwrap()
                        .insert(sid.clone(), req.thread_id.clone());
                    self.shared.save_records();
                    sid
                }
            };

            let message_id = req.message_id.clone();
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

    /// Node's OpenCode `writeShortText` (`src/main/agents/opencode.ts`): calls `POST /api/experimental/generate` with
    /// the thread's model at its least effort (no tools, no turn). Reads unmarked sessions before and after so a call
    /// that unexpectedly created a provider session writes nothing; an HTTP refusal (such as OpenCode Zen's 503) writes
    /// nothing and leaves the stand-in subject in place.
    fn write_short_text(&self, thread_id: String, prompt: crate::side_writing::ShortTextPrompt) -> BoxFuture<'_, Result<Option<String>, String>> {
        Box::pin(async move {
            if self.shared.status.lock().unwrap().connection != "connected" {
                return Ok(None);
            }
            let Some(record) = self.shared.records.lock().unwrap().get(&thread_id).cloned() else {
                return Ok(None);
            };
            // Matches Node's `!alias?.sessionConfirmed`.
            if record.extra.get("sessionConfirmed") != Some(&Value::Bool(true)) {
                return Ok(None);
            }
            let Some(model) = record.model_id.filter(|m| !m.trim().is_empty()) else {
                return Ok(None);
            };
            let models = self.models();
            let least_effort = crate::side_writing::side_writing_effort(&models, &public_provider_entity_id("opencode", "model", &model));
            let model_ref = opencode_model_ref(&models, &model, least_effort.as_deref())?;
            let Some(srv) = self.server.lock().await.clone() else {
                return Ok(None);
            };

            let before = opencode_unmarked_sessions(&srv, self.config.request_timeout_ms).await?;
            let timeout_ms = u64::try_from(self.config.side_writing_deadline.as_millis()).unwrap_or(u64::MAX);
            let (status, answer) = srv
                .http_json(
                    "POST",
                    "/api/experimental/generate",
                    Some(&json!({
                        "prompt": format!("{}\n\n{}", prompt.instruction, prompt.material),
                        "model": model_ref,
                    })),
                    timeout_ms,
                )
                .await?;
            if !(200..300).contains(&status) {
                return Ok(None);
            }
            let Some(text) = answer.pointer("/data/text").and_then(Value::as_str) else {
                return Err("OpenCode sent side text Sotto cannot read.".into());
            };
            let after = opencode_unmarked_sessions(&srv, self.config.request_timeout_ms).await?;
            if after.iter().any(|sid| !before.contains(sid)) {
                return Ok(None);
            }
            Ok(Some(text.to_string()))
        })
    }

    fn configure_thread(
        &self,
        thread_id: String,
        model_id: Option<String>,
        _runtime_mode: Option<String>,
        reasoning_effort: Option<String>,
    ) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let rec = self
                .shared
                .records
                .lock()
                .unwrap()
                .get(&thread_id)
                .cloned();
            let Some(rec) = rec else {
                return Ok(());
            };
            let raw_model = model_id
                .as_deref()
                .map(|m| {
                    parse_public_provider_entity_id(m)
                        .map(|(_, _, r)| r.to_string())
                        .unwrap_or_else(|| m.to_string())
                })
                .or(rec.model_id.clone());
            let Some(raw) = raw_model else {
                return Ok(());
            };
            let eff = reasoning_effort.or(rec.reasoning_effort.clone());
            if rec.model_id.as_deref() == Some(raw.as_str()) && rec.reasoning_effort == eff {
                return Ok(());
            }
            let srv = self.get_server().await?;
            let models = self.models();
            let model_obj = opencode_model_ref(&models, &raw, eff.as_deref())?;
            let path = format!("/api/session/{}/model", rec.session_id);
            let (status, _) = srv
                .http_json("POST", &path, Some(&json!({ "model": model_obj })), self.config.request_timeout_ms)
                .await?;
            if !(200..300).contains(&status) {
                return Err(format!("OpenCode refused model change (HTTP {status})."));
            }
            if let Some(entry) = self.shared.records.lock().unwrap().get_mut(&thread_id) {
                entry.model_id = Some(raw);
                entry.reasoning_effort = eff;
            }
            self.shared.save_records();
            Ok(())
        })
    }
}

/// Node's `modelRef` (`src/main/agents/opencode.ts`): splits `providerID/id` and attaches `variant` only when the
/// model offers that effort (excluding `"default"`), mapping `"off"` to `"none"`.
fn opencode_model_ref(models: &[AgentModel], model_id: &str, effort: Option<&str>) -> Result<Value, String> {
    let Some((pid, mid)) = model_id.split_once('/').filter(|(p, m)| !p.is_empty() && !m.is_empty()) else {
        return Err("That model is not an OpenCode model.".into());
    };
    let mut model_obj = json!({ "providerID": pid, "id": mid });
    if let Some(effort) = effort.filter(|e| !e.is_empty() && *e != "default") {
        let public_id = public_provider_entity_id("opencode", "model", model_id);
        let offered = models
            .iter()
            .find(|m| m.id == public_id || m.id == model_id)
            .and_then(|m| m.reasoning_efforts.as_ref());
        let allowed = match offered {
            Some(list) => list.iter().any(|level| level != "default" && level == effort),
            None => false,
        };
        if allowed {
            model_obj["variant"] = json!(if effort == "off" { "none" } else { effort });
        }
    }
    Ok(model_obj)
}

/// Node's `isWait503` (`src/main/agents/opencodeClient.ts`): a 503 with no `service`, `service: null`, or
/// `service: "plugin"` means OpenCode's location plugins are still activating; a 503 naming a model source
/// (such as `"opencode"` for OpenCode Zen) is an immediate refusal.
fn is_wait_503(status: u16, body: &Value) -> bool {
    if status != 503 {
        return false;
    }
    match body.get("service") {
        None | Some(Value::Null) => true,
        Some(Value::String(service)) => service == "plugin",
        Some(_) => false,
    }
}

/// Reads every provider session in OpenCode that carries no `metadata.sotto.thread` creation mark (matching Node's
/// `unmarkedSessions` in `src/main/agents/opencode.ts`).
async fn opencode_unmarked_sessions(srv: &OpenCodeServerHandle, timeout_ms: u64) -> Result<std::collections::HashSet<String>, String> {
    let mut found = std::collections::HashSet::new();
    let mut cursor: Option<String> = None;
    for _ in 0..50 {
        let path = match &cursor {
            Some(c) => format!("/api/session?cursor={}", encode_query_component(c)),
            None => "/api/session".to_string(),
        };
        let (status, body) = srv.http_json("GET", &path, None, timeout_ms).await?;
        if !(200..300).contains(&status) {
            return Err("OpenCode refused to list sessions.".into());
        }
        let Some(data) = body.get("data").and_then(Value::as_array) else {
            return Err("OpenCode returned an unreadable session list.".into());
        };
        for session in data {
            let marked = session
                .pointer("/metadata/sotto/thread")
                .and_then(Value::as_str)
                .is_some();
            if !marked {
                if let Some(id) = session.get("id").and_then(Value::as_str) {
                    found.insert(id.to_string());
                }
            }
        }
        let next = body
            .pointer("/cursor/next")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string);
        if data.is_empty() || next.is_none() || next == cursor {
            break;
        }
        cursor = next;
    }
    Ok(found)
}

fn encode_query_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            use std::fmt::Write;
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
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
    } else if is_chunked_encoding(&head) {
        let decoded = decode_chunked(body_slice);
        serde_json::from_slice(&decoded).unwrap_or(Value::Null)
    } else {
        serde_json::from_slice(body_slice).unwrap_or(Value::Null)
    };
    Ok((status, parsed))
}

fn is_chunked_encoding(head: &str) -> bool {
    head.lines().skip(1).any(|line| {
        let Some((name, value)) = line.split_once(':') else {
            return false;
        };
        name.trim().eq_ignore_ascii_case("transfer-encoding")
            && value.split(',').any(|token| token.trim().eq_ignore_ascii_case("chunked"))
    })
}

fn decode_chunked(mut input: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(pos) = input.windows(2).position(|w| w == b"\r\n") {
        let size_line = String::from_utf8_lossy(&input[..pos]);
        let size_hex = size_line.split(';').next().unwrap_or("").trim();
        let Ok(size) = usize::from_str_radix(size_hex, 16) else {
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
    crate::providers::load_thread_records(&data_directory.join(OPENCODE_THREADS_FILE), crate::providers::parse_serde_record)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wait_503_retries_plugin_activation_but_not_model_source_refusals() {
        assert!(is_wait_503(503, &json!({})));
        assert!(is_wait_503(503, &json!({ "service": null })));
        assert!(is_wait_503(503, &json!({ "service": "plugin" })));
        assert!(!is_wait_503(503, &json!({ "service": "opencode" })));
        assert!(!is_wait_503(400, &json!({ "service": "plugin" })));
    }

    #[test]
    fn chunked_header_decoding_and_query_encoding_handle_edge_cases() {
        assert!(is_chunked_encoding("HTTP/1.1 200 OK\r\nTransfer-Encoding:  gzip, Chunked\r\n"));
        assert!(!is_chunked_encoding("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"));
        assert_eq!(decode_chunked(b"5;ext=1\r\nhello\r\n0\r\n\r\n"), b"hello");
        assert_eq!(encode_query_component("a/b+c=1~_-."), "a%2Fb%2Bc%3D1~_-.");
    }
}
