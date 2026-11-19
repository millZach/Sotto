//! A stand-in for the Chromium component: a page painted on its own thread by its own renderer
//! (fontdue for text, a few lines of rasterising for boxes), delivered as RGBA frames the way
//! Chromium's off-screen mode delivers them to a host. Slint shows each frame as an image
//! clipped to the pane's rounded corners. Keys reach the page while the pane has the focus.
//!
//! Real: the threading, the frame hand-off, the rounded clip, the focus moving in and out.
//! Stood in: the page and its engine. Nothing here touches a network.

use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Default)]
pub struct PageState {
    pub width: u32,
    pub height: u32,
    pub scale: f32,
    pub focused: bool,
    /// 0 none, 1 the title field, 2 the Save button
    pub page_focus: u8,
    pub field: String,
    pub saved: Option<String>,
    pub reduced_motion: bool,
    pub dark_frame: bool,
    /// Bumped on every change, so the page repaints only when something changed.
    pub version: u64,
    /// When the page last started loading (the bar slides for two seconds after it).
    pub loaded_at: f32,
}

pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub pixels: slint::SharedPixelBuffer<slint::Rgba8Pixel>,
    pub rendered_in: Duration,
}

pub struct WebPane {
    pub state: Arc<Mutex<PageState>>,
    pub frames: Receiver<Frame>,
    _wake: Sender<()>,
}

const FIGTREE: &[u8] = include_bytes!("../../apps/ios/Sotto/Resources/Figtree.ttf");
const FIGTREE_BOLD: &[u8] = include_bytes!("../../apps/ios/Sotto/Resources/Figtree-SemiBold.ttf");

pub fn start() -> WebPane {
    let state = Arc::new(Mutex::new(PageState { width: 400, height: 300, scale: 1.0, ..Default::default() }));
    let (tx, rx) = channel();
    let (wake_tx, _wake_rx) = channel::<()>();
    let st = state.clone();
    std::thread::Builder::new()
        .name("page-renderer".into())
        .spawn(move || {
            let regular = fontdue::Font::from_bytes(FIGTREE, fontdue::FontSettings::default()).unwrap();
            let bold = fontdue::Font::from_bytes(FIGTREE_BOLD, fontdue::FontSettings::default()).unwrap();
            let start = Instant::now();
            let mut last_version = u64::MAX;
            let mut last_blink = false;
            loop {
                let s = st.lock().unwrap().clone();
                let t = start.elapsed().as_secs_f32();
                // A page repaints when it changes: while its bar slides, when its caret blinks, or on input.
                let sliding = !s.reduced_motion && t - s.loaded_at < 2.0;
                let blink = s.focused && s.page_focus == 1 && !s.reduced_motion && (t * 2.0).fract() < 0.6;
                if s.version != last_version || sliding || blink != last_blink {
                    last_version = s.version;
                    last_blink = blink;
                    let t0 = Instant::now();
                    let frame = paint(&s, &regular, &bold, t);
                    let frame = Frame { rendered_in: t0.elapsed(), ..frame };
                    if tx.send(frame).is_err() {
                        return;
                    }
                }
                std::thread::sleep(Duration::from_millis(16));
            }
        })
        .unwrap();
    WebPane { state, frames: rx, _wake: wake_tx }
}

struct Canvas {
    w: u32,
    h: u32,
    px: Vec<u8>,
    s: f32,
}

impl Canvas {
    fn rect(&mut self, x: f32, y: f32, w: f32, h: f32, c: [u8; 4], r: f32) {
        let (x0, y0, x1, y1) = (x * self.s, y * self.s, (x + w) * self.s, (y + h) * self.s);
        let r = r * self.s;
        for py in (y0.max(0.0) as u32)..(y1.min(self.h as f32) as u32) {
            for px in (x0.max(0.0) as u32)..(x1.min(self.w as f32) as u32) {
                let (fx, fy) = (px as f32 + 0.5, py as f32 + 0.5);
                // Rounded corners with a one-pixel soft edge.
                let cx = if fx < x0 + r { x0 + r } else if fx > x1 - r { x1 - r } else { fx };
                let cy = if fy < y0 + r { y0 + r } else if fy > y1 - r { y1 - r } else { fy };
                let d = ((fx - cx).powi(2) + (fy - cy).powi(2)).sqrt();
                let cover = (r - d + 0.5).clamp(0.0, 1.0);
                let cover = if r > 0.0 { cover } else { 1.0 };
                self.blend(px, py, c, cover * c[3] as f32 / 255.0);
            }
        }
    }
    fn blend(&mut self, x: u32, y: u32, c: [u8; 4], a: f32) {
        if a <= 0.0 {
            return;
        }
        let i = ((y * self.w + x) * 4) as usize;
        for k in 0..3 {
            self.px[i + k] = (self.px[i + k] as f32 * (1.0 - a) + c[k] as f32 * a) as u8;
        }
        self.px[i + 3] = 255;
    }
    fn text(&mut self, font: &fontdue::Font, x: f32, y: f32, size: f32, c: [u8; 4], text: &str, max_w: f32) -> f32 {
        let size = size * self.s;
        let mut pen = x * self.s;
        let base = y * self.s + size;
        let limit = (x + max_w) * self.s;
        for ch in text.chars() {
            let (m, bitmap) = font.rasterize(ch, size);
            if pen + m.advance_width > limit {
                break;
            }
            for gy in 0..m.height {
                for gx in 0..m.width {
                    let a = bitmap[gy * m.width + gx] as f32 / 255.0;
                    let px = pen as i32 + m.xmin + gx as i32;
                    let py = base as i32 - m.ymin - m.height as i32 + gy as i32;
                    if px >= 0 && py >= 0 && (px as u32) < self.w && (py as u32) < self.h {
                        self.blend(px as u32, py as u32, c, a);
                    }
                }
            }
            pen += m.advance_width;
        }
        pen / self.s - x
    }
}

fn paint(s: &PageState, regular: &fontdue::Font, bold: &fontdue::Font, t: f32) -> Frame {
    let (w, h) = ((s.width as f32 * s.scale).max(1.0) as u32, (s.height as f32 * s.scale).max(1.0) as u32);
    let mut c = Canvas { w, h, px: vec![255; (w * h * 4) as usize], s: s.scale };
    let lw = s.width as f32;
    let ink = [28, 31, 36, 255];
    let soft = [92, 97, 108, 255];
    let accent = [16, 120, 112, 255];
    // The page's own look: a light documentation page, whatever the host's theme.
    c.rect(0.0, 0.0, lw, 44.0, [244, 245, 247, 255], 0.0);
    c.text(bold, 16.0, 13.0, 15.0, ink, "Lantern shelf preview", lw - 32.0);
    // A loading bar that slides, unless motion is reduced.
    let bar_x = if s.reduced_motion || t - s.loaded_at >= 2.0 { -200.0 } else { ((t - s.loaded_at) * 0.6).fract() * (lw + 120.0) - 120.0 };
    c.rect(0.0, 43.0, lw, 2.0, [226, 229, 233, 255], 0.0);
    c.rect(bar_x, 43.0, 120.0, 2.0, accent, 0.0);
    let mut y = 64.0;
    c.text(bold, 16.0, y, 20.0, ink, "Recent entries", lw - 32.0);
    y += 36.0;
    for (title, when) in [("Shelf loses entries after a crash", "2 min ago"), ("Compaction threshold", "1 h ago"), ("Receipts journal", "yesterday")] {
        c.rect(16.0, y, lw - 32.0, 40.0, [248, 249, 250, 255], 8.0);
        c.text(regular, 28.0, y + 11.0, 14.0, ink, title, lw - 140.0);
        c.text(regular, lw - 104.0, y + 12.0, 12.0, soft, when, 90.0);
        y += 48.0;
    }
    y += 6.0;
    c.text(regular, 16.0, y, 13.0, soft, "Rename the newest entry", lw - 32.0);
    y += 24.0;
    // The title field.
    let field_focus = s.focused && s.page_focus == 1;
    if field_focus {
        c.rect(14.0, y - 2.0, lw - 28.0, 40.0, accent, 9.0);
    }
    c.rect(16.0, y, lw - 32.0, 36.0, [255, 255, 255, 255], 7.0);
    c.rect(16.0, y, lw - 32.0, 1.0, [208, 212, 218, 255], 0.0);
    c.rect(16.0, y + 35.0, lw - 32.0, 1.0, [208, 212, 218, 255], 0.0);
    let shown = if s.field.is_empty() && !field_focus { "Type a new title" } else { &s.field };
    let tw = c.text(regular, 28.0, y + 9.0, 14.0, if s.field.is_empty() { soft } else { ink }, shown, lw - 60.0);
    if field_focus && (s.reduced_motion || (t * 2.0).fract() < 0.6) {
        let cx = if s.field.is_empty() { 28.0 } else { 28.0 + tw + 1.0 };
        c.rect(cx, y + 9.0, 1.5, 18.0, ink, 0.0);
    }
    y += 50.0;
    // The Save button.
    let button_focus = s.focused && s.page_focus == 2;
    if button_focus {
        c.rect(14.0, y - 2.0, 112.0, 40.0, accent, 10.0);
        c.rect(16.0, y, 108.0, 36.0, [255, 255, 255, 255], 8.0);
    }
    c.rect(18.0, y + 2.0, 104.0, 32.0, accent, 7.0);
    c.text(bold, 42.0, y + 9.0, 14.0, [255, 255, 255, 255], "Save title", 80.0);
    if let Some(saved) = &s.saved {
        c.text(regular, 140.0, y + 10.0, 13.0, soft, &format!("Saved \u{201c}{saved}\u{201d}"), lw - 160.0);
    }
    let pixels = slint::SharedPixelBuffer::<slint::Rgba8Pixel>::clone_from_slice(&c.px, w, h);
    Frame { width: w, height: h, pixels, rendered_in: Duration::ZERO }
}

/// The page's answer to a key: true when the page used it, false to let the focus leave.
pub fn key(state: &Mutex<PageState>, text: &str, shift: bool) -> bool {
    use slint::platform::Key;
    let mut s = state.lock().unwrap();
    s.version += 1;
    let k = text.chars().next().unwrap_or('\0');
    if k == char::from(Key::Tab) || k == char::from(Key::Backtab) {
        let back = shift || k == char::from(Key::Backtab);
        let next = match (s.page_focus, back) {
            (0, false) => 1,
            (1, false) => 2,
            (2, false) => 0,
            (0, true) => 2,
            (2, true) => 1,
            (1, true) => 0,
            _ => 0,
        };
        s.page_focus = next;
        return next != 0;
    }
    if s.page_focus == 1 {
        if k == char::from(Key::Backspace) {
            s.field.pop();
            return true;
        }
        if k == char::from(Key::Return) {
            s.saved = Some(s.field.clone());
            return true;
        }
        if !text.is_empty() && !text.chars().any(|c| c.is_control() || ('\u{f700}'..='\u{f8ff}').contains(&c)) {
            s.field.push_str(text);
            return true;
        }
    }
    if s.page_focus == 2 && (k == char::from(Key::Return) || k == ' ') {
        s.saved = Some(s.field.clone());
        return true;
    }
    false
}
