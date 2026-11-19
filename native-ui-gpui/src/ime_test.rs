//! For checking input methods only (`SOTTO_GPUI_IME=ja` or `zh`): switch this
//! window to the real Microsoft Japanese IME or Microsoft Pinyin and turn it on,
//! as the user's language switch and IME toggle would. Outside automation could
//! not switch an IME on reliably, so the app does it for itself; the composing,
//! the conversion and the candidate window are the real IME's.

#[cfg(windows)]
pub fn activate(window: &gpui::Window, which: &str) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows::Win32::{
        Foundation::HWND,
        UI::{Input::Ime::*, Input::KeyboardAndMouse::*},
    };
    let klid = match which {
        "ja" => windows::core::w!("00000411"),
        "zh" => windows::core::w!("00000804"),
        _ => return,
    };
    let Ok(handle) = HasWindowHandle::window_handle(window) else { return };
    let RawWindowHandle::Win32(raw) = handle.as_raw() else { return };
    let hwnd = HWND(raw.hwnd.get() as *mut _);
    unsafe {
        let Ok(hkl) = LoadKeyboardLayoutW(klid, ACTIVATE_KEYBOARD_LAYOUT_FLAGS(KLF_ACTIVATE.0 | KLF_SETFORPROCESS.0)) else { return };
        let _ = ActivateKeyboardLayout(hkl, KLF_SETFORPROCESS);
        let himc = ImmGetContext(hwnd);
        if !himc.is_invalid() {
            let _ = ImmSetOpenStatus(himc, true);
            if which == "ja" {
                let _ = ImmSetConversionStatus(himc, IME_CMODE_NATIVE | IME_CMODE_FULLSHAPE, IME_SMODE_PHRASEPREDICT);
            }
            let _ = ImmReleaseContext(hwnd, himc);
        }
    }
    log_state(hwnd, "after switching on");
}

/// Write the IME's state for this window to %TEMP%\gpui-ime.txt.
#[cfg(windows)]
pub fn log_state(hwnd: windows::Win32::Foundation::HWND, when: &str) {
    use windows::Win32::UI::Input::{Ime::*, KeyboardAndMouse::GetKeyboardLayout};
    unsafe {
        let himc = ImmGetContext(hwnd);
        let open = !himc.is_invalid() && ImmGetOpenStatus(himc).as_bool();
        let (mut conv, mut sent) = (IME_CONVERSION_MODE(0), IME_SENTENCE_MODE(0));
        let _ = ImmGetConversionStatus(himc, Some(&mut conv), Some(&mut sent));
        let default_ime = ImmGetDefaultIMEWnd(hwnd);
        if !himc.is_invalid() {
            let _ = ImmReleaseContext(hwnd, himc);
        }
        let line = format!(
            "{when}: himc valid {}, open {open}, conversion {:#x}, layout {:?}, default IME window {:?}\n",
            !himc.is_invalid(),
            conv.0,
            GetKeyboardLayout(0),
            default_ime
        );
        let path = std::env::temp_dir().join("gpui-ime.txt");
        let mut text = std::fs::read_to_string(&path).unwrap_or_default();
        text.push_str(&line);
        let _ = std::fs::write(path, text);
    }
}

#[cfg(windows)]
pub fn log_window(window: &gpui::Window, when: &str) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let Ok(handle) = HasWindowHandle::window_handle(window) else { return };
    let RawWindowHandle::Win32(raw) = handle.as_raw() else { return };
    log_state(windows::Win32::Foundation::HWND(raw.hwnd.get() as *mut _), when);
}

#[cfg(not(windows))]
pub fn log_window(_window: &gpui::Window, _when: &str) {}

#[cfg(not(windows))]
pub fn activate(_window: &gpui::Window, _which: &str) {}
