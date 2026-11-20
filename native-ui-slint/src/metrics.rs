//! Measurements, taken inside the app so the method is the same on every machine.
//!
//! - Frame time: Slint's rendering notifier. Each frame has a start (BeforeRendering) and an end
//!   (AfterRendering, before the buffers are swapped). "Frame interval" is the time between the ends
//!   of consecutive frames while the reply streams; "render time" is end minus start.
//! - Typing latency: from winit delivering a key press to the end of the first frame rendered after
//!   the composer's text changed. Keys are injected from outside (wtype) during the stream.
//! - Launch: from SOTTO_LAUNCH_T0 (nanoseconds since the epoch, set by the harness just before it
//!   starts the process) to the end of the first frame, which already holds the 200 messages.
//! - Memory: /proc/self/smaps_rollup (PSS and RSS) five seconds after the stream ends. The shell in
//!   the terminal is a separate process and is not counted.

use crate::{AppWindow, Args};
use slint::ComponentHandle;
use slint::winit_030::{WinitWindowAccessor, winit};
use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub struct Metrics {
    launch_t0: Option<u128>,
    args: Args,
    backend: String,
    first_frame: Option<Duration>,
    created: Instant,
    frames: Vec<(Instant, Instant)>,
    before: Option<Instant>,
    streaming: bool,
    stream_start: Option<Instant>,
    stream_end: Option<Instant>,
    stream_frames: Vec<(Instant, Instant)>,
    keys: Vec<Instant>,
    text_changed: bool,
    typing: Vec<f64>,
    web_frames: Vec<Duration>,
    done: bool,
}

pub fn launch_t0() -> Option<u128> {
    std::env::var("SOTTO_LAUNCH_T0").ok()?.parse().ok()
}

/// The renderer this build asks for on Windows when SLINT_BACKEND is not set. Slint's own default there
/// is Skia over wgpu, which on this laptop picks a Vulkan adapter that Skia cannot use and falls back
/// to Skia's software renderer (docs/research/2026-11-19-native-ui-bake-off-slint-windows.md).
#[cfg(windows)]
pub const WINDOWS_RENDERER: &str = "skia-opengl";

pub fn backend_name() -> String {
    if let Ok(b) = std::env::var("SLINT_BACKEND") {
        return b;
    }
    #[cfg(windows)]
    return format!("winit-{WINDOWS_RENDERER} (this build's Windows default)");
    #[cfg(not(windows))]
    "winit (default renderer)".into()
}

impl Metrics {
    pub fn new(launch_t0: Option<u128>, args: Args, backend: String) -> Rc<RefCell<Self>> {
        Rc::new(RefCell::new(Self {
            launch_t0,
            args,
            backend,
            first_frame: None,
            created: Instant::now(),
            frames: Vec::new(),
            before: None,
            streaming: false,
            stream_start: None,
            stream_end: None,
            stream_frames: Vec::new(),
            keys: Vec::new(),
            text_changed: false,
            typing: Vec::new(),
            web_frames: Vec::new(),
            done: false,
        }))
    }

    pub fn text_changed(&mut self) {
        self.text_changed = true;
    }

    pub fn stream_started(&mut self) {
        self.streaming = true;
        self.stream_start = Some(Instant::now());
        self.stream_frames.clear();
    }

    pub fn web_frame(&mut self, d: Duration) {
        self.web_frames.push(d);
    }

    pub fn stream_ended(&mut self, ui: &AppWindow) {
        if !self.streaming {
            return;
        }
        self.streaming = false;
        self.stream_end = Some(Instant::now());
        eprintln!("event=stream-ended frames={}", self.stream_frames.len());
        if self.args.bench {
            let w = ui.as_weak();
            slint::Timer::single_shot(Duration::from_secs(5), move || {
                if let Some(ui) = w.upgrade() {
                    BENCH.with(|m| {
                        if let Some(m) = m.borrow().as_ref() {
                            m.borrow_mut().report(&ui);
                        }
                    });
                }
            });
        }
    }

    fn frame(&mut self, before: Instant, after: Instant, ui: &AppWindow) {
        if self.first_frame.is_none() {
            let since_created = after - self.created;
            let since_launch = self.launch_t0.map(|t0| {
                let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
                Duration::from_nanos(now.saturating_sub(t0) as u64)
            });
            self.first_frame = Some(since_launch.unwrap_or(since_created));
            let scale = ui.window().scale_factor();
            let size = ui.window().size();
            eprintln!(
                "event=first-frame launch_ms={:.1} since_window_created_ms={:.1} scale={scale} physical={}x{} wayland={}",
                since_launch.map(|d| d.as_secs_f64() * 1000.0).unwrap_or(f64::NAN),
                since_created.as_secs_f64() * 1000.0,
                size.width,
                size.height,
                is_wayland(ui),
            );
            if self.args.launch_only {
                let _ = slint::quit_event_loop();
            }
        }
        self.frames.push((before, after));
        if self.streaming {
            self.stream_frames.push((before, after));
        }
        if self.text_changed {
            self.text_changed = false;
            for k in self.keys.drain(..) {
                self.typing.push((after - k).as_secs_f64() * 1000.0);
            }
        }
    }

    fn report(&mut self, ui: &AppWindow) {
        if self.done {
            return;
        }
        self.done = true;
        let ms = |d: Duration| d.as_secs_f64() * 1000.0;
        let intervals: Vec<f64> = self.stream_frames.windows(2).map(|w| ms(w[1].1 - w[0].1)).collect();
        let renders: Vec<f64> = self.stream_frames.iter().map(|(b, a)| ms(*a - *b)).collect();
        let web: Vec<f64> = self.web_frames.iter().map(|d| ms(*d)).collect();
        let (pss, rss) = memory();
        let stream_ms = match (self.stream_start, self.stream_end) {
            (Some(a), Some(b)) => ms(b - a),
            _ => f64::NAN,
        };
        let size = ui.window().size();
        let json = format!(
            "{{\n  \"toolkit\": \"slint 1.19.0\",\n  \"backend\": \"{}\",\n  \"wayland\": {},\n  \"scale\": {},\n  \"physical_size\": [{}, {}],\n  \"launch_ms\": {:.1},\n  \"stream_ms\": {:.1},\n  \"stream_frames\": {},\n  \"frame_interval_ms\": {},\n  \"render_ms\": {},\n  \"typing_ms\": {},\n  \"web_page_paint_ms\": {},\n  \"memory_after_stream\": {{ \"pss_kib\": {}, \"rss_kib\": {} }}\n}}\n",
            self.backend,
            is_wayland(ui),
            ui.window().scale_factor(),
            size.width,
            size.height,
            self.first_frame.map(ms).unwrap_or(f64::NAN),
            stream_ms,
            self.stream_frames.len(),
            stats(&intervals),
            stats(&renders),
            stats(&self.typing),
            stats(&web),
            pss,
            rss,
        );
        match &self.args.out {
            Some(path) => {
                std::fs::write(path, &json).expect("write the bench result");
                let list = |v: &[f64]| v.iter().map(|x| format!("{x:.3}")).collect::<Vec<_>>().join(",");
                let raw = format!("{{\"frame_interval_ms\":[{}],\"render_ms\":[{}],\"typing_ms\":[{}]}}\n", list(&intervals), list(&renders), list(&self.typing));
                std::fs::write(format!("{path}.raw.json"), raw).expect("write the raw figures");
            }
            None => print!("{json}"),
        }
        eprintln!("event=bench-written");
        if self.args.exit {
            let _ = slint::quit_event_loop();
        }
    }
}

fn stats(v: &[f64]) -> String {
    if v.is_empty() {
        return "null".into();
    }
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p = |q: f64| s[((s.len() as f64 - 1.0) * q).round() as usize];
    let mean = s.iter().sum::<f64>() / s.len() as f64;
    format!(
        "{{ \"n\": {}, \"median\": {:.2}, \"p95\": {:.2}, \"p99\": {:.2}, \"max\": {:.2}, \"mean\": {:.2}, \"over_16_7\": {}, \"over_33_3\": {} }}",
        s.len(),
        p(0.5),
        p(0.95),
        p(0.99),
        s[s.len() - 1],
        mean,
        s.iter().filter(|x| **x > 16.7).count(),
        s.iter().filter(|x| **x > 33.3).count()
    )
}

fn memory() -> (u64, u64) {
    let text = std::fs::read_to_string("/proc/self/smaps_rollup").unwrap_or_default();
    let field = |name: &str| {
        text.lines()
            .find(|l| l.starts_with(name))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|v| v.parse().ok())
            .unwrap_or(0)
    };
    (field("Pss:"), field("Rss:"))
}

fn is_wayland(ui: &AppWindow) -> bool {
    use slint::winit_030::winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
    ui.window()
        .with_winit_window(|w| matches!(w.window_handle().map(|h| h.as_raw()), Ok(RawWindowHandle::Wayland(_))))
        .unwrap_or(false)
}

thread_local! {
    static BENCH: RefCell<Option<Rc<RefCell<Metrics>>>> = const { RefCell::new(None) };
}

pub fn install(ui: &AppWindow, m: Rc<RefCell<Metrics>>) {
    BENCH.with(|b| *b.borrow_mut() = Some(m.clone()));
    let w = ui.as_weak();
    let mm = m.clone();
    ui.window()
        .set_rendering_notifier(move |state, api| {
            #[cfg(windows)]
            crate::winsurface::on_render(&state, api);
            #[cfg(not(windows))]
            let _ = api;
            match state {
            slint::RenderingState::BeforeRendering => mm.borrow_mut().before = Some(Instant::now()),
            slint::RenderingState::AfterRendering => {
                let after = Instant::now();
                let before = mm.borrow_mut().before.take().unwrap_or(after);
                if let Some(ui) = w.upgrade() {
                    mm.borrow_mut().frame(before, after, &ui);
                }
            }
            _ => {}
        }})
        .unwrap_or_else(|e| eprintln!("event=no-rendering-notifier error={e:?}"));
    let mk = m.clone();
    let trace = std::env::var_os("SOTTO_TRACE_KEYS").is_some();
    ui.window().on_winit_window_event(move |_, event| {
        if trace {
            match event {
                winit::event::WindowEvent::KeyboardInput { event, .. } => eprintln!("event=key state={:?} key={:?}", event.state, event.logical_key),
                winit::event::WindowEvent::ModifiersChanged(m) => eprintln!("event=modifiers state={:?}", m.state()),
                winit::event::WindowEvent::Ime(ime) => eprintln!("event=ime kind={}", match ime { winit::event::Ime::Enabled => "enabled", winit::event::Ime::Preedit(..) => "preedit", winit::event::Ime::Commit(..) => "commit", winit::event::Ime::Disabled => "disabled" }),
                _ => {}
            }
        }
        if let winit::event::WindowEvent::KeyboardInput { event, .. } = event {
            if event.state == winit::event::ElementState::Pressed {
                mk.borrow_mut().keys.push(Instant::now());
            }
        }
        slint::winit_030::EventResult::Propagate
    });
}
