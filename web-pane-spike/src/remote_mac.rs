//! macOS: the helper link. CEF lives in a helper process the window starts when a web pane shows and ends when the
//! last one closes (CEF starts once per process). The window process never initializes CEF.
//!
//! Frames go up as Mach messages: the helper turns each frame's IOSurface into a Mach send right
//! (`IOSurfaceCreateMachPort`) and moves it in a port descriptor, with the 64-byte record inline. The window looks the
//! surface up (`IOSurfaceLookupFromMachPort`), copies it into its own Metal texture through cef-rs's importer, and
//! acknowledges, so the helper can hand the surface back to CEF. Acknowledgements and input go over a Unix stream
//! socket pair as the same 64-byte records as Linux (wire.rs).
//!
//! The Mach channel is set up through launchd: the window checks in a per-process service name
//! (`bootstrap_check_in`, as Chromium's own rendezvous server does) and the helper looks it up.

use crate::cefapp::{self, SpikeClient, on_ui};
use crate::embed::{Shared, apply_to_host};
use crate::hub::hub;
use crate::wire::{self, Msg};
use cef::*;
use mach2::bootstrap::{bootstrap_check_in, bootstrap_look_up, bootstrap_port, bootstrap_register};
use mach2::kern_return::KERN_SUCCESS;
use mach2::mach_port::{mach_port_allocate, mach_port_deallocate, mach_port_insert_right, mach_port_mod_refs};
use mach2::message::*;
use mach2::port::{MACH_PORT_NULL, MACH_PORT_RIGHT_RECEIVE, mach_port_t};
use mach2::traps::mach_task_self;
use std::ffi::{CString, c_void};
use std::os::fd::RawFd;
use std::os::unix::process::CommandExt;
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

#[link(name = "IOSurface", kind = "framework")]
unsafe extern "C" {
    fn IOSurfaceCreateMachPort(buffer: *mut c_void) -> mach_port_t;
    fn IOSurfaceLookupFromMachPort(port: mach_port_t) -> *mut c_void;
    fn IOSurfaceGetWidth(buffer: *mut c_void) -> usize;
    fn IOSurfaceGetHeight(buffer: *mut c_void) -> usize;
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(cf: *const c_void);
}

/// One frame: the surface's send right in a port descriptor, then the record.
#[repr(C)]
#[derive(Clone, Copy)]
struct FrameMsg {
    header: mach_msg_header_t,
    body: mach_msg_body_t,
    surface: mach_msg_port_descriptor_t,
    record: [u32; 16],
}
/// Receive buffer: the message and room for the kernel's trailer.
#[repr(C)]
struct FrameBuf {
    msg: FrameMsg,
    trailer: [u8; 128],
}

fn color(raw: u32) -> ColorType {
    ColorType::from(if raw == 0 { sys::cef_color_type_t::CEF_COLOR_TYPE_RGBA_8888 } else { sys::cef_color_type_t::CEF_COLOR_TYPE_BGRA_8888 })
}

// ------------------------------------------------------------------ processes, from outside

/// The process and its descendants, from `ps` (a spike; libproc would do in a product).
pub fn tree(root: i32) -> Vec<i32> {
    let out = std::process::Command::new("/bin/ps").args(["-A", "-o", "pid=,ppid="]).output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
    let pairs: Vec<(i32, i32)> = out.lines().filter_map(|l| { let mut it = l.split_whitespace(); Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?)) }).collect();
    let mut found = vec![root];
    let mut i = 0;
    while i < found.len() {
        let p = found[i];
        found.extend(pairs.iter().filter(|(_, pp)| *pp == p).map(|(c, _)| *c));
        i += 1;
    }
    found
}

/// Physical footprint (what Activity Monitor calls Memory) summed over the processes, in KB.
pub fn footprint_kb(pids: &[i32]) -> u64 {
    pids.iter().map(|&p| {
        let mut info: libc::rusage_info_v2 = unsafe { std::mem::zeroed() };
        let r = unsafe { libc::proc_pid_rusage(p, libc::RUSAGE_INFO_V2, &mut info as *mut libc::rusage_info_v2 as *mut libc::rusage_info_t) };
        if r == 0 { info.ri_phys_footprint / 1024 } else { 0 }
    }).sum()
}

pub fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

/// Every process whose command line names this bundle's executables, except this one.
pub fn ours_left() -> Vec<String> {
    let me = std::process::id() as i32;
    let exe = std::env::current_exe().ok().and_then(|p| p.parent()?.parent().map(|c| c.to_string_lossy().into_owned())).unwrap_or_default();
    let out = std::process::Command::new("/bin/ps").args(["-A", "-o", "pid=,command="]).output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
    out.lines().filter(|l| !exe.is_empty() && l.contains(&exe)).filter(|l| l.split_whitespace().next().and_then(|p| p.parse::<i32>().ok()) != Some(me)).map(|l| l.trim().chars().take(160).collect()).collect()
}

// ------------------------------------------------------------------ the window side

static SOCK: Mutex<Option<RawFd>> = Mutex::new(None);
static CHILDREN: Mutex<Vec<std::process::Child>> = Mutex::new(Vec::new());

/// One input record to the helper; None when no helper is up (the caller falls back to an in-process browser).
pub fn send(m: &Msg) -> Option<bool> {
    let sock = (*SOCK.lock().unwrap())?;
    Some(wire::send(sock, m, None))
}

/// A Mach receive right other processes can find by `name`: checked in with launchd, or registered if that fails.
fn service(name: &str) -> Result<(mach_port_t, &'static str), String> {
    let cname = CString::new(name).unwrap();
    let mut port: mach_port_t = MACH_PORT_NULL;
    let kr = unsafe { bootstrap_check_in(bootstrap_port, cname.as_ptr(), &mut port) };
    if kr == KERN_SUCCESS { return Ok((port, "bootstrap_check_in")) }
    let check_in_error = kr;
    unsafe {
        let task = mach_task_self();
        let kr = mach_port_allocate(task, MACH_PORT_RIGHT_RECEIVE, &mut port);
        if kr != KERN_SUCCESS { return Err(format!("check_in {check_in_error:#x}; mach_port_allocate {kr:#x}")) }
        let kr = mach_port_insert_right(task, port, port, MACH_MSG_TYPE_MAKE_SEND);
        if kr != KERN_SUCCESS { return Err(format!("check_in {check_in_error:#x}; insert_right {kr:#x}")) }
        let kr = bootstrap_register(bootstrap_port, cname.as_ptr() as *mut _, port);
        if kr != KERN_SUCCESS { return Err(format!("check_in {check_in_error:#x}; bootstrap_register {kr:#x}")) }
    }
    Ok((port, "bootstrap_register (check_in failed)"))
}

/// The window side: start the helper, show its frames, end it; WP_REMOTE_CYCLES times, holding WP_REMOTE_HOLD_S.
pub fn start_controller(shared: Arc<Shared>, window: Arc<winit::window::Window>) {
    std::thread::spawn(move || {
        let cycles: usize = std::env::var("WP_REMOTE_CYCLES").ok().and_then(|v| v.parse().ok()).unwrap_or(1);
        let hold: u64 = std::env::var("WP_REMOTE_HOLD_S").ok().and_then(|v| v.parse().ok()).unwrap_or(20);
        let run_dir = std::env::var("WP_RUN_DIR").unwrap_or(".".into());
        let me = std::process::id() as i32;
        let before = footprint_kb(&[me]);
        for cycle in 0..cycles {
            let name = format!("org.sotto.webpane-spike.{me}.{cycle}");
            let (recv, how) = match service(&name) {
                Ok(found) => found,
                Err(e) => { hub().note(format!("no Mach service: {e}")); shared.timings.lock().unwrap().errors.push(format!("no Mach service: {e}")); break }
            };
            hub().note(format!("Mach service {name} by {how}"));
            let (ours, theirs) = wire::pair();
            let spawned = Instant::now();
            let dir = format!("{run_dir}/helper{cycle}");
            std::fs::create_dir_all(&dir).ok();
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command.env("WP_MODE", "helper").env("WP_SOCK_FD", "3").env("WP_MACH_NAME", &name).env("WP_RUN_DIR", &dir).env("WP_CACHE", format!("{dir}/cache"))
                .stdout(std::fs::File::create(format!("{dir}/stdout.log")).unwrap()).stderr(std::fs::File::create(format!("{dir}/stderr.log")).unwrap());
            unsafe { command.pre_exec(move || { if libc::dup2(theirs, 3) < 0 { return Err(std::io::Error::last_os_error()) } Ok(()) }); }
            let child = command.spawn().expect("helper");
            unsafe { libc::close(theirs); }
            let pid = child.id() as i32;
            *SOCK.lock().unwrap() = Some(ours);
            let (vw, vh) = *shared.view.lock().unwrap();
            wire::send(ours, &Msg::new(wire::RESIZE, &[vw as u32, vh as u32]), None);
            CHILDREN.lock().unwrap().push(child);

            // Frames: receive each Mach message, look the surface up, import it, ack, release it.
            let stop = Arc::new(AtomicBool::new(false));
            let stop_r = stop.clone();
            let reader_shared = shared.clone();
            let first = Arc::new(Mutex::new(None::<f64>));
            let first_r = first.clone();
            let frames = Arc::new(AtomicU32::new(0));
            let frames_r = frames.clone();
            let lookups = Arc::new(Mutex::new(Vec::<u64>::new()));
            let lookups_r = lookups.clone();
            let reader = std::thread::spawn(move || {
                let s = reader_shared;
                loop {
                    let mut buf: FrameBuf = unsafe { std::mem::zeroed() };
                    let kr = unsafe { mach_msg(&mut buf.msg.header, MACH_RCV_MSG | MACH_RCV_TIMEOUT, 0, std::mem::size_of::<FrameBuf>() as u32, recv, 250, MACH_PORT_NULL) };
                    if kr == MACH_RCV_TIMED_OUT { if stop_r.load(Ordering::SeqCst) { break } continue }
                    if kr != MACH_MSG_SUCCESS { let mut t = s.timings.lock().unwrap(); if t.errors.len() < 5 { t.errors.push(format!("mach_msg receive {kr:#x}")); } break }
                    if buf.msg.header.msgh_bits & MACH_MSGH_BITS_COMPLEX == 0 || buf.msg.body.msgh_descriptor_count != 1 { continue }
                    let m = Msg(buf.msg.record);
                    let port = buf.msg.surface.name;
                    let start = Instant::now();
                    let surface = unsafe { IOSurfaceLookupFromMachPort(port) };
                    let lookup_us = start.elapsed().as_micros() as u64;
                    unsafe { mach_port_deallocate(mach_task_self(), port); }
                    if surface.is_null() {
                        wire::send(ours, &Msg::new(wire::ACK, &[m.0[4]]), None);
                        let mut t = s.timings.lock().unwrap(); if t.errors.len() < 5 { t.errors.push("IOSurfaceLookupFromMachPort returned null".into()); }
                        continue;
                    }
                    let mut info = AcceleratedPaintInfo::default();
                    info.shared_texture_io_surface = surface;
                    info.format = color(m.0[3]);
                    info.extra.coded_size = Size { width: m.i(1), height: m.i(2) };
                    let handle = cef::osr_texture_import::SharedTextureHandle::new(&info);
                    let imported = unsafe { handle.import_texture(&s.device, &s.queue) };
                    wire::send(ours, &Msg::new(wire::ACK, &[m.0[4]]), None);
                    let (sw, sh) = unsafe { (IOSurfaceGetWidth(surface), IOSurfaceGetHeight(surface)) };
                    unsafe { CFRelease(surface as *const c_void); }
                    { let mut l = lookups_r.lock().unwrap(); if l.len() < 100_000 { l.push(lookup_us); } }
                    match imported {
                        Ok(texture) => {
                            let us = start.elapsed().as_micros() as u64;
                            let mut t = s.timings.lock().unwrap();
                            t.import_us.push(us);
                            if t.formats.is_empty() { t.formats.push(format!("remote accelerated {}x{} iosurface {sw}x{sh} over Mach", texture.width(), texture.height())); }
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
            let deadline = Instant::now() + Duration::from_secs(25);
            while first.lock().unwrap().is_none() && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(2)); }
            let first_ms = *first.lock().unwrap();
            std::thread::sleep(Duration::from_secs(if cycles == 1 { hold } else { 3 }));
            let pids = tree(pid);
            let helper_kb = footprint_kb(&pids);
            let window_kb = footprint_kb(&[me]);
            let frames_shown = frames.load(Ordering::Relaxed);

            // The last pane closes: end the socket; the helper sees it end, closes its browser and exits.
            let stopping = Instant::now();
            *SOCK.lock().unwrap() = None;
            unsafe { libc::shutdown(ours, libc::SHUT_RDWR); }
            let mut child = { let mut c = CHILDREN.lock().unwrap(); let i = c.iter().position(|ch| ch.id() as i32 == pid).unwrap(); c.remove(i) };
            let mut exit = None;
            while stopping.elapsed() < Duration::from_secs(10) { if let Ok(Some(status)) = child.try_wait() { exit = Some(status); break } std::thread::sleep(Duration::from_millis(5)); }
            let killed = exit.is_none();
            if killed { let _ = child.kill(); exit = child.wait().ok(); }
            let stop_ms = stopping.elapsed().as_secs_f64() * 1000.0;
            stop.store(true, Ordering::SeqCst);
            let _ = reader.join();
            unsafe { libc::close(ours); mach_port_mod_refs(mach_task_self(), recv, MACH_PORT_RIGHT_RECEIVE, -1); }
            *shared.texture.lock().unwrap() = None;
            window.request_redraw();
            std::thread::sleep(Duration::from_secs(2));
            let left: Vec<i32> = pids.iter().copied().filter(|p| alive(*p)).collect();
            let mut lk = lookups.lock().unwrap().clone();
            lk.sort();
            let pct = |v: &Vec<u64>, p: f64| -> u64 { if v.is_empty() { 0 } else { v[((v.len() - 1) as f64 * p) as usize] } };
            let row = serde_json::json!({
                "cycle": cycle, "mach_service": how, "first_frame_in_window_ms": first_ms, "frames": frames_shown,
                "lookup_us": { "p50": pct(&lk, 0.5), "p95": pct(&lk, 0.95) },
                "helper_processes": pids.len(), "helper_footprint_mb": helper_kb / 1024, "window_footprint_mb_while_showing": window_kb / 1024,
                "stop_ms": stop_ms, "killed": killed, "exit": exit.map(|e| format!("{e}")), "helper_processes_left": left, "bundle_processes_left": ours_left(),
                "window_footprint_mb_before_first": before / 1024, "window_footprint_mb_after_stop": footprint_kb(&[me]) / 1024,
            });
            eprintln!("[remote] {row}");
            shared.timings.lock().unwrap().cycles.push(row);
            std::thread::sleep(Duration::from_secs(1));
        }
        hub().note("remote cycles done");
    });
}

pub fn stop_all() {
    if let Some(sock) = SOCK.lock().unwrap().take() { unsafe { libc::shutdown(sock, libc::SHUT_RDWR); } }
    for mut child in CHILDREN.lock().unwrap().drain(..) {
        let _ = child.wait();
    }
}

// ------------------------------------------------------------------ the helper process

static HELPER_VIEW: Mutex<(i32, i32)> = Mutex::new((1000, 700));
static ACKED: Mutex<u32> = Mutex::new(0);
static ACK_CV: Condvar = Condvar::new();
static SEQ: AtomicU32 = AtomicU32::new(0);
static UP: AtomicU32 = AtomicU32::new(0);
static ROUND_TRIPS: Mutex<Vec<u64>> = Mutex::new(Vec::new());
static MAKE_PORT_US: Mutex<Vec<u64>> = Mutex::new(Vec::new());
static SEND_ERRORS: Mutex<Vec<String>> = Mutex::new(Vec::new());

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
            if type_ != PaintElementType::default() || info.shared_texture_io_surface.is_null() { return }
            let up = UP.load(Ordering::SeqCst);
            if up == 0 { return }
            let seq = SEQ.fetch_add(1, Ordering::SeqCst) + 1;
            let (w, h) = (info.extra.coded_size.width as u32, info.extra.coded_size.height as u32);
            let format = if *info.format.as_ref() == sys::cef_color_type_t::CEF_COLOR_TYPE_RGBA_8888 { 0 } else { 1 };
            let start = Instant::now();
            let port = unsafe { IOSurfaceCreateMachPort(info.shared_texture_io_surface) };
            { let mut v = MAKE_PORT_US.lock().unwrap(); if v.len() < 100_000 { v.push(start.elapsed().as_micros() as u64); } }
            if port == MACH_PORT_NULL { let mut e = SEND_ERRORS.lock().unwrap(); if e.len() < 5 { e.push("IOSurfaceCreateMachPort returned null".into()); } return }
            let mut msg = FrameMsg {
                header: mach_msg_header_t { msgh_bits: MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0) | MACH_MSGH_BITS_COMPLEX, msgh_size: std::mem::size_of::<FrameMsg>() as u32, msgh_remote_port: up, msgh_local_port: MACH_PORT_NULL, msgh_voucher_port: 0, msgh_id: 1 },
                body: mach_msg_body_t { msgh_descriptor_count: 1 },
                // MOVE_SEND: the right goes to the window with the message; nothing to release here once it is sent.
                surface: mach_msg_port_descriptor_t::new(port, MACH_MSG_TYPE_MOVE_SEND),
                record: Msg::new(wire::FRAME, &[w, h, format, seq]).0,
            };
            let kr = unsafe { mach_msg(&mut msg.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, std::mem::size_of::<FrameMsg>() as u32, 0, MACH_PORT_NULL, 250, MACH_PORT_NULL) };
            if kr != MACH_MSG_SUCCESS {
                unsafe { mach_port_deallocate(mach_task_self(), port); }
                let mut e = SEND_ERRORS.lock().unwrap(); if e.len() < 5 { e.push(format!("mach_msg send {kr:#x}")); }
                return;
            }
            // CEF takes the surface back when this returns, so wait until the window has copied it.
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
    let name = std::env::var("WP_MACH_NAME").expect("WP_MACH_NAME");
    let run_dir = std::env::var("WP_RUN_DIR").unwrap_or(".".into());
    let cname = CString::new(name.as_str()).unwrap();
    let mut up: mach_port_t = MACH_PORT_NULL;
    let kr = unsafe { bootstrap_look_up(bootstrap_port, cname.as_ptr(), &mut up) };
    if kr != KERN_SUCCESS {
        std::fs::write(format!("{run_dir}/helper.json"), serde_json::json!({ "error": format!("bootstrap_look_up {name}: {kr:#x}") }).to_string()).ok();
        return ExitCode::from(3);
    }
    UP.store(up, Ordering::SeqCst);
    let config = cefapp::config();
    let settings = Settings {
        windowless_rendering_enabled: 1,
        no_sandbox: std::env::var("WP_NO_SANDBOX").is_ok() as i32,
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
        while let Some((m, _)) = wire::recv(sock) {
            match m.kind() {
                wire::ACK => { *ACKED.lock().unwrap() = m.0[1]; ACK_CV.notify_all(); }
                wire::RESIZE => { *HELPER_VIEW.lock().unwrap() = (m.i(1), m.i(2)); if let Some(h) = host() { h.was_resized(); } }
                _ => { if let Some(h) = host() { apply_to_host(&h, &m, &HELPER_VIEW); } }
            }
        }
        // The window closed its last pane.
        UP.store(0, Ordering::SeqCst);
        *ACKED.lock().unwrap() = u32::MAX; ACK_CV.notify_all();
        if let Some(h) = host() { h.close_browser(1); }
        let deadline = Instant::now() + Duration::from_secs(5);
        while !hub().closed.load(Ordering::SeqCst) && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(10)); }
        on_ui(|| quit_message_loop());
    });
    run_message_loop();
    let pct = |v: &Vec<u64>, p: f64| -> u64 { if v.is_empty() { 0 } else { v[((v.len() - 1) as f64 * p) as usize] } };
    let mut rt = ROUND_TRIPS.lock().unwrap().clone();
    rt.sort();
    let mut mk = MAKE_PORT_US.lock().unwrap().clone();
    mk.sort();
    let out = serde_json::json!({
        "frames_sent": rt.len(),
        "round_trip_us": { "p50": pct(&rt, 0.5), "p95": pct(&rt, 0.95), "max": rt.last().copied().unwrap_or(0) },
        "make_port_us": { "p50": pct(&mk, 0.5), "p95": pct(&mk, 0.95) },
        "send_errors": *SEND_ERRORS.lock().unwrap(),
        "alive_ms": started.elapsed().as_millis() as u64,
        "page_console": hub().console.lock().unwrap().iter().filter(|m| m.starts_with("EVT")).cloned().collect::<Vec<_>>(),
        "notes": *hub().notes.lock().unwrap(),
    });
    std::fs::write(format!("{run_dir}/helper.json"), out.to_string()).ok();
    *cefapp::LAST_BROWSER.lock().unwrap() = None;
    unsafe { mach_port_deallocate(mach_task_self(), up); }
    shutdown();
    ExitCode::SUCCESS
}
