//! The helper-process shape on Windows: CEF lives in a helper the window starts when a pane shows and ends when the
//! last one closes. Two named pipes join them, one each way, because synchronous I/O on one pipe handle is serialized
//! and a blocked read would hold up a write.
//!
//! WP_REMOTE=1 (off screen): the helper renders with a shared texture and sends each frame's NT handle *value* up
//! the pipe. The window, which holds the helper's process handle from starting it, duplicates the handle into itself
//! (`DuplicateHandle`), opens it on its own D3D12 device, copies it, closes its duplicate and acknowledges, so the
//! helper can hand the texture back to CEF. Input goes down as the same 64-byte records Linux uses.
//!
//! WP_REMOTE=child: the helper creates CEF's own windowed browser as a child of the window process's HWND, across
//! the process boundary. No frames cross; the window only places it.

use crate::cefapp::{self, SpikeClient, on_ui};
use crate::embed::{Shared, apply_to_host};
use crate::hub::hub;
use crate::wire::{self, Msg};
use cef::*;
use std::fs::File;
use std::io::{Read, Write};
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::process::ExitCode;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{CloseHandle, DUPLICATE_SAME_ACCESS, DuplicateHandle, ERROR_PIPE_CONNECTED, GetLastError, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_INBOUND, PIPE_ACCESS_OUTBOUND};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS};
use windows_sys::Win32::System::Pipes::{ConnectNamedPipe, CreateNamedPipeW, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT};
use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX2};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

/// The pipe the window writes input and acknowledgements into, while a helper runs.
static DOWN: Mutex<Option<File>> = Mutex::new(None);
static CHILDREN: Mutex<Vec<std::process::Child>> = Mutex::new(Vec::new());

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

fn write_msg(f: &mut File, m: &Msg) -> bool {
    f.write_all(&m.bytes()).is_ok()
}
fn read_msg(f: &mut File) -> Option<Msg> {
    let mut b = [0u8; 64];
    f.read_exact(&mut b).ok()?;
    Some(Msg::from_bytes(&b))
}

/// One input record for the helper. None when no helper runs (the caller then talks to an in-process browser).
pub fn send(m: &Msg) -> Option<bool> {
    let mut slot = DOWN.lock().unwrap();
    let f = slot.as_mut()?;
    Some(write_msg(f, m))
}

/// Every process under `root` (Toolhelp's parent links), root included.
pub fn tree(root: u32) -> Vec<u32> {
    let mut pairs = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE { return vec![root] }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut e) != 0 {
            loop {
                pairs.push((e.th32ProcessID, e.th32ParentProcessID));
                if Process32NextW(snap, &mut e) == 0 { break }
            }
        }
        CloseHandle(snap);
    }
    let mut out = vec![root];
    let mut i = 0;
    while i < out.len() {
        let p = out[i];
        out.extend(pairs.iter().filter(|(c, parent)| *parent == p && *c != p).map(|(c, _)| *c));
        i += 1;
    }
    out
}

/// Private working set (the nearest thing to Linux's PSS: pages only this process holds) and commit, in KB.
pub fn memory_kb(pids: &[u32]) -> (u64, u64) {
    let (mut private_ws, mut commit) = (0u64, 0u64);
    for &pid in pids {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() { continue }
            let mut c: PROCESS_MEMORY_COUNTERS_EX2 = std::mem::zeroed();
            c.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX2>() as u32;
            if K32GetProcessMemoryInfo(h, &mut c as *mut _ as *mut _, c.cb) != 0 {
                private_ws += c.PrivateWorkingSetSize as u64 / 1024;
                commit += c.PrivateUsage as u64 / 1024;
            }
            CloseHandle(h);
        }
    }
    (private_ws, commit)
}

/// Whether a process is still running (its exit code is STILL_ACTIVE).
pub fn alive(pid: u32) -> bool {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() { return false }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(h, &mut code);
        CloseHandle(h);
        ok != 0 && code == 259
    }
}

/// Processes named webpane.exe other than this one, from any folder.
#[allow(dead_code)]
pub fn ours_left() -> Vec<u32> {
    let me = std::process::id();
    let mut found = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE { return found }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut e) != 0 {
            loop {
                let name = String::from_utf16_lossy(&e.szExeFile[..e.szExeFile.iter().position(|&c| c == 0).unwrap_or(0)]);
                if name.eq_ignore_ascii_case("webpane.exe") && e.th32ProcessID != me { found.push(e.th32ProcessID) }
                if Process32NextW(snap, &mut e) == 0 { break }
            }
        }
        CloseHandle(snap);
    }
    found
}

/// One end of a pipe, made by the window before it starts the helper, so the name exists when the helper opens it.
/// FIRST_PIPE_INSTANCE refuses a name someone else already made; REJECT_REMOTE_CLIENTS keeps it to this machine.
fn make_pipe(name: &str, inbound: bool) -> HANDLE {
    let access = (if inbound { PIPE_ACCESS_INBOUND } else { PIPE_ACCESS_OUTBOUND }) | FILE_FLAG_FIRST_PIPE_INSTANCE;
    let h = unsafe { CreateNamedPipeW(wide(name).as_ptr(), access, PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 64 * 64, 64 * 64, 0, std::ptr::null()) };
    assert!(h != INVALID_HANDLE_VALUE, "CreateNamedPipeW {name}");
    h
}
fn accept(h: HANDLE) -> File {
    let ok = unsafe { ConnectNamedPipe(h, std::ptr::null_mut()) };
    if ok == 0 && unsafe { GetLastError() } != ERROR_PIPE_CONNECTED { panic!("ConnectNamedPipe failed") }
    unsafe { File::from_raw_handle(h as _) }
}

fn color(raw: u32) -> ColorType {
    ColorType::from(if raw == 0 { sys::cef_color_type_t::CEF_COLOR_TYPE_RGBA_8888 } else { sys::cef_color_type_t::CEF_COLOR_TYPE_BGRA_8888 })
}

/// The window side: start the helper, show its frames, end it; WP_REMOTE_CYCLES times, holding WP_REMOTE_HOLD_S.
pub fn start_controller(shared: Arc<Shared>, window: Arc<winit::window::Window>, hwnd: u64, rect: (i32, i32, i32, i32)) {
    let child_window = std::env::var("WP_REMOTE").as_deref() == Ok("child");
    std::thread::spawn(move || {
        let cycles: usize = std::env::var("WP_REMOTE_CYCLES").ok().and_then(|v| v.parse().ok()).unwrap_or(1);
        let hold: u64 = std::env::var("WP_REMOTE_HOLD_S").ok().and_then(|v| v.parse().ok()).unwrap_or(20);
        let run_dir = std::env::var("WP_RUN_DIR").unwrap_or(".".into());
        let me = std::process::id();
        let before = memory_kb(&[me]);
        for cycle in 0..cycles {
            let base = format!(r"\\.\pipe\sotto-webpane-{me}-{cycle}");
            let up = make_pipe(&format!("{base}-up"), true);
            let down = make_pipe(&format!("{base}-down"), false);
            let spawned = Instant::now();
            let dir = format!("{run_dir}/helper{cycle}");
            std::fs::create_dir_all(&dir).ok();
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command.env("WP_MODE", "helper").env("WP_PIPE", &base).env("WP_RUN_DIR", &dir).env("WP_CACHE", format!("{dir}/cache"))
                .stdout(std::fs::File::create(format!("{dir}/stdout.log")).unwrap()).stderr(std::fs::File::create(format!("{dir}/stderr.log")).unwrap());
            if child_window {
                command.env("WP_PARENT_HWND", hwnd.to_string()).env("WP_CHILD_RECT", format!("{},{},{},{}", rect.0, rect.1, rect.2, rect.3));
            }
            let child = command.spawn().expect("helper");
            let pid = child.id();
            let process = child.as_raw_handle() as HANDLE;
            let mut up = accept(up);
            let mut down_file = accept(down);
            let (vw, vh) = *shared.view.lock().unwrap();
            write_msg(&mut down_file, &Msg::new(wire::RESIZE, &[vw as u32, vh as u32]));
            *DOWN.lock().unwrap() = Some(down_file);
            CHILDREN.lock().unwrap().push(child);
            let connected_ms = spawned.elapsed().as_secs_f64() * 1000.0;

            // Frames: duplicate each handle into this process, import, close the duplicate, acknowledge.
            let reader_shared = shared.clone();
            let first = Arc::new(Mutex::new(None::<f64>));
            let first_r = first.clone();
            let frames = Arc::new(AtomicU32::new(0));
            let frames_r = frames.clone();
            let process_value = process as usize;
            let reader = std::thread::spawn(move || {
                let s = reader_shared;
                let process = process_value as HANDLE;
                let mut dup_us = Vec::new();
                while let Some(m) = read_msg(&mut up) {
                    if m.kind() == wire::LOADED {
                        // The windowed helper says its page finished loading; that is its first frame for this record.
                        if first_r.lock().unwrap().is_none() { *first_r.lock().unwrap() = Some(spawned.elapsed().as_secs_f64() * 1000.0); }
                        continue;
                    }
                    if m.kind() != wire::FRAME { continue }
                    let start = Instant::now();
                    let source = m.u64_at(3) as usize as HANDLE;
                    let mut mine: HANDLE = std::ptr::null_mut();
                    let ok = unsafe { DuplicateHandle(process, source, GetCurrentProcess(), &mut mine, 0, 0, DUPLICATE_SAME_ACCESS) };
                    dup_us.push(start.elapsed().as_micros() as u64);
                    if ok == 0 {
                        let mut t = s.timings.lock().unwrap();
                        if t.errors.len() < 5 { t.errors.push(format!("DuplicateHandle failed: {}", unsafe { GetLastError() })); }
                        send(&Msg::new(wire::ACK, &[m.0[6]]));
                        continue;
                    }
                    let mut info = AcceleratedPaintInfo::default();
                    info.shared_texture_handle = mine;
                    info.format = color(m.0[5]);
                    info.extra.coded_size = Size { width: m.i(1), height: m.i(2) };
                    let handle = cef::osr_texture_import::SharedTextureHandle::new(&info);
                    let imported = unsafe { handle.import_texture(&s.device, &s.queue) };
                    unsafe { CloseHandle(mine); }
                    send(&Msg::new(wire::ACK, &[m.0[6]]));
                    match imported {
                        Ok(texture) => {
                            let us = start.elapsed().as_micros() as u64;
                            let mut t = s.timings.lock().unwrap();
                            t.import_us.push(us);
                            if t.formats.is_empty() { t.formats.push(format!("remote accelerated {}x{} (NT handle duplicated across processes)", texture.width(), texture.height())); }
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
                dup_us.sort();
                dup_us
            });
            let deadline = Instant::now() + Duration::from_secs(30);
            while first.lock().unwrap().is_none() && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(2)); }
            let first_ms = *first.lock().unwrap();
            eprintln!("[remote] helper {pid} first frame {first_ms:?} ms");
            println!("HELPER_SHOWING {pid}");
            std::thread::sleep(Duration::from_secs(if cycles == 1 { hold } else { 3 }));
            let pids = tree(pid);
            let (helper_ws, helper_commit) = memory_kb(&pids);
            let (window_ws, _) = memory_kb(&[me]);
            let frames_shown = frames.load(Ordering::Relaxed);

            // The last pane closes: close the input pipe; the helper sees it end, closes its browser and exits.
            let stop = Instant::now();
            *DOWN.lock().unwrap() = None;
            let mut child = { let mut c = CHILDREN.lock().unwrap(); let i = c.iter().position(|ch| ch.id() == pid).unwrap(); c.remove(i) };
            let mut exit = None;
            while stop.elapsed() < Duration::from_secs(10) { if let Ok(Some(status)) = child.try_wait() { exit = Some(status); break } std::thread::sleep(Duration::from_millis(5)); }
            let killed = exit.is_none();
            if killed { let _ = child.kill(); exit = child.wait().ok(); }
            let stop_ms = stop.elapsed().as_secs_f64() * 1000.0;
            let dup_us = reader.join().unwrap_or_default();
            *shared.texture.lock().unwrap() = None;
            window.request_redraw();
            std::thread::sleep(Duration::from_secs(2));
            let left: Vec<u32> = pids.iter().copied().filter(|p| alive(*p)).collect();
            let pct = |v: &Vec<u64>, p: f64| if v.is_empty() { 0 } else { v[((v.len() - 1) as f64 * p) as usize] };
            let row = serde_json::json!({
                "cycle": cycle, "child_window": child_window, "pipes_connected_ms": connected_ms, "first_frame_in_window_ms": first_ms, "frames": frames_shown,
                "duplicate_handle_us": { "p50": pct(&dup_us, 0.5), "p95": pct(&dup_us, 0.95) },
                "helper_processes": pids.len(), "helper_private_ws_mb": helper_ws / 1024, "helper_commit_mb": helper_commit / 1024,
                "window_private_ws_mb_while_showing": window_ws / 1024,
                "stop_ms": stop_ms, "killed": killed, "exit": exit.map(|e| format!("{e}")), "processes_left_2s_after_stop": left,
                "window_private_ws_mb_before_first": before.0 / 1024, "window_private_ws_mb_after_stop": memory_kb(&[me]).0 / 1024,
            });
            eprintln!("[remote] {row}");
            shared.timings.lock().unwrap().cycles.push(row);
            std::thread::sleep(Duration::from_secs(1));
        }
        hub().note("remote cycles done");
        println!("REMOTE_DONE");
    });
}

pub fn stop_all() {
    *DOWN.lock().unwrap() = None;
    for mut child in CHILDREN.lock().unwrap().drain(..) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline { if let Ok(Some(_)) = child.try_wait() { break } std::thread::sleep(Duration::from_millis(10)); }
        let _ = child.kill();
        let _ = child.wait();
    }
}

// ------------------------------------------------------------------ the helper process

static HELPER_VIEW: Mutex<(i32, i32)> = Mutex::new((1000, 700));
static ACKED: Mutex<u32> = Mutex::new(0);
static ACK_CV: Condvar = Condvar::new();
static SEQ: AtomicU32 = AtomicU32::new(0);
static UP: Mutex<Option<File>> = Mutex::new(None);
static ROUND_TRIPS: Mutex<Vec<u64>> = Mutex::new(Vec::new());

fn up_send(m: &Msg) -> bool {
    match UP.lock().unwrap().as_mut() { Some(f) => write_msg(f, m), None => false }
}

wrap_render_handler! {
    struct HelperRender {}
    impl RenderHandler {
        fn view_rect(&self, _browser: Option<&mut Browser>, rect: Option<&mut Rect>) {
            if let Some(rect) = rect { let (w, h) = *HELPER_VIEW.lock().unwrap(); rect.x = 0; rect.y = 0; rect.width = w.max(1); rect.height = h.max(1); }
        }
        fn screen_info(&self, _browser: Option<&mut Browser>, info: Option<&mut ScreenInfo>) -> ::std::os::raw::c_int {
            if let Some(info) = info { info.device_scale_factor = std::env::var("WP_SCALE").ok().and_then(|v| v.parse().ok()).unwrap_or(1.0); return 1 } 0
        }
        fn on_accelerated_paint(&self, _browser: Option<&mut Browser>, type_: PaintElementType, _dirty: Option<&[Rect]>, info: Option<&AcceleratedPaintInfo>) {
            let Some(info) = info else { return };
            if type_ != PaintElementType::default() || info.shared_texture_handle.is_null() { return }
            let seq = SEQ.fetch_add(1, Ordering::SeqCst) + 1;
            let (w, h) = (info.extra.coded_size.width as u32, info.extra.coded_size.height as u32);
            let format = if *info.format.as_ref() == sys::cef_color_type_t::CEF_COLOR_TYPE_RGBA_8888 { 0 } else { 1 };
            let value = info.shared_texture_handle as usize as u64;
            let m = Msg::new(wire::FRAME, &[w, h, value as u32, (value >> 32) as u32, format, seq]);
            let start = Instant::now();
            if !up_send(&m) { return }
            // CEF takes the texture back when this returns, so wait until the window has copied it.
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
    let base = std::env::var("WP_PIPE").expect("WP_PIPE");
    let open = |suffix: &str, write: bool| std::fs::OpenOptions::new().read(!write).write(write).open(format!("{base}-{suffix}")).expect("helper pipe");
    *UP.lock().unwrap() = Some(open("up", true));
    let mut down = open("down", false);
    let parent: Option<u64> = std::env::var("WP_PARENT_HWND").ok().and_then(|v| v.parse().ok());
    let config = cefapp::config();
    let run_dir = std::env::var("WP_RUN_DIR").unwrap_or(".".into());
    let settings = Settings {
        windowless_rendering_enabled: parent.is_none() as i32,
        no_sandbox: 1,
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
        let rect: Vec<i32> = std::env::var("WP_CHILD_RECT").unwrap_or_default().split(',').filter_map(|v| v.parse().ok()).collect();
        let seen = hub().load_count();
        on_ui(move || {
            let window_info = match parent {
                // CEF's own child window, parented to an HWND that belongs to another process.
                Some(hwnd) => WindowInfo {
                    runtime_style: RuntimeStyle::from(sys::cef_runtime_style_t::CEF_RUNTIME_STYLE_ALLOY),
                    ..Default::default()
                }.set_as_child(crate::embed::parent_handle(hwnd), &Rect { x: rect[0], y: rect[1], width: rect[2], height: rect[3] }),
                None => WindowInfo { windowless_rendering_enabled: 1, shared_texture_enabled: 1, ..Default::default() },
            };
            let settings = BrowserSettings { windowless_frame_rate: 60, ..Default::default() };
            let mut client = SpikeClient::new(if parent.is_some() { None } else { Some(HelperRender::new()) });
            browser_host_create_browser(Some(&window_info), Some(&mut client), Some(&CefString::from(url.as_str())), Some(&settings), None, None);
        });
        if parent.is_some() {
            std::thread::spawn(move || { if hub().wait_load(seen, Duration::from_secs(30)).is_some() { up_send(&Msg::new(wire::LOADED, &[])); } });
            // WP_HANG_MS: after the page loads, block the helper's UI thread (the thread that owns the child window),
            // to see what that does to the window process it is parented into.
            if let Some(ms) = std::env::var("WP_HANG_MS").ok().and_then(|v| v.parse::<u64>().ok()) {
                std::thread::spawn(move || {
                    hub().wait_load(seen, Duration::from_secs(30));
                    std::thread::sleep(Duration::from_secs(3));
                    println!("HANG_START {}", started.elapsed().as_millis());
                    on_ui(move || std::thread::sleep(Duration::from_millis(ms)));
                });
            }
        }
        let host = || cefapp::LAST_BROWSER.lock().unwrap().as_ref().and_then(|b| b.0.host());
        while let Some(m) = read_msg(&mut down) {
            match m.kind() {
                wire::ACK => { *ACKED.lock().unwrap() = m.0[1]; ACK_CV.notify_all(); }
                wire::RESIZE => { *HELPER_VIEW.lock().unwrap() = (m.i(1), m.i(2)); if let Some(h) = host() { h.was_resized(); } }
                _ => { if let Some(h) = host() { apply_to_host(&h, &m, &HELPER_VIEW); } }
            }
        }
        // The window closed its last pane.
        *UP.lock().unwrap() = None;
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
