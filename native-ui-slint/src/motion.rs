//! Reduced motion, from the system.
//!
//! Slint 1.19 reads the system's motion setting on Windows only (its winit backend's
//! windows_settings.rs), at start and whenever a window gains focus, and honours it in every
//! `animate` block and in a flick's coasting; but the app's own motion (the breathing dot, the
//! page's loading bar) runs from this app's `Motion` global, so the app reads the setting too.
//!
//! - Linux: GNOME's `org.gnome.desktop.interface enable-animations` (the setting GTK and Chromium
//!   follow on Linux) through `gsettings`, watched with `gsettings monitor`. Slint's own built-in
//!   motion (a flick's coasting) cannot be told on Linux, so it still coasts.
//! - Windows: "Animation effects" (Settings > Accessibility > Visual effects), read through
//!   `SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION)`, the setting Chromium maps
//!   `prefers-reduced-motion` to. winit consumes `WM_SETTINGCHANGE`, so it is read again every
//!   500 ms on a thread of its own.

use crate::{AppWindow, Motion};
use slint::ComponentHandle;
use std::cell::RefCell;

thread_local! {
    static LISTENERS: RefCell<Vec<Box<dyn Fn(bool)>>> = RefCell::new(Vec::new());
}

pub fn on_change(f: impl Fn(bool) + 'static) {
    LISTENERS.with(|l| l.borrow_mut().push(Box::new(f)));
}

fn notify(w: &slint::Weak<AppWindow>, reduced: bool, source: &'static str) {
    let _ = w.upgrade_in_event_loop(move |_| {
        eprintln!("event=reduced-motion value={reduced} source={source}");
        LISTENERS.with(|l| l.borrow().iter().for_each(|f| f(reduced)));
    });
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[link(name = "user32")]
    unsafe extern "system" {
        fn SystemParametersInfoW(action: u32, param: u32, pv: *mut core::ffi::c_void, winini: u32) -> i32;
    }
    const SPI_GETCLIENTAREAANIMATION: u32 = 0x1042;
    static STOP: AtomicBool = AtomicBool::new(false);

    pub fn read() -> Option<bool> {
        let mut on: i32 = 1;
        // SAFETY: SPI_GETCLIENTAREAANIMATION writes one BOOL to the pointer it is given.
        let ok = unsafe { SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, &mut on as *mut i32 as *mut _, 0) };
        (ok != 0).then_some(on == 0)
    }

    pub const SOURCE: &str = "spi-clientareaanimation";

    pub fn watch_thread(w: slint::Weak<AppWindow>, mut last: bool) {
        std::thread::Builder::new()
            .name("motion-watch".into())
            .spawn(move || {
                while !STOP.load(Ordering::Acquire) {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    if let Some(now) = read()
                        && now != last
                    {
                        last = now;
                        notify(&w, now, "spi-poll");
                    }
                }
            })
            .ok();
    }

    pub fn stop() {
        STOP.store(true, Ordering::Release);
    }
}

#[cfg(unix)]
mod platform {
    use super::*;
    use std::io::BufRead;
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::sync::Mutex;

    /// The `gsettings monitor` child, stopped when the app quits (and by the kernel if the app dies first).
    static MONITOR: Mutex<Option<Child>> = Mutex::new(None);

    pub const SOURCE: &str = "gsettings";

    pub fn stop() {
        if let Some(mut child) = MONITOR.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    pub fn read() -> Option<bool> {
        let out = Command::new("gsettings").args(["get", "org.gnome.desktop.interface", "enable-animations"]).output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        match text.trim() {
            "false" => Some(true),
            "true" => Some(false),
            _ => None,
        }
    }

    pub fn watch_thread(w: slint::Weak<AppWindow>, _last: bool) {
        std::thread::Builder::new()
            .name("motion-watch".into())
            .spawn(move || {
                let mut command = Command::new("gsettings");
                command.args(["monitor", "org.gnome.desktop.interface", "enable-animations"]).stdout(Stdio::piped()).stderr(Stdio::null());
                // SAFETY: prctl is async-signal-safe; the child dies with this process.
                unsafe {
                    command.pre_exec(|| {
                        libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
                        Ok(())
                    });
                }
                let Ok(mut child) = command.spawn() else { return };
                let Some(out) = child.stdout.take() else { return };
                *MONITOR.lock().unwrap() = Some(child);
                for line in std::io::BufReader::new(out).lines().map_while(Result::ok) {
                    // The monitor's line can carry the value from before the write lands, so read it again.
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    let reduced = read().unwrap_or_else(|| line.trim().ends_with("false"));
                    notify(&w, reduced, "gsettings-monitor");
                }
            })
            .ok();
    }
}

pub use platform::stop;

pub fn watch(ui: &AppWindow) {
    let reduced = platform::read().unwrap_or(false);
    ui.global::<Motion>().set_reduced(reduced);
    eprintln!("event=reduced-motion value={reduced} source={}", platform::SOURCE);
    platform::watch_thread(ui.as_weak(), reduced);
}
