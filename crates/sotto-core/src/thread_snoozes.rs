//! Host-owned snoozes (ADR-0175), as Node's `ThreadSnoozes` (`src/main/agents/threadSnoozes.ts`) keeps them. Every
//! client reads one answer: each thread is published with `snoozedUntil`, the time it wakes or null. A snooze ends at its
//! time, when the user ends it, or when the thread or one it delegated to needs the user: a request, or a failure no
//! client has shown. That wakes the whole delegation, up to the first settled thread.
//!
//! The record is `agents.json`'s `threadSnoozes`, thread ID to time, so a host that rolls back to Node keeps every
//! snooze (ADR-0214).

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, Utc};
use serde_json::{Map, Value};

use crate::workspace::{AgentProject, AgentThread};

/// The key of the record in `agents.json`.
pub const SAVED_KEY: &str = "threadSnoozes";

#[derive(Debug, Default)]
pub struct ThreadSnoozes {
    until: BTreeMap<String, SnoozeUntil>,
}

/// The time a snooze ends: the words a client sent, kept as they were for `agents.json` and every client, and the
/// time they name, read once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnoozeUntil {
    words: String,
    at: DateTime<Utc>,
}

impl SnoozeUntil {
    /// Reads a time as Node's `z.string().datetime()` accepts it: RFC 3339 in UTC with a `Z`, seconds required, any
    /// fraction of a second. Anything else is no time at all.
    pub fn parse(words: &str) -> Option<Self> {
        let bytes = words.as_bytes();
        if bytes.len() < 20 || bytes[10] != b'T' || !words.ends_with('Z') {
            return None;
        }
        let at = DateTime::parse_from_rfc3339(words).ok()?.with_timezone(&Utc);
        Some(Self { words: words.to_string(), at })
    }
}

impl ThreadSnoozes {
    /// Takes the saved snoozes out of `agents.json`'s other fields. An entry that is not a time Node would read is
    /// dropped, since Node would refuse the whole file over it.
    pub fn take_saved(agents_json: &mut Map<String, Value>) -> Self {
        let mut until = BTreeMap::new();
        if let Some(Value::Object(saved)) = agents_json.remove(SAVED_KEY) {
            for (id, time) in saved {
                if let Some(time) = time.as_str().and_then(SnoozeUntil::parse) {
                    until.insert(id, time);
                }
            }
        }
        Self { until }
    }

    /// The record as `agents.json` keeps it.
    pub fn saved(&self) -> Value {
        Value::Object(self.until.iter().map(|(id, time)| (id.clone(), Value::String(time.words.clone()))).collect())
    }

    /// Snoozes a thread until a time, or ends its snooze with `None`.
    pub fn set(&mut self, thread_id: &str, until: Option<SnoozeUntil>) {
        match until {
            Some(time) => {
                self.until.insert(thread_id.to_string(), time);
            }
            None => {
                self.until.remove(thread_id);
            }
        }
    }

    /// What a client is shown for a thread: the time it wakes, or null when it is not snoozed.
    pub fn published(&self, thread_id: &str) -> Value {
        self.until.get(thread_id).map_or(Value::Null, |time| Value::String(time.words.clone()))
    }

    /// Ends every snooze whose time has come; true when one ended.
    pub fn expire(&mut self, now: DateTime<Utc>) -> bool {
        let before = self.until.len();
        self.until.retain(|_, time| time.at > now);
        self.until.len() != before
    }

    /// Wakes each thread that needs the user, and the threads that delegated to it up to the first settled one, as
    /// Node's `track` does; true when a snooze ended. A thread needs the user while it waits on a request, or while it
    /// is open and its last turn failed with nothing to answer. No client of this host is told a failure was seen, so
    /// every such failure is still unseen.
    pub fn track(&mut self, threads: &[AgentThread], projects: &[AgentProject]) -> bool {
        if self.until.is_empty() {
            return false;
        }
        let settled_projects: HashSet<&str> = projects
            .iter()
            .filter(|project| has_time(project.workspace_settled_at.as_deref()))
            .map(|project| project.id.as_str())
            .collect();
        let settled = |thread: &AgentThread| {
            has_time(thread.workspace_settled_at.as_deref())
                || settled_projects.contains(thread.project_id.as_str())
                || is_closed(thread)
        };
        let by_id: HashMap<&str, &AgentThread> = threads.iter().map(|thread| (thread.id.as_str(), thread)).collect();
        let mut changed = false;
        for thread in threads {
            let needs = !thread.requests.is_empty() || !settled(thread) && failure_unseen(thread);
            if !needs {
                continue;
            }
            let mut seen = HashSet::new();
            let mut current = Some(thread);
            while let Some(here) = current {
                if !seen.insert(here.id.as_str()) {
                    break;
                }
                changed |= self.until.remove(&here.id).is_some();
                if settled(here) {
                    break;
                }
                current = here.delegated_by.as_deref().and_then(|parent| by_id.get(parent).copied());
            }
        }
        changed
    }
}

/// Whether a saved time reads as one, as Node's `hasTimestamp`.
fn has_time(value: Option<&str>) -> bool {
    value.is_some_and(|value| DateTime::parse_from_rfc3339(value).is_ok())
}

/// Archived or settled by its provider, as Node's `isThreadClosed`.
fn is_closed(thread: &AgentThread) -> bool {
    let archived = thread.extra.get("archivedAt").and_then(Value::as_str);
    if has_time(archived) {
        return true;
    }
    match thread.extra.get("settledOverride").and_then(Value::as_str) {
        Some("active") => false,
        Some("settled") => true,
        _ => has_time(thread.settled_at.as_deref()),
    }
}

/// A failed thread that asks nothing and that no client was told it showed, as Node's `failureUnseen`.
fn failure_unseen(thread: &AgentThread) -> bool {
    thread.status == "error"
        && thread.requests.is_empty()
        && !is_closed(thread)
        && thread.extra.get("failureSeen") != Some(&Value::Bool(true))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn thread(id: &str, status: &str) -> AgentThread {
        serde_json::from_value(json!({ "id": id, "projectId": "p", "title": id, "status": status })).unwrap()
    }

    fn project(settled: Option<&str>) -> AgentProject {
        serde_json::from_value(json!({ "id": "p", "title": "P", "path": "/p", "workspaceSettledAt": settled })).unwrap()
    }

    const LATER: &str = "2099-01-01T00:00:00Z";

    fn at(words: &str) -> Option<SnoozeUntil> {
        Some(SnoozeUntil::parse(words).unwrap())
    }

    #[test]
    fn reads_only_the_times_node_reads() {
        assert!(SnoozeUntil::parse("2026-11-25T10:00:00Z").is_some());
        assert!(SnoozeUntil::parse("2026-11-25T10:00:00.123456Z").is_some());
        for refused in ["2026-11-25T10:00Z", "2026-11-25T10:00:00+01:00", "2026-11-25T10:00:00", "2026-02-30T10:00:00Z", "2026-11-25 10:00:00Z", "soon"] {
            assert!(SnoozeUntil::parse(refused).is_none(), "{refused}");
        }
    }

    #[test]
    fn keeps_the_saved_record_and_writes_it_back_as_it_was() {
        let mut saved = json!({ "threadSnoozes": { "a": LATER, "b": 7, "c": "soon" }, "draft": "" }).as_object().unwrap().clone();
        let snoozes = ThreadSnoozes::take_saved(&mut saved);
        assert_eq!(snoozes.saved(), json!({ "a": LATER }));
        assert!(!saved.contains_key(SAVED_KEY));
        assert_eq!(saved["draft"], "");
        assert_eq!(snoozes.published("a"), json!(LATER));
        assert_eq!(snoozes.published("b"), Value::Null);
    }

    #[test]
    fn a_snooze_ends_at_its_time() {
        let mut snoozes = ThreadSnoozes::default();
        snoozes.set("a", at("2026-11-25T10:00:00Z"));
        snoozes.set("b", at(LATER));
        assert!(!snoozes.expire("2026-11-25T09:59:59Z".parse().unwrap()));
        assert!(snoozes.expire("2026-11-25T10:00:00Z".parse().unwrap()));
        assert_eq!(snoozes.saved(), json!({ "b": LATER }));
        snoozes.set("b", None);
        assert_eq!(snoozes.saved(), json!({}));
    }

    #[test]
    fn a_request_wakes_the_thread_and_those_that_delegated_to_it() {
        let mut parent = thread("parent", "idle");
        let mut child = thread("child", "running");
        child.delegated_by = Some("parent".into());
        child.requests.push(json!({ "id": "r" }));
        let other = thread("other", "idle");
        let mut snoozes = ThreadSnoozes::default();
        for id in ["parent", "child", "other"] {
            snoozes.set(id, at(LATER));
        }
        assert!(snoozes.track(&[parent.clone(), child.clone(), other.clone()], &[project(None)]));
        assert_eq!(snoozes.saved(), json!({ "other": LATER }));

        // A settled thread stops the walk: the one that delegated to it stays snoozed.
        parent.workspace_settled_at = None;
        child.workspace_settled_at = Some("2026-11-25T09:00:00.000Z".into());
        snoozes.set("parent", at(LATER));
        snoozes.set("child", at(LATER));
        assert!(snoozes.track(&[parent, child], &[project(None)]));
        assert_eq!(snoozes.saved(), json!({ "other": LATER, "parent": LATER }));
    }

    #[test]
    fn an_unseen_failure_wakes_an_open_thread_only() {
        let failed = thread("failed", "error");
        let mut snoozes = ThreadSnoozes::default();
        snoozes.set("failed", at(LATER));
        // In a settled project the failure is quiet.
        assert!(!snoozes.track(std::slice::from_ref(&failed), &[project(Some("2026-11-25T09:00:00.000Z"))]));
        let mut seen = failed.clone();
        seen.extra.insert("failureSeen".into(), Value::Bool(true));
        assert!(!snoozes.track(&[seen], &[project(None)]));
        assert!(snoozes.track(&[failed], &[project(None)]));
        assert_eq!(snoozes.saved(), json!({}));
    }
}
