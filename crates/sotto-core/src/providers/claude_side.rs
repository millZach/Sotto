//! Claude Code's side call (ADR-0026), as Node's `ClaudeSubscriptionClient.write` (`src/main/agents/subscriptionClaude.ts`)
//! makes it: one print run of the user's own Claude Code on the thread's model, with no tools, no customisations, nobody
//! to prompt and no session file, so it cannot act, and neither Claude Code's resume list nor the thread's transcript
//! learns of it. The instruction is the system prompt and the material arrives on standard input, never in an argument.
//! What it is given and what it answers are never logged.

use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

use super::claude::ClaudeLaunch;
use crate::side_writing::ShortTextPrompt;

/// Node's `outputLimitBytes` default: what the run may print, standard output and error together.
const OUTPUT_LIMIT: usize = 256 * 1024;
/// How long Node waits for a stopped run to close before it answers.
const STOP_GRACE: Duration = Duration::from_secs(2);

const START_FAILED: &str = "Could not start Claude Code. Check its installation and try again.";

/// Node's `MODEL_ID`: at most 160 characters, a letter or digit first, then letters, digits and `._:/-`, with an
/// optional bracketed tag such as `[1m]`, in either case.
fn valid_model(model: &str) -> bool {
    let (base, tag) = match model.find('[') {
        Some(at) => (&model[..at], Some(&model[at..])),
        None => (model, None),
    };
    let tag_ok = tag.is_none_or(|tag| {
        tag.strip_prefix('[').and_then(|rest| rest.strip_suffix(']')).is_some_and(|inner| !inner.is_empty() && inner.chars().all(|c| c.is_ascii_alphanumeric()))
    });
    model.len() <= 160
        && base.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && base.chars().all(|c| c.is_ascii_alphanumeric() || "._:/-".contains(c))
        && tag_ok
}

/// Node's effort check: a lowercase letter, then up to 31 lowercase letters, digits, `_` or `-`.
fn valid_effort(effort: &str) -> bool {
    let mut chars = effort.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && effort.len() <= 32
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

/// The run's arguments after the client's own, in Node's order.
fn arguments(prompt: &ShortTextPrompt, model: &str, effort: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = ["--print", "--safe-mode", "--tools", "", "--permission-prompts", "none", "--no-session-persistence", "--output-format", "json", "--model", model]
        .into_iter()
        .map(String::from)
        .collect();
    if let Some(effort) = effort {
        args.extend(["--effort".into(), effort.into()]);
    }
    args.extend(["--system-prompt".into(), prompt.instruction.clone()]);
    args
}

/// One side call: what it asks, on which model and effort, in which folder, and how long it may take.
pub(crate) struct SideRun<'a> {
    pub(crate) prompt: &'a ShortTextPrompt,
    pub(crate) model: &'a str,
    pub(crate) effort: Option<&'a str>,
    pub(crate) cwd: &'a Path,
    pub(crate) deadline: Duration,
}

/// The side call on the user's Claude Code, after its own leading arguments and `prefix_args`: what Claude Code wrote,
/// or why it did not, in Node's words. A run past its deadline or the output limit is killed.
pub(crate) async fn write(launch: &ClaudeLaunch, prefix_args: &[String], run: SideRun<'_>) -> Result<String, String> {
    let SideRun { prompt, model, effort, cwd, deadline } = run;
    if !valid_model(model) || effort.is_some_and(|effort| !valid_effort(effort)) {
        return Err("Choose a valid Claude model before asking it to write.".into());
    }
    let mut command = launch.command();
    command
        .args(prefix_args)
        .args(arguments(prompt, model, effort))
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
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
    let printed = AtomicUsize::new(0);
    let run = async {
        let input = async {
            let mut stdin = stdin;
            stdin.write_all(prompt.material.as_bytes()).await.map_err(|_| "Claude Code could not receive the reasoning request.".to_string())?;
            stdin.shutdown().await.map_err(|_| "Claude Code could not receive the reasoning request.".to_string())
        };
        let (_, output, _) = tokio::try_join!(input, drain(stdout, &printed, true), drain(stderr, &printed, false))?;
        let status = child.wait().await.map_err(|_| START_FAILED.to_string())?;
        Ok::<_, String>((status, output))
    };
    let outcome = match tokio::time::timeout(deadline, run).await {
        Ok(outcome) => outcome,
        Err(_) => Err("Claude Code did not finish in time. Check the native client before retrying.".into()),
    };
    let (status, output) = match outcome {
        Ok(done) => done,
        Err(error) => {
            // Wait for it to close, as Node does, so no client outlives the call that started it.
            let _ = child.start_kill();
            let _ = tokio::time::timeout(STOP_GRACE, child.wait()).await;
            return Err(error);
        }
    };
    if !status.success() {
        return Err("Claude Code could not complete the request. Check its subscription and usage limits in the native client.".into());
    }
    read_result(&String::from_utf8_lossy(&output))
}

/// Reads one of the run's pipes to its end, keeping it when `keep`, and stops the run once both together pass the limit.
async fn drain(mut pipe: impl AsyncRead + Unpin, printed: &AtomicUsize, keep: bool) -> Result<Vec<u8>, String> {
    let mut kept = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let read = match pipe.read(&mut buffer).await {
            Ok(0) => return Ok(kept),
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Ok(kept),
        };
        if printed.fetch_add(read, Ordering::SeqCst) + read > OUTPUT_LIMIT {
            return Err("Claude Code exceeded the reasoning output limit.".into());
        }
        if keep {
            kept.extend_from_slice(&buffer[..read]);
        }
    }
}

/// Node's `RESULT`: `{ "type": "result", "is_error"?: boolean, "result": string }`, and the text it carries.
fn read_result(output: &str) -> Result<String, String> {
    const UNREADABLE: &str = "Claude Code did not return its answer in a form Sotto can read.";
    let envelope: Value = serde_json::from_str(output).map_err(|_| UNREADABLE.to_string())?;
    let is_error = match envelope.get("is_error") {
        None => false,
        Some(Value::Bool(flag)) => *flag,
        Some(_) => return Err(UNREADABLE.into()),
    };
    let (Some("result"), Some(result)) = (envelope.get("type").and_then(Value::as_str), envelope.get("result").and_then(Value::as_str)) else {
        return Err(UNREADABLE.into());
    };
    if is_error {
        return Err("Claude Code could not write this text. Check its subscription and usage limits in the native client.".into());
    }
    Ok(result.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_the_model_and_effort_as_node_does() {
        for model in ["opus", "claude-opus-5-5", "opus[1m]", "Sonnet[1M]", "us.anthropic/claude:v1.0"] {
            assert!(valid_model(model), "{model}");
        }
        for model in ["", "-opus", "opus[]", "opus[1m", "opus 5", "opus[1m]x", &"a".repeat(161)] {
            assert!(!valid_model(model), "{model}");
        }
        assert!(valid_effort("low") && valid_effort("x_high-2"));
        assert!(!valid_effort("Low") && !valid_effort("") && !valid_effort("1low") && !valid_effort(&"a".repeat(33)));
    }

    #[test]
    fn reads_the_answer_as_nodes_result_schema_does() {
        assert_eq!(read_result(r#" {"type":"result","subtype":"success","is_error":false,"result":"Fix it"} "#), Ok("Fix it".into()));
        assert_eq!(read_result(r#"{"type":"result","result":"Fix it"}"#), Ok("Fix it".into()));
        assert!(read_result(r#"{"type":"result","is_error":true,"result":"x"}"#).unwrap_err().contains("could not write this text"));
        for unreadable in ["", "{}", r#"{"type":"assistant","result":"x"}"#, r#"{"type":"result","result":1}"#, r#"{"type":"result","is_error":"no","result":"x"}"#] {
            assert_eq!(read_result(unreadable), Err("Claude Code did not return its answer in a form Sotto can read.".into()), "{unreadable}");
        }
    }

    #[test]
    fn asks_with_the_instruction_as_the_system_prompt_and_no_tools() {
        let prompt = ShortTextPrompt { instruction: "Write it.".into(), material: "diff".into(), purpose: crate::side_writing::ShortTextPurpose::CommitMessage };
        assert_eq!(
            arguments(&prompt, "opus", Some("low")),
            ["--print", "--safe-mode", "--tools", "", "--permission-prompts", "none", "--no-session-persistence", "--output-format", "json", "--model", "opus", "--effort", "low", "--system-prompt", "Write it."]
        );
        assert!(!arguments(&prompt, "opus", None).contains(&"--effort".to_string()));
    }
}
