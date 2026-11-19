//! The system's reduced-motion setting. GPUI has `App::set_reduce_motion` and
//! honours it in its own animations, but no platform reads the system setting
//! yet, so the app reads it.
//!
//! - Windows: "Animation effects" (Settings > Accessibility > Visual effects),
//!   `SPI_GETCLIENTAREAANIMATION`, which is what Chromium maps
//!   `prefers-reduced-motion` to.
//! - Linux: `org.gnome.desktop.interface enable-animations`, what GTK and
//!   Chromium follow there, read through the desktop portal's Settings interface
//!   (and watched for changes), or from GSettings directly when no portal
//!   answers.
//! - macOS would read `NSWorkspace.accessibilityDisplayShouldReduceMotion`; not
//!   wired here.

#[cfg(windows)]
pub fn system_prefers_reduced_motion() -> bool {
    use windows::{Win32::UI::WindowsAndMessaging::*, core::BOOL};
    let mut animations = BOOL(1);
    unsafe {
        let ok = SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            Some(&mut animations as *mut BOOL as *mut _),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        );
        ok.is_ok() && !animations.as_bool()
    }
}

#[cfg(target_os = "linux")]
pub fn system_prefers_reduced_motion() -> bool {
    linux::prefers_reduced_motion()
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn system_prefers_reduced_motion() -> bool {
    false
}

#[cfg(target_os = "linux")]
mod linux {
    //! A watcher thread keeps the latest answer; the UI thread's one-second poll reads it.
    use std::sync::{
        OnceLock,
        atomic::{AtomicBool, Ordering},
    };

    const NAMESPACE: &str = "org.gnome.desktop.interface";
    const KEY: &str = "enable-animations";
    static REDUCED: AtomicBool = AtomicBool::new(false);
    static STARTED: OnceLock<()> = OnceLock::new();

    pub fn prefers_reduced_motion() -> bool {
        STARTED.get_or_init(|| {
            // The first answer before the thread starts, so the first frame is right.
            if let Some(animations) = read_gsettings() {
                REDUCED.store(!animations, Ordering::SeqCst);
            }
            let _ = std::thread::Builder::new().name("reduced motion watcher".into()).spawn(watch);
        });
        REDUCED.load(Ordering::SeqCst)
    }

    fn watch() {
        let portal = futures_lite::future::block_on(async {
            use futures_lite::StreamExt as _;
            let settings = ashpd::desktop::settings::Settings::new().await.ok()?;
            let first: bool = settings.read(NAMESPACE, KEY).await.ok()?;
            REDUCED.store(!first, Ordering::SeqCst);
            eprintln!("reduced-motion source=portal enable-animations={first}");
            let mut changes = settings.receive_setting_changed_with_args::<bool>(NAMESPACE, KEY).await.ok()?;
            while let Some(change) = changes.next().await {
                if let Ok(animations) = change {
                    eprintln!("reduced-motion changed enable-animations={animations}");
                    REDUCED.store(!animations, Ordering::SeqCst);
                }
            }
            Some(())
        });
        if portal.is_some() {
            return;
        }
        // No portal answered (or it went away): read GSettings once a second instead.
        eprintln!("reduced-motion source=gsettings");
        loop {
            if let Some(animations) = read_gsettings() {
                REDUCED.store(!animations, Ordering::SeqCst);
            }
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    }

    fn read_gsettings() -> Option<bool> {
        let out = std::process::Command::new("gsettings").args(["get", NAMESPACE, KEY]).output().ok()?;
        match String::from_utf8_lossy(&out.stdout).trim() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        }
    }
}
