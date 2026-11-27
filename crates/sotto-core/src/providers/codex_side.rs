//! Codex's side call (ADR-0026), as Node's `writeWithCodexExec` (`src/main/agents/subscriptionCodex.ts`) makes it: one
//! `codex exec --ephemeral` of the user's own Codex on the thread's model, in the thread's folder, with every tool and
//! integration switched off and nothing to approve, so it cannot act and writes no session file, and neither Codex's
//! own thread list nor the thread's app-server learns of it. The instruction and the material go in on standard input,
//! never in an argument; the last agent message is the whole answer, and a tool item of any kind stops the call. What it
//! is given and what it answers are never logged.

use std::time::Duration;

use serde_json::Value;
use tokio::io::AsyncWriteExt;

use super::codex::CodexLaunch;
use super::side_process::SideOutput;
use crate::git_local::js_trim;
use crate::side_writing::ShortTextPrompt;

/// Node's `UNAVAILABLE`: what every failure but a refused model or a tool says.
const UNAVAILABLE: &str = "Codex subscription request failed. Check Codex sign-in, model access and usage limits, then retry.";
/// Node's `MAX_OUTPUT_BYTES`: what the run may print, standard output and error together.
const OUTPUT_LIMIT: usize = 1_048_576;
/// How long Node gives a stopped run before it kills it outright.
const STOP_GRACE: Duration = Duration::from_secs(1);

/// Node's `DISABLED_FEATURES`: every tool and integration a turn could reach.
const DISABLED_FEATURES: &[&str] = &[
    "shell_tool", "unified_exec", "shell_snapshot", "apps", "plugins", "remote_plugin",
    "hooks", "memories", "multi_agent", "multi_agent_v2", "goals", "computer_use",
    "browser_use", "browser_use_external", "in_app_browser", "in_app_local_automation",
    "image_generation", "view_image", "code_mode", "code_mode_only", "code_mode_host",
    "skill_search", "skill_mcp_dependency_install", "tool_suggest", "recommended_plugins",
    "sleep_tool", "workspace_dependencies",
];

/// Node's `sideWritingArguments`: its `isolationArguments` with nothing to approve, each as a `-c` setting. Skills and
/// MCP are off through the orchestrator as well as directly, the project's instruction files and history are not read,
/// `notify` is emptied so the user's own turn-complete program is never handed the prompt, and OpenTelemetry never logs it.
fn side_writing_arguments() -> Vec<String> {
    let mut settings: Vec<String> = DISABLED_FEATURES.iter().map(|name| format!("features.{name}=false")).collect();
    settings.extend(
        [
            "features.skip_host_skill_discovery=true", "web_search=\"disabled\"",
            "skills.include_instructions=false", "skills.bundled.enabled=false",
            "orchestrator.skills.enabled=false", "orchestrator.mcp.enabled=false",
            "project_doc_max_bytes=0", "mcp_servers={}", "instructions=\"\"",
            "history.persistence=\"none\"", "notify=[]", "otel.log_user_prompt=false",
            "model_provider=\"openai\"", "sandbox_mode=\"read-only\"",
            "approval_policy=\"never\"",
        ]
        .map(String::from),
    );
    settings.into_iter().flat_map(|setting| ["-c".to_string(), setting]).collect()
}

/// Node's model check, ``/^[a-z0-9][a-z0-9._:/-]{0,159}$/iu``.
fn valid_model(model: &str) -> bool {
    let mut chars = model.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric()) && model.len() <= 160 && chars.all(|c| c.is_ascii_alphanumeric() || "._:/-".contains(c))
}

/// Node's effort check, ``/^[a-z][a-z0-9_-]{0,31}$/u``.
fn valid_effort(effort: &str) -> bool {
    let mut chars = effort.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase()) && effort.len() <= 32 && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

/// The run's arguments after the client's own, in Node's order.
fn arguments(model: &str, effort: Option<&str>, cwd: &str) -> Vec<String> {
    let mut args: Vec<String> = ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--json", "--color", "never", "--cd", cwd, "--model", model]
        .into_iter()
        .map(String::from)
        .collect();
    if let Some(effort) = effort {
        args.extend(["-c".into(), format!("model_reasoning_effort=\"{effort}\"")]);
    }
    args.extend(side_writing_arguments());
    args.push("-".into());
    args
}

/// One side call: what it asks, on which model and effort, in which folder, and how long it may take.
pub(crate) struct SideRun<'a> {
    pub(crate) prompt: &'a ShortTextPrompt,
    pub(crate) model: &'a str,
    pub(crate) effort: Option<&'a str>,
    pub(crate) cwd: &'a str,
    pub(crate) deadline: Duration,
}

/// The side call on the user's Codex, after its own leading arguments and `prefix_args`: what Codex wrote, or why it did
/// not, in Node's words. A run past its deadline or the output limit fails, and every run is stopped once it has
/// answered, as Node stops it.
pub(crate) async fn write(launch: &CodexLaunch, prefix_args: &[String], run: SideRun<'_>) -> Result<String, String> {
    let SideRun { prompt, model, effort, cwd, deadline } = run;
    if !valid_model(model) || effort.is_some_and(|effort| !valid_effort(effort)) {
        return Err("Choose a valid Codex model before asking it to write.".into());
    }
    let mut command = launch.command();
    command
        .args(prefix_args)
        .args(arguments(model, effort, cwd))
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
    let mut child = command.spawn().map_err(|_| UNAVAILABLE.to_string())?;
    let (Some(stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else {
        let _ = child.start_kill();
        return Err(UNAVAILABLE.into());
    };
    let mut output = SideOutput::new(stdout, stderr, OUTPUT_LIMIT, true);
    let input = format!("{}\n\n{}", prompt.instruction, prompt.material);
    let run = async {
        let send = async {
            let mut stdin = stdin;
            stdin.write_all(input.as_bytes()).await.map_err(|_| UNAVAILABLE.to_string())?;
            stdin.shutdown().await.map_err(|_| UNAVAILABLE.to_string())
        };
        let ((), text) = tokio::try_join!(send, read_answer(&mut output))?;
        Ok::<_, String>(text)
    };
    let outcome = tokio::time::timeout(deadline, run).await.unwrap_or_else(|_| Err(UNAVAILABLE.into()));
    // Node stops the run once it has its answer, or once it has failed, and waits for it to close, so no client
    // outlives the call that started it.
    let _ = child.start_kill();
    let _ = tokio::time::timeout(STOP_GRACE, child.wait()).await;
    outcome
}

/// Reads the run's events to its answer.
async fn read_answer<R: tokio::io::AsyncRead + Unpin>(output: &mut SideOutput<R>) -> Result<String, String> {
    let mut text = None;
    loop {
        let line = match output.next_line().await {
            Ok(Some(line)) => line,
            // A run that closes before its turn completes, or prints past the limit, wrote nothing.
            Ok(None) | Err(_) => return Err(UNAVAILABLE.into()),
        };
        let line = js_trim(&line);
        if line.is_empty() {
            continue;
        }
        if let Some(answer) = read_event(line, &mut text)? {
            return Ok(answer);
        }
    }
}

/// The item kinds a side call may produce, Node's `SIDE_WRITING_ITEMS`: `error` items are Codex's own warnings, said
/// before the turn and harmless; every other kind is a tool.
const SIDE_WRITING_ITEMS: &[&str] = &["agent_message", "reasoning", "error"];

/// One line of `codex exec --json`, as Node's `execEvent` schema reads it and its handler acts on it: the answer once
/// the turn completes, `None` while it goes on, or why it stopped.
fn read_event(line: &str, text: &mut Option<String>) -> Result<Option<String>, String> {
    let event: Value = serde_json::from_str(line).map_err(|_| UNAVAILABLE.to_string())?;
    let kind = event.as_object().and_then(|event| event.get("type")).and_then(Value::as_str).ok_or(UNAVAILABLE)?;
    // `item`, when there is one, is an object with a string `type` and, if it has one, a string `text`.
    let item = match event.get("item") {
        None => None,
        Some(item) => {
            let item_kind = item.as_object().and_then(|item| item.get("type")).and_then(Value::as_str).ok_or(UNAVAILABLE)?;
            let item_text = match item.get("text") {
                None => None,
                Some(Value::String(written)) => Some(written.as_str()),
                Some(_) => return Err(UNAVAILABLE.into()),
            };
            Some((item_kind, item_text))
        }
    };
    if matches!(kind, "item.started" | "item.completed") && item.is_some_and(|(item_kind, _)| !SIDE_WRITING_ITEMS.contains(&item_kind)) {
        return Err("Codex tried to use a tool while writing. Sotto stopped the call.".into());
    }
    if let (Some(("agent_message", Some(written))), "item.completed") = (item, kind) {
        *text = Some(written.to_string());
    }
    match kind {
        "turn.failed" | "error" => Err(UNAVAILABLE.into()),
        "turn.completed" => text.take().map(Some).ok_or_else(|| UNAVAILABLE.to_string()),
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events(lines: &[&str]) -> Result<Option<String>, String> {
        let mut text = None;
        for line in lines {
            if let Some(answer) = read_event(line, &mut text)? {
                return Ok(Some(answer));
            }
        }
        Ok(None)
    }

    #[test]
    fn keeps_the_last_agent_message_once_the_turn_completes() {
        let answer = events(&[
            r#"{"type":"thread.started","thread_id":"x"}"#,
            r#"{"type":"item.completed","item":{"id":"w","type":"error","message":"Model metadata not found."}}"#,
            r#"{"type":"item.started","item":{"type":"reasoning"}}"#,
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"First"}}"#,
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"Fix it"}}"#,
            r#"{"type":"turn.completed","usage":{}}"#,
        ]);
        assert_eq!(answer, Ok(Some("Fix it".into())));
    }

    #[test]
    fn stops_at_a_tool_a_failure_or_a_turn_with_no_message_in_nodes_words() {
        assert_eq!(
            events(&[r#"{"type":"item.started","item":{"type":"command_execution","command":"ls"}}"#]),
            Err("Codex tried to use a tool while writing. Sotto stopped the call.".into())
        );
        for failed in [
            &[r#"{"type":"turn.failed","error":{"message":"x"}}"#][..],
            &[r#"{"type":"error","message":"x"}"#],
            &[r#"{"type":"turn.completed"}"#],
            &[r#"{"type":"item.completed","item":{"type":"agent_message"}}"#, r#"{"type":"turn.completed"}"#],
            &["not json"],
            &[r#"{"item":{"type":"agent_message"}}"#],
            &[r#"{"type":"item.completed","item":null}"#],
            &[r#"{"type":"item.completed","item":{"type":"agent_message","text":1}}"#],
        ] {
            assert_eq!(events(failed), Err(UNAVAILABLE.into()), "{failed:?}");
        }
    }

    #[test]
    fn asks_on_stdin_with_everything_switched_off_and_nothing_to_approve() {
        let args = arguments("gpt-5.5", Some("low"), "/work");
        assert_eq!(&args[..14], ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--json", "--color", "never", "--cd", "/work", "--model", "gpt-5.5", "-c", "model_reasoning_effort=\"low\""]);
        assert_eq!(args.last().map(String::as_str), Some("-"));
        let settings: Vec<&str> = args[14..args.len() - 1].chunks(2).map(|pair| { assert_eq!(pair[0], "-c"); pair[1].as_str() }).collect();
        assert_eq!(settings.len(), DISABLED_FEATURES.len() + 15);
        assert!(settings.contains(&"features.shell_tool=false") && settings.contains(&"mcp_servers={}") && settings.contains(&"notify=[]"));
        assert_eq!(settings.last(), Some(&"approval_policy=\"never\""));
        assert!(!arguments("gpt-5.5", None, "/work").iter().any(|arg| arg.starts_with("model_reasoning_effort")));
    }

    #[test]
    fn checks_the_model_and_effort_as_node_does() {
        for model in ["gpt-5.5", "o3", "Fixture-Model", "a/b:c_d.e"] {
            assert!(valid_model(model), "{model}");
        }
        for model in ["", "-gpt", "gpt 5", "opus[1m]", &"a".repeat(161)] {
            assert!(!valid_model(model), "{model}");
        }
        assert!(valid_effort("low") && valid_effort("x_high-2"));
        assert!(!valid_effort("Low") && !valid_effort("") && !valid_effort("1low") && !valid_effort(&"a".repeat(33)));
    }
}
