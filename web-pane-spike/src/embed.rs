//! Question 4: the page's picture inside a native Rust window, at a rectangle, with rounded corners.
//!
//! `embed`: a winit + wgpu (Vulkan) window. CEF renders off screen; its frames arrive either as shared textures
//! (dmabuf, `on_accelerated_paint`, WP_PATH=accelerated) imported into wgpu, or as CPU pixels (`on_paint`,
//! WP_PATH=software) uploaded. A shader draws the page inside a rounded rectangle over "native" chrome. Pointer,
//! wheel and keys from winit go to CEF's input methods; focus follows clicks.
//!
//! `child`: CEF's windowed mode, its own native child window parented to the winit window at a rectangle. On Linux
//! CEF takes an X11 window as parent, so this runs the winit window under XWayland.
//!
//! macOS: CEF must run on the main thread there (no multi-threaded message loop), so the in-process window pumps CEF
//! itself (`external_message_pump`, `do_message_loop_work` between winit's event pumps). With WP_REMOTE the window
//! never starts CEF and runs winit as usual. WP_SHOT=<file.bmp> saves what the window drew after WP_SHOT_FRAMES page
//! frames; WP_SELF_INPUT=1 sends a click into the page's field and types into it, through the same path as winit's
//! input, once the first frame shows.

use crate::cefapp::{self, SpikeClient};
use crate::hub::hub;
use crate::wire::Msg;
use cef::*;
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use winit::application::ApplicationHandler;
use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy};
use winit::keyboard::{Key, NamedKey};
use winit::window::{Window, WindowAttributes, WindowId};

/// Where the page sits in the window, in logical pixels: right of a 240 px sidebar, under a 56 px strip.
const LEFT: f64 = 240.0;
const TOP: f64 = 56.0;
const MARGIN: f64 = 20.0;
const RADIUS: f32 = 14.0;

#[derive(Default)]
pub struct Timings {
    pub import_us: Vec<u64>,
    pub first_frame_ms: Option<f64>,
    pub formats: Vec<String>,
    pub errors: Vec<String>,
    pub cycles: Vec<serde_json::Value>,
}

pub struct Shared {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub texture: Mutex<Option<wgpu::Texture>>,
    pub timings: Mutex<Timings>,
    pub view: Mutex<(i32, i32)>,
    scale: Mutex<f32>,
    pub proxy: Mutex<Option<EventLoopProxy<()>>>,
    pub frames: AtomicU64,
    accelerated: bool,
    /// Set when the page runs in a helper process (WP_REMOTE): the socket to it.
    pub remote: Mutex<Option<i32>>,
    pub view_pub: (),
    /// The wgpu adapter the window draws with (on a hybrid laptop, CEF's GPU process must open the same one).
    pub adapter: String,
}

struct SendShared(Arc<Shared>);
unsafe impl Send for SendShared {}
#[derive(Clone)]
struct SharedRef(Arc<Shared>);

wrap_render_handler! {
    struct EmbedRender { shared: SharedRef }
    impl RenderHandler {
        fn view_rect(&self, _browser: Option<&mut Browser>, rect: Option<&mut Rect>) {
            if let Some(rect) = rect {
                let (w, h) = *self.shared.0.view.lock().unwrap();
                rect.x = 0; rect.y = 0; rect.width = w.max(1); rect.height = h.max(1);
            }
        }
        fn screen_info(&self, _browser: Option<&mut Browser>, info: Option<&mut ScreenInfo>) -> ::std::os::raw::c_int {
            if let Some(info) = info { info.device_scale_factor = *self.shared.0.scale.lock().unwrap(); return 1 }
            0
        }
        fn on_accelerated_paint(&self, _browser: Option<&mut Browser>, type_: PaintElementType, _dirty: Option<&[Rect]>, info: Option<&AcceleratedPaintInfo>) {
            let Some(info) = info else { return };
            if type_ != PaintElementType::default() { return }
            let s = &self.shared.0;
            let start = Instant::now();
            let handle = cef::osr_texture_import::SharedTextureHandle::new(info);
            match unsafe { handle.import_texture(&s.device, &s.queue) } {
                Ok(texture) => {
                    let us = start.elapsed().as_micros() as u64;
                    let mut t = s.timings.lock().unwrap();
                    if t.first_frame_ms.is_none() { t.first_frame_ms = Some(hub().ms()); t.formats.push(format!("accelerated {:?} {}x{} {}", info.format, texture.width(), texture.height(), plane_note(info))); }
                    t.import_us.push(us);
                    drop(t);
                    *s.texture.lock().unwrap() = Some(texture);
                    s.frames.fetch_add(1, Ordering::Relaxed);
                    hub().accelerated_paints.fetch_add(1, Ordering::Relaxed);
                    if let Some(p) = s.proxy.lock().unwrap().as_ref() { let _ = p.send_event(()); }
                }
                Err(error) => {
                    let mut t = s.timings.lock().unwrap();
                    if t.errors.len() < 5 { t.errors.push(format!("{error}")); eprintln!("[embed] import failed: {error}"); }
                }
            }
        }
        fn on_paint(&self, _browser: Option<&mut Browser>, type_: PaintElementType, _dirty: Option<&[Rect]>, buffer: *const u8, width: ::std::os::raw::c_int, height: ::std::os::raw::c_int) {
            if type_ != PaintElementType::default() || buffer.is_null() || width <= 0 || height <= 0 { return }
            let s = &self.shared.0;
            let start = Instant::now();
            let (w, h) = (width as u32, height as u32);
            let bytes = unsafe { std::slice::from_raw_parts(buffer, (w * h * 4) as usize) };
            let mut slot = s.texture.lock().unwrap();
            let fits = slot.as_ref().map(|t| t.width() == w && t.height() == h).unwrap_or(false);
            if !fits {
                *slot = Some(s.device.create_texture(&wgpu::TextureDescriptor {
                    label: Some("page (software)"), size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
                    mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Bgra8Unorm,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST, view_formats: &[],
                }));
            }
            let texture = slot.as_ref().unwrap();
            s.queue.write_texture(
                wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                bytes,
                wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4 * w), rows_per_image: Some(h) },
                wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            );
            drop(slot);
            let us = start.elapsed().as_micros() as u64;
            let mut t = s.timings.lock().unwrap();
            if t.first_frame_ms.is_none() { t.first_frame_ms = Some(hub().ms()); t.formats.push(format!("software BGRA {w}x{h}")); }
            t.import_us.push(us);
            drop(t);
            s.frames.fetch_add(1, Ordering::Relaxed);
            hub().paints.fetch_add(1, Ordering::Relaxed);
            if let Some(p) = s.proxy.lock().unwrap().as_ref() { let _ = p.send_event(()); }
        }
    }
}

#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct Uniforms {
    viewport: [f32; 2],
    radius: f32,
    focused: f32,
    rect: [f32; 4],
    menu: [f32; 4],
}

const SHADER: &str = r#"
struct U { viewport: vec2<f32>, radius: f32, focused: f32, rect: vec4<f32>, menu: vec4<f32> };
@group(0) @binding(0) var page: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: U;
struct V { @builtin(position) pos: vec4<f32> };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  var o: V; o.pos = vec4(p[i], 0.0, 1.0); return o;
}
fn rounded(p: vec2<f32>, half: vec2<f32>, r: f32) -> f32 {
  let q = abs(p) - half + vec2(r);
  return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
}
@fragment fn fs(v: V) -> @location(0) vec4<f32> {
  let px = v.pos.xy;
  // Native chrome: a sidebar, a strip and the window background, as a stand-in for Sotto's own drawing.
  var bg = vec3(0.075, 0.08, 0.09);
  if (px.x < u.rect.x * 0.92) { bg = vec3(0.10, 0.11, 0.12); }
  if (px.y < u.rect.y * 0.7) { bg = vec3(0.06, 0.065, 0.07); }
  let center = u.rect.xy + u.rect.zw * 0.5;
  let d = rounded(px - center, u.rect.zw * 0.5, u.radius);
  let aa = clamp(0.5 - d, 0.0, 1.0);
  let uv = (px - u.rect.xy) / u.rect.zw;
  let c = textureSample(page, samp, clamp(uv, vec2(0.0), vec2(1.0))).rgb;
  // A focus ring outside the rounded edge when the page has the keyboard.
  let ring = u.focused * clamp(1.0 - abs(d - 3.0) / 1.5, 0.0, 1.0);
  let col = mix(bg, c, aa);
  let inmenu = px.x >= u.menu.x && px.y >= u.menu.y && px.x < u.menu.x + u.menu.z && px.y < u.menu.y + u.menu.w;
  if (inmenu) { return vec4(0.95, 0.62, 0.20, 1.0); }
  return vec4(mix(col, vec3(0.35, 0.55, 1.0), ring), 1.0);
}
"#;

struct Gfx {
    window: Arc<Window>,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    uniforms: wgpu::Buffer,
    placeholder: wgpu::Texture,
    present_us: Vec<u64>,
}

struct EmbedApp {
    shared: Arc<Shared>,
    instance: wgpu::Instance,
    gfx: Option<Gfx>,
    browser: Option<cef::Browser>,
    inside: bool,
    focused: bool,
    cursor: (f64, f64),
    deadline: Option<Instant>,
    events: Vec<String>,
    began: Instant,
    exit_written: bool,
    shot_taken: bool,
    input_plan: Option<(Instant, Vec<(Duration, Msg)>)>,
    log_once_done: bool,
}

fn page_rect(window: &Window) -> (f64, f64, f64, f64) {
    let size = window.inner_size().to_logical::<f64>(window.scale_factor());
    (LEFT, TOP, (size.width - LEFT - MARGIN).max(50.0), (size.height - TOP - MARGIN).max(50.0))
}

/// Applies one input record to a browser host. The in-process window and the helper process both use it.
pub fn apply_to_host(host: &BrowserHost, m: &Msg, view: &Mutex<(i32, i32)>) {
    use crate::wire::*;
    let event = cef::MouseEvent { x: m.i(1), y: m.i(2), modifiers: 0 };
    match m.kind() {
        MOVE => host.send_mouse_move_event(Some(&event), m.i(3)),
        CLICK => host.send_mouse_click_event(Some(&event), MouseButtonType::from(sys::cef_mouse_button_type_t::MBT_LEFT), m.i(3), 1),
        WHEEL => host.send_mouse_wheel_event(Some(&event), m.i(3), m.i(4)),
        FOCUS => host.set_focus(m.i(1)),
        RESIZE => { *view.lock().unwrap() = (m.i(1), m.i(2)); host.was_resized(); }
        KEY => {
            let stage = m.i(1);
            let mut k = cef::KeyEvent { windows_key_code: m.i(2), native_key_code: m.i(2), ..Default::default() };
            k.type_ = KeyEventType::from(match stage { 0 => sys::cef_key_event_type_t::KEYEVENT_RAWKEYDOWN, 1 => sys::cef_key_event_type_t::KEYEVENT_CHAR, _ => sys::cef_key_event_type_t::KEYEVENT_KEYUP });
            if stage == 1 { k.character = m.0[3] as u16; k.unmodified_character = m.0[3] as u16; k.windows_key_code = m.0[3] as i32; }
            host.send_key_event(Some(&k));
        }
        _ => {}
    }
}

impl EmbedApp {
    fn host(&self) -> Option<BrowserHost> {
        self.browser.as_ref().and_then(|b| b.host())
    }
    /// One input record to the page, wherever it runs.
    fn send(&self, m: Msg) -> bool {
        #[cfg(target_os = "windows")]
        if let Some(sent) = crate::remote_win::send(&m) { return sent }
        #[cfg(target_os = "linux")]
        if let Some(sock) = *self.shared.remote.lock().unwrap() { return crate::wire::send(sock, &m, None) }
        #[cfg(target_os = "macos")]
        if let Some(sent) = crate::remote_mac::send(&m) { return sent }
        match self.host() { Some(host) => { apply_to_host(&host, &m, &self.shared.view); true } None => false }
    }
    fn resize_view(&mut self) {
        let Some(gfx) = &self.gfx else { return };
        let (_, _, w, h) = page_rect(&gfx.window);
        // WP_VIEW=WxH renders the page at a fixed size (drawn scaled into the rectangle), to measure a real pane's cost
        // when the nested display is smaller than one.
        let fixed = std::env::var("WP_VIEW").ok().and_then(|v| { let (a, b) = v.split_once('x')?; Some((a.parse().ok()?, b.parse().ok()?)) });
        *self.shared.view.lock().unwrap() = fixed.unwrap_or((w.round() as i32, h.round() as i32));
        // WP_SCALE fixes the page's device scale factor (1 for the cost matrix, to match Linux); otherwise the display's.
        *self.shared.scale.lock().unwrap() = std::env::var("WP_SCALE").ok().and_then(|v| v.parse().ok()).unwrap_or(gfx.window.scale_factor() as f32);
        let (vw, vh) = *self.shared.view.lock().unwrap();
        #[cfg(target_os = "linux")]
        if let Some(sock) = *self.shared.remote.lock().unwrap() { crate::wire::send(sock, &Msg::new(crate::wire::RESIZE, &[vw as u32, vh as u32]), None); return }
        #[cfg(target_os = "windows")]
        if crate::remote_win::send(&Msg::new(crate::wire::RESIZE, &[vw as u32, vh as u32])).is_some() { return }
        #[cfg(target_os = "macos")]
        if crate::remote_mac::send(&Msg::new(crate::wire::RESIZE, &[vw as u32, vh as u32])).is_some() { return }
        let _ = (vw, vh);
        if let Some(host) = self.host() { host.was_resized(); }
    }
    fn draw(&mut self) {
        let Some(gfx) = &mut self.gfx else { return };
        let frame = match gfx.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(f) => f,
            wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
            _ => { gfx.surface.configure(&self.shared.device, &gfx.config); return }
        };
        let start = Instant::now();
        let scale = gfx.window.scale_factor() as f32;
        let (x, y, w, h) = page_rect(&gfx.window);
        let u = Uniforms { viewport: [gfx.config.width as f32, gfx.config.height as f32], radius: RADIUS * scale, focused: self.focused as i32 as f32, rect: [x as f32 * scale, y as f32 * scale, w as f32 * scale, h as f32 * scale], menu: if std::env::var("WP_MENU").is_ok() { [200.0 * scale, 40.0 * scale, 220.0 * scale, 160.0 * scale] } else { [0.0; 4] } };
        self.shared.queue.write_buffer(&gfx.uniforms, 0, bytemuck::bytes_of(&u));
        let page = self.shared.texture.lock().unwrap().clone().unwrap_or_else(|| gfx.placeholder.clone());
        let view = page.create_view(&wgpu::TextureViewDescriptor::default());
        let bind = self.shared.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None, layout: &gfx.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&gfx.sampler) },
                wgpu::BindGroupEntry { binding: 2, resource: gfx.uniforms.as_entire_binding() },
            ],
        });
        let target = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self.shared.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &target, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store }, depth_slice: None })],
                ..Default::default()
            });
            pass.set_pipeline(&gfx.pipeline);
            pass.set_bind_group(0, &bind, &[]);
            pass.draw(0..3, 0..1);
        }
        self.shared.queue.submit(Some(encoder.finish()));
        gfx.window.pre_present_notify();
        self.shared.queue.present(frame);
        gfx.present_us.push(start.elapsed().as_micros() as u64);
        let want: u64 = std::env::var("WP_SHOT_FRAMES").ok().and_then(|v| v.parse().ok()).unwrap_or(90);
        if !self.shot_taken && self.shared.frames.load(Ordering::Relaxed) >= want {
            if let Ok(path) = std::env::var("WP_SHOT") {
                self.shot_taken = true;
                let result = self.save_shot(&path, &bind);
                self.log(format!("self shot {path}: {result:?}"));
            }
        }
    }
    /// Draws the same pass into an offscreen texture and writes it as a 32-bit BMP: the window's own picture, for
    /// runners that do not grant screen recording.
    fn save_shot(&self, path: &str, bind: &wgpu::BindGroup) -> Result<(), String> {
        let Some(gfx) = &self.gfx else { return Err("no window".into()) };
        let (w, h) = (gfx.config.width, gfx.config.height);
        let device = &self.shared.device;
        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("shot"), size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1,
            dimension: wgpu::TextureDimension::D2, format: gfx.config.format, usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC, view_formats: &[],
        });
        let row = (w * 4).div_ceil(256) * 256;
        let buffer = device.create_buffer(&wgpu::BufferDescriptor { label: Some("shot"), size: (row * h) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
        let view = target.create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &view, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store }, depth_slice: None })],
                ..Default::default()
            });
            pass.set_pipeline(&gfx.pipeline);
            pass.set_bind_group(0, bind, &[]);
            pass.draw(0..3, 0..1);
        }
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo { texture: &target, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyBufferInfo { buffer: &buffer, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(h) } },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        self.shared.queue.submit(Some(encoder.finish()));
        let slice = buffer.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| { let _ = tx.send(r); });
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        rx.recv_timeout(Duration::from_secs(5)).map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
        let data = slice.get_mapped_range().map_err(|e| format!("{e:?}"))?;
        let mut bmp = Vec::with_capacity(54 + (w * h * 4) as usize);
        let size = 54 + w * h * 4;
        bmp.extend_from_slice(b"BM"); bmp.extend_from_slice(&size.to_le_bytes()); bmp.extend_from_slice(&[0; 4]); bmp.extend_from_slice(&54u32.to_le_bytes());
        bmp.extend_from_slice(&40u32.to_le_bytes()); bmp.extend_from_slice(&(w as i32).to_le_bytes()); bmp.extend_from_slice(&(-(h as i32)).to_le_bytes());
        bmp.extend_from_slice(&1u16.to_le_bytes()); bmp.extend_from_slice(&32u16.to_le_bytes()); bmp.extend_from_slice(&[0; 24]);
        let bgra = matches!(gfx.config.format, wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Bgra8UnormSrgb);
        for y in 0..h as usize {
            let line = &data[y * row as usize..y * row as usize + (w * 4) as usize];
            for px in line.chunks_exact(4) {
                if bgra { bmp.extend_from_slice(&[px[0], px[1], px[2], 255]); } else { bmp.extend_from_slice(&[px[2], px[1], px[0], 255]); }
            }
        }
        drop(data);
        buffer.unmap();
        std::fs::write(path, bmp).map_err(|e| e.to_string())
    }
    /// WP_SELF_INPUT: once the page shows, a click into its field (at 100,20 in the page, where anim.html puts it) and
    /// "across the socket" typed, each through `send`, the path winit's events take.
    fn self_input(&mut self) {
        if std::env::var("WP_SELF_INPUT").is_err() || self.shared.frames.load(Ordering::Relaxed) == 0 { return }
        let now = Instant::now();
        if self.input_plan.is_none() {
            let mut plan: Vec<(Duration, Msg)> = Vec::new();
            let at = |ms: u64| Duration::from_millis(1500 + ms);
            plan.push((at(0), Msg::new(crate::wire::FOCUS, &[1])));
            plan.push((at(10), Msg::new(crate::wire::MOVE, &[100, 20, 0])));
            plan.push((at(20), Msg::new(crate::wire::CLICK, &[100, 20, 0])));
            plan.push((at(60), Msg::new(crate::wire::CLICK, &[100, 20, 1])));
            for (i, c) in "across the socket".chars().enumerate() {
                let code = if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() as u32 } else { c as u32 };
                let t = 300 + i as u64 * 40;
                plan.push((at(t), Msg::new(crate::wire::KEY, &[0, code])));
                plan.push((at(t + 5), Msg::new(crate::wire::KEY, &[1, code, c as u32])));
                plan.push((at(t + 10), Msg::new(crate::wire::KEY, &[2, code])));
            }
            plan.push((at(1200), Msg::new(crate::wire::WHEEL, &[200, 200, 0, (-120i32) as u32])));
            self.input_plan = Some((now, plan));
            self.focused = true;
            self.log("self input planned".into());
        }
        let (began, plan) = self.input_plan.take().unwrap();
        let (due, rest): (Vec<_>, Vec<_>) = plan.into_iter().partition(|(t, _)| began + *t <= now);
        for (_, m) in due { let ok = self.send(m); if !ok { self.log(format!("self input not sent: kind {}", m.kind())); } }
        if !rest.is_empty() { self.log_once_done = false; } else if !self.log_once_done { self.log_once_done = true; self.log("self input sent".into()); }
        self.input_plan = Some((began, rest));
    }
    #[cfg(target_os = "linux")]
    fn shared_handle(&self) -> crate::remote::Handle {
        crate::remote::Handle(self.shared.clone())
    }
    fn log(&mut self, e: String) {
        if self.events.len() < 400 { self.events.push(format!("{:.0} {e}", self.began.elapsed().as_secs_f64() * 1000.0)); }
    }
    fn write_stats(&mut self) {
        if self.exit_written { return }
        self.exit_written = true;
        let t = self.shared.timings.lock().unwrap();
        let mut import = t.import_us.clone();
        import.sort();
        let pct = |v: &Vec<u64>, p: f64| -> u64 { if v.is_empty() { 0 } else { v[((v.len() - 1) as f64 * p) as usize] } };
        let mut present = self.gfx.as_ref().map(|g| g.present_us.clone()).unwrap_or_default();
        present.sort();
        let secs = self.began.elapsed().as_secs_f64();
        let stats = serde_json::json!({
            "path": if self.shared.accelerated { "accelerated" } else { "software" },
            "seconds": secs,
            "frames": self.shared.frames.load(Ordering::Relaxed),
            "fps": self.shared.frames.load(Ordering::Relaxed) as f64 / secs,
            "first_frame_ms": t.first_frame_ms,
            "import_us": { "p50": pct(&import, 0.5), "p95": pct(&import, 0.95), "max": import.last().copied().unwrap_or(0), "n": import.len() },
            "present_us": { "p50": pct(&present, 0.5), "p95": pct(&present, 0.95), "n": present.len() },
            "formats": t.formats, "errors": t.errors, "cycles": t.cycles,
            "events": self.events,
            "page_console": hub().console.lock().unwrap().iter().filter(|m| m.starts_with("EVT")).cloned().collect::<Vec<_>>(),
            "adapter": self.shared.adapter,
            "page_scale": *self.shared.scale.lock().unwrap(),
            "view": *self.shared.view.lock().unwrap(),
            "window": self.gfx.as_ref().map(|g| { let s = g.window.inner_size(); (s.width, s.height, g.window.scale_factor()) }),
        });
        let dir = std::env::var("WP_RUN_DIR").unwrap_or(".".into());
        std::fs::write(format!("{dir}/embed.json"), serde_json::to_string_pretty(&stats).unwrap()).ok();
        eprintln!("[embed] wrote stats");
    }
}

fn vk(key: &Key) -> Option<(i32, Option<char>)> {
    match key {
        Key::Named(NamedKey::Enter) => Some((13, Some('\r'))),
        Key::Named(NamedKey::Backspace) => Some((8, None)),
        Key::Named(NamedKey::Tab) => Some((9, None)),
        Key::Named(NamedKey::Escape) => Some((27, None)),
        Key::Named(NamedKey::Space) => Some((32, Some(' '))),
        Key::Named(NamedKey::ArrowLeft) => Some((37, None)),
        Key::Named(NamedKey::ArrowUp) => Some((38, None)),
        Key::Named(NamedKey::ArrowRight) => Some((39, None)),
        Key::Named(NamedKey::ArrowDown) => Some((40, None)),
        Key::Character(s) => {
            let c = s.chars().next()?;
            let code = if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() as i32 } else { 0 };
            Some((code, Some(c)))
        }
        _ => None,
    }
}

impl ApplicationHandler for EmbedApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.gfx.is_some() { return }
        let window = Arc::new(event_loop.create_window(WindowAttributes::default().with_title("Sotto web pane spike").with_inner_size(winit::dpi::LogicalSize::new(1280.0, 800.0))).unwrap());
        let surface = self.instance.create_surface(window.clone()).unwrap();
        let size = window.inner_size();
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT, format: wgpu::TextureFormat::Bgra8Unorm, color_space: wgpu::SurfaceColorSpace::Auto,
            view_formats: vec![], alpha_mode: wgpu::CompositeAlphaMode::Auto, width: size.width.max(1), height: size.height.max(1),
            desired_maximum_frame_latency: 2, present_mode: wgpu::PresentMode::AutoVsync,
        };
        surface.configure(&self.shared.device, &config);
        let device = &self.shared.device;
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: None,
            entries: &[
                wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { multisampled: false, view_dimension: wgpu::TextureViewDimension::D2, sample_type: wgpu::TextureSampleType::Float { filterable: true } }, count: None },
                wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
                wgpu::BindGroupLayoutEntry { binding: 2, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None },
            ],
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: None, source: wgpu::ShaderSource::Wgsl(SHADER.into()) });
        let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: None, layout: Some(&pl),
            vertex: wgpu::VertexState { module: &shader, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState { module: &shader, entry_point: Some("fs"), targets: &[Some(wgpu::ColorTargetState { format: config.format, blend: None, write_mask: wgpu::ColorWrites::ALL })], compilation_options: Default::default() }),
            primitive: wgpu::PrimitiveState::default(), depth_stencil: None, multisample: wgpu::MultisampleState::default(), multiview_mask: None, cache: None,
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor { mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, ..Default::default() });
        let uniforms = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: std::mem::size_of::<Uniforms>() as u64, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let placeholder = device.create_texture(&wgpu::TextureDescriptor { label: None, size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Bgra8Unorm, usage: wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] });
        self.gfx = Some(Gfx { window: window.clone(), surface, config, pipeline, layout, sampler, uniforms, placeholder, present_us: Vec::new() });
        self.resize_view();

        #[cfg(target_os = "linux")]
        if std::env::var("WP_REMOTE").is_ok() {
            crate::remote::start_controller(self.shared_handle(), window.clone());
            window.request_redraw();
            return;
        }
        #[cfg(target_os = "macos")]
        if std::env::var("WP_REMOTE").is_ok() {
            crate::remote_mac::start_controller(self.shared.clone(), window.clone());
            window.request_redraw();
            return;
        }
        #[cfg(target_os = "windows")]
        if std::env::var("WP_REMOTE").is_ok() {
            use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
            let hwnd = match window.window_handle().map(|h| h.as_raw()) { Ok(RawWindowHandle::Win32(h)) => h.hwnd.get() as u64, _ => 0 };
            let (x, y, w, h) = page_rect(&window);
            let s = window.scale_factor();
            crate::remote_win::start_controller(self.shared.clone(), window.clone(), hwnd, ((x * s) as i32, (y * s) as i32, (w * s) as i32, (h * s) as i32));
            window.request_redraw();
            return;
        }
        // The page: CEF off screen, its frames into the shared slot.
        let window_info = WindowInfo { windowless_rendering_enabled: 1, shared_texture_enabled: self.shared.accelerated as i32, ..Default::default() };
        let settings = BrowserSettings { windowless_frame_rate: 60, ..Default::default() };
        let mut client = SpikeClient::new(Some(EmbedRender::new(SharedRef(self.shared.clone()))));
        let url = std::env::var("WP_URL").unwrap_or_else(|_| "http://127.0.0.1:8765/anim.html".into());
        // macOS: this is CEF's UI thread (the main thread, pumped by hand), so create the browser here and now.
        #[cfg(target_os = "macos")]
        let created = {
            self.browser = browser_host_create_browser_sync(Some(&window_info), Some(&mut client), Some(&CefString::from(url.as_str())), Some(&settings), None, None);
            -1
        };
        #[cfg(not(target_os = "macos"))]
        let created = {
            let created = browser_host_create_browser(Some(&window_info), Some(&mut client), Some(&CefString::from(url.as_str())), Some(&settings), None, None);
            let deadline = Instant::now() + Duration::from_secs(10);
            while cefapp::LAST_BROWSER.lock().unwrap().is_none() && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(5)); }
            self.browser = cefapp::LAST_BROWSER.lock().unwrap().as_ref().map(|b| b.0.clone());
            created
        };
        self.log(format!("browser create asked={created} created={}", self.browser.is_some()));
        window.request_redraw();
    }

    fn user_event(&mut self, _event_loop: &ActiveEventLoop, _event: ()) {
        if let Some(g) = &self.gfx { g.window.request_redraw(); }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        self.self_input();
        if let Some(deadline) = self.deadline {
            if Instant::now() >= deadline { self.write_stats(); event_loop.exit(); }
            else { event_loop.set_control_flow(ControlFlow::WaitUntil(deadline)); }
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => { self.write_stats(); event_loop.exit(); }
            WindowEvent::RedrawRequested => self.draw(),
            WindowEvent::Resized(size) => {
                if let Some(g) = &mut self.gfx { g.config.width = size.width.max(1); g.config.height = size.height.max(1); g.surface.configure(&self.shared.device, &g.config); }
                self.resize_view();
                self.log(format!("resized {}x{}", size.width, size.height));
            }
            WindowEvent::Focused(f) => {
                self.log(format!("window focused={f}"));
                if !f { self.send(Msg::new(crate::wire::FOCUS, &[0])); }
                else if self.focused { self.send(Msg::new(crate::wire::FOCUS, &[1])); }
            }
            WindowEvent::CursorMoved { position, .. } => {
                let Some(g) = &self.gfx else { return };
                let p = position.to_logical::<f64>(g.window.scale_factor());
                self.cursor = (p.x, p.y);
                let (x, y, w, h) = page_rect(&g.window);
                let inside = p.x >= x && p.y >= y && p.x < x + w && p.y < y + h;
                let (px, py) = ((p.x - x) as i32 as u32, (p.y - y) as i32 as u32);
                if inside { self.send(Msg::new(crate::wire::MOVE, &[px, py, 0])); }
                else if self.inside { self.send(Msg::new(crate::wire::MOVE, &[px, py, 1])); }
                if inside != self.inside { self.log(format!("pointer {} the page at {:.0},{:.0}", if inside { "entered" } else { "left" }, p.x, p.y)); }
                self.inside = inside;
            }
            WindowEvent::MouseInput { state, button: MouseButton::Left, .. } => {
                let Some(g) = &self.gfx else { return };
                let (x, y, _, _) = page_rect(&g.window);
                let (cx, cy) = self.cursor;
                if self.inside {
                    if !self.focused { self.focused = true; self.send(Msg::new(crate::wire::FOCUS, &[1])); self.log("page took focus".into()); }
                    self.send(Msg::new(crate::wire::CLICK, &[(cx - x) as i32 as u32, (cy - y) as i32 as u32, (state == ElementState::Released) as u32]));
                    self.log(format!("click {:?} forwarded at page {:.0},{:.0}", state, cx - x, cy - y));
                } else if state == ElementState::Pressed {
                    if self.focused { self.focused = false; self.send(Msg::new(crate::wire::FOCUS, &[0])); self.log("native UI took focus".into()); }
                }
                if let Some(g) = &self.gfx { g.window.request_redraw(); }
            }
            WindowEvent::MouseWheel { delta, .. } => {
                if !self.inside { return }
                let Some(g) = &self.gfx else { return };
                let (x, y, _, _) = page_rect(&g.window);
                let (dx, dy) = match delta { MouseScrollDelta::LineDelta(a, b) => (a * 40.0, b * 40.0), MouseScrollDelta::PixelDelta(p) => (p.x as f32, p.y as f32) };
                self.send(Msg::new(crate::wire::WHEEL, &[(self.cursor.0 - x) as i32 as u32, (self.cursor.1 - y) as i32 as u32, dx as i32 as u32, dy as i32 as u32]));
                self.log(format!("wheel {dx},{dy} forwarded"));
            }
            WindowEvent::KeyboardInput { event, .. } => {
                if !self.focused { self.log(format!("key {:?} kept by native UI", event.logical_key)); return }
                let Some((code, ch)) = vk(&event.logical_key) else { return };
                if event.state == ElementState::Pressed {
                    self.send(Msg::new(crate::wire::KEY, &[0, code as u32]));
                    if let Some(c) = ch {
                        let mut c16 = [0u16; 2];
                        c.encode_utf16(&mut c16);
                        self.send(Msg::new(crate::wire::KEY, &[1, code as u32, c16[0] as u32]));
                    }
                } else {
                    self.send(Msg::new(crate::wire::KEY, &[2, code as u32]));
                }
                self.log(format!("key {:?} {:?} forwarded", event.logical_key, event.state));
            }
            _ => {}
        }
    }
}

pub fn run(args: &cef::args::Args, app: &mut cef::App, mode: &str) -> ExitCode {
    if mode == "child" { return run_child(args, app); }
    let accelerated = std::env::var("WP_PATH").map(|p| p != "software").unwrap_or(true);
    // wgpu first: the Vulkan device CEF's dmabufs are imported into.
    // The importer cef-rs ships: dmabuf into Vulkan on Linux, D3D11 shared handles into D3D12 on Windows, IOSurface
    // into Metal on macOS.
    #[cfg(target_os = "linux")]
    let backends = wgpu::Backends::VULKAN;
    #[cfg(target_os = "windows")]
    let backends = wgpu::Backends::DX12;
    #[cfg(target_os = "macos")]
    let backends = wgpu::Backends::METAL;
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor { backends, ..wgpu::InstanceDescriptor::new_without_display_handle() });
    // WP_POWER=high asks for the discrete GPU on a hybrid laptop; the default is the adapter the OS lists first.
    let power_preference = if std::env::var("WP_POWER").as_deref() == Ok("high") { wgpu::PowerPreference::HighPerformance } else if std::env::var("WP_POWER").as_deref() == Ok("low") { wgpu::PowerPreference::LowPower } else { wgpu::PowerPreference::None };
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions { power_preference, ..Default::default() })).expect("adapter");
    let info = adapter.get_info();
    let adapter_name = format!("{} ({:?}, {:?})", info.name, info.backend, info.device_type);
    eprintln!("[embed] adapter {} {:?} driver {}", info.name, info.backend, info.driver_info);
    #[cfg(target_os = "linux")]
    let features = if accelerated { wgpu::Features::VULKAN_EXTERNAL_MEMORY_DMA_BUF } else { wgpu::Features::empty() };
    #[cfg(not(target_os = "linux"))]
    let features = wgpu::Features::empty();
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { required_features: features, ..Default::default() })).expect("device");

    let config = cefapp::config();
    let run_dir = std::env::var("WP_RUN_DIR").unwrap_or(".".into());
    let remote = std::env::var("WP_REMOTE").is_ok();
    let settings = Settings {
        windowless_rendering_enabled: 1,
        #[cfg(not(target_os = "macos"))]
        multi_threaded_message_loop: 1,
        #[cfg(target_os = "macos")]
        external_message_pump: 1,
        #[cfg(target_os = "macos")]
        no_sandbox: std::env::var("WP_NO_SANDBOX").is_ok() as i32,
        root_cache_path: CefString::from(config.root_cache.as_str()),
        log_file: CefString::from(format!("{run_dir}/cef.log").as_str()),
        log_severity: LogSeverity::from(sys::cef_log_severity_t::LOGSEVERITY_WARNING),
        ..Default::default()
    };
    // In the helper-process shape this process never starts CEF: the page lives in a child it starts and ends.
    if !remote {
        if initialize(Some(args.as_main_args()), Some(&settings), Some(app), std::ptr::null_mut()) != 1 {
            eprintln!("CEF initialize failed");
            return ExitCode::from(2);
        }
        // macOS: nothing happens in CEF unless this thread pumps it, the context's start included.
        #[cfg(target_os = "macos")]
        {
            let deadline = Instant::now() + Duration::from_secs(20);
            while !hub().wait_ready(Duration::ZERO) && Instant::now() < deadline { do_message_loop_work(); std::thread::sleep(Duration::from_millis(2)); }
        }
        #[cfg(not(target_os = "macos"))]
        hub().wait_ready(Duration::from_secs(20));
    }

    let shared = Arc::new(Shared { device, queue, texture: Mutex::new(None), timings: Mutex::new(Timings::default()), view: Mutex::new((1000, 700)), scale: Mutex::new(1.0), proxy: Mutex::new(None), frames: AtomicU64::new(0), accelerated, remote: Mutex::new(None), view_pub: (), adapter: adapter_name });
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut event_loop = EventLoop::new().unwrap();
    *shared.proxy.lock().unwrap() = Some(event_loop.create_proxy());
    let seconds: u64 = std::env::var("WP_EMBED_SECONDS").ok().and_then(|s| s.parse().ok()).unwrap_or(0);
    let mut app_state = EmbedApp { shared: shared.clone(), instance, gfx: None, browser: None, inside: false, focused: false, cursor: (0.0, 0.0), deadline: (seconds > 0).then(|| Instant::now() + Duration::from_secs(seconds)), events: Vec::new(), began: Instant::now(), exit_written: false, shot_taken: false, input_plan: None, log_once_done: false };
    event_loop.set_control_flow(ControlFlow::Wait);
    #[cfg(target_os = "macos")]
    if !remote {
        // CEF's work and winit's events take turns on the main thread.
        use winit::platform::pump_events::{EventLoopExtPumpEvents, PumpStatus};
        loop {
            do_message_loop_work();
            if let PumpStatus::Exit(_) = event_loop.pump_app_events(Some(Duration::from_millis(2)), &mut app_state) { break }
        }
    } else {
        let _ = event_loop.run_app(&mut app_state);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = event_loop.run_app(&mut app_state);
    app_state.write_stats();
    #[cfg(target_os = "linux")]
    if remote { crate::remote::stop_all(); return ExitCode::SUCCESS }
    #[cfg(target_os = "windows")]
    if remote { crate::remote_win::stop_all(); return ExitCode::SUCCESS }
    #[cfg(target_os = "macos")]
    if remote { crate::remote_mac::stop_all(); return ExitCode::SUCCESS }
    if let Some(host) = app_state.host() { host.close_browser(1); }
    let deadline = Instant::now() + Duration::from_secs(5);
    while !hub().closed.load(Ordering::SeqCst) && Instant::now() < deadline {
        #[cfg(target_os = "macos")]
        do_message_loop_work();
        std::thread::sleep(Duration::from_millis(20));
    }
    *shared.proxy.lock().unwrap() = None;
    drop(app_state);
    shutdown();
    ExitCode::SUCCESS
}

// ------------------------------------------------------------------ the child-window path

struct ChildApp {
    window: Option<Arc<Window>>,
    browser: Option<cef::Browser>,
    deadline: Option<Instant>,
    note: Arc<AtomicBool>,
}

impl ApplicationHandler for ChildApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() { return }
        let window = Arc::new(event_loop.create_window(WindowAttributes::default().with_title("Sotto web pane spike (child window)").with_inner_size(winit::dpi::LogicalSize::new(1280.0, 800.0))).unwrap());
        use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
        let handle = window.window_handle().map(|h| h.as_raw());
        let parent = match handle {
            #[cfg(target_os = "windows")]
            Ok(RawWindowHandle::Win32(h)) => h.hwnd.get() as u64,
            Ok(RawWindowHandle::Xlib(h)) => h.window as u64,
            Ok(RawWindowHandle::Xcb(h)) => h.window.get() as u64,
            Ok(other) => { hub().note(format!("winit window is {other:?}: CEF on Linux takes only an X11 window as parent")); 0 }
            Err(e) => { hub().note(format!("no window handle: {e}")); 0 }
        };
        hub().note(format!("parent window id {parent:#x}"));
        let (x, y, w, h) = page_rect(&window);
        let s = window.scale_factor();
        // set_as_child also sets the Windows style (WS_CHILD | WS_VISIBLE | ...); without it CEF makes a hidden
        // top-level window owned by the parent, not a child.
        let window_info = WindowInfo {
            runtime_style: RuntimeStyle::from(sys::cef_runtime_style_t::CEF_RUNTIME_STYLE_ALLOY),
            ..Default::default()
        }.set_as_child(parent_handle(parent), &Rect { x: (x * s) as i32, y: (y * s) as i32, width: (w * s) as i32, height: (h * s) as i32 });
        let settings = BrowserSettings::default();
        let mut client = SpikeClient::new(None);
        let url = std::env::var("WP_URL").unwrap_or_else(|_| "http://127.0.0.1:8765/anim.html".into());
        browser_host_create_browser(Some(&window_info), Some(&mut client), Some(&CefString::from(url.as_str())), Some(&settings), None, None);
        let deadline = Instant::now() + Duration::from_secs(10);
        while cefapp::LAST_BROWSER.lock().unwrap().is_none() && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(5)); }
        self.browser = cefapp::LAST_BROWSER.lock().unwrap().as_ref().map(|b| b.0.clone());
        hub().note(format!("windowed browser created={} handle={:#x}", self.browser.is_some(), self.browser.as_ref().and_then(|b| b.host()).map(|h| handle_value(h.window_handle())).unwrap_or(0)));
        self.window = Some(window);
        let _ = &self.note;
    }
    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        if let Some(deadline) = self.deadline {
            if Instant::now() >= deadline { event_loop.exit(); } else { event_loop.set_control_flow(ControlFlow::WaitUntil(deadline)); }
        }
    }
    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::Resized(_) => {
                // A child window is the app's to move: CEF does not follow the parent's layout.
                hub().note("parent resized; the child's bounds must be moved by hand (XMoveResizeWindow)".to_string());
            }
            _ => {}
        }
    }
}

fn run_child(args: &cef::args::Args, app: &mut cef::App) -> ExitCode {
    let config = cefapp::config();
    let run_dir = std::env::var("WP_RUN_DIR").unwrap_or(".".into());
    let settings = Settings {
        multi_threaded_message_loop: 1,
        root_cache_path: CefString::from(config.root_cache.as_str()),
        log_file: CefString::from(format!("{run_dir}/cef.log").as_str()),
        log_severity: LogSeverity::from(sys::cef_log_severity_t::LOGSEVERITY_WARNING),
        ..Default::default()
    };
    if initialize(Some(args.as_main_args()), Some(&settings), Some(app), std::ptr::null_mut()) != 1 {
        eprintln!("CEF initialize failed");
        return ExitCode::from(2);
    }
    hub().wait_ready(Duration::from_secs(20));
    let event_loop = EventLoop::new().unwrap();
    let seconds: u64 = std::env::var("WP_EMBED_SECONDS").ok().and_then(|s| s.parse().ok()).unwrap_or(0);
    let mut state = ChildApp { window: None, browser: None, deadline: (seconds > 0).then(|| Instant::now() + Duration::from_secs(seconds)), note: Arc::new(AtomicBool::new(false)) };
    let _ = event_loop.run_app(&mut state);
    if let Some(host) = state.browser.as_ref().and_then(|b| b.host()) { host.close_browser(1); }
    let deadline = Instant::now() + Duration::from_secs(5);
    while !hub().closed.load(Ordering::SeqCst) && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(20)); }
    let dir = run_dir;
    std::fs::write(format!("{dir}/child.json"), serde_json::to_string_pretty(&hub().summary()).unwrap()).ok();
    drop(state);
    shutdown();
    ExitCode::SUCCESS
}

#[allow(dead_code)]
fn _unused(_s: SendShared) {}

#[cfg(target_os = "linux")]
fn plane_note(info: &AcceleratedPaintInfo) -> String { format!("planes={} modifier={:#x}", info.plane_count, info.modifier) }
#[cfg(target_os = "windows")]
fn plane_note(info: &AcceleratedPaintInfo) -> String { format!("nt-handle={:p}", info.shared_texture_handle) }
#[cfg(target_os = "macos")]
fn plane_note(_info: &AcceleratedPaintInfo) -> String { "iosurface".into() }

/// CEF's native window handle: an X11 id on Linux, an HWND on Windows, an NSView pointer on macOS.
#[cfg(target_os = "windows")]
pub fn parent_handle(v: u64) -> cef::sys::HWND { cef::sys::HWND(v as *mut _) }
#[cfg(target_os = "linux")]
pub fn parent_handle(v: u64) -> std::os::raw::c_ulong { v as _ }
#[cfg(target_os = "macos")]
pub fn parent_handle(v: u64) -> *mut std::os::raw::c_void { v as _ }
#[cfg(target_os = "windows")]
pub fn handle_value(h: cef::sys::HWND) -> u64 { h.0 as u64 }
#[cfg(target_os = "linux")]
pub fn handle_value(h: std::os::raw::c_ulong) -> u64 { h as u64 }
#[cfg(target_os = "macos")]
pub fn handle_value(h: *mut std::os::raw::c_void) -> u64 { h as u64 }
