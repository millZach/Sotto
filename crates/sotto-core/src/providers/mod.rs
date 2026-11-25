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

/// Reads a provider's `*-threads.json` the way Node's `AtomicJsonStore` writes it (ADR-0214): one record per Sotto
/// thread ID, which the Node host and this one share over the same data folder. Each entry is read on its own, so one
/// this build cannot read costs only that entry, and `save_thread_records` writes it back untouched. A file that is not
/// a JSON object is moved aside as `<name>.corrupt-<millis>`, as Node does, rather than overwritten by the next save.
pub(crate) fn load_thread_records<T>(path: &std::path::Path, parse: impl Fn(&serde_json::Value) -> Option<T>) -> std::collections::HashMap<String, T> {
    let mut out = std::collections::HashMap::new();
    let Ok(raw) = std::fs::read_to_string(path) else {
        return out;
    };
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(serde_json::Value::Object(map)) => {
            for (sotto_id, value) in &map {
                if let Some(record) = parse(value) {
                    out.insert(sotto_id.clone(), record);
                }
            }
        }
        _ => {
            let millis = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("threads.json");
            let _ = std::fs::rename(path, path.with_file_name(format!("{name}.corrupt-{millis}")));
        }
    }
    out
}

/// Writes a provider's `*-threads.json` whole: every record this host holds, encoded with every field it read, and every
/// entry on disk it could not read and does not hold, as it was, so a Node record this build does not understand
/// survives a Rust host and a rollback to Node (ADR-0214).
pub(crate) fn save_thread_records<T>(
    path: &std::path::Path,
    records: &std::collections::HashMap<String, T>,
    parse: impl Fn(&serde_json::Value) -> Option<T>,
    encode: impl Fn(&T) -> serde_json::Value,
) {
    let mut out = serde_json::Map::new();
    if let Ok(raw) = std::fs::read_to_string(path) {
        if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(&raw) {
            for (sotto_id, value) in map {
                if !records.contains_key(&sotto_id) && parse(&value).is_none() {
                    out.insert(sotto_id, value);
                }
            }
        }
    }
    for (sotto_id, record) in records {
        out.insert(sotto_id.clone(), encode(record));
    }
    let _ = crate::workspace::write_atomic_json(path, &serde_json::Value::Object(out));
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
    /// `SOTTO_SHARED_THREAD_STORES_DIR` set, the stores in that folder are the ones Node wrote, for
    /// `tests/integration/rustHostThreadStoreRollback.test.ts` to read back with Node's own parsers.
    #[test]
    fn node_thread_stores_survive_a_rust_load_and_save() {
        let dir = tempfile::tempdir().unwrap();
        let shared = std::env::var_os("SOTTO_SHARED_THREAD_STORES_DIR").map(std::path::PathBuf::from);
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
