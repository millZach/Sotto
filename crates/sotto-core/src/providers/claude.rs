use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
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
    AgentCapabilities, AgentModel, AgentProviderStatus,
};

pub const CLAUDE_THREADS_FILE: &str = "claude-threads.json";

#[derive(Debug, Clone)]
pub struct ClaudeAdapterConfig {
    pub data_directory: PathBuf,
    pub executable: String,
    pub prefix_args: Vec<String>,
    pub claude_home: Option<PathBuf>,
    pub request_timeout_ms: u64,
}

impl ClaudeAdapterConfig {
    pub fn native(data_directory: PathBuf) -> Self {
        Self {
            data_directory,
            executable: "claude".into(),
            prefix_args: Vec::new(),
            claude_home: None,
            request_timeout_ms: 30_000,
        }
    }

    pub fn fake(data_directory: PathBuf, fake_script: PathBuf) -> Self {
        let claude_home = data_directory.join("home");
        Self {
            data_directory: data_directory.clone(),
            executable: std::env::var("SOTTO_NODE_BIN").unwrap_or_else(|_| "node".into()),
            prefix_args: vec![
                fake_script.to_string_lossy().into_owned(),
                data_directory.to_string_lossy().into_owned(),
            ],
            claude_home: Some(claude_home),
            request_timeout_ms: 2_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeThreadRecord {
    session_id: String,
    #[serde(default)]
    cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime_mode: Option<String>,
    #[serde(default)]
    started: bool,
}

#[derive(Debug, Clone)]
struct InboundClaudeRequest {
    request_id: String,
    sotto_thread_id: String,
    subtype: String,
    tool_name: String,
    native_input: Value,
    stdin_tx: mpsc::UnboundedSender<String>,
}

type PendingControlMap = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;

struct ClaudeSessionProcess {
    session_id: String,
    stdin_tx: mpsc::UnboundedSender<String>,
    pending_control: PendingControlMap,
    pending_echo: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
    child: Mutex<Option<Child>>,
}

impl ClaudeSessionProcess {
    #[allow(clippy::too_many_arguments)]
    fn spawn(
        config: &ClaudeAdapterConfig,
        shared: Arc<ClaudeSharedState>,
        sotto_thread_id: Option<String>,
        session_id: String,
        cwd: &str,
        model: &str,
        effort: Option<&str>,
        runtime_mode: Option<&str>,
        resume: bool,
        metadata_only: bool,
    ) -> Result<Arc<Self>, String> {
        let mut args = config.prefix_args.clone();
        args.push("--input-format".into());
        args.push("stream-json".into());
        args.push("--output-format".into());
        args.push("stream-json".into());
        args.push("--verbose".into());

        if metadata_only {
            args.push("--no-session-persistence".into());
            args.push("--model".into());
            args.push(model.into());
        } else {
            let perm_mode = map_claude_permission_mode(runtime_mode);
            args.push("--permission-prompts".into());
            args.push("host".into());
            args.push("--permission-prompt-tool".into());
            args.push("stdio".into());
            args.push("--permission-mode".into());
            args.push(perm_mode.into());
            if perm_mode == "bypassPermissions" {
                args.push("--allow-dangerously-skip-permissions".into());
            }
            if resume {
                args.push("--resume".into());
                args.push(session_id.clone());
            } else {
                args.push("--session-id".into());
                args.push(session_id.clone());
            }
            args.push("--model".into());
            args.push(model.into());
            if let Some(eff) = effort {
                if !eff.is_empty() && eff != "ultracode" {
                    args.push("--effort".into());
                    args.push(eff.into());
                }
            }
        }

        let mut cmd = Command::new(&config.executable);
        cmd.args(&args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        if let Some(ref home) = config.claude_home {
            let _ = fs::create_dir_all(home);
            cmd.env("SOTTO_FAKE_CLAUDE_HOME", home);
        }
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Could not start Claude Code ({}): {e}", config.executable))?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Claude Code stdin unavailable.".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Claude Code stdout unavailable.".to_string())?;

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

        let pending_control: PendingControlMap = Arc::new(Mutex::new(HashMap::new()));
        let pending_echo: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        let reader_control = Arc::clone(&pending_control);
        let reader_echo = Arc::clone(&pending_echo);
        let reader_stdin = stdin_tx.clone();
        let reader_shared = Arc::clone(&shared);
        let reader_thread = sotto_thread_id;

        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(frame) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };
                let ftype = frame.get("type").and_then(Value::as_str).unwrap_or("");
                match ftype {
                    "control_response" => {
                        if let Some(resp) = frame.get("response") {
                            let req_id = resp
                                .get("request_id")
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            if let Some(tx) = reader_control.lock().unwrap().remove(req_id) {
                                let subtype = resp.get("subtype").and_then(Value::as_str).unwrap_or("");
                                if subtype == "success" {
                                    let body = resp.get("response").cloned().unwrap_or(Value::Null);
                                    let _ = tx.send(Ok(body));
                                } else {
                                    let err = resp
                                        .get("error")
                                        .and_then(Value::as_str)
                                        .unwrap_or("Claude Code refused the control request.")
                                        .to_string();
                                    let _ = tx.send(Err(err));
                                }
                            }
                        }
                    }
                    "control_request" => {
                        if let Some(ref tid) = reader_thread {
                            reader_shared.handle_control_request(tid, &frame, reader_stdin.clone());
                        }
                    }
                    "user" => {
                        if let Some(uuid) = frame.get("uuid").and_then(Value::as_str) {
                            if let Some(tx) = reader_echo.lock().unwrap().remove(uuid) {
                                let _ = tx.send(());
                            }
                        }
                    }
                    "command_lifecycle" => {
                        if let Some(cmd_uuid) = frame.get("command_uuid").and_then(Value::as_str) {
                            let state = frame.get("state").and_then(Value::as_str).unwrap_or("");
                            if state == "started" || state == "queued" {
                                if let Some(tx) = reader_echo.lock().unwrap().remove(cmd_uuid) {
                                    let _ = tx.send(());
                                }
                            }
                        }
                    }
                    "stream_event" | "assistant" | "result" | "system" => {
                        if let Some(ref tid) = reader_thread {
                            reader_shared.handle_stream_frame(tid, ftype, &frame);
                        }
                    }
                    _ => {}
                }
            }

            let drained: Vec<_> = reader_control.lock().unwrap().drain().collect();
            for (_, tx) in drained {
                let _ = tx.send(Err("Claude Code exited before answering.".into()));
            }
            reader_echo.lock().unwrap().clear();
        });

        Ok(Arc::new(Self {
            session_id,
            stdin_tx,
            pending_control,
            pending_echo,
            child: Mutex::new(Some(child)),
        }))
    }

    async fn control_request(&self, request: Value, timeout_ms: u64) -> Result<Value, String> {
        let req_id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending_control
            .lock()
            .unwrap()
            .insert(req_id.clone(), tx);

        let frame = json!({
            "type": "control_request",
            "request_id": req_id,
            "request": request,
        });
        let encoded = serde_json::to_string(&frame).map_err(|e| e.to_string())?;
        if self.stdin_tx.send(encoded).is_err() {
            self.pending_control.lock().unwrap().remove(&req_id);
            return Err("Claude Code process is not running.".into());
        }

        match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Err("Claude Code closed before answering.".into()),
            Err(_) => {
                self.pending_control.lock().unwrap().remove(&req_id);
                Err("timeout:control_request".into())
            }
        }
    }

    async fn initialize(&self, timeout_ms: u64) -> Result<Value, String> {
        self.control_request(
            json!({
                "subtype": "initialize",
                "hooks": {},
            }),
            timeout_ms,
        )
        .await
    }

    async fn send_user_frame(
        &self,
        uuid: &str,
        content: Value,
        timeout_ms: u64,
    ) -> Result<bool, String> {
        let (tx, rx) = oneshot::channel();
        self.pending_echo
            .lock()
            .unwrap()
            .insert(uuid.to_string(), tx);

        let frame = json!({
            "type": "user",
            "uuid": uuid,
            "session_id": self.session_id,
            "parent_tool_use_id": Value::Null,
            "message": {
                "role": "user",
                "content": content,
            }
        });
        let encoded = serde_json::to_string(&frame).map_err(|e| e.to_string())?;
        if self.stdin_tx.send(encoded).is_err() {
            self.pending_echo.lock().unwrap().remove(uuid);
            return Err("Claude Code process is not running.".into());
        }

        match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(())) => Ok(true),
            Ok(Err(_)) => Err("Claude Code exited before acknowledging prompt.".into()),
            Err(_) => {
                self.pending_echo.lock().unwrap().remove(uuid);
                Ok(false)
            }
        }
    }

    async fn shutdown(&self) {
        let child = self.child.lock().unwrap().take();
        if let Some(mut c) = child {
            let _ = c.kill().await;
        }
    }
}

struct ActiveAssistantStream {
    api_id: String,
    sotto_msg_id: String,
    text: String,
    added: bool,
}

struct ClaudeSharedState {
    data_directory: PathBuf,
    events_tx: Mutex<Option<mpsc::UnboundedSender<ProviderEvent>>>,
    status: Mutex<AgentProviderStatus>,
    models: Mutex<Vec<AgentModel>>,
    records: Mutex<HashMap<String, ClaudeThreadRecord>>,
    /// Sotto thread ID -> active turn prompt message ID (Claude keys turn activities by prompt message ID).
    active_turns: Mutex<HashMap<String, String>>,
    /// Sotto thread ID -> active turn activity JSON.
    turn_activities: Mutex<HashMap<String, Value>>,
    /// Sotto thread ID -> currently streaming assistant message state.
    streaming_assistant: Mutex<HashMap<String, ActiveAssistantStream>>,
    /// Request ID -> pending inbound `can_use_tool` / dialog request.
    pending_requests: Mutex<HashMap<String, InboundClaudeRequest>>,
}

impl ClaudeSharedState {
    fn new(data_directory: PathBuf) -> Self {
        let records = load_claude_records(&data_directory);
        Self {
            data_directory,
            events_tx: Mutex::new(None),
            status: Mutex::new(AgentProviderStatus {
                id: "claude".into(),
                name: "Claude Code".into(),
                connection: "disconnected".into(),
                version: String::new(),
                capabilities: claude_capabilities(),
                error: None,
            }),
            models: Mutex::new(Vec::new()),
            records: Mutex::new(records),
            active_turns: Mutex::new(HashMap::new()),
            turn_activities: Mutex::new(HashMap::new()),
            streaming_assistant: Mutex::new(HashMap::new()),
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
        let path = self.data_directory.join(CLAUDE_THREADS_FILE);
        let _ = write_atomic_json(&path, &snapshot);
    }

    fn handle_control_request(
        &self,
        sotto_tid: &str,
        frame: &Value,
        stdin_tx: mpsc::UnboundedSender<String>,
    ) {
        let req_id = frame
            .get("request_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let Some(request) = frame.get("request") else {
            return;
        };
        let subtype = request
            .get("subtype")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        if subtype == "hook_callback" {
            // Answer hook callbacks cleanly with an empty success object.
            let resp = json!({
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": req_id,
                    "response": {}
                }
            });
            if let Ok(encoded) = serde_json::to_string(&resp) {
                let _ = stdin_tx.send(encoded);
            }
            return;
        }

        if subtype != "can_use_tool" && subtype != "request_user_dialog" {
            return;
        }

        let tool_name = request
            .get("tool_name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let native_input = request.get("input").cloned().unwrap_or_else(|| json!({}));

        let card = build_claude_request_card(&req_id, &subtype, request);
        self.pending_requests.lock().unwrap().insert(
            req_id,
            InboundClaudeRequest {
                request_id: card["id"].as_str().unwrap_or("").to_string(),
                sotto_thread_id: sotto_tid.to_string(),
                subtype,
                tool_name,
                native_input,
                stdin_tx,
            },
        );
        self.emit(ProviderEvent::RequestOpened {
            thread_id: sotto_tid.to_string(),
            request: card,
        });
    }

    fn handle_stream_frame(&self, sotto_tid: &str, ftype: &str, frame: &Value) {
        let turn_msg_id = self.active_turns.lock().unwrap().get(sotto_tid).cloned();

        match ftype {
            "stream_event" => {
                let Some(event) = frame.get("event") else {
                    return;
                };
                let etype = event.get("type").and_then(Value::as_str).unwrap_or("");
                match etype {
                    "message_start" => {
                        let api_id = event
                            .get("message")
                            .and_then(|m| m.get("id"))
                            .and_then(Value::as_str)
                            .map(ToString::to_string)
                            .unwrap_or_else(|| Uuid::new_v4().to_string());
                        self.streaming_assistant.lock().unwrap().insert(
                            sotto_tid.to_string(),
                            ActiveAssistantStream {
                                api_id,
                                sotto_msg_id: Uuid::new_v4().to_string(),
                                text: String::new(),
                                added: false,
                            },
                        );
                    }
                    "content_block_delta" => {
                        let Some(delta) = event.get("delta") else {
                            return;
                        };
                        let dtype = delta.get("type").and_then(Value::as_str).unwrap_or("");
                        if dtype == "text_delta" {
                            let text_piece = delta.get("text").and_then(Value::as_str).unwrap_or("");
                            if text_piece.is_empty() {
                                return;
                            }
                            let mut map = self.streaming_assistant.lock().unwrap();
                            let stream = map.entry(sotto_tid.to_string()).or_insert_with(|| {
                                ActiveAssistantStream {
                                    api_id: Uuid::new_v4().to_string(),
                                    sotto_msg_id: Uuid::new_v4().to_string(),
                                    text: String::new(),
                                    added: false,
                                }
                            });
                            stream.text.push_str(text_piece);
                            let msg_id = stream.sotto_msg_id.clone();
                            if !stream.added {
                                stream.added = true;
                                let full = stream.text.clone();
                                drop(map);
                                self.emit(ProviderEvent::MessageAdded {
                                    thread_id: sotto_tid.to_string(),
                                    message: StoredMessage {
                                        id: msg_id,
                                        role: "assistant".into(),
                                        text: full,
                                        created_at: now_iso(),
                                        command_id: None,
                                        turn_message_id: turn_msg_id,
                                        attachments: None,
                                        watcher_own_change: None,
                                        watcher_observed_changes: None,
                                        provider_error: None,
                                    },
                                });
                            } else {
                                drop(map);
                                self.emit(ProviderEvent::MessageTextAppended {
                                    thread_id: sotto_tid.to_string(),
                                    message_id: msg_id,
                                    append_text: text_piece.to_string(),
                                });
                            }
                        }
                    }
                    _ => {}
                }
            }
            "assistant" => {
                let Some(message) = frame.get("message") else {
                    return;
                };
                let api_id = message
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let mut text_parts = Vec::new();
                if let Some(arr) = message.get("content").and_then(Value::as_array) {
                    for block in arr {
                        if block.get("type").and_then(Value::as_str) == Some("text") {
                            if let Some(t) = block.get("text").and_then(Value::as_str) {
                                text_parts.push(t);
                            }
                        }
                    }
                }
                if text_parts.is_empty() {
                    return;
                }
                let final_text = text_parts.join("");
                let created_at = frame
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .unwrap_or_else(now_iso);

                let existing = {
                    let mut map = self.streaming_assistant.lock().unwrap();
                    if map
                        .get(sotto_tid)
                        .is_some_and(|s| api_id.is_empty() || s.api_id == api_id)
                    {
                        map.remove(sotto_tid)
                    } else {
                        None
                    }
                };
                let (msg_id, was_added) = match existing {
                    Some(s) => (s.sotto_msg_id, s.added),
                    None => (Uuid::new_v4().to_string(), false),
                };
                let msg = StoredMessage {
                    id: msg_id,
                    role: "assistant".into(),
                    text: final_text,
                    created_at,
                    command_id: None,
                    turn_message_id: turn_msg_id,
                    attachments: None,
                    watcher_own_change: None,
                    watcher_observed_changes: None,
                    provider_error: None,
                };
                if was_added {
                    self.emit(ProviderEvent::MessageReplaced {
                        thread_id: sotto_tid.to_string(),
                        message: msg,
                    });
                } else {
                    self.emit(ProviderEvent::MessageAdded {
                        thread_id: sotto_tid.to_string(),
                        message: msg,
                    });
                }
            }
            "result" => {
                let is_error = frame.get("is_error").and_then(Value::as_bool) == Some(true);
                let terminal = frame
                    .get("terminal_reason")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let status = if terminal.starts_with("aborted")
                    || frame.get("result").and_then(Value::as_str) == Some("")
                        && self.streaming_assistant.lock().unwrap().contains_key(sotto_tid)
                {
                    "interrupted"
                } else if is_error {
                    "failed"
                } else {
                    "completed"
                };
                let title = match status {
                    "interrupted" => "Turn interrupted",
                    "failed" => "Turn failed",
                    _ => "Turn completed",
                };
                self.streaming_assistant.lock().unwrap().remove(sotto_tid);
                let turn_id = self
                    .active_turns
                    .lock()
                    .unwrap()
                    .remove(sotto_tid)
                    .unwrap_or_default();
                if let Some(mut act) = self.turn_activities.lock().unwrap().remove(sotto_tid) {
                    if let Some(obj) = act.as_object_mut() {
                        obj.insert("status".into(), Value::String(status.into()));
                        obj.insert("title".into(), Value::String(title.into()));
                        obj.insert("completedAt".into(), Value::String(now_iso()));
                    }
                    self.emit(ProviderEvent::ActivityUpserted {
                        thread_id: sotto_tid.to_string(),
                        activity: act,
                    });
                }
                self.emit(ProviderEvent::TurnCompleted {
                    thread_id: sotto_tid.to_string(),
                    turn_id,
                    status: status.into(),
                });
            }
            "system" => {
                let subtype = frame.get("subtype").and_then(Value::as_str).unwrap_or("");
                if subtype == "task_started" {
                    let task_id = frame.get("task_id").and_then(Value::as_str).unwrap_or("");
                    let desc = frame
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("Subagent");
                    if !task_id.is_empty() {
                        let act = json!({
                            "id": claude_activity_id(sotto_tid, task_id),
                            "kind": "subagent",
                            "title": desc,
                            "status": "running",
                            "startedAt": now_iso(),
                        });
                        self.emit(ProviderEvent::ActivityUpserted {
                            thread_id: sotto_tid.to_string(),
                            activity: act,
                        });
                    }
                }
            }
            _ => {}
        }
    }
}

pub struct ClaudeAdapter {
    config: ClaudeAdapterConfig,
    shared: Arc<ClaudeSharedState>,
    sessions: tokio::sync::Mutex<HashMap<String, Arc<ClaudeSessionProcess>>>,
}

impl ClaudeAdapter {
    pub fn new(config: ClaudeAdapterConfig) -> Self {
        let shared = Arc::new(ClaudeSharedState::new(config.data_directory.clone()));
        Self {
            config,
            shared,
            sessions: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    async fn ensure_thread_session(
        &self,
        req: &SendMessageRequest,
    ) -> Result<(Arc<ClaudeSessionProcess>, String), String> {
        let mut map = self.sessions.lock().await;
        if let Some(existing) = map.get(&req.thread_id) {
            return Ok((Arc::clone(existing), existing.session_id.clone()));
        }

        let raw_model = req
            .model_id
            .as_deref()
            .map(raw_claude_model)
            .unwrap_or_else(|| "fixture-model".to_string());
        let existing_record = self
            .shared
            .records
            .lock()
            .unwrap()
            .get(&req.thread_id)
            .cloned();
        let (session_id, resume) = match existing_record {
            Some(rec) => (rec.session_id, rec.started),
            None => (Uuid::new_v4().to_string(), false),
        };

        let proc = ClaudeSessionProcess::spawn(
            &self.config,
            Arc::clone(&self.shared),
            Some(req.thread_id.clone()),
            session_id.clone(),
            &req.cwd,
            &raw_model,
            req.reasoning_effort.as_deref(),
            req.runtime_mode.as_deref(),
            resume,
            false,
        )?;
        proc.initialize(self.config.request_timeout_ms).await?;

        self.shared.records.lock().unwrap().insert(
            req.thread_id.clone(),
            ClaudeThreadRecord {
                session_id: session_id.clone(),
                cwd: req.cwd.clone(),
                model_id: Some(raw_model),
                reasoning_effort: req.reasoning_effort.clone(),
                runtime_mode: req.runtime_mode.clone(),
                started: true,
            },
        );
        self.shared.save_records();

        map.insert(req.thread_id.clone(), Arc::clone(&proc));
        Ok((proc, session_id))
    }
}

impl ProviderAdapter for ClaudeAdapter {
    fn id(&self) -> &str {
        "claude"
    }

    fn name(&self) -> &str {
        "Claude Code"
    }

    fn status(&self) -> AgentProviderStatus {
        self.shared.status.lock().unwrap().clone()
    }

    fn models(&self) -> Vec<AgentModel> {
        self.shared.models.lock().unwrap().clone()
    }

    fn connect(&self, events: mpsc::UnboundedSender<ProviderEvent>) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            *self.shared.events_tx.lock().unwrap() = Some(events);
            let cwd = self.config.data_directory.to_string_lossy().into_owned();
            let probe = ClaudeSessionProcess::spawn(
                &self.config,
                Arc::clone(&self.shared),
                None,
                "metadata".into(),
                &cwd,
                "fixture-model",
                None,
                None,
                false,
                true,
            )?;
            let init = probe.initialize(self.config.request_timeout_ms).await;
            probe.shutdown().await;
            let init = init?;

            let version = init
                .get("claude_code_version")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();

            let mut models = Vec::new();
            if let Some(arr) = init.get("models").and_then(Value::as_array) {
                for entry in arr {
                    let raw_id = entry
                        .get("value")
                        .and_then(Value::as_str)
                        .unwrap_or("fixture-model");
                    let display = entry
                        .get("displayName")
                        .and_then(Value::as_str)
                        .unwrap_or(raw_id);
                    let efforts: Vec<String> = entry
                        .get("supportedEffortLevels")
                        .and_then(Value::as_array)
                        .map(|list| {
                            list.iter()
                                .filter_map(|v| v.as_str().map(ToString::to_string))
                                .collect()
                        })
                        .unwrap_or_default();
                    let default_effort = efforts.first().cloned();
                    models.push(AgentModel {
                        id: public_provider_entity_id("claude", "model", raw_id),
                        name: display.to_string(),
                        provider: "Claude Code".into(),
                        provider_id: "claude".into(),
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

            let status = AgentProviderStatus {
                id: "claude".into(),
                name: "Claude Code".into(),
                connection: "connected".into(),
                version,
                capabilities: claude_capabilities(),
                error: None,
            };
            *self.shared.status.lock().unwrap() = status.clone();
            *self.shared.models.lock().unwrap() = models.clone();

            self.shared.emit(ProviderEvent::StatusChanged {
                provider_id: "claude".into(),
                status,
                models,
                client_update: None,
            });
            Ok(())
        })
    }

    fn disconnect(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let procs: Vec<_> = self.sessions.lock().await.drain().collect();
            for (_, proc) in procs {
                proc.shutdown().await;
            }
            let mut status = self.shared.status.lock().unwrap().clone();
            status.connection = "disconnected".into();
            *self.shared.status.lock().unwrap() = status.clone();
            let models = self.shared.models.lock().unwrap().clone();
            self.shared.emit(ProviderEvent::StatusChanged {
                provider_id: "claude".into(),
                status,
                models,
                client_update: None,
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
            let (proc, _session_id) = self.ensure_thread_session(&req).await?;
            let message_id = Uuid::new_v4().to_string();

            self.shared
                .active_turns
                .lock()
                .unwrap()
                .insert(req.thread_id.clone(), message_id.clone());

            let act = json!({
                "id": claude_activity_id(&req.thread_id, &message_id),
                "kind": "turn",
                "sequence": 0,
                "startedAt": now_iso(),
                "status": "running",
                "timingSource": "provider",
                "title": "Working",
                "turnId": message_id,
                "afterMessageId": message_id,
            });
            self.shared
                .turn_activities
                .lock()
                .unwrap()
                .insert(req.thread_id.clone(), act.clone());
            self.shared.emit(ProviderEvent::TurnStarted {
                thread_id: req.thread_id.clone(),
                turn_id: message_id.clone(),
                after_message_id: Some(message_id.clone()),
                activity: act,
            });

            let content = build_claude_user_content(&req);
            let echoed = proc
                .send_user_frame(&message_id, content, self.config.request_timeout_ms)
                .await?;
            let latency = started.elapsed().as_millis() as u64;

            Ok(SendMessageAck {
                message_id: message_id.clone(),
                turn_id: message_id,
                status: if echoed { "accepted".into() } else { "uncertain".into() },
                provider_latency_ms: latency,
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
                .ok_or_else(|| "No pending Claude Code request matches that ID.".to_string())?;

            let response_body = build_claude_control_response(&pending, &req);
            let frame = json!({
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": pending.request_id,
                    "response": response_body,
                }
            });
            let encoded = serde_json::to_string(&frame).map_err(|e| e.to_string())?;
            pending
                .stdin_tx
                .send(encoded)
                .map_err(|_| "Claude Code process closed before receiving the answer.".to_string())?;

            self.shared.emit(ProviderEvent::RequestCleared {
                thread_id: pending.sotto_thread_id,
                request_id: req.request_id,
            });
            Ok(())
        })
    }

    fn interrupt(&self, thread_id: String) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let proc = {
                let sessions = self.sessions.lock().await;
                sessions.get(&thread_id).cloned()
            }
            .ok_or_else(|| "Claude Code session is not running.".to_string())?;

            proc.control_request(
                json!({ "subtype": "interrupt" }),
                self.config.request_timeout_ms,
            )
            .await?;

            // Ensure turn completes as interrupted even if result had empty text.
            if let Some(turn_id) = self.shared.active_turns.lock().unwrap().remove(&thread_id) {
                if let Some(mut act) = self.shared.turn_activities.lock().unwrap().remove(&thread_id)
                {
                    if let Some(obj) = act.as_object_mut() {
                        obj.insert("status".into(), Value::String("interrupted".into()));
                        obj.insert("title".into(), Value::String("Turn interrupted".into()));
                        obj.insert("completedAt".into(), Value::String(now_iso()));
                    }
                    self.shared.emit(ProviderEvent::ActivityUpserted {
                        thread_id: thread_id.clone(),
                        activity: act,
                    });
                }
                self.shared.emit(ProviderEvent::TurnCompleted {
                    thread_id,
                    turn_id,
                    status: "interrupted".into(),
                });
            }
            Ok(())
        })
    }

    fn compact(&self, thread_id: String) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let proc = {
                let sessions = self.sessions.lock().await;
                sessions.get(&thread_id).cloned()
            }
            .ok_or_else(|| "Claude Code session is not running.".to_string())?;
            let uuid = Uuid::new_v4().to_string();
            let _ = proc
                .send_user_frame(&uuid, Value::String("/compact".into()), self.config.request_timeout_ms)
                .await?;
            Ok(())
        })
    }
}

fn claude_capabilities() -> AgentCapabilities {
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

fn raw_claude_model(model_id: &str) -> String {
    parse_public_provider_entity_id(model_id)
        .map(|(_, _, raw)| raw.to_string())
        .unwrap_or_else(|| model_id.to_string())
}

fn map_claude_permission_mode(mode: Option<&str>) -> &'static str {
    match mode.unwrap_or("approval-required") {
        "full-access" => "bypassPermissions",
        "auto" => "auto",
        "auto-accept-edits" => "acceptEdits",
        _ => "default",
    }
}

fn claude_activity_id(sotto_thread_id: &str, key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("claude:{sotto_thread_id}:{key}").as_bytes());
    let digest = crate::providers::hex_encode(&hasher.finalize());
    format!("claude-activity-{digest}")
}

fn load_claude_records(data_directory: &Path) -> HashMap<String, ClaudeThreadRecord> {
    let path = data_directory.join(CLAUDE_THREADS_FILE);
    let Ok(raw) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn build_claude_user_content(req: &SendMessageRequest) -> Value {
    if req.attachments.is_empty() {
        return Value::String(req.text.clone());
    }
    let mut blocks = Vec::new();
    if !req.text.is_empty() {
        blocks.push(json!({ "type": "text", "text": req.text }));
    }
    for att in &req.attachments {
        if att.handle.kind == "image" {
            if let Ok(bytes) = fs::read(&att.path) {
                blocks.push(json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": att.handle.mime_type,
                        "data": STANDARD.encode(bytes),
                    }
                }));
            }
        } else {
            blocks.push(json!({
                "type": "text",
                "text": format!("Attached file: {} ({})", att.handle.name, att.path.to_string_lossy()),
            }));
        }
    }
    Value::Array(blocks)
}

fn build_claude_request_card(req_id: &str, _subtype: &str, request: &Value) -> Value {
    let tool_name = request
        .get("tool_name")
        .and_then(Value::as_str)
        .unwrap_or("");
    let tool_use_id = request
        .get("tool_use_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let input = request.get("input").cloned().unwrap_or_else(|| json!({}));

    if tool_name == "AskUserQuestion" {
        let mut questions = Vec::new();
        let mut top_options = Vec::new();
        let mut text = String::new();
        if let Some(arr) = input.get("questions").and_then(Value::as_array) {
            for (idx, q) in arr.iter().enumerate() {
                let header = q.get("header").and_then(Value::as_str).unwrap_or("Question");
                let question = q.get("question").and_then(Value::as_str).unwrap_or("");
                let multi = q.get("multiSelect").and_then(Value::as_bool).unwrap_or(false);
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
                    "id": idx.to_string(),
                    "header": header,
                    "question": question,
                    "options": opts,
                    "allowFreeText": true,
                    "multiSelect": multi,
                    "prose": true,
                    "skippable": true,
                }));
            }
        }
        return json!({
            "id": req_id,
            "kind": "question",
            "text": text,
            "since": now_iso(),
            "skippable": true,
            "options": top_options,
            "questions": questions,
            "context": {
                "toolCallId": tool_use_id,
                "toolName": "AskUserQuestion",
            }
        });
    }

    let command = input.get("command").and_then(Value::as_str);
    let summary = input
        .get("description")
        .and_then(Value::as_str)
        .or(command)
        .unwrap_or("Approve Claude Code tool?");
    let text = match (tool_name, command) {
        ("Bash", Some(cmd)) => format!("Run a command: {summary}\n{cmd}"),
        (_, Some(cmd)) => format!("{summary}\n{cmd}"),
        _ => summary.to_string(),
    };
    let mut ctx = Map::new();
    ctx.insert("toolCallId".into(), Value::String(tool_use_id.into()));
    ctx.insert("toolName".into(), Value::String(tool_name.into()));
    ctx.insert("summary".into(), Value::String(summary.into()));
    if let Some(cmd) = command {
        ctx.insert("command".into(), Value::String(cmd.into()));
    }
    json!({
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
        "context": Value::Object(ctx),
    })
}

/// Builds the Claude Code `control_response.response` body, strictly preserving native tool input
/// and NEVER setting `updatedPermissions` (ADR-0004).
fn build_claude_control_response(pending: &InboundClaudeRequest, req: &AnswerRequestInput) -> Value {
    if pending.subtype == "request_user_dialog" {
        let behavior = if req.approved.unwrap_or(true) {
            "completed"
        } else {
            "cancelled"
        };
        return json!({
            "behavior": behavior,
            "result": if req.answer.is_empty() { "continue" } else { req.answer.as_str() }
        });
    }

    if pending.tool_name == "AskUserQuestion" {
        let mut answers = Map::new();
        if let Some(obj) = req.question_answers.as_ref().and_then(Value::as_object) {
            for (k, v) in obj {
                let text = match v {
                    Value::String(s) => s.clone(),
                    Value::Array(arr) => arr
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", "),
                    _ => req.answer.clone(),
                };
                answers.insert(k.clone(), Value::String(text));
            }
        }
        // Always ensure every question text key is populated.
        if let Some(questions) = pending
            .native_input
            .get("questions")
            .and_then(Value::as_array)
        {
            for q in questions {
                if let Some(qtext) = q.get("question").and_then(Value::as_str) {
                    answers
                        .entry(qtext.to_string())
                        .or_insert_with(|| Value::String(req.answer.clone()));
                }
            }
        }
        let mut updated = pending.native_input.clone();
        if let Some(obj) = updated.as_object_mut() {
            obj.insert("answers".into(), Value::Object(answers));
        }
        return json!({
            "behavior": "allow",
            "updatedInput": updated,
        });
    }

    let allow = match req.permission_choice.as_deref() {
        Some("allow") | Some("allow-once") => true,
        Some("deny") => false,
        _ => req.approved.unwrap_or(false),
    };
    if allow {
        json!({
            "behavior": "allow",
            "updatedInput": pending.native_input,
        })
    } else {
        let msg = if req.answer.trim().is_empty() {
            "The user denied this request."
        } else {
            req.answer.as_str()
        };
        json!({
            "behavior": "deny",
            "message": msg,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_control_responses_preserve_input_and_never_set_updated_permissions() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let q_pending = InboundClaudeRequest {
            request_id: "r1".into(),
            sotto_thread_id: "t1".into(),
            subtype: "can_use_tool".into(),
            tool_name: "AskUserQuestion".into(),
            native_input: json!({
                "questions": [{ "question": "Which colour?", "header": "Choice", "options": [{ "label": "Blue" }] }]
            }),
            stdin_tx: tx.clone(),
        };
        let q_resp = build_claude_control_response(
            &q_pending,
            &AnswerRequestInput {
                thread_id: "t1".into(),
                request_id: "r1".into(),
                answer: "Blue".into(),
                approved: None,
                permission_choice: None,
                question_answers: None,
            },
        );
        assert_eq!(q_resp["behavior"], "allow");
        assert_eq!(q_resp["updatedInput"]["answers"]["Which colour?"], "Blue");
        assert!(q_resp.get("updatedPermissions").is_none());

        let bash_input = json!({ "command": "npm run build", "description": "Run build" });
        let p_pending = InboundClaudeRequest {
            request_id: "r2".into(),
            sotto_thread_id: "t1".into(),
            subtype: "can_use_tool".into(),
            tool_name: "Bash".into(),
            native_input: bash_input.clone(),
            stdin_tx: tx,
        };
        let p_resp = build_claude_control_response(
            &p_pending,
            &AnswerRequestInput {
                thread_id: "t1".into(),
                request_id: "r2".into(),
                answer: String::new(),
                approved: Some(true),
                permission_choice: None,
                question_answers: None,
            },
        );
        assert_eq!(p_resp["behavior"], "allow");
        assert_eq!(p_resp["updatedInput"], bash_input);
        assert!(p_resp.get("updatedPermissions").is_none());
    }
}
