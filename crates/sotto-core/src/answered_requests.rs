//! The questions this host has answered, as Node's coordinator keeps them (`answeredRequests` in
//! `src/main/agents/control.ts`): for each answer a provider took, its thread, provider, request, the digest of the
//! questions it answered and the answer's decision ID. It holds no question or answer text. A client that lost the
//! acknowledgement of its answer asks for its receipt by the command ID it sent, and the host tells it whether that
//! exact answer to those exact questions was given (`answer-receipts`, `src/shared/hostProtocol.ts`).
//!
//! The record is `agents.json`'s `answeredRequests`, oldest first, kept whether or not local history is on, as Node
//! keeps it, so a host that rolls back to Node still knows every answer it gave (ADR-0214).

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::protocol_fields::{is_digest, protocol_id};
use crate::workspace::{sha256_hex, ALL_PROVIDER_IDS};

/// The key of the record in `agents.json`.
pub const SAVED_KEY: &str = "answeredRequests";
/// How many answers are kept, newest last, as Node's `trimReceipts` keeps `MAX_DELIVERED_DRAFTS`.
pub const ANSWERED_REQUESTS_KEPT: usize = 128;
/// The most Node's schema reads (`MAX_DELIVERED_DRAFTS * 2`); a longer list would have Node refuse the whole file.
const ANSWERED_REQUESTS_READ: usize = ANSWERED_REQUESTS_KEPT * 2;

/// One exact answer attempt a client names: the thread, its provider, the request and the digest of its questions, as
/// Node's `hostAnswerTargetSchema` reads one. Never the question or the answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerTarget {
    pub thread_id: String,
    pub provider_id: String,
    pub request_id: String,
    pub questions_digest: String,
}

impl AnswerTarget {
    /// Reads a target as Node's strict schema does: these four fields and nothing else, each ID not empty and at most
    /// 512 UTF-16 code units, a provider Node names and a SHA-256 digest in lowercase hexadecimal.
    pub fn parse(value: &Value) -> Option<Self> {
        let fields = value.as_object()?;
        const KEYS: [&str; 4] = ["threadId", "providerId", "requestId", "questionsDigest"];
        if fields.keys().any(|key| !KEYS.contains(&key.as_str())) {
            return None;
        }
        let provider_id = fields.get("providerId")?.as_str().filter(|id| ALL_PROVIDER_IDS.contains(id))?;
        let questions_digest = fields.get("questionsDigest")?.as_str().filter(|digest| is_digest(digest))?;
        Some(Self {
            thread_id: protocol_id(fields.get("threadId"))?,
            provider_id: provider_id.to_string(),
            request_id: protocol_id(fields.get("requestId"))?,
            questions_digest: questions_digest.to_string(),
        })
    }

    /// The target with the decision ID the client sent it under, as an `acceptedAnswer` carries it.
    pub fn accepted(&self, decision_id: &str) -> Value {
        let mut accepted = serde_json::to_value(self).unwrap_or_else(|_| json!({}));
        accepted["decisionId"] = json!(decision_id);
        accepted
    }
}

/// The decision ID a socket client's answer is given under, as Node's `answerDecisionId`: the client and its command
/// ID, hashed, so one client cannot name another's answer.
pub fn answer_decision_id(client_id: &str, command_id: &str) -> String {
    let named = serde_json::to_string(&[client_id, command_id]).unwrap_or_default();
    format!("socket-answer:{}", sha256_hex(named.as_bytes()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OptionSignature<'a> {
    id: &'a str,
    label: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    preview: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QuestionSignature<'a> {
    id: &'a str,
    question: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    header: Option<&'a str>,
    options: Vec<OptionSignature<'a>>,
    multi_select: bool,
    allow_free_text: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    required: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unavailable_reason: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    prose: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    secret: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    skippable: Option<bool>,
}

/// An optional string field as zod reads `text.optional()`: absent, or a string. Anything else fails the read.
fn optional_text<'a>(fields: &'a Map<String, Value>, key: &str) -> Result<Option<&'a str>, ()> {
    match fields.get(key) {
        None => Ok(None),
        Some(Value::String(text)) => Ok(Some(text)),
        Some(_) => Err(()),
    }
}

/// An optional `z.literal(true)`: absent, or `true`.
fn optional_true(fields: &Map<String, Value>, key: &str) -> Result<Option<bool>, ()> {
    match fields.get(key) {
        None => Ok(None),
        Some(Value::Bool(true)) => Ok(Some(true)),
        Some(_) => Err(()),
    }
}

fn option_signature(option: &Value, with_details: bool) -> Option<OptionSignature<'_>> {
    let fields = option.as_object()?;
    Some(OptionSignature {
        id: fields.get("id")?.as_str()?,
        label: fields.get("label")?.as_str()?,
        description: if with_details { optional_text(fields, "description").ok()? } else { None },
        preview: if with_details { optional_text(fields, "preview").ok()? } else { None },
    })
}

fn question_signature(question: &Value) -> Option<QuestionSignature<'_>> {
    let fields = question.as_object()?;
    let options = fields.get("options")?.as_array()?.iter().map(|option| option_signature(option, true)).collect::<Option<Vec<_>>>()?;
    let required = match fields.get("required") {
        None => None,
        Some(Value::Bool(required)) => Some(*required),
        Some(_) => return None,
    };
    Some(QuestionSignature {
        id: fields.get("id")?.as_str()?,
        question: fields.get("question")?.as_str()?,
        header: optional_text(fields, "header").ok()?,
        options,
        multi_select: fields.get("multiSelect")?.as_bool()?,
        allow_free_text: fields.get("allowFreeText")?.as_bool()?,
        required,
        unavailable_reason: optional_text(fields, "unavailableReason").ok()?,
        prose: optional_true(fields, "prose").ok()?,
        secret: optional_true(fields, "secret").ok()?,
        skippable: optional_true(fields, "skippable").ok()?,
    })
}

/// The digest of a request's questions, as Node's `requestQuestionsDigest(requestDraftQuestions(request))`: a question
/// request's own questions, or its text and options as one question, written as Node's schema writes them and hashed.
/// None for a permission, for a question with nothing to answer, and for questions Node's schema would not read.
pub fn request_questions_digest(request: &Value) -> Option<String> {
    let fields = request.as_object()?;
    if fields.get("kind").and_then(Value::as_str) != Some("question") {
        return None;
    }
    let questions = fields.get("questions").and_then(Value::as_array).filter(|questions| !questions.is_empty());
    let signatures = match questions {
        Some(questions) => questions.iter().map(question_signature).collect::<Option<Vec<_>>>()?,
        None => {
            let options = fields.get("options").and_then(Value::as_array).filter(|options| !options.is_empty())?;
            vec![QuestionSignature {
                id: fields.get("id")?.as_str()?,
                question: fields.get("text")?.as_str()?,
                header: None,
                options: options.iter().map(|option| option_signature(option, false)).collect::<Option<Vec<_>>>()?,
                multi_select: false,
                allow_free_text: false,
                required: None,
                unavailable_reason: None,
                prose: None,
                secret: None,
                skippable: None,
            }]
        }
    };
    let signature = serde_json::to_string(&signatures).ok()?;
    Some(sha256_hex(signature.as_bytes()))
}

/// One answer a provider took.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnsweredRequest {
    pub thread_id: String,
    pub provider: String,
    pub request_id: String,
    pub questions_digest: String,
    pub decision_id: Option<String>,
}

impl AnsweredRequest {
    fn read(saved: &Value) -> Option<Self> {
        let fields = saved.as_object()?;
        let text = |key: &str| fields.get(key).and_then(Value::as_str).map(ToString::to_string);
        let decision_id = match fields.get("decisionId") {
            None => None,
            Some(Value::String(id)) => Some(id.clone()),
            Some(_) => return None,
        };
        Some(Self {
            thread_id: text("threadId")?,
            provider: text("provider").filter(|id| ALL_PROVIDER_IDS.contains(&id.as_str()))?,
            request_id: text("requestId")?,
            questions_digest: text("questionsDigest")?,
            decision_id,
        })
    }

    fn saved(&self) -> Value {
        let mut saved = json!({ "threadId": self.thread_id, "provider": self.provider, "requestId": self.request_id, "questionsDigest": self.questions_digest });
        if let Some(decision_id) = &self.decision_id {
            saved["decisionId"] = json!(decision_id);
        }
        saved
    }
}

#[derive(Debug, Default)]
pub struct AnsweredRequests {
    items: Vec<AnsweredRequest>,
}

impl AnsweredRequests {
    /// Takes the saved answers out of `agents.json`'s other fields. An entry Node would not read is dropped, since Node
    /// would refuse the whole file over it, and so is any beyond the most Node reads, oldest first.
    pub fn take_saved(agents_json: &mut Map<String, Value>) -> Self {
        let mut items: Vec<AnsweredRequest> = match agents_json.remove(SAVED_KEY) {
            Some(Value::Array(saved)) => saved.iter().filter_map(AnsweredRequest::read).collect(),
            _ => Vec::new(),
        };
        if items.len() > ANSWERED_REQUESTS_READ {
            items.drain(..items.len() - ANSWERED_REQUESTS_READ);
        }
        Self { items }
    }

    /// The answers as `agents.json` keeps them, oldest first.
    pub fn saved(&self) -> Value {
        Value::Array(self.items.iter().map(AnsweredRequest::saved).collect())
    }

    /// Keeps one answer the provider took, newest last: the same answer recorded again moves to the end, and the oldest
    /// go past `ANSWERED_REQUESTS_KEPT`, as Node's `recordAnsweredRequest` keeps them.
    pub fn record(&mut self, answered: AnsweredRequest) {
        self.items.retain(|item| *item != answered);
        self.items.push(answered);
        if self.items.len() > ANSWERED_REQUESTS_KEPT {
            self.items.drain(..self.items.len() - ANSWERED_REQUESTS_KEPT);
        }
    }

    /// Whether the provider took this exact answer: the same thread, provider, request and questions, given under the
    /// decision ID this client's command was sent under, as Node's socket server reads `requestAnswerRecovery`.
    pub fn accepted(&self, target: &AnswerTarget, decision_id: &str) -> bool {
        self.items.iter().any(|item| {
            item.thread_id == target.thread_id
                && item.provider == target.provider_id
                && item.request_id == target.request_id
                && item.questions_digest == target.questions_digest
                && item.decision_id.as_deref() == Some(decision_id)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIGEST: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn target() -> AnswerTarget {
        AnswerTarget { thread_id: "t-1".into(), provider_id: "codex".into(), request_id: "r-1".into(), questions_digest: DIGEST.into() }
    }

    fn answered(request_id: &str, decision_id: Option<&str>) -> AnsweredRequest {
        AnsweredRequest { thread_id: "t-1".into(), provider: "codex".into(), request_id: request_id.into(), questions_digest: DIGEST.into(), decision_id: decision_id.map(Into::into) }
    }

    #[test]
    fn a_target_is_read_as_nodes_strict_schema_reads_it() {
        let wire = json!({ "threadId": "t-1", "providerId": "codex", "requestId": "r-1", "questionsDigest": DIGEST });
        assert_eq!(AnswerTarget::parse(&wire), Some(target()));
        let mut extra = wire.clone();
        extra["answer"] = json!("Blue");
        assert_eq!(AnswerTarget::parse(&extra), None, "a field Node's strict schema does not name");
        for (key, bad) in [("providerId", json!("someone")), ("questionsDigest", json!(DIGEST.to_uppercase())), ("questionsDigest", json!("ab")), ("threadId", json!("")), ("requestId", json!(1))] {
            let mut wrong = wire.clone();
            wrong[key] = bad;
            assert_eq!(AnswerTarget::parse(&wrong), None, "{key}");
        }
        let mut missing = wire.as_object().unwrap().clone();
        missing.remove("requestId");
        assert_eq!(AnswerTarget::parse(&Value::Object(missing)), None);
        assert_eq!(target().accepted("c-1"), json!({ "threadId": "t-1", "providerId": "codex", "requestId": "r-1", "questionsDigest": DIGEST, "decisionId": "c-1" }));
    }

    #[test]
    fn a_decision_id_is_nodes_for_the_same_client_and_command() {
        // `'socket-answer:' + sha256(JSON.stringify(['client-1', 'command-1']))`, as Node computes it.
        assert_eq!(answer_decision_id("client-1", "command-1"), format!("socket-answer:{}", sha256_hex(br#"["client-1","command-1"]"#)));
        assert_ne!(answer_decision_id("client-1", "command-1"), answer_decision_id("client-2", "command-1"));
    }

    #[test]
    fn the_questions_digest_is_nodes() {
        // Node: requestQuestionsDigest(requestDraftQuestions(request)) for these two requests, computed with
        // `createHash('sha256').update(JSON.stringify(agentRequestSchema.shape.questions.unwrap().parse(questions)))`.
        let form = json!({ "id": "r-1", "kind": "question", "text": "Pick", "options": [], "questions": [{
            "skippable": true, "allowFreeText": true, "multiSelect": false, "id": "q-1", "question": "Colour?", "header": "Colour",
            "options": [{ "label": "Blue", "id": "blue", "description": "Calm", "later": 1 }], "laterField": "dropped" }] });
        let written = r#"[{"id":"q-1","question":"Colour?","header":"Colour","options":[{"id":"blue","label":"Blue","description":"Calm"}],"multiSelect":false,"allowFreeText":true,"skippable":true}]"#;
        assert_eq!(request_questions_digest(&form), Some(sha256_hex(written.as_bytes())));
        assert_eq!(request_questions_digest(&form).unwrap(), "dd4713d21de317b26809aa32f9e53c2d99659552b28eba774368739993227d58");
        let plain = json!({ "id": "r-2", "kind": "question", "text": "Go on?", "options": [{ "id": "yes", "label": "Yes", "description": "dropped" }] });
        let written = r#"[{"id":"r-2","question":"Go on?","options":[{"id":"yes","label":"Yes"}],"multiSelect":false,"allowFreeText":false}]"#;
        assert_eq!(request_questions_digest(&plain), Some(sha256_hex(written.as_bytes())));
        assert_eq!(request_questions_digest(&plain).unwrap(), "f24593d07f1c7a89c6ae944a64b215f8891e20b83af1415630ae2053ad676455");
        assert_eq!(request_questions_digest(&json!({ "id": "r-3", "kind": "permission", "text": "Run?", "options": [{ "id": "y", "label": "Y" }] })), None);
        assert_eq!(request_questions_digest(&json!({ "id": "r-4", "kind": "question", "text": "Say", "options": [] })), None, "nothing to answer");
        let mut changed = form.clone();
        changed["questions"][0]["question"] = json!("Color?");
        assert_ne!(request_questions_digest(&changed), request_questions_digest(&form));
        let mut unread = form;
        unread["questions"][0]["secret"] = json!(false);
        assert_eq!(request_questions_digest(&unread), None, "a mark Node's schema refuses");
    }

    #[test]
    fn an_answer_is_accepted_only_for_its_exact_target_and_decision() {
        let mut record = AnsweredRequests::default();
        record.record(answered("r-1", Some("d-1")));
        assert!(record.accepted(&target(), "d-1"));
        assert!(!record.accepted(&target(), "d-2"), "another client's command");
        assert!(!record.accepted(&AnswerTarget { questions_digest: "f".repeat(64), ..target() }, "d-1"), "changed questions");
        assert!(!record.accepted(&AnswerTarget { provider_id: "claude".into(), ..target() }, "d-1"));
        assert!(!record.accepted(&AnswerTarget { request_id: "r-9".into(), ..target() }, "d-1"), "an unknown request");
    }

    #[test]
    fn the_record_keeps_the_newest_and_survives_a_trip_through_agents_json() {
        let mut record = AnsweredRequests::default();
        for n in 0..ANSWERED_REQUESTS_KEPT + 5 {
            record.record(answered(&format!("r-{n}"), Some(&format!("d-{n}"))));
        }
        record.record(answered("r-10", Some("d-10")));
        let saved = record.saved();
        let items = saved.as_array().unwrap();
        assert_eq!(items.len(), ANSWERED_REQUESTS_KEPT);
        assert_eq!(items[0]["requestId"], "r-5", "the oldest went, and r-10 moved rather than counting twice");
        assert_eq!(items.last().unwrap()["requestId"], "r-10", "recorded again, it moved to the end");
        // Node's saved shape, and what Node would refuse dropped on the way in.
        let mut agents_json = Map::new();
        let mut entries = items.clone();
        entries.push(json!({ "threadId": "t-1", "provider": "nobody", "requestId": "r", "questionsDigest": DIGEST }));
        entries.push(json!({ "threadId": "t-1", "provider": "codex", "requestId": "r-old", "questionsDigest": DIGEST }));
        agents_json.insert(SAVED_KEY.into(), Value::Array(entries));
        agents_json.insert("laterField".into(), json!(1));
        let reread = AnsweredRequests::take_saved(&mut agents_json);
        assert!(!agents_json.contains_key(SAVED_KEY) && agents_json.contains_key("laterField"));
        let resaved = reread.saved();
        assert_eq!(resaved.as_array().unwrap().len(), ANSWERED_REQUESTS_KEPT + 1);
        assert_eq!(resaved[ANSWERED_REQUESTS_KEPT], json!({ "threadId": "t-1", "provider": "codex", "requestId": "r-old", "questionsDigest": DIGEST }), "no decision ID, as an older Node saved it");
        assert!(reread.accepted(&AnswerTarget { request_id: "r-10".into(), ..target() }, "d-10"));
    }
}
