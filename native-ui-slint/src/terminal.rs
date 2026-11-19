//! A real pseudo-terminal running the user's shell, parsed by alacritty_terminal and drawn by
//! Slint as runs of text that share a style. Scrollback, selection and resize with reflow are
//! alacritty_terminal's; colour comes from Sotto's terminal palette (tools/terminalView.ts).

use crate::{AppWindow, TermRow, TermRun};
use alacritty_terminal::event::{Event, EventListener, Notify, OnResize, WindowSize};
use alacritty_terminal::event_loop::{EventLoop, Notifier};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line, Point, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::tty;
use alacritty_terminal::vte::ansi::{Color, NamedColor, Rgb};
use slint::platform::Key;
use slint::{ComponentHandle, Model, ModelRc, SharedString, VecModel};
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

const ANSI_DARK: [u32; 16] = [
    0x1a1d1b, 0xf0a89c, 0x8fd18a, 0xf0c67a, 0x8fb8f2, 0xc9b3f7, 0x7fd6ca, 0xc3c9c6, 0x6b7370, 0xffbcb0, 0xaee3a9,
    0xf7d99e, 0xb0d0fa, 0xddd0fb, 0xa6e7de, 0xf3f4f3,
];
const ANSI_LIGHT: [u32; 16] = [
    0x141816, 0xb42318, 0x2f7433, 0x8a5300, 0x2860c4, 0x6a4bc9, 0x146e63, 0x59625d, 0x3a423e, 0x9a1f14, 0x1b5e20,
    0x6e4300, 0x1d4c9e, 0x553aa6, 0x0f5a51, 0x7b847f,
];

#[derive(Clone, Copy)]
struct Size {
    lines: usize,
    cols: usize,
}
impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.lines
    }
    fn screen_lines(&self) -> usize {
        self.lines
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

#[derive(Clone)]
struct Listener {
    dirty: Arc<AtomicBool>,
    ui: slint::Weak<AppWindow>,
    title: Arc<std::sync::Mutex<Option<String>>>,
    writes: Arc<std::sync::Mutex<Vec<String>>>,
}

impl EventListener for Listener {
    fn send_event(&self, event: Event) {
        match event {
            Event::Wakeup => {
                if !self.dirty.swap(true, Ordering::AcqRel) {
                    let _ = self.ui.upgrade_in_event_loop(|_| {
                        TERMINAL.with(|t| {
                            if let Some(t) = t.borrow().as_ref() {
                                t.borrow_mut().schedule();
                            }
                        })
                    });
                }
            }
            Event::Title(t) => {
                *self.title.lock().unwrap() = Some(t);
                self.send_event(Event::Wakeup);
            }
            Event::PtyWrite(s) => {
                self.writes.lock().unwrap().push(s);
                self.send_event(Event::Wakeup);
            }
            Event::ChildExit(_) | Event::Exit => {
                *self.title.lock().unwrap() = Some("Terminal (the shell exited)".into());
                self.send_event(Event::Wakeup);
            }
            _ => {}
        }
    }
}

thread_local! {
    static TERMINAL: RefCell<Option<Rc<RefCell<Terminal>>>> = const { RefCell::new(None) };
}

pub struct Terminal {
    term: Arc<FairMutex<Term<Listener>>>,
    notifier: Notifier,
    listener: Listener,
    ui: slint::Weak<AppWindow>,
    size: Size,
    cell: (f32, f32),
    pub dark: bool,
    rows: Rc<VecModel<TermRow>>,
    timer: Option<slint::Timer>,
    selecting: bool,
}

pub fn start(ui: &AppWindow, dark: bool) -> std::io::Result<Rc<RefCell<Terminal>>> {
    let size = Size { lines: 24, cols: 80 };
    let listener = Listener {
        dirty: Arc::new(AtomicBool::new(false)),
        ui: ui.as_weak(),
        title: Default::default(),
        writes: Default::default(),
    };
    let mut env = std::collections::HashMap::new();
    env.insert("TERM".into(), "xterm-256color".into());
    env.insert("COLORTERM".into(), "truecolor".into());
    let options = tty::Options {
        shell: shell(),
        working_directory: std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(Into::into),
        drain_on_exit: false,
        #[cfg(windows)]
        escape_args: false,
        env,
    };
    let window = WindowSize { num_lines: 24, num_cols: 80, cell_width: 8, cell_height: 16 };
    let pty = tty::new(&options, window, 0)?;
    let term = Arc::new(FairMutex::new(Term::new(Config { scrolling_history: 5000, ..Config::default() }, &size, listener.clone())));
    let event_loop = EventLoop::new(term.clone(), listener.clone(), pty, false, false)?;
    let notifier = Notifier(event_loop.channel());
    event_loop.spawn();
    let rows = Rc::new(VecModel::default());
    ui.set_term_rows(ModelRc::from(rows.clone()));
    let t = Rc::new(RefCell::new(Terminal { term, notifier, listener, ui: ui.as_weak(), size, cell: (8.0, 16.0), dark, rows, timer: None, selecting: false }));
    TERMINAL.with(|cell| *cell.borrow_mut() = Some(t.clone()));
    Ok(t)
}

/// The shell Sotto picks today. Linux and macOS: `$SHELL` (alacritty_terminal's default when this is `None`).
/// Windows: `pwsh.exe` when it is on PATH, else Windows PowerShell; alacritty_terminal runs it on ConPTY.
fn shell() -> Option<tty::Shell> {
    if !cfg!(windows) {
        return None;
    }
    // As src/main/terminals/shell.ts: the first pwsh.exe on PATH, else %SystemRoot%'s Windows PowerShell.
    let pwsh = std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|dir| dir.join("pwsh.exe")).find(|c| c.is_file()));
    let program = pwsh.unwrap_or_else(|| {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
        std::path::PathBuf::from(root).join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe")
    });
    let name = program.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    eprintln!("event=terminal-shell program={name}");
    Some(tty::Shell::new(program.to_string_lossy().into_owned(), Vec::new()))
}

fn rgb(c: u32) -> slint::Color {
    slint::Color::from_rgb_u8((c >> 16) as u8, (c >> 8) as u8, c as u8)
}

impl Terminal {
    /// Coalesce wakeups into one redraw per frame.
    fn schedule(&mut self) {
        if self.timer.is_some() {
            return;
        }
        let timer = slint::Timer::default();
        timer.start(slint::TimerMode::SingleShot, std::time::Duration::from_millis(4), || {
            TERMINAL.with(|t| {
                if let Some(t) = t.borrow().as_ref() {
                    let mut t = t.borrow_mut();
                    t.timer = None;
                    t.redraw();
                }
            })
        });
        self.timer = Some(timer);
    }

    pub fn set_dark(&mut self, dark: bool) {
        self.dark = dark;
        self.redraw();
    }

    fn color(&self, c: Color, colors: &alacritty_terminal::term::color::Colors, fg: bool, theme_fg: slint::Color, theme_bg: slint::Color) -> Option<slint::Color> {
        let ansi = if self.dark { &ANSI_DARK } else { &ANSI_LIGHT };
        match c {
            Color::Spec(Rgb { r, g, b }) => Some(slint::Color::from_rgb_u8(r, g, b)),
            Color::Indexed(i) => {
                if let Some(Rgb { r, g, b }) = colors[i as usize] {
                    return Some(slint::Color::from_rgb_u8(r, g, b));
                }
                Some(match i {
                    0..=15 => rgb(ansi[i as usize]),
                    16..=231 => {
                        let i = i - 16;
                        let step = |v: u8| if v == 0 { 0 } else { 55 + v * 40 };
                        slint::Color::from_rgb_u8(step(i / 36), step((i / 6) % 6), step(i % 6))
                    }
                    _ => {
                        let v = 8 + (i - 232) * 10;
                        slint::Color::from_rgb_u8(v, v, v)
                    }
                })
            }
            Color::Named(n) => {
                let idx = n as usize;
                if idx < 16 {
                    return Some(rgb(ansi[idx]));
                }
                match n {
                    NamedColor::Foreground | NamedColor::BrightForeground => Some(theme_fg),
                    NamedColor::DimForeground => Some(theme_fg.with_alpha(0.7)),
                    NamedColor::Background => if fg { Some(theme_bg) } else { None },
                    NamedColor::Cursor => Some(theme_fg),
                    _ if (NamedColor::DimBlack as usize..=NamedColor::DimWhite as usize).contains(&idx) => {
                        Some(rgb(ansi[idx - NamedColor::DimBlack as usize]).with_alpha(0.75))
                    }
                    _ => Some(theme_fg),
                }
            }
        }
    }

    pub fn redraw(&mut self) {
        let Some(ui) = self.ui.upgrade() else { return };
        self.listener.dirty.store(false, Ordering::Release);
        for s in self.listener.writes.lock().unwrap().drain(..) {
            self.notifier.notify(s.into_bytes());
        }
        if let Some(title) = self.listener.title.lock().unwrap().take() {
            ui.set_term_title(title.into());
        }
        let theme = ui.global::<crate::Theme>();
        let (theme_fg, theme_bg, sel_bg) = (theme.get_terminal_foreground(), theme.get_terminal_background(), theme.get_terminal_selection());
        let term = self.term.lock();
        let content = term.renderable_content();
        let lines = self.size.lines;
        let mut grid: Vec<Vec<TermRun>> = vec![Vec::new(); lines];
        let mut text_rows: Vec<String> = vec![String::new(); lines];
        let offset = content.display_offset as i32;
        let selection = content.selection;
        let mut current: Option<(usize, TermRun)> = None;
        let flush = |current: &mut Option<(usize, TermRun)>, grid: &mut Vec<Vec<TermRun>>| {
            if let Some((r, run)) = current.take() {
                if r < grid.len() && (!run.text.trim().is_empty() || run.has_bg) {
                    grid[r].push(run);
                }
            }
        };
        for indexed in content.display_iter {
            let row = (indexed.point.line.0 + offset) as usize;
            if row >= lines {
                continue;
            }
            let cell = indexed.cell;
            if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                continue;
            }
            let mut fg = self.color(cell.fg, content.colors, true, theme_fg, theme_bg).unwrap_or(theme_fg);
            let mut bg = self.color(cell.bg, content.colors, false, theme_fg, theme_bg);
            if cell.flags.contains(Flags::INVERSE) {
                let old_fg = fg;
                fg = bg.unwrap_or(theme_bg);
                bg = Some(old_fg);
            }
            let selected = selection.is_some_and(|s| s.contains(indexed.point));
            if selected {
                bg = Some(sel_bg);
                fg = theme.get_accent_surface_text();
            }
            let col = indexed.point.column.0 as i32;
            let ch = if cell.flags.contains(Flags::HIDDEN) { ' ' } else { cell.c };
            text_rows[row].push(ch);
            let bold = cell.flags.contains(Flags::BOLD);
            let italic = cell.flags.contains(Flags::ITALIC);
            let underline = cell.flags.intersects(Flags::ALL_UNDERLINES);
            let width = if cell.flags.contains(Flags::WIDE_CHAR) { 2 } else { 1 };
            let same = current.as_ref().is_some_and(|(r, run)| {
                *r == row && run.fg == fg && run.has_bg == bg.is_some() && (bg.is_none() || run.bg == bg.unwrap()) && run.bold == bold && run.italic == italic && run.underline == underline && run.col + run.len == col && width == 1
            });
            if same {
                let (_, run) = current.as_mut().unwrap();
                let mut s = run.text.to_string();
                s.push(ch);
                if let Some(zw) = cell.zerowidth() {
                    s.extend(zw.iter());
                }
                run.text = s.into();
                run.len += 1;
            } else {
                flush(&mut current, &mut grid);
                let mut s = String::from(ch);
                if let Some(zw) = cell.zerowidth() {
                    s.extend(zw.iter());
                }
                current = Some((row, TermRun { col, len: width, text: s.into(), fg, bg: bg.unwrap_or(theme_bg), has_bg: bg.is_some(), bold, italic, underline }));
            }
        }
        flush(&mut current, &mut grid);
        let cursor = content.cursor.point;
        let cursor_shown = content.mode.contains(TermMode::SHOW_CURSOR) && offset == 0;
        drop(term);

        // Update only rows that changed.
        let new_rows: Vec<TermRow> = grid.into_iter().map(|runs| TermRow { runs: ModelRc::new(VecModel::from(runs)) }).collect();
        if self.rows.row_count() != new_rows.len() {
            self.rows.set_vec(new_rows);
        } else {
            for (i, row) in new_rows.into_iter().enumerate() {
                let old = self.rows.row_data(i).unwrap();
                let same = old.runs.row_count() == row.runs.row_count() && (0..old.runs.row_count()).all(|j| old.runs.row_data(j) == row.runs.row_data(j));
                if !same {
                    self.rows.set_row_data(i, row);
                }
            }
        }
        ui.set_term_cursor_col(cursor.column.0 as i32);
        ui.set_term_cursor_row(cursor.line.0 + offset);
        ui.set_term_cursor_shown(cursor_shown);
        let screen: String = text_rows.iter().map(|r| r.trim_end()).collect::<Vec<_>>().join("\n");
        ui.set_term_text(SharedString::from(screen.trim_end()));
    }

    pub fn resize(&mut self, width: f32, height: f32, cw: f32, ch: f32) {
        if cw <= 0.0 || ch <= 0.0 {
            return;
        }
        let cols = ((width / cw).floor() as usize).max(10);
        let lines = ((height / ch).floor() as usize).max(3);
        self.cell = (cw, ch);
        if cols == self.size.cols && lines == self.size.lines {
            return;
        }
        self.size = Size { lines, cols };
        self.term.lock().resize(self.size);
        self.notifier.on_resize(WindowSize { num_lines: lines as u16, num_cols: cols as u16, cell_width: cw as u16, cell_height: ch as u16 });
        self.redraw();
    }

    pub fn input(&mut self, text: &str, control: bool, alt: bool, shift: bool) -> bool {
        let app_cursor = self.term.lock().mode().contains(TermMode::APP_CURSOR);
        let k = text.chars().next().unwrap_or('\0');
        let arrow = |c: char| if app_cursor { format!("\x1bO{c}") } else { format!("\x1b[{c}") };
        let bytes: Option<Vec<u8>> = if k == char::from(Key::Return) {
            Some(b"\r".to_vec())
        } else if k == char::from(Key::Backspace) {
            Some(if control { vec![0x08] } else { vec![0x7f] })
        } else if k == char::from(Key::Tab) {
            Some(b"\t".to_vec())
        } else if k == char::from(Key::Backtab) {
            Some(b"\x1b[Z".to_vec())
        } else if k == char::from(Key::Escape) {
            Some(b"\x1b".to_vec())
        } else if k == char::from(Key::UpArrow) {
            Some(arrow('A').into_bytes())
        } else if k == char::from(Key::DownArrow) {
            Some(arrow('B').into_bytes())
        } else if k == char::from(Key::RightArrow) {
            Some(arrow('C').into_bytes())
        } else if k == char::from(Key::LeftArrow) {
            Some(arrow('D').into_bytes())
        } else if k == char::from(Key::Home) {
            Some(b"\x1b[H".to_vec())
        } else if k == char::from(Key::End) {
            Some(b"\x1b[F".to_vec())
        } else if k == char::from(Key::Delete) {
            Some(b"\x1b[3~".to_vec())
        } else if k == char::from(Key::PageUp) && shift {
            self.scroll(self.size.lines as i32 - 1);
            return true;
        } else if k == char::from(Key::PageDown) && shift {
            self.scroll(-(self.size.lines as i32 - 1));
            return true;
        } else if k == char::from(Key::PageUp) {
            Some(b"\x1b[5~".to_vec())
        } else if k == char::from(Key::PageDown) {
            Some(b"\x1b[6~".to_vec())
        } else if ('\u{f700}'..='\u{f8ff}').contains(&k) || k == '\0' {
            None
        } else if control && k.is_ascii_alphabetic() {
            Some(vec![(k.to_ascii_lowercase() as u8) & 0x1f])
        } else if control && k == ' ' {
            Some(vec![0])
        } else if !text.is_empty() && !text.chars().any(|c| c.is_control() && c != '\u{1b}') {
            let mut v = Vec::new();
            if alt {
                v.push(0x1b);
            }
            v.extend_from_slice(text.as_bytes());
            Some(v)
        } else {
            None
        };
        match bytes {
            Some(b) => {
                // Typing goes back to the live screen.
                if self.term.lock().grid().display_offset() != 0 {
                    self.term.lock().scroll_display(Scroll::Bottom);
                }
                self.term.lock().selection = None;
                self.notifier.notify(b);
                true
            }
            None => false,
        }
    }

    pub fn scroll(&mut self, lines: i32) {
        self.term.lock().scroll_display(Scroll::Delta(lines));
        self.redraw();
    }

    pub fn pointer(&mut self, kind: i32, col: i32, row: i32) {
        let mut term = self.term.lock();
        let offset = term.grid().display_offset() as i32;
        let point = Point::new(Line(row.clamp(0, self.size.lines as i32 - 1) - offset), Column(col.clamp(0, self.size.cols as i32 - 1) as usize));
        match kind {
            0 => {
                term.selection = Some(Selection::new(SelectionType::Simple, point, Side::Left));
                self.selecting = true;
            }
            1 if self.selecting => {
                if let Some(sel) = term.selection.as_mut() {
                    sel.update(point, Side::Right);
                }
            }
            2 => {
                self.selecting = false;
                if term.selection.as_ref().is_some_and(|s| s.is_empty()) {
                    term.selection = None;
                }
            }
            _ => {}
        }
        drop(term);
        self.redraw();
    }

    pub fn selection_text(&self) -> Option<String> {
        self.term.lock().selection_to_string()
    }

    pub fn paste(&mut self, text: &str) {
        let bracketed = self.term.lock().mode().contains(TermMode::BRACKETED_PASTE);
        let mut v = Vec::new();
        if bracketed {
            v.extend_from_slice(b"\x1b[200~");
        }
        v.extend_from_slice(text.replace('\n', "\r").as_bytes());
        if bracketed {
            v.extend_from_slice(b"\x1b[201~");
        }
        self.notifier.notify(v);
    }

    pub fn write(&self, text: &str) {
        self.notifier.notify(text.as_bytes().to_vec());
    }
}
