//! Markdown to a flat list of blocks, with pulldown-cmark (MIT).
//!
//! Nested lists are flattened into one block per item with a depth, so a
//! streaming reply grows at its last block and the transcript can re-lay only
//! that block. Fenced ```diff becomes a diff block and ```activity a folded
//! activity row (title on the first line, body after).

use pulldown_cmark::{Alignment, CodeBlockKind, Event, Options, Parser, Tag, TagEnd};
use std::ops::Range;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct SpanStyle {
    pub strong: bool,
    pub emphasis: bool,
    pub code: bool,
    pub link: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Span {
    pub range: Range<usize>,
    pub style: SpanStyle,
    pub href: Option<String>,
}

/// Text with styled spans over it. `text` is exactly what selection copies.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct Inline {
    pub text: String,
    pub spans: Vec<Span>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Align {
    Left,
    Right,
    Center,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Block {
    Heading { level: u8, inline: Inline },
    Paragraph { inline: Inline },
    ListItem { depth: usize, marker: String, inline: Inline },
    Code { lang: String, text: String, closed: bool },
    Diff { text: String, closed: bool },
    Activity { title: Inline, body: String, closed: bool },
    Table { aligns: Vec<Align>, rows: Vec<Vec<Inline>> },
    Rule,
}

impl Block {
    /// The block's text as it copies, without its decoration.
    pub fn plain_text(&self) -> String {
        match self {
            Block::Heading { inline, .. } | Block::Paragraph { inline } => inline.text.clone(),
            Block::ListItem { marker, inline, .. } => format!("{marker} {}", inline.text),
            Block::Code { text, .. } | Block::Diff { text, .. } => text.clone(),
            Block::Activity { title, body, .. } => format!("{}\n{body}", title.text),
            Block::Table { rows, .. } => rows
                .iter()
                .map(|row| row.iter().map(|cell| cell.text.as_str()).collect::<Vec<_>>().join("\t"))
                .collect::<Vec<_>>()
                .join("\n"),
            Block::Rule => String::new(),
        }
    }
}

struct ListFrame {
    ordered: Option<u64>,
}

#[derive(Default)]
struct InlineBuilder {
    inline: Inline,
    style: SpanStyle,
    href: Option<String>,
}

impl InlineBuilder {
    fn push(&mut self, text: &str, extra: SpanStyle) {
        if text.is_empty() {
            return;
        }
        let start = self.inline.text.len();
        self.inline.text.push_str(text);
        let style = SpanStyle {
            strong: self.style.strong || extra.strong,
            emphasis: self.style.emphasis || extra.emphasis,
            code: self.style.code || extra.code,
            link: self.style.link || extra.link,
        };
        if style != SpanStyle::default() {
            // Merge with the previous span when it continues it.
            if let Some(last) = self.inline.spans.last_mut()
                && last.range.end == start
                && last.style == style
                && last.href == self.href
            {
                last.range.end = self.inline.text.len();
                return;
            }
            self.inline.spans.push(Span { range: start..self.inline.text.len(), style, href: self.href.clone() });
        }
    }

    fn take(&mut self) -> Inline {
        let mut inline = std::mem::take(&mut self.inline);
        let trimmed = inline.text.trim_end().len();
        inline.text.truncate(trimmed);
        for span in &mut inline.spans {
            span.range.end = span.range.end.min(trimmed);
        }
        inline.spans.retain(|span| span.range.start < span.range.end);
        inline
    }

    fn is_empty(&self) -> bool {
        self.inline.text.trim().is_empty()
    }
}

/// Parse Markdown into blocks. `complete` says whether the source is whole; while
/// it streams, a fence with no closing line is reported as open.
pub fn parse(source: &str) -> Vec<Block> {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    let parser = Parser::new_ext(source, options).into_offset_iter();

    let mut blocks = Vec::new();
    let mut builder = InlineBuilder::default();
    let mut lists: Vec<ListFrame> = Vec::new();
    let mut item_marker: Option<String> = None;
    let mut code: Option<(String, String, Range<usize>)> = None;
    let mut heading: Option<u8> = None;
    let mut table: Option<(Vec<Align>, Vec<Vec<Inline>>)> = None;
    let mut row: Vec<Inline> = Vec::new();

    let flush_item = |builder: &mut InlineBuilder, blocks: &mut Vec<Block>, marker: &mut Option<String>, depth: usize| {
        if let Some(m) = marker.take() {
            blocks.push(Block::ListItem { depth, marker: m, inline: builder.take() });
        } else if !builder.is_empty() {
            blocks.push(Block::Paragraph { inline: builder.take() });
        }
    };

    for (event, range) in parser {
        match event {
            Event::Start(Tag::Heading { level, .. }) => heading = Some(level as u8),
            Event::End(TagEnd::Heading(_)) => {
                blocks.push(Block::Heading { level: heading.take().unwrap_or(1), inline: builder.take() });
            }
            Event::Start(Tag::Paragraph) => {}
            Event::End(TagEnd::Paragraph) => {
                if lists.is_empty() && table.is_none() {
                    blocks.push(Block::Paragraph { inline: builder.take() });
                } else if item_marker.is_some() {
                    builder.push(" ", SpanStyle::default());
                }
            }
            Event::Start(Tag::List(start)) => {
                if !lists.is_empty() {
                    let depth = lists.len() - 1;
                    flush_item(&mut builder, &mut blocks, &mut item_marker, depth);
                }
                lists.push(ListFrame { ordered: start });
            }
            Event::End(TagEnd::List(_)) => {
                lists.pop();
            }
            Event::Start(Tag::Item) => {
                let depth = lists.len().saturating_sub(1);
                flush_item(&mut builder, &mut blocks, &mut item_marker, depth);
                let frame = lists.last_mut();
                item_marker = Some(match frame {
                    Some(ListFrame { ordered: Some(n) }) => {
                        let marker = format!("{n}.");
                        *n += 1;
                        marker
                    }
                    _ => "•".to_string(),
                });
            }
            Event::End(TagEnd::Item) => {
                let depth = lists.len().saturating_sub(1);
                flush_item(&mut builder, &mut blocks, &mut item_marker, depth);
            }
            Event::Start(Tag::CodeBlock(kind)) => {
                let lang = match kind {
                    CodeBlockKind::Fenced(lang) => lang.to_string(),
                    CodeBlockKind::Indented => String::new(),
                };
                code = Some((lang, String::new(), range.clone()));
            }
            Event::End(TagEnd::CodeBlock) => {
                if let Some((lang, text, range)) = code.take() {
                    // A fence is closed when the source holds its closing line.
                    let fenced = &source[range.clone()];
                    let closed = fenced.trim_end().ends_with("```") && fenced.trim_end().len() > 3 + lang.len();
                    let text = text.strip_suffix('\n').unwrap_or(&text).to_string();
                    blocks.push(match lang.as_str() {
                        "diff" => Block::Diff { text, closed },
                        "activity" => {
                            let (title, body) = text.split_once('\n').unwrap_or((text.as_str(), ""));
                            Block::Activity { title: parse_inline(title), body: body.to_string(), closed }
                        }
                        _ => Block::Code { lang, text, closed },
                    });
                }
            }
            Event::Start(Tag::Table(aligns)) => {
                table = Some((
                    aligns
                        .iter()
                        .map(|a| match a {
                            Alignment::Right => Align::Right,
                            Alignment::Center => Align::Center,
                            _ => Align::Left,
                        })
                        .collect(),
                    Vec::new(),
                ));
            }
            Event::End(TagEnd::Table) => {
                if let Some((aligns, rows)) = table.take() {
                    blocks.push(Block::Table { aligns, rows });
                }
            }
            Event::Start(Tag::TableHead) | Event::Start(Tag::TableRow) => row = Vec::new(),
            Event::End(TagEnd::TableHead) | Event::End(TagEnd::TableRow) => {
                if let Some((_, rows)) = table.as_mut() {
                    rows.push(std::mem::take(&mut row));
                }
            }
            Event::Start(Tag::TableCell) => {}
            Event::End(TagEnd::TableCell) => row.push(builder.take()),
            Event::Start(Tag::Strong) => builder.style.strong = true,
            Event::End(TagEnd::Strong) => builder.style.strong = false,
            Event::Start(Tag::Emphasis) => builder.style.emphasis = true,
            Event::End(TagEnd::Emphasis) => builder.style.emphasis = false,
            Event::Start(Tag::Link { dest_url, .. }) => {
                builder.style.link = true;
                builder.href = Some(dest_url.to_string());
            }
            Event::End(TagEnd::Link) => {
                builder.style.link = false;
                builder.href = None;
            }
            Event::Text(text) => {
                if let Some((_, buffer, _)) = code.as_mut() {
                    buffer.push_str(&text);
                } else {
                    builder.push(&text, SpanStyle::default());
                }
            }
            Event::Code(text) => builder.push(&text, SpanStyle { code: true, ..Default::default() }),
            Event::SoftBreak => builder.push(" ", SpanStyle::default()),
            Event::HardBreak => builder.push("\n", SpanStyle::default()),
            Event::Rule => blocks.push(Block::Rule),
            _ => {}
        }
    }
    // A streaming source can end inside a paragraph or an item.
    if let Some((lang, text, _)) = code.take() {
        blocks.push(Block::Code { lang, text, closed: false });
    }
    let depth = lists.len().saturating_sub(1);
    flush_item(&mut builder, &mut blocks, &mut item_marker, depth);
    blocks
}

/// Inline Markdown for a single line, such as an activity row's title.
pub fn parse_inline(source: &str) -> Inline {
    match parse(source).into_iter().next() {
        Some(Block::Paragraph { inline }) => inline,
        _ => Inline { text: source.to_string(), spans: Vec::new() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_lists_flatten_with_depth() {
        let blocks = parse("1. One\n   - Two\n     - Three\n2. Four\n");
        let items: Vec<_> = blocks
            .iter()
            .map(|b| match b {
                Block::ListItem { depth, marker, inline } => (*depth, marker.clone(), inline.text.clone()),
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(
            items,
            vec![
                (0, "1.".into(), "One".into()),
                (1, "•".into(), "Two".into()),
                (2, "•".into(), "Three".into()),
                (0, "2.".into(), "Four".into()),
            ]
        );
    }

    #[test]
    fn activity_and_diff_fences_become_their_own_blocks() {
        let blocks = parse("```activity\nRan `npm test`\n41 passed\n```\n\n```diff\n-a\n+b\n```\n");
        assert!(matches!(&blocks[0], Block::Activity { title, body, closed: true } if title.text == "Ran npm test" && body == "41 passed"));
        assert!(matches!(&blocks[1], Block::Diff { text, closed: true } if text == "-a\n+b"));
    }

    #[test]
    fn an_open_fence_is_reported_open() {
        let blocks = parse("```rust\nfn main() {\n");
        assert!(matches!(&blocks[0], Block::Code { closed: false, .. }));
    }

    #[test]
    fn the_whole_reply_parses_into_the_expected_parts() {
        let blocks = parse(&crate::content::long_reply());
        let count = |f: fn(&Block) -> bool| blocks.iter().filter(|b| f(b)).count();
        assert_eq!(count(|b| matches!(b, Block::Activity { .. })), 12);
        assert_eq!(count(|b| matches!(b, Block::Code { .. })), 6);
        assert_eq!(count(|b| matches!(b, Block::Diff { .. })), 1);
        assert_eq!(count(|b| matches!(b, Block::Table { .. })), 2);
        assert!(count(|b| matches!(b, Block::ListItem { depth: 2, .. })) >= 2);
    }
}
