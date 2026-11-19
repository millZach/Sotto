//! Sotto's thread screen in Slint: the Slint half of the native UI bake-off (issue #2689).
//! A prototype on `prototype/native-ui-slint`; it never merges into main. It makes no network call.

mod composer;
mod highlight;
mod markdown;
mod metrics;
mod motion;
mod terminal;
mod thread;
mod webpane;
#[cfg(windows)]
mod winsurface;

slint::include_modules!();

use highlight::CodeColors;
use slint::{ComponentHandle, Model, ModelRc, VecModel};
use slint::winit_030::WinitWindowAccessor;
use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

#[derive(Default, Clone)]
pub struct Args {
    pub variant: i32,
    pub light: bool,
    pub size: Option<(f32, f32)>,
    /// The window's top-left corner in physical desktop pixels, set before the first frame.
    pub position: Option<(i32, i32)>,
    pub no_tools: bool,
    pub stream: bool,
    pub finished: bool,
    pub bench: bool,
    pub exit: bool,
    pub launch_only: bool,
    pub out: Option<String>,
    pub scroll_up_after: Option<u64>,
    /// The composer's text at start, instead of the demo text with its two pills.
    pub composer_text: Option<String>,
    pub no_focus: bool,
    /// Stream the reply again half a second after each one ends (for typing while it streams).
    pub loop_stream: bool,
    /// The web pane's surface: image (default), or on Windows child or shared (src/winsurface.rs).
    pub web_surface: String,
}

fn args() -> Args {
    let mut a = Args::default();
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--variant" => a.variant = match it.next().as_deref() { Some("b") | Some("1") => 1, Some("c") | Some("2") => 2, _ => 0 },
            "--light" => a.light = true,
            "--size" => {
                if let Some((w, h)) = it.next().and_then(|s| s.split_once('x').map(|(w, h)| (w.parse().unwrap_or(1280.0), h.parse().unwrap_or(800.0)))) {
                    a.size = Some((w, h));
                }
            }
            "--position" => a.position = it.next().and_then(|s| s.split_once(',').and_then(|(x, y)| Some((x.parse().ok()?, y.parse().ok()?)))),
            "--no-tools" => a.no_tools = true,
            "--stream" => a.stream = true,
            "--finished" => a.finished = true,
            "--bench" => {
                a.bench = true;
                a.stream = true;
            }
            "--exit" => a.exit = true,
            "--launch-only" => a.launch_only = true,
            "--out" => a.out = it.next(),
            "--scroll-up-after" => a.scroll_up_after = it.next().and_then(|s| s.parse().ok()),
            "--composer-text" => a.composer_text = it.next(),
            "--no-focus" => a.no_focus = true,
            "--web-surface" => a.web_surface = it.next().unwrap_or_default(),
            "--loop" => {
                a.loop_stream = true;
                a.stream = true;
            }
            other => eprintln!("unknown argument {other}"),
        }
    }
    a
}

fn code_colors(ui: &AppWindow) -> CodeColors {
    let t = ui.global::<Theme>();
    let c = |c: slint::Color| [c.red(), c.green(), c.blue(), c.alpha()];
    CodeColors {
        text: c(t.get_reading_code_text()),
        keyword: c(t.get_code_keyword()),
        string: c(t.get_code_string()),
        number: c(t.get_code_number()),
        title: c(t.get_code_title()),
        ty: c(t.get_code_type()),
        comment: c(t.get_code_comment()),
        meta: c(t.get_code_meta()),
    }
}

fn menu(items: &[(&str, &str)]) -> ModelRc<MenuItem> {
    ModelRc::new(VecModel::from(items.iter().map(|(l, d)| MenuItem { label: (*l).into(), detail: (*d).into() }).collect::<Vec<_>>()))
}

fn main() {
    let launch_t0 = metrics::launch_t0();
    let args = args();
    slint::set_xdg_app_id("dev.sotto.SlintBakeoff").ok();
    let ui = AppWindow::new().expect("create the window");
    let backend = metrics::backend_name();
    ui.global::<Theme>().set_dark(!args.light);
    // Sotto's --tt-font-mono is 'Spline Sans Mono', ui-monospace, …, Consolas: Spline Sans Mono is not bundled, so
    // Electron on Windows draws Consolas, and so does this build there.
    if cfg!(windows) {
        ui.global::<Fonts>().set_mono("Consolas".into());
    }
    ui.set_composer_variant(args.variant);
    ui.set_tools_shown(!args.no_tools);
    if let Some((w, h)) = args.size {
        ui.window().set_size(slint::LogicalSize::new(w, h));
    }
    if let Some((x, y)) = args.position {
        ui.window().set_position(slint::PhysicalPosition::new(x, y));
    }

    // Reduced motion, from the system, and kept in step with it.
    motion::watch(&ui);

    // The thread.
    let thread = Rc::new(RefCell::new(thread::Thread::new(code_colors(&ui))));
    ui.set_rows(ModelRc::from(thread.borrow().rows.clone()));
    if args.finished {
        thread.borrow_mut().start_reply();
        thread.borrow_mut().finish();
    }

    // The composer.
    // Today's catalogue for a Claude thread (composer-reference/README.md): three models, five levels and Ultracode,
    // the provider's default effort until one is chosen, and Standard or Fast.
    ui.set_models(menu(&[("Opus 5.5", ""), ("Sonnet 5.5", ""), ("Haiku 5.5", "")]));
    ui.set_efforts(menu(&[("Low", ""), ("Medium", ""), ("High", ""), ("XHigh", ""), ("Max", ""), ("Ultracode", "")]));
    ui.set_permissions(menu(&[("Ask for approval", ""), ("Allow edits", ""), ("Auto", ""), ("Full access", "")]));
    ui.set_model_index(0);
    ui.set_effort_index(-1);
    ui.set_permission_index(0);
    ui.set_model_name("Opus 5.5".into());
    ui.set_effort("Default".into());
    ui.set_permission("Ask for approval".into());
    ui.set_composer_text(args.composer_text.clone().map(Into::into).unwrap_or_else(composer::initial_text));
    ui.set_effort_offer(composer::suggested_effort(&ui.get_composer_text(), -1).into());
    let pills: Rc<RefCell<Vec<composer::Pill>>> = Rc::new(RefCell::new(composer::parse(&ui.get_composer_text()).0));
    let metrics = metrics::Metrics::new(launch_t0, args.clone(), backend);

    {
        let w = ui.as_weak();
        let pills = pills.clone();
        let m = metrics.clone();
        ui.on_composer_edited(move |text| {
            let ui = w.unwrap();
            m.borrow_mut().text_changed();
            let (found, cleaned) = composer::parse(&text);
            if let Some(cleaned) = cleaned {
                ui.set_composer_text(cleaned.into());
            }
            ui.set_composer_rtl(markdown::starts_rtl(&ui.get_composer_text()));
            ui.set_effort_offer(composer::suggested_effort(&ui.get_composer_text(), ui.get_effort_index()).into());
            *pills.borrow_mut() = found;
            composer::measure(&ui, &pills.borrow());
        });
    }
    {
        let pills = pills.clone();
        ui.on_pill_key(move |key, shift, anchor, cursor| composer::key_action(&pills.borrow(), &key, shift, anchor as usize, cursor as usize));
    }
    {
        let w = ui.as_weak();
        let pills = pills.clone();
        ui.on_caret_moved(move |anchor, cursor| {
            if anchor != cursor {
                return;
            }
            if let Some(to) = composer::snap(&pills.borrow(), cursor as usize) {
                let w = w.clone();
                slint::Timer::single_shot(Duration::ZERO, move || {
                    if let Some(ui) = w.upgrade() {
                        ui.invoke_place_cursor(to as i32, to as i32);
                    }
                });
            }
        });
    }
    {
        let w = ui.as_weak();
        let pills = pills.clone();
        ui.on_composer_layout_changed(move || {
            let w = w.clone();
            let pills = pills.clone();
            slint::Timer::single_shot(Duration::ZERO, move || {
                if let Some(ui) = w.upgrade() {
                    composer::measure(&ui, &pills.borrow());
                }
            });
        });
    }
    ui.on_composition_changed(|text| {
        if !text.is_empty() {
            eprintln!("event=ime-preedit chars={}", text.chars().count());
        }
    });
    {
        let w = ui.as_weak();
        let next = Rc::new(RefCell::new(0usize));
        ui.on_attach(move || {
            let ui = w.unwrap();
            let names = composer::attach_names();
            let name = names[*next.borrow() % names.len()];
            *next.borrow_mut() += 1;
            let mut text = ui.get_composer_text().to_string();
            text.push(' ');
            text.push_str(&composer::pill_text(composer::FILE, name));
            text.push(' ');
            ui.set_composer_text(text.clone().into());
            ui.invoke_composer_edited(text.into());
            ui.invoke_focus_composer();
            let end = ui.get_composer_text().len() as i32;
            ui.invoke_place_cursor(end, end);
        });
    }
    {
        let w = ui.as_weak();
        ui.on_pick_model(move |i| {
            let ui = w.unwrap();
            ui.set_model_index(i);
            if let Some(item) = ui.get_models().row_data(i as usize) {
                ui.set_model_name(item.label);
            }
        });
        let w = ui.as_weak();
        ui.on_pick_effort(move |i| {
            let ui = w.unwrap();
            ui.set_effort_index(i);
            if let Some(item) = ui.get_efforts().row_data(i as usize) {
                ui.set_effort(item.label);
            }
            ui.set_effort_offer("".into());
        });
        let w = ui.as_weak();
        ui.on_pick_speed(move |i| w.unwrap().set_speed_index(i));
        let w = ui.as_weak();
        ui.on_take_offer(move || {
            let ui = w.unwrap();
            let offer = ui.get_effort_offer();
            if let Some(i) = (0..ui.get_efforts().row_count()).find(|&i| ui.get_efforts().row_data(i).is_some_and(|m| m.label == offer)) {
                ui.set_effort_index(i as i32);
                ui.set_effort(offer);
                ui.set_effort_offer("".into());
            }
        });
        let w = ui.as_weak();
        ui.on_pick_permission(move |i| {
            let ui = w.unwrap();
            ui.set_permission_index(i);
            if let Some(item) = ui.get_permissions().row_data(i as usize) {
                ui.set_permission(item.label);
            }
        });
    }

    // Streaming: 20 characters every 16 ms.
    let stream_timer = Rc::new(slint::Timer::default());
    let start_stream = {
        let w = ui.as_weak();
        let thread = thread.clone();
        let timer = stream_timer.clone();
        let m = metrics.clone();
        let loop_stream = args.loop_stream;
        Rc::new(move || {
            let ui = w.unwrap();
            thread.borrow_mut().start_reply();
            ui.set_busy(true);
            ui.set_following(true);
            m.borrow_mut().stream_started();
            let w = w.clone();
            let thread = thread.clone();
            let m = m.clone();
            let t0 = Instant::now();
            // The timer stops itself once the reply is whole.
            let this_timer = Rc::downgrade(&timer);
            timer.start(slint::TimerMode::Repeated, Duration::from_millis(16), move || {
                let Some(ui) = w.upgrade() else { return };
                let more = thread.borrow_mut().step();
                let streamed = thread.borrow().streamed;
                let words = thread::REPLY[..streamed].split_whitespace().count();
                ui.set_stream_status(format!("{words} words").into());
                if !more {
                    if let Some(t) = this_timer.upgrade() {
                        t.stop();
                    }
                    ui.set_busy(false);
                    ui.set_stream_status(format!("{words} words in {:.1} s", t0.elapsed().as_secs_f32()).into());
                    m.borrow_mut().stream_ended(&ui);
                    if loop_stream {
                        let w = w.clone();
                        slint::Timer::single_shot(Duration::from_millis(500), move || {
                            if let Some(ui) = w.upgrade() {
                                ui.invoke_send();
                            }
                        });
                    }
                }
            });
        })
    };
    {
        let w = ui.as_weak();
        let start = start_stream.clone();
        let timer = stream_timer.clone();
        let thread = thread.clone();
        ui.on_send(move || {
            let ui = w.unwrap();
            if ui.get_busy() {
                timer.stop();
                ui.set_busy(false);
                thread.borrow_mut().finish();
                return;
            }
            if ui.get_composer_text().is_empty() {
                return;
            }
            start();
        });
    }
    {
        let thread = thread.clone();
        ui.on_toggle_activity(move |i| thread.borrow_mut().toggle(i as usize));
    }
    {
        let w = ui.as_weak();
        let thread = thread.clone();
        ui.on_copy_row(move |i| {
            let ui = w.unwrap();
            if let Some(text) = thread.borrow().copy_text(i as usize) {
                ui.invoke_copy_text(text.into());
                ui.set_copied_row(i);
                let w = w.clone();
                slint::Timer::single_shot(Duration::from_millis(1600), move || {
                    if let Some(ui) = w.upgrade() {
                        ui.set_copied_row(-1);
                    }
                });
            }
        });
    }
    ui.on_link(|url| eprintln!("event=link-pressed scheme={}", url.split(':').next().unwrap_or("")));
    ui.on_jump_to_latest(|| {});

    // The terminal.
    let term = match terminal::start(&ui, !args.light) {
        Ok(t) => Some(t),
        Err(e) => {
            eprintln!("event=terminal-failed error={e}");
            None
        }
    };
    if let Some(term) = term.clone() {
        let t = term.clone();
        ui.on_term_key(move |e| t.borrow_mut().input(&e.text, e.modifiers.control, e.modifiers.alt, e.modifiers.shift));
        let t = term.clone();
        ui.on_term_resized(move |w, h, cw, ch| t.borrow_mut().resize(w, h, cw, ch));
        let t = term.clone();
        ui.on_term_pointer(move |k, c, r| t.borrow_mut().pointer(k, c, r));
        let t = term.clone();
        ui.on_term_wheel(move |n| t.borrow_mut().scroll(n));
        let t = term.clone();
        let w = ui.as_weak();
        ui.on_term_copy(move || {
            if let Some(text) = t.borrow().selection_text() {
                w.unwrap().invoke_copy_text(text.into());
            }
        });
    }

    // The web pane.
    let web = webpane::start();
    {
        let state = web.state.clone();
        ui.on_web_key(move |text, shift, _control| webpane::key(&state, &text, shift));
        let state = web.state.clone();
        ui.on_web_focus_changed(move |focused, _back| {
            let mut s = state.lock().unwrap();
            s.focused = focused;
            if focused && s.page_focus == 0 {
                s.page_focus = 1;
            }
            s.version += 1;
        });
        let state = web.state.clone();
        let w = ui.as_weak();
        ui.on_web_resized(move |width, height| {
            let mut s = state.lock().unwrap();
            s.width = width.max(1.0) as u32;
            s.height = height.max(1.0) as u32;
            s.scale = w.upgrade().map(|ui| ui.window().scale_factor()).unwrap_or(1.0);
            s.version += 1;
        });
        let state = web.state.clone();
        ui.on_web_pointer(move |x, y, _| {
            let mut s = state.lock().unwrap();
            // The page's own hit test for its field and button.
            s.page_focus = if y > 270.0 && y < 320.0 { 1 } else if y >= 320.0 && y < 360.0 && x < 130.0 { 2 } else { s.page_focus };
            s.version += 1;
        });
        ui.set_web_title("Lantern shelf preview".into());
    }
    let web_frames = web.frames;
    let web_timer = slint::Timer::default();
    let image_frames = args.web_surface.is_empty() || args.web_surface == "image";
    let reduced_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(ui.global::<Motion>().get_reduced()));
    #[cfg(windows)]
    let _surface_timer = winsurface::start(&ui, winsurface::mode_from(&args.web_surface), reduced_flag.clone());
    {
        let w = ui.as_weak();
        let m = metrics.clone();
        web_timer.start(slint::TimerMode::Repeated, Duration::from_millis(8), move || {
            let mut latest = None;
            while let Ok(f) = web_frames.try_recv() {
                latest = Some(f);
            }
            if !image_frames {
                return;
            }
            if let (Some(f), Some(ui)) = (latest, w.upgrade()) {
                m.borrow_mut().web_frame(f.rendered_in);
                ui.set_web_frame(slint::Image::from_rgba8(f.pixels));
            }
        });
    }
    {
        let state = web.state.clone();
        let reduced = ui.global::<Motion>().get_reduced();
        state.lock().unwrap().reduced_motion = reduced;
    }
    let web_state = web.state.clone();

    // The window.
    {
        let w = ui.as_weak();
        let thread = thread.clone();
        let term = term.clone();
        let web_state = web_state.clone();
        ui.on_toggle_theme(move || {
            let ui = w.unwrap();
            let t = ui.global::<Theme>();
            t.set_dark(!t.get_dark());
            thread.borrow_mut().recolor(code_colors(&ui));
            if let Some(term) = &term {
                term.borrow_mut().set_dark(t.get_dark());
            }
            web_state.lock().unwrap().version += 1;
        });
    }
    {
        let w = ui.as_weak();
        ui.on_drag_window(move || {
            let ui = w.unwrap();
            let _ = ui.window().with_winit_window(|win| {
                let _ = win.drag_window();
            });
        });
        let w = ui.as_weak();
        ui.on_minimise(move || w.unwrap().window().set_minimized(true));
        let w = ui.as_weak();
        ui.on_maximise(move || {
            let ui = w.unwrap();
            let max = ui.window().is_maximized();
            ui.window().set_maximized(!max);
        });
        ui.on_close_window(|| {
            let _ = slint::quit_event_loop();
        });
    }
    {
        // Reduced motion reaches the page too.
        let web_state = web_state.clone();
        let w = ui.as_weak();
        let reduced_flag = reduced_flag.clone();
        motion::on_change(move |reduced| {
            reduced_flag.store(reduced, std::sync::atomic::Ordering::Relaxed);
            let mut s = web_state.lock().unwrap();
            s.reduced_motion = reduced;
            s.version += 1;
            if let Some(ui) = w.upgrade() {
                ui.global::<Motion>().set_reduced(reduced);
            }
        });
    }

    metrics::install(&ui, metrics.clone());
    {
        // Measure the pills once the window has a size, and start the stream when asked to.
        let w = ui.as_weak();
        let pills = pills.clone();
        let start = start_stream.clone();
        let stream = args.stream && !args.finished;
        let focus = !args.no_focus;
        let scroll_up = args.scroll_up_after;
        slint::Timer::single_shot(Duration::from_millis(300), move || {
            if let Some(ui) = w.upgrade() {
                composer::measure(&ui, &pills.borrow());
                // A thread opens with the composer ready to type in, as Sotto's does.
                if focus {
                    ui.invoke_focus_composer();
                    let end = ui.get_composer_text().len() as i32;
                    ui.invoke_place_cursor(end, end);
                }
            }
        });
        if stream {
            slint::Timer::single_shot(Duration::from_millis(1500), move || start());
        }
        if let Some(ms) = scroll_up {
            let w = ui.as_weak();
            slint::Timer::single_shot(Duration::from_millis(1500 + ms), move || {
                if let Some(ui) = w.upgrade() {
                    ui.set_following(false);
                    ui.invoke_scroll_transcript_by(600.0);
                }
            });
        }
    }
    let _keep = (stream_timer, web_timer, term);
    ui.run().expect("run the window");
    motion::stop();
}
