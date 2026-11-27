//! Grok Build's side call (ADR-0026), as Node's `GrokSubscriptionClient.write` (`src/main/agents/subscriptionGrok.ts`)
//! makes it: its own short-lived `agent --no-leader stdio` process of the user's Grok, never a thread's, on a throwaway
//! Grok home that is removed afterwards, so neither Grok's own session list, the thread's leader session nor the
//! adapter's records learn of it. Every tool is denied inside Grok itself, and the session opens in the thread's folder on
//! the thread's model at the least thorough effort that model reports. What it is given and what it answers are never
//! logged.
//!
//! The environments a Grok process starts on live here too: a thread's session's, Node's `grokEnvironment`, and the side
//! call's, which differs from it as Node's does.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::process::{ChildStdin, ChildStdout, Command};

use super::order_reasoning_efforts;
use super::side_process::{keep_only_environment, valid_effort, valid_model_id, SideOutput};
use crate::cli_lookup::ResolvedCli;
use crate::side_writing::ShortTextPrompt;

/// Node's `outputLimitBytes` default for a Grok side call: what it may print, standard output and error together.
const OUTPUT_LIMIT: usize = 2_000_000;
/// How long Node gives a stopped Grok before it kills it outright.
const STOP_GRACE: Duration = Duration::from_secs(1);
/// How long Grok has to say it selected the model, after it answered that it did.
const SELECTION_WAIT: Duration = Duration::from_millis(2_000);
/// How long Node waits for more text after the turn ends, and how quiet the text must have been.
const DRAIN_STEP: Duration = Duration::from_millis(150);

const CONNECTION_ERROR: &str = "Could not verify the Grok subscription. Open Grok and check its sign-in, then check the connection in Sotto. Sotto will not switch to API billing.";
const START_FAILED: &str = "Could not start the native Grok client.";
const CLOSED: &str = "The native Grok connection closed.";
const UNREADABLE: &str = "Grok sent an invalid protocol response.";
const UNEXPECTED: &str = "Grok returned an unexpected protocol response.";

/// Node's `safeEnvironment` (`src/main/agents/grokRpc.ts`), lowercase: what a Grok thread's own process keeps of the
/// host's environment.
pub(crate) const SESSION_ENVIRONMENT_KEYS: &[&str] = &[
    "path", "pathext", "systemroot", "windir", "temp", "tmp", "home", "user", "logname", "username", "userprofile", "homedrive", "homepath",
    "appdata", "localappdata", "programdata", "allusersprofile", "lang", "lc_all", "lc_ctype", "tz", "https_proxy", "http_proxy", "no_proxy",
    "ssl_cert_file", "ssl_cert_dir",
];

/// Node's `SAFE_ENVIRONMENT` (`subscriptionGrok.ts`), lowercase: what a side call keeps, which is the session's less the
/// user and login names.
pub(crate) const SIDE_ENVIRONMENT_KEYS: &[&str] = &[
    "path", "pathext", "systemroot", "windir", "temp", "tmp", "home", "userprofile", "homedrive", "homepath",
    "appdata", "localappdata", "programdata", "allusersprofile", "lang", "lc_all", "lc_ctype", "tz", "https_proxy", "http_proxy", "no_proxy",
    "ssl_cert_file", "ssl_cert_dir",
];

/// The host's own setting for `key`, when it is an absolute path, as Node reads `GROK_HOME` and `GROK_AUTH_PATH`.
fn absolute_setting(key: &str) -> Option<PathBuf> {
    std::env::var_os(key).map(PathBuf::from).filter(|path| path.is_absolute())
}

/// Node's `grokEnvironment`: what a Grok thread's own process starts on. The allow-list, the user's own Grok home and
/// sign-in file when the host names them absolutely, no API-key sign-in, no self-update, and every tool request refused
/// and never remembered. The PATH the lookup found the client on is the caller's to add after this.
pub(crate) fn session_environment(command: &mut Command) {
    keep_only_environment(command, SESSION_ENVIRONMENT_KEYS);
    for key in ["GROK_HOME", "GROK_AUTH_PATH"] {
        if let Some(path) = absolute_setting(key) {
            command.env(key, path);
        }
    }
    command
        .env("GROK_DISABLE_API_KEY_AUTH", "1")
        .env("GROK_DISABLE_AUTOUPDATER", "1")
        .env("GROK_DEFAULT_SELECTED_PERMISSION", "reject")
        .env("GROK_REMEMBER_TOOL_APPROVALS", "0");
}

/// What Node's `withSession` gives a side call: its own allow-list, the throwaway `home` and the user's own sign-in file,
/// and every memory, sub-agent, file, web, tool search, LSP, managed MCP, telemetry and imported Cursor or Claude feature
/// switched off.
fn side_environment(command: &mut Command, home: &Path) {
    keep_only_environment(command, SIDE_ENVIRONMENT_KEYS);
    let native_home = absolute_setting("GROK_HOME")
        .unwrap_or_else(|| crate::cli_lookup::CliLookupOptions::from_process_env().home.unwrap_or_default().join(".grok"));
    let auth_path = absolute_setting("GROK_AUTH_PATH").unwrap_or_else(|| native_home.join("auth.json"));
    command.env("GROK_HOME", home).env("GROK_AUTH_PATH", auth_path);
    for (key, value) in [
        ("GROK_DISABLE_API_KEY_AUTH", "1"), ("GROK_DISABLE_AUTOUPDATER", "1"),
        ("GROK_MEMORY", "0"), ("GROK_SUBAGENTS", "0"), ("GROK_WRITE_FILE", "0"), ("GROK_WEB_FETCH", "0"), ("GROK_TOOL_SEARCH", "0"),
        ("GROK_LSP_TOOLS", "0"), ("GROK_MANAGED_MCPS_ENABLED", "0"), ("GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED", "0"),
        ("GROK_DEFAULT_SELECTED_PERMISSION", "reject"), ("GROK_REMEMBER_TOOL_APPROVALS", "0"),
        ("GROK_TELEMETRY_ENABLED", "0"), ("GROK_TELEMETRY_TRACE_UPLOAD", "0"),
    ] {
        command.env(key, value);
    }
    for vendor in ["CURSOR", "CLAUDE"] {
        for feature in ["SKILLS", "RULES", "AGENTS", "MCPS", "HOOKS"] {
            command.env(format!("GROK_{vendor}_{feature}_ENABLED"), "0");
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Throwaway homes.

/// When this host started, near enough: the first time anything here asks, which is when the Grok adapter is made and
/// before any side call makes a home. Node takes its own process start.
static STARTED: LazyLock<SystemTime> = LazyLock::new(SystemTime::now);

/// Notes when this host started, for the sweep of the homes an earlier run left.
pub(crate) fn note_start() {
    LazyLock::force(&STARTED);
}

/// The writing folders already swept by this process.
static SWEPT: OnceLock<tokio::sync::Mutex<HashSet<PathBuf>>> = OnceLock::new();

/// Node's `sweepLeftoverSessions`: once per folder per process, the throwaway homes an earlier run left in `parent` are
/// removed. A crash, a kill or a removal that failed mid-call leaves one behind, holding the call's prompt in Grok's
/// session store where nothing ever reads it. Only folders made before this host started are touched, so a call already
/// running keeps its home, and every call waits for the sweep before it makes its own.
async fn sweep_leftover_sessions(parent: &Path) {
    let mut swept = SWEPT.get_or_init(Default::default).lock().await;
    if swept.insert(parent.to_path_buf()) {
        sweep(parent, *STARTED).await;
    }
}

/// The sweep itself, of every `grok-` folder in `parent` changed before `started`. The folder holds a few small entries,
/// so it is read in place rather than off the runtime.
async fn sweep(parent: &Path, started: SystemTime) {
    let Ok(entries) = std::fs::read_dir(parent) else { return };
    let left: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()) && entry.file_name().to_string_lossy().starts_with("grok-"))
        // The next start tries again for one that cannot be read or removed.
        .filter(|entry| entry.metadata().and_then(|meta| meta.modified()).is_ok_and(|changed| changed < started))
        .map(|entry| entry.path())
        .collect();
    for directory in left {
        remove_session(&directory, parent).await;
    }
}

/// Node's `mkdtemp(join(parent, 'grok-'))`: a new folder of this call's own.
async fn make_session_folder(parent: &Path) -> std::io::Result<PathBuf> {
    loop {
        let name: String = uuid::Uuid::new_v4().simple().to_string().chars().take(6).collect();
        let directory = parent.join(format!("grok-{name}"));
        match std::fs::create_dir(&directory) {
            Ok(()) => return Ok(directory),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
}

/// Node's `removeSession`: a throwaway home in `parent` removed, tried again for a moment because Windows can hold a file
/// for a moment after Grok exits, and a home left behind keeps the prompt on disk.
async fn remove_session(directory: &Path, parent: &Path) {
    if directory.parent() != Some(parent) {
        return;
    }
    for attempt in 0..=5u64 {
        match std::fs::remove_dir_all(directory) {
            Ok(()) => return,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(_) if attempt < 5 => tokio::time::sleep(Duration::from_millis(100 * (attempt + 1))).await,
            Err(_) => return,
        }
    }
}

/// A file only its owner can read, as Node writes the throwaway home's settings.
fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    std::io::Write::write_all(&mut options.open(path)?, text.as_bytes())
}

// ---------------------------------------------------------------------------------------------------------------------
// The call.

/// One side call: what it asks, on which model, in which folder, how long it may take, and the folder its throwaway
/// homes go in.
pub(crate) struct SideRun<'a> {
    pub(crate) prompt: &'a ShortTextPrompt,
    pub(crate) model: &'a str,
    pub(crate) cwd: &'a Path,
    pub(crate) deadline: Duration,
    /// Node's `writing/grok` in the host's data folder.
    pub(crate) homes_folder: &'a Path,
}

/// The side call on the user's Grok, `launch` as the lookup found it, after `prefix_args`: what Grok wrote, or why it did
/// not, in Node's words. Its home is removed however it ends.
pub(crate) async fn write(launch: Option<&ResolvedCli>, prefix_args: &[String], run: SideRun<'_>) -> Result<String, String> {
    if !valid_model_id(run.model) {
        return Err("Choose a valid Grok model before asking it to write.".into());
    }
    let Some(launch) = launch else {
        return Err("Install Grok CLI and sign in with your Grok subscription first.".into());
    };
    std::fs::create_dir_all(run.homes_folder).map_err(|_| START_FAILED.to_string())?;
    sweep_leftover_sessions(run.homes_folder).await;
    let directory = make_session_folder(run.homes_folder).await.map_err(|_| START_FAILED.to_string())?;
    let outcome = write_in(launch, prefix_args, &run, &directory).await;
    remove_session(&directory, run.homes_folder).await;
    outcome
}

/// The call in its throwaway home `directory`.
async fn write_in(launch: &ResolvedCli, prefix_args: &[String], run: &SideRun<'_>, directory: &Path) -> Result<String, String> {
    let home = directory.join("home");
    std::fs::create_dir_all(&home).map_err(|_| START_FAILED.to_string())?;
    // Grok's own marker that its Claude settings and plugins were already imported, so it imports none: in the throwaway
    // home only, never the user's.
    write_private(&home.join("config.toml"), "[claude_compat]\nimported = true\n").map_err(|_| START_FAILED.to_string())?;
    // Every tool denied inside Grok, before any session exists: ACP's capabilities do not cover its built-in tools, and
    // its empty `--tools` is not a deny-all.
    write_private(&home.join("requirements.toml"), "[permission]\nrules = [{ action = \"deny\", tool = \"any\" }]\n").map_err(|_| START_FAILED.to_string())?;

    let mut command = Command::new(&launch.executable);
    side_environment(&mut command, &home);
    launch.apply_tokio(&mut command);
    let cwd = run.cwd.to_string_lossy().into_owned();
    command
        .args(&launch.prefix_args)
        .args(prefix_args)
        .args(["--cwd", &cwd, "--tools", "", "--no-subagents", "--disable-web-search", "--permission-mode", "dontAsk", "--deny", "*", "agent", "--no-leader", "stdio"])
        .current_dir(run.cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|_| START_FAILED.to_string())?;
    let (Some(stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else {
        let _ = child.start_kill();
        return Err(START_FAILED.into());
    };
    let mut rpc = Rpc::new(stdin, SideOutput::new(stdout, stderr, OUTPUT_LIMIT, false));
    let outcome = match tokio::time::timeout(run.deadline, session(&mut rpc, run.prompt, run.model, &cwd)).await {
        Ok(outcome) => outcome,
        Err(_) => Err("Grok reasoning timed out. Check its subscription and connection, then try again.".into()),
    };
    // Node's `close`: its input ended and the client stopped, waited for so it lets go of the home before it is removed.
    drop(rpc);
    let _ = child.start_kill();
    let _ = tokio::time::timeout(STOP_GRACE, child.wait()).await;
    outcome
}

/// Node's `write` inside its session: signed in by Grok's own cached token and never an API key, a tool-free session in
/// the thread's folder, the thread's model at its least effort confirmed by Grok, then the instruction and the material
/// in one turn, and its text once it has stopped arriving.
async fn session(rpc: &mut Rpc, prompt: &ShortTextPrompt, model: &str, cwd: &str) -> Result<String, String> {
    let initial = rpc
        .request("initialize", json!({ "protocolVersion": 1, "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false }, "clientInfo": { "name": "sotto", "version": "1" } }))
        .await?;
    let methods = auth_methods(&initial).ok_or(UNREADABLE)?;
    if !methods.iter().any(|method| method == "cached_token") || methods.iter().any(|method| names_an_api_key(method)) {
        return Err(CONNECTION_ERROR.into());
    }
    rpc.request("authenticate", json!({ "methodId": "cached_token", "_meta": { "headless": true } })).await?;
    let created = rpc
        .request(
            "session/new",
            json!({ "cwd": cwd, "mcpServers": [], "_meta": {
                "systemPromptOverride": format!("{}\nTools and all computer actions are unavailable in this writing session.", prompt.instruction),
                "yoloMode": false, "autoMode": false,
                "agentProfile": { "name": "sotto-writing", "description": "Text-only Sotto writing", "injectDefaultTools": false, "tools": [], "permissionMode": "dontAsk",
                    "discoverSkills": false, "inheritSkills": false, "agentsMd": false, "mcpInheritance": "none", "hooks": {} },
            } }),
        )
        .await?;
    let session = read_session(&created).ok_or(UNREADABLE)?;
    if !session.models.iter().any(|offered| offered.id == session.current_model) {
        return Err("Grok did not report its current model in the subscription catalog.".into());
    }
    let selected = session
        .models
        .iter()
        .find(|offered| offered.id == model)
        .ok_or("Grok no longer offers this thread\u{2019}s model. Choose an available model for the thread.")?;
    let effort = selected.efforts.first().cloned();
    rpc.session_id = session.session_id.clone();
    let mut selection = json!({ "sessionId": session.session_id, "modelId": selected.id });
    if let Some(effort) = &effort {
        selection["_meta"] = json!({ "reasoningEffort": effort });
    }
    let chosen = rpc.request("session/set_model", selection).await?;
    if chosen.pointer("/_meta/model/Ok").and_then(Value::as_str) != Some(selected.id.as_str()) {
        return Err("Grok did not select the thread\u{2019}s model. Check the connection and try again.".into());
    }
    rpc.confirm_selection(&selected.id, effort.as_deref()).await?;
    // The instruction goes in the turn too: with it only in the system prompt, a live Grok answered the first message it
    // was given instead of naming it.
    let text = format!("{}\n\n{}", prompt.instruction, prompt.material);
    let result = rpc.request("session/prompt", json!({ "sessionId": session.session_id, "prompt": [{ "type": "text", "text": text }] })).await?;
    if result.get("stopReason").and_then(Value::as_str) != Some("end_turn") {
        return Err("Grok did not finish writing. Check its subscription and usage limits, then try again.".into());
    }
    rpc.drain().await?;
    Ok(std::mem::take(&mut rpc.text))
}

/// One frame read from Grok, once [`Rpc::receive`] has acted on it.
enum Received {
    Response(i64, Result<Value, String>),
    Other,
    Closed,
}

/// What Grok's `model_changed` notification says a session is on.
struct Selection {
    model: String,
    effort: Option<String>,
}

/// Node's `GrokRpc` for a side call: one request at a time, everything Grok says in between read and acted on.
struct Rpc {
    stdin: ChildStdin,
    output: SideOutput<ChildStdout>,
    serial: i64,
    session_id: String,
    text: String,
    last_text_at: Option<Instant>,
    /// The model and effort Grok last said the session is on.
    selection: Option<Selection>,
    failed: Option<String>,
}

impl Rpc {
    fn new(stdin: ChildStdin, output: SideOutput<ChildStdout>) -> Self {
        Self { stdin, output, serial: 0, session_id: String::new(), text: String::new(), last_text_at: None, selection: None, failed: None }
    }

    /// The call fails for `error`, unless it already failed for something else, and answers with whichever came first.
    fn fail(&mut self, error: &str) -> String {
        self.failed.get_or_insert_with(|| error.to_string()).clone()
    }

    async fn send(&mut self, frame: &Value) -> Result<(), String> {
        let line = format!("{frame}\n");
        match self.stdin.write_all(line.as_bytes()).await {
            Ok(()) => Ok(()),
            Err(_) => Err(self.fail(CLOSED)),
        }
    }

    /// Node's `request`: `method` asked, and its answer, with what Grok says in between acted on.
    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        if let Some(failed) = &self.failed {
            return Err(failed.clone());
        }
        self.serial += 1;
        let id = self.serial;
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await?;
        loop {
            match self.receive().await? {
                Received::Response(answered, result) if answered == id => return result,
                Received::Response(..) => return Err(self.fail(UNEXPECTED)),
                Received::Closed => return Err("Grok closed before returning a reasoning response.".into()),
                Received::Other => {}
            }
        }
    }

    /// Node's `confirmSelection`: Grok's own word, within two seconds, that the model and effort asked for are the
    /// session's.
    async fn confirm_selection(&mut self, model: &str, effort: Option<&str>) -> Result<(), String> {
        const UNCONFIRMED: &str = "Grok did not confirm the requested model and reasoning effort. Check the connection and try again.";
        let deadline = tokio::time::Instant::now() + SELECTION_WAIT;
        loop {
            if self.selection.as_ref().is_some_and(|chosen| chosen.model == model && effort.is_none_or(|effort| chosen.effort.as_deref() == Some(effort))) {
                return Ok(());
            }
            match tokio::time::timeout_at(deadline, self.receive()).await {
                Err(_) | Ok(Ok(Received::Closed)) => return Err(UNCONFIRMED.into()),
                Ok(Err(error)) => return Err(error),
                Ok(Ok(Received::Response(..))) => return Err(self.fail(UNEXPECTED)),
                Ok(Ok(Received::Other)) => {}
            }
        }
    }

    /// Node's `drain`: what Grok still says after the turn ends, until its text has been quiet for a moment.
    async fn drain(&mut self) -> Result<(), String> {
        loop {
            let until = tokio::time::Instant::now() + DRAIN_STEP;
            loop {
                match tokio::time::timeout_at(until, self.receive()).await {
                    Err(_) => break,
                    Ok(Err(error)) => return Err(error),
                    Ok(Ok(Received::Response(..))) => return Err(self.fail(UNEXPECTED)),
                    Ok(Ok(Received::Closed)) => {
                        tokio::time::sleep_until(until).await;
                        break;
                    }
                    Ok(Ok(Received::Other)) => {}
                }
            }
            if let Some(failed) = &self.failed {
                return Err(failed.clone());
            }
            if self.last_text_at.is_none_or(|at| at.elapsed() >= DRAIN_STEP) {
                return Ok(());
            }
        }
    }

    /// Node's `receive`: one frame read and acted on. A request from Grok is refused and stops the call, as is a tool
    /// call; the session's text is gathered and its model change noted.
    async fn receive(&mut self) -> Result<Received, String> {
        let line = match self.output.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => return Ok(Received::Closed),
            Err(_) => return Err(self.fail("Grok exceeded the response size limit.")),
        };
        if crate::git_local::js_trim(&line).is_empty() {
            return Ok(Received::Other);
        }
        let Some(message) = serde_json::from_str::<Value>(&line).ok().filter(Value::is_object) else {
            return Err(self.fail(UNREADABLE));
        };
        let method = message.get("method").filter(|method| js_truthy(method));
        if let (Some(method), Some(id)) = (method, message.get("id")) {
            let error = self.fail("Grok requested a computer action during text-only reasoning. The action was denied.");
            let reply = if method == "session/request_permission" {
                json!({ "jsonrpc": "2.0", "id": id, "result": { "outcome": { "outcome": "cancelled" } } })
            } else {
                json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Computer actions are unavailable in Sotto reasoning." } })
            };
            let _ = self.stdin.write_all(format!("{reply}\n").as_bytes()).await;
            return Err(error);
        }
        if let Some(id) = message.get("id").filter(|id| id.is_number()) {
            // As JavaScript reads it, `1.0` is request 1; a number that is not a whole one matches no request Sotto made.
            let id = id.as_i64().or_else(|| id.as_f64().filter(|id| id.fract() == 0.0 && id.abs() < 9e15).map(|id| id as i64)).unwrap_or(-1);
            let result = if message.get("error").is_some_and(js_truthy) { Err(CONNECTION_ERROR.to_string()) } else { Ok(message.get("result").cloned().unwrap_or(Value::Null)) };
            return Ok(Received::Response(id, result));
        }
        let params = message.get("params");
        let for_this_session = params.and_then(|params| params.get("sessionId")).and_then(Value::as_str) == Some(self.session_id.as_str());
        let update = params.and_then(|params| params.get("update"));
        let kind = update.and_then(|update| update.get("sessionUpdate")).and_then(Value::as_str);
        match message.get("method").and_then(Value::as_str) {
            Some("session/update") if for_this_session => {
                let content = update.and_then(|update| update.get("content"));
                if kind == Some("agent_message_chunk") && content.and_then(|content| content.get("type")).and_then(Value::as_str) == Some("text") {
                    if let Some(text) = content.and_then(|content| content.get("text")).and_then(Value::as_str) {
                        self.text.push_str(text);
                        self.last_text_at = Some(Instant::now());
                    }
                }
                if kind == Some("tool_call") {
                    return Err(self.fail("Grok attempted a tool call during text-only reasoning. The response was stopped."));
                }
            }
            Some("_x.ai/session_notification") if for_this_session && kind == Some("model_changed") => {
                if let Some(model) = update.and_then(|update| update.get("model_id")).and_then(Value::as_str) {
                    let effort = update.and_then(|update| update.get("reasoning_effort")).and_then(Value::as_str).map(String::from);
                    self.selection = Some(Selection { model: model.to_string(), effort });
                }
            }
            _ => {}
        }
        Ok(Received::Other)
    }
}

/// Whether JavaScript takes `value` for true.
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0 && !number.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// What Grok answers, as Node's schemas read it.

/// What Node's `/api.?key/iu` finds in a sign-in method's name.
fn names_an_api_key(method: &str) -> bool {
    let lower: Vec<char> = method.to_lowercase().chars().collect();
    let key = |at: usize| lower.get(at..at + 3) == Some(&['k', 'e', 'y'][..]);
    (0..lower.len()).any(|at| {
        lower.get(at..at + 3) == Some(&['a', 'p', 'i'][..]) && (key(at + 3) || lower.get(at + 3).is_some_and(|c| !matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')) && key(at + 4))
    })
}

/// A string JavaScript counts as `min` to `max` characters long.
fn string_of(value: &Value, min: usize, max: usize) -> Option<&str> {
    let text = value.as_str()?;
    let length = text.encode_utf16().count();
    (min..=max).contains(&length).then_some(text)
}

/// A field zod's `.optional()` takes: absent, or present and passing `check`. JSON's `null` is not absent.
fn optional(object: &Value, key: &str, check: impl FnOnce(&Value) -> bool) -> bool {
    object.get(key).is_none_or(check)
}

/// Node's `INITIALIZE`: protocol version 1 and the sign-in methods' names.
fn auth_methods(initial: &Value) -> Option<Vec<String>> {
    if initial.get("protocolVersion").and_then(Value::as_f64) != Some(1.0) {
        return None;
    }
    initial.get("authMethods")?.as_array()?.iter().map(|method| Some(method.as_object()?.get("id")?.as_str()?.to_string())).collect()
}

/// A model the session offers, with the efforts it reports in Sotto's order.
#[derive(Debug, PartialEq, Eq)]
struct Offered {
    id: String,
    efforts: Vec<String>,
}

/// What Node's `SESSION` schema and `account` take from a new session.
#[derive(Debug, PartialEq, Eq)]
struct NewSession {
    session_id: String,
    current_model: String,
    models: Vec<Offered>,
}

/// Node's `SESSION`, and the catalog its `account` makes of it: each model's efforts, when it supports any, as
/// `orderReasoningEfforts` orders their values.
fn read_session(created: &Value) -> Option<NewSession> {
    let session_id = string_of(created.get("sessionId")?, 1, 300)?.to_string();
    let models = created.get("models")?;
    let current_model = models.get("currentModelId")?.as_str().filter(|id| valid_model_id(id))?.to_string();
    let available = models.get("availableModels")?.as_array()?;
    if available.is_empty() || available.len() > 300 {
        return None;
    }
    let offered = available.iter().map(read_offered).collect::<Option<Vec<_>>>()?;
    let meta_ok = optional(created, "_meta", |meta| {
        meta.is_object()
            && optional(meta, "x.ai/sessionConfig", |config| {
                config.get("options").and_then(Value::as_array).is_some_and(|options| {
                    options.iter().all(|option| {
                        option.is_object()
                            && option.get("id").is_some_and(Value::is_string)
                            && option.get("category").is_some_and(Value::is_string)
                            && optional(option, "selected", Value::is_boolean)
                    })
                })
            })
    });
    meta_ok.then_some(NewSession { session_id, current_model, models: offered })
}

/// One of `availableModels`, as Node's schema reads it.
fn read_offered(model: &Value) -> Option<Offered> {
    let id = model.get("modelId")?.as_str().filter(|id| valid_model_id(id))?.to_string();
    string_of(model.get("name")?, 1, 300)?;
    let mut supports = false;
    let mut efforts = Vec::new();
    if let Some(meta) = model.get("_meta") {
        meta.as_object()?;
        if !optional(meta, "supportsReasoningEffort", Value::is_boolean) || !optional(meta, "reasoningEffort", |effort| effort.as_str().is_some_and(valid_effort)) {
            return None;
        }
        supports = meta.get("supportsReasoningEffort") == Some(&Value::Bool(true));
        if let Some(listed) = meta.get("reasoningEfforts") {
            let listed = listed.as_array().filter(|listed| listed.len() <= 30)?;
            for entry in listed {
                let named = |key: &str| entry.get(key).and_then(Value::as_str).filter(|name| valid_effort(name));
                let id = named("id")?;
                if !entry.is_object() || !optional(entry, "value", |value| value.as_str().is_some_and(valid_effort)) || !optional(entry, "default", Value::is_boolean) {
                    return None;
                }
                efforts.push(named("value").unwrap_or(id).to_string());
            }
        }
    }
    Some(Offered { id, efforts: if supports { order_reasoning_efforts(&efforts) } else { Vec::new() } })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_new_session_as_nodes_session_schema_does() {
        let created = json!({ "sessionId": "s", "models": { "currentModelId": "grok-5", "availableModels": [
            { "modelId": "grok-5", "name": "Grok 5", "_meta": { "supportsReasoningEffort": true, "reasoningEffort": "high", "reasoningEfforts": [{ "id": "high" }, { "id": "x", "value": "low", "default": true }] } },
            { "modelId": "grok-fast", "name": "Fast", "_meta": { "reasoningEfforts": [{ "id": "low" }] } },
        ] }, "_meta": { "x.ai/sessionConfig": { "options": [{ "id": "a", "category": "b", "selected": true }] } } });
        assert_eq!(
            read_session(&created),
            Some(NewSession { session_id: "s".into(), current_model: "grok-5".into(), models: vec![
                Offered { id: "grok-5".into(), efforts: vec!["low".into(), "high".into()] },
                // Efforts listed by a model that does not say it supports them are none.
                Offered { id: "grok-fast".into(), efforts: Vec::new() },
            ] })
        );
        for broken in [
            json!({ "sessionId": "", "models": { "currentModelId": "m", "availableModels": [{ "modelId": "m", "name": "M" }] } }),
            json!({ "sessionId": "s", "models": { "currentModelId": "m", "availableModels": [] } }),
            json!({ "sessionId": "s", "models": { "currentModelId": "-m", "availableModels": [{ "modelId": "m", "name": "M" }] } }),
            json!({ "sessionId": "s", "models": { "currentModelId": "m", "availableModels": [{ "modelId": "m", "name": "M", "_meta": null }] } }),
            json!({ "sessionId": "s", "models": { "currentModelId": "m", "availableModels": [{ "modelId": "m", "name": "M", "_meta": { "reasoningEfforts": [{ "id": "Low" }] } }] } }),
            json!({ "sessionId": "s", "models": { "currentModelId": "m", "availableModels": [{ "modelId": "m", "name": "M" }] }, "_meta": { "x.ai/sessionConfig": {} } }),
        ] {
            assert_eq!(read_session(&broken), None, "{broken}");
        }
    }

    #[test]
    fn signs_in_only_by_grok_s_cached_token() {
        assert_eq!(auth_methods(&json!({ "protocolVersion": 1, "authMethods": [{ "id": "cached_token" }] })), Some(vec!["cached_token".into()]));
        assert_eq!(auth_methods(&json!({ "protocolVersion": 2, "authMethods": [] })), None);
        assert_eq!(auth_methods(&json!({ "protocolVersion": 1, "authMethods": [{ "name": "x" }] })), None);
        for named in ["api_key", "API-KEY", "xai-apikey", "apiXkey"] {
            assert!(names_an_api_key(named), "{named}");
        }
        for named in ["cached_token", "api__key", "api\nkey", "key-api"] {
            assert!(!names_an_api_key(named), "{named}");
        }
    }

    /// The homes an earlier run left are removed, and one made since this host started, as a running call's is, is kept.
    #[test]
    fn sweeps_only_the_homes_an_earlier_run_left() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let dir = tempfile::tempdir().unwrap();
        for name in ["grok-left", "grok-running", "other"] {
            std::fs::create_dir_all(dir.path().join(name).join("home")).unwrap();
        }
        std::fs::write(dir.path().join("grok-file"), "kept").unwrap();
        let later = SystemTime::now() + Duration::from_secs(60);
        runtime.block_on(sweep(dir.path(), later));
        assert!(!dir.path().join("grok-left").exists() && !dir.path().join("grok-running").exists());
        assert!(dir.path().join("other").exists() && dir.path().join("grok-file").exists());
        std::fs::create_dir_all(dir.path().join("grok-running")).unwrap();
        runtime.block_on(sweep(dir.path(), SystemTime::now() - Duration::from_secs(60)));
        assert!(dir.path().join("grok-running").exists());
    }
}
