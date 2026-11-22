use std::collections::{HashMap, HashSet};

use serde_json::{json, Map, Value};

use sotto_core::{
    diff_thread_detail, summarize_activity_for_wire, AgentThreadDetail, HOST_PROTOCOL_VERSION,
};

const GATED_PROVIDERS: &[(&str, &str)] = &[
    ("opencode", "provider-opencode"),
    ("cursor", "provider-cursor"),
    ("deepseek", "provider-deepseek"),
    ("hermes", "provider-hermes"),
    ("antigravity", "provider-antigravity"),
];

/// Per-WebSocket-connection protocol v1 wire encoder implementing `tests/referee/fold.ts` and
/// `docs/host-protocol.md` (capability filtering, `model-catalog-revision`, `changed-thread-records`,
/// `reply-thread-records`, `command-changed-thread-records`, `kept-parts`, `detail-delta`, and
/// `activity-summaries`).
#[derive(Default)]
pub struct ClientWireState {
    pub hello_done: bool,
    pub accepts: HashSet<String>,
    pub observed: HashSet<String>,
    last_models_revision: Option<u64>,
    thread_records_revision: u64,
    last_threads: Option<Vec<Value>>,
    last_top: Option<Map<String, Value>>,
    last_host: Option<Map<String, Value>>,
    held_details: HashMap<String, AgentThreadDetail>,
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
    }

    pub fn has(&self, feature: &str) -> bool {
        self.accepts.contains(feature)
    }

    pub fn set_observed(&mut self, thread_ids: &[String]) {
        let next: HashSet<String> = thread_ids.iter().cloned().collect();
        self.held_details.retain(|tid, _| next.contains(tid));
        self.observed = next;
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
                        host.remove("threads");
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
            host.remove("threads");
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

    /// Formats a thread detail for a direct `detail` read (applying `activity-summaries` if active).
    pub fn format_detail(&self, detail: &AgentThreadDetail) -> AgentThreadDetail {
        if !self.has("activity-summaries") {
            return detail.clone();
        }
        AgentThreadDetail {
            activities: detail
                .activities
                .iter()
                .map(summarize_activity_for_wire)
                .collect(),
            ..detail.clone()
        }
    }

    /// Produces a whole `event: "detail"` push for `observe` (always sent when newly observed),
    /// recording the held revision so subsequent updates send deltas or skip duplicates.
    pub fn encode_observe_detail_push(
        &mut self,
        thread_id: &str,
        detail: Option<&AgentThreadDetail>,
    ) -> Value {
        let Some(detail) = detail else {
            self.held_details.remove(thread_id);
            return json!({
                "v": HOST_PROTOCOL_VERSION,
                "event": "detail",
                "threadId": thread_id,
                "detail": Value::Null,
            });
        };
        let formatted = self.format_detail(detail);
        self.held_details
            .insert(thread_id.to_string(), formatted.clone());
        json!({
            "v": HOST_PROTOCOL_VERSION,
            "event": "detail",
            "threadId": thread_id,
            "detail": formatted,
        })
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
            if prev_host.get(k) == Some(v) {
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
