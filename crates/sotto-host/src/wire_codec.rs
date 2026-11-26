use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::{json, Map, Value};

use sotto_core::activity_bodies::{cut_activity_bodies, strip_agent_steps, ACTIVITY_BODY_LIMIT};
use sotto_core::{
    diff_thread_detail, summarize_activity_for_wire, AgentThreadDetail, Observer, HOST_PROTOCOL_VERSION,
};

const READ_AHEAD_LIMIT: usize = 64;

const GATED_PROVIDERS: &[(&str, &str)] = &[
    ("opencode", "provider-opencode"),
    ("cursor", "provider-cursor"),
    ("deepseek", "provider-deepseek"),
    ("hermes", "provider-hermes"),
    ("antigravity", "provider-antigravity"),
];

#[derive(Clone)]
struct ReadAheadEntry {
    revision: u64,
    digest: String,
}

/// Per-WebSocket-connection protocol v1 wire encoder implementing `tests/referee/fold.ts` and
/// `docs/host-protocol.md` (capability filtering, `model-catalog-revision`, `changed-thread-records`,
/// `reply-thread-records`, `command-changed-thread-records`, `kept-parts`, `detail-delta`,
/// `detail-read-held`, and `activity-summaries`).
#[derive(Default)]
pub struct ClientWireState {
    /// Who this connection observes threads as, its own from the start, so the host can tell which threads each client
    /// shows.
    pub observer: Observer,
    /// Set by an `observe` with `shown: false`: a desktop behind another app, whose threads stay observed but none is
    /// shown (ADR-0092). Kept until its next `observe`, so its own `observe-threads` shows nothing either, as on Node.
    pub hidden: bool,
    pub hello_done: bool,
    pub accepts: HashSet<String>,
    pub observed: HashSet<String>,
    last_models_revision: Option<u64>,
    thread_records_revision: u64,
    last_threads: Option<Vec<Value>>,
    last_top: Option<Map<String, Value>>,
    last_host: Option<Map<String, Value>>,
    held_details: HashMap<String, AgentThreadDetail>,
    read_ahead: HashMap<String, ReadAheadEntry>,
    read_ahead_order: VecDeque<String>,
}

impl ClientWireState {
    pub fn apply_hello(&mut self, accepts: impl IntoIterator<Item = String>) {
        self.hello_done = true;
        self.accepts = accepts.into_iter().collect();
        self.last_models_revision = None;
        self.last_threads = None;
        self.last_top = None;
        self.last_host = None;
        // After a fresh hello, previously held details must be resent whole on next observe.
        self.held_details.clear();
        self.read_ahead.clear();
        self.read_ahead_order.clear();
    }

    pub fn has(&self, feature: &str) -> bool {
        self.accepts.contains(feature)
    }

    pub fn set_observed(&mut self, thread_ids: &[String]) {
        let next: HashSet<String> = thread_ids.iter().cloned().collect();
        self.held_details.retain(|tid, _| next.contains(tid));
        self.observed = next;
    }

    /// Whether this client is not sent threads of `provider`, since its hello does not accept that provider's feature.
    pub fn hides_provider(&self, provider: &str) -> bool {
        self.hidden_providers().contains(provider)
    }

    fn hidden_providers(&self) -> HashSet<&'static str> {
        GATED_PROVIDERS
            .iter()
            .filter(|(_, feat)| !self.has(feat))
            .map(|(prov, _)| *prov)
            .collect()
    }

    /// Filters gated providers and applies `model-catalog-revision` elision when the client
    /// already holds this exact catalog revision.
    fn filter_shell(&mut self, mut shell: Value, may_omit_catalog: bool) -> Value {
        let hidden = self.hidden_providers();
        if let Some(obj) = shell.as_object_mut() {
            if !hidden.is_empty() {
                if let Some(updates) = obj.get_mut("clientUpdates").and_then(Value::as_array_mut) {
                    updates.retain(|u| {
                        u.get("id")
                            .and_then(Value::as_str)
                            .is_none_or(|id| !hidden.contains(id))
                    });
                }
            }
            if let Some(host) = obj.get_mut("host").and_then(Value::as_object_mut) {
                if !hidden.is_empty() {
                    if let Some(provs) = host.get_mut("providers").and_then(Value::as_array_mut) {
                        provs.retain(|p| {
                            p.get("id")
                                .and_then(Value::as_str)
                                .is_none_or(|id| !hidden.contains(id))
                        });
                    }
                    if let Some(models) = host.get_mut("models").and_then(Value::as_array_mut) {
                        models.retain(|m| {
                            m.get("providerId")
                                .and_then(Value::as_str)
                                .is_none_or(|id| !hidden.contains(id))
                        });
                    }
                    if let Some(projects) = host.get_mut("projects").and_then(Value::as_array_mut) {
                        projects.retain(|p| {
                            p.get("providerId")
                                .and_then(Value::as_str)
                                .is_none_or(|id| !hidden.contains(id))
                        });
                    }
                    if let Some(threads) = host.get_mut("threads").and_then(Value::as_array_mut) {
                        threads.retain(|t| {
                            t.get("providerId")
                                .and_then(Value::as_str)
                                .is_none_or(|id| !hidden.contains(id))
                        });
                    }
                }

                if self.has("model-catalog-revision") {
                    if let Some(rev) = host.get("modelsRevision").and_then(Value::as_u64) {
                        if may_omit_catalog && self.last_models_revision == Some(rev) {
                            host.remove("models");
                        } else {
                            self.last_models_revision = Some(rev);
                        }
                    }
                } else {
                    host.remove("modelsRevision");
                }
            }
        }
        shell
    }

    /// Encodes the shell returned inside a `hello` or `shell` response.
    pub fn encode_reply_shell(&mut self, raw_shell: Value) -> Value {
        let mut shell = self.filter_shell(raw_shell, false);
        if self.has("reply-thread-records") {
            self.thread_records_revision += 1;
            let rev = self.thread_records_revision;
            let threads = shell
                .get("host")
                .and_then(|h| h.get("threads"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            self.last_threads = Some(threads);
            self.last_top = None;
            self.last_host = None;
            if let Some(obj) = shell.as_object_mut() {
                obj.insert("threadRecordsRevision".into(), Value::from(rev));
            }
        } else {
            self.last_threads = None;
            self.last_top = None;
            self.last_host = None;
        }
        shell
    }

    /// Encodes the shell returned inside a `command` response.
    pub fn encode_command_shell(&mut self, raw_shell: Value) -> Value {
        let mut shell = self.filter_shell(raw_shell, true);
        if self.has("command-changed-thread-records") {
            if let Some(ref prev_threads) = self.last_threads {
                let next_threads = shell
                    .get("host")
                    .and_then(|h| h.get("threads"))
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let wire_threads = build_thread_records_diff(
                    prev_threads,
                    &next_threads,
                    self.thread_records_revision,
                    self.thread_records_revision + 1,
                );
                if let Some(obj) = shell.as_object_mut() {
                    obj.insert("threadRecords".into(), wire_threads);
                    if let Some(host) = obj.get_mut("host").and_then(Value::as_object_mut) {
                        host.insert("threads".into(), Value::Array(Vec::new()));
                    }
                }
            }
        }
        shell
    }

    /// Encodes an async `event: "shell"` push frame for this connection.
    pub fn encode_shell_push(&mut self, raw_shell: Value) -> Value {
        let filtered = self.filter_shell(raw_shell, true);
        if !self.has("changed-thread-records") {
            return json!({
                "v": HOST_PROTOCOL_VERSION,
                "event": "shell",
                "state": filtered,
            });
        }

        let next_threads = filtered
            .get("host")
            .and_then(|h| h.get("threads"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let prev_rev = self.thread_records_revision;
        let next_rev = prev_rev + 1;
        let wire_threads = match self.last_threads.as_ref() {
            Some(prev) => build_thread_records_diff(prev, &next_threads, prev_rev, next_rev),
            None => json!({
                "revision": next_rev,
                "base": Value::Null,
                "changed": next_threads,
            }),
        };

        let mut wire_state = filtered.clone();
        if let Some(host) = wire_state.get_mut("host").and_then(Value::as_object_mut) {
            host.insert("threads".into(), Value::Array(Vec::new()));
        }

        // Apply `kept-parts` elision when we have a matching baseline from `prev_rev`.
        let final_state = if self.has("kept-parts") {
            if let (Some(prev_top), Some(prev_host)) = (&self.last_top, &self.last_host) {
                elide_kept_parts(&wire_state, prev_top, prev_host)
            } else {
                wire_state.clone()
            }
        } else {
            wire_state.clone()
        };

        self.thread_records_revision = next_rev;
        self.last_threads = Some(next_threads);
        if let Some(obj) = filtered.as_object() {
            let mut top = obj.clone();
            top.remove("host");
            self.last_top = Some(top);
            if let Some(host) = obj.get("host").and_then(Value::as_object) {
                let mut h = host.clone();
                h.remove("threads");
                self.last_host = Some(h);
            }
        }

        json!({
            "v": HOST_PROTOCOL_VERSION,
            "event": "shell",
            "state": final_state,
            "threads": wire_threads,
        })
    }

    /// Formats a thread detail for a direct `detail` read (applying `activity-summaries` if active)
    /// and updates this connection's held revision or `detail-read-held` cache so later deltas stay
    /// aligned with what the client cached.
    pub fn record_detail_read(&mut self, detail: &AgentThreadDetail) -> AgentThreadDetail {
        let formatted = self.format_detail(detail);
        if self.observed.contains(&formatted.thread_id) {
            self.held_details
                .insert(formatted.thread_id.clone(), formatted.clone());
        } else if self.has("detail-delta") && self.has("detail-read-held") {
            let digest = detail_content_digest(&formatted);
            self.read_ahead.insert(
                formatted.thread_id.clone(),
                ReadAheadEntry {
                    revision: formatted.revision,
                    digest,
                },
            );
            self.read_ahead_order.retain(|id| id != &formatted.thread_id);
            self.read_ahead_order.push_back(formatted.thread_id.clone());
            while self.read_ahead_order.len() > READ_AHEAD_LIMIT {
                if let Some(oldest) = self.read_ahead_order.pop_front() {
                    self.read_ahead.remove(&oldest);
                }
            }
        }
        formatted
    }

    /// Whether this client is sent records with cut bodies: a desktop that accepts `activity-bodies` and not summaries
    /// (ADR-0025, October 18 amendment), as Node's socket server decides at hello.
    pub fn takes_cut_bodies(&self) -> bool {
        self.has("activity-bodies") && !self.has("activity-summaries")
    }

    /// Formats a thread detail for this client: summaries when it accepts `activity-summaries`, records with cut bodies
    /// when it accepts `activity-bodies`, and the records whole otherwise. No record carries its agents' steps, which
    /// only the host's own sub-agent store reads, as Node's socket server sends them.
    pub fn format_detail(&self, detail: &AgentThreadDetail) -> AgentThreadDetail {
        let record_for_client: fn(&Value) -> Value = if self.takes_cut_bodies() {
            |record| cut_activity_bodies(record, ACTIVITY_BODY_LIMIT)
        } else if self.has("activity-summaries") {
            summarize_activity_for_wire
        } else {
            strip_agent_steps
        };
        AgentThreadDetail {
            thread_id: detail.thread_id.clone(),
            revision: detail.revision,
            messages: detail.messages.clone(),
            activities: detail.activities.iter().map(record_for_client).collect(),
            earlier_available: detail.earlier_available,
        }
    }

    /// Produces a push frame for a newly observed thread, honoring `detail-read-held` (#1990)
    /// when the client already read the exact same content just before observing.
    pub fn encode_observe_detail_push(
        &mut self,
        thread_id: &str,
        detail: Option<&AgentThreadDetail>,
    ) -> Option<Value> {
        let Some(detail) = detail else {
            self.held_details.remove(thread_id);
            self.read_ahead.remove(thread_id);
            return Some(json!({
                "v": HOST_PROTOCOL_VERSION,
                "event": "detail",
                "threadId": thread_id,
                "detail": Value::Null,
            }));
        };
        let formatted = self.format_detail(detail);
        if let Some(read) = self.read_ahead.get(thread_id).cloned() {
            if formatted.revision >= read.revision {
                self.read_ahead.remove(thread_id);
                if detail_content_digest(&formatted) == read.digest {
                    self.held_details
                        .insert(thread_id.to_string(), formatted.clone());
                    if formatted.revision == read.revision {
                        return None;
                    }
                    return Some(json!({
                        "v": HOST_PROTOCOL_VERSION,
                        "event": "detail-delta",
                        "threadId": thread_id,
                        "delta": {
                            "threadId": thread_id,
                            "baseRevision": read.revision,
                            "revision": formatted.revision,
                            "messageDeltas": [],
                            "activityDeltas": [],
                        },
                    }));
                }
            }
        }
        self.held_details
            .insert(thread_id.to_string(), formatted.clone());
        Some(json!({
            "v": HOST_PROTOCOL_VERSION,
            "event": "detail",
            "threadId": thread_id,
            "detail": formatted,
        }))
    }

    /// Encodes a live thread detail update for an observed thread, returning `None` if this client
    /// already holds `detail.revision` or newer (#2699).
    pub fn encode_detail_update_push(&mut self, detail: &AgentThreadDetail) -> Option<Value> {
        if !self.observed.contains(&detail.thread_id) {
            return None;
        }
        let formatted = self.format_detail(detail);
        if let Some(held) = self.held_details.get(&detail.thread_id) {
            if formatted.revision <= held.revision {
                return None;
            }
            if self.has("detail-delta") {
                if let Some(delta) = diff_thread_detail(held, &formatted) {
                    self.held_details
                        .insert(detail.thread_id.clone(), formatted);
                    return Some(json!({
                        "v": HOST_PROTOCOL_VERSION,
                        "event": "detail-delta",
                        "threadId": detail.thread_id,
                        "delta": delta,
                    }));
                }
            }
        }
        self.held_details
            .insert(detail.thread_id.clone(), formatted.clone());
        Some(json!({
            "v": HOST_PROTOCOL_VERSION,
            "event": "detail",
            "threadId": detail.thread_id,
            "detail": formatted,
        }))
    }
}

fn detail_content_digest(detail: &AgentThreadDetail) -> String {
    let mut copy = detail.clone();
    copy.revision = 0;
    let raw = serde_json::to_vec(&copy).unwrap_or_default();
    sotto_core::workspace::sha256_hex(&raw)
}

fn build_thread_records_diff(
    prev: &[Value],
    next: &[Value],
    base_rev: u64,
    next_rev: u64,
) -> Value {
    let prev_map: HashMap<&str, &Value> = prev
        .iter()
        .filter_map(|t| t.get("id").and_then(Value::as_str).map(|id| (id, t)))
        .collect();
    let next_ids: Vec<&str> = next
        .iter()
        .filter_map(|t| t.get("id").and_then(Value::as_str))
        .collect();
    let prev_ids: Vec<&str> = prev
        .iter()
        .filter_map(|t| t.get("id").and_then(Value::as_str))
        .collect();
    let next_set: HashSet<&str> = next_ids.iter().copied().collect();

    let changed: Vec<Value> = next
        .iter()
        .filter(|t| {
            t.get("id")
                .and_then(Value::as_str)
                .is_none_or(|id| prev_map.get(id).copied() != Some(*t))
        })
        .cloned()
        .collect();
    let removed: Vec<&str> = prev_ids
        .iter()
        .copied()
        .filter(|id| !next_set.contains(id))
        .collect();

    let mut obj = Map::new();
    obj.insert("revision".into(), Value::from(next_rev));
    obj.insert("base".into(), Value::from(base_rev));
    obj.insert("changed".into(), Value::Array(changed));
    if !removed.is_empty() {
        obj.insert(
            "removed".into(),
            Value::Array(removed.into_iter().map(Value::from).collect()),
        );
    }
    if prev_ids != next_ids {
        obj.insert(
            "order".into(),
            Value::Array(next_ids.into_iter().map(Value::from).collect()),
        );
    }
    Value::Object(obj)
}

fn elide_kept_parts(
    wire_state: &Value,
    prev_top: &Map<String, Value>,
    prev_host: &Map<String, Value>,
) -> Value {
    let Some(obj) = wire_state.as_object() else {
        return wire_state.clone();
    };
    let mut top = Map::new();
    let mut kept_top = Vec::new();
    for (k, v) in obj {
        if k == "host" {
            continue;
        }
        if prev_top.get(k) == Some(v) {
            kept_top.push(Value::String(k.clone()));
        } else {
            top.insert(k.clone(), v.clone());
        }
    }
    if !kept_top.is_empty() {
        top.insert("kept".into(), Value::Array(kept_top));
    }

    if let Some(host_obj) = obj.get("host").and_then(Value::as_object) {
        let mut host = Map::new();
        let mut kept_host = Vec::new();
        for (k, v) in host_obj {
            // Matching `SOCKET_HOST_SENT` in `src/host/socketServer.ts`: threads and catalog fields
            // are always carried directly rather than elided into `host.kept`.
            if matches!(
                k.as_str(),
                "threads" | "models" | "modelsRevision" | "providerModeLists"
            ) {
                host.insert(k.clone(), v.clone());
            } else if prev_host.get(k) == Some(v) {
                kept_host.push(Value::String(k.clone()));
            } else {
                host.insert(k.clone(), v.clone());
            }
        }
        if !kept_host.is_empty() {
            host.insert("kept".into(), Value::Array(kept_host));
        }
        top.insert("host".into(), Value::Object(host));
    }
    Value::Object(top)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn detail() -> AgentThreadDetail {
        let output: String = (0..400).map(|line| format!("out {line:04}\n")).collect();
        AgentThreadDetail {
            thread_id: "t".into(),
            revision: 1,
            messages: Vec::new(),
            activities: vec![json!({ "id": "a", "kind": "command", "title": "Ran it", "output": output })],
            earlier_available: None,
        }
    }

    fn client(accepts: &[&str]) -> ClientWireState {
        let mut wire = ClientWireState::default();
        wire.apply_hello(accepts.iter().map(ToString::to_string));
        wire
    }

    /// A desktop that accepts `activity-bodies` and not summaries is sent cut bodies; one that accepts summaries is sent
    /// summaries; any other client is sent the records whole, as Node's socket server decides (ADR-0025).
    #[test]
    fn each_client_is_sent_the_records_its_hello_accepts() {
        let whole = detail();
        let cut = client(&["activity-bodies"]).format_detail(&whole);
        assert!(cut.activities[0]["cut"]["output"].is_number());
        assert!(cut.activities[0]["output"].as_str().unwrap().len() <= sotto_core::activity_bodies::ACTIVITY_BODY_LIMIT);
        let summaries = client(&["activity-bodies", "activity-summaries"]).format_detail(&whole);
        assert!(summaries.activities[0].get("output").is_none() && summaries.activities[0].get("cut").is_none());
        assert_eq!(client(&[]).format_detail(&whole).activities, whole.activities);
    }

    /// No client is sent an agent's steps, whatever its hello accepts, as Node's socket server strips them.
    #[test]
    fn no_client_is_sent_agents_steps() {
        let mut with_steps = detail();
        with_steps.activities = vec![json!({ "id": "g", "kind": "agents", "agents": [{ "id": "x", "steps": [{ "id": "s" }] }] })];
        for accepts in [&[][..], &["activity-bodies"][..]] {
            assert!(client(accepts).format_detail(&with_steps).activities[0]["agents"][0].get("steps").is_none(), "{accepts:?}");
        }
    }

    /// A body that grows reaches a desktop that takes cut bodies as a delta carrying the record cut again.
    #[test]
    fn a_growing_body_is_sent_cut_in_its_delta() {
        let mut wire = client(&["activity-bodies", "detail-delta"]);
        wire.set_observed(&["t".to_string()]);
        let mut grown = detail();
        let first = wire.encode_detail_update_push(&grown).unwrap();
        assert_eq!(first["event"], "detail");
        let output: String = (0..800).map(|line| format!("out {line:04}\n")).collect();
        grown.revision = 2;
        grown.activities[0]["output"] = json!(output);
        let delta = wire.encode_detail_update_push(&grown).unwrap();
        assert_eq!(delta["event"], "detail-delta");
        let record = &delta["delta"]["activityDeltas"][0]["record"];
        assert_eq!(record["cut"]["output"], output.len());
        assert!(record["output"].as_str().unwrap().len() <= ACTIVITY_BODY_LIMIT);
    }
}
