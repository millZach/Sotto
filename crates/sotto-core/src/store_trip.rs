//! Test support for the Node -> Rust -> Node round trips of the JSON stores both host programs write (ADR-0214).
//!
//! Each round-trip test has the same shape: a store as Node writes it, a Rust load and save through the real code, and
//! a check that the file still holds everything Node wrote. With `SOTTO_SHARED_STORES_DIR` set, the stores in that
//! folder are the ones Node wrote, and a TypeScript test under `tests/integration/rustHost*Rollback.test.ts` reads them
//! back with Node's own parsers afterwards.

use serde_json::Value;
use std::path::{Path, PathBuf};

/// Whether `outer` holds everything `inner` does: every key of an object with the same value, every element of an array
/// in the same place, anything else equal.
pub(crate) fn holds(outer: &Value, inner: &Value) -> bool {
    match (outer, inner) {
        (Value::Object(o), Value::Object(i)) => i.iter().all(|(key, value)| o.get(key).is_some_and(|held| holds(held, value))),
        (Value::Array(o), Value::Array(i)) => o.len() == i.len() && o.iter().zip(i).all(|(held, value)| holds(held, value)),
        _ => outer == inner,
    }
}

/// The paths in `inner` that `outer` does not hold, for a failure message that names what was lost.
pub(crate) fn missing(outer: &Value, inner: &Value, path: &str) -> Vec<String> {
    match (outer, inner) {
        (Value::Object(o), Value::Object(i)) => i
            .iter()
            .flat_map(|(key, value)| match o.get(key) {
                Some(held) => missing(held, value, &format!("{path}.{key}")),
                None => vec![format!("{path}.{key}")],
            })
            .collect(),
        (Value::Array(o), Value::Array(i)) if o.len() == i.len() => {
            o.iter().zip(i).enumerate().flat_map(|(n, (held, value))| missing(held, value, &format!("{path}[{n}]"))).collect()
        }
        _ if outer == inner => Vec::new(),
        _ => vec![format!("{path}: {inner} became {outer}")],
    }
}

/// The folder Node's stores are in when a TypeScript test runs this one, or none.
pub(crate) fn shared_dir() -> Option<PathBuf> {
    std::env::var_os("SOTTO_SHARED_STORES_DIR").map(PathBuf::from)
}

/// Runs one store's round trip: writes `node` to `file` in a fresh folder unless a TypeScript test already wrote it in
/// the shared one, runs `trip` on the folder, and fails if the file lost anything Node wrote.
pub(crate) fn round_trip(file: &str, node: impl FnOnce() -> Value, trip: impl FnOnce(&Path)) {
    let own = tempfile::tempdir().unwrap();
    let shared = shared_dir();
    let dir = shared.clone().unwrap_or_else(|| own.path().to_path_buf());
    let path = dir.join(file);
    if shared.is_none() {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&path, serde_json::to_string_pretty(&node()).unwrap()).unwrap();
    }
    let before: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    trip(&dir);
    let after: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert!(holds(&after, &before), "{file} lost something Node wrote:\nbefore {before}\nafter {after}");
}

/// Runs `make` on a folder so it writes `file` through Rust's own code: the shared folder when a TypeScript test runs
/// this one, which then reads the file with Node's parser, or a fresh one. Returns what Rust wrote.
pub(crate) fn created(file: &str, make: impl FnOnce(&Path)) -> Value {
    let own = tempfile::tempdir().unwrap();
    let dir = shared_dir().unwrap_or_else(|| own.path().to_path_buf());
    make(&dir);
    let text = std::fs::read_to_string(dir.join(file)).unwrap_or_else(|err| panic!("Rust wrote no {file}: {err}"));
    serde_json::from_str(&text).unwrap()
}
