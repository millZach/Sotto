//! The thread's transcript: 200 earlier messages, then one long reply that
//! streams in. Drawn as a virtualised GPUI `list`, one row per earlier message
//! and one row per block of the reply, so a chunk re-lays only the block it
//! lands in.
//!
//! Selection is the transcript's own: every run of text is a "unit" with a
//! place in reading order, and a selection runs from one unit to another across
//! blocks and messages. Copy writes the units' text, not what is on screen.

use crate::{
    UI_FONT,
    highlight::{self, Class},
    markdown::{Align, Block, Inline, parse},
    terminal::MONO,
    theme::Tokens,
};
use gpui::{
    AnyElement, App, Bounds, ClipboardItem, Context, Element, ElementId, Entity, FocusHandle, Focusable, FontStyle,
    FontWeight, GlobalElementId, Hsla, InspectorElementId, IntoElement, LayoutId, ListAlignment, ListState,
    MouseButton, ParentElement, Pixels, Point, Render, Role, SharedString, StatefulInteractiveElement, Styled,
    StyledText, TextLayout, TextRun, UnderlineStyle, Window, actions, div, font, list, prelude::*, px,
};
use gpui::AnimationExt;
use std::{cell::RefCell, collections::HashSet, ops::Range, rc::Rc};

actions!(transcript, [CopySelection, SelectAllText, ScrollUp, ScrollDown, PageUp, PageDown, ToTop, ToBottom]);

/// Where a selection end sits: which row, which unit in that row, which byte.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Pos {
    pub row: usize,
    pub unit: usize,
    pub offset: usize,
}

struct Hit {
    row: usize,
    unit: usize,
    bounds: Bounds<Pixels>,
    layout: TextLayout,
}

pub struct Message {
    pub from_user: bool,
    pub who: SharedString,
    pub time: SharedString,
    pub blocks: Vec<Block>,
}

pub struct Transcript {
    pub focus: FocusHandle,
    pub list: ListState,
    messages: Vec<Message>,
    reply_who: SharedString,
    reply_time: SharedString,
    reply_source: String,
    pub reply_blocks: Vec<Block>,
    pub streaming: bool,
    open: HashSet<usize>,
    selection: Option<(Pos, Pos)>,
    selecting: bool,
    hits: Rc<RefCell<Vec<Hit>>>,
    highlights: Rc<RefCell<highlight::Cache>>,
    pub tokens: Tokens,
    pub reduce_motion: bool,
    /// Bumped on every chunk, so the frame log can tell a streaming frame.
    pub chunks_applied: u64,
}

fn row_id(row: usize, unit: usize) -> ElementId {
    ElementId::Integer((row as u64) << 20 | unit as u64)
}

/// Whether text reads right to left, from its first strong character.
pub fn is_rtl(text: &str) -> bool {
    for c in text.chars() {
        let cp = c as u32;
        let rtl = (0x0590..=0x08FF).contains(&cp) || (0xFB1D..=0xFDFF).contains(&cp) || (0xFE70..=0xFEFF).contains(&cp);
        if rtl {
            return true;
        }
        if c.is_alphabetic() {
            return false;
        }
    }
    false
}

impl Transcript {
    pub fn new(tokens: Tokens, cx: &mut Context<Self>) -> Self {
        let mut messages: Vec<Message> = crate::content::earlier_messages()
            .into_iter()
            .map(|m| Message {
                from_user: m.from_user,
                who: if m.from_user { "You".into() } else { "Claude".into() },
                time: m.time.into(),
                blocks: parse(&m.markdown),
            })
            .collect();
        messages.push(Message {
            from_user: true,
            who: "You".into(),
            time: "4:41 pm".into(),
            blocks: parse(crate::content::LAST_ASK),
        });
        let rows = messages.len();
        let list = ListState::new(rows, ListAlignment::Bottom, px(600.));
        list.set_follow_mode(gpui::FollowMode::Tail);
        Transcript {
            focus: cx.focus_handle().tab_stop(true),
            list,
            messages,
            reply_who: "Claude".into(),
            reply_time: "4:41 pm".into(),
            reply_source: String::new(),
            reply_blocks: Vec::new(),
            streaming: false,
            open: HashSet::new(),
            selection: None,
            selecting: false,
            hits: Rc::new(RefCell::new(Vec::new())),
            highlights: Rc::new(RefCell::new(highlight::Cache::default())),
            tokens,
            reduce_motion: false,
            chunks_applied: 0,
        }
    }

    fn rows(&self) -> usize {
        self.messages.len() + self.reply_blocks.len() + usize::from(self.streaming)
    }

    pub fn start_stream(&mut self, cx: &mut Context<Self>) {
        let before = self.rows();
        self.reply_source.clear();
        self.reply_blocks.clear();
        self.open.clear();
        self.streaming = true;
        self.list.splice(self.messages.len()..before, self.rows() - self.messages.len());
        self.list.set_follow_mode(gpui::FollowMode::Tail);
        cx.notify();
    }

    /// Add one chunk of the reply and re-lay only the blocks it changed.
    pub fn push_chunk(&mut self, chunk: &str, cx: &mut Context<Self>) {
        self.reply_source.push_str(chunk);
        let blocks = parse(&self.reply_source);
        let first_changed = self
            .reply_blocks
            .iter()
            .zip(blocks.iter())
            .position(|(a, b)| a != b)
            .unwrap_or(self.reply_blocks.len().min(blocks.len()));
        let base = self.messages.len();
        let old_tail = self.reply_blocks.len() - first_changed;
        let new_tail = blocks.len() - first_changed;
        self.reply_blocks = blocks;
        if old_tail > 0 || new_tail > 0 {
            self.list.splice(base + first_changed..base + first_changed + old_tail, new_tail);
        }
        self.chunks_applied += 1;
        cx.notify();
    }

    pub fn end_stream(&mut self, cx: &mut Context<Self>) {
        if self.streaming {
            self.streaming = false;
            let working_row = self.messages.len() + self.reply_blocks.len();
            self.list.splice(working_row..working_row + 1, 0);
            cx.notify();
        }
    }

    pub fn add_user_message(&mut self, text: String, cx: &mut Context<Self>) {
        // The finished reply becomes an ordinary message, and the new ask follows it.
        let reply_rows = self.reply_blocks.len() + usize::from(self.streaming);
        let start = self.messages.len();
        if !self.reply_blocks.is_empty() {
            self.messages.push(Message {
                from_user: false,
                who: self.reply_who.clone(),
                time: self.reply_time.clone(),
                blocks: std::mem::take(&mut self.reply_blocks),
            });
        }
        self.messages.push(Message { from_user: true, who: "You".into(), time: "now".into(), blocks: parse(&text) });
        self.streaming = false;
        self.list.splice(start..start + reply_rows, self.messages.len() - start);
        self.selection = None;
        cx.notify();
    }

    pub fn jump_to_latest(&mut self, cx: &mut Context<Self>) {
        self.list.set_follow_mode(gpui::FollowMode::Tail);
        self.list.scroll_to_end();
        cx.notify();
    }

    pub fn is_following(&self) -> bool {
        self.list.is_following_tail() || self.list.is_scrolled_to_end().unwrap_or(true)
    }

    // ----- selection -----

    fn units_of_block(&self, block: &Block, open: bool) -> Vec<String> {
        match block {
            Block::Heading { inline, .. } | Block::Paragraph { inline } | Block::ListItem { inline, .. } => {
                vec![inline.text.clone()]
            }
            Block::Code { text, .. } => vec![text.clone()],
            Block::Diff { text, .. } => text.lines().map(str::to_string).collect(),
            Block::Activity { title, body, .. } => {
                if open { vec![title.text.clone(), body.clone()] } else { vec![title.text.clone()] }
            }
            Block::Table { rows, .. } => rows.iter().flatten().map(|c| c.text.clone()).collect(),
            Block::Rule => vec![],
        }
    }

    fn units_of_row(&self, row: usize) -> Vec<String> {
        if row < self.messages.len() {
            self.messages[row].blocks.iter().flat_map(|b| self.units_of_block(b, false)).collect()
        } else if let Some(block) = self.reply_blocks.get(row - self.messages.len()) {
            let ix = row - self.messages.len();
            self.units_of_block(block, self.open.contains(&ix))
        } else {
            Vec::new()
        }
    }

    fn selected_text(&self) -> Option<String> {
        let (a, b) = self.selection?;
        let (start, end) = if a <= b { (a, b) } else { (b, a) };
        let mut out = Vec::new();
        for row in start.row..=end.row {
            let units = self.units_of_row(row);
            for (u, text) in units.iter().enumerate() {
                let here = Pos { row, unit: u, offset: 0 };
                let there = Pos { row, unit: u, offset: text.len() };
                if there < start || here > end {
                    continue;
                }
                let from = if start.row == row && start.unit == u { start.offset.min(text.len()) } else { 0 };
                let to = if end.row == row && end.unit == u { end.offset.min(text.len()) } else { text.len() };
                if from < to {
                    out.push(text[from..to].to_string());
                }
            }
        }
        Some(out.join("\n"))
    }

    fn selected_range_in(&self, row: usize, unit: usize, len: usize) -> Option<Range<usize>> {
        let (a, b) = self.selection?;
        let (start, end) = if a <= b { (a, b) } else { (b, a) };
        let here = Pos { row, unit, offset: 0 };
        let there = Pos { row, unit, offset: len };
        if there < start || here > end || start == end {
            return None;
        }
        let from = if start.row == row && start.unit == unit { start.offset.min(len) } else { 0 };
        let to = if end.row == row && end.unit == unit { end.offset.min(len) } else { len };
        (from < to).then_some(from..to)
    }

    fn hit(&self, position: Point<Pixels>) -> Option<Pos> {
        let hits = self.hits.borrow();
        let mut best: Option<(&Hit, f32)> = None;
        for hit in hits.iter() {
            let b = hit.bounds;
            let dy = if position.y < b.top() {
                f32::from(b.top() - position.y)
            } else if position.y > b.bottom() {
                f32::from(position.y - b.bottom())
            } else {
                0.
            };
            let dx = if position.x < b.left() {
                f32::from(b.left() - position.x)
            } else if position.x > b.right() {
                f32::from(position.x - b.right())
            } else {
                0.
            };
            let d = dy * 4. + dx;
            if best.as_ref().is_none_or(|(_, bd)| d < *bd) {
                best = Some((hit, d));
            }
        }
        let (hit, _) = best?;
        let clamped = Point {
            x: position.x.clamp(hit.bounds.left(), hit.bounds.right()),
            y: position.y.clamp(hit.bounds.top(), hit.bounds.bottom() - px(1.)),
        };
        let offset = match hit.layout.index_for_position(clamped) {
            Ok(i) | Err(i) => i,
        };
        Some(Pos { row: hit.row, unit: hit.unit, offset: offset.min(hit.layout.len()) })
    }

    fn mouse_down(&mut self, event: &gpui::MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        if let Some(pos) = self.hit(event.position) {
            if event.modifiers.shift
                && let Some((anchor, _)) = self.selection
            {
                self.selection = Some((anchor, pos));
            } else {
                self.selection = Some((pos, pos));
            }
            self.selecting = true;
            cx.notify();
        }
    }

    fn mouse_move(&mut self, event: &gpui::MouseMoveEvent, cx: &mut Context<Self>) {
        if self.selecting
            && event.pressed_button == Some(MouseButton::Left)
            && let Some(pos) = self.hit(event.position)
            && let Some((anchor, head)) = self.selection
            && head != pos
        {
            self.selection = Some((anchor, pos));
            cx.notify();
        }
    }

    fn copy(&mut self, _: &CopySelection, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = self.selected_text() {
            cx.write_to_clipboard(ClipboardItem::new_string(text));
        }
    }

    fn select_all(&mut self, _: &SelectAllText, _: &mut Window, cx: &mut Context<Self>) {
        let last = self.rows().saturating_sub(1);
        let units = self.units_of_row(last);
        let end = Pos { row: last, unit: units.len().saturating_sub(1), offset: units.last().map_or(0, |u| u.len()) };
        self.selection = Some((Pos { row: 0, unit: 0, offset: 0 }, end));
        cx.notify();
    }

    fn scroll(&mut self, by: Pixels, cx: &mut Context<Self>) {
        self.list.scroll_by(by);
        cx.notify();
    }

    pub fn toggle_activity(&mut self, ix: usize, cx: &mut Context<Self>) {
        if !self.open.remove(&ix) {
            self.open.insert(ix);
        }
        let row = self.messages.len() + ix;
        self.list.splice(row..row + 1, 1);
        cx.notify();
    }

    // ----- drawing -----

    fn render_row(&mut self, row: usize, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let t = &self.tokens;
        let column = div().w_full().flex().justify_center().px(px(24.));
        let inner = div().w_full().max_w(px(760.)).flex().flex_col();
        if row < self.messages.len() {
            let message = &self.messages[row];
            let mut units = 0usize;
            let body: Vec<AnyElement> =
                message.blocks.iter().map(|b| self.render_block(row, &mut units, b, false, None, message.from_user, window, cx)).collect();
            let header = div()
                .flex()
                .gap(px(8.))
                .items_baseline()
                .text_size(px(12.))
                .text_color(t.transcript_muted.hsla())
                .child(div().font_weight(FontWeight::MEDIUM).text_color(t.reading_text_2.hsla()).child(message.who.clone()))
                .child(message.time.clone());
            let card = if message.from_user {
                div()
                    .id(row_id(row, 0xFFFFF))
                    .role(Role::Article)
                    .aria_label(SharedString::from(format!("{}, {}", message.who, message.time)))
                    .self_end()
                    .max_w(px(560.))
                    .px(px(16.))
                    .py(px(12.))
                    .rounded(px(14.))
                    .bg(t.bubble.hsla())
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(header)
                    .children(body)
            } else {
                div()
                    .id(row_id(row, 0xFFFFF))
                    .role(Role::Article)
                    .aria_label(SharedString::from(format!("{}, {}", message.who, message.time)))
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(header)
                    .children(body)
            };
            return column.pt(px(if row == 0 { 24. } else { 0. })).pb(px(28.)).child(inner.child(card)).into_any_element();
        }

        let ix = row - self.messages.len();
        if ix >= self.reply_blocks.len() {
            // The working line while the reply streams.
            return column.pb(px(24.)).child(inner.child(self.working_line())).into_any_element();
        }
        let block = self.reply_blocks[ix].clone();
        let open = self.open.contains(&ix);
        let mut units = 0usize;
        let is_last = ix + 1 == self.reply_blocks.len();
        let el = self.render_block(row, &mut units, &block, open, Some(ix), false, window, cx);
        let mut inner = inner;
        if ix == 0 {
            inner = inner.child(
                div()
                    .flex()
                    .gap(px(8.))
                    .text_size(px(12.))
                    .text_color(t.transcript_muted.hsla())
                    .pb(px(8.))
                    .child(div().font_weight(FontWeight::MEDIUM).text_color(t.reading_text_2.hsla()).child(self.reply_who.clone()))
                    .child(self.reply_time.clone()),
            );
        }
        let gap = match block {
            Block::ListItem { .. } => 5.,
            Block::Activity { .. } => 6.,
            Block::Heading { .. } => 10.,
            _ => 14.,
        };
        let mut wrapped = inner.child(el);
        if is_last && self.streaming {
            wrapped = wrapped.child(self.caret());
        }
        column.pb(px(gap)).child(wrapped).into_any_element()
    }

    fn caret(&self) -> AnyElement {
        let accent = self.tokens.accent_text.hsla();
        let caret = div().id("stream-caret").w(px(8.)).h(px(16.)).rounded(px(2.)).bg(accent);
        if self.reduce_motion {
            caret.into_any_element()
        } else {
            caret
                .with_animation(
                    "caret-pulse",
                    gpui::Animation::new(std::time::Duration::from_millis(900)).repeat(),
                    |el, delta| el.opacity(0.35 + 0.65 * (1. - (delta * std::f32::consts::PI * 2.).cos()) / 2.),
                )
                .into_any_element()
        }
    }

    fn working_line(&self) -> AnyElement {
        let t = &self.tokens;
        let label = div()
            .id("working")
            .role(Role::Status)
            .aria_label("Writing a reply")
            .text_size(px(13.))
            .text_color(t.transcript_muted.hsla())
            .child("Writing a reply");
        if self.reduce_motion {
            label.into_any_element()
        } else {
            label
                .with_animation(
                    "working-light",
                    gpui::Animation::new(std::time::Duration::from_millis(1600)).repeat(),
                    |el, delta| el.opacity(0.55 + 0.45 * (1. - (delta * std::f32::consts::PI * 2.).cos()) / 2.),
                )
                .into_any_element()
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn unit(
        &self,
        row: usize,
        units: &mut usize,
        inline: &Inline,
        style: RunLook,
        role: Role,
        level: Option<usize>,
    ) -> Unit {
        let unit = *units;
        *units += 1;
        let sel = self.selected_range_in(row, unit, inline.text.len());
        let runs = runs_for(inline, &style, &self.tokens, sel);
        Unit {
            id: row_id(row, unit),
            row,
            unit,
            text: StyledText::new(SharedString::from(inline.text.clone())).with_runs(runs),
            hits: self.hits.clone(),
            role,
            level,
            label: inline.text.clone().into(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn render_block(
        &self,
        row: usize,
        units: &mut usize,
        block: &Block,
        open: bool,
        reply_ix: Option<usize>,
        in_bubble: bool,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = &self.tokens;
        let prose = RunLook {
            size: px(15.),
            color: if in_bubble { t.bubble_text.hsla() } else { t.reading_text_2.hsla() },
            weight: FontWeight::NORMAL,
            family: UI_FONT,
        };
        let line_height = |size: f32| px((size * 1.6).round());
        match block {
            Block::Heading { level, inline } => {
                let size = match level {
                    1 => 22.,
                    2 => 18.,
                    _ => 16.,
                };
                let look = RunLook { size: px(size), color: t.rich_strong.hsla(), weight: FontWeight::SEMIBOLD, ..prose };
                let rtl = is_rtl(&inline.text);
                div()
                    .pt(px(if *level <= 2 { 14. } else { 6. }))
                    .text_size(px(size))
                    .line_height(px((size * 1.35).round()))
                    .when(rtl, |d| d.text_right())
                    .child(self.unit(row, units, inline, look, Role::Heading, Some(*level as usize)))
                    .into_any_element()
            }
            Block::Paragraph { inline } => {
                let rtl = is_rtl(&inline.text);
                div()
                    .max_w(px(680.))
                    .when(rtl, |d| d.w_full().max_w(px(760.)).text_right())
                    .line_height(line_height(15.))
                    .child(self.unit(row, units, inline, prose, Role::Paragraph, None))
                    .into_any_element()
            }
            Block::ListItem { depth, marker, inline } => div()
                .flex()
                .max_w(px(680.))
                .pl(px(*depth as f32 * 22.))
                .line_height(line_height(15.))
                .child(div().flex_none().w(px(22.)).text_color(t.transcript_muted.hsla()).text_size(px(15.)).child(marker.clone()))
                .child(div().flex_1().min_w_0().child(self.unit(row, units, inline, prose, Role::ListItem, None)))
                .into_any_element(),
            Block::Code { lang, text, .. } => {
                let classes = self.highlights.borrow_mut().get(lang, text);
                let inline = Inline { text: text.clone(), spans: Vec::new() };
                let unit = *units;
                *units += 1;
                let sel = self.selected_range_in(row, unit, text.len());
                let runs = code_runs(text, &classes, t, sel);
                let code = Unit {
                    id: row_id(row, unit),
                    row,
                    unit,
                    text: StyledText::new(SharedString::from(inline.text.clone())).with_runs(runs),
                    hits: self.hits.clone(),
                    role: Role::Code,
                    level: None,
                    label: SharedString::from(format!("{} code: {}", language_name(lang), text)),
                };
                div()
                    .rounded(px(10.))
                    .border_1()
                    .border_color(t.reading_hairline.alpha(0.6).hsla())
                    .bg(t.code_bg.hsla())
                    .overflow_hidden()
                    .child(
                        div()
                            .h(px(32.))
                            .px(px(14.))
                            .flex()
                            .items_center()
                            .font_family(MONO)
                            .text_size(px(12.))
                            .text_color(t.transcript_muted.hsla())
                            .child(language_name(lang)),
                    )
                    .child(
                        div()
                            .id(row_id(row, 0xFFFF0 + unit))
                            .px(px(14.))
                            .pb(px(14.))
                            .overflow_x_scroll()
                            .whitespace_nowrap()
                            .text_size(px(13.))
                            .line_height(px(21.))
                            .child(code),
                    )
                    .into_any_element()
            }
            Block::Diff { text, .. } => {
                let rows: Vec<AnyElement> = text
                    .lines()
                    .map(|line| {
                        let (bg, edge, sign_color) = if line.starts_with('+') && !line.starts_with("+++") {
                            (Some(t.diff_added.hsla()), Some(t.diff_edge_added.hsla()), t.success.hsla())
                        } else if line.starts_with('-') && !line.starts_with("---") {
                            (Some(t.diff_removed.hsla()), Some(t.diff_edge_removed.hsla()), t.error.hsla())
                        } else {
                            (None, None, t.code_text.hsla())
                        };
                        let hunk = line.starts_with("@@");
                        let meta = line.starts_with("diff ") || line.starts_with("index ") || line.starts_with("---") || line.starts_with("+++");
                        let color = if hunk || meta { t.transcript_muted.hsla() } else { t.code_text.hsla() };
                        let unit = *units;
                        *units += 1;
                        let sel = self.selected_range_in(row, unit, line.len());
                        let mut runs = vec![];
                        let sign_len = if !hunk && !meta && !line.is_empty() { line.chars().next().unwrap().len_utf8() } else { 0 };
                        push_run(&mut runs, sign_len, sign_color, MONO, px(13.), FontWeight::NORMAL, false, None);
                        push_run(&mut runs, line.len() - sign_len, color, MONO, px(13.), FontWeight::NORMAL, false, None);
                        let runs = apply_selection(runs, sel, t.selection.hsla());
                        let el = Unit {
                            id: row_id(row, unit),
                            row,
                            unit,
                            text: StyledText::new(SharedString::from(line.to_string())).with_runs(runs),
                            hits: self.hits.clone(),
                            role: Role::Paragraph,
                            level: None,
                            label: line.to_string().into(),
                        };
                        div()
                            .px(px(12.))
                            .min_h(px(20.))
                            .line_height(px(20.))
                            .when_some(bg, |d, bg| d.bg(bg))
                            .when_some(edge, |d, edge| d.border_l_2().border_color(edge))
                            .when(edge.is_none(), |d| d.pl(px(14.)))
                            .child(el)
                            .into_any_element()
                    })
                    .collect();
                div()
                    .id(row_id(row, 0xFFFF1))
                    .role(Role::Group)
                    .aria_label("Diff of src/harbor/scheduler.ts")
                    .rounded(px(10.))
                    .border_1()
                    .border_color(t.reading_hairline.alpha(0.6).hsla())
                    .bg(t.code_bg.hsla())
                    .py(px(8.))
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_size(px(13.))
                    .children(rows)
                    .into_any_element()
            }
            Block::Activity { title, body, .. } => {
                let ix = reply_ix.unwrap_or(usize::MAX);
                let entity = cx.entity().downgrade();
                let look = RunLook { size: px(13.), color: t.transcript_muted.hsla(), weight: FontWeight::NORMAL, family: UI_FONT };
                let title_unit = self.unit(row, units, title, look, Role::Label, None);
                let chevron = if open { "▾" } else { "▸" };
                let label = format!("{}. {}", title.text, if open { "Expanded" } else { "Collapsed" });
                let mut el = div()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .id(row_id(row, 0xFFFF2))
                            .role(Role::Button)
                            .aria_label(SharedString::from(label))
                            .aria_expanded(open)
                            .focusable()
                            .tab_stop(true)
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .text_size(px(13.))
                            .px(px(6.))
                            .py(px(2.))
                            .rounded(px(6.))
                            .cursor_pointer()
                            .hover(|s| s.bg(t.hover.hsla()))
                            .focus_visible(|s| s.border_2().border_color(t.focus_ring.hsla()))
                            .border_2()
                            .border_color(gpui::transparent_black())
                            .on_click(move |_, _, cx| {
                                entity.update(cx, |this, cx| this.toggle_activity(ix, cx)).ok();
                            })
                            .child(div().text_size(px(11.)).text_color(t.transcript_muted.hsla()).w(px(12.)).child(chevron))
                            .child(title_unit),
                    );
                if open {
                    let inline = Inline { text: body.clone(), spans: Vec::new() };
                    let look = RunLook { size: px(13.), color: t.code_text.hsla(), weight: FontWeight::NORMAL, family: MONO };
                    el = el.child(
                        div()
                            .ml(px(24.))
                            .mt(px(4.))
                            .p(px(10.))
                            .rounded(px(8.))
                            .bg(t.code_bg.hsla())
                            .text_size(px(13.))
                            .line_height(px(20.))
                            .child(self.unit(row, units, &inline, look, Role::Paragraph, None)),
                    );
                }
                el.into_any_element()
            }
            Block::Table { aligns, rows } => {
                let cols = aligns.len().max(1);
                let body: Vec<AnyElement> = rows
                    .iter()
                    .enumerate()
                    .map(|(r, cells)| {
                        let header = r == 0;
                        let look = RunLook {
                            weight: if header { FontWeight::SEMIBOLD } else { FontWeight::NORMAL },
                            color: if header { t.rich_strong.hsla() } else { t.reading_text_2.hsla() },
                            size: px(14.),
                            ..prose
                        };
                        let cells: Vec<AnyElement> = (0..cols)
                            .map(|c| {
                                let empty = Inline::default();
                                let inline = cells.get(c).unwrap_or(&empty);
                                let align = aligns.get(c).cloned().unwrap_or(Align::Left);
                                div()
                                    .flex_1()
                                    .min_w(px(90.))
                                    .px(px(12.))
                                    .py(px(7.))
                                    .when(align == Align::Right, |d| d.text_right())
                                    .when(align == Align::Center, |d| d.text_center())
                                    .child(self.unit(row, units, inline, look, if header { Role::ColumnHeader } else { Role::Cell }, None))
                                    .into_any_element()
                            })
                            .collect();
                        div()
                            .id(row_id(row, 0xFFFF8 + r.min(6)))
                            .role(Role::Row)
                            .flex()
                            .border_b_1()
                            .border_color(t.reading_hairline.hsla())
                            .when(r > 0 && r % 2 == 0, |d| d.bg(t.table_stripe.hsla()))
                            .children(cells)
                            .into_any_element()
                    })
                    .collect();
                div()
                    .id(row_id(row, 0xFFFF3))
                    .role(Role::Table)
                    .aria_label("Table")
                    .w_full()
                    .overflow_x_scroll()
                    .text_size(px(14.))
                    .line_height(px(21.))
                    .child(div().min_w(px(cols as f32 * 110.)).flex().flex_col().children(body))
                    .into_any_element()
            }
            Block::Rule => div().h(px(1.)).bg(t.reading_hairline.hsla()).into_any_element(),
        }
    }
}

fn language_name(lang: &str) -> String {
    match lang {
        "ts" => "TypeScript".into(),
        "rust" => "Rust".into(),
        "json" => "JSON".into(),
        "sh" => "Shell".into(),
        "" => "Code".into(),
        other => other.to_string(),
    }
}

#[derive(Clone, Copy)]
struct RunLook {
    size: Pixels,
    color: Hsla,
    weight: FontWeight,
    family: &'static str,
}

#[allow(clippy::too_many_arguments)]
fn push_run(
    runs: &mut Vec<TextRun>,
    len: usize,
    color: Hsla,
    family: &'static str,
    _size: Pixels,
    weight: FontWeight,
    italic: bool,
    underline: Option<UnderlineStyle>,
) {
    if len == 0 {
        return;
    }
    runs.push(TextRun {
        len,
        font: gpui::Font { weight, style: if italic { FontStyle::Italic } else { FontStyle::Normal }, ..font(family) },
        color,
        background_color: None,
        underline,
        strikethrough: None,
    });
}

/// Split runs at a selection and give the selected part the selection's background.
fn apply_selection(runs: Vec<TextRun>, sel: Option<Range<usize>>, color: Hsla) -> Vec<TextRun> {
    let Some(sel) = sel else { return runs };
    let mut out = Vec::with_capacity(runs.len() + 2);
    let mut at = 0;
    for run in runs {
        let end = at + run.len;
        let mut cut = vec![at, end];
        for b in [sel.start, sel.end] {
            if b > at && b < end {
                cut.push(b);
            }
        }
        cut.sort();
        cut.dedup();
        for w in cut.windows(2) {
            let selected = w[0] >= sel.start && w[1] <= sel.end;
            out.push(TextRun { len: w[1] - w[0], background_color: selected.then_some(color), ..run.clone() });
        }
        at = end;
    }
    out
}

fn runs_for(inline: &Inline, look: &RunLook, t: &Tokens, sel: Option<Range<usize>>) -> Vec<TextRun> {
    let mut runs = Vec::new();
    let mut at = 0;
    for span in &inline.spans {
        if span.range.start > at {
            push_run(&mut runs, span.range.start - at, look.color, look.family, look.size, look.weight, false, None);
        }
        let s = span.style;
        let (family, color) = if s.code {
            (MONO, t.code_text.hsla())
        } else if s.link {
            (look.family, t.link.hsla())
        } else {
            (look.family, look.color)
        };
        let weight = if s.strong { FontWeight::SEMIBOLD } else { look.weight };
        let underline = s.link.then(|| UnderlineStyle { color: Some(t.link.alpha(0.5).hsla()), thickness: px(1.), wavy: false });
        push_run(&mut runs, span.range.end - span.range.start, color, family, look.size, weight, s.emphasis, underline);
        if s.code
            && let Some(last) = runs.last_mut()
        {
            last.background_color = Some(t.code_chip.hsla());
        }
        at = span.range.end;
    }
    if at < inline.text.len() {
        push_run(&mut runs, inline.text.len() - at, look.color, look.family, look.size, look.weight, false, None);
    }
    apply_selection(runs, sel, t.selection.hsla())
}

fn code_runs(text: &str, classes: &[(Range<usize>, Class)], t: &Tokens, sel: Option<Range<usize>>) -> Vec<TextRun> {
    let mut runs = Vec::new();
    let mut at = 0;
    for (range, class) in classes {
        if range.start < at || range.end > text.len() {
            continue;
        }
        push_run(&mut runs, range.start - at, t.code_text.hsla(), MONO, px(13.), FontWeight::NORMAL, false, None);
        let (color, weight, italic) = match class {
            Class::Keyword => (t.syntax_keyword, FontWeight::NORMAL, false),
            Class::String => (t.syntax_string, FontWeight::NORMAL, false),
            Class::Number => (t.syntax_number, FontWeight::NORMAL, false),
            Class::Type => (t.syntax_type, FontWeight::NORMAL, false),
            Class::Title => (t.code_text, FontWeight::MEDIUM, false),
            Class::Comment => (t.syntax_comment, FontWeight::NORMAL, true),
            Class::Meta => (t.syntax_meta, FontWeight::NORMAL, false),
        };
        push_run(&mut runs, range.end - range.start, color.hsla(), MONO, px(13.), weight, italic, None);
        at = range.end;
    }
    push_run(&mut runs, text.len() - at, t.code_text.hsla(), MONO, px(13.), FontWeight::NORMAL, false, None);
    apply_selection(runs, sel, t.selection.hsla())
}

impl Focusable for Transcript {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for Transcript {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.hits.borrow_mut().clear();
        if self.highlights.borrow().is_pending() {
            // Draw again when the highlighter's colour lands.
            window.request_animation_frame();
        }
        let entity = cx.entity().downgrade();
        let t = &self.tokens;
        let text_size = px(15.);
        div()
            .id("transcript")
            .role(Role::Log)
            .aria_label("Transcript")
            .key_context("Transcript")
            .track_focus(&self.focus)
            .tab_stop(true)
            .size_full()
            .text_size(text_size)
            .text_color(t.reading_text_2.hsla())
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(|this, _: &ScrollUp, _, cx| this.scroll(px(-48.), cx)))
            .on_action(cx.listener(|this, _: &ScrollDown, _, cx| this.scroll(px(48.), cx)))
            .on_action(cx.listener(|this, _: &PageUp, window, cx| {
                let h = window.viewport_size().height * 0.8;
                this.scroll(-h, cx)
            }))
            .on_action(cx.listener(|this, _: &PageDown, window, cx| {
                let h = window.viewport_size().height * 0.8;
                this.scroll(h, cx)
            }))
            .on_action(cx.listener(|this, _: &ToTop, _, cx| {
                this.list.scroll_to(gpui::ListOffset { item_ix: 0, offset_in_item: px(0.) });
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &ToBottom, _, cx| this.jump_to_latest(cx)))
            .on_mouse_down(MouseButton::Left, cx.listener(|this, e, window, cx| this.mouse_down(e, window, cx)))
            .on_mouse_move(cx.listener(|this, e, _, cx| this.mouse_move(e, cx)))
            .on_mouse_up(MouseButton::Left, cx.listener(|this, _, _, _| this.selecting = false))
            .on_mouse_up_out(MouseButton::Left, cx.listener(|this, _, _, _| this.selecting = false))
            .cursor_text()
            .child(
                list(self.list.clone(), move |ix, window, cx| {
                    entity
                        .update(cx, |this, cx| this.render_row(ix, window, cx))
                        .unwrap_or_else(|_| div().into_any_element())
                })
                .size_full(),
            )
    }
}

pub fn key_bindings() -> Vec<gpui::KeyBinding> {
    use gpui::KeyBinding;
    let c = Some("Transcript");
    vec![
        KeyBinding::new("ctrl-c", CopySelection, c),
        KeyBinding::new("ctrl-a", SelectAllText, c),
        KeyBinding::new("up", ScrollUp, c),
        KeyBinding::new("down", ScrollDown, c),
        KeyBinding::new("pageup", PageUp, c),
        KeyBinding::new("pagedown", PageDown, c),
        KeyBinding::new("home", ToTop, c),
        KeyBinding::new("end", ToBottom, c),
    ]
}

/// A run of transcript text that knows its place in reading order, reports
/// where it was drawn for hit testing, and appears to a screen reader with its
/// role and its text as its name.
pub struct Unit {
    id: ElementId,
    row: usize,
    unit: usize,
    text: StyledText,
    hits: Rc<RefCell<Vec<Hit>>>,
    role: Role,
    level: Option<usize>,
    label: SharedString,
}


impl Element for Unit {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        Some(self.id.clone())
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn a11y_role(&self) -> Option<Role> {
        Some(self.role)
    }

    fn write_a11y_info(&self, node: &mut gpui::accesskit::Node) {
        node.set_label(self.label.to_string());
        if self.role == Role::Label {
            // A label's text is its value to UI Automation.
            node.set_value(self.label.to_string());
        }
        if let Some(level) = self.level {
            node.set_level(level);
        }
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        self.text.request_layout(None, None, window, cx)
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        state: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.text.prepaint(None, None, bounds, state, window, cx);
        self.hits.borrow_mut().push(Hit { row: self.row, unit: self.unit, bounds, layout: self.text.layout().clone() });
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        state: &mut (),
        prepaint: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.text.paint(None, None, bounds, state, prepaint, window, cx);
    }
}

#[allow(dead_code)]
fn _assert_entity(_: Entity<Transcript>) {}
