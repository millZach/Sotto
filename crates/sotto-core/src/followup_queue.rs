//! The follow-up queue's own changes, as Node's `FollowupStore` makes them (`src/main/agents/followups.ts`): a prompt
//! queued, edited, removed, put in order, resumed, paused, taken to send and settled. Each is made on a copy and kept
//! only once `followups.json` is saved, so a failed save changes nothing. Sotto's wake-ups and Watcher's sends in the
//! file keep their place and every field, whatever this host does with the user's prompts around them.

use std::collections::HashSet;

use serde_json::{Map, Value};
use uuid::Uuid;

use crate::watcher::{
    followup_digest, is_any_restart_news, is_waiting_wake_up, FollowupReceipt, FollowupStore, QueuedFollowup,
    FOLLOWUPS_PER_THREAD_MAX, FOLLOWUPS_RECEIPTS_MAX,
};
use crate::workspace::now_iso;

/// The review token of a prompt queued while its thread rested on no turn Sotto had read, as Node's `UNKNOWN_TURN`.
pub const UNKNOWN_TURN: &str = "unknown";

const REVISION_TAKEN: &str =
    "This revision already belongs to a submitted prompt. Use a new draft revision for different content.";
const NO_LONGER_QUEUED: &str = "That follow-up is no longer queued.";
const MAYBE_SENT: &str = "This follow-up may already be sent. Refresh to reconcile it before making changes.";
const WAKE_UP_NOT_EDITABLE: &str = "A wake-up is Sotto's own message and cannot be edited. Remove it if the thread should not get it.";
const ORDER_CHANGED: &str = "The follow-up order changed. Refresh and try again.";
const DELIVERY_PENDING: &str = "Wait for this thread\u{2019}s pending delivery before reordering follow-ups.";
const SAVE_FAILED: &str = "Could not save the follow-up queue.";

/// A prompt for the queue, as Node's `enqueue` takes one.
#[derive(Debug, Clone, Default)]
pub struct FollowupPrompt {
    pub thread_id: String,
    pub draft_id: String,
    pub text: String,
    pub attachments: Vec<Value>,
    pub skills: Option<Vec<Value>>,
    pub files: Option<Vec<Value>>,
    /// The turn this prompt follows, so it goes after that turn without a review (`resumeAfterTurnId`).
    pub resume_after_turn_id: Option<String>,
}

/// What an edit sets on a queued prompt, each field as given.
#[derive(Debug, Clone, Default)]
pub struct FollowupEdit {
    pub text: String,
    pub attachments: Vec<Value>,
    pub skills: Option<Vec<Value>>,
    pub files: Option<Vec<Value>>,
}

/// How a queued item ends: sent, or held with what went wrong.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FollowupSettle {
    Accepted,
    Uncertain,
    Failed,
}

/// A wake-up holding news of one kind no one is shown, as Node's `isHiddenWakeUp`: Watcher's, a delegation's or peer
/// coordination's. No queue shows it, so no order names it.
pub fn is_hidden_wake_up(item: &QueuedFollowup) -> bool {
    let Some(news) = item.news.as_deref().filter(|news| item.wake_up == Some(true) && !news.is_empty()) else {
        return false;
    };
    let source = |part: &Value| part.get("source").and_then(Value::as_str).map(ToString::to_string);
    let first = source(&news[0]);
    matches!(first.as_deref(), Some("watcher" | "delegation" | "coordination")) && news.iter().all(|part| source(part) == first)
}

/// A waiting wake-up of this thread that resumes a stopped turn, which goes ahead of the user's prompts (`leadsQueue`).
fn leads_queue(item: &QueuedFollowup, thread_id: &str) -> bool {
    item.thread_id == thread_id && is_waiting_wake_up(item) && item.news.as_deref().unwrap_or(&[]).iter().any(is_any_restart_news)
}

fn waiting_wake_up(item: &QueuedFollowup, thread_id: &str) -> bool {
    item.thread_id == thread_id && is_waiting_wake_up(item)
}

fn digest_of(item: &QueuedFollowup) -> String {
    followup_digest(&item.text, &item.attachments, item.skills.as_deref(), item.files.as_deref())
}

impl FollowupStore {
    /// Makes `update` on a copy of the queue and keeps it once saved, as Node's `change`. `Ok(false)` from the update
    /// changed nothing and writes nothing.
    fn change(
        &mut self,
        watcher_thread_ids: &HashSet<String>,
        update: impl FnOnce(&mut Vec<QueuedFollowup>, &mut Vec<FollowupReceipt>) -> Result<bool, String>,
    ) -> Result<(), String> {
        let (mut items, mut receipts) = (self.items.clone(), self.receipts.clone());
        if !update(&mut items, &mut receipts)? {
            return Ok(());
        }
        let before = (std::mem::replace(&mut self.items, items), std::mem::replace(&mut self.receipts, receipts));
        if self.save(watcher_thread_ids).is_err() {
            (self.items, self.receipts) = before;
            return Err(SAVE_FAILED.into());
        }
        Ok(())
    }

    /// Queues a prompt behind the thread's others and ahead of a wake-up waiting there, and keeps its receipt. A draft
    /// queued again with the same content is the same prompt; with other content it is refused. Answers the ID of the
    /// item that holds the draft, or `None` when it has already been sent.
    pub fn enqueue_prompt(&mut self, prompt: FollowupPrompt, watcher_thread_ids: &HashSet<String>) -> Result<Option<String>, String> {
        let mut queued = None;
        self.change(watcher_thread_ids, |items, receipts| {
            let same = |thread_id: &str, draft_id: &str| thread_id == prompt.thread_id && draft_id == prompt.draft_id;
            let digest = followup_digest(&prompt.text, &prompt.attachments, prompt.skills.as_deref(), prompt.files.as_deref());
            let receipt = receipts.iter().find(|r| same(&r.thread_id, &r.draft_id));
            let item = items.iter().find(|i| same(&i.thread_id, &i.draft_id));
            if receipt.is_some() || item.is_some() {
                let held = receipt.and_then(|r| r.digest.clone()).or_else(|| item.map(digest_of));
                if held.as_deref() != Some(digest.as_str()) {
                    return Err(REVISION_TAKEN.into());
                }
                queued = item.map(|i| i.id.clone());
                return Ok(false);
            }
            if items.iter().filter(|i| i.thread_id == prompt.thread_id).count() >= FOLLOWUPS_PER_THREAD_MAX {
                return Err("This thread already has 100 follow-ups. Remove or send some first.".into());
            }
            let now = now_iso();
            let id = Uuid::new_v4().to_string();
            let at = items
                .iter()
                .position(|i| waiting_wake_up(i, &prompt.thread_id) && !leads_queue(i, &prompt.thread_id))
                .unwrap_or(items.len());
            items.insert(at, QueuedFollowup {
                id: id.clone(),
                thread_id: prompt.thread_id.clone(),
                draft_id: prompt.draft_id.clone(),
                text: prompt.text.clone(),
                attachments: prompt.attachments.clone(),
                skills: prompt.skills.clone(),
                files: prompt.files.clone(),
                status: "queued".into(),
                created_at: now.clone(),
                updated_at: now,
                error: None,
                paused_by: None,
                wake_up: None,
                resume_after_turn_id: prompt.resume_after_turn_id.clone(),
                watcher_operation_id: None,
                message_id: None,
                news: None,
                phone_origin: None,
                command_id: None,
                extra: Map::new(),
            });
            receipts.push(FollowupReceipt { thread_id: prompt.thread_id.clone(), draft_id: prompt.draft_id.clone(), digest: Some(digest), extra: Map::new() });
            keep_receipts(receipts);
            queued = Some(id);
            Ok(true)
        })?;
        Ok(queued)
    }

    /// Edits a queued prompt with `update`, or removes it without one, as Node's `edit`.
    pub fn edit_item(&mut self, thread_id: &str, item_id: &str, update: Option<FollowupEdit>, watcher_thread_ids: &HashSet<String>) -> Result<(), String> {
        self.change(watcher_thread_ids, |items, _| {
            let Some(at) = items.iter().position(|i| i.thread_id == thread_id && i.id == item_id) else {
                return Err(NO_LONGER_QUEUED.into());
            };
            if matches!(items[at].status.as_str(), "dispatching" | "uncertain") {
                return Err(MAYBE_SENT.into());
            }
            match update {
                Some(_) if items[at].wake_up == Some(true) => return Err(WAKE_UP_NOT_EDITABLE.into()),
                Some(update) => {
                    let item = &mut items[at];
                    item.text = update.text;
                    item.attachments = update.attachments;
                    item.skills = update.skills;
                    item.files = update.files;
                    item.updated_at = now_iso();
                }
                None => {
                    items.remove(at);
                }
            }
            Ok(true)
        })
    }

    /// Puts a thread's queue in the order `ids` gives, as Node's `reorder`: every item a queue shows, once each. A
    /// hidden wake-up the order leaves out keeps its place after them, a resume note stays first and a waiting wake-up
    /// stays after the user's prompts.
    pub fn reorder(&mut self, thread_id: &str, ids: &[String], watcher_thread_ids: &HashSet<String>) -> Result<(), String> {
        self.change(watcher_thread_ids, |items, _| {
            let (thread_items, others): (Vec<QueuedFollowup>, Vec<QueuedFollowup>) =
                std::mem::take(items).into_iter().partition(|i| i.thread_id == thread_id);
            if thread_items.iter().any(|i| matches!(i.status.as_str(), "dispatching" | "uncertain")) {
                return Err(DELIVERY_PENDING.into());
            }
            let (hidden, shown): (Vec<QueuedFollowup>, Vec<QueuedFollowup>) =
                thread_items.into_iter().partition(|i| is_hidden_wake_up(i) && !ids.contains(&i.id));
            let distinct: HashSet<&String> = ids.iter().collect();
            if ids.len() != shown.len() || distinct.len() != ids.len() || ids.iter().any(|id| !shown.iter().any(|i| &i.id == id)) {
                return Err(ORDER_CHANGED.into());
            }
            let mut ordered: Vec<QueuedFollowup> = ids.iter().filter_map(|id| shown.iter().find(|i| &i.id == id).cloned()).collect();
            ordered.extend(hidden);
            let (leading, rest): (Vec<QueuedFollowup>, Vec<QueuedFollowup>) = ordered.into_iter().partition(|i| leads_queue(i, thread_id));
            let (waiting, prompts): (Vec<QueuedFollowup>, Vec<QueuedFollowup>) = rest.into_iter().partition(|i| waiting_wake_up(i, thread_id));
            *items = others.into_iter().chain(leading).chain(prompts).chain(waiting).collect();
            Ok(true)
        })
    }

    /// Sends a thread's paused and failed items again, after `turn_id` when given, as Node's `resume`.
    pub fn resume(&mut self, thread_id: &str, turn_id: Option<&str>, watcher_thread_ids: &HashSet<String>) -> Result<(), String> {
        self.change(watcher_thread_ids, |items, _| {
            for item in items.iter_mut().filter(|i| i.thread_id == thread_id && matches!(i.status.as_str(), "paused" | "failed")) {
                item.status = "queued".into();
                if let Some(turn) = turn_id {
                    item.resume_after_turn_id = Some(turn.to_string());
                }
                item.error = None;
                item.paused_by = None;
            }
            Ok(true)
        })
    }

    /// Pauses a thread's queued items with `error` saying why, as Node's `pause`. A hidden wake-up never pauses: no one
    /// could resume it.
    pub fn pause(&mut self, thread_id: &str, error: &str, watcher_thread_ids: &HashSet<String>) -> Result<(), String> {
        self.change(watcher_thread_ids, |items, _| {
            for item in items.iter_mut().filter(|i| i.thread_id == thread_id && i.status == "queued" && !is_hidden_wake_up(i)) {
                item.status = "paused".into();
                item.error = Some(error.to_string());
            }
            Ok(true)
        })
    }

    /// Takes the head of its thread's queue to send, as Node's `claim` in its send mode: items `waits` says wait are not
    /// counted. Answers the item as taken, with the command and message it goes as.
    pub fn claim(&mut self, id: &str, waits: impl Fn(&QueuedFollowup) -> bool, watcher_thread_ids: &HashSet<String>) -> Result<QueuedFollowup, String> {
        let mut claimed = None;
        self.change(watcher_thread_ids, |items, _| {
            let thread_id = items.iter().find(|i| i.id == id).map(|i| i.thread_id.clone());
            let head = thread_id.and_then(|thread| items.iter().position(|i| i.thread_id == thread && !waits(i)));
            let Some(at) = head.filter(|&at| items[at].id == id && items[at].status == "queued") else {
                let wake_up = items.iter().any(|i| i.id == id && i.wake_up == Some(true));
                return Err(if wake_up { "This wake-up is no longer ready to send." } else { "This follow-up is no longer ready to send." }.into());
            };
            let item = &mut items[at];
            item.status = "dispatching".into();
            item.command_id = Some(Uuid::new_v4().to_string());
            if item.watcher_operation_id.is_none() || item.message_id.is_none() {
                item.message_id = Some(Uuid::new_v4().to_string());
            }
            item.updated_at = now_iso();
            claimed = Some(item.clone());
            Ok(true)
        })?;
        claimed.ok_or_else(|| SAVE_FAILED.into())
    }

    /// Ends an item taken to send, as Node's `settle`: one sent leaves the queue, any other keeps its place and says why.
    pub fn settle(&mut self, id: &str, outcome: FollowupSettle, error: Option<String>, watcher_thread_ids: &HashSet<String>) -> Result<(), String> {
        self.change(watcher_thread_ids, |items, _| {
            let Some(at) = items.iter().position(|i| i.id == id) else {
                return Ok(false);
            };
            match outcome {
                FollowupSettle::Accepted => {
                    items.remove(at);
                }
                FollowupSettle::Uncertain | FollowupSettle::Failed => {
                    let item = &mut items[at];
                    item.status = if outcome == FollowupSettle::Failed { "failed" } else { "uncertain" }.into();
                    item.error = error;
                    item.updated_at = now_iso();
                }
            }
            Ok(true)
        })
    }

    /// Takes back the named drafts Watcher queued that have not started to send. Answers how many went.
    pub fn cancel_drafts(&mut self, draft_ids: &HashSet<String>, watcher_thread_ids: &HashSet<String>) -> Result<usize, String> {
        let mut removed = 0;
        self.change(watcher_thread_ids, |items, _| {
            let before = items.len();
            items.retain(|i| !draft_ids.contains(&i.draft_id) || matches!(i.status.as_str(), "dispatching" | "uncertain"));
            removed = before - items.len();
            Ok(removed > 0)
        })?;
        Ok(removed)
    }

    /// The queue as a client is shown it, as Node's state carries it: no hidden wake-up, and no item's news or the
    /// phone it came from.
    pub fn published(&self) -> Vec<Value> {
        self.items
            .iter()
            .filter(|item| !is_hidden_wake_up(item))
            .filter_map(|item| {
                let mut value = serde_json::to_value(item).ok()?;
                if let Some(fields) = value.as_object_mut() {
                    fields.remove("news");
                    fields.remove("phoneOrigin");
                }
                Some(value)
            })
            .collect()
    }

    /// The drafts the queue holds receipts for, as Node's state carries them: thread and draft alone.
    pub fn published_receipts(&self) -> Vec<Value> {
        self.receipts.iter().map(|r| serde_json::json!({ "threadId": r.thread_id, "draftId": r.draft_id })).collect()
    }
}

/// Keeps the newest receipts, as many as the saved file holds (`keepReceipts`).
fn keep_receipts(receipts: &mut Vec<FollowupReceipt>) {
    if receipts.len() > FOLLOWUPS_RECEIPTS_MAX {
        receipts.drain(..receipts.len() - FOLLOWUPS_RECEIPTS_MAX);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn store() -> (tempfile::TempDir, FollowupStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = FollowupStore::new(dir.path(), true);
        (dir, store)
    }

    fn prompt(thread: &str, text: &str) -> FollowupPrompt {
        FollowupPrompt { thread_id: thread.into(), draft_id: Uuid::new_v4().to_string(), text: text.into(), ..FollowupPrompt::default() }
    }

    fn none() -> HashSet<String> {
        HashSet::new()
    }

    fn texts(store: &FollowupStore, thread: &str) -> Vec<String> {
        store.items.iter().filter(|i| i.thread_id == thread).map(|i| i.text.clone()).collect()
    }

    fn wake_up(thread: &str, source: &str) -> QueuedFollowup {
        let mut item: QueuedFollowup = serde_json::from_value(json!({ "id": Uuid::new_v4().to_string(), "threadId": thread, "draftId": Uuid::new_v4().to_string(),
            "text": source, "attachments": [], "status": "queued", "createdAt": now_iso(), "updatedAt": now_iso(), "wakeUp": true })).unwrap();
        item.news = Some(vec![json!({ "source": source })]);
        item
    }

    /// A prompt is saved to `followups.json`, the same draft again is the same prompt, and other content under it is refused.
    #[test]
    fn a_draft_is_queued_once_and_saved() {
        let (dir, mut store) = store();
        let first = prompt("t", "One");
        let id = store.enqueue_prompt(first.clone(), &none()).unwrap().unwrap();
        assert_eq!(store.enqueue_prompt(first.clone(), &none()).unwrap(), Some(id.clone()));
        let other = FollowupPrompt { text: "Other".into(), ..first };
        assert_eq!(store.enqueue_prompt(other, &none()).unwrap_err(), REVISION_TAKEN);
        let mut reread = FollowupStore::new(dir.path(), true);
        reread.load(&none()).unwrap();
        assert_eq!(reread.items().iter().map(|i| i.id.clone()).collect::<Vec<_>>(), vec![id]);
        assert_eq!(reread.receipts().len(), 1);
    }

    /// A thread's prompts go ahead of a waiting wake-up and behind a resume note, and a thread takes a hundred.
    #[test]
    fn prompts_queue_between_a_resume_note_and_a_wake_up() {
        let (_dir, mut store) = store();
        store.items = vec![wake_up("t", "babysit"), wake_up("t", "restart")];
        store.enqueue_prompt(prompt("t", "Mine"), &none()).unwrap();
        store.reorder("t", &store.items.iter().map(|i| i.id.clone()).collect::<Vec<_>>(), &none()).unwrap();
        assert_eq!(texts(&store, "t"), ["restart", "Mine", "babysit"]);
        for at in store.items.len()..FOLLOWUPS_PER_THREAD_MAX {
            store.enqueue_prompt(prompt("t", &format!("{at}")), &none()).unwrap();
        }
        assert!(store.enqueue_prompt(prompt("t", "Past"), &none()).unwrap_err().starts_with("This thread already has 100"));
    }

    /// An order names every item a queue shows, once each, and may leave out a hidden wake-up, which keeps its place after them.
    #[test]
    fn an_order_names_what_the_queue_shows() {
        let (_dir, mut store) = store();
        let a = store.enqueue_prompt(prompt("t", "A"), &none()).unwrap().unwrap();
        let b = store.enqueue_prompt(prompt("t", "B"), &none()).unwrap().unwrap();
        store.items.push(wake_up("t", "watcher"));
        store.reorder("t", &[b.clone(), a.clone()], &none()).unwrap();
        assert_eq!(texts(&store, "t"), ["B", "A", "watcher"]);
        for refused in [vec![a.clone()], vec![a.clone(), a.clone()], vec![a.clone(), b.clone(), "x".into()]] {
            assert_eq!(store.reorder("t", &refused, &none()).unwrap_err(), ORDER_CHANGED);
        }
        store.reorder("empty", &[], &none()).unwrap();
    }

    /// An edit changes a prompt, a remove takes it out, and neither touches one that may have been sent or a wake-up's words.
    #[test]
    fn an_edit_or_remove_is_refused_where_node_refuses_it() {
        let (_dir, mut store) = store();
        let id = store.enqueue_prompt(prompt("t", "Before"), &none()).unwrap().unwrap();
        let edit = || Some(FollowupEdit { text: "After".into(), ..FollowupEdit::default() });
        store.edit_item("t", &id, edit(), &none()).unwrap();
        assert_eq!(texts(&store, "t"), ["After"]);
        assert_eq!(store.edit_item("t", "gone", edit(), &none()).unwrap_err(), NO_LONGER_QUEUED);
        store.items.push(wake_up("t", "babysit"));
        let news = store.items[1].id.clone();
        assert_eq!(store.edit_item("t", &news, edit(), &none()).unwrap_err(), WAKE_UP_NOT_EDITABLE);
        store.edit_item("t", &news, None, &none()).unwrap();
        store.claim(&id, |_| false, &none()).unwrap();
        assert_eq!(store.edit_item("t", &id, None, &none()).unwrap_err(), MAYBE_SENT);
        assert_eq!(store.reorder("t", &[id], &none()).unwrap_err(), DELIVERY_PENDING);
    }

    /// Only the head is taken to send; it leaves once sent, a failed send holds the queue, and resuming sends it again.
    #[test]
    fn the_head_is_sent_and_a_failure_waits_for_resume() {
        let (_dir, mut store) = store();
        let first = store.enqueue_prompt(prompt("t", "First"), &none()).unwrap().unwrap();
        let second = store.enqueue_prompt(prompt("t", "Second"), &none()).unwrap().unwrap();
        assert!(store.claim(&second, |_| false, &none()).is_err());
        let claimed = store.claim(&first, |_| false, &none()).unwrap();
        assert!(claimed.command_id.is_some() && claimed.message_id.is_some());
        store.settle(&first, FollowupSettle::Failed, Some("No".into()), &none()).unwrap();
        assert_eq!((store.items[0].status.as_str(), store.items[0].error.as_deref()), ("failed", Some("No")));
        store.resume("t", Some("turn-1"), &none()).unwrap();
        assert_eq!((store.items[0].status.as_str(), store.items[0].resume_after_turn_id.as_deref()), ("queued", Some("turn-1")));
        store.claim(&first, |_| false, &none()).unwrap();
        store.settle(&first, FollowupSettle::Accepted, None, &none()).unwrap();
        assert_eq!(texts(&store, "t"), ["Second"]);
    }

    /// A pause holds the user's prompts and Sotto's shown wake-ups, never a hidden one.
    #[test]
    fn a_pause_leaves_a_hidden_wake_up_alone() {
        let (_dir, mut store) = store();
        store.enqueue_prompt(prompt("t", "Mine"), &none()).unwrap();
        store.items.push(wake_up("t", "delegation"));
        store.pause("t", "Review it.", &none()).unwrap();
        assert_eq!(store.items.iter().map(|i| i.status.as_str()).collect::<Vec<_>>(), ["paused", "queued"]);
        assert_eq!(store.published().len(), 1);
    }

    /// What Node saved that this host does not send, a hidden wake-up with its news and a field it does not know, is
    /// written back whole when the queue changes around it.
    #[test]
    fn nodes_items_are_kept_whole() {
        let dir = tempfile::tempdir().unwrap();
        let saved = json!({ "items": [{ "id": Uuid::new_v4().to_string(), "threadId": "t", "draftId": Uuid::new_v4().to_string(), "text": "News",
            "attachments": [], "status": "queued", "createdAt": now_iso(), "updatedAt": now_iso(), "wakeUp": true,
            "news": [{ "source": "watcher", "events": [] }], "laterField": 1 }], "receipts": [] });
        std::fs::write(dir.path().join("followups.json"), saved.to_string()).unwrap();
        let mut store = FollowupStore::new(dir.path(), true);
        store.load(&none()).unwrap();
        store.enqueue_prompt(prompt("t", "Mine"), &none()).unwrap();
        let written: Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join("followups.json")).unwrap()).unwrap();
        let kept = written["items"].as_array().unwrap().iter().find(|item| item["text"] == "News").unwrap();
        assert_eq!((kept["laterField"].clone(), kept["news"].clone()), (json!(1), saved["items"][0]["news"].clone()));
        assert!(store.published().iter().all(|item| item["text"] != "News"));
    }

    /// Watcher's own copy of the file, read at start, writes over nothing the coordinator queued since.
    #[test]
    fn watchers_copy_keeps_what_was_queued_since() {
        let dir = tempfile::tempdir().unwrap();
        let mut watcher = FollowupStore::new(dir.path(), true);
        watcher.load(&none()).unwrap();
        let mut queue = FollowupStore::new(dir.path(), true);
        queue.enqueue_prompt(prompt("t", "Queued since"), &none()).unwrap();
        watcher.set_history_enabled(true, &none()).unwrap();
        watcher.cancel_watcher(&HashSet::from(["op".to_string()]), &none()).unwrap();
        let mut reread = FollowupStore::new(dir.path(), true);
        reread.load(&none()).unwrap();
        assert_eq!(texts(&reread, "t"), ["Queued since"]);
    }

    /// A save that fails changes nothing in the queue.
    #[test]
    fn a_failed_save_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = FollowupStore::new(dir.path().join("missing").join("deeper"), true);
        std::fs::write(dir.path().join("missing"), "a file where the folder would be").unwrap();
        assert_eq!(store.enqueue_prompt(prompt("t", "Lost"), &none()).unwrap_err(), SAVE_FAILED);
        assert!(store.items().is_empty() && store.receipts().is_empty());
    }
}
