//! Cut bodies (ADR-0025, October 18 amendment; `docs/host-protocol.md` under `activity-bodies`), as Node's
//! `src/shared/activityBodies.ts` makes them. A desktop that accepts `activity-bodies` is sent each activity record with
//! every body over `ACTIVITY_BODY_LIMIT` UTF-8 bytes cut down to its first or last part, and `cut` naming each one's whole
//! size, and fetches the whole record with `activity-body` when its row opens. The bodies are a record's `output`, its
//! `text` and each of its changes' `diff`; every other field goes whole.
//!
//! Rust strings are UTF-8, so a body's size is its length, and no cut can split a character.

use serde_json::{json, Map, Value};

/// The most UTF-8 bytes a body is sent whole with.
pub const ACTIVITY_BODY_LIMIT: usize = 2_048;

/// Which end of a body a cut keeps: command output its end, where the result is, and text and diffs their start.
#[derive(Clone, Copy)]
enum Keep {
    Start,
    End,
}

/// The part of `value` a cut keeps: at most `limit` UTF-8 bytes from the kept end, ending (or, for the end, starting) at a
/// line break, so no line shows half. A window with no line break in it keeps nothing, as Node's `cutText`.
fn cut_text(value: &str, keep: Keep, limit: usize) -> &str {
    if value.len() <= limit {
        return value;
    }
    match keep {
        Keep::Start => {
            let mut end = limit;
            while !value.is_char_boundary(end) {
                end -= 1;
            }
            // The window ends where a line does, or is shortened back to the last line break inside it.
            if value.as_bytes()[end] == b'\n' {
                return &value[..end];
            }
            value[..end].rfind('\n').map_or("", |at| &value[..at])
        }
        Keep::End => {
            let mut start = value.len() - limit;
            while !value.is_char_boundary(start) {
                start += 1;
            }
            if value.as_bytes()[start - 1] == b'\n' {
                return &value[start..];
            }
            value[start..].find('\n').map_or("", |at| &value[start + at + 1..])
        }
    }
}

/// A JSON string literal's UTF-8 size, quotes and escapes included. Node's `JSON.stringify` escapes as `serde_json` does.
fn literal_bytes(value: &str) -> usize {
    serde_json::to_string(value).map_or(value.len() + 2, |literal| literal.len())
}

/// `value` shortened so its JSON literal takes at most `limit` bytes, at a line break when one is in reach.
fn shorten_string(value: &str, limit: usize) -> String {
    if literal_bytes(value) <= limit {
        return value.to_string();
    }
    // The longest prefix whose literal fits, found by halving: escapes make the literal's size uneven along the string.
    let ends: Vec<usize> = value.char_indices().map(|(at, _)| at).chain(std::iter::once(value.len())).collect();
    let (mut low, mut high) = (0, ends.len() - 1);
    while low < high {
        let middle = (low + high).div_ceil(2);
        if literal_bytes(&value[..ends[middle]]) <= limit {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    let prefix = &value[..ends[low]];
    match prefix.rfind('\n') {
        Some(at) if at > 0 => prefix[..at].to_string(),
        _ => prefix.to_string(),
    }
}

/// Every string value in `value` (keys left alone) cut so its literal takes at most `cap` bytes.
fn shorten_strings(value: &Value, cap: usize) -> Value {
    match value {
        Value::String(text) => Value::String(shorten_string(text, cap)),
        Value::Array(items) => Value::Array(items.iter().map(|item| shorten_strings(item, cap)).collect()),
        Value::Object(fields) => Value::Object(fields.iter().map(|(key, item)| (key.clone(), shorten_strings(item, cap))).collect()),
        other => other.clone(),
    }
}

fn string_literals(value: &Value, into: &mut Vec<usize>) {
    match value {
        Value::String(text) => into.push(literal_bytes(text)),
        Value::Array(items) => items.iter().for_each(|item| string_literals(item, into)),
        Value::Object(fields) => fields.values().for_each(|item| string_literals(item, into)),
        _ => {}
    }
}

/// Tool input kept as JSON within the limit, and whether a string in it was shortened rather than only whitespace taken
/// out, as Node's `cutJson` answers.
struct CutJson {
    text: String,
    shortened: bool,
}

/// Text that is a JSON object or array, such as Claude's tool input, kept valid JSON within the limit: each long string
/// value in it is shortened, so the short ones (a file path, a pattern) stay whole for the row's preview. `None` when the
/// text is not JSON, or when even shortened strings leave it over the limit.
fn cut_json(text: &str, limit: usize) -> Option<CutJson> {
    let trimmed = text.trim();
    if !(trimmed.starts_with('{') && trimmed.ends_with('}') || trimmed.starts_with('[') && trimmed.ends_with(']')) {
        return None;
    }
    let value: Value = serde_json::from_str(trimmed).ok()?;
    if !value.is_object() && !value.is_array() {
        return None;
    }
    let compact = serde_json::to_string(&value).ok()?;
    // Only whitespace came out: nothing is missing, so nothing is cut.
    if compact.len() <= limit {
        return Some(CutJson { text: compact, shortened: false });
    }
    let mut literals = Vec::new();
    string_literals(&value, &mut literals);
    if literals.is_empty() {
        return None;
    }
    let overhead = compact.len() - literals.iter().sum::<usize>();
    let fits = |cap: usize| overhead + literals.iter().map(|bytes| (*bytes).min(cap)).sum::<usize>() <= limit;
    // The largest per-string cap whose strings, all cut to it, fit: a shortened string can come out a little under its cap.
    let (mut low, mut high) = (2, *literals.iter().max()?);
    if !fits(low) {
        return None;
    }
    while low < high {
        let middle = (low + high).div_ceil(2);
        if fits(middle) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    let mut cap = low;
    while cap >= 2 {
        let shortened = serde_json::to_string(&shorten_strings(&value, cap)).ok()?;
        if shortened.len() <= limit {
            return Some(CutJson { text: shortened, shortened: true });
        }
        cap = (cap - 1).min(cap * 9 / 10);
    }
    None
}

/// Whether a record's text would be read as tool input, as the desktop's rows read it (`activityInput`).
fn reads_as_input(record: &Map<String, Value>) -> bool {
    !matches!(record.get("kind").and_then(Value::as_str), Some("reasoning" | "plan" | "status" | "turn"))
}

/// A record without its agents' `steps`, which only the host's own sub-agent store reads, as Node's `stripAgentSteps`.
pub fn strip_agent_steps(record: &Value) -> Value {
    let mut record = record.clone();
    if let Some(agents) = record.get_mut("agents").and_then(Value::as_array_mut) {
        for agent in agents {
            if let Some(agent) = agent.as_object_mut() {
                agent.remove("steps");
            }
        }
    }
    record
}

/// A record as a desktop that accepts `activity-bodies` is sent it, as Node's `cutActivityBodies`: each body over the
/// limit cut, and `cut` naming each one's whole size in UTF-8 bytes (diffs by their change's index).
pub fn cut_activity_bodies(record: &Value, limit: usize) -> Value {
    let mut record = strip_agent_steps(record);
    let Some(fields) = record.as_object_mut() else {
        return record;
    };
    let mut cut = Map::new();
    if let Some(output) = fields.get("output").and_then(Value::as_str).filter(|output| output.len() > limit) {
        cut.insert("output".into(), json!(output.len()));
        let kept = cut_text(output, Keep::End, limit).to_string();
        fields.insert("output".into(), Value::String(kept));
    }
    if let Some(text) = fields.get("text").and_then(Value::as_str).filter(|text| text.len() > limit).map(ToString::to_string) {
        let json = if reads_as_input(fields) { cut_json(&text, limit) } else { None };
        let shortened = json.as_ref().is_none_or(|json| json.shortened);
        let kept = json.map_or_else(|| cut_text(&text, Keep::Start, limit).to_string(), |json| json.text);
        fields.insert("text".into(), Value::String(kept));
        if shortened {
            cut.insert("text".into(), json!(text.len()));
        }
    }
    if let Some(changes) = fields.get_mut("changes").and_then(Value::as_array_mut) {
        let mut diffs = Vec::new();
        for (index, change) in changes.iter_mut().enumerate() {
            let Some(diff) = change.get("diff").and_then(Value::as_str).filter(|diff| diff.len() > limit) else {
                continue;
            };
            diffs.push(json!({ "index": index, "bytes": diff.len() }));
            let kept = cut_text(diff, Keep::Start, limit).to_string();
            change["diff"] = Value::String(kept);
        }
        if !diffs.is_empty() {
            cut.insert("diffs".into(), Value::Array(diffs));
        }
    }
    if !cut.is_empty() {
        fields.insert("cut".into(), Value::Object(cut));
    }
    record
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each case of `tests/fixtures/activityBodies.json` is cut as Node's own `cutActivityBodies` cut it; the fixture's
    /// own test (`tests/unit/shared/activityBodies.test.ts`) holds it to Node. Its JSON inputs keep their keys in order, so
    /// the shortened text this host writes, with its keys sorted, reads the same.
    #[test]
    fn cuts_every_fixture_case_as_node_does() {
        let cases: Vec<Value> = serde_json::from_str(include_str!("../../../tests/fixtures/activityBodies.json")).unwrap();
        assert!(cases.len() >= 10);
        for case in cases {
            assert_eq!(cut_activity_bodies(&case["record"], ACTIVITY_BODY_LIMIT), case["sent"], "{}", case["name"]);
        }
    }

    #[test]
    fn a_body_is_cut_at_a_line_break_from_the_end_it_keeps() {
        let lines: String = (0..400).map(|line| format!("line {line:03}\n")).collect();
        let start = cut_text(&lines, Keep::Start, 30);
        assert_eq!(start, "line 000\nline 001\nline 002");
        let end = cut_text(&lines, Keep::End, 30);
        assert_eq!(end, "line 397\nline 398\nline 399\n");
        assert_eq!(cut_text("short", Keep::Start, 30), "short");
        assert_eq!(cut_text(&"x".repeat(40), Keep::Start, 30), "", "a window with no line break keeps nothing");
        // A character is never split: three-byte characters fill 30 bytes with 10 of them.
        let wide = format!("{}\n", "\u{20AC}".repeat(20));
        assert_eq!(cut_text(&wide, Keep::End, 30), "");
        assert_eq!(cut_text(&format!("a\n{}", "\u{20AC}".repeat(20)), Keep::Start, 30), "a");
    }

    #[test]
    fn a_record_carries_its_cut_bodies_and_their_whole_sizes() {
        let output: String = (0..300).map(|line| format!("out {line:04}\n")).collect();
        let text: String = (0..300).map(|line| format!("said {line:04}\n")).collect();
        let diff: String = (0..300).map(|line| format!("+add {line:04}\n")).collect();
        let record = json!({ "id": "a", "kind": "reasoning", "output": output, "text": text,
            "changes": [{ "path": "x", "diff": "+small\n" }, { "path": "y", "diff": diff }],
            "agents": [{ "id": "g", "steps": [1, 2] }] });
        let sent = cut_activity_bodies(&record, ACTIVITY_BODY_LIMIT);
        assert_eq!(sent["cut"], json!({ "output": output.len(), "text": text.len(), "diffs": [{ "index": 1, "bytes": diff.len() }] }));
        assert!(sent["output"].as_str().unwrap().len() <= ACTIVITY_BODY_LIMIT && output.ends_with(sent["output"].as_str().unwrap()));
        assert!(text.starts_with(sent["text"].as_str().unwrap()));
        assert_eq!(sent["changes"][0]["diff"], "+small\n");
        assert!(sent["agents"][0].get("steps").is_none());
        let short = json!({ "id": "b", "kind": "command", "output": "ok" });
        assert_eq!(cut_activity_bodies(&short, ACTIVITY_BODY_LIMIT), short);
    }

    #[test]
    fn tool_input_stays_json_with_its_short_strings_whole() {
        let input = json!({ "path": "src/main.rs", "content": "y".repeat(5_000) }).to_string();
        let record = json!({ "id": "c", "kind": "tool", "text": input });
        let sent = cut_activity_bodies(&record, ACTIVITY_BODY_LIMIT);
        let kept: Value = serde_json::from_str(sent["text"].as_str().unwrap()).unwrap();
        assert_eq!(kept["path"], "src/main.rs");
        assert!(sent["text"].as_str().unwrap().len() <= ACTIVITY_BODY_LIMIT);
        assert_eq!(sent["cut"]["text"], input.len());
        // Pretty JSON that fits once compact is sent compact, and nothing is named cut.
        let pretty = serde_json::to_string_pretty(&json!({ "items": vec!["a"; 400] })).unwrap();
        assert!(pretty.len() > ACTIVITY_BODY_LIMIT);
        let sent = cut_activity_bodies(&json!({ "id": "d", "kind": "tool", "text": pretty }), ACTIVITY_BODY_LIMIT);
        assert!(sent.get("cut").is_none());
        assert!(serde_json::from_str::<Value>(sent["text"].as_str().unwrap()).is_ok());
    }
}
