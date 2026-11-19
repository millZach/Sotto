//! The system's reduced-motion setting. GPUI has `App::set_reduce_motion` and
//! honours it in its own animations, but no platform reads the system setting
//! yet, so the app reads it.
//!
//! - Windows: "Animation effects" (Settings > Accessibility > Visual effects),
//!   `SPI_GETCLIENTAREAANIMATION`, which is what Chromium maps
//!   `prefers-reduced-motion` to.
//! - macOS would read `NSWorkspace.accessibilityDisplayShouldReduceMotion`, and
//!   Linux the portal's `org.gnome.desktop.interface enable-animations`; neither
//!   is wired here.

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

#[cfg(not(windows))]
pub fn system_prefers_reduced_motion() -> bool {
    false
}
