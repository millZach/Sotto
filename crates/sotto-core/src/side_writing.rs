//! Sotto's own short writing (ADR-0026), as Node's `ShortTextWriter` (`src/main/llm/shortTextWriter.ts`) asks for it:
//! a side call to the thread's own provider client, on its own account and model, that is never shown to the user as an
//! error. Every failure answers `None`, so a caller keeps whatever it already had, and the only line logged is
//! `short-writing-failed`, as Node's headless host logs it: never the prompt, the material or what the provider said.

use std::sync::Arc;
use std::time::Duration;

use crate::git_local::{js_space, js_trim};
use crate::provider::{BoxFuture, ProviderAdapter};
use crate::workspace::{clip_utf16, AgentModel};

/// Node's `SIDE_WRITING_TIMEOUT_MS`: how long a thread's client has to answer a side call. A client starts cold for each
/// one, and a call that hangs is abandoned rather than retried.
pub const SIDE_WRITING_DEADLINE: Duration = Duration::from_secs(90);

/// What a piece of short text is for, as Node's `ShortTextPurpose` names it: for routing and the failure log, never
/// sent to the model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShortTextPurpose {
    ThreadTitle,
    ThreadBranch,
    CommitMessage,
    PullRequestText,
    NextPrompt,
    CommandSummary,
    ModelRoute,
}

impl ShortTextPurpose {
    /// Node's `watcherMayWrite`: the side calls Watcher's own thread may make, since neither runs a tool or joins its
    /// conversation (ADR-0173, ADR-0185).
    pub fn watcher_may_write(self) -> bool {
        matches!(self, Self::NextPrompt | Self::CommandSummary)
    }
}

/// What a provider is asked, as Node's `ShortTextPrompt` carries it: the instruction and the material kept apart, so a
/// client that takes a system prompt keeps them apart too, and the material is always something to describe, never to
/// obey.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShortTextPrompt {
    pub instruction: String,
    pub material: String,
    pub purpose: ShortTextPurpose,
}

/// How a written answer is kept, as Node's `ShortTextRequest.shape` says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShortTextShape {
    /// The first non-empty line, which is what a name or a subject is.
    Line,
    /// Every line, for a written body.
    Text,
}

/// One request for short text, as Node's `ShortTextRequest`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShortTextRequest {
    pub prompt: ShortTextPrompt,
    /// Longer output is cut back to this, in UTF-16 code units as JavaScript counts them, at a word boundary.
    pub max_characters: usize,
    pub shape: ShortTextShape,
}

/// The thread a side call is for, as the caller finds it: its provider's adapter, and whether it runs on Watcher's
/// launch profile. The caller answers `None` for a thread Node's workspace would not ask about: one it does not know,
/// one hidden from it, a council judge's, or one whose provider session has not started.
#[derive(Clone)]
pub struct SideWritingThread {
    pub provider: Arc<dyn ProviderAdapter>,
    pub watcher: bool,
}

/// Finds the thread a side call is for, by its Sotto thread ID (ADR-0002).
pub type SideWritingThreads = Arc<dyn Fn(String) -> BoxFuture<'static, Option<SideWritingThread>> + Send + Sync>;

/// Node's `ShortTextWriter.write`: the thread's own provider asked on the side, its answer kept in the request's shape.
/// A thread that is not found, Watcher's thread asked for what it may not write, a provider that writes nothing, a call
/// that fails and an answer with nothing in it all answer `None`, and each is logged by its stable name alone.
pub async fn write_short_text(threads: &SideWritingThreads, thread_id: &str, request: &ShortTextRequest) -> Option<String> {
    let purpose = request.prompt.purpose;
    let content = match threads(thread_id.to_string()).await {
        // Every Node adapter that knows Watcher's profile writes nothing else for it.
        Some(thread) if thread.watcher && !purpose.watcher_may_write() => Ok(None),
        Some(thread) => thread.provider.write_short_text(thread_id.to_string(), request.prompt.clone()).await,
        None => Ok(None),
    };
    let content = match content {
        Ok(Some(content)) => content,
        Ok(None) => return failed(),
        Err(_) => return failed(),
    };
    let kept = match request.shape {
        ShortTextShape::Line => trim_to_line(&content, request.max_characters),
        ShortTextShape::Text => trim_to_text(&content, request.max_characters),
    };
    kept.or_else(failed)
}

/// Node's headless host logs a short-writing failure, whether the thread's provider writes nothing, failed or wrote
/// nothing to keep, by its code alone: not the purpose, the reason or any text.
fn failed() -> Option<String> {
    eprintln!("[Sotto] short-writing-failed");
    None
}

/// Node's `sideWritingEffort`: the least thorough effort the thread's model reports, or none, for the model's own
/// default. A name or a commit subject needs no deliberation, and the call is paid for from the same limits as the
/// thread's own work.
pub fn side_writing_effort(models: &[AgentModel], model_id: &str) -> Option<String> {
    crate::coordinator::resolve_model(models, model_id)?.reasoning_efforts.as_ref()?.first().cloned()
}

/// JavaScript's `\s`, as the `u` flag reads it: the same set `trim` takes away.
pub(crate) fn js_whitespace_runs_to_space(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for c in text.chars() {
        if js_space(c) {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

/// Node's `trimToLine`: the first non-empty line, its runs of space made one, its quotes and its closing full stop
/// taken off, and anything past the ceiling cut at a word.
pub fn trim_to_line(content: &str, max_characters: usize) -> Option<String> {
    let line = content.split('\n').map(js_trim).find(|part| !part.is_empty())?;
    let spaced = js_whitespace_runs_to_space(line);
    let quote = |c: char| matches!(c, '"' | '\'' | '“' | '”' | '‘' | '’' | '`');
    let unquoted = spaced.trim_start_matches(quote).trim_end_matches(quote);
    let unstopped = unquoted.trim_end_matches(['.', '、', '。']);
    cut_at_boundary(js_trim(unstopped), max_characters, &[' '])
}

/// Node's `trimToText`: a code fence round the whole answer dropped, each line's end trimmed, runs of blank lines made
/// one, and an over-long text cut at a line or a word rather than mid-word.
pub fn trim_to_text(content: &str, max_characters: usize) -> Option<String> {
    let text = fenced(js_trim(content)).unwrap_or(content);
    let lines: Vec<&str> = text.split('\n').map(|line| line.trim_end_matches(js_space)).collect();
    let mut joined = lines.join("\n");
    while joined.contains("\n\n\n") {
        joined = joined.replace("\n\n\n", "\n\n");
    }
    cut_at_boundary(js_trim(&joined), max_characters, &['\n', ' '])
}

/// What Node's ``/^```[^\n]*\n([\s\S]*?)\n?```$/u`` takes from a whole answer in a code fence: everything after the
/// fence's first line and before its closing backticks, less one newline before them.
fn fenced(text: &str) -> Option<&str> {
    let rest = text.strip_prefix("```")?;
    let body = &rest[rest.find('\n')? + 1..];
    let inner = body.strip_suffix("```")?;
    Some(inner.strip_suffix('\n').unwrap_or(inner))
}

/// Node's `cutAtBoundary`: text past the ceiling cut at the last boundary, unless that would lose more than half of it.
/// Lengths are UTF-16 code units, as JavaScript counts them; a cut never falls inside a character.
fn cut_at_boundary(text: &str, max_characters: usize, boundaries: &[char]) -> Option<String> {
    if text.is_empty() {
        return None;
    }
    if text.encode_utf16().count() <= max_characters {
        return Some(text.to_string());
    }
    let cut = clip_utf16(text, max_characters);
    let last = boundaries.iter().filter_map(|mark| cut.rfind(*mark)).max();
    let kept = match last {
        Some(at) if cut[..at].encode_utf16().count() * 2 > max_characters => &cut[..at],
        _ => cut,
    };
    Some(js_trim(kept).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_one_line_as_nodes_trim_to_line_does() {
        assert_eq!(trim_to_line("\n  \n  \"Fix   the\tbuild.\"  \nmore", 72).as_deref(), Some("Fix the build"));
        // As Node orders it: quotes come off before the full stop, so a quote before one stays.
        assert_eq!(trim_to_line("`Name`。", 72).as_deref(), Some("Name`"));
        assert_eq!(trim_to_line(" \n\t\n", 72), None);
        // Past the ceiling, at the last space when that keeps more than half.
        assert_eq!(trim_to_line("one two three four", 12).as_deref(), Some("one two"));
        assert_eq!(trim_to_line("abcdefghij k", 8).as_deref(), Some("abcdefgh"));
    }

    #[test]
    fn keeps_a_written_body_as_nodes_trim_to_text_does() {
        assert_eq!(trim_to_text("```text\nSubject\n\n\n\nBody   \n```", 1000).as_deref(), Some("Subject\n\nBody"));
        assert_eq!(trim_to_text("  Subject  \r\n\nBody\n", 1000).as_deref(), Some("Subject\n\nBody"));
        assert_eq!(trim_to_text("```\n```", 1000), None);
        // A fence that does not close the answer is kept as written.
        assert_eq!(trim_to_text("```\nSubject\n``` and more", 1000).as_deref(), Some("```\nSubject\n``` and more"));
        // Cut at the later of the last line break and the last space when that keeps more than half, else at the ceiling.
        assert_eq!(trim_to_text("Subject line\nsecond line here", 20).as_deref(), Some("Subject line\nsecond"));
        assert_eq!(trim_to_text("Subject line\nsecondlinehere", 20).as_deref(), Some("Subject line"));
        assert_eq!(trim_to_text("ab cdefghijklmnop", 10).as_deref(), Some("ab cdefghi"));
    }

    #[test]
    fn lets_watcher_write_only_its_own_side_calls() {
        assert!(!ShortTextPurpose::CommitMessage.watcher_may_write());
        assert!(ShortTextPurpose::NextPrompt.watcher_may_write() && ShortTextPurpose::CommandSummary.watcher_may_write());
    }
}
