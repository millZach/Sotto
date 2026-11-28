//! Cursor and Antigravity side calls (ADR-0026), as Node's `CursorAcpHost.writeShortText` (`src/main/agents/cursor.ts`)
//! and `AntigravityAcpHost.writeShortText` (`src/main/agents/antigravity.ts`) make them: one short-lived ACP process of
//! its own in the thread's folder on the thread's model at its least reported effort, with no tool servers, every inbound
//! request answered `cancelled`, and any tool call stopping the session so nothing is written.
//!
//! Cursor runs against Sotto's `cursor/side-config` folder (`cli-config.json` with every tool denied) in `ask` mode;
//! Antigravity runs Gemini-only models (ADR-0212) in `default` mode and removes the side session's brain and conversation
//! files afterwards (and on cancellation). Neither prompt text nor provider replies are ever logged.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Map, Value};
use tokio::io::AsyncWriteExt;
use tokio::process::{ChildStdin, ChildStdout, Command};

use super::side_process::{keep_only_environment, SideOutput};
use super::{effort_rank, order_reasoning_efforts};
use crate::cli_lookup::ResolvedCli;
use crate::git_local::js_trim;
use crate::side_writing::ShortTextPrompt;

/// Output limit for Cursor and Antigravity side calls (stdout and stderr combined).
const OUTPUT_LIMIT: usize = 2_000_000;
/// Grace period waiting for a stopped child to exit before killing or cleaning up its files.
const STOP_GRACE: Duration = Duration::from_secs(1);

const CURSOR_FAILED: &str = "Cursor could not write this text. Nothing else changed.";
const ANTIGRAVITY_FAILED: &str = "Antigravity could not write this text. Nothing else changed.";
const ANTIGRAVITY_GEMINI_ONLY: &str = "Antigravity runs only Google\u{2019}s Gemini models in Sotto. Choose a Gemini model for this thread.";
const ANTIGRAVITY_APP_DATA: &str = "antigravity-acp";
const ANTIGRAVITY_DB_SUFFIXES: &[&str] = &["", "-wal", "-shm", "-journal"];

/// Node's `CURSOR_SIDE_DENY` (`src/main/agents/cursorRpc.ts`).
pub(crate) const CURSOR_SIDE_DENY: &[&str] = &["Read(**)", "Write(**)", "Shell(*)", "WebFetch(*)", "Mcp(*:*)"];

/// Node's Cursor `safeEnvironment` (`src/main/agents/cursorRpc.ts`), lowercase.
pub(crate) const CURSOR_ENVIRONMENT_KEYS: &[&str] = &[
    "path", "pathext", "systemroot", "windir", "comspec", "temp", "tmp", "tmpdir", "home", "user", "logname",
    "username", "userprofile", "homedrive", "homepath", "appdata", "localappdata", "programdata", "allusersprofile",
    "lang", "lc_all", "lc_ctype", "tz", "https_proxy", "http_proxy", "no_proxy", "ssl_cert_file", "ssl_cert_dir",
    "xdg_data_home", "xdg_config_home", "xdg_cache_home",
];

/// Node's Antigravity `safeEnvironment` (`src/main/agents/antigravityRpc.ts`), lowercase.
pub(crate) const ANTIGRAVITY_ENVIRONMENT_KEYS: &[&str] = &[
    "path", "pathext", "systemroot", "windir", "comspec", "home", "user", "logname", "username", "userprofile",
    "homedrive", "homepath", "appdata", "localappdata", "programdata", "allusersprofile", "lang", "lc_all",
    "lc_ctype", "tz", "https_proxy", "http_proxy", "no_proxy", "ssl_cert_file", "ssl_cert_dir", "xdg_data_home",
    "xdg_config_home", "xdg_cache_home",
];

/// Node's `cursorEnvironment`: allow-listed host environment with `CURSOR_CONFIG_DIR`, `CURSOR_INVOKED_AS=agent`,
/// and `NO_OPEN_BROWSER=1`. The lookup's augmented PATH is applied by the caller afterwards.
pub(crate) fn cursor_environment(command: &mut Command, config_directory: &Path) {
    keep_only_environment(command, CURSOR_ENVIRONMENT_KEYS);
    command
        .env("CURSOR_CONFIG_DIR", config_directory)
        .env("CURSOR_INVOKED_AS", "agent")
        .env("NO_OPEN_BROWSER", "1");
}

/// Node's headless `antigravityEnvironment` (`src/main/agents/antigravityRpc.ts` + `src/host/providerSignIn.ts`,
/// ADR-0212): allow-listed host environment with ambient Google credentials (`GEMINI_API_KEY`, `GOOGLE_API_KEY`,
/// `GOOGLE_APPLICATION_CREDENTIALS`) stripped, Sotto's own Gemini and temp folders, file storage, no self-update,
/// unbuffered Python, and `SSH_CONNECTION` so `agy` keeps Google account sign-in in Sotto's folder.
pub(crate) fn antigravity_environment(command: &mut Command, data_directory: &Path) {
    let agy_root = data_directory.join("antigravity");
    let gemini_dir = agy_root.join("gemini");
    let tmp_dir = agy_root.join("tmp");
    let _ = std::fs::create_dir_all(&gemini_dir);
    let _ = std::fs::create_dir_all(&tmp_dir);

    let ssh_connection = std::env::vars_os()
        .find(|(key, _)| key.to_str().is_some_and(|k| k.eq_ignore_ascii_case("SSH_CONNECTION")))
        .map(|(_, value)| value)
        .filter(|value| !value.is_empty());

    keep_only_environment(command, ANTIGRAVITY_ENVIRONMENT_KEYS);
    match ssh_connection {
        Some(ssh) => {
            command.env("SSH_CONNECTION", ssh);
        }
        None => {
            command.env("SSH_CONNECTION", "127.0.0.1 0 127.0.0.1 0");
        }
    }
    command
        .env("GEMINI_HOME", &gemini_dir)
        .env("AGY_ACP_FORCE_FILE_STORAGE", "1")
        .env("AGY_CLI_DISABLE_AUTO_UPDATE", "1")
        .env("PYTHONUNBUFFERED", "1");
    #[cfg(windows)]
    {
        command.env("TEMP", &tmp_dir).env("TMP", &tmp_dir);
    }
    #[cfg(not(windows))]
    {
        command.env("TMPDIR", &tmp_dir);
    }
}

/// Node's `antigravityArguments`: `acp --gemini-dir <gemini> --app-data-dir antigravity-acp`.
pub(crate) fn antigravity_arguments(data_directory: &Path) -> Vec<String> {
    let gemini_dir = data_directory.join("antigravity").join("gemini");
    vec![
        "acp".into(),
        "--gemini-dir".into(),
        gemini_dir.to_string_lossy().into_owned(),
        "--app-data-dir".into(),
        ANTIGRAVITY_APP_DATA.into(),
    ]
}

/// Node's `antigravityGeminiModel` (`src/main/agents/antigravityModels.ts`, ADR-0212).
pub(crate) fn is_antigravity_gemini_model(model_id: &str) -> bool {
    model_id
        .trim()
        .as_bytes()
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"gemini-"))
}

/// Node's `writeCursorSideConfig` (`src/main/agents/cursorRpc.ts`): writes `cli-config.json` in `config_directory`
/// denying every tool (`CURSOR_SIDE_DENY`) in allowlist mode, preserving other keys in an existing file.
pub(crate) fn write_cursor_side_config(config_directory: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(config_directory)?;
    let path = config_directory.join("cli-config.json");
    let current = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let mut editor = current
        .get("editor")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    editor.insert("vimMode".into(), Value::Bool(false));

    let mut next = current.clone();
    next.insert("version".into(), json!(1));
    next.insert("editor".into(), Value::Object(editor));
    next.insert(
        "permissions".into(),
        json!({ "allow": [], "deny": CURSOR_SIDE_DENY }),
    );
    next.insert("approvalMode".into(), Value::String("allowlist".into()));

    let current_text = serde_json::to_string_pretty(&Value::Object(current)).unwrap_or_default() + "\n";
    let next_text = serde_json::to_string_pretty(&Value::Object(next)).unwrap_or_default() + "\n";
    if current_text == next_text && path.exists() {
        return Ok(());
    }
    if crate::workspace::write_atomic(&path, next_text.as_bytes()).is_err() {
        // Windows can refuse rename over a file held by a starting Cursor process; write in place as Node does.
        std::fs::write(&path, next_text.as_bytes())?;
    }
    Ok(())
}

/// Parses an ACP `configOptions` array for the `thought_level` option whose values include at least one recognized
/// reasoning effort level (matching `cursorEffortOption` and `antigravityThinking`).
pub(crate) fn parse_thought_level_option(options: &[Value]) -> Option<(String, Vec<String>, Option<String>)> {
    for entry in options {
        if entry.get("category").and_then(Value::as_str) != Some("thought_level") {
            continue;
        }
        let Some(id) = entry.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
            continue;
        };
        let values = flatten_option_values(entry.get("options").and_then(Value::as_array));
        if !values.iter().any(|value| effort_rank(value).is_some()) {
            continue;
        }
        let ordered = order_reasoning_efforts(&values);
        let current = entry
            .get("currentValue")
            .and_then(Value::as_str)
            .filter(|value| ordered.iter().any(|level| level == value))
            .map(ToString::to_string);
        return Some((id.to_string(), ordered, current));
    }
    None
}

fn flatten_option_values(items: Option<&Vec<Value>>) -> Vec<String> {
    let mut out = Vec::new();
    let Some(items) = items else { return out };
    for item in items {
        if let Some(group) = item.get("options").and_then(Value::as_array) {
            for inner in group {
                if let Some(value) = inner.get("value").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    out.push(value.to_string());
                }
            }
        } else if let Some(value) = item.get("value").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            out.push(value.to_string());
        }
    }
    out
}

#[derive(Debug, Default, PartialEq, Eq)]
struct SessionSettings {
    model: Option<String>,
    effort_option: Option<String>,
    effort_levels: Vec<String>,
    effort: Option<String>,
    mode: Option<String>,
    mode_is_option: bool,
}

fn read_session_settings(value: &Value, prev: &SessionSettings) -> SessionSettings {
    let mut next = SessionSettings {
        model: prev.model.clone(),
        effort_option: prev.effort_option.clone(),
        effort_levels: prev.effort_levels.clone(),
        effort: prev.effort.clone(),
        mode: prev.mode.clone(),
        mode_is_option: prev.mode_is_option,
    };
    let mut mode_from_option = false;
    if let Some(options) = value.get("configOptions").and_then(Value::as_array) {
        let model_opt = options.iter().find(|entry| entry.get("id").and_then(Value::as_str) == Some("model"));
        let model_changed = model_opt
            .and_then(|entry| entry.get("currentValue"))
            .and_then(Value::as_str)
            .is_some_and(|model| {
                let changed = next.model.as_deref() != Some(model);
                next.model = Some(model.to_string());
                changed
            });
        if let Some((id, levels, current)) = parse_thought_level_option(options) {
            next.effort_option = Some(id);
            next.effort_levels = levels;
            next.effort = current;
        } else if let Some(prev_id) = prev.effort_option.as_deref() {
            // A partial `configOptions` answer may carry only `{ id, currentValue }` without repeating `category` or `options`.
            if let Some(current) = options
                .iter()
                .find(|entry| entry.get("id").and_then(Value::as_str) == Some(prev_id))
                .and_then(|entry| entry.get("currentValue"))
                .and_then(Value::as_str)
            {
                next.effort = Some(current.to_string());
            } else if model_changed || model_opt.is_some() {
                next.effort_option = None;
                next.effort_levels.clear();
                next.effort = None;
            }
        }
        if let Some(mode_opt) = options.iter().find(|entry| entry.get("id").and_then(Value::as_str) == Some("mode")) {
            next.mode_is_option = true;
            if let Some(mode) = mode_opt.get("currentValue").and_then(Value::as_str) {
                next.mode = Some(mode.to_string());
                mode_from_option = true;
            }
        } else {
            next.mode_is_option = false;
        }
    }
    if !mode_from_option {
        if let Some(mode) = value.pointer("/modes/currentModeId").and_then(Value::as_str) {
            next.mode = Some(mode.to_string());
        }
    }
    next
}

// ---------------------------------------------------------------------------------------------------------------------
// Antigravity scratch session cleanup.

fn safe_antigravity_session_id(session_id: &str) -> bool {
    (8..=128).contains(&session_id.len()) && session_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn antigravity_session_files_exist(app_data: &Path, session_id: &str) -> bool {
    if !safe_antigravity_session_id(session_id) {
        return false;
    }
    let conversations = app_data.join("conversations");
    app_data.join("brain").join(session_id).exists()
        || ANTIGRAVITY_DB_SUFFIXES
            .iter()
            .any(|suffix| conversations.join(format!("{session_id}.db{suffix}")).exists())
}

/// Node's `removeScratchSession` (`src/main/agents/antigravity.ts`): removes a side session's `brain/<id>` folder and
/// `conversations/<id>.db*` files under `<data_directory>/antigravity/gemini/antigravity-acp`.
fn remove_antigravity_session_files(app_data: &Path, session_id: &str) {
    if !safe_antigravity_session_id(session_id) {
        return;
    }
    let _ = std::fs::remove_dir_all(app_data.join("brain").join(session_id));
    let conversations = app_data.join("conversations");
    for suffix in ANTIGRAVITY_DB_SUFFIXES {
        let _ = std::fs::remove_file(conversations.join(format!("{session_id}.db{suffix}")));
    }
}

async fn remove_antigravity_session_with_retry(app_data: &Path, session_id: &str) {
    if !safe_antigravity_session_id(session_id) {
        return;
    }
    for attempt in 0..=5u64 {
        remove_antigravity_session_files(app_data, session_id);
        if !antigravity_session_files_exist(app_data, session_id) {
            return;
        }
        if attempt < 5 {
            tokio::time::sleep(Duration::from_millis(100 * (attempt + 1))).await;
        }
    }
}

struct AntigravitySessionGuard {
    app_data: PathBuf,
    session_id: Arc<Mutex<Option<String>>>,
}

impl AntigravitySessionGuard {
    fn new(app_data: PathBuf, session_id: Arc<Mutex<Option<String>>>) -> Self {
        Self { app_data, session_id }
    }

    fn disarm(&self) {
        *self.session_id.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

impl Drop for AntigravitySessionGuard {
    fn drop(&mut self) {
        let Some(session_id) = self.session_id.lock().unwrap_or_else(|e| e.into_inner()).take() else { return };
        if !safe_antigravity_session_id(&session_id) {
            return;
        }
        remove_antigravity_session_files(&self.app_data, &session_id);
        if antigravity_session_files_exist(&self.app_data, &session_id) && tokio::runtime::Handle::try_current().is_ok() {
            let app_data = self.app_data.clone();
            tokio::spawn(async move { remove_antigravity_session_with_retry(&app_data, &session_id).await });
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Shared side-call ACP RPC transport.

struct AcpSideRpc {
    stdin: ChildStdin,
    output: SideOutput<ChildStdout>,
    next_id: i64,
    session_id: Option<String>,
    text: String,
    tooled: bool,
    ignore_non_json: bool,
    /// Whether an inbound JSON-RPC request before `session/new` returns also aborts the side call (Antigravity: yes;
    /// Cursor: only once a session exists, matching `cursor.ts:1365`).
    cancel_before_session: bool,
    failure: &'static str,
}

impl AcpSideRpc {
    fn new(
        stdin: ChildStdin,
        output: SideOutput<ChildStdout>,
        ignore_non_json: bool,
        cancel_before_session: bool,
        failure: &'static str,
    ) -> Self {
        Self {
            stdin,
            output,
            next_id: 0,
            session_id: None,
            text: String::new(),
            tooled: false,
            ignore_non_json,
            cancel_before_session,
            failure,
        }
    }

    async fn write_frame(&mut self, frame: &Value) -> Result<(), String> {
        let mut line = serde_json::to_string(frame).map_err(|_| self.failure.to_string())?;
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).await.map_err(|_| self.failure.to_string())?;
        self.stdin.flush().await.map_err(|_| self.failure.to_string())
    }

    async fn cancel_once(&mut self) {
        if self.tooled {
            return;
        }
        self.tooled = true;
        if let Some(session_id) = self.session_id.clone() {
            let _ = self
                .write_frame(&json!({ "jsonrpc": "2.0", "method": "session/cancel", "params": { "sessionId": session_id } }))
                .await;
        }
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        self.write_frame(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await?;
        loop {
            let line = match self.output.next_line().await {
                Ok(Some(line)) => line,
                Ok(None) | Err(_) => return Err(self.failure.into()),
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if self.ignore_non_json && !trimmed.starts_with('{') {
                continue;
            }
            let frame: Value = serde_json::from_str(trimmed).map_err(|_| self.failure.to_string())?;
            let Some(obj) = frame.as_object() else {
                return Err(self.failure.into());
            };
            if let Some(result) = self.handle_frame(obj, id).await? {
                return Ok(result);
            }
        }
    }

    async fn handle_frame(&mut self, frame: &Map<String, Value>, waiting_id: i64) -> Result<Option<Value>, String> {
        let method = frame.get("method").and_then(Value::as_str);
        let wire_id = frame.get("id").filter(|value| !value.is_null());
        if let (Some(method), Some(wire_id)) = (method, wire_id) {
            let reply = if method == "elicitation/create" {
                json!({ "action": "cancel" })
            } else {
                json!({ "outcome": { "outcome": "cancelled" } })
            };
            let _ = self
                .write_frame(&json!({ "jsonrpc": "2.0", "id": wire_id, "result": reply }))
                .await;
            if self.cancel_before_session || self.session_id.is_some() {
                self.cancel_once().await;
            }
            return Ok(None);
        }
        if method.is_none() && wire_id.is_some() {
            if frame.get("id").and_then(Value::as_i64) != Some(waiting_id) {
                return Err(self.failure.into());
            }
            if frame.contains_key("error") {
                return Err(self.failure.into());
            }
            return Ok(Some(frame.get("result").cloned().unwrap_or(Value::Null)));
        }
        if method == Some("session/update") {
            let params = frame.get("params").and_then(Value::as_object);
            let sid = params.and_then(|p| p.get("sessionId")).and_then(Value::as_str);
            if self.session_id.as_deref() == sid && sid.is_some() {
                if let Some(update) = params.and_then(|p| p.get("update")).and_then(Value::as_object) {
                    match update.get("sessionUpdate").and_then(Value::as_str) {
                        Some("tool_call" | "tool_call_update") => {
                            self.cancel_once().await;
                        }
                        Some("agent_message_chunk") if !self.tooled => {
                            let content = update.get("content").and_then(Value::as_object);
                            if content.and_then(|c| c.get("type")).and_then(Value::as_str) == Some("text") {
                                if let Some(chunk) = content.and_then(|c| c.get("text")).and_then(Value::as_str) {
                                    self.text.push_str(chunk);
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        Ok(None)
    }

    async fn select_model_and_least_effort(&mut self, session_id: &str, model: &str, mut settings: SessionSettings) -> Result<SessionSettings, String> {
        if settings.model.as_deref() != Some(model) {
            let res = self
                .request(
                    "session/set_config_option",
                    json!({ "sessionId": session_id, "configId": "model", "value": model }),
                )
                .await?;
            settings = read_session_settings(&res, &settings);
            if settings.model.as_deref() != Some(model) {
                return Err(self.failure.into());
            }
        }
        if let (Some(opt_id), Some(least)) = (settings.effort_option.clone(), settings.effort_levels.first().cloned()) {
            if settings.effort.as_deref() != Some(least.as_str()) {
                let res = self
                    .request(
                        "session/set_config_option",
                        json!({ "sessionId": session_id, "configId": opt_id, "value": least }),
                    )
                    .await?;
                settings = read_session_settings(&res, &settings);
                if settings.effort.as_deref() != Some(least.as_str()) {
                    return Err(self.failure.into());
                }
            }
        }
        Ok(settings)
    }

    async fn prompt_text(&mut self, session_id: &str, prompt: &ShortTextPrompt) -> Result<Option<String>, String> {
        let text = format!("{}\n\n{}", prompt.instruction, prompt.material);
        let answered = self
            .request(
                "session/prompt",
                json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": text }] }),
            )
            .await?;
        let Some(stop_reason) = answered.get("stopReason").and_then(Value::as_str) else {
            return Err(self.failure.into());
        };
        if self.tooled || stop_reason != "end_turn" {
            return Ok(None);
        }
        let trimmed = js_trim(&self.text);
        Ok((!trimmed.is_empty()).then(|| trimmed.to_string()))
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Entry points: Cursor and Antigravity.

pub(crate) struct SideRun<'a> {
    pub(crate) prompt: &'a ShortTextPrompt,
    pub(crate) model: &'a str,
    pub(crate) cwd: &'a str,
    pub(crate) deadline: Duration,
    pub(crate) data_directory: &'a Path,
}

fn spawn_side_child(mut command: Command, cwd: &str, failure: &'static str) -> Result<(tokio::process::Child, ChildStdin, ChildStdout, tokio::process::ChildStderr), String> {
    command
        .current_dir(cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|_| failure.to_string())?;
    let (Some(stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else {
        let _ = child.start_kill();
        return Err(failure.into());
    };
    Ok((child, stdin, stdout, stderr))
}

async fn stop_child(child: &mut tokio::process::Child, timed_out: bool) {
    if timed_out || tokio::time::timeout(STOP_GRACE, child.wait()).await.is_err() {
        let _ = child.start_kill();
        let _ = tokio::time::timeout(STOP_GRACE, child.wait()).await;
    }
}

/// Cursor's side call (`cursor.ts:writeShortText`): one `agent acp` on `cursor/side-config` in `ask` mode,
/// on the thread's model at its least effort.
pub(crate) async fn write_cursor(launch: &ResolvedCli, prefix_args: &[String], run: SideRun<'_>) -> Result<Option<String>, String> {
    let side_config_dir = run.data_directory.join("cursor").join("side-config");
    write_cursor_side_config(&side_config_dir).map_err(|_| CURSOR_FAILED.to_string())?;

    let mut command = Command::new(&launch.executable);
    cursor_environment(&mut command, &side_config_dir);
    launch.apply_tokio(&mut command);
    command.args(&launch.prefix_args).args(prefix_args).arg("acp");
    let (mut child, stdin, stdout, stderr) = spawn_side_child(command, run.cwd, CURSOR_FAILED)?;
    let mut rpc = AcpSideRpc::new(stdin, SideOutput::new(stdout, stderr, OUTPUT_LIMIT, false), false, false, CURSOR_FAILED);
    let (timed_out, outcome) = match tokio::time::timeout(run.deadline, run_cursor_session(&mut rpc, &run)).await {
        Ok(outcome) => (false, outcome),
        Err(_) => (true, Err(CURSOR_FAILED.into())),
    };
    drop(rpc);
    stop_child(&mut child, timed_out).await;
    outcome
}

async fn run_cursor_session(rpc: &mut AcpSideRpc, run: &SideRun<'_>) -> Result<Option<String>, String> {
    let init = rpc
        .request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false,
                    "_meta": { "parameterizedModelPicker": true, "subagents": true },
                },
                "clientInfo": { "name": "sotto", "version": env!("CARGO_PKG_VERSION") },
            }),
        )
        .await?;
    if init.get("protocolVersion").and_then(Value::as_i64) != Some(1) {
        return Err(CURSOR_FAILED.into());
    }
    let created = rpc.request("session/new", json!({ "cwd": run.cwd, "mcpServers": [] })).await?;
    let session_id = created
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| CURSOR_FAILED.to_string())?
        .to_string();
    rpc.session_id = Some(session_id.clone());

    let settings = read_session_settings(&created, &SessionSettings::default());
    let _ = rpc.select_model_and_least_effort(&session_id, run.model, settings).await?;
    rpc.request(
        "session/set_config_option",
        json!({ "sessionId": session_id, "configId": "mode", "value": "ask" }),
    )
    .await?;
    rpc.prompt_text(&session_id, run.prompt).await
}

/// Antigravity's side call (`antigravity.ts:writeShortText`): one `agy acp` in the thread's folder on a Gemini model
/// at its least thinking level, in `default` mode, removing the side session's brain and conversation files afterwards.
pub(crate) async fn write_antigravity(launch: &ResolvedCli, prefix_args: &[String], run: SideRun<'_>) -> Result<Option<String>, String> {
    if !is_antigravity_gemini_model(run.model) {
        return Err(ANTIGRAVITY_GEMINI_ONLY.into());
    }
    let app_data = run.data_directory.join("antigravity").join("gemini").join(ANTIGRAVITY_APP_DATA);
    let session_slot: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let guard = AntigravitySessionGuard::new(app_data.clone(), Arc::clone(&session_slot));

    let mut command = Command::new(&launch.executable);
    antigravity_environment(&mut command, run.data_directory);
    launch.apply_tokio(&mut command);
    command
        .args(&launch.prefix_args)
        .args(prefix_args)
        .args(antigravity_arguments(run.data_directory));
    let (mut child, stdin, stdout, stderr) = spawn_side_child(command, run.cwd, ANTIGRAVITY_FAILED)?;
    let mut rpc = AcpSideRpc::new(stdin, SideOutput::new(stdout, stderr, OUTPUT_LIMIT, false), true, true, ANTIGRAVITY_FAILED);
    let (timed_out, outcome) = match tokio::time::timeout(run.deadline, run_antigravity_session(&mut rpc, &run, &session_slot)).await {
        Ok(outcome) => (false, outcome),
        Err(_) => (true, Err(ANTIGRAVITY_FAILED.into())),
    };
    drop(rpc);
    stop_child(&mut child, timed_out).await;

    let sid = session_slot.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(sid) = sid {
        remove_antigravity_session_with_retry(&app_data, &sid).await;
    }
    guard.disarm();
    outcome
}

async fn run_antigravity_session(
    rpc: &mut AcpSideRpc,
    run: &SideRun<'_>,
    session_slot: &Arc<Mutex<Option<String>>>,
) -> Result<Option<String>, String> {
    let init = rpc
        .request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false,
                },
                "clientInfo": { "name": "sotto", "title": "Sotto", "version": env!("CARGO_PKG_VERSION") },
            }),
        )
        .await?;
    if init.get("protocolVersion").and_then(Value::as_i64) != Some(1) {
        return Err(ANTIGRAVITY_FAILED.into());
    }
    rpc.request("authenticate", json!({ "methodId": "oauth-personal" })).await?;
    let created = rpc.request("session/new", json!({ "cwd": run.cwd, "mcpServers": [] })).await?;
    let session_id = created
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ANTIGRAVITY_FAILED.to_string())?
        .to_string();
    *session_slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(session_id.clone());
    rpc.session_id = Some(session_id.clone());

    let settings = read_session_settings(&created, &SessionSettings::default());
    let mut settings = rpc.select_model_and_least_effort(&session_id, run.model, settings).await?;
    if settings.mode.as_deref().is_some_and(|mode| mode != "default") {
        if settings.mode_is_option {
            let res = rpc
                .request(
                    "session/set_config_option",
                    json!({ "sessionId": session_id, "configId": "mode", "value": "default" }),
                )
                .await?;
            settings = read_session_settings(&res, &settings);
            if settings.mode.as_deref() != Some("default") {
                return Err(ANTIGRAVITY_FAILED.into());
            }
        } else {
            rpc.request("session/set_mode", json!({ "sessionId": session_id, "modeId": "default" })).await?;
        }
    }
    rpc.prompt_text(&session_id, run.prompt).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_cursor_side_config_denying_every_tool_while_preserving_other_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cli-config.json");
        std::fs::write(&path, r#"{"custom":42,"editor":{"fontSize":13,"vimMode":true}}"#).unwrap();

        write_cursor_side_config(dir.path()).unwrap();
        let written: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(written["custom"], json!(42));
        assert_eq!(written["version"], json!(1));
        assert_eq!(written["approvalMode"], json!("allowlist"));
        assert_eq!(written["editor"]["fontSize"], json!(13));
        assert_eq!(written["editor"]["vimMode"], json!(false));
        assert_eq!(written["permissions"]["allow"], json!([]));
        assert_eq!(written["permissions"]["deny"], json!(CURSOR_SIDE_DENY));
    }

    #[test]
    fn parses_thought_level_efforts_in_sottos_order_and_skips_boolean_thinking() {
        let options = vec![
            json!({ "id": "thinking", "category": "thought_level", "currentValue": "true", "options": [{ "value": "false" }, { "value": "true" }] }),
            json!({ "id": "effort", "category": "thought_level", "currentValue": "high", "options": [{ "group": "g", "options": [{ "value": "max" }, { "value": "high" }, { "value": "low" }] }] }),
        ];
        assert_eq!(
            parse_thought_level_option(&options),
            Some(("effort".into(), vec!["low".into(), "high".into(), "max".into()], Some("high".into())))
        );
        assert_eq!(parse_thought_level_option(&options[..1]), None);
    }

    #[test]
    fn read_session_settings_preserves_effort_on_partial_options_and_updates_modes() {
        let initial = json!({
            "configOptions": [
                { "id": "model", "currentValue": "gpt-fixture" },
                { "id": "reasoning", "category": "thought_level", "currentValue": "high", "options": [{ "value": "low" }, { "value": "high" }] }
            ],
            "modes": { "currentModeId": "auto" }
        });
        let s1 = read_session_settings(&initial, &SessionSettings::default());
        assert_eq!(s1.effort_option.as_deref(), Some("reasoning"));
        assert_eq!(s1.effort.as_deref(), Some("high"));
        assert_eq!(s1.mode.as_deref(), Some("auto"));
        assert!(!s1.mode_is_option);

        // Partial response after setting effort omits `category` and `options`, and updates `modes.currentModeId`.
        let partial = json!({
            "configOptions": [
                { "id": "reasoning", "currentValue": "low" }
            ],
            "modes": { "currentModeId": "default" }
        });
        let s2 = read_session_settings(&partial, &s1);
        assert_eq!(s2.effort_option.as_deref(), Some("reasoning"));
        assert_eq!(s2.effort.as_deref(), Some("low"));
        assert_eq!(s2.mode.as_deref(), Some("default"));
    }

    #[test]
    fn antigravity_gemini_filter_and_session_id_safety_match_node() {
        assert!(is_antigravity_gemini_model("gemini-3.8-flash"));
        assert!(is_antigravity_gemini_model("  GEMINI-4-carbon "));
        assert!(!is_antigravity_gemini_model("claude-sonnet-5-5"));
        assert!(!is_antigravity_gemini_model("gpt-5.6"));
        // Multi-byte UTF-8 where byte 7 is not a char boundary must never panic.
        assert!(!is_antigravity_gemini_model("日本語モデル"));
        assert!(!is_antigravity_gemini_model("éééé"));

        assert!(safe_antigravity_session_id("3d6f4ac1-4b9e-43f3-aa5e-2238e5f6c649"));
        assert!(!safe_antigravity_session_id("../escape"));
        assert!(!safe_antigravity_session_id("short"));
    }

    #[test]
    fn antigravity_session_guard_removes_brain_and_conversation_files_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("antigravity-acp");
        let sid = "3d6f4ac1-4b9e-43f3-aa5e-2238e5f6c649";
        let brain = app_data.join("brain").join(sid);
        let conv = app_data.join("conversations");
        std::fs::create_dir_all(&brain).unwrap();
        std::fs::create_dir_all(&conv).unwrap();
        std::fs::write(brain.join("note.txt"), "scratch").unwrap();
        for suffix in ANTIGRAVITY_DB_SUFFIXES {
            std::fs::write(conv.join(format!("{sid}.db{suffix}")), "db").unwrap();
        }
        std::fs::write(conv.join("other.db"), "keep").unwrap();

        let slot = Arc::new(Mutex::new(Some(sid.to_string())));
        let guard = AntigravitySessionGuard::new(app_data.clone(), slot);
        drop(guard);

        assert!(!antigravity_session_files_exist(&app_data, sid));
        assert!(conv.join("other.db").exists());
    }
}
