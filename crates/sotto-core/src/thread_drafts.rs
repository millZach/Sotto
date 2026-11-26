//! Thread drafts as Node's coordinator keeps them (`src/main/agents/control.ts`: `threadDrafts`, `obsoleteDrafts`,
//! `deliveredDrafts`): each thread's draft revision, what the user typed and attached for it, kept in `agents.json` so a
//! client finds it again on any device and after a restart. A revision a newer one replaced, or one cleared, is
//! remembered as obsolete, so a late save of it never brings it back; a revision that was sent is never kept as a draft
//! again.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::workspace::DeliveredDraft;

/// The keys `agents.json` keeps them under, as Node's `savedSchema` names them.
pub const DRAFTS_KEY: &str = "threadDrafts";
pub const OBSOLETE_KEY: &str = "obsoleteDrafts";
pub const DELIVERED_KEY: &str = "deliveredDrafts";
/// The receipts kept, the newest, as Node's `MAX_DELIVERED_DRAFTS`.
pub const RECEIPTS_KEPT: usize = 128;

const CHANGED_ON_HOST: &str = "This thread draft changed on the host. Your edit is kept on this computer. Review the host draft before saving again.";
const OTHER_CONTENT: &str = "This revision already belongs to different draft content. Use a new draft revision for your edit.";
const CLEARED: &str = "This draft revision was cleared or replaced. Your newer draft was kept.";
const SUBMITTED: &str = "Use a new draft revision when editing a submitted prompt.";
const ANSWER_HELD: &str = "Clear the existing answer before starting a different draft.";

/// One thread's draft as Node's `agentThreadDraftSchema` keeps it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDraft {
    pub thread_id: String,
    pub draft_id: String,
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skills: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<Value>>,
    /// The question this draft answers, or none.
    pub request_id: Option<String>,
    pub updated_at: String,
    /// Fields this build does not know, written back as they were (ADR-0214).
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A save of a thread's draft, as `save-thread-draft` names it.
#[derive(Debug, Clone, Default)]
pub struct DraftSave {
    pub thread_id: String,
    pub draft_id: String,
    /// The revision the client last saw, when it names one (`expectedDraftId`, `draft-revisions`): `Some(None)` is none.
    pub expected: Option<Option<String>>,
    pub text: String,
    pub attachments: Vec<Value>,
    pub skills: Option<Vec<Value>>,
    pub files: Option<Vec<Value>>,
    pub request_id: Option<String>,
}

/// What the coordinator knows of a revision that this record does not.
#[derive(Debug, Clone, Copy, Default)]
pub struct DraftFacts {
    /// The thread is one the host holds.
    pub thread_known: bool,
    /// This revision was queued or delivered on this thread: it is a prompt, not a draft.
    pub sent: bool,
    /// This revision was submitted and not refused.
    pub submitted: bool,
    /// This revision's ID is already another thread's sent prompt.
    pub elsewhere: bool,
}

/// What a save did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DraftSaved {
    /// The draft is kept as given.
    Kept,
    /// The revision was already sent, so nothing changed.
    AlreadySent,
}

#[derive(Debug, Default)]
pub struct ThreadDrafts {
    drafts: Vec<ThreadDraft>,
    /// A thread's empty revision, kept in memory only, as Node's `emptyDraftRevisions`: a draft cleared to nothing.
    empty: HashMap<String, (String, Option<String>)>,
    obsolete: Vec<DeliveredDraft>,
}

impl ThreadDrafts {
    /// Takes the drafts, the obsolete revisions and the delivered ones out of `agents.json`, keeping whatever of
    /// each reads.
    pub fn take_saved(agents_json: &mut Map<String, Value>) -> (Self, Vec<DeliveredDraft>) {
        let read = |value: Option<Value>| -> Vec<Value> { value.and_then(|v| v.as_array().cloned()).unwrap_or_default() };
        let drafts = read(agents_json.remove(DRAFTS_KEY)).into_iter().filter_map(|v| serde_json::from_value(v).ok()).collect();
        let obsolete = read(agents_json.remove(OBSOLETE_KEY)).into_iter().filter_map(|v| serde_json::from_value(v).ok()).collect();
        let delivered = read(agents_json.remove(DELIVERED_KEY)).into_iter().filter_map(|v| serde_json::from_value(v).ok()).collect();
        (Self { drafts, empty: HashMap::new(), obsolete }, delivered)
    }

    /// Writes them back into `agents.json`, as Node's `savedSchema` keeps them.
    pub fn save_into(&self, agents_json: &mut Map<String, Value>, delivered: &[DeliveredDraft]) {
        let list = |items: &[DeliveredDraft]| serde_json::to_value(items).unwrap_or(Value::Array(Vec::new()));
        agents_json.insert(DRAFTS_KEY.into(), serde_json::to_value(&self.drafts).unwrap_or(Value::Array(Vec::new())));
        agents_json.insert(OBSOLETE_KEY.into(), list(&self.obsolete));
        agents_json.insert(DELIVERED_KEY.into(), list(delivered));
    }

    /// The drafts as a client is shown them.
    pub fn published(&self) -> Value {
        serde_json::to_value(&self.drafts).unwrap_or(Value::Array(Vec::new()))
    }

    /// The obsolete revisions as a client is shown them.
    pub fn published_obsolete(&self) -> Value {
        serde_json::to_value(&self.obsolete).unwrap_or(Value::Array(Vec::new()))
    }

    /// The revision a thread's draft stands at, or its empty revision.
    fn current_id(&self, thread_id: &str) -> Option<&str> {
        self.drafts.iter().find(|d| d.thread_id == thread_id).map(|d| d.draft_id.as_str())
            .or_else(|| self.empty.get(thread_id).map(|(id, _)| id.as_str()))
    }

    /// Saves a thread's draft, as Node's `stageThreadDraft`: checked against the revision the client saw, against
    /// another draft's revision, against a cleared or a submitted one, and against an answer the draft holds. A
    /// revision already sent changes nothing.
    pub fn save(&mut self, save: DraftSave, facts: DraftFacts, updated_at: String) -> Result<DraftSaved, String> {
        let previous = self.drafts.iter().find(|d| d.thread_id == save.thread_id).cloned();
        let empty = self.empty.get(&save.thread_id).cloned();
        let digest_matches = |d: &ThreadDraft| {
            crate::watcher::followup_digest(&d.text, &d.attachments, d.skills.as_deref(), d.files.as_deref())
                == crate::watcher::followup_digest(&save.text, &save.attachments, save.skills.as_deref(), save.files.as_deref())
        };
        let same_revision = match (&previous, &empty) {
            (Some(d), _) => d.draft_id == save.draft_id && d.text == save.text && d.request_id == save.request_id && digest_matches(d),
            (None, Some((id, request))) => *id == save.draft_id && *request == save.request_id && save.text.is_empty() && save.attachments.is_empty(),
            (None, None) => false,
        };
        if let Some(expected) = &save.expected {
            if self.current_id(&save.thread_id) != expected.as_deref() && !same_revision {
                return Err(CHANGED_ON_HOST.into());
            }
            let elsewhere = facts.elsewhere
                || self.drafts.iter().any(|d| d.draft_id == save.draft_id && d.thread_id != save.thread_id)
                || self.empty.iter().any(|(owner, (id, _))| *id == save.draft_id && *owner != save.thread_id)
                || self.obsolete.iter().any(|d| d.draft_id == save.draft_id && d.thread_id != save.thread_id);
            let reused = previous.as_ref().is_some_and(|d| d.draft_id == save.draft_id) || empty.as_ref().is_some_and(|(id, _)| *id == save.draft_id);
            if elsewhere || reused && !same_revision {
                return Err(OTHER_CONTENT.into());
            }
        }
        if previous.is_none() && !facts.thread_known {
            return Err("Select an available thread first.".into());
        }
        if facts.sent {
            return Ok(DraftSaved::AlreadySent);
        }
        if self.obsolete.iter().any(|d| d.thread_id == save.thread_id && d.draft_id == save.draft_id) {
            return Err(CLEARED.into());
        }
        if facts.submitted {
            return Err(SUBMITTED.into());
        }
        if let Some(held) = previous.as_ref().and_then(|d| d.request_id.clone()) {
            if Some(&held) != save.request_id.as_ref() && (!save.text.is_empty() || !save.attachments.is_empty()) {
                return Err(ANSWER_HELD.into());
            }
        }
        self.put(ThreadDraft {
            thread_id: save.thread_id,
            draft_id: save.draft_id,
            text: save.text,
            attachments: save.attachments,
            skills: save.skills,
            files: save.files,
            request_id: save.request_id,
            updated_at,
            extra: previous.map(|d| d.extra).unwrap_or_default(),
        });
        Ok(DraftSaved::Kept)
    }

    /// Puts a thread's draft in place of the one it had, as Node's `putThreadDraft`: the revision it replaces is
    /// obsolete, and an empty draft is kept only as its revision.
    fn put(&mut self, draft: ThreadDraft) {
        if let Some(previous) = self.current_id(&draft.thread_id).map(ToString::to_string) {
            if previous != draft.draft_id {
                self.make_obsolete(&draft.thread_id, &previous);
            }
        }
        self.drafts.retain(|d| d.thread_id != draft.thread_id);
        if draft.text.is_empty() && draft.attachments.is_empty() {
            self.empty.insert(draft.thread_id.clone(), (draft.draft_id, draft.request_id));
        } else {
            self.empty.remove(&draft.thread_id);
            self.drafts.push(draft);
        }
    }

    fn make_obsolete(&mut self, thread_id: &str, draft_id: &str) {
        self.obsolete.retain(|d| d.thread_id != thread_id || d.draft_id != draft_id);
        self.obsolete.push(DeliveredDraft { draft_id: draft_id.to_string(), thread_id: thread_id.to_string() });
        keep_newest(&mut self.obsolete);
    }

    /// Lets go of a thread's draft once its revision went as a prompt, as Node's state drops a draft its queue or
    /// delivery owns. Answers whether a draft went.
    pub fn sent(&mut self, thread_id: &str, draft_id: &str) -> bool {
        let before = self.drafts.len();
        self.drafts.retain(|d| d.thread_id != thread_id || d.draft_id != draft_id);
        before != self.drafts.len()
    }
}

/// Keeps the newest receipts, as many as `agents.json` holds (`trimReceipts`).
pub fn keep_newest(receipts: &mut Vec<DeliveredDraft>) {
    if receipts.len() > RECEIPTS_KEPT {
        receipts.drain(..receipts.len() - RECEIPTS_KEPT);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn save(draft: &str, text: &str) -> DraftSave {
        DraftSave { thread_id: "t".into(), draft_id: draft.into(), text: text.into(), ..DraftSave::default() }
    }

    fn known() -> DraftFacts {
        DraftFacts { thread_known: true, ..DraftFacts::default() }
    }

    /// A draft is kept, a newer revision replaces it and makes the old one obsolete, and a late save of the old one is
    /// refused; an empty revision is no draft.
    #[test]
    fn a_newer_revision_replaces_the_draft_for_good() {
        let mut drafts = ThreadDrafts::default();
        assert_eq!(drafts.save(save("a", "One"), known(), "t1".into()), Ok(DraftSaved::Kept));
        drafts.save(save("b", "Two"), known(), "t2".into()).unwrap();
        assert_eq!(drafts.published()[0]["text"], "Two");
        assert_eq!(drafts.published_obsolete(), json!([{ "draftId": "a", "threadId": "t" }]));
        assert_eq!(drafts.save(save("a", "One again"), known(), "t3".into()).unwrap_err(), CLEARED);
        drafts.save(save("c", ""), known(), "t4".into()).unwrap();
        assert_eq!(drafts.published(), json!([]));
    }

    /// With `draft-revisions`, a save names the revision it saw, and is refused when the host's moved on or when its
    /// revision is another draft's.
    #[test]
    fn a_save_naming_its_revision_is_checked_against_the_host() {
        let mut drafts = ThreadDrafts::default();
        drafts.save(save("a", "One"), known(), "t1".into()).unwrap();
        let stale = DraftSave { expected: Some(None), ..save("b", "Two") };
        assert_eq!(drafts.save(stale, known(), "t2".into()).unwrap_err(), CHANGED_ON_HOST);
        let current = DraftSave { expected: Some(Some("a".into())), ..save("b", "Two") };
        assert_eq!(drafts.save(current, known(), "t2".into()), Ok(DraftSaved::Kept));
        let reused = DraftSave { expected: Some(Some("b".into())), ..save("b", "Other words") };
        assert_eq!(drafts.save(reused, known(), "t3".into()).unwrap_err(), OTHER_CONTENT);
        let taken = DraftSave { expected: Some(Some("b".into())), ..save("x", "Elsewhere") };
        assert_eq!(drafts.save(taken, DraftFacts { elsewhere: true, ..known() }, "t4".into()).unwrap_err(), OTHER_CONTENT);
    }

    /// A revision already sent changes nothing, a submitted one is refused, an unknown thread is refused, and a draft
    /// answering a question keeps that question until it is cleared.
    #[test]
    fn sent_submitted_and_answering_drafts_are_kept_as_node_keeps_them() {
        let mut drafts = ThreadDrafts::default();
        assert_eq!(drafts.save(save("a", "Sent"), DraftFacts { sent: true, ..known() }, "t1".into()), Ok(DraftSaved::AlreadySent));
        assert_eq!(drafts.save(save("a", "Sent"), DraftFacts { submitted: true, ..known() }, "t1".into()).unwrap_err(), SUBMITTED);
        assert!(drafts.save(save("a", "Gone"), DraftFacts::default(), "t1".into()).is_err());
        let answer = DraftSave { request_id: Some("q".into()), ..save("b", "Yes") };
        drafts.save(answer, known(), "t2".into()).unwrap();
        assert_eq!(drafts.save(save("c", "Something else"), known(), "t3".into()).unwrap_err(), ANSWER_HELD);
        assert!(drafts.sent("t", "b"));
        assert_eq!(drafts.published(), json!([]));
    }

    /// Drafts, obsolete revisions and delivered ones read back from `agents.json` as they were written, unknown fields
    /// kept.
    #[test]
    fn drafts_round_trip_through_agents_json() {
        let mut agents = json!({
            "threadDrafts": [{ "threadId": "t", "draftId": "a", "text": "Kept", "attachments": [], "requestId": null, "updatedAt": "2026-11-26T00:00:00.000Z", "later": 1 }],
            "obsoleteDrafts": [{ "threadId": "t", "draftId": "z" }],
            "deliveredDrafts": [{ "threadId": "t", "draftId": "y" }],
            "other": true,
        }).as_object().unwrap().clone();
        let (drafts, delivered) = ThreadDrafts::take_saved(&mut agents);
        assert_eq!(delivered.len(), 1);
        assert_eq!(agents.keys().collect::<Vec<_>>(), ["other"]);
        drafts.save_into(&mut agents, &delivered);
        assert_eq!(agents["threadDrafts"][0]["later"], 1);
        assert_eq!(agents["threadDrafts"][0]["requestId"], Value::Null);
        assert_eq!((agents["obsoleteDrafts"][0]["draftId"].clone(), agents["deliveredDrafts"][0]["draftId"].clone()), (json!("z"), json!("y")));
    }
}
