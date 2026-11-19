//! Sotto's hard screen, in GPUI. Issue #2689, the native UI bake-off.
//!
//! One window under Sotto's thin strip: a thread pane streaming a long reply,
//! the composer with inline pills, a real terminal and a web pane region, in
//! Sotto's own dark and light themes, honouring the system's reduced motion.
//!
//! Environment switches for measuring (all optional):
//! - `SOTTO_GPUI_SIZE=1280x800` opens at that size.
//! - `SOTTO_GPUI_THEME=light` starts in the light theme.
//! - `SOTTO_GPUI_VARIANT=B` starts with composer variant A, B or C.
//! - `SOTTO_GPUI_AUTOSTREAM=1500` starts the reply that many milliseconds after the first frame.
//! - `SOTTO_GPUI_METRICS=path.json` writes frame and typing timings there when the stream ends.
//! - `SOTTO_GPUI_EXIT_AFTER_STREAM=1` quits five seconds after the stream ends (after the memory sample).
//! - `SOTTO_GPUI_REDUCE_MOTION=1` forces reduced motion on, whatever the system says.

mod composer;
mod content;
mod highlight;
mod icons;
mod ime_test;
mod markdown;
mod metrics;
mod motion;
mod terminal;
mod theme;
mod transcript;
mod webpane;

use composer::{ComposerElement, ComposerText, PillKind, TextLook};
use gpui::{
    AnyElement, App, Bounds, Context, Entity, FocusHandle, FontWeight, Hsla, KeyBinding, MouseButton,
    ParentElement, Pixels, Render, Role, SharedString, StatefulInteractiveElement, Styled, TitlebarOptions, Window,
    WindowBounds, WindowControlArea, WindowOptions, actions, anchored, canvas, deferred, div, prelude::*, px, size,
    svg,
};
use std::{cell::RefCell, rc::Rc, time::{Duration, Instant}};
use terminal::{TerminalElement, TerminalView};
use theme::{Mode, Tokens};
use transcript::Transcript;
use webpane::{Leave, Surface, WebPane};

pub const UI_FONT: &str = "Figtree";

actions!(
    sotto,
    [
        FocusNext, FocusPrev, NextRegion, PrevRegion, Dismiss, ToggleTheme, VariantA, VariantB, VariantC, Restream,
        MenuUp, MenuDown, Quit, PageTab, PageBacktab
    ]
);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Variant {
    A,
    B,
    C,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Menu {
    Attach,
    Permissions,
    Model,
    Effort,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ToolTab {
    Page,
    Terminal,
}

struct Root {
    mode: Mode,
    tokens: Tokens,
    variant: Variant,
    transcript: Entity<Transcript>,
    composer: Entity<ComposerText>,
    terminal: Entity<TerminalView>,
    web: Entity<WebPane>,
    menu: Option<Menu>,
    menu_focus: FocusHandle,
    menu_ix: usize,
    chip_focus: [FocusHandle; 4],
    permission: usize,
    model: usize,
    effort: usize,
    tool_tab: ToolTab,
    reduce_motion: bool,
    forced_reduce_motion: bool,
    last_direction_forward: bool,
    metrics: Rc<RefCell<metrics::Metrics>>,
    stream_task: Option<gpui::Task<()>>,
    caret_on: bool,
}

const PERMISSIONS: [&str; 3] = ["Ask first", "Allow edits", "Read only"];
const MODELS: [&str; 3] = ["Sonnet 4.5", "Opus 4.5", "Haiku 4.5"];
const EFFORTS: [&str; 4] = ["Low", "Medium", "High", "Max"];

impl Root {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mode = if std::env::var("SOTTO_GPUI_THEME").is_ok_and(|v| v == "light") { Mode::Light } else { Mode::Dark };
        let tokens = Tokens::new(mode);
        let variant = match std::env::var("SOTTO_GPUI_VARIANT").as_deref() {
            Ok("B") | Ok("b") => Variant::B,
            Ok("C") | Ok("c") => Variant::C,
            _ => Variant::A,
        };
        let transcript = cx.new(|cx| Transcript::new(tokens.clone(), cx));
        let composer = cx.new(ComposerText::new);
        let terminal = cx.new(TerminalView::new);
        let web = cx.new(|cx| WebPane::new(&tokens, cx));
        let metrics = Rc::new(RefCell::new(metrics::Metrics::new()));

        // Sending: the message joins the transcript and the reply streams again.
        let root = cx.entity().downgrade();
        composer.update(cx, |c, _| {
            c.on_submit = Some(Box::new(move |window, cx| {
                root.update(cx, |root, cx| root.send(window, cx)).ok();
            }));
        });

        // Focus leaving the web page goes to Sotto's next or previous control.
        let leave = web.read(cx).leave_events();
        cx.spawn_in(window, async move |this, cx| {
            while let Ok(direction) = leave.recv().await {
                this.update_in(cx, |_, window, cx| match direction {
                    Leave::Next => window.focus_next(cx),
                    Leave::Previous => window.focus_prev(cx),
                })
                .ok();
            }
        })
        .detach();

        // Focus arriving at the web pane enters the page at the end it came from.
        let web_focus = web.read(cx).focus.clone();
        cx.on_focus(&web_focus, window, |this, window, cx| {
            let from_end = !this.last_direction_forward;
            this.web.update(cx, |w, cx| w.enter(from_end, window, cx));
        })
        .detach();
        cx.on_blur(&web_focus, window, |this, _, cx| {
            this.web.update(cx, |w, _| {
                if w.surface == Surface::Texture {
                    w.blur_page()
                }
            });
        })
        .detach();

        // Reduced motion follows the system setting, read now and whenever it may have changed.
        let forced = std::env::var("SOTTO_GPUI_REDUCE_MOTION").is_ok_and(|v| v == "1");
        cx.spawn_in(window, async move |this, cx| {
            loop {
                let reduce = forced || motion::system_prefers_reduced_motion();
                if this.update(cx, |root, cx| root.set_reduce_motion(reduce, cx)).is_err() {
                    break;
                }
                cx.background_executor().timer(Duration::from_millis(1000)).await;
            }
        })
        .detach();

        // The composer's caret blinks unless motion is reduced.
        cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(530)).await;
                let ok = this
                    .update(cx, |root, cx| {
                        let next = root.reduce_motion || !root.caret_on;
                        if next != root.caret_on {
                            root.caret_on = next;
                            root.composer.update(cx, |_, cx| cx.notify());
                        }
                    })
                    .is_ok();
                if !ok {
                    break;
                }
            }
        })
        .detach();

        let mut root = Root {
            mode,
            tokens,
            variant,
            transcript,
            composer,
            terminal,
            web,
            menu: None,
            menu_focus: cx.focus_handle(),
            menu_ix: 0,
            chip_focus: [
                cx.focus_handle().tab_stop(true),
                cx.focus_handle().tab_stop(true),
                cx.focus_handle().tab_stop(true),
                cx.focus_handle().tab_stop(true),
            ],
            permission: 0,
            model: 0,
            effort: 2,
            tool_tab: ToolTab::Terminal,
            reduce_motion: false,
            forced_reduce_motion: forced,
            last_direction_forward: true,
            metrics,
            stream_task: None,
            caret_on: true,
        };
        if let Ok(ms) = std::env::var("SOTTO_GPUI_AUTOSTREAM") {
            let delay = ms.parse().unwrap_or(1500);
            root.stream_task = Some(cx.spawn_in(window, async move |this, cx| {
                cx.background_executor().timer(Duration::from_millis(delay)).await;
                this.update(cx, |root, cx| root.start_stream(cx)).ok();
            }));
        } else {
            root.start_stream(cx);
        }
        let composer_focus = root.composer.read(cx).focus.clone();
        window.focus(&composer_focus, cx);
        // `SOTTO_GPUI_DEMO_PILLS=1` fills the composer with the same words and two pills, for captures.
        if std::env::var("SOTTO_GPUI_DEMO_PILLS").is_ok_and(|v| v == "1") {
            cx.spawn_in(window, async move |this, cx| {
                cx.background_executor().timer(Duration::from_millis(300)).await;
                this.update_in(cx, |root, window, cx| {
                    use gpui::EntityInputHandler as _;
                    root.composer.update(cx, |c, cx| {
                        c.replace_text_in_range(None, "See ", window, cx);
                        c.insert_pill(PillKind::File, "harbor-notes.md", window, cx);
                        c.replace_text_in_range(None, "and ", window, cx);
                        c.insert_pill(PillKind::Quote, "“Every berth is full…”", window, cx);
                        c.replace_text_in_range(None, "before merging.", window, cx);
                    });
                })
                .ok();
            })
            .detach();
        }
        if let Ok(which) = std::env::var("SOTTO_GPUI_IME") {
            cx.spawn_in(window, async move |_, cx| {
                cx.background_executor().timer(Duration::from_millis(800)).await;
                cx.update(|window, _| ime_test::activate(window, &which)).ok();
                for when in ["5 s later", "10 s later", "20 s later", "30 s later"] {
                    cx.background_executor().timer(Duration::from_millis(5000)).await;
                    cx.update(|window, _| ime_test::log_window(window, when)).ok();
                }
            })
            .detach();
        }
        root
    }

    fn set_reduce_motion(&mut self, reduce: bool, cx: &mut Context<Self>) {
        if self.reduce_motion != reduce {
            self.reduce_motion = reduce;
            cx.set_reduce_motion(reduce);
            self.transcript.update(cx, |t, cx| {
                t.reduce_motion = reduce;
                cx.notify();
            });
            self.web.update(cx, |w, _| w.set_reduce_motion(reduce));
            self.caret_on = true;
            cx.notify();
        }
    }

    fn start_stream(&mut self, cx: &mut Context<Self>) {
        let reply = content::long_reply();
        self.transcript.update(cx, |t, cx| t.start_stream(cx));
        self.metrics.borrow_mut().stream_started();
        let (tx, rx) = async_channel::unbounded::<Option<String>>();
        // The generator: 20 characters every 16 ms, on its own schedule, as a provider would send them.
        std::thread::Builder::new()
            .name("reply generator".into())
            .spawn(move || {
                let chars: Vec<char> = reply.chars().collect();
                let start = Instant::now();
                for (i, chunk) in chars.chunks(20).enumerate() {
                    let due = start + Duration::from_millis(16 * i as u64);
                    let now = Instant::now();
                    if due > now {
                        std::thread::sleep(due - now);
                    }
                    if tx.send_blocking(Some(chunk.iter().collect())).is_err() {
                        return;
                    }
                }
                let _ = tx.send_blocking(None);
            })
            .unwrap();
        let transcript = self.transcript.clone();
        let metrics = self.metrics.clone();
        self.stream_task = Some(cx.spawn(async move |this, cx| {
            while let Ok(first) = rx.recv().await {
                let mut chunk = String::new();
                let mut done = false;
                let mut take = |m: Option<String>, chunk: &mut String| match m {
                    Some(s) => chunk.push_str(&s),
                    None => done = true,
                };
                take(first, &mut chunk);
                while let Ok(more) = rx.try_recv() {
                    take(more, &mut chunk);
                }
                transcript.update(cx, |t, cx| {
                    if !chunk.is_empty() {
                        t.push_chunk(&chunk, cx);
                    }
                    if done {
                        t.end_stream(cx);
                    }
                });
                if done {
                    metrics.borrow_mut().stream_ended();
                    let exit = std::env::var("SOTTO_GPUI_EXIT_AFTER_STREAM").is_ok_and(|v| v == "1");
                    // Memory is sampled three seconds after the stream ends, once the last frames settle.
                    cx.background_executor().timer(Duration::from_secs(3)).await;
                    metrics.borrow_mut().sample_memory();
                    metrics.borrow_mut().write();
                    if exit {
                        cx.background_executor().timer(Duration::from_secs(2)).await;
                        this.update(cx, |_, cx| cx.quit()).ok();
                    }
                    // `SOTTO_GPUI_LOOP=1` streams the reply again and again, for typing while it streams.
                    if std::env::var("SOTTO_GPUI_LOOP").is_ok_and(|v| v == "1") {
                        this.update(cx, |root, cx| root.start_stream(cx)).ok();
                    }
                    return;
                }
            }
        }));
    }

    fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.composer.read(cx).text.clone();
        if text.trim().is_empty() {
            return;
        }
        let plain = text.replace('\u{202F}', "").replace('\u{00A0}', " ");
        self.composer.update(cx, |c, cx| c.clear(cx));
        self.transcript.update(cx, |t, cx| t.add_user_message(plain, cx));
        self.start_stream(cx);
        let _ = window;
    }

    fn set_theme(&mut self, mode: Mode, cx: &mut Context<Self>) {
        self.mode = mode;
        self.tokens = Tokens::new(mode);
        let tokens = self.tokens.clone();
        self.transcript.update(cx, |t, cx| {
            t.tokens = tokens.clone();
            t.list.remeasure();
            cx.notify();
        });
        self.web.update(cx, |w, _| w.set_theme(&tokens));
        cx.notify();
    }

    fn open_menu(&mut self, menu: Menu, window: &mut Window, cx: &mut Context<Self>) {
        if self.menu == Some(menu) {
            self.close_menu(window, cx);
            return;
        }
        self.menu = Some(menu);
        self.menu_ix = match menu {
            Menu::Attach => 0,
            Menu::Permissions => self.permission,
            Menu::Model => self.model,
            Menu::Effort => self.effort,
        };
        window.focus(&self.menu_focus, cx);
        cx.notify();
    }

    fn close_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(menu) = self.menu.take() {
            let chip = &self.chip_focus[menu as usize];
            window.focus(chip, cx);
            cx.notify();
        }
    }

    fn menu_items(&self, menu: Menu) -> Vec<String> {
        match menu {
            Menu::Attach => vec!["Attach a file: harbor-notes.md".into(), "Quote the last reply".into()],
            Menu::Permissions => PERMISSIONS.iter().map(|s| s.to_string()).collect(),
            Menu::Model => MODELS.iter().map(|s| s.to_string()).collect(),
            Menu::Effort => EFFORTS.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn choose(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(menu) = self.menu else { return };
        match menu {
            Menu::Attach => {
                self.menu = None;
                let composer_focus = self.composer.read(cx).focus.clone();
                window.focus(&composer_focus, cx);
                self.composer.update(cx, |c, cx| {
                    if ix == 0 {
                        c.insert_pill(PillKind::File, "harbor-notes.md", window, cx);
                    } else {
                        c.insert_pill(PillKind::Quote, "“Every berth is full…”", window, cx);
                    }
                });
                cx.notify();
                return;
            }
            Menu::Permissions => self.permission = ix,
            Menu::Model => self.model = ix,
            Menu::Effort => self.effort = ix,
        }
        self.close_menu(window, cx);
    }

    fn focus_region(&mut self, forward: bool, window: &mut Window, cx: &mut Context<Self>) {
        let regions: Vec<FocusHandle> = vec![
            self.transcript.read(cx).focus.clone(),
            self.composer.read(cx).focus.clone(),
            self.web.read(cx).focus.clone(),
            self.terminal.read(cx).focus.clone(),
        ];
        let current = regions.iter().position(|h| h.contains_focused(window, cx));
        let next = match current {
            Some(i) if forward => (i + 1) % regions.len(),
            Some(i) => (i + regions.len() - 1) % regions.len(),
            None => 0,
        };
        let narrow = window.viewport_size().width < px(1100.);
        if narrow {
            if next == 2 {
                self.tool_tab = ToolTab::Page;
            } else if next == 3 {
                self.tool_tab = ToolTab::Terminal;
            }
        }
        self.last_direction_forward = forward;
        window.focus(&regions[next], cx);
        cx.notify();
    }
}

fn icon(path: &'static str, color: Hsla, size_px: f32) -> gpui::Svg {
    svg().path(path).size(px(size_px)).text_color(color).flex_none()
}

impl Root {
    fn strip(&self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = &self.tokens;
        let ink = t.toolbar_text.hsla();
        let muted = t.text_muted.hsla();
        let control = |id: &'static str, label: &'static str| {
            div()
                .id(id)
                .role(Role::Button)
                .aria_label(label)
                .focusable()
                .tab_stop(true)
                .h(px(28.))
                .px(px(8.))
                .flex()
                .items_center()
                .gap(px(6.))
                .rounded(px(6.))
                .text_size(px(13.))
                .text_color(ink)
                .cursor_pointer()
                .hover(|s| s.bg(t.hover.hsla()))
                .focus_visible(|s| s.border_2().border_color(t.focus_ring.hsla()))
        };
        let variant_button = |v: Variant, id: &'static str, label: &'static str| {
            let on = self.variant == v;
            div()
                .id(id)
                .role(Role::RadioButton)
                .aria_label(SharedString::from(format!("Composer variant {label}")))
                .aria_toggled(if on { gpui::Toggled::True } else { gpui::Toggled::False })
                .focusable()
                .tab_stop(true)
                .w(px(26.))
                .h(px(24.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(4.))
                .text_size(px(12.))
                .font_weight(if on { FontWeight::SEMIBOLD } else { FontWeight::NORMAL })
                .text_color(if on { t.text.hsla() } else { muted })
                .when(on, |d| d.bg(t.surface_overlay.hsla()))
                .cursor_pointer()
                .focus_visible(|s| s.border_2().border_color(t.focus_ring.hsla()))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.variant = v;
                    cx.notify();
                }))
                .child(label)
        };
        let window_button = |id: &'static str, label: &'static str, path: &'static str, area: WindowControlArea, close: bool| {
            div()
                .id(id)
                .role(Role::Button)
                .aria_label(label)
                .window_control_area(area)
                .w(px(46.))
                .h_full()
                .flex()
                .items_center()
                .justify_center()
                .hover(move |s| if close { s.bg(gpui::rgb(0xc42b1c)) } else { s.bg(t.hover.hsla()) })
                .child(icon(path, ink, 16.))
        };
        let dark = self.mode == Mode::Dark;
        let _ = window;
        div()
            .id("strip")
            .role(Role::TitleBar)
            .aria_label("Sotto")
            .h(px(40.))
            .flex_none()
            .flex()
            .items_center()
            .bg(t.chrome.hsla())
            .border_b_1()
            .border_color(t.border_faint.hsla())
            .child(
                // The drag area: everything in the strip that is not a control moves the window.
                div()
                    .id("drag")
                    .window_control_area(WindowControlArea::Drag)
                    .flex_1()
                    .h_full()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .pl(px(14.))
                    .child(icon("icons/mark.svg", t.accent.hsla(), 18.))
                    .child(div().text_size(px(14.)).font_weight(FontWeight::SEMIBOLD).text_color(ink).child("Harbor scheduler"))
                    .child(div().text_size(px(13.)).text_color(muted).child("/ harbor"))
                    .when(self.reduce_motion, |d| {
                        d.child(
                            div()
                                .id("reduced-motion-note")
                                .role(Role::Status)
                                .aria_label("Reduced motion is on")
                                .ml(px(8.))
                                .px(px(6.))
                                .py(px(1.))
                                .rounded(px(4.))
                                .bg(t.surface_elevated.hsla())
                                .text_size(px(11.))
                                .text_color(muted)
                                .child("Reduced motion"),
                        )
                    }),
            )
            .child(
                div()
                    .id("variants")
                    .role(Role::RadioGroup)
                    .aria_label("Composer variant")
                    .flex()
                    .items_center()
                    .gap(px(2.))
                    .p(px(2.))
                    .mr(px(6.))
                    .rounded(px(6.))
                    .bg(t.surface.hsla())
                    .child(div().px(px(6.)).text_size(px(12.)).text_color(muted).child("Composer"))
                    .child(variant_button(Variant::A, "variant-a", "A"))
                    .child(variant_button(Variant::B, "variant-b", "B"))
                    .child(variant_button(Variant::C, "variant-c", "C")),
            )
            .child(
                control("theme", if dark { "Switch to the light theme" } else { "Switch to the dark theme" })
                    .mr(px(6.))
                    .on_click(cx.listener(|this, _, _, cx| {
                        let next = if this.mode == Mode::Dark { Mode::Light } else { Mode::Dark };
                        this.set_theme(next, cx);
                    }))
                    .child(icon(if dark { "icons/sun.svg" } else { "icons/moon.svg" }, ink, 16.))
                    .child(if dark { "Light" } else { "Dark" }),
            )
            .child(window_button("min", "Minimize", "icons/min.svg", WindowControlArea::Min, false))
            .child(window_button("max", "Maximize", "icons/max.svg", WindowControlArea::Max, false))
            .child(window_button("close", "Close", "icons/close.svg", WindowControlArea::Close, true))
    }

    fn chip(&self, which: Menu, id: &'static str, path: &'static str, label: String, accessible: String, cx: &mut Context<Self>) -> gpui::Stateful<gpui::Div> {
        let t = &self.tokens;
        let open = self.menu == Some(which);
        let quiet = t.text_quiet.hsla();
        let quiet_chip = self.variant == Variant::B;
        div()
            .id(id)
            .role(Role::Button)
            .aria_label(SharedString::from(accessible))
            .aria_expanded(open)
            .track_focus(&self.chip_focus[which as usize])
            .tab_stop(true)
            .h(px(30.))
            .px(px(if label.is_empty() { 7. } else { 9. }))
            .flex()
            .items_center()
            .gap(px(6.))
            .rounded(px(if self.variant == Variant::C { 15. } else { 6. }))
            .text_size(px(13.))
            .text_color(quiet)
            .when(self.variant == Variant::C && !label.is_empty(), |d| d.border_1().border_color(t.border_faint.hsla()))
            .when(open, |d| d.bg(t.hover.hsla()))
            .cursor_pointer()
            .hover(|s| s.bg(t.hover.hsla()))
            .focus_visible(|s| s.border_2().border_color(t.focus_ring.hsla()))
            .on_click(cx.listener(move |this, _, window, cx| this.open_menu(which, window, cx)))
            .when(!quiet_chip || label.is_empty(), |d| d.child(icon(path, quiet, 16.)))
            .when(!label.is_empty(), |d| d.child(label))
    }

    fn menu_overlay(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let menu = self.menu?;
        let t = &self.tokens;
        let items = self.menu_items(menu);
        let selected = match menu {
            Menu::Attach => usize::MAX,
            Menu::Permissions => self.permission,
            Menu::Model => self.model,
            Menu::Effort => self.effort,
        };
        let title = match menu {
            Menu::Attach => "Attach",
            Menu::Permissions => "Permissions",
            Menu::Model => "Model",
            Menu::Effort => "Effort",
        };
        let rows: Vec<AnyElement> = items
            .into_iter()
            .enumerate()
            .map(|(ix, label)| {
                let active = ix == self.menu_ix;
                div()
                    .id(("menu-item", ix))
                    .role(if menu == Menu::Attach { Role::MenuItem } else { Role::MenuItemRadio })
                    .aria_label(SharedString::from(label.clone()))
                    .when(menu != Menu::Attach, |d| d.aria_toggled(if ix == selected { gpui::Toggled::True } else { gpui::Toggled::False }))
                    .when(active, |d| d.aria_active_descendant())
                    .px(px(10.))
                    .py(px(6.))
                    .rounded(px(8.))
                    .text_size(px(14.))
                    .text_color(t.text.hsla())
                    .flex()
                    .justify_between()
                    .gap(px(16.))
                    .when(active, |d| d.bg(t.hover.hsla()))
                    .cursor_pointer()
                    .on_click(cx.listener(move |this, _, window, cx| this.choose(ix, window, cx)))
                    .child(label)
                    .when(ix == selected, |d| d.child(div().text_color(t.accent_text.hsla()).child("✓")))
                    .into_any_element()
            })
            .collect();
        Some(
            div()
                .id("menu")
                .role(Role::Menu)
                .aria_label(title)
                .track_focus(&self.menu_focus)
                .key_context("Menu")
                .on_action(cx.listener(|this, _: &MenuUp, _, cx| {
                    let n = this.menu.map(|m| this.menu_items(m).len()).unwrap_or(1);
                    this.menu_ix = (this.menu_ix + n - 1) % n;
                    cx.notify();
                }))
                .on_action(cx.listener(|this, _: &MenuDown, _, cx| {
                    let n = this.menu.map(|m| this.menu_items(m).len()).unwrap_or(1);
                    this.menu_ix = (this.menu_ix + 1) % n;
                    cx.notify();
                }))
                .on_action(cx.listener(|this, _: &menu_actions::Choose, window, cx| this.choose(this.menu_ix, window, cx)))
                .on_mouse_down_out(cx.listener(|this, _, window, cx| this.close_menu(window, cx)))
                .min_w(px(220.))
                .p(px(6.))
                .rounded(px(10.))
                .bg(t.surface_overlay.hsla())
                .border_1()
                .border_color(t.border_faint.hsla())
                .shadow_lg()
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(div().px(px(10.)).py(px(4.)).text_size(px(12.)).text_color(t.text_muted.hsla()).child(title))
                .children(rows)
                .into_any_element(),
        )
    }

    fn composer_view(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let t = &self.tokens;
        let streaming = self.transcript.read(cx).streaming;
        let mut look = TextLook::from_tokens(t);
        match self.variant {
            Variant::A => {}
            Variant::B => {
                look.font_size = px(14.);
                look.line_height = px(22.);
                look.pill_bg = gpui::transparent_black();
                look.pill_border = Some(t.border.hsla());
                look.pill_quote_bg = gpui::transparent_black();
                look.pill_radius = px(11.);
            }
            Variant::C => {
                look.pill_bg = t.accent_surface.hsla();
                look.pill_radius = px(12.);
            }
        }
        let text = ComposerElement { input: self.composer.clone(), look, caret_visible: self.caret_on };
        let (value, hint) = {
            let c = self.composer.read(cx);
            (SharedString::from(c.text.replace('\u{202F}', "").replace('\u{00A0}', " ")), c.placeholder.clone())
        };
        // The focusable wrapper is what UI Automation reports as focused, so it carries the edit's role, name and value.
        let text = ComposerText::bind(
            &self.composer,
            div()
                .id("composer-input")
                .role(Role::MultilineTextInput)
                .aria_label("Message")
                .aria_value(value)
                .aria_placeholder(hint)
                .aria_keyshortcuts("Enter sends, Shift+Enter starts a new line")
                .w_full()
                .min_w_0(),
            cx,
        )
        .child(text);

        let send_label = if streaming { "Stop the reply" } else { "Send" };
        let send = div()
            .id("send")
            .role(Role::Button)
            .aria_label(send_label)
            .focusable()
            .tab_stop(true)
            .size(px(if self.variant == Variant::C { 36. } else { 32. }))
            .flex_none()
            .rounded_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(if self.variant == Variant::C { t.primary.hsla() } else { t.pill.hsla() })
            .cursor_pointer()
            .focus_visible(|s| s.border_2().border_color(t.focus_ring.hsla()))
            .on_click(cx.listener(|this, _, window, cx| {
                if this.transcript.read(cx).streaming {
                    this.stream_task = None;
                    this.transcript.update(cx, |t, cx| t.end_stream(cx));
                } else {
                    this.send(window, cx);
                }
            }))
            .child(icon(
                if streaming { "icons/stop.svg" } else { "icons/up.svg" },
                if self.variant == Variant::C { t.primary_contrast.hsla() } else { t.pill_ink.hsla() },
                16.,
            ));

        let chips = vec![
            self.chip(Menu::Attach, "chip-attach", "icons/attach.svg", String::new(), "Attach a file or quote a reply".into(), cx),
            self.chip(Menu::Permissions, "chip-permissions", "icons/shield.svg", PERMISSIONS[self.permission].into(), format!("Permissions: {}", PERMISSIONS[self.permission]), cx),
            self.chip(Menu::Model, "chip-model", "icons/spark.svg", MODELS[self.model].into(), format!("Model: {}", MODELS[self.model]), cx),
            self.chip(Menu::Effort, "chip-effort", "icons/gauge.svg", EFFORTS[self.effort].into(), format!("Effort: {}", EFFORTS[self.effort]), cx),
        ];
        let menu = self.menu_overlay(cx).map(|m| deferred(anchored().anchor(gpui::Anchor::BottomLeft).child(div().mb(px(8.)).child(m))).with_priority(1));
        let _ = window;
        let [attach, permissions, model, effort] = <[_; 4]>::try_from(chips).ok().unwrap();

        match self.variant {
            Variant::A => div()
                .id("composer")
                .role(Role::Form)
                .aria_label("Composer")
                .mx(px(24.))
                .mb(px(16.))
                .px(px(16.))
                .pt(px(14.))
                .pb(px(10.))
                .rounded(px(14.))
                .bg(t.composer_card.hsla())
                .flex()
                .flex_col()
                .gap(px(10.))
                .child(text)
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .child(attach)
                        .child(permissions)
                        .child(div().flex_1())
                        .child(model)
                        .child(effort)
                        .child(div().w(px(6.)))
                        .child(send),
                )
                .children(menu)
                .into_any_element(),
            Variant::B => div()
                .id("composer")
                .role(Role::Form)
                .aria_label("Composer")
                .mx(px(24.))
                .mb(px(14.))
                .pl(px(6.))
                .pr(px(8.))
                .py(px(6.))
                .rounded(px(20.))
                .bg(t.composer_card.hsla())
                .border_1()
                .border_color(t.border_faint.hsla())
                .flex()
                .items_end()
                .gap(px(4.))
                .child(attach)
                .child(div().flex_1().min_w_0().py(px(4.)).child(text))
                .child(div().flex().items_center().gap(px(0.)).child(permissions).child(model).child(effort))
                .child(send)
                .children(menu)
                .into_any_element(),
            Variant::C => div()
                .id("composer")
                .role(Role::Form)
                .aria_label("Composer")
                .mx(px(24.))
                .mb(px(14.))
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(
                    div()
                        .flex()
                        .items_end()
                        .gap(px(10.))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .px(px(16.))
                                .py(px(12.))
                                .rounded(px(14.))
                                .bg(t.surface.hsla())
                                .border_1()
                                .border_color(t.field_border.hsla())
                                .child(text),
                        )
                        .child(send),
                )
                .child(div().flex().items_center().gap(px(6.)).child(attach).child(permissions).child(model).child(effort))
                .children(menu)
                .into_any_element(),
        }
    }

    fn tools(&self, narrow: bool, cx: &mut Context<Self>) -> AnyElement {
        let t = &self.tokens;
        let show_page = !narrow || self.tool_tab == ToolTab::Page;
        let show_terminal = !narrow || self.tool_tab == ToolTab::Terminal;
        self.web.update(cx, |w, _| w.set_hidden(!show_page));
        let terminal_focused = false;
        let terminal_el = self.terminal_view(cx);
        let tab = |id: &'static str, label: &'static str, path: &'static str, which: ToolTab| {
            let on = self.tool_tab == which;
            div()
                .id(id)
                .role(Role::Tab)
                .aria_label(label)
                .aria_selected(on)
                .focusable()
                .tab_stop(true)
                .h(px(28.))
                .px(px(10.))
                .flex()
                .items_center()
                .gap(px(6.))
                .rounded(px(6.))
                .text_size(px(13.))
                .text_color(if on { t.text.hsla() } else { t.text_muted.hsla() })
                .when(on, |d| d.bg(t.surface_elevated.hsla()))
                .cursor_pointer()
                .focus_visible(|s| s.border_2().border_color(t.focus_ring.hsla()))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.tool_tab = which;
                    cx.notify();
                }))
                .child(icon(path, if on { t.text.hsla() } else { t.text_muted.hsla() }, 14.))
                .child(label)
        };
        let surface = self.web.read(cx).surface;
        let surface_switch = |id: &'static str, label: &'static str, which: Surface| {
            let on = surface == which;
            div()
                .id(id)
                .role(Role::RadioButton)
                .aria_label(SharedString::from(format!("Show the page as a {label}")))
                .aria_toggled(if on { gpui::Toggled::True } else { gpui::Toggled::False })
                .focusable()
                .tab_stop(true)
                .px(px(8.))
                .h(px(22.))
                .flex()
                .items_center()
                .rounded(px(4.))
                .text_size(px(12.))
                .text_color(if on { t.text.hsla() } else { t.text_muted.hsla() })
                .when(on, |d| d.bg(t.surface_overlay.hsla()))
                .cursor_pointer()
                .focus_visible(|s| s.border_2().border_color(t.focus_ring.hsla()))
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.web.update(cx, |w, cx| w.set_surface(which, window, cx));
                }))
                .child(label)
        };
        let page = div()
            .id("page-region")
            .role(Role::Region)
            .aria_label("Web page")
            .flex()
            .flex_col()
            .gap(px(8.))
            .when(narrow, |d| d.flex_1())
            .when(!narrow, |d| d.h(px(0.)).flex_1().max_h(relative_half()))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(icon("icons/globe.svg", t.text_muted.hsla(), 14.))
                    .child(div().flex_1().min_w_0().text_size(px(13.)).text_color(t.text_muted.hsla()).child("harbor.example/status"))
                    .child(
                        div()
                            .id("surface-switch")
                            .role(Role::RadioGroup)
                            .aria_label("Page surface")
                            .flex()
                            .gap(px(2.))
                            .p(px(2.))
                            .rounded(px(6.))
                            .bg(t.surface.hsla())
                            .child(surface_switch("surface-texture", "Texture", Surface::Texture))
                            .child(surface_switch("surface-child", "Child window", Surface::ChildWindow)),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_h(px(120.))
                    .rounded(px(10.))
                    .border_1()
                    .border_color(t.border_faint.hsla())
                    .child(self.web.clone()),
            );
        let terminal = div()
            .id("terminal-region")
            .role(Role::Region)
            .aria_label(SharedString::from(format!("Terminal, {}", self.terminal.read(cx).shell_name)))
            .flex_1()
            .min_h(px(120.))
            .flex()
            .flex_col()
            .gap(px(6.))
            .when(!narrow, |d| {
                d.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .text_size(px(13.))
                        .text_color(t.text_muted.hsla())
                        .child(icon("icons/terminal.svg", t.text_muted.hsla(), 14.))
                        .child(SharedString::from(format!("Terminal · {}", self.terminal.read(cx).shell_name))),
                )
            })
            .child(terminal_el);
        let _ = terminal_focused;
        div()
            .id("tools")
            .role(Role::Complementary)
            .aria_label("Tools")
            .h_full()
            .flex()
            .flex_col()
            .gap(px(10.))
            .p(px(12.))
            .bg(t.canvas.hsla())
            .border_l_1()
            .border_color(t.border_faint.hsla())
            .when(narrow, |d| {
                d.child(
                    div()
                        .id("tool-tabs")
                        .role(Role::TabList)
                        .aria_label("Tools")
                        .flex()
                        .gap(px(4.))
                        .child(tab("tab-page", "Page", "icons/globe.svg", ToolTab::Page))
                        .child(tab("tab-terminal", "Terminal", "icons/terminal.svg", ToolTab::Terminal)),
                )
            })
            .when(show_page, |d| d.child(page))
            .when(show_terminal, |d| d.child(terminal))
            .into_any_element()
    }

    fn terminal_view(&self, cx: &mut Context<Self>) -> AnyElement {
        let t = &self.tokens;
        let view = self.terminal.clone();
        let focus = view.read(cx).focus.clone();
        let text: SharedString = view.read(cx).visible_text().into();
        let exited = view.read(cx).has_exited();
        let key_view = view.clone();
        let down_view = view.clone();
        let move_view = view.clone();
        let up_view = view.clone();
        let wheel_view = view.clone();
        let copy_view = view.clone();
        let paste_view = view.clone();
        div()
            .id("terminal")
            .role(Role::Terminal)
            .aria_label("Terminal output")
            .aria_description(if exited { SharedString::from("The shell ended. Press Enter to start it again.") } else { text })
            .key_context("Terminal")
            .track_focus(&focus)
            .tab_stop(true)
            .flex_1()
            .min_h(px(80.))
            .p(px(8.))
            .rounded(px(10.))
            .bg(t.terminal_bg.hsla())
            .border_1()
            .border_color(t.border_faint.hsla())
            .focus_visible(|s| s.border_2().border_color(t.focus_ring.hsla()))
            .on_action(move |_: &terminal_actions::CopyTerminal, _, cx| copy_view.update(cx, |v, cx| v.copy_selection(cx)))
            .on_action(move |_: &terminal_actions::PasteTerminal, _, cx| paste_view.update(cx, |v, cx| v.paste(cx)))
            .on_action({
                let v = view.clone();
                move |_: &terminal_actions::SendTab, _, cx| v.update(cx, |v, cx| v.send_text("\t", cx))
            })
            .on_action({
                let v = view.clone();
                move |_: &terminal_actions::SendBacktab, _, cx| v.update(cx, |v, cx| v.send_text("\x1b[Z", cx))
            })
            .on_action({
                let v = view.clone();
                move |_: &terminal_actions::SendEscape, _, cx| v.update(cx, |v, cx| v.send_text("\x1b", cx))
            })
            .on_key_down(move |event, _, cx| {
                if key_view.update(cx, |v, cx| v.key_down(event, cx)) {
                    cx.stop_propagation();
                }
            })
            .on_mouse_down(MouseButton::Left, move |e, window, cx| down_view.update(cx, |v, cx| v.mouse_down(e, window, cx)))
            .on_mouse_move(move |e, _, cx| move_view.update(cx, |v, cx| v.mouse_move(e, cx)))
            .on_mouse_up(MouseButton::Left, move |_, _, cx| up_view.update(cx, |v, cx| v.mouse_up(cx)))
            .on_scroll_wheel(move |e, _, cx| wheel_view.update(cx, |v, cx| v.scroll_wheel(e, cx)))
            .cursor_text()
            .child(TerminalElement { view: view.clone(), tokens: t.clone(), focused: false, reduce_motion: self.reduce_motion })
            .into_any_element()
    }
}

fn relative_half() -> gpui::DefiniteLength {
    gpui::relative(0.5)
}

mod terminal_actions {
    gpui::actions!(terminal, [CopyTerminal, PasteTerminal, SendTab, SendBacktab, SendEscape]);
}

mod menu_actions {
    gpui::actions!(menu, [Choose]);
}

impl Render for Root {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.metrics.borrow_mut().begin_frame(self.transcript.read(cx).streaming);
        if let Some(key_at) = self.composer.update(cx, |c, _| c.last_key_at.take()) {
            self.metrics.borrow_mut().key(key_at);
        }
        let t = self.tokens.clone();
        let viewport = window.viewport_size();
        let narrow = viewport.width < px(1100.);
        let tools_width = if narrow { px(360.) } else { (viewport.width * 0.38).clamp(px(380.), px(640.)) };
        let transcript = self.transcript.clone();
        let following = transcript.read(cx).is_following();
        let metrics = self.metrics.clone();
        let terminal_focused = self.terminal.read(cx).focus.is_focused(window);

        let jump = (!following).then(|| {
            div()
                .id("jump")
                .role(Role::Button)
                .aria_label("Jump to latest")
                .focusable()
                .tab_stop(true)
                .absolute()
                .bottom(px(12.))
                .left_0()
                .right_0()
                .flex()
                .justify_center()
                .child(
                    div()
                        .px(px(12.))
                        .h(px(30.))
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .rounded(px(15.))
                        .bg(t.surface_overlay.hsla())
                        .border_1()
                        .border_color(t.border_faint.hsla())
                        .shadow_md()
                        .text_size(px(13.))
                        .text_color(t.text.hsla())
                        .cursor_pointer()
                        .child(icon("icons/down.svg", t.text.hsla(), 14.))
                        .child("Jump to latest"),
                )
                .focus_visible(|s| s.border_2().border_color(t.focus_ring.hsla()))
                .on_click(cx.listener(|this, _, _, cx| this.transcript.update(cx, |t, cx| t.jump_to_latest(cx))))
        });

        let composer = self.composer_view(window, cx);
        let tools = self.tools(narrow, cx);
        let _ = terminal_focused;

        div()
            .id("root")
            .role(Role::Application)
            .aria_label("Sotto")
            .key_context("Root")
            .size_full()
            .flex()
            .flex_col()
            .bg(t.canvas.hsla())
            .text_color(t.text.hsla())
            .font_family(UI_FONT)
            .text_size(px(15.))
            .on_action(cx.listener(|this, _: &FocusNext, window, cx| {
                this.last_direction_forward = true;
                window.focus_next(cx);
            }))
            .on_action(cx.listener(|this, _: &FocusPrev, window, cx| {
                this.last_direction_forward = false;
                window.focus_prev(cx);
            }))
            .on_action(cx.listener(|this, _: &NextRegion, window, cx| this.focus_region(true, window, cx)))
            .on_action(cx.listener(|this, _: &PrevRegion, window, cx| this.focus_region(false, window, cx)))
            .on_action(cx.listener(|this, _: &Dismiss, window, cx| this.close_menu(window, cx)))
            .on_action(cx.listener(|this, _: &ToggleTheme, _, cx| {
                let next = if this.mode == Mode::Dark { Mode::Light } else { Mode::Dark };
                this.set_theme(next, cx);
            }))
            .on_action(cx.listener(|this, _: &VariantA, _, cx| {
                this.variant = Variant::A;
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &VariantB, _, cx| {
                this.variant = Variant::B;
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &VariantC, _, cx| {
                this.variant = Variant::C;
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &Restream, _, cx| this.start_stream(cx)))
            .on_action(cx.listener(|_, _: &Quit, _, cx| cx.quit()))
            .child(self.strip(window, cx))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .child(
                        div()
                            .id("thread")
                            .role(Role::Main)
                            .aria_label("Thread: Harbor scheduler")
                            .flex_1()
                            .min_w(px(420.))
                            .h_full()
                            .flex()
                            .flex_col()
                            .child(div().flex_1().min_h_0().relative().child(transcript.clone()).children(jump))
                            .child(composer),
                    )
                    .child(div().w(tools_width).flex_none().h_full().child(tools)),
            )
            .child(
                // Painted last: marks the end of the frame's paint for the frame log.
                canvas(|_, _, _| (), move |_, _, _, _| metrics.borrow_mut().end_paint()).absolute().size_0(),
            )
    }
}

fn json_string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn main() {
    metrics::mark_process_start();
    // `--dump-content <dir>` writes the invented conversation, so Electron can be fed the same bytes.
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--dump-content") {
        let dir = std::path::PathBuf::from(args.get(i + 1).expect("--dump-content <dir>"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("reply.md"), content::long_reply()).unwrap();
        let earlier: Vec<String> = content::earlier_messages()
            .iter()
            .map(|m| {
                format!(
                    "{{\"role\":\"{}\",\"time\":{},\"text\":{}}}",
                    if m.from_user { "user" } else { "assistant" },
                    json_string(&m.time),
                    json_string(&m.markdown)
                )
            })
            .collect();
        std::fs::write(dir.join("earlier.json"), format!("[{}]", earlier.join(",\n"))).unwrap();
        std::fs::write(dir.join("last-ask.txt"), content::LAST_ASK).unwrap();
        return;
    }
    highlight::warm();
    let app = gpui_platform::application().with_assets(icons::Icons);
    app.run(|cx: &mut App| {
        let fonts: Vec<std::borrow::Cow<'static, [u8]>> = vec![
            include_bytes!("../assets/fonts/Figtree-400.ttf").as_slice().into(),
            include_bytes!("../assets/fonts/Figtree-500.ttf").as_slice().into(),
            include_bytes!("../assets/fonts/Figtree-600.ttf").as_slice().into(),
            include_bytes!("../assets/fonts/Figtree-700.ttf").as_slice().into(),
            include_bytes!("../assets/fonts/SplineSansMono-400.ttf").as_slice().into(),
            include_bytes!("../assets/fonts/SplineSansMono-500.ttf").as_slice().into(),
        ];
        cx.text_system().add_fonts(fonts).expect("the app's fonts load");

        let mut bindings = vec![
            KeyBinding::new("tab", FocusNext, None),
            KeyBinding::new("shift-tab", FocusPrev, None),
            KeyBinding::new("ctrl-tab", NextRegion, None),
            KeyBinding::new("ctrl-shift-tab", PrevRegion, None),
            KeyBinding::new("f6", NextRegion, None),
            KeyBinding::new("shift-f6", PrevRegion, None),
            KeyBinding::new("escape", Dismiss, None),
            KeyBinding::new("ctrl-shift-l", ToggleTheme, None),
            KeyBinding::new("alt-1", VariantA, None),
            KeyBinding::new("alt-2", VariantB, None),
            KeyBinding::new("alt-3", VariantC, None),
            KeyBinding::new("ctrl-shift-r", Restream, None),
            KeyBinding::new("ctrl-q", Quit, None),
            KeyBinding::new("up", MenuUp, Some("Menu")),
            KeyBinding::new("down", MenuDown, Some("Menu")),
            KeyBinding::new("enter", menu_actions::Choose, Some("Menu")),
            KeyBinding::new("space", menu_actions::Choose, Some("Menu")),
            KeyBinding::new("ctrl-shift-c", terminal_actions::CopyTerminal, Some("Terminal")),
            KeyBinding::new("ctrl-shift-v", terminal_actions::PasteTerminal, Some("Terminal")),
            // In the terminal, Tab and Escape belong to the shell; Ctrl+Tab and F6 leave it.
            KeyBinding::new("tab", terminal_actions::SendTab, Some("Terminal")),
            KeyBinding::new("shift-tab", terminal_actions::SendBacktab, Some("Terminal")),
            KeyBinding::new("escape", terminal_actions::SendEscape, Some("Terminal")),
            // In the page, Tab walks its controls and then leaves it, as CEF's OnTakeFocus does.
            KeyBinding::new("tab", PageTab, Some("WebPane")),
            KeyBinding::new("shift-tab", PageBacktab, Some("WebPane")),
        ];
        bindings.extend(composer::key_bindings());
        bindings.extend(transcript::key_bindings());
        cx.bind_keys(bindings);

        let (w, h) = std::env::var("SOTTO_GPUI_SIZE")
            .ok()
            .and_then(|s| s.split_once('x').and_then(|(w, h)| Some((w.parse().ok()?, h.parse().ok()?))))
            .unwrap_or((1600.0f32, 1000.0f32));
        let bounds = Bounds::centered(None, size(px(w), px(h)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions { title: Some("Sotto (GPUI)".into()), appears_transparent: true, traffic_light_position: None }),
                window_min_size: Some(size(px(820.), px(560.))),
                app_id: Some("sotto-gpui-bakeoff".into()),
                ..Default::default()
            },
            |window, cx| cx.new(|cx| Root::new(window, cx)),
        )
        .expect("the window opens");
        cx.activate(true);
    });
}

#[allow(dead_code)]
fn _px(p: Pixels) -> Pixels {
    p
}
