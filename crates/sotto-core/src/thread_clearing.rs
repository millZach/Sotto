//! Deleting a settled thread (ADR-0140), as Node's host does it: why one is kept back (`threadClearHold` in
//! `src/main/agents/threadClearing.ts`, and the workspace's own `deletionHold` in `src/main/agents/workspace.ts`), what a
//! deleted thread's neighbours lose (`unlinkedFrom`), and how the words of its history are taken out
//! (`redactedPayload` and the identity hashes in `src/main/agents/threadStore.ts` and `subagentStore.ts`).

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde_json::{json, Map, Value};

use crate::thread_lifecycle::has_time;
use crate::workspace::{sha256_hex, AgentProject, AgentThread};

/// How deep delegation goes, as Node's `DELEGATION_LEVELS_MAX` (`src/shared/delegation.ts`).
const DELEGATION_LEVELS_MAX: usize = 2;
/// The longest thread ID Node's command schema reads (`id` in `src/shared/agents.ts`), in UTF-16 code units.
const THREAD_ID_MAX: usize = 512;
/// The most confirmed ignored items or item folders, and nested repositories, Node's command schema reads
/// (`WORKTREE_CONFIRMED_ITEMS_MAX`, `WORKTREE_CONFIRMED_REPOSITORIES_MAX` in `src/shared/agents.ts`).
const WORKTREE_CONFIRMED_ITEMS_MAX: usize = 10_000;
const WORKTREE_CONFIRMED_REPOSITORIES_MAX: usize = 1_000;

/// Whether a JSON number is a whole number at or above `min`, as zod's `int()` with `nonnegative()` or `positive()`.
fn whole_at_least(value: Option<&Value>, min: f64) -> bool {
    value.and_then(Value::as_f64).is_some_and(|n| n.fract() == 0.0 && n >= min && n.abs() <= 9_007_199_254_740_991.0)
}

/// Whether an object holds only `keys`, as a strict zod object reads it.
fn only_keys(object: &Map<String, Value>, keys: &[&str]) -> bool {
    object.keys().all(|key| keys.contains(&key.as_str()))
}

/// Whether one of Delete thread…'s confirmation lists, if it is there, is what Node's `worktreeConfirmations` schema
/// reads: at most `max` items, each as `item` says.
fn confirmation_list(command: &Map<String, Value>, key: &str, max: usize, item: impl Fn(&Value) -> bool) -> bool {
    match command.get(key) {
        None => true,
        Some(Value::Array(items)) => items.len() <= max && items.iter().all(item),
        Some(_) => false,
    }
}

/// Whether a `preview-delete-thread` or `delete-thread` command is one Node's strict command schema reads
/// (`agentCommandSchema` in `src/shared/agents.ts`, which `commandFromProtocolV1` parses before any refusal): only its
/// own fields, a thread ID, and for a delete the confirmations of what goes with a worktree folder (ADR-0041), each
/// optional and limited as Node limits it.
pub fn delete_command_shape(command: &Map<String, Value>) -> bool {
    let kind = command.get("type").and_then(Value::as_str);
    let fields: &[&str] = match kind {
        Some("preview-delete-thread") => &["type", "threadId"],
        Some("delete-thread") => &["type", "threadId", "confirmedIgnored", "confirmedItems", "confirmedRepositories"],
        _ => return false,
    };
    let thread_id = command.get("threadId").and_then(Value::as_str).is_some_and(|id| !id.is_empty() && id.encode_utf16().count() <= THREAD_ID_MAX);
    if !only_keys(command, fields) || !thread_id {
        return false;
    }
    confirmation_list(command, "confirmedIgnored", WORKTREE_CONFIRMED_ITEMS_MAX, Value::is_string)
        && confirmation_list(command, "confirmedItems", WORKTREE_CONFIRMED_ITEMS_MAX, |item| {
            item.as_object().is_some_and(|o| only_keys(o, &["path", "fileCount"]) && o.get("path").is_some_and(Value::is_string) && whole_at_least(o.get("fileCount"), 0.0))
        })
        && confirmation_list(command, "confirmedRepositories", WORKTREE_CONFIRMED_REPOSITORIES_MAX, |item| {
            item.as_object().is_some_and(|o| {
                only_keys(o, &["path", "changeCount", "unpushedCommitCount", "kind", "fetchedByHash"])
                    && o.get("path").is_some_and(Value::is_string)
                    && whole_at_least(o.get("changeCount"), 0.0)
                    && o.get("unpushedCommitCount").is_none_or(|n| whole_at_least(Some(n), 0.0))
                    && matches!(o.get("kind").and_then(Value::as_str), Some("worktree" | "repository"))
                    && o.get("fetchedByHash").is_none_or(|fetched| {
                        fetched.as_object().is_some_and(|f| only_keys(f, &["remote", "commitCount"]) && f.get("remote").is_some_and(Value::is_string) && whole_at_least(f.get("commitCount"), 1.0))
                    })
            })
        })
}

/// Why a settled thread is kept back (ADR-0140 decision 3), as Node's `THREAD_CLEAR_KEPT_REASONS`
/// (`src/shared/threadClear.ts`): a code a client words and the log names as it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeptReason {
    Working,
    WaitingOnYou,
    Queued,
    PullRequest,
    DelegatedWorking,
    Babysitting,
    Watched,
    Uncommitted,
    WorktreeFiles,
    WorktreeInUse,
    WorktreeError,
    NotSettled,
    Hidden,
}

impl KeptReason {
    /// The reason's code, as a client and the log read it.
    pub fn code(self) -> &'static str {
        match self {
            Self::Working => "working",
            Self::WaitingOnYou => "waiting-on-you",
            Self::Queued => "queued",
            Self::PullRequest => "pull-request",
            Self::DelegatedWorking => "delegated-working",
            Self::Babysitting => "babysitting",
            Self::Watched => "watched",
            Self::Uncommitted => "uncommitted",
            Self::WorktreeFiles => "worktree-files",
            Self::WorktreeInUse => "worktree-in-use",
            Self::WorktreeError => "worktree-error",
            Self::NotSettled => "not-settled",
            Self::Hidden => "hidden",
        }
    }

    /// Why it is kept, as a short lower-case clause that reads after its title, as Node's `threadClearKeptWords`.
    pub fn words(self) -> &'static str {
        match self {
            Self::Working => "still working",
            Self::WaitingOnYou => "waiting on you",
            Self::Queued => "something is queued for it",
            Self::PullRequest => "pull request still open",
            Self::DelegatedWorking => "a thread it delegated to is still working",
            Self::Babysitting => "being babysat",
            Self::Watched => "Watcher is watching it",
            Self::Uncommitted => "uncommitted changes in its worktree",
            Self::WorktreeFiles => "its worktree holds files Git ignores; delete it on its own to review them",
            Self::WorktreeInUse => "its worktree is in use",
            Self::WorktreeError => "its worktree could not be removed; delete it on its own to see why",
            Self::NotSettled => "not settled",
            Self::Hidden => "hidden",
        }
    }
}

/// What the clearing check needs of the coordinator beside a thread's record, made once for a check, as Node's
/// `ThreadClearFacts`. This host hides no thread (it holds no Owl gate back), and Restart stopped threads, sent to stable,
/// has retired babysitting on Node's host (ADR-0144), so a babysat pull request holds nothing back here either.
pub struct ClearFacts<'a> {
    pub threads: &'a [AgentThread],
    pub projects: &'a [AgentProject],
    /// Something is queued or on its way for the thread, or an action of its has an unknown result.
    pub pending: &'a dyn Fn(&str) -> bool,
    /// The threads Watcher watches on this host.
    pub watched: &'a HashSet<String>,
}

fn extra_status(thread: &AgentThread, key: &str) -> Option<String> {
    thread.extra.get(key).and_then(|value| value.get("status")).and_then(Value::as_str).map(ToString::to_string)
}

fn non_empty_list(thread: &AgentThread, key: &str) -> bool {
    thread.extra.get(key).and_then(Value::as_array).is_some_and(|list| !list.is_empty())
}

/// Work the thread is doing now: a turn, a compaction, background work, monitoring or working sub-agents, or a Git
/// action, as Node's `working`.
fn working(thread: &AgentThread) -> bool {
    thread.status == "running"
        || thread.last_turn.as_ref().is_some_and(|turn| turn.status == "running")
        || extra_status(thread, "compaction").as_deref() == Some("running")
        || non_empty_list(thread, "backgroundWork")
        || non_empty_list(thread, "monitoring")
        || thread.extra.get("subagentSummary").and_then(|summary| summary.get("working")).is_some_and(truthy)
        || extra_status(thread, "gitAction").as_deref() == Some("running")
}

/// A JavaScript value read as JavaScript's `Boolean` reads it.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn compaction_uncertain(thread: &AgentThread) -> bool {
    extra_status(thread, "compaction").as_deref() == Some("uncertain")
}

/// A pull request of the thread's that is still open: one it linked, or its branch's own, as Node's `openPullRequest`.
fn open_pull_request(thread: &AgentThread) -> bool {
    let linked = thread
        .extra
        .get("pullRequests")
        .and_then(Value::as_array)
        .is_some_and(|list| list.iter().any(|pull| pull.get("state").and_then(Value::as_str) == Some("open")));
    let own = thread
        .worktree
        .as_ref()
        .and_then(|worktree| worktree.git.as_ref())
        .and_then(|git| git.get("pullRequest"))
        .and_then(|pull| pull.get("state"))
        .and_then(Value::as_str)
        == Some("open");
    linked || own
}

/// Every thread below `thread_id` that it delegated to, at both levels, as Node's `delegatedThreadsBelow`.
pub fn delegated_threads_below(threads: &[AgentThread], thread_id: &str) -> Vec<String> {
    let mut children: HashMap<&str, Vec<&str>> = HashMap::new();
    for thread in threads {
        if let Some(parent) = thread.delegated_by.as_deref().filter(|parent| !parent.is_empty()) {
            children.entry(parent).or_default().push(thread.id.as_str());
        }
    }
    let mut below = Vec::new();
    let mut seen: HashSet<&str> = HashSet::from([thread_id]);
    let mut level: Vec<&str> = children.get(thread_id).cloned().unwrap_or_default();
    let mut depth = 0;
    while depth < DELEGATION_LEVELS_MAX && !level.is_empty() {
        let mut next = Vec::new();
        for child in level {
            if seen.insert(child) {
                below.push(child.to_string());
                next.extend(children.get(child).cloned().unwrap_or_default());
            }
        }
        level = next;
        depth += 1;
    }
    below
}

fn workspace_settled(thread: &AgentThread, projects: &[AgentProject]) -> bool {
    has_time(thread.workspace_settled_at.as_deref())
        || projects.iter().find(|project| project.id == thread.project_id).is_some_and(|project| has_time(project.workspace_settled_at.as_deref()))
}

/// Why the coordinator keeps a thread back from clearing, or `None`, in Node's order (`threadClearHold`): gone or
/// Watcher's own, not settled, waiting on the user, working, something queued or unknown, an open pull request of its own
/// or of a thread it delegated to, a delegated thread not at rest, or watched.
pub fn clear_hold(thread: Option<&AgentThread>, facts: &ClearFacts<'_>) -> Option<KeptReason> {
    let Some(thread) = thread.filter(|thread| !matches!(thread.kind.as_deref(), Some("watcher" | "watcher-history"))) else {
        return Some(KeptReason::Hidden);
    };
    if !workspace_settled(thread, facts.projects) {
        return Some(KeptReason::NotSettled);
    }
    // A question or a permission holds its turn running, so it is named first: what the thread needs is you.
    if !thread.requests.is_empty() {
        return Some(KeptReason::WaitingOnYou);
    }
    if working(thread) {
        return Some(KeptReason::Working);
    }
    if (facts.pending)(&thread.id) || compaction_uncertain(thread) {
        return Some(KeptReason::Queued);
    }
    let delegator = facts.threads.iter().any(|other| other.delegated_by.as_deref() == Some(thread.id.as_str()));
    let below: Vec<&AgentThread> = if delegator {
        delegated_threads_below(facts.threads, &thread.id)
            .iter()
            .filter_map(|id| facts.threads.iter().find(|item| &item.id == id))
            .collect()
    } else {
        Vec::new()
    };
    if open_pull_request(thread) || below.iter().any(|item| open_pull_request(item)) {
        return Some(KeptReason::PullRequest);
    }
    if below.iter().any(|item| working(item) || !item.requests.is_empty() || (facts.pending)(&item.id) || compaction_uncertain(item)) {
        return Some(KeptReason::DelegatedWorking);
    }
    if facts.watched.contains(&thread.id) {
        return Some(KeptReason::Watched);
    }
    None
}

/// What the workspace itself keeps a thread back for as it deletes it, as Node's `deletionHold`: a request, or work.
pub fn deletion_hold(thread: &AgentThread) -> Option<KeptReason> {
    if !thread.requests.is_empty() {
        return Some(KeptReason::WaitingOnYou);
    }
    working(thread).then_some(KeptReason::Working)
}

/// The thread's own worktree folder, when it has one on the disk to remove: never a shared checkout or a reused folder,
/// as Node's `ownWorktreeToRemove`.
pub fn own_worktree(thread: &AgentThread) -> Option<&str> {
    let worktree = thread.worktree.as_ref().filter(|worktree| worktree.mode == "independent")?;
    if worktree.reused == Some(true) || worktree.reclaimed() {
        return None;
    }
    worktree.path.as_deref().filter(|path| !path.is_empty() && Path::new(path).exists())
}

/// Takes a deleted thread's links out of another thread, as Node's `unlinkedFrom`: who delegated to it, what it was
/// continued from or started from, and where it was continued. True when anything went.
pub fn unlink_from(thread: &mut AgentThread, gone: &HashSet<String>) -> bool {
    let named = |value: Option<&Value>| value.and_then(|v| v.get("threadId")).and_then(Value::as_str).is_some_and(|id| gone.contains(id));
    let mut changed = false;
    if thread.delegated_by.as_ref().is_some_and(|parent| gone.contains(parent)) {
        thread.delegated_by = None;
        changed = true;
    }
    for key in ["continuedFrom", "startedFrom"] {
        if named(thread.extra.get(key)) {
            thread.extra.remove(key);
            changed = true;
        }
    }
    if let Some(Value::Array(into)) = thread.extra.get_mut("continuedIn") {
        if into.iter().any(|item| named(Some(item))) {
            into.retain(|item| !named(Some(item)));
            if into.is_empty() {
                thread.extra.remove("continuedIn");
            }
            changed = true;
        }
    }
    changed
}

/// An event's payload with its words taken out, or `None` for one that holds none, as Node's `redactedPayload`.
pub fn redacted_payload(payload: &str) -> Option<String> {
    let mut event: Map<String, Value> = serde_json::from_str(payload).ok()?;
    let kind = event.get("kind").and_then(Value::as_str)?.to_string();
    // As `JSON.stringify` writes an object: a field the event did not have is left out, not written as null.
    let copied = |from: &Map<String, Value>, into: &mut Map<String, Value>, keys: &[&str]| {
        for key in keys {
            if let Some(value) = from.get(*key) {
                into.insert((*key).into(), value.clone());
            }
        }
    };
    let mut redacted = Map::new();
    redacted.insert("kind".into(), Value::String(kind.clone()));
    copied(&event, &mut redacted, &["at"]);
    match kind.as_str() {
        "message-added" | "message-replaced" => {
            redacted.insert("redacted".into(), Value::Bool(true));
            let mut message = Map::new();
            if let Some(Value::Object(original)) = event.get("message") {
                copied(original, &mut message, &["id", "role", "createdAt"]);
            }
            message.insert("text".into(), Value::String(String::new()));
            redacted.insert("message".into(), Value::Object(message));
        }
        "message-text-appended" => {
            redacted.insert("redacted".into(), Value::Bool(true));
            copied(&event, &mut redacted, &["messageId"]);
            redacted.insert("appendText".into(), Value::String(String::new()));
        }
        // Option IDs can be the provider's labels, so they are words too.
        "answer-given" => {
            event.remove("questionOptionIds");
            event.insert("answer".into(), Value::String(String::new()));
            redacted = event;
        }
        _ => return None,
    }
    Some(Value::Object(redacted).to_string())
}

/// The identity of one of a thread's activities, remembered as erased, as Node's `activityIdentityHash`: the thread ID's
/// length in UTF-16 code units, a colon, the thread ID and the activity ID.
pub fn activity_identity_hash(thread_id: &str, activity_id: &str) -> String {
    sha256_hex(format!("{}:{thread_id}{activity_id}", thread_id.encode_utf16().count()).as_bytes())
}

/// The identity of a sub-agent, or one of its assignments, remembered as erased, as Node's `privacyIdentity`.
pub fn subagent_identity(thread_id: &str, agent_id: &str, assignment_id: Option<&str>) -> String {
    sha256_hex(json!([thread_id, agent_id, assignment_id]).to_string().as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SETTLED: &str = "2026-11-20T10:00:00.000Z";

    fn thread(fields: Value) -> AgentThread {
        let mut value = json!({ "id": "t", "projectId": "p", "title": "T", "status": "idle", "workspaceSettledAt": SETTLED });
        value.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());
        serde_json::from_value(value).unwrap()
    }

    fn project(fields: Value) -> AgentProject {
        let mut value = json!({ "id": "p", "title": "P", "path": "/p" });
        value.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());
        serde_json::from_value(value).unwrap()
    }

    fn held(threads: &[AgentThread], projects: &[AgentProject], pending: &[&str], watched: &[&str], id: &str) -> Option<&'static str> {
        let pending = |thread_id: &str| pending.contains(&thread_id);
        let watched: HashSet<String> = watched.iter().map(ToString::to_string).collect();
        let facts = ClearFacts { threads, projects, pending: &pending, watched: &watched };
        clear_hold(threads.iter().find(|t| t.id == id), &facts).map(KeptReason::code)
    }

    /// Node's `threadClearHold`, reason by reason in its order: each later reason shows only once the earlier ones pass.
    #[test]
    fn keeps_a_thread_back_for_nodes_reasons_in_nodes_order() {
        let none: &[AgentProject] = &[];
        let one = |fields: Value| vec![thread(fields)];
        assert_eq!(held(&[], none, &[], &[], "t"), Some("hidden"), "a thread that is not there");
        assert_eq!(held(&one(json!({ "kind": "watcher" })), none, &[], &[], "t"), Some("hidden"), "Watcher's own");
        assert_eq!(held(&one(json!({ "workspaceSettledAt": null })), none, &[], &[], "t"), Some("not-settled"));
        let in_settled_project = vec![thread(json!({ "workspaceSettledAt": null }))];
        assert_eq!(held(&in_settled_project, &[project(json!({ "workspaceSettledAt": SETTLED }))], &[], &[], "t"), None, "its project's settle counts");
        assert_eq!(held(&one(json!({ "status": "running", "requests": [{ "id": "r" }] })), none, &[], &[], "t"), Some("waiting-on-you"), "a request is named before work");
        for working in [json!({ "status": "running" }), json!({ "lastTurn": { "id": "u", "status": "running" } }), json!({ "compaction": { "status": "running" } }),
            json!({ "backgroundWork": [{}] }), json!({ "monitoring": [{}] }), json!({ "subagentSummary": { "working": 1 } }), json!({ "gitAction": { "status": "running" } })] {
            assert_eq!(held(&one(working.clone()), none, &[], &[], "t"), Some("working"), "{working}");
        }
        assert_eq!(held(&one(json!({ "subagentSummary": { "working": 0 } })), none, &[], &[], "t"), None, "no working sub-agents");
        assert_eq!(held(&one(json!({})), none, &["t"], &[], "t"), Some("queued"));
        assert_eq!(held(&one(json!({ "compaction": { "status": "uncertain" } })), none, &[], &[], "t"), Some("queued"));
        assert_eq!(held(&one(json!({ "pullRequests": [{ "state": "open" }] })), none, &[], &[], "t"), Some("pull-request"));
        assert_eq!(held(&one(json!({ "worktree": { "mode": "independent", "git": { "pullRequest": { "state": "open" } } } })), none, &[], &[], "t"), Some("pull-request"));
        assert_eq!(held(&one(json!({ "pullRequests": [{ "state": "merged" }] })), none, &[], &[], "t"), None);
        let child = |fields: Value| {
            let mut value = json!({ "id": "c", "delegatedBy": "t" });
            value.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());
            thread(value)
        };
        let family = |fields: Value| vec![thread(json!({})), child(fields)];
        assert_eq!(held(&family(json!({ "pullRequests": [{ "state": "open" }] })), none, &[], &[], "t"), Some("pull-request"), "a delegated thread's pull request");
        assert_eq!(held(&family(json!({ "status": "running" })), none, &[], &[], "t"), Some("delegated-working"));
        assert_eq!(held(&family(json!({ "requests": [{ "id": "r" }] })), none, &[], &[], "t"), Some("delegated-working"));
        assert_eq!(held(&family(json!({})), none, &["c"], &[], "t"), Some("delegated-working"));
        assert_eq!(held(&family(json!({})), none, &[], &[], "t"), None, "a delegated thread at rest holds nothing");
        assert_eq!(held(&one(json!({ "babysitting": [{ "url": "u" }] })), none, &[], &[], "t"), None, "babysitting is retired, as Restart stopped threads retires it");
        assert_eq!(held(&one(json!({})), none, &[], &["t"], "t"), Some("watched"));
        assert_eq!(held(&one(json!({})), none, &[], &[], "t"), None);
    }

    /// Node's `delegatedThreadsBelow`: two levels down, and no further.
    #[test]
    fn finds_delegated_threads_two_levels_down() {
        let threads: Vec<AgentThread> = [("a", None), ("b", Some("a")), ("c", Some("b")), ("d", Some("c")), ("e", Some("a"))]
            .into_iter()
            .map(|(id, parent)| thread(json!({ "id": id, "delegatedBy": parent })))
            .collect();
        assert_eq!(delegated_threads_below(&threads, "a"), ["b", "e", "c"]);
        assert!(delegated_threads_below(&threads, "d").is_empty());
    }

    /// The workspace's own check as it deletes, as Node's `deletionHold`.
    #[test]
    fn the_workspace_keeps_a_thread_with_a_request_or_work() {
        assert_eq!(deletion_hold(&thread(json!({ "requests": [{ "id": "r" }] }))), Some(KeptReason::WaitingOnYou));
        assert_eq!(deletion_hold(&thread(json!({ "backgroundWork": [{}] }))), Some(KeptReason::Working));
        assert_eq!(deletion_hold(&thread(json!({ "workspaceSettledAt": null }))), None, "settling is the coordinator's check");
    }

    /// Only a thread's own worktree folder on the disk is its to remove, as Node's `ownWorktreeToRemove`.
    #[test]
    fn names_only_a_threads_own_worktree_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();
        let worktree = |fields: Value| {
            let mut value = json!({ "mode": "independent", "path": path });
            value.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());
            thread(json!({ "worktree": value }))
        };
        assert_eq!(own_worktree(&worktree(json!({}))), Some(path.as_str()));
        assert_eq!(own_worktree(&worktree(json!({ "mode": "shared" }))), None);
        assert_eq!(own_worktree(&worktree(json!({ "reused": true }))), None);
        assert_eq!(own_worktree(&worktree(json!({ "reclaimedAt": SETTLED }))), None);
        assert_eq!(own_worktree(&worktree(json!({ "path": dir.path().join("gone").to_string_lossy() }))), None);
    }

    /// Other threads lose only their links to a deleted one, as Node's `unlinkedFrom`.
    #[test]
    fn takes_only_the_links_to_a_deleted_thread() {
        let gone: HashSet<String> = HashSet::from(["x".to_string()]);
        let mut linked = thread(json!({ "delegatedBy": "x", "continuedFrom": { "threadId": "x" }, "startedFrom": { "threadId": "x" },
            "continuedIn": [{ "threadId": "x" }, { "threadId": "y" }] }));
        assert!(unlink_from(&mut linked, &gone));
        assert_eq!(linked.delegated_by, None);
        assert!(!linked.extra.contains_key("continuedFrom") && !linked.extra.contains_key("startedFrom"));
        assert_eq!(linked.extra["continuedIn"], json!([{ "threadId": "y" }]));
        let mut last = thread(json!({ "continuedIn": [{ "threadId": "x" }] }));
        assert!(unlink_from(&mut last, &gone));
        assert!(!last.extra.contains_key("continuedIn"), "an emptied list goes, as Node deletes it");
        let mut other = thread(json!({ "delegatedBy": "y" }));
        assert!(!unlink_from(&mut other, &gone));
        assert_eq!(other.delegated_by.as_deref(), Some("y"));
    }

    /// The words go and the shape stays, as Node's `redactedPayload` writes it.
    #[test]
    fn redacts_events_as_node_does() {
        let added = json!({ "kind": "message-added", "at": "A", "message": { "id": "m", "role": "user", "createdAt": "C", "text": "Secret", "commandId": "k" } });
        let redacted: Value = serde_json::from_str(&redacted_payload(&added.to_string()).unwrap()).unwrap();
        assert_eq!(redacted, json!({ "kind": "message-added", "at": "A", "redacted": true, "message": { "id": "m", "role": "user", "createdAt": "C", "text": "" } }));
        let appended = json!({ "kind": "message-text-appended", "at": "A", "messageId": "m", "appendText": "Secret" });
        let redacted: Value = serde_json::from_str(&redacted_payload(&appended.to_string()).unwrap()).unwrap();
        assert_eq!(redacted, json!({ "kind": "message-text-appended", "at": "A", "redacted": true, "messageId": "m", "appendText": "" }));
        // Node's own output for this event: `JSON.stringify({ ...event, questionOptionIds: undefined, answer: '' })`.
        let answer = json!({ "kind": "answer-given", "at": "2026-11-26T00:00:00.000Z", "requestId": "r1", "answer": "yes please", "questionOptionIds": ["opt"], "approved": true });
        let redacted: Value = serde_json::from_str(&redacted_payload(&answer.to_string()).unwrap()).unwrap();
        let node: Value = serde_json::from_str(r#"{"kind":"answer-given","at":"2026-11-26T00:00:00.000Z","requestId":"r1","answer":"","approved":true}"#).unwrap();
        assert_eq!(redacted, node);
        assert_eq!(redacted_payload(&json!({ "kind": "turn-started", "at": "A" }).to_string()), None);
        assert_eq!(redacted_payload("not json"), None);
    }

    /// Node's strict schema for the two commands: their own fields, a thread ID, and the confirmations as it limits them.
    #[test]
    fn reads_delete_commands_as_nodes_schema_reads_them() {
        let read = |command: Value| delete_command_shape(command.as_object().unwrap());
        assert!(read(json!({ "type": "preview-delete-thread", "threadId": "t" })));
        assert!(read(json!({ "type": "delete-thread", "threadId": "t", "confirmedIgnored": ["node_modules"], "confirmedItems": [{ "path": "a", "fileCount": 2 }],
            "confirmedRepositories": [{ "path": "r", "changeCount": 0, "kind": "repository", "fetchedByHash": { "remote": "origin", "commitCount": 1 } }] })));
        for refused in [
            json!({ "type": "preview-delete-thread" }),
            json!({ "type": "preview-delete-thread", "threadId": "" }),
            json!({ "type": "preview-delete-thread", "threadId": "x".repeat(513) }),
            json!({ "type": "preview-delete-thread", "threadId": "t", "confirmedIgnored": [] }),
            json!({ "type": "delete-thread", "threadId": "t", "later": 1 }),
            json!({ "type": "delete-thread", "threadId": "t", "confirmedIgnored": "node_modules" }),
            json!({ "type": "delete-thread", "threadId": "t", "confirmedItems": [{ "path": "a", "fileCount": -1 }] }),
            json!({ "type": "delete-thread", "threadId": "t", "confirmedItems": [{ "path": "a", "fileCount": 1.5 }] }),
            json!({ "type": "delete-thread", "threadId": "t", "confirmedItems": [{ "path": "a", "fileCount": 1, "extra": true }] }),
            json!({ "type": "delete-thread", "threadId": "t", "confirmedRepositories": [{ "path": "r", "changeCount": 0, "kind": "folder" }] }),
            json!({ "type": "delete-thread", "threadId": "t", "confirmedRepositories": [{ "path": "r", "changeCount": 0, "kind": "worktree", "fetchedByHash": { "remote": "o", "commitCount": 0 } }] }),
            json!({ "type": "delete-thread", "threadId": "t", "confirmedIgnored": vec!["x"; 10_001] }),
        ] {
            assert!(!read(refused.clone()), "{refused}");
        }
    }

    /// The identities remembered as erased are Node's own, byte for byte (`activityIdentityHash`, `privacyIdentity`).
    #[test]
    fn remembers_erased_identities_as_node_hashes_them() {
        assert_eq!(activity_identity_hash("thread-1", "activity-1"), "90143ebd66b07ee2166dbb7756868cc1d6bae617c4506894e685e0e5973a23ce");
        assert_eq!(activity_identity_hash("t\u{f1}\u{1F600}", "a"), "1cecf870fc2e1705a1b5f8b9ffbaca8a54eeaeaa21621d47e0a94d05654a39a1", "the length is JavaScript's");
        assert_eq!(subagent_identity("thread-1", "agent-1", Some("task-1")), "92158015788b9d2ac0654a886eaf49a12d7e46d56da6ccdf998333ca2bc82462");
        assert_eq!(subagent_identity("thread-1", "agent-1", None), "075174418ddc8e70fc59f30b2407115edaa9ce4ec3827f6ee2f6ee0b4eb8dcaa");
    }
}
