//! Reduced motion, from the system.
//!
//! Slint 1.19 reads the system's motion setting on Windows only (its winit backend's
//! windows_settings.rs); on Linux it reads colour scheme, accent, font and cursor blink from the
//! desktop portal but not the animations switch. So this reads GNOME's
//! `org.gnome.desktop.interface enable-animations` itself (the setting GTK and Chromium follow on
//! Linux) through `gsettings`, and watches it with `gsettings monitor`. Slint's own built-in motion
//! (a flick's coasting) cannot be told on Linux, so it still coasts; this switch covers everything
//! this app animates.

use crate::{AppWindow, Motion};
use slint::ComponentHandle;
use std::cell::RefCell;
use std::io::BufRead;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

/// The `gsettings monitor` child, stopped when the app quits (and by the kernel if the app dies first).
static MONITOR: Mutex<Option<Child>> = Mutex::new(None);

pub fn stop() {
    if let Some(mut child) = MONITOR.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

thread_local! {
    static LISTENERS: RefCell<Vec<Box<dyn Fn(bool)>>> = RefCell::new(Vec::new());
}

fn read() -> Option<bool> {
    let out = Command::new("gsettings").args(["get", "org.gnome.desktop.interface", "enable-animations"]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    match text.trim() {
        "false" => Some(true),
        "true" => Some(false),
        _ => None,
    }
}

pub fn on_change(f: impl Fn(bool) + 'static) {
    LISTENERS.with(|l| l.borrow_mut().push(Box::new(f)));
}

pub fn watch(ui: &AppWindow) {
    let reduced = read().unwrap_or(false);
    ui.global::<Motion>().set_reduced(reduced);
    eprintln!("event=reduced-motion value={reduced} source=gsettings");
    let w = ui.as_weak();
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
                let _ = w.upgrade_in_event_loop(move |_| {
                    eprintln!("event=reduced-motion value={reduced} source=gsettings-monitor");
                    LISTENERS.with(|l| l.borrow().iter().for_each(|f| f(reduced)));
                });
            }
        })
        .ok();
}
