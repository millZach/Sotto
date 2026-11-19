//! The plan's actual shape: CEF in a helper process the window starts when a web pane shows and ends when the last
//! one closes, since CEF cannot start twice in one process. Frames cross as dmabuf descriptors over a socket pair
//! (see wire.rs); input crosses the other way. The window process never initializes CEF.

use crate::cefapp::{self, SpikeClient, on_ui};
use crate::embed::{Shared, apply_to_host};
use crate::hub::hub;
use crate::wire::{self, Msg};
use cef::*;
use std::os::fd::RawFd;
use std::os::unix::process::CommandExt;
use std::process::ExitCode;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub struct Handle(pub Arc<Shared>);

static CHILDREN: Mutex<Vec<(std::process::Child, RawFd)>> = Mutex::new(Vec::new());

fn tree(pid: u32) -> Vec<u32> {
    let mut out = Vec::new();
    let mut todo = vec![pid];
    while let Some(p) = todo.pop() {
        out.push(p);
        if let Ok(tasks) = std::fs::read_dir(format!("/proc/{p}/task")) {
            for t in tasks.flatten() {
                if let Ok(c) = std::fs::read_to_string(t.path().join("children")) {
                    todo.extend(c.split_whitespace().filter_map(|x| x.parse::<u32>().ok()));
                }
            }
        }
    }
    out
}
fn pss_kb(pids: &[u32]) -> u64 {
    pids.iter().map(|p| std::fs::read_to_string(format!("/proc/{p}/smaps_rollup")).ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("Pss:")).and_then(|l| l.split_whitespace().nth(1)?.parse::<u64>().ok())).unwrap_or(0)).sum()
}
fn alive(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat")).map(|s| !s.contains(") Z ")).unwrap_or(false)
}

fn color(raw: u32) -> ColorType {
    ColorType::from(if raw == 0 { sys::cef_color_type_t::CEF_COLOR_TYPE_RGBA_8888 } else { sys::cef_color_type_t::CEF_COLOR_TYPE_BGRA_8888 })
}

/// The window side: start the helper, show its frames, end it; WP_REMOTE_CYCLES times, holding WP_REMOTE_HOLD_S.
pub fn start_controller(handle: Handle, window: Arc<winit::window::Window>) {
    let shared = handle.0;
    std::thread::spawn(move || {
        let cycles: usize = std::env::var("WP_REMOTE_CYCLES").ok().and_then(|v| v.parse().ok()).unwrap_or(1);
        let hold: u64 = std::env::var("WP_REMOTE_HOLD_S").ok().and_then(|v| v.parse().ok()).unwrap_or(20);
        let run_dir = std::env::var("WP_RUN_DIR").unwrap_or(".".into());
        let me = std::process::id();
        let before = pss_kb(&[me]);
        for cycle in 0..cycles {
            let (ours, theirs) = wire::pair();
            let spawned = Instant::now();
            let dir = format!("{run_dir}/helper{cycle}");
            std::fs::create_dir_all(&dir).ok();
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command.env("WP_MODE", "helper").env("WP_SOCK_FD", "3").env("WP_RUN_DIR", &dir).env("WP_CACHE", format!("{dir}/cache"))
                .stdout(std::fs::File::create(format!("{dir}/stdout.log")).unwrap()).stderr(std::fs::File::create(format!("{dir}/stderr.log")).unwrap());
            unsafe { command.pre_exec(move || { if libc::dup2(theirs, 3) < 0 { return Err(std::io::Error::last_os_error()) } Ok(()) }); }
            let child = command.spawn().expect("helper");
            unsafe { libc::close(theirs); }
            let pid = child.id();
            *shared.remote.lock().unwrap() = Some(ours);
            let (vw, vh) = *shared.view.lock().unwrap();
            wire::send(ours, &Msg::new(wire::RESIZE, &[vw as u32, vh as u32]), None);
            CHILDREN.lock().unwrap().push((child, ours));

            // Frames: import each, ack it, close its descriptor.
            let reader_shared = shared.clone();
            let first = Arc::new(Mutex::new(None::<f64>));
            let first_r = first.clone();
            let frames = Arc::new(AtomicU32::new(0));
            let frames_r = frames.clone();
            let reader = std::thread::spawn(move || {
                let s = reader_shared;
                while let Some((m, fd)) = wire::recv(ours) {
                    if m.kind() != wire::FRAME { if let Some(fd) = fd { unsafe { libc::close(fd); } } continue }
                    let Some(fd) = fd else { continue };
                    let start = Instant::now();
                    let mut info = AcceleratedPaintInfo::default();
                    info.planes[0] = AcceleratedPaintNativePixmapPlaneInfo { stride: m.0[3], offset: m.u64_at(4), size: m.u64_at(10), fd };
                    info.plane_count = 1;
                    info.modifier = m.u64_at(6);
                    info.format = color(m.0[8]);
                    info.extra.coded_size = Size { width: m.i(1), height: m.i(2) };
                    let handle = cef::osr_texture_import::SharedTextureHandle::new(&info);
                    let imported = unsafe { handle.import_texture(&s.device, &s.queue) };
                    wire::send(ours, &Msg::new(wire::ACK, &[m.0[9]]), None);
                    unsafe { libc::close(fd); }
                    match imported {
                        Ok(texture) => {
                            let us = start.elapsed().as_micros() as u64;
                            let mut t = s.timings.lock().unwrap();
                            t.import_us.push(us);
                            if t.formats.is_empty() { t.formats.push(format!("remote accelerated {}x{} modifier={:#x}", texture.width(), texture.height(), m.u64_at(6))); }
                            drop(t);
                            *s.texture.lock().unwrap() = Some(texture);
                            if first_r.lock().unwrap().is_none() { *first_r.lock().unwrap() = Some(spawned.elapsed().as_secs_f64() * 1000.0); }
                            frames_r.fetch_add(1, Ordering::Relaxed);
                            s.frames.fetch_add(1, Ordering::Relaxed);
                            if let Some(p) = s.proxy.lock().unwrap().as_ref() { let _ = p.send_event(()); }
                        }
                        Err(e) => { let mut t = s.timings.lock().unwrap(); if t.errors.len() < 5 { t.errors.push(format!("{e}")); } }
                    }
                }
            });
            let deadline = Instant::now() + Duration::from_secs(20);
            while first.lock().unwrap().is_none() && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(2)); }
            let first_ms = *first.lock().unwrap();
            std::thread::sleep(Duration::from_secs(if cycles == 1 { hold } else { 3 }));
            let pids = tree(pid);
            let helper_pss = pss_kb(&pids);
            let window_pss = pss_kb(&[me]);
            let frames_shown = frames.load(Ordering::Relaxed);

            // The last pane closes: drop the socket; the helper sees it end, closes its browser and exits.
            let stop = Instant::now();
            *shared.remote.lock().unwrap() = None;
            unsafe { libc::shutdown(ours, libc::SHUT_RDWR); }
            let mut child = { let mut c = CHILDREN.lock().unwrap(); let i = c.iter().position(|(ch, _)| ch.id() == pid).unwrap(); c.remove(i).0 };
            let mut exit = None;
            while stop.elapsed() < Duration::from_secs(10) { if let Ok(Some(status)) = child.try_wait() { exit = Some(status); break } std::thread::sleep(Duration::from_millis(5)); }
            if exit.is_none() { let _ = child.kill(); exit = child.wait().ok(); }
            let stop_ms = stop.elapsed().as_secs_f64() * 1000.0;
            let _ = reader.join();
            unsafe { libc::close(ours); }
            *shared.texture.lock().unwrap() = None;
            window.request_redraw();
            std::thread::sleep(Duration::from_secs(2));
            let left: Vec<u32> = pids.iter().copied().filter(|p| alive(*p)).collect();
            let row = serde_json::json!({
                "cycle": cycle, "first_frame_in_window_ms": first_ms, "frames": frames_shown,
                "helper_processes": pids.len(), "helper_pss_mb": helper_pss / 1024, "window_pss_mb_while_showing": window_pss / 1024,
                "stop_ms": stop_ms, "exit": exit.map(|e| format!("{e}")), "helper_processes_left": left,
                "window_pss_mb_before_first": before / 1024, "window_pss_mb_after_stop": pss_kb(&[me]) / 1024,
            });
            eprintln!("[remote] {row}");
            shared.timings.lock().unwrap().cycles.push(row);
            std::thread::sleep(Duration::from_secs(1));
        }
        hub().note("remote cycles done");
    });
}

pub fn stop_all() {
    for (mut child, sock) in CHILDREN.lock().unwrap().drain(..) {
        unsafe { libc::shutdown(sock, libc::SHUT_RDWR); }
        let _ = child.wait();
    }
}

// ------------------------------------------------------------------ the helper process

static HELPER_VIEW: Mutex<(i32, i32)> = Mutex::new((1000, 700));
static ACKED: Mutex<u32> = Mutex::new(0);
static ACK_CV: Condvar = Condvar::new();
static SEQ: AtomicU32 = AtomicU32::new(0);
static SOCK: AtomicU32 = AtomicU32::new(u32::MAX);
static ROUND_TRIPS: Mutex<Vec<u64>> = Mutex::new(Vec::new());

wrap_render_handler! {
    struct HelperRender {}
    impl RenderHandler {
        fn view_rect(&self, _browser: Option<&mut Browser>, rect: Option<&mut Rect>) {
            if let Some(rect) = rect { let (w, h) = *HELPER_VIEW.lock().unwrap(); rect.x = 0; rect.y = 0; rect.width = w.max(1); rect.height = h.max(1); }
        }
        fn screen_info(&self, _browser: Option<&mut Browser>, info: Option<&mut ScreenInfo>) -> ::std::os::raw::c_int {
            if let Some(info) = info { info.device_scale_factor = 1.0; return 1 } 0
        }
        fn on_accelerated_paint(&self, _browser: Option<&mut Browser>, type_: PaintElementType, _dirty: Option<&[Rect]>, info: Option<&AcceleratedPaintInfo>) {
            let Some(info) = info else { return };
            if type_ != PaintElementType::default() || info.plane_count != 1 { return }
            let sock = SOCK.load(Ordering::SeqCst);
            if sock == u32::MAX { return }
            let seq = SEQ.fetch_add(1, Ordering::SeqCst) + 1;
            let p = &info.planes[0];
            let (w, h) = (info.extra.coded_size.width as u32, info.extra.coded_size.height as u32);
            let format = if *info.format.as_ref() == sys::cef_color_type_t::CEF_COLOR_TYPE_RGBA_8888 { 0 } else { 1 };
            let m = Msg::new(wire::FRAME, &[w, h, p.stride, p.offset as u32, (p.offset >> 32) as u32, info.modifier as u32, (info.modifier >> 32) as u32, format, seq, p.size as u32, (p.size >> 32) as u32]);
            let start = Instant::now();
            if !wire::send(sock as RawFd, &m, Some(p.fd)) { return }
            // CEF takes the buffer back when this returns, so wait until the window has copied it.
            let mut acked = ACKED.lock().unwrap();
            let deadline = Instant::now() + Duration::from_millis(250);
            while *acked < seq && Instant::now() < deadline { acked = ACK_CV.wait_timeout(acked, Duration::from_millis(10)).unwrap().0; }
            drop(acked);
            let mut rt = ROUND_TRIPS.lock().unwrap();
            if rt.len() < 100_000 { rt.push(start.elapsed().as_micros() as u64); }
        }
    }
}

pub fn run_helper(args: &cef::args::Args, app: &mut cef::App) -> ExitCode {
    let sock: RawFd = std::env::var("WP_SOCK_FD").ok().and_then(|v| v.parse().ok()).expect("WP_SOCK_FD");
    SOCK.store(sock as u32, Ordering::SeqCst);
    let config = cefapp::config();
    let run_dir = std::env::var("WP_RUN_DIR").unwrap_or(".".into());
    let settings = Settings {
        windowless_rendering_enabled: 1,
        root_cache_path: CefString::from(config.root_cache.as_str()),
        log_file: CefString::from(format!("{run_dir}/cef.log").as_str()),
        log_severity: LogSeverity::from(sys::cef_log_severity_t::LOGSEVERITY_WARNING),
        ..Default::default()
    };
    let started = Instant::now();
    if initialize(Some(args.as_main_args()), Some(&settings), Some(app), std::ptr::null_mut()) != 1 { return ExitCode::from(2) }
    std::thread::spawn(move || {
        hub().wait_ready(Duration::from_secs(20));
        let url = std::env::var("WP_URL").unwrap_or_else(|_| "http://127.0.0.1:8765/anim.html".into());
        on_ui(move || {
            let window_info = WindowInfo { windowless_rendering_enabled: 1, shared_texture_enabled: 1, ..Default::default() };
            let settings = BrowserSettings { windowless_frame_rate: 60, ..Default::default() };
            let mut client = SpikeClient::new(Some(HelperRender::new()));
            browser_host_create_browser(Some(&window_info), Some(&mut client), Some(&CefString::from(url.as_str())), Some(&settings), None, None);
        });
        let host = || cefapp::LAST_BROWSER.lock().unwrap().as_ref().and_then(|b| b.0.host());
        while let Some((m, fd)) = wire::recv(sock) {
            if let Some(fd) = fd { unsafe { libc::close(fd); } }
            match m.kind() {
                wire::ACK => { *ACKED.lock().unwrap() = m.0[1]; ACK_CV.notify_all(); }
                wire::RESIZE => { *HELPER_VIEW.lock().unwrap() = (m.i(1), m.i(2)); if let Some(h) = host() { h.was_resized(); } }
                _ => { if let Some(h) = host() { apply_to_host(&h, &m, &HELPER_VIEW); } }
            }
        }
        // The window closed its last pane.
        SOCK.store(u32::MAX, Ordering::SeqCst);
        *ACKED.lock().unwrap() = u32::MAX; ACK_CV.notify_all();
        if let Some(h) = host() { h.close_browser(1); }
        let deadline = Instant::now() + Duration::from_secs(5);
        while !hub().closed.load(Ordering::SeqCst) && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(10)); }
        on_ui(|| quit_message_loop());
    });
    run_message_loop();
    let mut rt = ROUND_TRIPS.lock().unwrap().clone();
    rt.sort();
    let pct = |p: f64| if rt.is_empty() { 0 } else { rt[((rt.len() - 1) as f64 * p) as usize] };
    let out = serde_json::json!({ "frames_sent": rt.len(), "round_trip_us": { "p50": pct(0.5), "p95": pct(0.95), "max": rt.last().copied().unwrap_or(0) }, "alive_ms": started.elapsed().as_millis() as u64, "page_console": hub().console.lock().unwrap().iter().filter(|m| m.starts_with("EVT")).cloned().collect::<Vec<_>>() });
    std::fs::write(format!("{run_dir}/helper.json"), out.to_string()).ok();
    *cefapp::LAST_BROWSER.lock().unwrap() = None;
    shutdown();
    ExitCode::SUCCESS
}
