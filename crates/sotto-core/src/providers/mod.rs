pub mod acp;
pub mod claude;
pub mod claude_history;
pub mod codex;
pub mod muse;
pub mod opencode;

pub use acp::{AcpAdapter, AcpAdapterConfig, AcpFlavor};
pub use claude::{ClaudeAdapter, ClaudeAdapterConfig};
pub use claude_history::{
    claude_project_dir, fork_claude_session, read_claude_session_transcript, ClaudeTranscriptMessage,
};
pub use codex::{CodexAdapter, CodexAdapterConfig};
pub use muse::{MuseAdapter, MuseAdapterConfig};
pub use opencode::{OpenCodeAdapter, OpenCodeAdapterConfig};

pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// Node's key for each thread in one provider's store, where it is not the thread's Sotto ID (ADR-0002, ADR-0214).
/// Node's `ThreadRegistry` binds each Sotto thread to the provider adapter's own ID for it, and the adapter keys its
/// `<provider>-threads.json` by that ID; `threads.json` beside the store holds the bindings. This host keys its records
/// by the Sotto thread ID, so a thread Node made is read and written under Node's key. A thread this host made is bound
/// to its own ID and needs nothing.
#[derive(Default)]
pub(crate) struct StoreKeys {
    to_disk: std::collections::HashMap<String, String>,
    to_sotto: std::collections::HashMap<String, String>,
}

impl StoreKeys {
    pub(crate) fn of(path: &std::path::Path) -> Self {
        use serde_json::Value;
        let mut keys = Self::default();
        let Some(provider) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix("-threads.json")) else {
            return keys;
        };
        let Some(registry) = std::fs::read_to_string(path.with_file_name("threads.json"))
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        else {
            return keys;
        };
        for binding in registry.get("bindings").and_then(Value::as_array).into_iter().flatten() {
            let text = |key: &str| binding.get(key).and_then(Value::as_str);
            let (Some(thread_id), Some(session_id)) = (text("threadId"), text("sessionId")) else { continue };
            // Node keeps the first of two rows for one thread or one session, and so does this host.
            if text("provider") != Some(provider) || thread_id == session_id
                || keys.to_disk.contains_key(thread_id) || keys.to_sotto.contains_key(session_id) {
                continue;
            }
            keys.to_disk.insert(thread_id.to_string(), session_id.to_string());
            keys.to_sotto.insert(session_id.to_string(), thread_id.to_string());
        }
        keys
    }

    /// The key a thread's record has on disk.
    pub(crate) fn disk<'a>(&'a self, sotto_id: &'a str) -> &'a str {
        self.to_disk.get(sotto_id).map_or(sotto_id, String::as_str)
    }

    /// The Sotto thread a key on disk is the record of.
    pub(crate) fn sotto<'a>(&'a self, disk_key: &'a str) -> &'a str {
        self.to_sotto.get(disk_key).map_or(disk_key, String::as_str)
    }
}

/// Reads a provider's `*-threads.json` the way Node's `AtomicJsonStore` writes it (ADR-0214): one record per provider
/// thread, which the Node host and this one share over the same data folder, returned by Sotto thread ID (`StoreKeys`).
/// Each entry is read on its own, so one this build cannot read costs only that entry, and `save_thread_records` writes
/// it back untouched. A file that is not a JSON object is moved aside as `<name>.corrupt-<millis>`, as Node does, rather
/// than overwritten by the next save.
pub(crate) fn load_thread_records<T>(path: &std::path::Path, parse: impl Fn(&serde_json::Value) -> Option<T>) -> std::collections::HashMap<String, T> {
    let mut out = std::collections::HashMap::new();
    let Ok(raw) = std::fs::read_to_string(path) else {
        return out;
    };
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(serde_json::Value::Object(map)) => {
            let keys = StoreKeys::of(path);
            for (disk_key, value) in &map {
                let sotto_id = keys.sotto(disk_key);
                // A record under the Sotto ID of a thread Node bound to another key is a stray an earlier build made.
                // It is never read, so it can never be written over the record under Node's key, which may be one Node
                // made before the thread had a session.
                if keys.disk(sotto_id) != disk_key {
                    continue;
                }
                if let Some(record) = parse(value) {
                    out.insert(sotto_id.to_string(), record);
                }
            }
        }
        _ => {
            let _ = std::fs::rename(path, crate::workspace::corrupt_copy_path(path));
        }
    }
    out
}

/// Writes a provider's `*-threads.json` whole: every record this host holds, under its key on disk (`StoreKeys`) and
/// encoded with every field it read, and every entry on disk it could not read or does not write, as it was, so a Node
/// record this build does not understand survives a Rust host and a rollback to Node (ADR-0214). A record it can read
/// and no longer holds is one it removed, and is not written.
pub(crate) fn save_thread_records<T>(
    path: &std::path::Path,
    records: &std::collections::HashMap<String, T>,
    parse: impl Fn(&serde_json::Value) -> Option<T>,
    encode: impl Fn(&T) -> serde_json::Value,
) {
    let keys = StoreKeys::of(path);
    let mut out = serde_json::Map::new();
    if let Ok(raw) = std::fs::read_to_string(path) {
        if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(&raw) {
            for (disk_key, value) in map {
                let sotto_id = keys.sotto(&disk_key);
                let stray = keys.disk(sotto_id) != disk_key;
                if stray || (!records.contains_key(sotto_id) && parse(&value).is_none()) {
                    out.insert(disk_key, value);
                }
            }
        }
    }
    for (sotto_id, record) in records {
        out.insert(keys.disk(sotto_id).to_string(), encode(record));
    }
    let _ = crate::workspace::write_atomic_json(path, &serde_json::Value::Object(out));
}

/// The fields a record this host creates for `thread_id` starts from, so Node reads it after a rollback (ADR-0214). An
/// entry already on disk for the thread is kept whole: a Node record with no session yet, which this host cannot read.
/// What Node's schema requires and the entry lacks comes from the thread (`projectId`, `title`, `createdAt`, no
/// `origins`) and then from `defaults`, the provider's own fields with the value Node gives a session this host made.
pub(crate) fn node_record_fields(
    path: &std::path::Path,
    thread_id: &str,
    seed: &crate::provider::ThreadRecordSeed,
    defaults: &[(&str, serde_json::Value)],
) -> serde_json::Map<String, serde_json::Value> {
    use serde_json::Value;
    let keys = StoreKeys::of(path);
    let mut fields = std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|store| store.get(keys.disk(thread_id)).and_then(Value::as_object).cloned())
        .unwrap_or_default();
    if fields.get("kind").and_then(Value::as_str) != Some("personal") && !seed.project_id.is_empty() {
        fields.entry("projectId").or_insert_with(|| Value::String(seed.project_id.clone()));
    }
    fields.entry("title").or_insert_with(|| Value::String(seed.title.clone()));
    let created_at = if seed.created_at.is_empty() { crate::workspace::now_iso() } else { seed.created_at.clone() };
    fields.entry("createdAt").or_insert(Value::String(created_at));
    fields.entry("origins").or_insert_with(|| Value::Array(Vec::new()));
    for (key, value) in defaults {
        fields.entry(key.to_string()).or_insert_with(|| value.clone());
    }
    fields
}

/// `record` with Node's `fields` under it: what `record` sets wins, and the rest land in its flattened `extra`, so
/// nothing it models is written twice.
pub(crate) fn with_node_fields<T: serde::Serialize + serde::de::DeserializeOwned>(
    record: T,
    mut fields: serde_json::Map<String, serde_json::Value>,
) -> T {
    if let Ok(serde_json::Value::Object(own)) = serde_json::to_value(&record) {
        fields.extend(own);
    }
    parse_serde_record(&serde_json::Value::Object(fields)).unwrap_or(record)
}

/// The serde form of `load_thread_records` and `save_thread_records`' record functions, for a record that derives serde.
pub(crate) fn parse_serde_record<T: serde::de::DeserializeOwned>(value: &serde_json::Value) -> Option<T> {
    serde_json::from_value(value.clone()).ok()
}
pub(crate) fn encode_serde_record<T: serde::Serialize>(record: &T) -> serde_json::Value {
    serde_json::to_value(record).unwrap_or(serde_json::Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::path::Path;

    /// A Rust host's whole life with a store: read it at start, and write it whole at its next save.
    fn load_and_save<T>(path: &Path, parse: impl Fn(&Value) -> Option<T> + Copy, encode: impl Fn(&T) -> Value) {
        let records = load_thread_records(path, parse);
        save_thread_records(path, &records, parse, encode);
    }

    type Trip = Box<dyn Fn(&Path)>;

    fn acp(flavor: AcpFlavor) -> Trip {
        Box::new(move |path| load_and_save(path, |value| acp::AcpThreadRecord::parse(flavor, value), |record| record.encode(flavor)))
    }

    /// Every provider store a Rust host shares with Node, its session ID field, and its Rust load and save.
    fn stores() -> Vec<(&'static str, &'static str, Trip)> {
        vec![
            ("claude-threads.json", "sessionId", Box::new(|path| load_and_save(path, parse_serde_record::<claude::ClaudeThreadRecord>, encode_serde_record))),
            ("codex-threads.json", "codexThreadId", Box::new(|path| load_and_save(path, parse_serde_record::<codex::CodexThreadRecord>, encode_serde_record))),
            ("muse-threads.json", "museSessionId", Box::new(|path| load_and_save(path, parse_serde_record::<muse::MuseThreadRecord>, encode_serde_record))),
            ("opencode-threads.json", "sessionId", Box::new(|path| load_and_save(path, parse_serde_record::<opencode::OpenCodeThreadRecord>, encode_serde_record))),
            ("grok-threads.json", "grokSessionId", acp(AcpFlavor::Grok)),
            ("devin-threads.json", "devinSessionId", acp(AcpFlavor::Devin)),
            ("cursor-threads.json", "cursorSessionId", acp(AcpFlavor::Cursor)),
            ("antigravity-threads.json", "antigravitySessionId", acp(AcpFlavor::Antigravity)),
            ("hermes-threads.json", "hermesSessionId", acp(AcpFlavor::Hermes)),
        ]
    }

    /// Whether `outer` holds everything `inner` does: every key of an object with the same value, anything else equal.
    fn holds(outer: &Value, inner: &Value) -> bool {
        match (outer, inner) {
            (Value::Object(o), Value::Object(i)) => i.iter().all(|(key, value)| o.get(key).is_some_and(|held| holds(held, value))),
            _ => outer == inner,
        }
    }

    /// A store as Node writes it: a thread with every field Node keeps, and one with no session yet, which Rust cannot read.
    fn node_store(session_field: &str) -> Value {
        json!({
            "6f1c2d3e-4b5a-4c6d-8e7f-001122334455": {
                session_field: "1b4e28ba-2fa1-41d2-883f-0016d3cca427",
                "projectId": "project-1",
                "cwd": "/home/zach/work",
                "title": "Fix the build",
                "modelId": "model-1",
                "reasoningEffort": "high",
                "runtimeMode": "auto",
                "createdAt": "2026-11-20T10:00:00.000Z",
                "lineage": [{ "sessionId": "2c5f39cb-3a52-42e3-994e-1127e4ddb538" }],
                "origins": [{ "messageId": "m-1", "commandId": "c-1" }],
                "answeredRequestIds": ["r-1"],
            },
            "7a2b3c4d-5e6f-4a7b-9c8d-112233445566": {
                "projectId": "project-1",
                "cwd": "/home/zach/work",
                "title": "Not started yet",
                "modelId": "model-1",
                "createdAt": "2026-11-21T10:00:00.000Z",
            },
        })
    }

    /// Node -> Rust -> Node for every shared provider store (ADR-0214): a Rust host's load and save keeps every field of
    /// every record Node wrote, and every entry it cannot read, so a rollback to Node never quarantines a store. On forge a
    /// Rust save once stripped 208 Claude records to six fields, and Node then refused the whole file. With
    /// `SOTTO_SHARED_STORES_DIR` set, the stores in that folder are the ones Node wrote, for
    /// `tests/integration/rustHostThreadStoreRollback.test.ts` to read back with Node's own parsers.
    #[test]
    fn node_thread_stores_survive_a_rust_load_and_save() {
        let dir = tempfile::tempdir().unwrap();
        let shared = crate::store_trip::shared_dir();
        let base = shared.clone().unwrap_or_else(|| dir.path().to_path_buf());
        for (file, session_field, trip) in stores() {
            let path = base.join(file);
            if shared.is_none() {
                std::fs::write(&path, serde_json::to_string_pretty(&node_store(session_field)).unwrap()).unwrap();
            }
            let before: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            trip(&path);
            let after: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            assert!(holds(&after, &before), "{file} lost a field Node wrote:\nbefore {before}\nafter {after}");
        }
    }

    fn seed() -> crate::provider::ThreadRecordSeed {
        crate::provider::ThreadRecordSeed {
            project_id: "project-1".into(),
            title: "Fix the build".into(),
            created_at: "2026-11-20T10:00:00.000Z".into(),
        }
    }

    /// A send that makes a thread's session, as the coordinator asks for it.
    fn send(thread_id: &str) -> crate::provider::SendMessageRequest {
        crate::provider::SendMessageRequest {
            thread_id: thread_id.into(),
            record_seed: seed(),
            message_id: "m-1".into(),
            cwd: "/home/zach/work".into(),
            model_id: Some("model-1".into()),
            reasoning_effort: None,
            runtime_mode: Some("approval-required".into()),
            text: "Hello".into(),
            command_id: "c-1".into(),
            draft_id: "d-1".into(),
            attachments: Vec::new(),
        }
    }

    /// A thread Node made and never sent to has a record with no session, which this host cannot read. The record this
    /// host makes when it starts the session keeps that one whole and adds only what it lacks.
    #[test]
    fn a_node_record_with_no_session_yet_is_kept_whole_when_this_host_starts_its_session() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode-threads.json");
        let waiting = json!({ "projectId": "project-node", "cwd": "/w", "title": "Named in Node", "modelId": "model-1",
            "createdAt": "2026-11-19T10:00:00.000Z", "createToken": "token-node", "origins": [{ "messageId": "m-0" }] });
        std::fs::write(&path, json!({ "t-1": waiting }).to_string()).unwrap();

        let fields = node_record_fields(&path, "t-1", &seed(), &[("createToken", json!("token-rust")), ("sessionConfirmed", json!(false))]);
        assert!(crate::store_trip::holds(&Value::Object(fields.clone()), &waiting), "lost what Node wrote: {fields:?}");
        assert_eq!(fields["sessionConfirmed"], false);

        let fresh = node_record_fields(&path, "t-2", &seed(), &[]);
        assert_eq!(Value::Object(fresh), json!({ "projectId": "project-1", "title": "Fix the build", "createdAt": "2026-11-20T10:00:00.000Z", "origins": [] }));
    }

    #[test]
    fn a_record_with_node_fields_writes_each_field_once_with_its_own_value() {
        let record: codex::CodexThreadRecord = parse_serde_record(&json!({ "codexThreadId": "t", "cwd": "/w", "modelId": "new" })).unwrap();
        let mut fields = serde_json::Map::new();
        fields.insert("modelId".into(), json!("old"));
        fields.insert("projectId".into(), json!("project-1"));
        let merged = with_node_fields(record, fields);
        let encoded = encode_serde_record(&merged);
        assert_eq!(encoded["modelId"], "new");
        assert_eq!(encoded["projectId"], "project-1");
        assert_eq!(serde_json::to_string(&merged).unwrap().matches("modelId").count(), 1);
    }

    /// The record this host makes for each ACP provider carries what Node's schema requires. With
    /// `SOTTO_SHARED_STORES_DIR` set, the stores are written there for `rustHostThreadStoreRollback.test.ts` to read
    /// with Node's own parsers; Hermes has no fake to drive, so this is where its record is checked.
    #[test]
    fn rust_created_acp_records_carry_what_node_requires() {
        let own = tempfile::tempdir().unwrap();
        let dir = crate::store_trip::shared_dir().unwrap_or_else(|| own.path().to_path_buf());
        for flavor in [AcpFlavor::Grok, AcpFlavor::Devin, AcpFlavor::Cursor, AcpFlavor::Antigravity, AcpFlavor::Hermes] {
            let thread = "6f1c2d3e-4b5a-4c6d-8e7f-001122334455";
            let record = acp::AcpThreadRecord::created(flavor, &dir, &send(thread), "1b4e28ba-2fa1-41d2-883f-0016d3cca427".into());
            let path = dir.join(flavor.threads_file());
            let parse = |value: &Value| acp::AcpThreadRecord::parse(flavor, value);
            save_thread_records(&path, &std::collections::HashMap::from([(thread.to_string(), record)]), parse, |r| r.encode(flavor));
            let saved: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let entry = &saved[thread];
            for key in ["projectId", "title", "createdAt", "origins", "modelId", "cwd", flavor.session_id_field()] {
                assert!(entry.get(key).is_some(), "{} record has no {key}: {entry}", flavor.threads_file());
            }
        }
    }

    /// Node keys a provider store by the adapter's own ID for each thread, which `threads.json` binds to the Sotto thread.
    /// On forge none of Node's threads matched a Rust lookup by Sotto ID, so every send there began a fresh session.
    #[test]
    fn a_thread_node_made_is_read_and_written_under_nodes_key_for_it() {
        let dir = tempfile::tempdir().unwrap();
        let (thread, node_key, rust_thread) = ("sotto-thread-1", "adapter-key-1", "sotto-thread-2");
        std::fs::write(dir.path().join("threads.json"), json!({ "bindings": [
            { "threadId": thread, "provider": "codex", "sessionId": node_key, "projectId": "p", "createdAt": "2026-11-20T10:00:00.000Z" },
            { "threadId": "sotto-thread-3", "provider": "claude", "sessionId": "claude-key", "projectId": "p", "createdAt": "2026-11-20T10:00:00.000Z" },
            { "threadId": rust_thread, "provider": "codex", "sessionId": rust_thread, "projectId": "p", "createdAt": "2026-11-20T10:00:00.000Z" },
        ] }).to_string()).unwrap();
        let path = dir.path().join("codex-threads.json");
        let node = json!({ "codexThreadId": "native-1", "cwd": "/w", "modelId": "m", "projectId": "p", "title": "Node's", "createdAt": "2026-11-20T10:00:00.000Z" });
        let rust = json!({ "codexThreadId": "native-2", "cwd": "/w", "modelId": "m", "projectId": "p", "title": "Rust's", "createdAt": "2026-11-21T10:00:00.000Z" });
        // A record an earlier build made under the Sotto ID of a thread Node had bound to another key.
        let stray = json!({ "codexThreadId": "native-stray", "cwd": "/w", "modelId": "m" });
        std::fs::write(&path, json!({ node_key: node, rust_thread: rust, thread: stray }).to_string()).unwrap();

        let records = load_thread_records(&path, parse_serde_record::<codex::CodexThreadRecord>);
        assert_eq!(encode_serde_record(&records[thread])["codexThreadId"], "native-1");
        assert_eq!(encode_serde_record(&records[rust_thread])["codexThreadId"], "native-2");
        assert_eq!(records.len(), 2);

        save_thread_records(&path, &records, parse_serde_record::<codex::CodexThreadRecord>, encode_serde_record);
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved, json!({ node_key: node, rust_thread: rust, thread: stray }));

        // Node made the thread and never sent to it, and an earlier build started a session under the Sotto ID: the
        // stray is not read, so Node's record is not written over, and both stay on disk.
        let node_waiting = json!({ "cwd": "/w", "modelId": "m", "projectId": "p", "title": "Node's", "createdAt": "2026-11-20T10:00:00.000Z" });
        std::fs::write(&path, json!({ node_key: node_waiting, thread: stray }).to_string()).unwrap();
        let records = load_thread_records(&path, parse_serde_record::<codex::CodexThreadRecord>);
        assert!(records.is_empty(), "read a stray");
        save_thread_records(&path, &records, parse_serde_record::<codex::CodexThreadRecord>, encode_serde_record);
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved, json!({ node_key: node_waiting, thread: stray }));

        let waiting = dir.path().join("devin-threads.json");
        std::fs::write(dir.path().join("threads.json"), json!({ "bindings": [
            { "threadId": thread, "provider": "devin", "sessionId": node_key, "projectId": "p", "createdAt": "2026-11-20T10:00:00.000Z" },
        ] }).to_string()).unwrap();
        std::fs::write(&waiting, json!({ node_key: { "projectId": "p", "title": "Named in Node", "settingsConfirmed": false } }).to_string()).unwrap();
        assert_eq!(node_record_fields(&waiting, thread, &seed(), &[])["title"], "Named in Node");
    }

    #[test]
    fn a_store_that_is_not_an_object_is_moved_aside_rather_than_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("claude-threads.json");
        std::fs::write(&path, "{ not json").unwrap();
        let records = load_thread_records(&path, parse_serde_record::<claude::ClaudeThreadRecord>);
        assert!(records.is_empty());
        assert!(!path.exists());
        let aside: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|entry| entry.unwrap().file_name().into_string().unwrap()).collect();
        assert_eq!(aside.len(), 1);
        assert!(aside[0].starts_with("claude-threads.json.corrupt-"));
    }

    #[test]
    fn a_codex_record_an_earlier_rust_build_wrote_reads_its_model() {
        let record: codex::CodexThreadRecord = parse_serde_record(&json!({ "codexThreadId": "t", "cwd": "/w", "model": "gpt-x" })).unwrap();
        assert_eq!(encode_serde_record(&record)["modelId"], "gpt-x");
    }
}
