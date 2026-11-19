//! The web pane region: how GPUI hosts a surface it does not draw.
//!
//! A separate spike proves the Chromium component. Here a stand-in page is drawn
//! by another renderer (Windows GDI, on its own thread) and shown two ways, the
//! two ways CEF can be embedded on Windows:
//!
//! - **Texture**: the other renderer hands GPUI a BGRA frame (what CEF's
//!   off-screen rendering gives), and GPUI draws it as an image with rounded
//!   corners. Keys and clicks are forwarded to the page.
//! - **Child window**: a real Win32 child window (what CEF's windowed mode and
//!   WebView2 give) placed over GPUI's surface at the pane's rectangle, its
//!   corners cut with a window region.
//!
//! In both, Tab moves through the page's two controls and then out of the page
//! to the next control in Sotto, and Shift+Tab out the other way, as CEF's
//! `OnTakeFocus` does.

use crate::theme::Tokens;
use gpui::{
    App, Context, FocusHandle, Focusable, ImageSource, IntoElement, KeyDownEvent, ParentElement, Render, RenderImage,
    Role, SharedString, StatefulInteractiveElement, Styled, Window, div, img, prelude::*, px,
};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Surface {
    Texture,
    ChildWindow,
}

/// The stand-in page's own state, shared with whichever renderer draws it.
#[derive(Clone, Debug, Default)]
pub struct Page {
    pub text: String,
    /// 0: nothing focused, 1: the field, 2: the button.
    pub focus: u8,
    pub presses: u32,
    pub dark: bool,
    pub reduce_motion: bool,
    pub started: Option<Instant>,
}

/// Where focus goes when it leaves the page.
#[derive(Clone, Copy, Debug)]
pub enum Leave {
    Next,
    Previous,
}

pub struct WebPane {
    pub focus: FocusHandle,
    pub surface: Surface,
    page: Arc<Mutex<Page>>,
    frame: Option<Arc<RenderImage>>,
    stale: Vec<Arc<RenderImage>>,
    renderer: Option<renderer::Handle>,
    #[cfg(windows)]
    child: Option<child::ChildWindow>,
    leave_rx: async_channel::Receiver<Leave>,
    leave_tx: async_channel::Sender<Leave>,
    pub last_size: (u32, u32),
    pub hidden: bool,
}

impl WebPane {
    pub fn new(tokens: &Tokens, cx: &mut Context<Self>) -> Self {
        let page = Arc::new(Mutex::new(Page {
            dark: tokens.mode == crate::theme::Mode::Dark,
            started: Some(Instant::now()),
            ..Default::default()
        }));
        let (leave_tx, leave_rx) = async_channel::unbounded();
        let (frame_tx, frame_rx) = async_channel::bounded::<image::Frame>(2);
        let renderer = renderer::spawn(page.clone(), frame_tx);

        // Frames from the other renderer become GPUI images on the UI thread.
        cx.spawn(async move |this, cx| {
            while let Ok(frame) = frame_rx.recv().await {
                let mut frame = Some(frame);
                while let Ok(newer) = frame_rx.try_recv() {
                    frame = Some(newer);
                }
                let image = Arc::new(RenderImage::new(smallvec::smallvec![frame.take().unwrap()]));
                if this
                    .update(cx, |pane, cx| {
                        if let Some(old) = pane.frame.replace(image) {
                            pane.stale.push(old);
                        }
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();

        WebPane {
            focus: cx.focus_handle().tab_stop(true),
            surface: Surface::Texture,
            page,
            frame: None,
            stale: Vec::new(),
            renderer: Some(renderer),
            #[cfg(windows)]
            child: None,
            leave_rx,
            leave_tx,
            last_size: (0, 0),
            hidden: false,
        }
    }

    pub fn leave_events(&self) -> async_channel::Receiver<Leave> {
        self.leave_rx.clone()
    }

    pub fn set_theme(&mut self, tokens: &Tokens) {
        self.page.lock().unwrap().dark = tokens.mode == crate::theme::Mode::Dark;
        self.redraw();
    }

    pub fn set_reduce_motion(&mut self, reduce: bool) {
        self.page.lock().unwrap().reduce_motion = reduce;
        self.redraw();
    }

    fn redraw(&self) {
        if let Some(r) = &self.renderer {
            r.dirty();
        }
        #[cfg(windows)]
        if let Some(c) = &self.child {
            c.invalidate();
        }
    }

    pub fn set_surface(&mut self, surface: Surface, window: &mut Window, cx: &mut Context<Self>) {
        self.surface = surface;
        #[cfg(windows)]
        {
            if surface == Surface::ChildWindow && self.child.is_none() {
                self.child = child::ChildWindow::create(window, self.page.clone(), self.leave_tx.clone()).ok();
            }
            if let Some(c) = &self.child {
                c.show(surface == Surface::ChildWindow && !self.hidden);
            }
        }
        let _ = window;
        cx.notify();
    }

    /// Focus arrived from Sotto: give it to the page's first or last control.
    pub fn enter(&mut self, from_end: bool, window: &mut Window, cx: &mut Context<Self>) {
        {
            let mut page = self.page.lock().unwrap();
            page.focus = if from_end { 2 } else { 1 };
        }
        window.focus(&self.focus, cx);
        #[cfg(windows)]
        if self.surface == Surface::ChildWindow
            && let Some(c) = &self.child
        {
            c.take_focus();
        }
        self.redraw();
        cx.notify();
    }

    pub fn blur_page(&mut self) {
        self.page.lock().unwrap().focus = 0;
        self.redraw();
    }

    /// A key while the texture surface has focus: the page handles it, or it leaves.
    pub fn key_down(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) -> bool {
        let key = event.keystroke.key.as_str();
        let shift = event.keystroke.modifiers.shift;
        let leave = {
            let mut page = self.page.lock().unwrap();
            if page.focus == 0 {
                page.focus = 1;
            }
            match key {
                "tab" if !shift && page.focus == 2 => Some(Leave::Next),
                "tab" if shift && page.focus == 1 => Some(Leave::Previous),
                "tab" => {
                    page.focus = if shift { 1 } else { 2 };
                    None
                }
                "enter" | "space" if page.focus == 2 => {
                    page.presses += 1;
                    None
                }
                "backspace" if page.focus == 1 => {
                    page.text.pop();
                    None
                }
                _ => {
                    if page.focus == 1
                        && let Some(ch) = &event.keystroke.key_char
                        && !event.keystroke.modifiers.control
                    {
                        page.text.push_str(ch);
                    } else {
                        return false;
                    }
                    None
                }
            }
        };
        if let Some(leave) = leave {
            self.page.lock().unwrap().focus = 0;
            let _ = self.leave_tx.try_send(leave);
        }
        self.redraw();
        cx.notify();
        true
    }

    /// Tab inside the page: through its two controls, then out of the page.
    pub fn tab(&mut self, backwards: bool, cx: &mut Context<Self>) {
        let leave = {
            let mut page = self.page.lock().unwrap();
            if page.focus == 0 {
                page.focus = if backwards { 2 } else { 1 };
                None
            } else if !backwards && page.focus == 2 {
                Some(Leave::Next)
            } else if backwards && page.focus == 1 {
                Some(Leave::Previous)
            } else {
                page.focus = if backwards { 1 } else { 2 };
                None
            }
        };
        if let Some(leave) = leave {
            self.page.lock().unwrap().focus = 0;
            let _ = self.leave_tx.try_send(leave);
        }
        self.redraw();
        cx.notify();
    }

    pub fn click(&mut self, local_x: f32, local_y: f32, width: f32, height: f32, window: &mut Window, cx: &mut Context<Self>) {
        let hit = renderer::hit(local_x / width, local_y / height);
        {
            let mut page = self.page.lock().unwrap();
            page.focus = hit.max(1);
            if hit == 2 {
                page.presses += 1;
            }
        }
        window.focus(&self.focus, cx);
        self.redraw();
        cx.notify();
    }

    /// Called each frame with the pane's rectangle in window pixels.
    pub fn place(&mut self, bounds: gpui::Bounds<gpui::Pixels>, scale: f32) {
        let w = (f32::from(bounds.size.width) * scale).round().max(1.) as u32;
        let h = (f32::from(bounds.size.height) * scale).round().max(1.) as u32;
        if (w, h) != self.last_size {
            self.last_size = (w, h);
            if let Some(r) = &self.renderer {
                r.resize(w, h);
            }
        }
        #[cfg(windows)]
        if let Some(c) = &self.child {
            c.place(
                (f32::from(bounds.origin.x) * scale).round() as i32,
                (f32::from(bounds.origin.y) * scale).round() as i32,
                w as i32,
                h as i32,
                (10. * scale).round() as i32,
            );
        }
    }

    pub fn page_summary(&self) -> String {
        let page = self.page.lock().unwrap();
        format!(
            "Stand-in page. Field: {}. Booked {} times.",
            if page.text.is_empty() { "empty".to_string() } else { page.text.clone() },
            page.presses
        )
    }

    pub fn set_hidden(&mut self, hidden: bool) {
        self.hidden = hidden;
        #[cfg(windows)]
        if let Some(c) = &self.child {
            c.show(self.surface == Surface::ChildWindow && !hidden);
        }
    }
}

impl Focusable for WebPane {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for WebPane {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        for old in self.stale.drain(..) {
            cx.drop_image(old, Some(window));
        }
        let entity = cx.entity().downgrade();
        let surface: gpui::AnyElement = match (&self.frame, self.surface) {
            (Some(frame), Surface::Texture) => img(ImageSource::Render(frame.clone())).size_full().rounded(px(10.)).into_any_element(),
            _ => div().size_full().into_any_element(),
        };
        let summary: SharedString = self.page_summary().into();
        div()
            .id("web-pane-surface")
            .role(Role::Document)
            .aria_label(SharedString::from(format!("Web page (stand-in, {} surface)", match self.surface {
                Surface::Texture => "texture",
                Surface::ChildWindow => "child window",
            })))
            .aria_description(summary)
            .track_focus(&self.focus)
            .key_context("WebPane")
            .size_full()
            .rounded(px(10.))
            .on_action(cx.listener(|this, _: &crate::PageTab, _, cx| this.tab(false, cx)))
            .on_action(cx.listener(|this, _: &crate::PageBacktab, _, cx| this.tab(true, cx)))
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                if this.surface == Surface::Texture && this.key_down(event, cx) {
                    cx.stop_propagation();
                }
            }))
            .on_mouse_down(gpui::MouseButton::Left, move |event, window, cx| {
                let bounds = window.bounds();
                let _ = bounds;
                let _ = (event, &entity, window, cx);
            })
            .child(
                gpui::canvas(
                    {
                        let entity = cx.entity().downgrade();
                        move |bounds, window, cx| {
                            let scale = window.scale_factor();
                            entity.update(cx, |pane, _| pane.place(bounds, scale)).ok();
                            bounds
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .child(surface)
    }
}

mod renderer {
    //! The other renderer: GDI, on its own thread, drawing the stand-in page into a BGRA buffer.
    use super::Page;
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    };
    use std::time::Duration;

    pub struct Handle {
        dirty: Arc<AtomicBool>,
        size: Arc<AtomicU64>,
    }

    impl Handle {
        pub fn dirty(&self) {
            self.dirty.store(true, Ordering::SeqCst);
        }
        pub fn resize(&self, w: u32, h: u32) {
            self.size.store(((w as u64) << 32) | h as u64, Ordering::SeqCst);
            self.dirty();
        }
    }

    /// Which control a point (in 0..1 of the page) lands on: 1 the field, 2 the button.
    pub fn hit(x: f32, y: f32) -> u8 {
        if (0.06..0.7).contains(&x) && (0.42..0.56).contains(&y) {
            1
        } else if (0.72..0.94).contains(&x) && (0.42..0.56).contains(&y) {
            2
        } else {
            0
        }
    }

    pub fn spawn(page: Arc<Mutex<Page>>, tx: async_channel::Sender<image::Frame>) -> Handle {
        let dirty = Arc::new(AtomicBool::new(true));
        let size = Arc::new(AtomicU64::new((640u64 << 32) | 400));
        let handle = Handle { dirty: dirty.clone(), size: size.clone() };
        std::thread::Builder::new()
            .name("stand-in page renderer".into())
            .spawn(move || {
                let mut last_tick = 0u64;
                loop {
                    std::thread::sleep(Duration::from_millis(33));
                    let snapshot = page.lock().unwrap().clone();
                    // The live stripe moves twice a second unless motion is reduced.
                    let tick = if snapshot.reduce_motion {
                        0
                    } else {
                        snapshot.started.map(|s| s.elapsed().as_millis() as u64 / 500).unwrap_or(0)
                    };
                    let was_dirty = dirty.swap(false, Ordering::SeqCst);
                    if !was_dirty && tick == last_tick {
                        continue;
                    }
                    last_tick = tick;
                    let packed = size.load(Ordering::SeqCst);
                    let (w, h) = ((packed >> 32) as u32, packed as u32);
                    let Some(pixels) = draw(&snapshot, w, h, tick) else { continue };
                    let Some(buffer) = image::RgbaImage::from_raw(w, h, pixels) else { continue };
                    if tx.send_blocking(image::Frame::new(buffer)).is_err() {
                        break;
                    }
                }
            })
            .expect("the page renderer starts");
        handle
    }

    #[cfg(windows)]
    pub fn draw(page: &Page, w: u32, h: u32, tick: u64) -> Option<Vec<u8>> {
        super::gdi::render_to_bgra(page, w, h, tick)
    }

    #[cfg(not(windows))]
    pub fn draw(_page: &Page, w: u32, h: u32, _tick: u64) -> Option<Vec<u8>> {
        Some(vec![200; (w * h * 4) as usize])
    }
}

#[cfg(windows)]
mod gdi {
    //! Drawing the stand-in page with GDI, shared by both surfaces.
    use super::Page;
    use windows::Win32::{Foundation::*, Graphics::Gdi::*};
    use windows::core::w;

    fn rgb(r: u8, g: u8, b: u8) -> COLORREF {
        COLORREF(r as u32 | (g as u32) << 8 | (b as u32) << 16)
    }

    fn fill(hdc: HDC, rect: RECT, color: COLORREF) {
        unsafe {
            let brush = CreateSolidBrush(color);
            FillRect(hdc, &rect, brush);
            let _ = DeleteObject(brush.into());
        }
    }

    fn text(hdc: HDC, s: &str, mut rect: RECT, color: COLORREF, size: i32, bold: bool, format: DRAW_TEXT_FORMAT) {
        unsafe {
            let font = CreateFontW(
                -size, 0, 0, 0, if bold { 600 } else { 400 }, 0, 0, 0, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, 0, w!("Segoe UI"),
            );
            let old = SelectObject(hdc, font.into());
            SetTextColor(hdc, color);
            SetBkMode(hdc, TRANSPARENT);
            let mut wide: Vec<u16> = s.encode_utf16().collect();
            DrawTextW(hdc, &mut wide, &mut rect, format);
            SelectObject(hdc, old);
            let _ = DeleteObject(font.into());
        }
    }

    /// Paint the page into a device context of the given size.
    pub fn paint(hdc: HDC, page: &Page, w: i32, h: i32, tick: u64) {
        let (bg, ink, muted, field, ring, button) = if page.dark {
            (rgb(28, 30, 34), rgb(236, 238, 240), rgb(160, 166, 172), rgb(44, 47, 52), rgb(94, 196, 186), rgb(94, 196, 186))
        } else {
            (rgb(255, 255, 255), rgb(30, 32, 36), rgb(96, 100, 108), rgb(242, 243, 245), rgb(18, 120, 112), rgb(18, 120, 112))
        };
        let s = (h as f32 / 400.).clamp(0.6, 3.0);
        let px = |v: f32| (v * s) as i32;
        fill(hdc, RECT { left: 0, top: 0, right: w, bottom: h }, bg);
        // A live stripe that moves, so a stale frame shows.
        let stripe_x = ((tick % 8) as i32) * w / 8;
        fill(hdc, RECT { left: stripe_x, top: 0, right: stripe_x + w / 8, bottom: px(3.) }, ring);
        text(hdc, "harbor.example", RECT { left: px(24.), top: px(20.), right: w, bottom: px(44.) }, muted, px(13.), false, DT_LEFT);
        text(hdc, "Berth status", RECT { left: px(24.), top: px(48.), right: w, bottom: px(90.) }, ink, px(26.), true, DT_LEFT);
        text(
            hdc,
            "A stand-in page drawn by GDI on its own thread. The Chromium component replaces it.",
            RECT { left: px(24.), top: px(96.), right: w - px(24.), bottom: px(150.) },
            muted,
            px(14.),
            false,
            DT_LEFT | DT_WORDBREAK,
        );
        let fy = (h as f32 * 0.42) as i32;
        let fh = (h as f32 * 0.14) as i32;
        let field_rect = RECT { left: (w as f32 * 0.06) as i32, top: fy, right: (w as f32 * 0.7) as i32, bottom: fy + fh };
        if page.focus == 1 {
            fill(hdc, RECT { left: field_rect.left - 2, top: field_rect.top - 2, right: field_rect.right + 2, bottom: field_rect.bottom + 2 }, ring);
        }
        fill(hdc, field_rect, field);
        let shown = if page.text.is_empty() { "Ship name".to_string() } else { format!("{}{}", page.text, if page.focus == 1 { "|" } else { "" }) };
        text(
            hdc,
            &shown,
            RECT { left: field_rect.left + px(10.), top: field_rect.top, right: field_rect.right - px(10.), bottom: field_rect.bottom },
            if page.text.is_empty() { muted } else { ink },
            px(15.),
            false,
            DT_LEFT | DT_VCENTER | DT_SINGLELINE,
        );
        let button_rect = RECT { left: (w as f32 * 0.72) as i32, top: fy, right: (w as f32 * 0.94) as i32, bottom: fy + fh };
        if page.focus == 2 {
            fill(hdc, RECT { left: button_rect.left - 3, top: button_rect.top - 3, right: button_rect.right + 3, bottom: button_rect.bottom + 3 }, ink);
        }
        fill(hdc, button_rect, button);
        text(hdc, "Book a berth", button_rect, bg, px(14.), true, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
        let status = if page.presses == 0 { "No bookings yet.".to_string() } else { format!("Booked {} times.", page.presses) };
        text(hdc, &status, RECT { left: px(24.), top: fy + fh + px(16.), right: w, bottom: fy + fh + px(40.) }, muted, px(13.), false, DT_LEFT);
    }

    /// Draw into a DIB and return its pixels, BGRA top-down, as GPUI's images want them.
    pub fn render_to_bgra(page: &Page, w: u32, h: u32, tick: u64) -> Option<Vec<u8>> {
        unsafe {
            let screen = GetDC(None);
            let dc = CreateCompatibleDC(Some(screen));
            ReleaseDC(None, screen);
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w as i32,
                    biHeight: -(h as i32),
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits = std::ptr::null_mut();
            let bitmap = CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0).ok()?;
            let old = SelectObject(dc, bitmap.into());
            paint(dc, page, w as i32, h as i32, tick);
            let _ = GdiFlush();
            let len = (w * h * 4) as usize;
            let mut out = std::slice::from_raw_parts(bits as *const u8, len).to_vec();
            for px in out.chunks_exact_mut(4) {
                px[3] = 255;
            }
            SelectObject(dc, old);
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(dc);
            Some(out)
        }
    }
}

#[cfg(windows)]
mod child {
    //! A real Win32 child window over GPUI's surface: the windowed-embedding path.
    use super::{Leave, Page};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use std::sync::{Arc, Mutex};
    use windows::Win32::{
        Foundation::*,
        Graphics::Gdi::*,
        System::LibraryLoader::GetModuleHandleW,
        UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
    };
    use windows::core::w;

    struct State {
        page: Arc<Mutex<Page>>,
        leave: async_channel::Sender<Leave>,
        parent: HWND,
    }

    pub struct ChildWindow {
        hwnd: HWND,
        last: std::cell::Cell<(i32, i32, i32, i32, i32)>,
    }

    impl ChildWindow {
        pub fn create(window: &gpui::Window, page: Arc<Mutex<Page>>, leave: async_channel::Sender<Leave>) -> Result<Self, String> {
            let handle = HasWindowHandle::window_handle(window).map_err(|_| "no window handle".to_string())?;
            let RawWindowHandle::Win32(raw) = handle.as_raw() else { return Err("not a Win32 window".to_string()) };
            let parent = HWND(raw.hwnd.get() as *mut _);
            unsafe {
                let instance = GetModuleHandleW(None).map_err(|_| "no module".to_string())?;
                let class = WNDCLASSW {
                    lpfnWndProc: Some(proc),
                    hInstance: instance.into(),
                    lpszClassName: w!("SottoStandInPage"),
                    hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
                    ..Default::default()
                };
                RegisterClassW(&class);
                let state = Box::new(State { page, leave, parent });
                let hwnd = CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    w!("SottoStandInPage"),
                    w!("Stand-in page"),
                    WS_CHILD | WS_CLIPSIBLINGS | WS_TABSTOP,
                    0,
                    0,
                    100,
                    100,
                    Some(parent),
                    None,
                    Some(instance.into()),
                    Some(Box::into_raw(state) as *const _),
                )
                .map_err(|_| "CreateWindowExW failed".to_string())?;
                Ok(ChildWindow { hwnd, last: std::cell::Cell::new((0, 0, 0, 0, 0)) })
            }
        }

        pub fn show(&self, show: bool) {
            unsafe {
                let _ = ShowWindow(self.hwnd, if show { SW_SHOWNA } else { SW_HIDE });
            }
        }

        pub fn invalidate(&self) {
            unsafe {
                let _ = InvalidateRect(Some(self.hwnd), None, false);
            }
        }

        pub fn take_focus(&self) {
            unsafe {
                let _ = SetFocus(Some(self.hwnd));
            }
        }

        pub fn place(&self, x: i32, y: i32, w: i32, h: i32, radius: i32) {
            let key = (x, y, w, h, radius);
            if self.last.get() == key {
                return;
            }
            self.last.set(key);
            unsafe {
                let _ = SetWindowPos(self.hwnd, Some(HWND_TOP), x, y, w, h, SWP_NOACTIVATE);
                // Round the corners with a window region. GDI regions are not anti-aliased.
                let region = CreateRoundRectRgn(0, 0, w + 1, h + 1, radius * 2, radius * 2);
                SetWindowRgn(self.hwnd, Some(region), true);
            }
        }
    }

    impl Drop for ChildWindow {
        fn drop(&mut self) {
            unsafe {
                let _ = DestroyWindow(self.hwnd);
            }
        }
    }

    unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        unsafe {
            if msg == WM_NCCREATE {
                let create = &*(lparam.0 as *const CREATESTRUCTW);
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
                return DefWindowProcW(hwnd, msg, wparam, lparam);
            }
            let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut State;
            if state.is_null() {
                return DefWindowProcW(hwnd, msg, wparam, lparam);
            }
            let state = &*state;
            match msg {
                WM_PAINT => {
                    let mut ps = PAINTSTRUCT::default();
                    let hdc = BeginPaint(hwnd, &mut ps);
                    let mut rect = RECT::default();
                    let _ = GetClientRect(hwnd, &mut rect);
                    let page = state.page.lock().unwrap().clone();
                    // Double-buffer to avoid flicker.
                    let mem = CreateCompatibleDC(Some(hdc));
                    let bmp = CreateCompatibleBitmap(hdc, rect.right, rect.bottom);
                    let old = SelectObject(mem, bmp.into());
                    let tick = if page.reduce_motion { 0 } else { page.started.map(|s| s.elapsed().as_millis() as u64 / 500).unwrap_or(0) };
                    super::gdi::paint(mem, &page, rect.right, rect.bottom, tick);
                    let _ = BitBlt(hdc, 0, 0, rect.right, rect.bottom, Some(mem), 0, 0, SRCCOPY);
                    SelectObject(mem, old);
                    let _ = DeleteObject(bmp.into());
                    let _ = DeleteDC(mem);
                    let _ = EndPaint(hwnd, &ps);
                    LRESULT(0)
                }
                WM_ERASEBKGND => LRESULT(1),
                WM_SETFOCUS => {
                    let mut page = state.page.lock().unwrap();
                    if page.focus == 0 {
                        page.focus = 1;
                    }
                    drop(page);
                    let _ = InvalidateRect(Some(hwnd), None, false);
                    LRESULT(0)
                }
                WM_KILLFOCUS => {
                    state.page.lock().unwrap().focus = 0;
                    let _ = InvalidateRect(Some(hwnd), None, false);
                    LRESULT(0)
                }
                WM_LBUTTONDOWN => {
                    let x = (lparam.0 & 0xFFFF) as i16 as f32;
                    let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as f32;
                    let mut rect = RECT::default();
                    let _ = GetClientRect(hwnd, &mut rect);
                    let hit = super::renderer::hit(x / rect.right.max(1) as f32, y / rect.bottom.max(1) as f32);
                    let _ = SetFocus(Some(hwnd));
                    let mut page = state.page.lock().unwrap();
                    page.focus = hit.max(1);
                    if hit == 2 {
                        page.presses += 1;
                    }
                    drop(page);
                    let _ = InvalidateRect(Some(hwnd), None, false);
                    LRESULT(0)
                }
                WM_GETDLGCODE => LRESULT((DLGC_WANTALLKEYS | DLGC_WANTCHARS | DLGC_WANTTAB) as isize),
                WM_KEYDOWN => {
                    let shift = GetKeyState(VK_SHIFT.0 as i32) < 0;
                    let key = VIRTUAL_KEY(wparam.0 as u16);
                    let mut page = state.page.lock().unwrap();
                    let mut leave = None;
                    match key {
                        VK_TAB if !shift && page.focus == 2 => leave = Some(Leave::Next),
                        VK_TAB if shift && page.focus <= 1 => leave = Some(Leave::Previous),
                        VK_TAB => page.focus = if shift { 1 } else { 2 },
                        VK_RETURN | VK_SPACE if page.focus == 2 => page.presses += 1,
                        VK_BACK if page.focus == 1 => {
                            page.text.pop();
                        }
                        _ => {}
                    }
                    drop(page);
                    if let Some(leave) = leave {
                        // Give focus back to GPUI's window; Sotto moves it on.
                        let _ = SetFocus(Some(state.parent));
                        let _ = state.leave.try_send(leave);
                    }
                    let _ = InvalidateRect(Some(hwnd), None, false);
                    LRESULT(0)
                }
                WM_CHAR => {
                    let ch = char::from_u32(wparam.0 as u32).unwrap_or('\0');
                    let mut page = state.page.lock().unwrap();
                    if page.focus == 1 && !ch.is_control() {
                        page.text.push(ch);
                    }
                    drop(page);
                    let _ = InvalidateRect(Some(hwnd), None, false);
                    LRESULT(0)
                }
                WM_NCDESTROY => {
                    drop(Box::from_raw(state as *const State as *mut State));
                    SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                    DefWindowProcW(hwnd, msg, wparam, lparam)
                }
                _ => DefWindowProcW(hwnd, msg, wparam, lparam),
            }
        }
    }

}

#[allow(dead_code)]
fn _unused(_: Duration) {}
