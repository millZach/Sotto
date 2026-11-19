//! Markdown into transcript blocks.
//!
//! Prose (paragraphs and lists, nested or not) goes to Slint's StyledText as its own Markdown
//! source, since StyledText parses CommonMark itself. Headings, code, tables, the diff and the
//! activity rows are blocks of their own, because StyledText draws none of them. Code is coloured
//! here and handed over as StyledText markup: one `<font color>` span per token, one line per
//! paragraph.

use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};
use std::ops::Range;

#[derive(Clone, Debug, PartialEq)]
pub enum Block {
    Prose { source: String },
    Heading { level: u8, text: String },
    Code { lang: String, code: String },
    Diff { code: String },
    Activity { title: String, output: String },
    Table { header: Vec<String>, rows: Vec<Vec<String>> },
}

/// Splits a Markdown document into blocks. Unclosed fences (mid-stream) run to the end.
pub fn blocks(source: &str) -> Vec<Block> {
    let mut out = Vec::new();
    let parser = Parser::new_ext(source, Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH).into_offset_iter();
    let mut depth = 0usize;
    let mut prose: Option<Range<usize>> = None;
    let mut table: Option<(Vec<String>, Vec<Vec<String>>, bool)> = None;
    let mut cell: Option<Range<usize>> = None;
    let mut heading: Option<(u8, Range<usize>)> = None;
    let mut code: Option<(String, String)> = None;

    let flush_prose = |prose: &mut Option<Range<usize>>, out: &mut Vec<Block>| {
        if let Some(r) = prose.take() {
            let text = source[r].trim_end().to_string();
            if !text.is_empty() {
                out.push(Block::Prose { source: text });
            }
        }
    };

    for (event, range) in parser {
        match event {
            Event::Start(tag) => {
                let top = depth == 0;
                depth += 1;
                match tag {
                    Tag::Paragraph | Tag::List(_) | Tag::BlockQuote(_) if top => {
                        prose = Some(match prose.take() {
                            Some(r) => r.start..range.end,
                            None => range.clone(),
                        });
                        // Each top-level paragraph or list is its own row, for the list's virtualisation.
                        flush_prose(&mut prose, &mut out);
                    }
                    Tag::Heading { level, .. } if top => heading = Some((level as u8, range.clone())),
                    Tag::CodeBlock(kind) if top => {
                        let lang = match kind {
                            CodeBlockKind::Fenced(info) => info.split_whitespace().next().unwrap_or("").to_string(),
                            CodeBlockKind::Indented => String::new(),
                        };
                        code = Some((lang, String::new()));
                    }
                    Tag::Table(_) if top => table = Some((Vec::new(), Vec::new(), false)),
                    Tag::TableHead => {
                        if let Some(t) = table.as_mut() {
                            t.2 = true;
                        }
                    }
                    Tag::TableRow => {
                        if let Some(t) = table.as_mut() {
                            t.1.push(Vec::new());
                        }
                    }
                    Tag::TableCell => cell = Some(range.clone()),
                    _ => {}
                }
            }
            Event::End(tag) => {
                depth = depth.saturating_sub(1);
                match tag {
                    TagEnd::Heading(_) if depth == 0 => {
                        if let Some((level, r)) = heading.take() {
                            let text = source[r].trim_start_matches('#').trim().to_string();
                            out.push(Block::Heading { level, text });
                        }
                    }
                    TagEnd::CodeBlock if depth == 0 => {
                        if let Some((lang, body)) = code.take() {
                            out.push(code_block(lang, body));
                        }
                    }
                    TagEnd::TableHead => {
                        if let Some(t) = table.as_mut() {
                            t.2 = false;
                        }
                    }
                    TagEnd::TableCell => {
                        if let (Some(r), Some(t)) = (cell.take(), table.as_mut()) {
                            let text = source[r].trim().trim_matches('|').trim().to_string();
                            if t.2 {
                                t.0.push(text);
                            } else if let Some(row) = t.1.last_mut() {
                                row.push(text);
                            }
                        }
                    }
                    TagEnd::Table if depth == 0 => {
                        if let Some((header, rows, _)) = table.take() {
                            out.push(Block::Table { header, rows });
                        }
                    }
                    _ => {}
                }
            }
            Event::Text(text) => {
                if let Some((_, body)) = code.as_mut() {
                    body.push_str(&text);
                }
            }
            _ => {}
        }
    }
    // A fence still open at the end of a streamed prefix.
    if let Some((lang, body)) = code.take() {
        out.push(code_block(lang, body));
    }
    out
}

fn code_block(lang: String, body: String) -> Block {
    let body = body.strip_suffix('\n').map(str::to_string).unwrap_or(body);
    match lang.as_str() {
        "activity" => {
            let (title, output) = body.split_once('\n').unwrap_or((&body, ""));
            Block::Activity { title: title.to_string(), output: output.to_string() }
        }
        "diff" => Block::Diff { code: body },
        _ => Block::Code { lang, code: body },
    }
}

/// Escapes text so Slint's Markdown parser shows it literally.
pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    for ch in text.chars() {
        if ch.is_ascii_punctuation() {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// One line of coloured code as StyledText markup. The opening tag comes first, so the line's
/// leading spaces are text inside it rather than indentation the Markdown parser would strip.
pub fn line_markup(spans: &[(String, String)], out: &mut String) {
    if spans.iter().all(|(_, t)| t.is_empty()) {
        out.push_str("<font color=\"#00000000\"> </font>");
        return;
    }
    for (color, text) in spans {
        if text.is_empty() {
            continue;
        }
        out.push_str("<font color=\"");
        out.push_str(color);
        out.push_str("\">");
        out.push_str(&escape(&text.replace('\t', "    ")));
        out.push_str("</font>");
    }
}

/// True when the first strong character reads right to left (Arabic, Hebrew, Syriac, Thaana, N'Ko).
pub fn starts_rtl(text: &str) -> bool {
    for ch in text.chars() {
        let c = ch as u32;
        if (0x0590..=0x08FF).contains(&c) || (0xFB1D..=0xFDFF).contains(&c) || (0xFE70..=0xFEFF).contains(&c) {
            return true;
        }
        if ch.is_alphabetic() {
            return false;
        }
    }
    false
}

/// The plain words of a Markdown fragment, for accessible names and copying.
pub fn plain(source: &str) -> String {
    let mut out = String::new();
    for event in Parser::new(source) {
        match event {
            Event::Text(t) | Event::Code(t) => out.push_str(&t),
            Event::SoftBreak | Event::HardBreak => out.push(' '),
            Event::End(TagEnd::Paragraph) | Event::End(TagEnd::Item) => out.push(' '),
            _ => {}
        }
    }
    out.trim().to_string()
}
