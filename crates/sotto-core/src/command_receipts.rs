//! Each paired client's commands by the client's own request ID, as Node's `CommandReceipts`
//! (`src/host/commandReceipts.ts`) keeps them, so a command sent again is answered from its first run instead of acting
//! twice, and a client that lost a command's acknowledgement can ask what became of it (`receipt`). Both of a host's
//! listeners share one, so a desktop that moves between them is answered from here (ADR-0053).
//!
//! A receipt is pending while its command runs and completed once it ends, with Node's fixed `unavailable` error when
//! it failed, and for an answer whether the answer was delivered. A settled receipt is kept for five minutes, which covers a reconnect after
//! a lost acknowledgement, and then dropped, so a host that runs for weeks never fills up. Only pending work is busy.
//! Receipts live in memory only and hold no command text: a digest of the command, its outcome and nothing else.

use std::collections::HashMap;

use serde_json::{json, Value};
use tokio::sync::watch;

use crate::answered_requests::AnswerTarget;
use crate::coordinator::CoordinatorError;
use crate::protocol::HostErrorCode;

/// How long a settled receipt answers a retried command, as Node's `RECEIPT_LIFETIME_MS`.
pub const RECEIPT_LIFETIME_MS: i64 = 5 * 60_000;
/// How many receipts are kept at once, as Node's `RECEIPT_LIMIT`.
pub const RECEIPT_LIMIT: usize = 10_000;
/// How many answers one connection waits to hear were accepted, oldest dropped first, as Node's socket server keeps them.
pub const ANSWER_WATCHES_MAX: usize = 512;

/// The commands that keep no receipt: selecting and observing only move one client's own view, and repeating one is
/// harmless, as Node's `UNRECEIPTED` names them.
pub fn keeps_receipt(command_type: &str) -> bool {
    !matches!(command_type, "select-thread" | "select-project" | "observe-threads")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReceiptStatus {
    Pending,
    Completed,
}

/// What became of one command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Receipt {
    pub status: ReceiptStatus,
    /// The code a command that failed is answered with again, always with that code's own words: a receipt never keeps
    /// what an adapter or the coordinator said, so no such words reach another reply.
    pub error: Option<HostErrorCode>,
    /// For an answer, whether the provider took it.
    pub answer_delivered: Option<bool>,
}

impl Receipt {
    pub fn pending() -> Self {
        Self { status: ReceiptStatus::Pending, error: None, answer_delivered: None }
    }

    pub fn completed() -> Self {
        Self { status: ReceiptStatus::Completed, error: None, answer_delivered: None }
    }

    /// A command that failed, as Node records every one: `unavailable`, in its fixed words.
    pub fn unavailable() -> Self {
        Self { status: ReceiptStatus::Completed, error: Some(HostErrorCode::Unavailable), answer_delivered: None }
    }

    /// The receipt as Node's `hostReceiptSchema` reads it.
    pub fn to_value(&self) -> Value {
        let status = match self.status {
            ReceiptStatus::Pending => "pending",
            ReceiptStatus::Completed => "completed",
        };
        let mut value = json!({ "status": status });
        if let Some(code) = self.error {
            value["error"] = json!({ "code": code.as_str(), "message": code.default_message() });
        }
        if let Some(delivered) = self.answer_delivered {
            value["answerDelivered"] = json!(delivered);
        }
        value
    }
}

/// What a command's receipt says once it ended, as Node's socket server writes it: completed, `unavailable` in its fixed
/// words when it failed however it failed, and for an answer whether the provider took it. A command turned down before
/// it acted keeps no receipt at all: the socket server refuses it before one is made.
pub fn ended_receipt(is_answer: bool, outcome: &Result<Value, CoordinatorError>) -> Receipt {
    let ended = if outcome.is_ok() { Receipt::completed() } else { Receipt::unavailable() };
    Receipt { answer_delivered: is_answer.then_some(outcome.is_ok()), ..ended }
}

/// The receipt of a command this host does not hold, or no longer does.
pub fn unknown_receipt() -> Value {
    json!({ "status": "unknown" })
}

struct Kept {
    digest: String,
    receipt: watch::Sender<Receipt>,
    settled_at: Option<i64>,
    /// When it was first kept among the others, as a JavaScript `Map` keeps the order things were added.
    order: u64,
}

/// A receipt kept for a command, as a retry of it finds it.
pub struct KeptReceipt {
    /// The digest of the command the receipt is for, so a retry under the same ID that says something else is refused.
    pub digest: String,
    receipt: watch::Receiver<Receipt>,
}

impl KeptReceipt {
    /// The receipt once its command has ended, waiting while it runs; none if it was let go before it ended.
    pub async fn settled(mut self) -> Option<Receipt> {
        self.receipt.wait_for(|receipt| receipt.status == ReceiptStatus::Completed).await.ok().map(|receipt| receipt.clone())
    }
}

pub struct CommandReceipts {
    entries: HashMap<String, Kept>,
    next_order: u64,
    lifetime_ms: i64,
    limit: usize,
    now: Box<dyn Fn() -> i64 + Send + Sync>,
}

impl Default for CommandReceipts {
    fn default() -> Self {
        Self::new(RECEIPT_LIFETIME_MS, RECEIPT_LIMIT, Box::new(|| chrono::Utc::now().timestamp_millis()))
    }
}

fn key(client_id: &str, request_id: &str) -> String {
    format!("{client_id}:{request_id}")
}

impl CommandReceipts {
    pub fn new(lifetime_ms: i64, limit: usize, now: Box<dyn Fn() -> i64 + Send + Sync>) -> Self {
        Self { entries: HashMap::new(), next_order: 0, lifetime_ms, limit, now }
    }

    /// The receipt this client's command keeps, for a retry of it.
    pub fn get(&self, client_id: &str, request_id: &str) -> Option<KeptReceipt> {
        self.entries.get(&key(client_id, request_id)).map(|kept| KeptReceipt { digest: kept.digest.clone(), receipt: kept.receipt.subscribe() })
    }

    /// The receipt as it stands now, for a `receipt` read.
    pub fn receipt(&self, client_id: &str, request_id: &str) -> Option<Receipt> {
        self.entries.get(&key(client_id, request_id)).map(|kept| kept.receipt.borrow().clone())
    }

    /// Drops receipts settled longer ago than the replay window, then the oldest settled one if still full, and says
    /// whether there is room. Only pending work is busy.
    pub fn make_room(&mut self) -> bool {
        let now = (self.now)();
        let lifetime = self.lifetime_ms;
        self.entries.retain(|_, kept| kept.settled_at.is_none_or(|at| now - at <= lifetime));
        if self.entries.len() < self.limit {
            return true;
        }
        let oldest = self.entries.iter().filter(|(_, kept)| kept.settled_at.is_some()).min_by_key(|(_, kept)| kept.order).map(|(key, _)| key.clone());
        oldest.is_some_and(|key| self.entries.remove(&key).is_some())
    }

    /// Keeps a pending receipt for a command about to run.
    pub fn record(&mut self, client_id: &str, request_id: &str, digest: String) {
        let order = self.next_order;
        self.next_order += 1;
        let (receipt, _) = watch::channel(Receipt::pending());
        let order = self.entries.get(&key(client_id, request_id)).map_or(order, |kept| kept.order);
        self.entries.insert(key(client_id, request_id), Kept { digest, receipt, settled_at: None, order });
    }

    /// Marks the command ended, with what became of it, and tells every retry waiting on it.
    pub fn settle(&mut self, client_id: &str, request_id: &str, mut receipt: Receipt) {
        let now = (self.now)();
        if let Some(kept) = self.entries.get_mut(&key(client_id, request_id)) {
            receipt.status = ReceiptStatus::Completed;
            kept.settled_at = Some(now);
            kept.receipt.send_replace(receipt);
        }
    }

    /// Lets a command's receipt go, for one turned down before it acted, which Node never keeps.
    pub fn forget(&mut self, client_id: &str, request_id: &str) {
        self.entries.remove(&key(client_id, request_id));
    }
}

/// The answers one connection asked the receipt of and was told were not accepted yet, by the command ID they were sent
/// under, oldest first, so it can be told when one is (`answer-receipt`).
#[derive(Debug, Default)]
pub struct AnswerWatches {
    watches: Vec<(String, AnswerTarget)>,
}

impl AnswerWatches {
    /// Watches an answer, in its first place if it was already watched, as a JavaScript `Map` keeps it, and drops the
    /// oldest past `ANSWER_WATCHES_MAX`.
    pub fn watch(&mut self, command_id: &str, target: AnswerTarget) {
        match self.watches.iter_mut().find(|(id, _)| id == command_id) {
            Some(watch) => watch.1 = target,
            None => self.watches.push((command_id.to_string(), target)),
        }
        if self.watches.len() > ANSWER_WATCHES_MAX {
            self.watches.drain(..self.watches.len() - ANSWER_WATCHES_MAX);
        }
    }

    pub fn forget(&mut self, command_id: &str) {
        self.watches.retain(|(id, _)| id != command_id);
    }

    pub fn is_empty(&self) -> bool {
        self.watches.is_empty()
    }

    pub fn watched(&self) -> &[(String, AnswerTarget)] {
        &self.watches
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::Arc;

    fn receipts(limit: usize) -> (CommandReceipts, Arc<AtomicI64>) {
        let clock = Arc::new(AtomicI64::new(1_000));
        let now = Arc::clone(&clock);
        (CommandReceipts::new(RECEIPT_LIFETIME_MS, limit, Box::new(move || now.load(Ordering::SeqCst))), clock)
    }

    fn target(request_id: &str) -> AnswerTarget {
        AnswerTarget { thread_id: "t".into(), provider_id: "codex".into(), request_id: request_id.into(), questions_digest: "a".repeat(64) }
    }

    #[test]
    fn a_receipt_is_pending_then_completed_and_each_client_reads_its_own() {
        let (mut store, _) = receipts(RECEIPT_LIMIT);
        assert!(store.receipt("c-1", "cmd").is_none(), "an unknown command ID");
        assert_eq!(unknown_receipt(), json!({ "status": "unknown" }));
        store.record("c-1", "cmd", "digest".into());
        assert_eq!(store.receipt("c-1", "cmd").unwrap().to_value(), json!({ "status": "pending" }));
        assert!(store.receipt("c-2", "cmd").is_none(), "another client's command is not this one's");
        store.settle("c-1", "cmd", Receipt::completed());
        assert_eq!(store.receipt("c-1", "cmd").unwrap().to_value(), json!({ "status": "completed" }));
        assert_eq!(store.get("c-1", "cmd").unwrap().digest, "digest");
    }

    #[test]
    fn an_answer_says_whether_it_was_delivered_and_a_failure_is_unavailable() {
        let delivered = Receipt { answer_delivered: Some(true), ..Receipt::completed() };
        assert_eq!(delivered.to_value(), json!({ "status": "completed", "answerDelivered": true }));
        let undelivered = Receipt { answer_delivered: Some(false), ..Receipt::unavailable() };
        let words = HostErrorCode::Unavailable.default_message();
        assert_eq!(undelivered.to_value(), json!({ "status": "completed", "error": { "code": "unavailable", "message": words }, "answerDelivered": false }));
    }

    #[tokio::test]
    async fn a_retry_waits_for_a_pending_command_and_hears_how_it_ended() {
        let (mut store, _) = receipts(RECEIPT_LIMIT);
        store.record("c", "cmd", "d".into());
        let waiting = store.get("c", "cmd").unwrap();
        let retry = tokio::spawn(waiting.settled());
        tokio::task::yield_now().await;
        assert!(!retry.is_finished());
        store.settle("c", "cmd", Receipt::unavailable());
        let ended = retry.await.unwrap().unwrap();
        assert_eq!(ended.error, Some(HostErrorCode::Unavailable));
        // One let go before it ended is not waited on for good.
        store.record("c", "other", "d".into());
        let waiting = store.get("c", "other").unwrap();
        store.forget("c", "other");
        assert!(waiting.settled().await.is_none());
        assert!(store.receipt("c", "other").is_none());
    }

    #[test]
    fn a_settled_receipt_goes_after_five_minutes_and_a_full_store_is_busy_only_with_pending_work() {
        let (mut store, clock) = receipts(2);
        store.record("c", "a", "d".into());
        store.settle("c", "a", Receipt::completed());
        clock.fetch_add(RECEIPT_LIFETIME_MS, Ordering::SeqCst);
        assert!(store.make_room());
        assert!(store.receipt("c", "a").is_some(), "kept for the whole window");
        clock.fetch_add(1, Ordering::SeqCst);
        assert!(store.make_room());
        assert!(store.receipt("c", "a").is_none(), "dropped once the window passed");

        store.record("c", "b", "d".into());
        store.record("c", "c", "d".into());
        assert!(!store.make_room(), "full of pending work: busy");
        store.settle("c", "c", Receipt::completed());
        assert!(store.make_room(), "the oldest settled one makes room");
        assert!(store.receipt("c", "c").is_none() && store.receipt("c", "b").is_some(), "pending work is never dropped");
    }

    #[test]
    fn the_oldest_settled_receipt_goes_first() {
        let (mut store, _) = receipts(2);
        store.record("c", "first", "d".into());
        store.record("c", "second", "d".into());
        store.settle("c", "second", Receipt::completed());
        store.settle("c", "first", Receipt::completed());
        assert!(store.make_room());
        assert!(store.receipt("c", "first").is_none() && store.receipt("c", "second").is_some());
    }

    /// A receipt keeps only Node's fixed `unavailable` error, whatever the command failed with, so what an adapter or the
    /// coordinator said never reaches another reply.
    #[test]
    fn a_receipt_says_how_its_command_ended_in_the_hosts_words_alone() {
        let shell = Ok(json!({ "threads": [] }));
        assert_eq!(ended_receipt(false, &shell), Receipt::completed());
        assert_eq!(ended_receipt(true, &shell).to_value(), json!({ "status": "completed", "answerDelivered": true }));
        let words = HostErrorCode::Unavailable.default_message();
        let failed = Err(CoordinatorError::unavailable("codex: connection reset by peer at /home/someone/project"));
        assert_eq!(ended_receipt(true, &failed).to_value(),
            json!({ "status": "completed", "error": { "code": "unavailable", "message": words }, "answerDelivered": false }));
        for failed in [CoordinatorError::forbidden("No."), CoordinatorError::invalid("Unknown thread."), CoordinatorError::stale("Gone.")] {
            assert_eq!(ended_receipt(false, &Err(failed)).to_value(), json!({ "status": "completed", "error": { "code": "unavailable", "message": words } }));
        }
    }

    #[test]
    fn only_selecting_and_observing_keep_no_receipt() {
        for kind in ["select-thread", "select-project", "observe-threads"] {
            assert!(!keeps_receipt(kind));
        }
        for kind in ["answer", "manual-send", "rename-thread", "snooze-thread"] {
            assert!(keeps_receipt(kind));
        }
    }

    #[test]
    fn answer_watches_keep_their_place_and_drop_the_oldest() {
        let mut watches = AnswerWatches::default();
        watches.watch("a", target("r-a"));
        watches.watch("b", target("r-b"));
        watches.watch("a", target("r-a2"));
        assert_eq!(watches.watched().iter().map(|(id, t)| (id.as_str(), t.request_id.as_str())).collect::<Vec<_>>(), [("a", "r-a2"), ("b", "r-b")]);
        for n in 0..ANSWER_WATCHES_MAX {
            watches.watch(&format!("n-{n}"), target("r"));
        }
        assert_eq!(watches.watched().len(), ANSWER_WATCHES_MAX);
        assert_eq!(watches.watched()[0].0, "n-0", "the two oldest went");
        watches.forget("n-0");
        assert_eq!(watches.watched()[0].0, "n-1");
    }
}
