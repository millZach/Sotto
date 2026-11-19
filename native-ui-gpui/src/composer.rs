//! The composer's text: multi-line editing with inline pills.
//!
//! Built on GPUI's `EntityInputHandler`, which is what the Windows IME, the
//! macOS input methods and Wayland's text-input protocol talk to. A pill (an
//! attached file or a quoted reply) is a run of text the caret cannot enter:
//! the arrow keys step over it, Backspace and Delete remove it whole, and a
//! click inside it lands at its nearer edge. It copies as its label.

use crate::theme::Tokens;
use gpui::{
    App, Bounds, ClipboardItem, Context, CursorStyle, Element, ElementId, ElementInputHandler, Entity,
    EntityInputHandler, FocusHandle, Focusable, GlobalElementId, Hsla, InspectorElementId, IntoElement, LayoutId,
    MouseButton, MouseDownEvent, MouseMoveEvent, Pixels, Point, SharedString, Style, TextRun, UTF16Selection,
    UnderlineStyle, Window, WrappedLine, actions, fill, font, point, px, relative, size,
};
use gpui::prelude::*;
use std::{cell::RefCell, ops::Range, rc::Rc, time::Instant};
use unicode_segmentation::UnicodeSegmentation;

actions!(
    composer,
    [
        Backspace, Delete, Left, Right, Up, Down, SelectLeft, SelectRight, SelectUp, SelectDown, SelectAll, Home, End,
        WordLeft, WordRight, Newline, Submit, Paste, Cut, Copy
    ]
);

/// A pill's padding: a narrow no-break space on each side, so it never wraps apart.
const PAD: char = '\u{202F}';

#[derive(Clone, Debug, PartialEq)]
pub enum PillKind {
    File,
    Quote,
}

#[derive(Clone, Debug)]
pub struct Pill {
    pub range: Range<usize>,
    pub kind: PillKind,
    pub label: String,
}

pub struct ComposerText {
    pub focus: FocusHandle,
    pub text: String,
    pub pills: Vec<Pill>,
    selected: Range<usize>,
    reversed: bool,
    marked: Option<Range<usize>>,
    goal_x: Option<Pixels>,
    selecting: bool,
    pub placeholder: SharedString,
    layout: Rc<RefCell<Option<Rc<Layout>>>>,
    /// When the last key reached the composer, for the typing-latency log.
    pub last_key_at: Option<Instant>,
    pub on_submit: Option<Box<dyn Fn(&mut Window, &mut App)>>,
    /// Where the caret was last drawn, in the window, so the input method hears when it moves.
    ime_caret: std::cell::Cell<Option<Point<Pixels>>>,
}

struct Layout {
    lines: Rc<Vec<WrappedLine>>,
    starts: Vec<usize>,
    tops: Vec<Pixels>,
    bounds: Bounds<Pixels>,
    line_height: Pixels,
    text: String,
}

impl Layout {
    fn line_for_offset(&self, offset: usize) -> usize {
        match self.starts.binary_search(&offset) {
            Ok(i) => i,
            Err(i) => i.saturating_sub(1),
        }
    }

    fn position_for(&self, offset: usize) -> Point<Pixels> {
        if self.text.is_empty() {
            return self.bounds.origin;
        }
        let i = self.line_for_offset(offset);
        let local = offset - self.starts[i];
        let p = self.lines[i].position_for_index(local, self.line_height).unwrap_or_else(|| {
            // Past the end of a wrapped line: the end of its last row.
            let width = self.lines[i].width();
            let rows = self.lines[i].wrap_boundaries().len() as f32;
            point(width.min(self.bounds.size.width), self.line_height * rows)
        });
        point(self.bounds.left() + p.x, self.bounds.top() + self.tops[i] + p.y)
    }

    fn offset_for(&self, position: Point<Pixels>) -> usize {
        // An empty composer is laid out with its hint, whose offsets are not the text's.
        if self.text.is_empty() {
            return 0;
        }
        let y = position.y - self.bounds.top();
        if y < px(0.) {
            return 0;
        }
        let mut i = 0;
        for (ix, top) in self.tops.iter().enumerate() {
            if y >= *top {
                i = ix;
            }
        }
        let local = point(position.x - self.bounds.left(), y - self.tops[i]);
        let ix = match self.lines[i].closest_index_for_position(local, self.line_height) {
            Ok(ix) | Err(ix) => ix,
        };
        let offset = (self.starts[i] + ix.min(self.lines[i].len())).min(self.text.len());
        let mut offset = offset;
        while !self.text.is_char_boundary(offset) {
            offset -= 1;
        }
        offset
    }
}

impl ComposerText {
    pub fn new(cx: &mut Context<Self>) -> Self {
        ComposerText {
            focus: cx.focus_handle().tab_stop(true),
            text: String::new(),
            pills: Vec::new(),
            selected: 0..0,
            reversed: false,
            marked: None,
            goal_x: None,
            selecting: false,
            placeholder: "Ask for a change, or reply".into(),
            layout: Rc::new(RefCell::new(None)),
            last_key_at: None,
            on_submit: None,
            ime_caret: std::cell::Cell::new(None),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.text.trim().is_empty()
    }

    pub fn clear(&mut self, cx: &mut Context<Self>) {
        self.text.clear();
        self.pills.clear();
        self.selected = 0..0;
        self.marked = None;
        cx.notify();
    }

    fn cursor(&self) -> usize {
        if self.reversed { self.selected.start } else { self.selected.end }
    }

    fn pill_at(&self, offset: usize) -> Option<&Pill> {
        self.pills.iter().find(|p| p.range.start < offset && offset < p.range.end)
    }

    /// Never leave the caret inside a pill: move it to the edge in the direction of travel.
    fn snap(&self, offset: usize, forward: bool) -> usize {
        match self.pill_at(offset) {
            Some(pill) if forward => pill.range.end,
            Some(pill) => pill.range.start,
            None => offset,
        }
    }

    fn snap_nearest(&self, offset: usize) -> usize {
        match self.pill_at(offset) {
            Some(pill) => {
                if offset - pill.range.start < pill.range.end - offset { pill.range.start } else { pill.range.end }
            }
            None => offset,
        }
    }

    fn previous_boundary(&self, offset: usize) -> usize {
        let prev = self.text.grapheme_indices(true).rev().find_map(|(i, _)| (i < offset).then_some(i)).unwrap_or(0);
        self.snap(prev, false)
    }

    fn next_boundary(&self, offset: usize) -> usize {
        let next = self.text.grapheme_indices(true).find_map(|(i, _)| (i > offset).then_some(i)).unwrap_or(self.text.len());
        self.snap(next, true)
    }

    fn word_boundary(&self, offset: usize, forward: bool) -> usize {
        let mut last = if forward { self.text.len() } else { 0 };
        for (i, word) in self.text.unicode_word_indices() {
            if forward && i + word.len() > offset {
                last = i + word.len();
                break;
            }
            if !forward && i < offset {
                last = i;
            }
        }
        self.snap(last, forward)
    }

    fn move_to(&mut self, offset: usize, window: &mut Window, cx: &mut Context<Self>) {
        self.selected = offset..offset;
        self.reversed = false;
        window.notify_text_selection_changed(&self.focus);
        cx.notify();
    }

    fn select_to(&mut self, offset: usize, window: &mut Window, cx: &mut Context<Self>) {
        if self.reversed {
            self.selected.start = offset;
        } else {
            self.selected.end = offset;
        }
        if self.selected.end < self.selected.start {
            self.reversed = !self.reversed;
            self.selected = self.selected.end..self.selected.start;
        }
        window.notify_text_selection_changed(&self.focus);
        cx.notify();
    }

    /// Replace a range, removing any pill it touches whole and moving the pills after it.
    fn replace(&mut self, mut range: Range<usize>, new_text: &str) -> Range<usize> {
        for pill in &self.pills {
            if pill.range.start < range.end && range.start < pill.range.end {
                range.start = range.start.min(pill.range.start);
                range.end = range.end.max(pill.range.end);
            }
        }
        let delta = new_text.len() as isize - (range.end - range.start) as isize;
        self.pills.retain(|p| p.range.end <= range.start || p.range.start >= range.end);
        for pill in &mut self.pills {
            if pill.range.start >= range.end {
                pill.range.start = (pill.range.start as isize + delta) as usize;
                pill.range.end = (pill.range.end as isize + delta) as usize;
            }
        }
        self.text.replace_range(range.clone(), new_text);
        range.start..range.start + new_text.len()
    }

    pub fn insert_pill(&mut self, kind: PillKind, label: &str, window: &mut Window, cx: &mut Context<Self>) {
        let display = format!("{PAD}{}{PAD}", label.replace(' ', "\u{00A0}"));
        let at = self.selected.clone();
        let inserted = self.replace(at, &display);
        self.pills.push(Pill { range: inserted.clone(), kind, label: label.to_string() });
        self.pills.sort_by_key(|p| p.range.start);
        // A space after the pill, so typing carries on outside it.
        let after = self.replace(inserted.end..inserted.end, " ");
        self.move_to(after.end, window, cx);
        window.notify_text_input_changed(&self.focus);
    }

    fn backspace(&mut self, _: &Backspace, window: &mut Window, cx: &mut Context<Self>) {
        self.mark_key();
        if self.selected.is_empty() {
            let prev = self.previous_boundary(self.cursor());
            self.select_to(prev, window, cx);
        }
        self.replace_text_in_range(None, "", window, cx);
    }

    fn delete(&mut self, _: &Delete, window: &mut Window, cx: &mut Context<Self>) {
        self.mark_key();
        if self.selected.is_empty() {
            let next = self.next_boundary(self.cursor());
            self.select_to(next, window, cx);
        }
        self.replace_text_in_range(None, "", window, cx);
    }

    fn left(&mut self, _: &Left, window: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        let to = if self.selected.is_empty() { self.previous_boundary(self.cursor()) } else { self.selected.start };
        self.move_to(to, window, cx);
    }

    fn right(&mut self, _: &Right, window: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        let to = if self.selected.is_empty() { self.next_boundary(self.cursor()) } else { self.selected.end };
        self.move_to(to, window, cx);
    }

    fn word_left(&mut self, _: &WordLeft, window: &mut Window, cx: &mut Context<Self>) {
        let to = self.word_boundary(self.cursor(), false);
        self.move_to(to, window, cx);
    }

    fn word_right(&mut self, _: &WordRight, window: &mut Window, cx: &mut Context<Self>) {
        let to = self.word_boundary(self.cursor(), true);
        self.move_to(to, window, cx);
    }

    fn vertical(&mut self, rows: f32, select: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(layout) = self.layout.borrow().clone() else { return };
        let here = layout.position_for(self.cursor());
        let x = *self.goal_x.get_or_insert(here.x);
        let target = point(x, here.y + layout.line_height * rows + layout.line_height / 2.);
        let to = if target.y < layout.bounds.top() {
            0
        } else if target.y > layout.bounds.top() + layout.tops.last().copied().unwrap_or_default()
            + layout.lines.last().map(|l| l.size(layout.line_height).height).unwrap_or_default()
        {
            self.text.len()
        } else {
            self.snap_nearest(layout.offset_for(target))
        };
        let goal = self.goal_x;
        if select { self.select_to(to, window, cx) } else { self.move_to(to, window, cx) }
        self.goal_x = goal;
    }

    fn up(&mut self, _: &Up, window: &mut Window, cx: &mut Context<Self>) {
        self.vertical(-1., false, window, cx);
    }
    fn down(&mut self, _: &Down, window: &mut Window, cx: &mut Context<Self>) {
        self.vertical(1., false, window, cx);
    }
    fn select_up(&mut self, _: &SelectUp, window: &mut Window, cx: &mut Context<Self>) {
        self.vertical(-1., true, window, cx);
    }
    fn select_down(&mut self, _: &SelectDown, window: &mut Window, cx: &mut Context<Self>) {
        self.vertical(1., true, window, cx);
    }
    fn select_left(&mut self, _: &SelectLeft, window: &mut Window, cx: &mut Context<Self>) {
        let to = self.previous_boundary(self.cursor());
        self.select_to(to, window, cx);
    }
    fn select_right(&mut self, _: &SelectRight, window: &mut Window, cx: &mut Context<Self>) {
        let to = self.next_boundary(self.cursor());
        self.select_to(to, window, cx);
    }
    fn select_all(&mut self, _: &SelectAll, window: &mut Window, cx: &mut Context<Self>) {
        self.move_to(0, window, cx);
        self.select_to(self.text.len(), window, cx);
    }
    fn home(&mut self, _: &Home, window: &mut Window, cx: &mut Context<Self>) {
        let start = self.text[..self.cursor()].rfind('\n').map(|i| i + 1).unwrap_or(0);
        self.move_to(start, window, cx);
    }
    fn end(&mut self, _: &End, window: &mut Window, cx: &mut Context<Self>) {
        let c = self.cursor();
        let end = self.text[c..].find('\n').map(|i| c + i).unwrap_or(self.text.len());
        self.move_to(end, window, cx);
    }
    fn newline(&mut self, _: &Newline, window: &mut Window, cx: &mut Context<Self>) {
        self.mark_key();
        self.replace_text_in_range(None, "\n", window, cx);
    }
    fn submit(&mut self, _: &Submit, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(on_submit) = self.on_submit.take() {
            on_submit(window, cx);
            self.on_submit = Some(on_submit);
        }
    }
    fn paste(&mut self, _: &Paste, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            self.replace_text_in_range(None, &text.replace("\r\n", "\n"), window, cx);
        }
    }
    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selected.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(self.copy_text(self.selected.clone())));
        }
    }
    fn cut(&mut self, _: &Cut, window: &mut Window, cx: &mut Context<Self>) {
        if !self.selected.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(self.copy_text(self.selected.clone())));
            self.replace_text_in_range(None, "", window, cx);
        }
    }

    /// Text as it copies: a pill as its plain label.
    fn copy_text(&self, range: Range<usize>) -> String {
        self.text[range].replace(PAD, "").replace('\u{00A0}', " ")
    }

    fn mark_key(&mut self) {
        self.last_key_at = Some(Instant::now());
    }

    fn mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        self.selecting = true;
        self.goal_x = None;
        let Some(layout) = self.layout.borrow().clone() else { return };
        let offset = self.snap_nearest(layout.offset_for(event.position));
        if event.modifiers.shift { self.select_to(offset, window, cx) } else { self.move_to(offset, window, cx) }
    }

    fn mouse_move(&mut self, event: &MouseMoveEvent, window: &mut Window, cx: &mut Context<Self>) {
        if self.selecting && event.pressed_button == Some(MouseButton::Left) {
            let Some(layout) = self.layout.borrow().clone() else { return };
            let offset = self.snap_nearest(layout.offset_for(event.position));
            self.select_to(offset, window, cx);
        }
    }

    fn utf16_to_utf8(&self, offset: usize) -> usize {
        let mut utf8 = 0;
        let mut utf16 = 0;
        for ch in self.text.chars() {
            if utf16 >= offset {
                break;
            }
            utf16 += ch.len_utf16();
            utf8 += ch.len_utf8();
        }
        utf8
    }

    fn utf8_to_utf16(&self, offset: usize) -> usize {
        self.text[..offset.min(self.text.len())].encode_utf16().count()
    }

    fn range_from_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.utf16_to_utf8(range.start)..self.utf16_to_utf8(range.end)
    }

    fn range_to_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.utf8_to_utf16(range.start)..self.utf8_to_utf16(range.end)
    }

    /// Wire the composer's actions onto its focusable root.
    pub fn bind(this: &Entity<Self>, element: gpui::Stateful<gpui::Div>, cx: &mut App) -> gpui::Stateful<gpui::Div> {
        let listener = |f: fn(&mut Self, &dyn std::any::Any, &mut Window, &mut Context<Self>)| f;
        let _ = listener;
        let e = this.clone();
        macro_rules! on {
            ($el:expr, $action:ty, $method:ident) => {{
                let e = e.clone();
                $el.on_action(move |action: &$action, window: &mut Window, cx: &mut App| {
                    e.update(cx, |this, cx| this.$method(action, window, cx));
                })
            }};
        }
        let el = element.key_context("Composer").track_focus(&this.read(cx).focus).cursor(CursorStyle::IBeam);
        let el = on!(el, Backspace, backspace);
        let el = on!(el, Delete, delete);
        let el = on!(el, Left, left);
        let el = on!(el, Right, right);
        let el = on!(el, Up, up);
        let el = on!(el, Down, down);
        let el = on!(el, SelectLeft, select_left);
        let el = on!(el, SelectRight, select_right);
        let el = on!(el, SelectUp, select_up);
        let el = on!(el, SelectDown, select_down);
        let el = on!(el, SelectAll, select_all);
        let el = on!(el, Home, home);
        let el = on!(el, End, end);
        let el = on!(el, WordLeft, word_left);
        let el = on!(el, WordRight, word_right);
        let el = on!(el, Newline, newline);
        let el = on!(el, Submit, submit);
        let el = on!(el, Paste, paste);
        let el = on!(el, Copy, copy);
        let el = on!(el, Cut, cut);
        let down = e.clone();
        let moving = e.clone();
        let up = e.clone();
        el.on_mouse_down(MouseButton::Left, move |event, window, cx| {
            down.update(cx, |this, cx| this.mouse_down(event, window, cx));
        })
        .on_mouse_move(move |event, window, cx| {
            moving.update(cx, |this, cx| this.mouse_move(event, window, cx));
        })
        .on_mouse_up(MouseButton::Left, move |_, _, cx| {
            up.update(cx, |this, _| this.selecting = false);
        })
    }
}

pub fn key_bindings() -> Vec<gpui::KeyBinding> {
    use gpui::KeyBinding;
    let c = Some("Composer");
    vec![
        KeyBinding::new("backspace", Backspace, c),
        KeyBinding::new("delete", Delete, c),
        KeyBinding::new("left", Left, c),
        KeyBinding::new("right", Right, c),
        KeyBinding::new("up", Up, c),
        KeyBinding::new("down", Down, c),
        KeyBinding::new("shift-left", SelectLeft, c),
        KeyBinding::new("shift-right", SelectRight, c),
        KeyBinding::new("shift-up", SelectUp, c),
        KeyBinding::new("shift-down", SelectDown, c),
        KeyBinding::new("ctrl-a", SelectAll, c),
        KeyBinding::new("home", Home, c),
        KeyBinding::new("end", End, c),
        KeyBinding::new("ctrl-left", WordLeft, c),
        KeyBinding::new("ctrl-right", WordRight, c),
        KeyBinding::new("shift-enter", Newline, c),
        KeyBinding::new("enter", Submit, c),
        KeyBinding::new("ctrl-v", Paste, c),
        KeyBinding::new("ctrl-c", Copy, c),
        KeyBinding::new("ctrl-x", Cut, c),
    ]
}

impl Focusable for ComposerText {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl EntityInputHandler for ComposerText {
    fn text_for_range(
        &mut self,
        range_utf16: Range<usize>,
        actual_range: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let range = self.range_from_utf16(&range_utf16);
        actual_range.replace(self.range_to_utf16(&range));
        Some(self.text[range].to_string())
    }

    fn selected_text_range(&mut self, _: bool, _: &mut Window, _: &mut Context<Self>) -> Option<UTF16Selection> {
        Some(UTF16Selection { range: self.range_to_utf16(&self.selected), reversed: self.reversed })
    }

    fn set_selected_text_range(&mut self, range_utf16: Range<usize>, window: &mut Window, cx: &mut Context<Self>) {
        let range = self.range_from_utf16(&range_utf16);
        self.selected = self.snap(range.start, false)..self.snap(range.end, true);
        self.reversed = false;
        window.notify_text_selection_changed(&self.focus);
        cx.notify();
    }

    fn text_length_utf16(&mut self, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        Some(self.text.encode_utf16().count())
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.as_ref().map(|r| self.range_to_utf16(r))
    }

    fn unmark_text(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.marked = None;
        window.notify_text_input_changed(&self.focus);
        cx.notify();
    }

    fn replace_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.mark_key();
        let range = range_utf16
            .as_ref()
            .map(|r| self.range_from_utf16(r))
            .or(self.marked.clone())
            .unwrap_or(self.selected.clone());
        let inserted = self.replace(range, new_text);
        self.selected = inserted.end..inserted.end;
        self.reversed = false;
        self.marked = None;
        self.goal_x = None;
        window.notify_text_input_changed(&self.focus);
        cx.notify();
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        new_selected_utf16: Option<Range<usize>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.mark_key();
        let range = range_utf16
            .as_ref()
            .map(|r| self.range_from_utf16(r))
            .or(self.marked.clone())
            .unwrap_or(self.selected.clone());
        let inserted = self.replace(range, new_text);
        self.marked = (!new_text.is_empty()).then_some(inserted.clone());
        let start16 = self.utf8_to_utf16(inserted.start);
        let len16 = new_text.encode_utf16().count();
        self.selected = new_selected_utf16
            .map(|s| self.range_from_utf16(&(start16 + s.start.min(len16)..start16 + s.end.min(len16))))
            .unwrap_or(inserted.end..inserted.end);
        self.reversed = false;
        window.notify_text_input_changed(&self.focus);
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        range_utf16: Range<usize>,
        _: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        // The IME places its candidate window from these bounds.
        let layout = self.layout.borrow();
        let layout = layout.as_ref()?;
        if layout.text != self.text {
            return None;
        }
        let range = self.range_from_utf16(&range_utf16);
        let start = layout.position_for(range.start);
        let end = layout.position_for(range.end);
        let end = if end.y > start.y { point(start.x + px(1.), start.y) } else { end };
        Some(Bounds::from_corners(start, point(end.x.max(start.x + px(1.)), start.y + layout.line_height)))
    }

    fn character_index_for_point(&mut self, p: Point<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        let layout = self.layout.borrow();
        let layout = layout.as_ref()?;
        Some(self.utf8_to_utf16(layout.offset_for(p)))
    }
}

/// How the composer's text looks; the variants change these.
#[derive(Clone)]
pub struct TextLook {
    pub font_size: Pixels,
    pub line_height: Pixels,
    pub max_lines: usize,
    pub text: Hsla,
    pub hint: Hsla,
    pub caret: Hsla,
    pub selection: Hsla,
    pub pill_bg: Hsla,
    pub pill_text: Hsla,
    pub pill_quote_bg: Hsla,
    pub pill_radius: Pixels,
    pub pill_border: Option<Hsla>,
}

impl TextLook {
    pub fn from_tokens(tokens: &Tokens) -> Self {
        TextLook {
            font_size: px(15.),
            line_height: px(24.),
            max_lines: 8,
            text: tokens.text.hsla(),
            hint: tokens.text_hint.hsla(),
            caret: tokens.accent.hsla(),
            selection: tokens.selection.hsla(),
            pill_bg: tokens.hover.hsla(),
            pill_text: tokens.accent_surface_text().hsla(),
            pill_quote_bg: tokens.border_faint.hsla(),
            pill_radius: px(4.),
            pill_border: None,
        }
    }
}

impl Tokens {
    pub fn accent_surface_text(&self) -> crate::theme::Lab {
        self.text
    }
}

pub struct ComposerElement {
    pub input: Entity<ComposerText>,
    pub look: TextLook,
    pub caret_visible: bool,
}

pub struct Prepaint {
    lines: Rc<Vec<WrappedLine>>,
    tops: Vec<Pixels>,
    quads: Vec<(Bounds<Pixels>, Hsla, Pixels, Option<Hsla>)>,
    caret: Option<Bounds<Pixels>>,
    placeholder: bool,
    a11y: (String, Range<usize>, String),
}


fn shape(input: &ComposerText, look: &TextLook, width: Pixels, window: &mut Window) -> (Vec<WrappedLine>, bool) {
    let placeholder = input.text.is_empty();
    let text: SharedString = if placeholder { input.placeholder.clone() } else { input.text.clone().into() };
    let base = TextRun {
        len: 0,
        font: font(crate::UI_FONT),
        color: if placeholder { look.hint } else { look.text },
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    let mut runs = Vec::new();
    let mut cursor = 0;
    fn push(runs: &mut Vec<TextRun>, cursor: &mut usize, end: usize, run: TextRun) {
        if end > *cursor {
            runs.push(TextRun { len: end - *cursor, ..run });
            *cursor = end;
        }
    }
    if !placeholder {
        // Pills and the IME's marked text get their own runs.
        let mut marks: Vec<(Range<usize>, TextRun)> = Vec::new();
        for pill in &input.pills {
            marks.push((
                pill.range.clone(),
                TextRun { color: look.pill_text, font: gpui::Font { weight: gpui::FontWeight::MEDIUM, ..font(crate::UI_FONT) }, ..base.clone() },
            ));
        }
        if let Some(marked) = &input.marked {
            marks.push((
                marked.clone(),
                TextRun { underline: Some(UnderlineStyle { color: Some(look.text), thickness: px(1.), wavy: false }), ..base.clone() },
            ));
        }
        marks.sort_by_key(|(r, _)| r.start);
        for (range, run) in marks {
            if range.start < cursor {
                continue;
            }
            push(&mut runs, &mut cursor, range.start, base.clone());
            push(&mut runs, &mut cursor, range.end, run);
        }
    }
    push(&mut runs, &mut cursor, text.len(), base.clone());
    let lines = window
        .text_system()
        .shape_text(text, look.font_size, &runs, Some(width), None)
        .map(|l| l.into_iter().collect())
        .unwrap_or_default();
    (lines, placeholder)
}

impl Element for ComposerElement {
    type RequestLayoutState = ();
    type PrepaintState = Prepaint;

    fn id(&self) -> Option<ElementId> {
        Some("composer-text".into())
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn a11y_role(&self) -> Option<gpui::Role> {
        Some(gpui::Role::MultilineTextInput)
    }

    fn write_a11y_info(&self, _node: &mut gpui::accesskit::Node) {}

    fn a11y_synthetic_children(&mut self, prepaint: &mut Prepaint, builder: &mut gpui::A11ySubtreeBuilder) {
        // The text as one run, with the caret, so a screen reader reads and follows it.
        let (text, selected, placeholder) = &prepaint.a11y;
        let run_id = builder.synthetic_node_id(0);
        let mut run = gpui::accesskit::Node::new(gpui::Role::TextRun);
        let lengths: Vec<u8> = text.chars().map(|c| c.len_utf8() as u8).collect();
        run.set_value(text.clone());
        run.set_character_lengths(lengths);
        builder.push_child(run_id, run);
        let caret = |byte: usize| gpui::accesskit::TextPosition {
            node: run_id,
            character_index: text[..byte.min(text.len())].chars().count(),
        };
        let selection = gpui::accesskit::TextSelection { anchor: caret(selected.start), focus: caret(selected.end) };
        let parent = builder.parent_node();
        parent.set_text_selection(selection);
        parent.set_value(text.clone());
        parent.set_label("Message");
        parent.set_placeholder(placeholder.clone());
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let input = self.input.clone();
        let look = self.look.clone();
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        let id = window.request_measured_layout(style, move |known, available, window, cx| {
            let width = known.width.unwrap_or(match available.width {
                gpui::AvailableSpace::Definite(w) => w,
                _ => px(600.),
            });
            let (lines, _) = shape(input.read(cx), &look, width, window);
            let rows: usize = lines.iter().map(|l| l.wrap_boundaries().len() + 1).sum::<usize>().max(1);
            size(width, look.line_height * rows.min(look.max_lines) as f32)
        });
        let _ = cx;
        (id, ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Prepaint {
        let input = self.input.read(cx);
        let (lines, placeholder) = shape(input, &self.look, bounds.size.width, window);
        let mut tops = Vec::with_capacity(lines.len());
        let mut starts = Vec::with_capacity(lines.len());
        let mut y = px(0.);
        let mut start = 0;
        for line in &lines {
            tops.push(y);
            starts.push(start);
            y += line.size(self.look.line_height).height;
            start += line.len() + 1;
        }
        // Keep the caret in view when the text is taller than the composer allows.
        let lines = Rc::new(lines);
        let layout = Layout {
            lines: lines.clone(),
            starts,
            tops: tops.clone(),
            bounds,
            line_height: self.look.line_height,
            text: input.text.clone(),
        };
        let mut scroll = px(0.);
        if !placeholder {
            let caret_bottom = layout.position_for(input.cursor()).y + self.look.line_height;
            if caret_bottom > bounds.bottom() {
                scroll = caret_bottom - bounds.bottom();
            }
        }
        let layout = Layout { bounds: Bounds::new(point(bounds.left(), bounds.top() - scroll), bounds.size), ..layout };

        let mut quads = Vec::new();
        if !placeholder {
            for pill in &input.pills {
                for rect in range_rects(&layout, pill.range.clone()) {
                    let bg = if pill.kind == PillKind::Quote { self.look.pill_quote_bg } else { self.look.pill_bg };
                    // A little wider than its text, into the spaces either side, so an outline never touches a letter.
                    let rect = Bounds::new(point(rect.left() - px(2.), rect.top() + px(2.)), size(rect.size.width + px(4.), rect.size.height - px(4.)));
                    quads.push((rect, bg, self.look.pill_radius, self.look.pill_border));
                }
            }
            if !input.selected.is_empty() {
                for rect in range_rects(&layout, input.selected.clone()) {
                    quads.push((rect, self.look.selection.opacity(0.9), px(2.), None));
                }
            }
        }
        // Wayland's text-input is told where the caret is, not asked (Windows asks when a
        // composition starts), so say so whenever it moves: typing, arrows, a resize, a
        // scroll. Without this the candidate window opened where the composer was when it
        // first took focus (found on forge with fcitx5).
        if input.focus.is_focused(window) {
            let at = if placeholder { layout.bounds.origin } else { layout.position_for(input.cursor()) };
            if input.ime_caret.get() != Some(at) {
                input.ime_caret.set(Some(at));
                window.invalidate_character_coordinates();
            }
        }
        let caret = (input.selected.is_empty() && self.caret_visible && input.focus.is_focused(window)).then(|| {
            let p = if placeholder { layout.bounds.origin } else { layout.position_for(input.cursor()) };
            Bounds::new(point(p.x, p.y + px(3.)), size(px(1.5), self.look.line_height - px(6.)))
        });
        let a11y = (input.text.clone(), input.selected.clone(), input.placeholder.to_string());
        let tops = layout.tops.iter().map(|t| *t - scroll).collect();
        input.layout.replace(Some(Rc::new(layout)));
        Prepaint { lines, tops, quads, caret, placeholder, a11y }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        prepaint: &mut Prepaint,
        window: &mut Window,
        cx: &mut App,
    ) {
        let focus = self.input.read(cx).focus.clone();
        window.handle_input(&focus, ElementInputHandler::new(bounds, self.input.clone()), cx);
        window.with_content_mask(Some(gpui::ContentMask { bounds }), |window| {
            for (rect, color, radius, border) in prepaint.quads.drain(..) {
                let mut quad = fill(rect, color).corner_radii(radius);
                if let Some(border) = border {
                    quad = quad.border_widths(px(1.)).border_color(border);
                }
                window.paint_quad(quad);
            }
            for (line, top) in prepaint.lines.iter().zip(prepaint.tops.iter()) {
                let _ = line.paint(point(bounds.left(), bounds.top() + *top), self.look.line_height, gpui::TextAlign::Left, None, window, cx);
            }
            if let Some(caret) = prepaint.caret {
                window.paint_quad(fill(caret, self.look.caret));
            }
        });
        let _ = prepaint.placeholder;
    }
}

/// The rectangles a byte range covers, one per visual row.
fn range_rects(layout: &Layout, range: Range<usize>) -> Vec<Bounds<Pixels>> {
    let mut rects = Vec::new();
    let start = layout.position_for(range.start);
    let end = layout.position_for(range.end);
    if (start.y - end.y).abs() < px(1.) {
        rects.push(Bounds::from_corners(start, point(end.x, end.y + layout.line_height)));
        return rects;
    }
    let right = layout.bounds.right();
    let left = layout.bounds.left();
    rects.push(Bounds::from_corners(start, point(right, start.y + layout.line_height)));
    let mut y = start.y + layout.line_height;
    while y + px(1.) < end.y {
        rects.push(Bounds::from_corners(point(left, y), point(right, y + layout.line_height)));
        y += layout.line_height;
    }
    rects.push(Bounds::from_corners(point(left, end.y), point(end.x, end.y + layout.line_height)));
    rects
}

#[cfg(test)]
mod tests {
    use super::*;

    impl gpui::Render for ComposerText {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            gpui::div()
        }
    }

    fn text_with_pill() -> (String, Vec<Pill>) {
        let mut t = String::from("See ");
        let start = t.len();
        t.push_str(&format!("{PAD}notes.md{PAD}"));
        let end = t.len();
        t.push_str(" now");
        (t, vec![Pill { range: start..end, kind: PillKind::File, label: "notes.md".into() }])
    }

    #[gpui::test]
    fn the_caret_steps_over_a_pill_and_backspace_removes_it_whole(cx: &mut gpui::TestAppContext) {
        let window = cx.add_window(|_, cx| {
            let mut c = ComposerText::new(cx);
            let (t, pills) = text_with_pill();
            c.text = t;
            c.pills = pills;
            c
        });
        window
            .update(cx, |c, window, cx| {
                let pill = c.pills[0].range.clone();
                c.move_to(pill.start, window, cx);
                c.right(&Right, window, cx);
                assert_eq!(c.cursor(), pill.end, "Right steps over the pill");
                c.left(&Left, window, cx);
                assert_eq!(c.cursor(), pill.start, "Left steps back over it");
                c.move_to(pill.end, window, cx);
                c.backspace(&Backspace, window, cx);
                assert_eq!(c.text, "See  now");
                assert!(c.pills.is_empty());
            })
            .unwrap();
    }
}
