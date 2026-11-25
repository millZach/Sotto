use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

/// A parsed user or assistant message from a native Claude Code `.jsonl` session transcript.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeTranscriptMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
}

/// Computes Claude Code's project transcript directory (`<claudeHome>/projects/<sanitizedCwd>`),
/// matching Claude Code CLI's `cwd.replace(/[^a-zA-Z0-9]/g, '-')`.
pub fn claude_project_dir(claude_home: &Path, cwd: &str) -> PathBuf {
    let sanitized: String = cwd
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    claude_home.join("projects").join(sanitized)
}

/// Returns the `.jsonl` transcript file path for a Claude Code session.
pub fn claude_transcript_path(claude_home: &Path, cwd: &str, session_id: &str) -> PathBuf {
    claude_project_dir(claude_home, cwd).join(format!("{session_id}.jsonl"))
}

/// Whether Claude Code has a transcript for `session_id` in `cwd`, found the way Node's `ClaudeSessionLog` finds it:
/// each UTF-16 code unit that is not an ASCII letter or digit becomes `-`, and a folder name longer than 200 is matched
/// by its first 200 and a `-`. Node resumes a session exactly when this is true, and so does this host (ADR-0214).
pub fn claude_session_exists(claude_home: &Path, cwd: &str, session_id: &str) -> bool {
    let folder: String = cwd
        .encode_utf16()
        .map(|unit| match char::from_u32(u32::from(unit)) {
            Some(c) if c.is_ascii_alphanumeric() => c,
            _ => '-',
        })
        .collect();
    let projects = claude_home.join("projects");
    let file = format!("{session_id}.jsonl");
    if folder.len() <= 200 {
        return projects.join(&folder).join(&file).is_file();
    }
    let prefix = format!("{}-", &folder[..200]);
    std::fs::read_dir(&projects).into_iter().flatten().flatten().any(|entry| {
        entry.file_name().to_str().is_some_and(|name| name.starts_with(&prefix)) && entry.path().join(&file).is_file()
    })
}

/// Reads a Claude Code `.jsonl` session transcript natively in Rust, ignoring sidechain frames,
/// attachments, and tool-only frames, and collapsing consecutive assistant blocks with the same
/// API message ID.
pub fn read_claude_session_transcript(path: &Path) -> Result<Vec<ClaudeTranscriptMessage>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file = File::open(path).map_err(|e| format!("Could not open Claude transcript: {e}"))?;
    let reader = BufReader::new(file);
    let mut messages: Vec<ClaudeTranscriptMessage> = Vec::new();

    for line in reader.lines() {
        let Ok(line) = line else {
            continue;
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(frame) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if frame.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let frame_type = frame.get("type").and_then(Value::as_str).unwrap_or("");
        if frame_type != "user" && frame_type != "assistant" {
            continue;
        }
        let Some(message) = frame.get("message") else {
            continue;
        };
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or(frame_type);
        if role != "user" && role != "assistant" {
            continue;
        }

        let (text, thinking, only_tool_results) = extract_content_blocks(message.get("content"));
        if only_tool_results && text.is_empty() && thinking.is_none() {
            continue;
        }
        if text.is_empty() && thinking.is_none() {
            continue;
        }

        let uuid = frame
            .get("uuid")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        let msg_id = message
            .get("id")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .or_else(|| uuid.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let created_at = frame
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        // Claude writes thinking and text blocks as separate JSONL lines sharing `message.id`.
        if role == "assistant" {
            if let Some(last) = messages.last_mut() {
                if last.role == "assistant" && last.id == msg_id {
                    if !text.is_empty() {
                        if !last.text.is_empty() {
                            last.text.push('\n');
                        }
                        last.text.push_str(&text);
                    }
                    if let Some(t) = thinking {
                        match &mut last.thinking {
                            Some(existing) => {
                                existing.push('\n');
                                existing.push_str(&t);
                            }
                            None => last.thinking = Some(t),
                        }
                    }
                    if !created_at.is_empty() {
                        last.created_at = created_at;
                    }
                    continue;
                }
            }
        }

        messages.push(ClaudeTranscriptMessage {
            id: msg_id,
            role: role.to_string(),
            text,
            created_at,
            thinking,
            uuid,
        });
    }

    Ok(messages)
}

/// Durably forks a Claude Code `.jsonl` session transcript up to an optional `up_to_uuid`,
/// rewriting `sessionId` and re-linking `parentUuid` chains into a fresh session file.
pub fn fork_claude_session(
    claude_home: &Path,
    cwd: &str,
    source_session_id: &str,
    target_session_id: &str,
    up_to_uuid: Option<&str>,
) -> Result<PathBuf, String> {
    let source_path = claude_transcript_path(claude_home, cwd, source_session_id);
    if !source_path.exists() {
        return Err("Source Claude session transcript does not exist.".into());
    }
    let content =
        fs::read_to_string(&source_path).map_err(|e| format!("Could not read transcript: {e}"))?;

    let mut out_lines: Vec<String> = Vec::new();
    let mut found_cutoff = up_to_uuid.is_none();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(mut frame) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if let Some(obj) = frame.as_object_mut() {
            obj.insert(
                "sessionId".into(),
                Value::String(target_session_id.to_string()),
            );
            if obj.contains_key("session_id") {
                obj.insert(
                    "session_id".into(),
                    Value::String(target_session_id.to_string()),
                );
            }
        }
        let matches_cutoff = up_to_uuid.is_some_and(|needle| {
            frame.get("uuid").and_then(Value::as_str) == Some(needle)
                || frame
                    .get("message")
                    .and_then(|m| m.get("id"))
                    .and_then(Value::as_str)
                    == Some(needle)
        });
        out_lines.push(serde_json::to_string(&frame).map_err(|e| e.to_string())?);
        if matches_cutoff {
            found_cutoff = true;
            break;
        }
    }

    if !found_cutoff {
        return Err("Requested fork turn boundary was not found in the Claude transcript.".into());
    }

    let target_path = claude_transcript_path(claude_home, cwd, target_session_id);
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Could not create transcript dir: {e}"))?;
    }
    let tmp = target_path.with_extension("jsonl.tmp");
    {
        let mut f = File::create(&tmp).map_err(|e| format!("Could not write forked transcript: {e}"))?;
        for l in &out_lines {
            writeln!(f, "{l}").map_err(|e| e.to_string())?;
        }
        f.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &target_path).map_err(|e| format!("Could not commit forked transcript: {e}"))?;
    Ok(target_path)
}

fn extract_content_blocks(content: Option<&Value>) -> (String, Option<String>, bool) {
    let Some(val) = content else {
        return (String::new(), None, false);
    };
    if let Some(s) = val.as_str() {
        return (s.to_string(), None, false);
    }
    let Some(arr) = val.as_array() else {
        return (String::new(), None, false);
    };

    let mut texts = Vec::new();
    let mut thinkings = Vec::new();
    let mut has_tool_result = false;
    let mut has_other = false;

    for block in arr {
        let btype = block.get("type").and_then(Value::as_str).unwrap_or("");
        match btype {
            "text" => {
                if let Some(t) = block.get("text").and_then(Value::as_str) {
                    if !t.is_empty() {
                        texts.push(t.to_string());
                    }
                }
                has_other = true;
            }
            "thinking" => {
                if let Some(t) = block.get("thinking").and_then(Value::as_str) {
                    if !t.is_empty() {
                        thinkings.push(t.to_string());
                    }
                }
                has_other = true;
            }
            "tool_result" => {
                has_tool_result = true;
            }
            _ => {
                has_other = true;
            }
        }
    }

    let thinking = if thinkings.is_empty() {
        None
    } else {
        Some(thinkings.join("\n"))
    };
    (texts.join("\n"), thinking, has_tool_result && !has_other)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_and_merges_thinking_and_text_and_forks_at_cutoff() {
        let dir = std::env::temp_dir().join(format!("sotto-claude-hist-{}", Uuid::new_v4()));
        let home = dir.join("home");
        let cwd = "/tmp/my_project";
        let src_path = claude_transcript_path(&home, cwd, "sess-1");
        fs::create_dir_all(src_path.parent().unwrap()).unwrap();

        let lines = [
            json!({
                "type": "user",
                "uuid": "u-1",
                "sessionId": "sess-1",
                "isSidechain": false,
                "timestamp": "2026-11-21T00:00:00Z",
                "message": { "role": "user", "content": "Hello Claude" }
            }),
            json!({
                "type": "assistant",
                "uuid": "a-1-think",
                "sessionId": "sess-1",
                "isSidechain": false,
                "timestamp": "2026-11-21T00:00:01Z",
                "message": { "id": "msg-1", "role": "assistant", "content": [{ "type": "thinking", "thinking": "Let me check" }] }
            }),
            json!({
                "type": "assistant",
                "uuid": "a-1-text",
                "sessionId": "sess-1",
                "isSidechain": false,
                "timestamp": "2026-11-21T00:00:02Z",
                "message": { "id": "msg-1", "role": "assistant", "content": [{ "type": "text", "text": "Hi there!" }] }
            }),
            json!({
                "type": "user",
                "uuid": "u-tool",
                "sessionId": "sess-1",
                "isSidechain": false,
                "timestamp": "2026-11-21T00:00:03Z",
                "message": { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "ok" }] }
            }),
            json!({
                "type": "assistant",
                "uuid": "side-1",
                "sessionId": "sess-1",
                "isSidechain": true,
                "timestamp": "2026-11-21T00:00:04Z",
                "message": { "id": "msg-side", "role": "assistant", "content": [{ "type": "text", "text": "Sidechain" }] }
            }),
            json!({
                "type": "user",
                "uuid": "u-2",
                "sessionId": "sess-1",
                "isSidechain": false,
                "timestamp": "2026-11-21T00:00:05Z",
                "message": { "role": "user", "content": "Second prompt" }
            }),
        ];
        let body = lines
            .iter()
            .map(|v| serde_json::to_string(v).unwrap())
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        fs::write(&src_path, body).unwrap();

        let parsed = read_claude_session_transcript(&src_path).unwrap();
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].role, "user");
        assert_eq!(parsed[0].text, "Hello Claude");
        assert_eq!(parsed[1].role, "assistant");
        assert_eq!(parsed[1].text, "Hi there!");
        assert_eq!(parsed[1].thinking.as_deref(), Some("Let me check"));
        assert_eq!(parsed[2].text, "Second prompt");

        let forked_path = fork_claude_session(&home, cwd, "sess-1", "sess-2", Some("a-1-text")).unwrap();
        let forked = read_claude_session_transcript(&forked_path).unwrap();
        assert_eq!(forked.len(), 2);
        assert_eq!(forked[1].text, "Hi there!");

        let _ = fs::remove_dir_all(&dir);
    }
}
