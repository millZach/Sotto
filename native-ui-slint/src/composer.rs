//! Pills in the composer's text.
//!
//! A pill is its label between two invisible markers: U+2064 INVISIBLE PLUS for an attached file,
//! U+2063 INVISIBLE SEPARATOR for a quoted reply. The label uses no-break spaces and a word joiner
//! after each hyphen or slash, so it never wraps, and four no-break spaces at its start leave room
//! for the icon the editor draws behind it.

use crate::{AppWindow, KeyAction, PillRect};
use slint::platform::Key;
use slint::{ComponentHandle, Model, ModelRc, SharedString, VecModel};

pub const FILE: char = '\u{2064}';
pub const QUOTE: char = '\u{2063}';
const PAD: &str = "\u{00A0}\u{00A0}\u{00A0}\u{00A0}";

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pill {
    /// Byte offset of the opening marker.
    pub start: usize,
    /// Byte offset just after the closing marker.
    pub end: usize,
    pub kind: i32,
}

pub fn pill_text(kind: char, label: &str) -> String {
    let label = label.replace(' ', "\u{00A0}").replace('-', "-\u{2060}").replace('/', "/\u{2060}");
    format!("{kind}{PAD}{label}\u{00A0}{kind}")
}

/// Finds the pills, and drops any marker left without its partner (after a partial delete).
pub fn parse(text: &str) -> (Vec<Pill>, Option<String>) {
    let mut pills = Vec::new();
    let mut open: Option<(usize, char)> = None;
    let mut orphans = Vec::new();
    for (i, ch) in text.char_indices() {
        if ch == FILE || ch == QUOTE {
            match open {
                Some((s, k)) if k == ch => {
                    pills.push(Pill { start: s, end: i + ch.len_utf8(), kind: if ch == FILE { 0 } else { 1 } });
                    open = None;
                }
                Some((s, _)) => {
                    orphans.push(s);
                    open = Some((i, ch));
                }
                None => open = Some((i, ch)),
            }
        }
    }
    if let Some((s, _)) = open {
        orphans.push(s);
    }
    if orphans.is_empty() {
        return (pills, None);
    }
    let cleaned: String = text.char_indices().filter(|(i, _)| !orphans.contains(i)).map(|(_, c)| c).collect();
    let (pills, _) = parse(&cleaned);
    (pills, Some(cleaned))
}

pub fn key_action(pills: &[Pill], key: &str, shift: bool, anchor: usize, cursor: usize) -> KeyAction {
    let none = KeyAction { handled: false, anchor: 0, cursor: 0, accept: false };
    let k = key.chars().next().unwrap_or('\0');
    let backspace = k == char::from(Key::Backspace);
    let delete = k == char::from(Key::Delete);
    let left = k == char::from(Key::LeftArrow);
    let right = k == char::from(Key::RightArrow);
    let at = |c: usize| pills.iter().find(|p| c > p.start && c < p.end);
    if anchor != cursor {
        // A selection that cuts a pill grows to take all of it, then the key deletes it whole.
        if backspace || delete {
            let (mut a, mut b) = (anchor.min(cursor), anchor.max(cursor));
            for p in pills {
                if a > p.start && a < p.end {
                    a = p.start;
                }
                if b > p.start && b < p.end {
                    b = p.end;
                }
            }
            return KeyAction { handled: true, anchor: a as i32, cursor: b as i32, accept: false };
        }
        if !shift {
            return none;
        }
    }
    if backspace {
        if let Some(p) = pills.iter().find(|p| p.end == cursor).or_else(|| at(cursor)) {
            return KeyAction { handled: true, anchor: p.start as i32, cursor: p.end as i32, accept: false };
        }
    }
    if delete {
        if let Some(p) = pills.iter().find(|p| p.start == cursor).or_else(|| at(cursor)) {
            return KeyAction { handled: true, anchor: p.start as i32, cursor: p.end as i32, accept: false };
        }
    }
    if left {
        if let Some(p) = pills.iter().find(|p| p.end == cursor).or_else(|| at(cursor)) {
            let a = if shift { anchor } else { p.start };
            return KeyAction { handled: true, anchor: a as i32, cursor: p.start as i32, accept: true };
        }
    }
    if right {
        if let Some(p) = pills.iter().find(|p| p.start == cursor).or_else(|| at(cursor)) {
            let a = if shift { anchor } else { p.end };
            return KeyAction { handled: true, anchor: a as i32, cursor: p.end as i32, accept: true };
        }
    }
    none
}

/// Where a caret placed inside a pill (by a click) belongs: the nearer edge.
pub fn snap(pills: &[Pill], cursor: usize) -> Option<usize> {
    let p = pills.iter().find(|p| cursor > p.start && cursor < p.end)?;
    Some(if cursor - p.start < p.end - cursor { p.start } else { p.end })
}

/// Measures every pill with the twin editor and hands the rectangles to the UI.
pub fn measure(ui: &AppWindow, pills: &[Pill]) {
    let width = ui.get_composer_editor_width();
    let mut rects = Vec::with_capacity(pills.len());
    for p in pills {
        // Measure just inside the markers: the label's first and last characters.
        let a = ui.invoke_measure_at((p.start + FILE.len_utf8()) as i32);
        let b = ui.invoke_measure_at((p.end - FILE.len_utf8()) as i32);
        let (x, w) = if (b.y - a.y).abs() < 1.0 { (a.x, b.x - a.x) } else { (a.x, width - a.x) };
        rects.push(PillRect { x, y: a.y, width: w.max(8.0), kind: p.kind });
    }
    let model = ui.get_pills();
    if model.row_count() == rects.len() && (0..rects.len()).all(|i| model.row_data(i).as_ref() == Some(&rects[i])) {
        return;
    }
    ui.set_pills(ModelRc::new(VecModel::from(rects)));
}

pub fn initial_text() -> SharedString {
    format!(
        "Before merging, check {} against {} and tell me if the worst case still holds.",
        pill_text(FILE, "crash-after.json"),
        pill_text(QUOTE, "The worst run lost one entry"),
    )
    .into()
}

pub fn attach_names() -> [&'static str; 4] {
    ["shelf.journal", "compact-bench.txt", "receipts.rs", "autosave.ts"]
}

#[allow(dead_code)]
pub fn weak(ui: &AppWindow) -> slint::Weak<AppWindow> {
    ui.as_weak()
}
