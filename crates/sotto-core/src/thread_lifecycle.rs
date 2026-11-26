//! What a thread's own record says of where it rests, as Node reads it in `src/shared/threadActivity.ts`,
//! `src/shared/threadFailures.ts` and `src/main/agents/finishedUnread.ts`: settled, closed, failed. Snoozes and the
//! record of failures seen ask the same questions, so they are answered once here.

use std::collections::HashSet;

use chrono::DateTime;
use serde_json::Value;

use crate::workspace::{AgentProject, AgentThread};

/// Whether a saved time reads as one, as Node's `hasTimestamp`.
pub fn has_time(value: Option<&str>) -> bool {
    value.is_some_and(|value| DateTime::parse_from_rfc3339(value).is_ok())
}

/// Archived or settled by its provider, as Node's `isThreadClosed`.
pub fn is_closed(thread: &AgentThread) -> bool {
    if has_time(thread.extra.get("archivedAt").and_then(Value::as_str)) {
        return true;
    }
    match thread.extra.get("settledOverride").and_then(Value::as_str) {
        Some("active") => false,
        Some("settled") => true,
        _ => has_time(thread.settled_at.as_deref()),
    }
}

/// A thread whose last turn failed and that asks the user nothing, as Node's `failedWithoutRequest`.
pub fn failed_without_request(thread: &AgentThread) -> bool {
    thread.status == "error" && thread.requests.is_empty() && !is_closed(thread)
}

/// Which threads are settled, as Node's `settledIn`: in Sotto's workspace by themselves or their project, or closed.
pub struct SettledIn<'a> {
    projects: HashSet<&'a str>,
}

impl<'a> SettledIn<'a> {
    pub fn new(projects: &'a [AgentProject]) -> Self {
        Self {
            projects: projects
                .iter()
                .filter(|project| has_time(project.workspace_settled_at.as_deref()))
                .map(|project| project.id.as_str())
                .collect(),
        }
    }

    pub fn settled(&self, thread: &AgentThread) -> bool {
        has_time(thread.workspace_settled_at.as_deref()) || self.projects.contains(thread.project_id.as_str()) || is_closed(thread)
    }
}
