//! A real terminal: the user's shell on a pseudo-terminal (ConPTY on Windows)
//! through `alacritty_terminal` (Apache-2.0), drawn natively by GPUI.
//!
//! Nothing here comes from Zed's `terminal` or `terminal_view` crates (GPL).
//! The shell is the one Sotto's own terminal picks on Windows: `pwsh.exe` when it
//! is on PATH, else Windows PowerShell.

use crate::theme::{Lab, Tokens};
use alacritty_terminal::{
    event::{Event, EventListener, WindowSize},
    event_loop::{EventLoop, EventLoopSender, Msg},
    grid::{Dimensions, Scroll},
    index::{Column, Line, Point as TermPoint, Side},
    selection::{Selection, SelectionType},
    sync::FairMutex,
    term::{Config, Term, TermMode, cell::Flags, test::TermSize},
    tty,
    vte::ansi::{Color as AnsiColor, NamedColor},
};
use gpui::{
    App, Bounds, ClipboardItem, Context, Element, ElementId, Entity, FocusHandle, Focusable, FontWeight,
    GlobalElementId, Hsla, InspectorElementId, IntoElement, KeyDownEvent, LayoutId, MouseButton, MouseDownEvent,
    MouseMoveEvent, Pixels, Point, ScrollWheelEvent, ShapedLine, SharedString, Size, Style, TextRun, Window, fill,
    font, point, px, relative, size,
};
use std::{borrow::Cow, sync::Arc};

pub const MONO: &str = "Spline Sans Mono";

#[derive(Clone)]
struct Listener(async_channel::Sender<Event>);

impl EventListener for Listener {
    fn send_event(&self, event: Event) {
        let _ = self.0.try_send(event);
    }
}

pub struct TerminalView {
    term: Arc<FairMutex<Term<Listener>>>,
    sender: EventLoopSender,
    pub focus: FocusHandle,
    grid: (usize, usize),
    cell: Size<Pixels>,
    font_size: Pixels,
    exited: bool,
    selecting: bool,
    origin: Point<Pixels>,
    pub shell_name: String,
}

fn default_shell() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        if let Ok(path) = std::env::var("PATH") {
            for dir in std::env::split_paths(&path) {
                let candidate = dir.join("pwsh.exe");
                if candidate.exists() {
                    return (candidate.to_string_lossy().into_owned(), vec!["-NoLogo".into()]);
                }
            }
        }
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        (format!("{root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"), vec!["-NoLogo".into()])
    }
    #[cfg(not(windows))]
    {
        (std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()), Vec::new())
    }
}

impl TerminalView {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let (tx, rx) = async_channel::unbounded();
        let listener = Listener(tx);
        let cols = 80;
        let rows = 24;
        let term = Term::new(Config::default(), &TermSize::new(cols, rows), listener.clone());
        let term = Arc::new(FairMutex::new(term));
        let (program, args) = default_shell();
        let shell_name = std::path::Path::new(&program)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| program.clone());
        let options = tty::Options {
            shell: Some(tty::Shell::new(program, args)),
            working_directory: std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).ok().map(Into::into),
            drain_on_exit: true,
            env: Default::default(),
            #[cfg(windows)]
            escape_args: true,
        };
        let window_size = WindowSize { num_lines: rows as u16, num_cols: cols as u16, cell_width: 8, cell_height: 16 };
        let pty = tty::new(&options, window_size, 0).expect("the pseudo-terminal starts");
        let event_loop = EventLoop::new(term.clone(), listener, pty, true, false).expect("the terminal's reader starts");
        let sender = event_loop.channel();
        event_loop.spawn();

        // Bring the reader's events onto the UI thread. Wake-ups arrive far faster than frames,
        // so a burst is folded into one repaint.
        cx.spawn(async move |this, cx| {
            while let Ok(event) = rx.recv().await {
                let mut events = vec![event];
                while let Ok(more) = rx.try_recv() {
                    events.push(more);
                }
                let alive = this
                    .update(cx, |view, cx| {
                        for event in events {
                            match event {
                                Event::PtyWrite(text) => view.write(text.into_bytes()),
                                Event::ClipboardStore(_, text) => cx.write_to_clipboard(ClipboardItem::new_string(text)),
                                Event::Exit | Event::ChildExit(_) => view.exited = true,
                                Event::TextAreaSizeRequest(format) => {
                                    let size = view.window_size();
                                    view.write(format(size).into_bytes());
                                }
                                _ => {}
                            }
                        }
                        cx.notify();
                    })
                    .is_ok();
                if !alive {
                    break;
                }
            }
        })
        .detach();

        TerminalView {
            term,
            sender,
            focus: cx.focus_handle().tab_stop(true),
            grid: (cols, rows),
            cell: size(px(8.), px(16.)),
            font_size: px(13.),
            exited: false,
            selecting: false,
            origin: Point::default(),
            shell_name,
        }
    }

    fn window_size(&self) -> WindowSize {
        WindowSize {
            num_lines: self.grid.1 as u16,
            num_cols: self.grid.0 as u16,
            cell_width: f32::from(self.cell.width) as u16,
            cell_height: f32::from(self.cell.height) as u16,
        }
    }

    fn write(&self, bytes: impl Into<Cow<'static, [u8]>>) {
        let _ = self.sender.send(Msg::Input(bytes.into()));
    }

    fn resize(&mut self, cols: usize, rows: usize) {
        if (cols, rows) == self.grid || cols < 2 || rows < 1 {
            return;
        }
        self.grid = (cols, rows);
        // Term::resize reflows wrapped lines to the new width.
        self.term.lock().resize(TermSize::new(cols, rows));
        let _ = self.sender.send(Msg::Resize(self.window_size()));
    }

    /// Bytes the shell gets for a key Sotto's own bindings would otherwise take (Tab, Escape).
    pub fn send_text(&mut self, text: &'static str, cx: &mut Context<Self>) {
        if self.exited {
            return;
        }
        self.term.lock().scroll_display(Scroll::Bottom);
        self.write(text.as_bytes());
        cx.notify();
    }

    pub fn copy_selection(&mut self, cx: &mut Context<Self>) {
        if let Some(text) = self.term.lock().selection_to_string() {
            cx.write_to_clipboard(ClipboardItem::new_string(text));
        }
    }

    pub fn paste(&mut self, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            let bracketed = self.term.lock().mode().contains(TermMode::BRACKETED_PASTE);
            let text = text.replace("\r\n", "\r").replace('\n', "\r");
            if bracketed {
                self.write(format!("\x1b[200~{text}\x1b[201~").into_bytes());
            } else {
                self.write(text.into_bytes());
            }
        }
    }

    /// Bytes for a key the shell should see. Returns false when the key is not the terminal's.
    pub fn key_down(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) -> bool {
        let keystroke = &event.keystroke;
        let mods = keystroke.modifiers;
        if self.exited {
            if keystroke.key == "enter" {
                self.restart(cx);
                return true;
            }
            return false;
        }
        let app_cursor = self.term.lock().mode().contains(TermMode::APP_CURSOR);
        let arrow = |c: char| {
            if mods.control {
                format!("\x1b[1;5{c}")
            } else if mods.shift {
                format!("\x1b[1;2{c}")
            } else if app_cursor {
                format!("\x1bO{c}")
            } else {
                format!("\x1b[{c}")
            }
        };
        let bytes: Option<String> = match keystroke.key.as_str() {
            "enter" => Some("\r".into()),
            "backspace" => Some(if mods.control { "\x17".into() } else { "\x7f".into() }),
            "tab" => Some(if mods.shift { "\x1b[Z".into() } else { "\t".into() }),
            "escape" => Some("\x1b".into()),
            "up" => Some(arrow('A')),
            "down" => Some(arrow('B')),
            "right" => Some(arrow('C')),
            "left" => Some(arrow('D')),
            "home" => Some("\x1b[H".into()),
            "end" => Some("\x1b[F".into()),
            "delete" => Some("\x1b[3~".into()),
            "insert" => Some("\x1b[2~".into()),
            "pageup" if mods.shift => {
                self.scroll(Scroll::PageUp, cx);
                return true;
            }
            "pagedown" if mods.shift => {
                self.scroll(Scroll::PageDown, cx);
                return true;
            }
            "pageup" => Some("\x1b[5~".into()),
            "pagedown" => Some("\x1b[6~".into()),
            key if mods.control && !mods.alt && key.len() == 1 => {
                let c = key.chars().next().unwrap().to_ascii_lowercase();
                if c.is_ascii_lowercase() {
                    Some(((c as u8 - b'a' + 1) as char).to_string())
                } else {
                    None
                }
            }
            _ => keystroke.key_char.clone().map(|ch| if mods.alt { format!("\x1b{ch}") } else { ch }),
        };
        match bytes {
            Some(bytes) => {
                // Typing returns the view to the bottom and clears a selection, as terminals do.
                {
                    let mut term = self.term.lock();
                    term.scroll_display(Scroll::Bottom);
                    term.selection = None;
                }
                self.write(bytes.into_bytes());
                cx.notify();
                true
            }
            None => false,
        }
    }

    fn restart(&mut self, cx: &mut Context<Self>) {
        let fresh = TerminalView::new(cx);
        let focus = self.focus.clone();
        *self = fresh;
        self.focus = focus;
        cx.notify();
    }

    fn scroll(&mut self, scroll: Scroll, cx: &mut Context<Self>) {
        self.term.lock().scroll_display(scroll);
        cx.notify();
    }

    pub fn scroll_wheel(&mut self, event: &ScrollWheelEvent, cx: &mut Context<Self>) {
        let delta = event.delta.pixel_delta(self.cell.height);
        let lines = (f32::from(delta.y) / f32::from(self.cell.height)).round() as i32;
        if lines != 0 {
            self.scroll(Scroll::Delta(lines), cx);
        }
    }

    fn grid_point(&self, position: Point<Pixels>) -> (TermPoint, Side) {
        let local = position - self.origin;
        let col_f = f32::from(local.x) / f32::from(self.cell.width);
        let col = (col_f.max(0.) as usize).min(self.grid.0.saturating_sub(1));
        let row = ((f32::from(local.y) / f32::from(self.cell.height)).max(0.) as usize).min(self.grid.1.saturating_sub(1));
        let offset = self.term.lock().grid().display_offset() as i32;
        let side = if col_f.fract() < 0.5 { Side::Left } else { Side::Right };
        (TermPoint::new(Line(row as i32 - offset), Column(col)), side)
    }

    pub fn mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        let (point, side) = self.grid_point(event.position);
        let ty = match event.click_count {
            2 => SelectionType::Semantic,
            3 => SelectionType::Lines,
            _ => SelectionType::Simple,
        };
        self.term.lock().selection = Some(Selection::new(ty, point, side));
        self.selecting = true;
        cx.notify();
    }

    pub fn mouse_move(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) {
        if self.selecting && event.pressed_button == Some(MouseButton::Left) {
            let (point, side) = self.grid_point(event.position);
            if let Some(selection) = self.term.lock().selection.as_mut() {
                selection.update(point, side);
            }
            cx.notify();
        }
    }

    pub fn mouse_up(&mut self, cx: &mut Context<Self>) {
        self.selecting = false;
        let empty = self.term.lock().selection.as_ref().is_some_and(|s| s.is_empty());
        if empty {
            self.term.lock().selection = None;
        }
        cx.notify();
    }

    /// The visible text, for the accessibility tree.
    pub fn visible_text(&self) -> String {
        let term = self.term.lock();
        let grid = term.grid();
        let mut lines = Vec::new();
        let offset = grid.display_offset() as i32;
        for row in 0..grid.screen_lines() as i32 {
            let line = Line(row - offset);
            let mut text = String::new();
            for col in 0..grid.columns() {
                let cell = &grid[line][Column(col)];
                if !cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                    text.push(cell.c);
                }
            }
            lines.push(text.trim_end().to_string());
        }
        while lines.last().is_some_and(|l| l.is_empty()) {
            lines.pop();
        }
        lines.join("\n")
    }

    pub fn has_exited(&self) -> bool {
        self.exited
    }
}

impl Focusable for TerminalView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

/// Sotto's ANSI colours (`terminalView.ts`), per mode.
fn ansi(index: usize, dark: bool) -> Hsla {
    const DARK: [u32; 16] = [
        0x1a1d1b, 0xf0a89c, 0x8fd18a, 0xf0c67a, 0x8fb8f2, 0xc9b3f7, 0x7fd6ca, 0xc3c9c6, 0x6b7370, 0xffbcb0, 0xaee3a9,
        0xf7d99e, 0xb0d0fa, 0xddd0fb, 0xa6e7de, 0xf3f4f3,
    ];
    const LIGHT: [u32; 16] = [
        0x141816, 0xb42318, 0x2f7433, 0x8a5300, 0x2860c4, 0x6a4bc9, 0x146e63, 0x59625d, 0x3a423e, 0x9a1f14, 0x1b5e20,
        0x6e4300, 0x1d4c9e, 0x553aa6, 0x0f5a51, 0x7b847f,
    ];
    let rgb = if dark { DARK[index] } else { LIGHT[index] };
    gpui::rgb(rgb).into()
}

fn xterm_256(index: u8, dark: bool) -> Hsla {
    match index {
        0..=15 => ansi(index as usize, dark),
        16..=231 => {
            let i = index - 16;
            let level = |v: u8| if v == 0 { 0 } else { 55 + v as u32 * 40 };
            let (r, g, b) = (level(i / 36), level((i / 6) % 6), level(i % 6));
            gpui::rgb((r << 16) | (g << 8) | b).into()
        }
        _ => {
            let v = 8 + (index as u32 - 232) * 10;
            gpui::rgb((v << 16) | (v << 8) | v).into()
        }
    }
}

fn resolve(color: AnsiColor, tokens: &Tokens, foreground: bool) -> Option<Hsla> {
    let dark = tokens.mode == crate::theme::Mode::Dark;
    match color {
        AnsiColor::Named(NamedColor::Foreground) | AnsiColor::Named(NamedColor::BrightForeground) => {
            Some(tokens.terminal_fg.hsla())
        }
        AnsiColor::Named(NamedColor::Background) => {
            if foreground {
                Some(tokens.terminal_bg.hsla())
            } else {
                None
            }
        }
        AnsiColor::Named(NamedColor::DimForeground) => Some(tokens.text_muted.hsla()),
        AnsiColor::Named(named) => {
            let i = named as usize;
            if i < 16 {
                Some(ansi(i, dark))
            } else if (NamedColor::DimBlack as usize..=NamedColor::DimWhite as usize).contains(&i) {
                Some(ansi(i - NamedColor::DimBlack as usize, dark).opacity(0.7))
            } else {
                Some(tokens.terminal_fg.hsla())
            }
        }
        AnsiColor::Spec(rgb) => Some(gpui::rgb(((rgb.r as u32) << 16) | ((rgb.g as u32) << 8) | rgb.b as u32).into()),
        AnsiColor::Indexed(i) => Some(xterm_256(i, dark)),
    }
}

/// The terminal's drawing surface.
pub struct TerminalElement {
    pub view: Entity<TerminalView>,
    pub tokens: Tokens,
    pub focused: bool,
    pub reduce_motion: bool,
}

pub struct Prepaint {
    lines: Vec<(Point<Pixels>, ShapedLine)>,
    quads: Vec<(Bounds<Pixels>, Hsla)>,
    cursor: Option<Bounds<Pixels>>,
}


impl Element for TerminalElement {
    type RequestLayoutState = ();
    type PrepaintState = Prepaint;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = relative(1.).into();
        (window.request_layout(style, [], cx), ())
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
        let font_size = self.view.read(cx).font_size;
        let regular = font(MONO);
        let bold = gpui::Font { weight: FontWeight::MEDIUM, ..font(MONO) };
        let text_system = window.text_system().clone();
        let font_id = text_system.resolve_font(&regular);
        let cell_width = text_system.advance(font_id, font_size, 'm').map(|s| s.width).unwrap_or(px(8.));
        let cell_height = (font_size * 1.3).round();
        let cols = (f32::from(bounds.size.width) / f32::from(cell_width)).floor().max(2.) as usize;
        let rows = (f32::from(bounds.size.height) / f32::from(cell_height)).floor().max(1.) as usize;
        self.view.update(cx, |view, _| {
            view.cell = size(cell_width, cell_height);
            view.origin = bounds.origin;
            view.resize(cols, rows);
        });

        let view = self.view.read(cx);
        let term = view.term.lock();
        let content = term.renderable_content();
        let offset = content.display_offset as i32;
        let selection = content.selection;
        let cursor = content.cursor;
        let default_bg = self.tokens.terminal_bg;
        let selection_bg = self.tokens.terminal_selection.hsla();

        let mut lines = Vec::new();
        let mut quads = Vec::new();
        // Gather one row at a time into runs of one style; a wide character is drawn on its own,
        // so the grid stays aligned whatever the fallback font's advance.
        let mut row_text = String::new();
        let mut row_runs: Vec<TextRun> = Vec::new();
        let mut row_start_col = 0usize;
        let mut current_row: i32 = i32::MIN;
        let flush = |row: i32, start_col: usize, text: &mut String, runs: &mut Vec<TextRun>, lines: &mut Vec<(Point<Pixels>, ShapedLine)>| {
            if text.trim().is_empty() {
                text.clear();
                runs.clear();
                return;
            }
            let shaped = text_system.shape_line(SharedString::from(std::mem::take(text)), font_size, runs, Some(cell_width));
            runs.clear();
            let origin = point(
                bounds.origin.x + cell_width * start_col as f32,
                bounds.origin.y + cell_height * (row + offset) as f32,
            );
            lines.push((origin, shaped));
        };

        for indexed in content.display_iter {
            let cell = indexed.cell;
            let p = indexed.point;
            if p.line.0 != current_row {
                if current_row != i32::MIN {
                    flush(current_row, row_start_col, &mut row_text, &mut row_runs, &mut lines);
                }
                current_row = p.line.0;
                row_start_col = 0;
            }
            if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                continue;
            }
            let selected = selection.is_some_and(|s| s.contains(p));
            let inverse = cell.flags.contains(Flags::INVERSE);
            let mut fg = resolve(cell.fg, &self.tokens, true).unwrap_or(self.tokens.terminal_fg.hsla());
            let mut bg = resolve(cell.bg, &self.tokens, false);
            if inverse {
                let old_fg = fg;
                fg = bg.unwrap_or(default_bg.hsla());
                bg = Some(old_fg);
            }
            if cell.flags.contains(Flags::DIM) {
                fg = fg.opacity(0.7);
            }
            let wide = cell.flags.contains(Flags::WIDE_CHAR);
            let cell_origin = point(
                bounds.origin.x + cell_width * p.column.0 as f32,
                bounds.origin.y + cell_height * (p.line.0 + offset) as f32,
            );
            let width_cells = if wide { 2. } else { 1. };
            if let Some(bg) = if selected { Some(selection_bg) } else { bg } {
                quads.push((Bounds::new(cell_origin, size(cell_width * width_cells, cell_height)), bg));
            }
            let font = if cell.flags.contains(Flags::BOLD) { bold.clone() } else { regular.clone() };
            let font = if cell.flags.contains(Flags::ITALIC) { gpui::Font { style: gpui::FontStyle::Italic, ..font } } else { font };
            let underline = cell.flags.intersects(Flags::ALL_UNDERLINES).then(|| gpui::UnderlineStyle {
                color: Some(fg),
                thickness: px(1.),
                wavy: cell.flags.contains(Flags::UNDERCURL),
            });
            let ch = if cell.c == '\0' || cell.c == '\t' { ' ' } else { cell.c };

            if wide {
                flush(p.line.0, row_start_col, &mut row_text, &mut row_runs, &mut lines);
                let mut s = String::new();
                s.push(ch);
                let run = TextRun { len: s.len(), font, color: fg, background_color: None, underline, strikethrough: None };
                lines.push((cell_origin, text_system.shape_line(s.into(), font_size, &[run], None)));
                row_start_col = p.column.0 + 2;
                continue;
            }
            if row_text.is_empty() {
                row_start_col = p.column.0;
            }
            let len = ch.len_utf8();
            row_text.push(ch);
            if let Some(last) = row_runs.last_mut()
                && last.font == font
                && last.color == fg
                && last.underline == underline
            {
                last.len += len;
            } else {
                row_runs.push(TextRun { len, font, color: fg, background_color: None, underline, strikethrough: None });
            }
            // Extra text, such as zero-width combining marks, joins its cell.
            if let Some(extra) = cell.zerowidth() {
                for c in extra {
                    row_text.push(*c);
                    if let Some(last) = row_runs.last_mut() {
                        last.len += c.len_utf8();
                    }
                }
            }
        }
        if current_row != i32::MIN {
            flush(current_row, row_start_col, &mut row_text, &mut row_runs, &mut lines);
        }

        let cursor_visible = cursor.shape != alacritty_terminal::vte::ansi::CursorShape::Hidden;
        let cursor = cursor_visible.then(|| {
            let origin = point(
                bounds.origin.x + cell_width * cursor.point.column.0 as f32,
                bounds.origin.y + cell_height * (cursor.point.line.0 + offset) as f32,
            );
            if self.focused {
                Bounds::new(origin, size(cell_width, cell_height))
            } else {
                Bounds::new(point(origin.x, origin.y + cell_height - px(2.)), size(cell_width, px(2.)))
            }
        });
        drop(term);
        Prepaint { lines, quads, cursor }
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
        window.paint_quad(fill(bounds, self.tokens.terminal_bg.hsla()));
        window.with_content_mask(Some(gpui::ContentMask { bounds }), |window| {
            for (b, color) in prepaint.quads.drain(..) {
                window.paint_quad(fill(b, color));
            }
            let cell_height = self.view.read(cx).cell.height;
            if let Some(cursor) = prepaint.cursor {
                let color: Lab = self.tokens.terminal_cursor;
                window.paint_quad(fill(cursor, color.hsla()));
            }
            for (origin, line) in prepaint.lines.drain(..) {
                let _ = line.paint(origin, cell_height, gpui::TextAlign::Left, None, window, cx);
            }
        });
    }
}
