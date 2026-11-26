//! The failed threads some client has shown since they failed (ADR-0092), as Node's `FailuresSeen`
//! (`src/main/agents/failuresSeen.ts`) keeps them. A failed turn is attention until a client shows the thread or the
//! user presses Dismiss all; after that the row reads Done and the pane still says why the turn failed. The host owns
//! the record, so every client reads one answer and a restart keeps it.
//!
//! Every thread in error is published with the host's name for its failure (`failureId`), the failed turn's reason
//! (`failureReason`) and when the failure was named (`failureSince`), and with `failureSeen` once it is seen. A failure
//! ends once the thread works or rests again with its provider connected, so its next failure is news. A settled thread
//! has its failure seen too: settled is quiet.
//!
//! The record is `agents.json`'s `failuresSeen`, oldest first, so a host that rolls back to Node keeps every mark
//! (ADR-0214).

use std::collections::{HashMap, HashSet};

use chrono::DateTime;
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::thread_lifecycle::{failed_without_request, SettledIn};
use crate::workspace::{AgentProject, AgentThread, AgentThreadDetail};

/// The key of the record in `agents.json`.
pub const SAVED_KEY: &str = "failuresSeen";
/// How many marks are kept for threads gone from the host's list, newest last, as Node's `FAILURES_SEEN_MAX`.
pub const FAILURES_SEEN_MAX: usize = 200;
/// The longest reason published with a failure, as `failureReason` allows: 600 UTF-16 code units, as JavaScript counts.
const REASON_MAX: usize = 600;
/// The fields a thread carries for its failure, which only this record writes.
const PUBLISHED: [&str; 4] = ["failureId", "failureReason", "failureSince", "failureSeen"];

/// One failure of one thread. `id` is the host's own name for it, made when the record first sees the thread in error,
/// or in error on a different failed turn. `turn` is the provider's failed turn, once one is known.
#[derive(Debug, Clone)]
struct Failure {
    id: String,
    turn: Option<String>,
    seen: bool,
    reason: Option<String>,
    /// When the record named the failure, in milliseconds since the epoch; absent from marks Node saved before it kept it.
    since: Option<i64>,
    /// Where the failure stands among the others, oldest first, as a JavaScript `Map` keeps the order things were added.
    order: u64,
}

/// What the record reads the threads through: the host's threads and projects, each thread's activity records, and
/// whether a thread's provider is connected.
pub struct ThreadsView<'a> {
    pub threads: &'a [AgentThread],
    pub projects: &'a [AgentProject],
    pub details: &'a HashMap<String, AgentThreadDetail>,
    pub connected: &'a dyn Fn(&AgentThread) -> bool,
}

impl ThreadsView<'_> {
    fn activities<'b>(&'b self, thread: &'b AgentThread) -> &'b [Value] {
        self.details.get(&thread.id).map_or(thread.activities.as_slice(), |detail| detail.activities.as_slice())
    }
}

pub struct FailuresSeen {
    failures: HashMap<String, Failure>,
    next_order: u64,
    /// The threads some client shows now.
    shown: HashSet<String>,
    now: fn() -> i64,
}

impl Default for FailuresSeen {
    fn default() -> Self {
        Self { failures: HashMap::new(), next_order: 0, shown: HashSet::new(), now: || chrono::Utc::now().timestamp_millis() }
    }
}

impl FailuresSeen {
    /// Takes the saved marks out of `agents.json`'s other fields. A mark Node would not read is dropped, since Node would
    /// refuse the whole file over it. Nothing else is dropped until a list of threads says which are gone.
    pub fn take_saved(agents_json: &mut Map<String, Value>) -> Self {
        let mut record = Self::default();
        if let Some(Value::Array(saved)) = agents_json.remove(SAVED_KEY) {
            for mark in saved {
                let (Some(thread_id), Some(failure)) = (mark.get("threadId").and_then(Value::as_str), mark.get("failure").and_then(Value::as_str)) else {
                    continue;
                };
                let turn = match mark.get("turn") {
                    None => None,
                    Some(Value::String(turn)) => Some(turn.clone()),
                    Some(_) => continue,
                };
                let since = match mark.get("since") {
                    None => None,
                    Some(since) => match since.as_f64() {
                        Some(since) if since.is_finite() => Some(since as i64),
                        _ => continue,
                    },
                };
                record.failures.remove(thread_id);
                record.insert(thread_id, Failure { id: failure.to_string(), turn, seen: true, reason: None, since, order: 0 });
            }
        }
        record
    }

    /// The marks as `agents.json` keeps them: the seen ones, oldest first.
    pub fn saved(&self) -> Value {
        Value::Array(
            self.in_order()
                .into_iter()
                .filter(|(_, failure)| failure.seen)
                .map(|(thread_id, failure)| {
                    let mut mark = json!({ "threadId": thread_id, "failure": failure.id });
                    if let Some(turn) = &failure.turn {
                        mark["turn"] = json!(turn);
                    }
                    if let Some(since) = failure.since {
                        mark["since"] = json!(since);
                    }
                    mark
                })
                .collect(),
        )
    }

    /// Whether the thread's failure is seen.
    pub fn has(&self, thread_id: &str) -> bool {
        self.failures.get(thread_id).is_some_and(|failure| failure.seen)
    }

    /// Writes the thread's failure fields as clients read them: its failure's name, reason and when it was named while
    /// it stands in one, and `failureSeen` while that is seen. A thread that stands in none carries none of the four.
    pub fn publish(&self, thread_id: &str, thread: &mut Map<String, Value>) {
        for key in PUBLISHED {
            thread.remove(key);
        }
        let Some(failure) = self.failures.get(thread_id) else {
            return;
        };
        thread.insert("failureId".into(), json!(failure.id));
        if let Some(reason) = failure.reason.as_ref().filter(|reason| !reason.is_empty()) {
            thread.insert("failureReason".into(), json!(reason));
        }
        if let Some(since) = failure.since.and_then(DateTime::from_timestamp_millis) {
            thread.insert("failureSince".into(), json!(since.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)));
        }
        if failure.seen {
            thread.insert("failureSeen".into(), Value::Bool(true));
        }
    }

    /// Reads every thread; true when a saved mark was made, changed or dropped.
    pub fn track(&mut self, view: &ThreadsView<'_>) -> bool {
        let settled = SettledIn::new(view.projects);
        let mut changed = false;
        for thread in view.threads {
            changed |= self.read(view, thread, &settled);
        }
        // A failure nobody has seen is not saved, so one for a thread no longer listed has nothing left to say.
        let present: HashSet<&str> = view.threads.iter().map(|thread| thread.id.as_str()).collect();
        self.failures.retain(|id, failure| failure.seen || present.contains(id.as_str()));
        self.trim(&present);
        changed
    }

    /// The threads some client shows now: each that has failed is seen. True when a mark was made.
    pub fn show(&mut self, thread_ids: impl IntoIterator<Item = String>, view: &ThreadsView<'_>) -> bool {
        self.shown = thread_ids.into_iter().collect();
        let shown = self.shown.clone();
        self.see_all(view, |thread| shown.contains(&thread.id), |_, _| true)
    }

    /// Dismiss all: each named thread is seen, as if a client had shown it, when it still stands in the failure the
    /// client named. One that has failed again since the press is news the user has not seen. True when a mark was made.
    pub fn dismiss(&mut self, named: &HashMap<String, String>, view: &ThreadsView<'_>) -> bool {
        self.see_all(view, |thread| named.contains_key(&thread.id), |record, thread| {
            record.failures.get(&thread.id).map(|failure| &failure.id) == named.get(&thread.id)
        })
    }

    /// One thread read against its failure; true when a saved mark was made, changed or dropped.
    fn read(&mut self, view: &ThreadsView<'_>, thread: &AgentThread, settled: &SettledIn<'_>) -> bool {
        if thread.status == "error" {
            let activities = view.activities(thread);
            let mut changed = self.identify(thread, activities);
            self.record_reason(thread, activities);
            if self.shown.contains(&thread.id) || settled.settled(thread) {
                changed |= self.see(thread);
            }
            return changed;
        }
        let Some(seen) = self.failures.get(&thread.id).map(|failure| failure.seen) else {
            return false;
        };
        // A provider that disconnects says nothing new about the thread, so its failure stands.
        if !(view.connected)(thread) {
            return false;
        }
        self.failures.remove(&thread.id);
        seen
    }

    fn see_all(&mut self, view: &ThreadsView<'_>, named: impl Fn(&AgentThread) -> bool, still: impl Fn(&Self, &AgentThread) -> bool) -> bool {
        let mut changed = false;
        for thread in view.threads {
            if !named(thread) || thread.status != "error" {
                continue;
            }
            changed |= self.identify(thread, view.activities(thread));
            if still(self, thread) {
                changed |= self.see(thread);
            }
        }
        let present: HashSet<&str> = view.threads.iter().map(|thread| thread.id.as_str()).collect();
        self.trim(&present);
        changed
    }

    /// The failure a thread in error stands in, named when it is new: the thread was not in error before, or it is now
    /// in error on a different failed turn. A failure named with no turn takes the first failed turn named for it,
    /// unless that turn's record says it started after the failure was named: then it is a later turn that failed. True
    /// when a seen failure was replaced, or gained its turn, so the saved marks moved.
    fn identify(&mut self, thread: &AgentThread, activities: &[Value]) -> bool {
        let turn = thread.last_turn.as_ref().filter(|turn| turn.status == "failed").map(|turn| turn.id.clone());
        let known = self.failures.get(&thread.id);
        let later = known.is_some_and(|known| known.turn.is_none())
            && turn.is_some()
            && started_after(thread, activities, known.and_then(|known| known.since));
        if let Some(known) = self.failures.get_mut(&thread.id) {
            if !later && (turn.is_none() || known.turn.is_none() || known.turn == turn) {
                if turn.is_none() || known.turn.is_some() {
                    return false;
                }
                known.turn = turn;
                return known.seen;
            }
        }
        let was_seen = self.failures.remove(&thread.id).is_some_and(|known| known.seen);
        let since = (self.now)();
        self.insert(&thread.id, Failure { id: Uuid::new_v4().to_string(), turn, seen: false, reason: None, since: Some(since), order: 0 });
        was_seen
    }

    /// Keeps the failed turn's reason with its failure; a thread whose records name none leaves what was read before.
    fn record_reason(&mut self, thread: &AgentThread, activities: &[Value]) {
        let Some(reason) = failed_turn_reason(thread, activities) else {
            return;
        };
        if let Some(failure) = self.failures.get_mut(&thread.id) {
            failure.reason = Some(within_utf16(reason, REASON_MAX).to_string());
        }
    }

    fn see(&mut self, thread: &AgentThread) -> bool {
        match self.failures.get_mut(&thread.id) {
            Some(failure) if !failure.seen && failed_without_request(thread) => {
                failure.seen = true;
                true
            }
            _ => false,
        }
    }

    /// Drops the oldest marks of threads gone from the list past the limit; listed threads' marks stay whole.
    fn trim(&mut self, present: &HashSet<&str>) {
        let gone: Vec<String> = self
            .in_order()
            .into_iter()
            .filter(|(id, _)| !present.contains(id.as_str()))
            .map(|(id, _)| id.clone())
            .collect();
        for id in gone.iter().take(gone.len().saturating_sub(FAILURES_SEEN_MAX)) {
            self.failures.remove(id);
        }
    }

    fn insert(&mut self, thread_id: &str, mut failure: Failure) {
        failure.order = self.next_order;
        self.next_order += 1;
        self.failures.insert(thread_id.to_string(), failure);
    }

    fn in_order(&self) -> Vec<(&String, &Failure)> {
        let mut all: Vec<(&String, &Failure)> = self.failures.iter().collect();
        all.sort_by_key(|(_, failure)| failure.order);
        all
    }
}

/// The record of the thread's last turn: the one its provider names, otherwise the newest turn record, as Node's
/// `lastTurnRecord`.
fn last_turn_record<'a>(thread: &AgentThread, activities: &'a [Value]) -> Option<&'a Value> {
    let anchor = thread.last_turn.as_ref().map(|turn| turn.message_id.as_deref().unwrap_or(&turn.id));
    let mut last = None;
    for record in activities.iter().rev() {
        if record.get("kind").and_then(Value::as_str) != Some("turn") {
            continue;
        }
        if anchor.is_none() || record.get("turnId").and_then(Value::as_str) == anchor {
            return Some(record);
        }
        last = last.or(Some(record));
    }
    last
}

/// The reason the thread's last turn failed, as its turn record says, as Node's `failedTurnReason`.
fn failed_turn_reason<'a>(thread: &AgentThread, activities: &'a [Value]) -> Option<&'a str> {
    let record = last_turn_record(thread, activities)?;
    if record.get("status").and_then(Value::as_str) != Some("failed") {
        return None;
    }
    record.get("error").and_then(Value::as_str).filter(|error| !error.is_empty())
}

/// The longest start of `text` that is at most `max` UTF-16 code units, as JavaScript's `slice(0, max)` keeps, except that
/// a character is never cut in half.
fn within_utf16(text: &str, max: usize) -> &str {
    let mut units = 0;
    for (at, character) in text.char_indices() {
        units += character.len_utf16();
        if units > max {
            return &text[..at];
        }
    }
    text
}

/// Whether the thread's last turn record says it started after `since`; unknown either way reads as not.
fn started_after(thread: &AgentThread, activities: &[Value], since: Option<i64>) -> bool {
    let started = last_turn_record(thread, activities)
        .and_then(|record| record.get("startedAt"))
        .and_then(Value::as_str)
        .and_then(|started| DateTime::parse_from_rfc3339(started).ok());
    matches!((since, started), (Some(since), Some(started)) if started.timestamp_millis() > since)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn thread(id: &str, status: &str, failed_turn: Option<&str>) -> AgentThread {
        let mut value = json!({ "id": id, "projectId": "p", "title": id, "status": status, "providerId": "codex" });
        if let Some(turn) = failed_turn {
            value["lastTurn"] = json!({ "id": turn, "status": "failed" });
        }
        serde_json::from_value(value).unwrap()
    }

    fn project(settled: Option<&str>) -> AgentProject {
        serde_json::from_value(json!({ "id": "p", "title": "P", "path": "/p", "workspaceSettledAt": settled })).unwrap()
    }

    fn turn_record(turn: &str, error: &str, started: &str) -> Value {
        json!({ "id": format!("act-{turn}"), "kind": "turn", "turnId": turn, "status": "failed", "error": error, "startedAt": started })
    }

    struct World {
        threads: Vec<AgentThread>,
        projects: Vec<AgentProject>,
        details: HashMap<String, AgentThreadDetail>,
        connected: bool,
    }

    impl World {
        fn new(threads: Vec<AgentThread>) -> Self {
            Self { threads, projects: vec![project(None)], details: HashMap::new(), connected: true }
        }
        fn activities(&mut self, thread_id: &str, activities: Vec<Value>) {
            self.details.insert(thread_id.into(), AgentThreadDetail { thread_id: thread_id.into(), revision: 1, messages: Vec::new(), activities, earlier_available: None });
        }
        fn with<T>(&self, run: impl FnOnce(&ThreadsView<'_>) -> T) -> T {
            let connected = self.connected;
            let is_connected = move |_: &AgentThread| connected;
            run(&ThreadsView { threads: &self.threads, projects: &self.projects, details: &self.details, connected: &is_connected })
        }
    }

    fn published(record: &FailuresSeen, thread_id: &str) -> Map<String, Value> {
        let mut thread = Map::new();
        thread.insert("failureSeen".into(), Value::Bool(true));
        record.publish(thread_id, &mut thread);
        thread
    }

    #[test]
    fn names_a_failure_with_its_reason_and_sees_it_when_shown() {
        let mut world = World::new(vec![thread("a", "error", Some("t1"))]);
        world.activities("a", vec![turn_record("t1", "The model refused.", "2026-11-25T10:00:00.000Z")]);
        let mut record = FailuresSeen::default();
        assert!(!world.with(|view| record.track(view)), "an unseen failure saves nothing");
        let thread = published(&record, "a");
        assert!(thread["failureId"].is_string());
        assert_eq!(thread["failureReason"], "The model refused.");
        assert!(thread["failureSince"].is_string());
        assert!(!thread.contains_key("failureSeen"), "a failure no client showed is not seen, whatever the record said");
        assert_eq!(record.saved(), json!([]));

        assert!(world.with(|view| record.show(["a".to_string()], view)));
        assert_eq!(published(&record, "a")["failureSeen"], true);
        assert_eq!(record.saved(), json!([{ "threadId": "a", "failure": thread["failureId"], "turn": "t1", "since": record.failures["a"].since }]));
    }

    #[test]
    fn a_new_failed_turn_is_news_and_a_working_thread_ends_its_failure() {
        let mut world = World::new(vec![thread("a", "error", Some("t1"))]);
        let mut record = FailuresSeen::default();
        world.with(|view| record.show(["a".to_string()], view));
        let first = published(&record, "a")["failureId"].clone();
        // Shown no more, the thread fails again on another turn: a new failure, not seen.
        world.with(|view| record.show(Vec::new(), view));
        world.threads[0] = thread("a", "error", Some("t2"));
        assert!(world.with(|view| record.track(view)), "the seen mark went");
        assert_ne!(published(&record, "a")["failureId"], first);
        assert!(!record.has("a"));

        // A provider that disconnects says nothing new; one connected with the thread at rest ends the failure.
        world.threads[0] = thread("a", "idle", None);
        world.connected = false;
        world.with(|view| record.track(view));
        assert!(published(&record, "a").contains_key("failureId"));
        world.connected = true;
        world.with(|view| record.track(view));
        assert!(published(&record, "a").is_empty());
    }

    #[test]
    fn a_failure_first_named_without_its_turn_takes_the_turn_unless_it_started_later() {
        let mut world = World::new(vec![thread("a", "error", None)]);
        let mut record = FailuresSeen { now: || DateTime::parse_from_rfc3339("2026-11-25T10:00:00Z").unwrap().timestamp_millis(), ..FailuresSeen::default() };
        world.with(|view| record.show(["a".to_string()], view));
        let id = published(&record, "a")["failureId"].clone();
        // History names the turn that failed before the failure was named: the same failure, now with its turn.
        world.threads[0] = thread("a", "error", Some("t1"));
        world.activities("a", vec![turn_record("t1", "Lost.", "2026-11-25T09:59:00.000Z")]);
        assert!(world.with(|view| record.track(view)));
        assert_eq!(published(&record, "a")["failureId"], id);
        assert_eq!(record.failures["a"].turn.as_deref(), Some("t1"));

        // A turn that started after a failure with no turn was named is a later failure.
        let mut record = FailuresSeen { now: || DateTime::parse_from_rfc3339("2026-11-25T10:00:00Z").unwrap().timestamp_millis(), ..FailuresSeen::default() };
        world.threads[0] = thread("a", "error", None);
        world.with(|view| record.show(["a".to_string()], view));
        let id = published(&record, "a")["failureId"].clone();
        world.with(|view| record.show(Vec::new(), view));
        world.threads[0] = thread("a", "error", Some("t9"));
        world.activities("a", vec![turn_record("t9", "Again.", "2026-11-25T10:05:00.000Z")]);
        world.with(|view| record.track(view));
        assert_ne!(published(&record, "a")["failureId"], id);
    }

    #[test]
    fn dismiss_sees_only_the_failure_the_row_showed_and_never_a_waiting_thread() {
        let mut asking = thread("b", "error", Some("t1"));
        asking.requests.push(json!({ "id": "r" }));
        let world = World::new(vec![thread("a", "error", Some("t1")), asking]);
        let mut record = FailuresSeen::default();
        world.with(|view| record.track(view));
        let named: HashMap<String, String> = [("a".to_string(), "not-this-one".to_string())].into();
        assert!(!world.with(|view| record.dismiss(&named, view)), "a failure the row did not show stays news");
        let shown = published(&record, "a")["failureId"].as_str().unwrap().to_string();
        let named: HashMap<String, String> = [("a".to_string(), shown), ("b".to_string(), published(&record, "b")["failureId"].as_str().unwrap().to_string())].into();
        assert!(world.with(|view| record.dismiss(&named, view)));
        assert!(record.has("a"));
        assert!(!record.has("b"), "a thread that asks the user something is the user's to answer");
    }

    #[test]
    fn a_reason_is_cut_to_what_node_allows_in_utf_16() {
        assert_eq!(within_utf16("abc", 2), "ab");
        // Each of these takes two UTF-16 code units, so 600 units hold 300 of them and never half of one.
        let wide = "\u{1F600}".repeat(400);
        assert_eq!(within_utf16(&wide, REASON_MAX).encode_utf16().count(), 600);
        assert_eq!(within_utf16(&format!("a{wide}"), REASON_MAX).encode_utf16().count(), 599);
    }

    #[test]
    fn a_settled_thread_has_its_failure_seen() {
        let mut world = World::new(vec![thread("a", "error", Some("t1"))]);
        world.projects = vec![project(Some("2026-11-25T09:00:00.000Z"))];
        let mut record = FailuresSeen::default();
        assert!(world.with(|view| record.track(view)));
        assert!(record.has("a"));
    }

    #[test]
    fn keeps_the_saved_record_and_trims_only_threads_that_are_gone() {
        let mut saved = json!({ SAVED_KEY: [
            { "threadId": "a", "failure": "f-a", "turn": "t1", "since": 1_700_000_000_000_i64 },
            { "threadId": "b", "failure": "f-b" },
            { "threadId": "c", "failure": 7 },
        ] }).as_object().unwrap().clone();
        let mut record = FailuresSeen::take_saved(&mut saved);
        assert!(!saved.contains_key(SAVED_KEY));
        assert_eq!(record.saved(), json!([{ "threadId": "a", "failure": "f-a", "turn": "t1", "since": 1_700_000_000_000_i64 }, { "threadId": "b", "failure": "f-b" }]));

        for index in 0..FAILURES_SEEN_MAX + 5 {
            record.insert(&format!("gone-{index}"), Failure { id: format!("f{index}"), turn: None, seen: true, reason: None, since: None, order: 0 });
        }
        let world = World::new(vec![thread("a", "error", Some("t1"))]);
        world.with(|view| record.track(view));
        let kept = record.saved();
        let ids: Vec<&str> = kept.as_array().unwrap().iter().map(|mark| mark["threadId"].as_str().unwrap()).collect();
        assert_eq!(ids.len(), FAILURES_SEEN_MAX + 1, "the listed thread's mark and the newest of the gone ones");
        assert_eq!(ids[0], "a");
        assert!(!ids.contains(&"b") && !ids.contains(&"gone-4") && ids.contains(&"gone-5"));
    }
}
