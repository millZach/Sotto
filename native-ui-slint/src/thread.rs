//! The thread: 200 earlier messages, then one long reply streamed in 20-character chunks every
//! 16 ms from a generator in the app. All of it is invented text in `content/`.

use crate::highlight::{CodeColors, Highlighter};
use crate::markdown::{self, Block};
use crate::{DiffLine, Row, TableRow};
use slint::{Model, ModelRc, SharedString, StyledText, VecModel};
use std::rc::Rc;

pub const REPLY: &str = include_str!("../content/reply.md");
const HISTORY: &str = include_str!("../content/history.json");
pub const CHUNK: usize = 20;

#[derive(serde::Deserialize)]
struct Message {
    role: String,
    text: String,
}

pub struct Thread {
    pub rows: Rc<VecModel<Row>>,
    /// Rows before the streamed reply.
    base: usize,
    /// The reply's blocks as last shown, to update only what changed.
    shown: Vec<Block>,
    expanded: Vec<bool>,
    pub streamed: usize,
    pub highlighter: Highlighter,
    pub writing: bool,
    colors: CodeColors,
}

fn styled(md: &str) -> StyledText {
    StyledText::from_markdown(md).unwrap_or_else(|_| StyledText::from_plain_text(md))
}

fn empty_row(kind: i32) -> Row {
    Row {
        kind,
        author: SharedString::new(),
        time: SharedString::new(),
        you: false,
        text: StyledText::default(),
        plain: SharedString::new(),
        level: 0,
        lang: SharedString::new(),
        detail: SharedString::new(),
        expanded: false,
        lines: 0,
        diff: ModelRc::default(),
        columns: ModelRc::default(),
        header: ModelRc::default(),
        rows: ModelRc::default(),
        rtl: false,
        selected: false,
        label: SharedString::new(),
    }
}

/// What a screen reader says for a row: its kind, then its words.
fn labelled(mut r: Row) -> Row {
    let first = |s: &str| s.lines().next().unwrap_or("").chars().take(120).collect::<String>();
    r.label = match r.kind {
        0 => format!("{}, {}", r.author, r.time),
        1 => format!("You said: {}", r.plain),
        2 => r.plain.to_string(),
        3 => format!("Heading level {}: {}", r.level, r.plain),
        4 => format!("{} code, {} lines. Enter copies it. {}", r.lang, r.lines, first(&r.plain)),
        5 => format!("Table, {} rows: {}", r.rows.row_count(), r.plain),
        6 => format!("Changes to {}, {}. Enter copies the diff.", r.lang, r.detail),
        7 => format!("{}, {}. Enter {} it.", r.lang, if r.expanded { "open" } else { "folded" }, if r.expanded { "folds" } else { "opens" }),
        8 => "Writing a reply".to_string(),
        _ => String::new(),
    }
    .into();
    r
}

fn time_of(index: usize) -> String {
    let minutes = 9 * 60 + 2 + index as u32 * 2;
    let (h, m) = (minutes / 60, minutes % 60);
    let (h12, ampm) = if h >= 12 { (if h > 12 { h - 12 } else { h }, "pm") } else { (h, "am") };
    format!("{h12}:{m:02} {ampm}")
}

impl Thread {
    pub fn new(colors: CodeColors) -> Self {
        let history: Vec<Message> = serde_json::from_str(HISTORY).expect("history.json");
        let rows = Rc::new(VecModel::<Row>::default());
        let mut out = Vec::with_capacity(history.len() * 3);
        for (i, m) in history.iter().enumerate() {
            let you = m.role == "user";
            let mut author = empty_row(0);
            author.author = if you { "You" } else { "Claude" }.into();
            author.time = time_of(i).into();
            author.you = you;
            out.push(labelled(author));
            let rtl = markdown::starts_rtl(&m.text);
            if you {
                let mut r = empty_row(1);
                r.text = styled(&m.text);
                r.plain = markdown::plain(&m.text).into();
                r.you = true;
                r.rtl = rtl;
                out.push(labelled(r));
            } else {
                for block in markdown::blocks(&m.text) {
                    if let Block::Prose { source } = block {
                        let mut r = empty_row(2);
                        r.rtl = markdown::starts_rtl(&source);
                        r.text = styled(&source);
                        r.plain = markdown::plain(&source).into();
                        out.push(labelled(r));
                    }
                }
            }
        }
        rows.set_vec(out);
        let base = rows.row_count();
        Self { rows, base, shown: Vec::new(), expanded: Vec::new(), streamed: 0, highlighter: Highlighter::new(colors), writing: false, colors }
    }

    /// Adds the reply's author line and the "Writing a reply" line, ready for the stream.
    pub fn start_reply(&mut self) {
        let mut author = empty_row(0);
        author.author = "Claude".into();
        author.time = time_of(200).into();
        self.rows.push(labelled(author));
        self.base = self.rows.row_count();
        self.shown.clear();
        self.expanded.clear();
        self.streamed = 0;
        self.writing = true;
        self.rows.push(labelled(empty_row(8)));
    }

    /// Streams the next chunk. Returns false once the reply is whole.
    pub fn step(&mut self) -> bool {
        if self.streamed >= REPLY.len() {
            if self.writing {
                self.writing = false;
                let last = self.rows.row_count() - 1;
                if self.rows.row_data(last).map(|r| r.kind) == Some(8) {
                    self.rows.remove(last);
                }
            }
            return false;
        }
        let mut end = (self.streamed + CHUNK).min(REPLY.len());
        while !REPLY.is_char_boundary(end) {
            end += 1;
        }
        self.streamed = end;
        self.refresh();
        true
    }

    /// Shows the whole reply at once (used when the stream is skipped).
    pub fn finish(&mut self) {
        self.streamed = REPLY.len();
        self.refresh();
        self.step();
    }

    fn refresh(&mut self) {
        let blocks = markdown::blocks(&REPLY[..self.streamed]);
        let writing_row = usize::from(self.writing);
        // Rows from base: one per block, then the writing line.
        for (i, block) in blocks.iter().enumerate() {
            if i < self.shown.len() && self.shown[i] == *block {
                continue;
            }
            if self.expanded.len() <= i {
                self.expanded.push(false);
            }
            let row = labelled(self.row_for(block, self.expanded[i]));
            let at = self.base + i;
            if i < self.shown.len() {
                self.rows.set_row_data(at, row);
            } else {
                self.rows.insert(at, row);
            }
        }
        // A block that vanished (a heading that became a paragraph mid-stream, say).
        while self.rows.row_count() > self.base + blocks.len() + writing_row {
            self.rows.remove(self.base + blocks.len());
        }
        self.shown = blocks;
    }

    pub fn toggle(&mut self, index: usize) {
        let Some(mut row) = self.rows.row_data(index) else { return };
        if row.kind != 7 {
            return;
        }
        row.expanded = !row.expanded;
        let row = labelled(row);
        if index >= self.base && index - self.base < self.expanded.len() {
            self.expanded[index - self.base] = row.expanded;
        }
        self.rows.set_row_data(index, row);
    }

    /// Colour the code again after a theme change.
    pub fn recolor(&mut self, colors: CodeColors) {
        self.highlighter.set_colors(colors);
        self.colors = colors;
        for (i, block) in self.shown.clone().iter().enumerate() {
            if matches!(block, Block::Code { .. } | Block::Diff { .. } | Block::Activity { .. }) {
                let row = labelled(self.row_for(block, self.expanded.get(i).copied().unwrap_or(false)));
                self.rows.set_row_data(self.base + i, row);
            }
        }
    }

    /// The text a Copy button copies.
    pub fn copy_text(&self, index: usize) -> Option<String> {
        if index < self.base {
            return None;
        }
        match self.shown.get(index - self.base)? {
            Block::Code { code, .. } | Block::Diff { code } => Some(code.clone()),
            Block::Activity { output, .. } => Some(output.clone()),
            _ => None,
        }
    }

    fn row_for(&self, block: &Block, expanded: bool) -> Row {
        match block {
            Block::Prose { source } => {
                let mut r = empty_row(2);
                r.text = styled(source);
                r.plain = markdown::plain(source).into();
                r.rtl = markdown::starts_rtl(source);
                r
            }
            Block::Heading { level, text } => {
                let mut r = empty_row(3);
                r.level = *level as i32;
                r.text = styled(&format!("**{}**", markdown::escape(text)));
                r.plain = text.clone().into();
                r
            }
            Block::Code { lang, code } => {
                let mut r = empty_row(4);
                let lines = self.highlighter.lines(lang, code);
                let mut md = String::with_capacity(code.len() * 3);
                for (i, spans) in lines.iter().enumerate() {
                    if i > 0 {
                        md.push('\n');
                    }
                    markdown::line_markup(spans, &mut md);
                }
                r.text = styled(&md);
                r.plain = code.clone().into();
                r.lang = match lang.as_str() {
                    "typescript" => "TypeScript",
                    "rust" => "Rust",
                    "json" => "JSON",
                    "shell" => "Shell",
                    other => other,
                }
                .into();
                r.lines = lines.len() as i32;
                r
            }
            Block::Diff { code } => {
                let mut r = empty_row(6);
                let (mut old_no, mut new_no) = (0u32, 0u32);
                let mut file = String::new();
                let (mut added, mut removed) = (0, 0);
                let mut lines = Vec::new();
                let mut md = String::with_capacity(code.len() * 2);
                let colors = self.highlighter_colors();
                for (i, line) in code.lines().enumerate() {
                    let (kind, color, old, new) = if line.starts_with("@@") {
                        // @@ -a,b +c,d @@
                        let nums: Vec<u32> = line
                            .split(|c: char| !c.is_ascii_digit())
                            .filter(|s| !s.is_empty())
                            .filter_map(|s| s.parse().ok())
                            .collect();
                        if nums.len() >= 3 {
                            old_no = nums[0];
                            new_no = nums[2];
                        }
                        (3, colors.meta, String::new(), String::new())
                    } else if line.starts_with("+++") || line.starts_with("---") || line.starts_with("diff ") || line.starts_with("index ") {
                        if let Some(p) = line.strip_prefix("+++ b/") {
                            file = p.to_string();
                        }
                        (3, colors.meta, String::new(), String::new())
                    } else if line.starts_with('+') {
                        added += 1;
                        new_no += 1;
                        (1, colors.text, String::new(), new_no.to_string())
                    } else if line.starts_with('-') {
                        removed += 1;
                        old_no += 1;
                        (2, colors.text, old_no.to_string(), String::new())
                    } else {
                        old_no += 1;
                        new_no += 1;
                        (0, colors.text, old_no.to_string(), new_no.to_string())
                    };
                    if i > 0 {
                        md.push('\n');
                    }
                    let hex = format!("#{:02x}{:02x}{:02x}", color[0], color[1], color[2]);
                    markdown::line_markup(&[(hex, line.to_string())], &mut md);
                    lines.push(DiffLine { kind, old_no: old.into(), new_no: new.into() });
                }
                r.lines = lines.len() as i32;
                r.diff = ModelRc::new(VecModel::from(lines));
                r.text = styled(&md);
                r.plain = code.clone().into();
                r.lang = if file.is_empty() { "diff".into() } else { file.into() };
                r.detail = format!("+{added} −{removed}").into();
                r
            }
            Block::Activity { title, output } => {
                let mut r = empty_row(7);
                r.lang = title.clone().into();
                let first = output.lines().next().unwrap_or("").trim();
                r.detail = first.chars().take(60).collect::<String>().into();
                let colors = self.highlighter_colors();
                let hex = format!("#{:02x}{:02x}{:02x}", colors.text[0], colors.text[1], colors.text[2]);
                let mut md = String::new();
                for (i, line) in output.lines().enumerate() {
                    if i > 0 {
                        md.push('\n');
                    }
                    markdown::line_markup(&[(hex.clone(), line.to_string())], &mut md);
                }
                r.text = styled(&md);
                r.plain = output.clone().into();
                r.lines = output.lines().count() as i32;
                r.expanded = expanded;
                r
            }
            Block::Table { header, rows } => {
                let mut r = empty_row(5);
                let cols = header.len().max(1);
                let mut weights = vec![1f32; cols];
                for (c, h) in header.iter().enumerate() {
                    weights[c] = weights[c].max(h.chars().count() as f32);
                }
                for row in rows {
                    for (c, cell) in row.iter().enumerate().take(cols) {
                        weights[c] = weights[c].max(cell.chars().count() as f32);
                    }
                }
                r.columns = ModelRc::new(VecModel::from(weights));
                r.header = ModelRc::new(VecModel::from(header.iter().map(|h| styled(&format!("**{h}**"))).collect::<Vec<_>>()));
                r.rows = ModelRc::new(VecModel::from(
                    rows.iter()
                        .map(|row| {
                            let mut cells: Vec<StyledText> = row.iter().map(|c| styled(c)).collect();
                            cells.resize(cols, StyledText::default());
                            TableRow { cells: ModelRc::new(VecModel::from(cells)) }
                        })
                        .collect::<Vec<_>>(),
                ));
                r.plain = header.join(", ").into();
                r
            }
        }
    }

    fn highlighter_colors(&self) -> CodeColors {
        self.colors
    }
}
