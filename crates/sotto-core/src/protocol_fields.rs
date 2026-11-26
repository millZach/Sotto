//! The small field checks Node's zod schemas make that the Rust host's request parsers and file reads share: an ID's
//! length in UTF-16 code units, a safe whole number, a SHA-256 digest, and a path that names another computer.

use serde_json::Value;

/// The longest ID Node's protocol reads (`id` in `src/shared/agents.ts`), in UTF-16 code units as zod counts.
pub const ID_MAX: usize = 512;
/// The largest integer Node's schema takes as an integer (`Number.MAX_SAFE_INTEGER`).
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// A string's length as zod's `min` and `max` count it: in UTF-16 code units.
pub fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// An ID as Node's schema reads one: not empty and at most `ID_MAX` UTF-16 code units.
pub fn protocol_id(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|id| (1..=ID_MAX).contains(&utf16_len(id)))
        .map(ToString::to_string)
}

/// A whole non-negative number no larger than `Number.MAX_SAFE_INTEGER`, as `z.number().int().nonnegative()` takes
/// one: `3.0` and `-0` are integers to zod, a fraction is not.
pub fn whole_number(value: &Value) -> Option<u64> {
    if let Some(whole) = value.as_u64() {
        return (whole <= MAX_SAFE_INTEGER).then_some(whole);
    }
    let number = value.as_f64()?;
    // `as` is exact for every safe integer.
    (number.is_finite() && number.fract() == 0.0 && (0.0..=MAX_SAFE_INTEGER as f64).contains(&number)).then_some(number as u64)
}

/// A SHA-256 digest as Node's schemas write one: 64 lowercase hexadecimal digits.
pub fn is_digest(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Whether a path names a file on another computer, as Node's `onNetwork` reads it: a Windows UNC path (`\\server\share`,
/// `//server/share`) or a device path (`\\?\`), whose resolving reaches the network before the file is looked at.
pub fn on_network(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && matches!(bytes[0], b'\\' | b'/') && matches!(bytes[1], b'\\' | b'/')
}

/// Bytes as lowercase hexadecimal, as Node's `digest('hex')` writes them.
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fields_are_read_as_nodes_schemas_read_them() {
        assert_eq!(protocol_id(Some(&json!("t"))), Some("t".into()));
        assert_eq!(protocol_id(Some(&json!(""))), None);
        assert_eq!(protocol_id(Some(&json!("\u{1F600}".repeat(256)))), Some("\u{1F600}".repeat(256)));
        assert_eq!(protocol_id(Some(&json!("\u{1F600}".repeat(257)))), None, "an emoji is two UTF-16 code units");
        assert_eq!(protocol_id(Some(&json!(1))), None);
        assert_eq!(whole_number(&json!(3)), Some(3));
        assert_eq!(whole_number(&json!(3.0)), Some(3));
        assert_eq!(whole_number(&json!(-0.0)), Some(0));
        assert_eq!(whole_number(&json!(1.5)), None);
        assert_eq!(whole_number(&json!(-1)), None);
        assert_eq!(whole_number(&json!(MAX_SAFE_INTEGER)), Some(MAX_SAFE_INTEGER));
        assert_eq!(whole_number(&json!(MAX_SAFE_INTEGER + 1)), None);
        assert_eq!(whole_number(&json!("3")), None);
        assert!(is_digest(&"a0".repeat(32)));
        assert!(!is_digest(&"A0".repeat(32)));
        assert!(!is_digest(&"a0".repeat(31)));
        assert!(!is_digest("../../secret"));
        for network in ["\\\\server\\share", "//server/share", "\\\\?\\C:\\clip.mp4", "/\\server"] {
            assert!(on_network(network), "{network}");
        }
        for local in ["C:\\clip.mp4", "/home/clip.mp4", "clip.mp4", "\\clip.mp4", ""] {
            assert!(!on_network(local), "{local}");
        }
        assert_eq!(hex(&[0, 15, 255]), "000fff");
    }
}
