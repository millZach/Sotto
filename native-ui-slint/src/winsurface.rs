//! The web pane's two Windows questions, as experiments beside the default image path
//! (`--web-surface child|shared`). Neither embeds Chromium; each stands in for how a Chromium
//! helper would hand its page over on Windows.
//!
//! - `child`: a real Win32 child window (`WS_CHILD`), painted by GDI on the UI thread, kept at
//!   the pane surface's rectangle with a rounded window region. Does it show over Slint's surface?
//! - `shared`: a producer thread with its own D3D11 device paints the stand-in page with Direct2D
//!   into a texture created with `D3D11_RESOURCE_MISC_SHARED_NTHANDLE | SHARED_KEYEDMUTEX`, and
//!   hands over only the NT handle, as Chromium's GPU process does (CEF's `OnAcceleratedPaint`).
//!   Slint's side opens the handle on a D3D11 device of its own, maps the texture into OpenGL with
//!   `WGL_NV_DX_interop2`, copies it on the GPU (`glCopyImageSubData`) into one of two textures and
//!   shows that as a `BorrowedOpenGLTexture`. No pixel passes through the CPU. OpenGL renderers only
//!   (Skia over OpenGL, femtovg); the rendering notifier is where Slint's GL context is current.

use crate::AppWindow;
use slint::ComponentHandle;
use std::cell::RefCell;
use std::ffi::{CStr, c_void};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Direct2D::Common::*;
use windows::Win32::Graphics::Direct2D::*;
use windows::Win32::Graphics::Direct3D::*;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::DirectWrite::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::{BOOL, Interface, PCWSTR, w};
const INFINITE: u32 = u32::MAX;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Image,
    Child,
    Shared,
}

pub fn mode_from(arg: &str) -> Mode {
    match arg {
        "child" => Mode::Child,
        "shared" => Mode::Shared,
        _ => Mode::Image,
    }
}

fn hwnd_of(ui: &AppWindow) -> Option<HWND> {
    use slint::winit_030::WinitWindowAccessor;
    use slint::winit_030::winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
    ui.window()
        .with_winit_window(|w| match w.window_handle().ok()?.as_raw() {
            RawWindowHandle::Win32(h) => Some(HWND(h.hwnd.get() as *mut c_void)),
            _ => None,
        })
        .flatten()
}

/// The surface's rectangle in the window's client area, in physical pixels.
fn surface_rect(ui: &AppWindow) -> (i32, i32, i32, i32) {
    let s = ui.window().scale_factor();
    let r = |v: f32| (v * s).round() as i32;
    (r(ui.get_web_surface_x()), r(ui.get_web_surface_y()), r(ui.get_web_surface_width()), r(ui.get_web_surface_height()))
}

// ---------------------------------------------------------------- child window

thread_local! {
    static CHILD: RefCell<Option<(HWND, (i32, i32, i32, i32))>> = const { RefCell::new(None) };
}
static CHILD_TICK: AtomicU64 = AtomicU64::new(0);

unsafe extern "system" fn child_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe {
        match msg {
            WM_PAINT => {
                let mut ps = PAINTSTRUCT::default();
                let dc = BeginPaint(hwnd, &mut ps);
                let mut rc = RECT::default();
                let _ = GetClientRect(hwnd, &mut rc);
                let white = CreateSolidBrush(COLORREF(0x00ffffff));
                FillRect(dc, &rc, white);
                let _ = DeleteObject(white.into());
                // A stripe that moves twice a second, so a stale frame shows.
                let tick = CHILD_TICK.load(Ordering::Relaxed) as i32;
                let w = (rc.right - rc.left).max(1);
                let x = (tick * 37) % w;
                let teal = CreateSolidBrush(COLORREF(0x00807a1f));
                let stripe = RECT { left: x, top: 0, right: x + w / 6, bottom: 6 };
                FillRect(dc, &stripe, teal);
                let _ = DeleteObject(teal.into());
                let _ = SetBkMode(dc, TRANSPARENT);
                let _ = SetTextColor(dc, COLORREF(0x00202020));
                let mut text: Vec<u16> = "Stand-in page in a Win32 child window (GDI)".encode_utf16().collect();
                let mut tr = RECT { left: 16, top: 24, right: rc.right - 16, bottom: rc.bottom };
                let _ = DrawTextW(dc, &mut text, &mut tr, DT_LEFT | DT_WORDBREAK);
                let _ = EndPaint(hwnd, &ps);
                LRESULT(0)
            }
            WM_TIMER => {
                CHILD_TICK.fetch_add(1, Ordering::Relaxed);
                let _ = InvalidateRect(Some(hwnd), None, false);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }
}

fn place_child(ui: &AppWindow) {
    let rect = surface_rect(ui);
    CHILD.with(|c| {
        let mut c = c.borrow_mut();
        if c.is_none() {
            let Some(parent) = hwnd_of(ui) else { return };
            unsafe {
                let instance = GetModuleHandleW(None).unwrap_or_default();
                let class = w!("SottoStandInChild");
                let wc = WNDCLASSW { lpfnWndProc: Some(child_proc), hInstance: instance.into(), lpszClassName: class, hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(), ..Default::default() };
                RegisterClassW(&wc);
                let style = WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS;
                match CreateWindowExW(WINDOW_EX_STYLE(0), class, w!("Stand-in page"), style, rect.0, rect.1, rect.2, rect.3, Some(parent), None, Some(instance.into()), None) {
                    Ok(h) => {
                        let _ = SetTimer(Some(h), 1, 500, None);
                        eprintln!("event=web-child-created x={} y={} w={} h={}", rect.0, rect.1, rect.2, rect.3);
                        *c = Some((h, (0, 0, 0, 0)));
                    }
                    Err(e) => eprintln!("event=web-child-failed error={e}"),
                }
            }
        }
        if let Some((h, last)) = c.as_mut()
            && *last != rect
        {
            *last = rect;
            unsafe {
                let _ = SetWindowPos(*h, None, rect.0, rect.1, rect.2, rect.3, SWP_NOZORDER | SWP_NOACTIVATE);
                // GDI regions are not anti-aliased: the corner is a staircase, unlike Slint's clip.
                let radius = (12.0 * ui.window().scale_factor()).round() as i32;
                let rgn = CreateRoundRectRgn(0, 0, rect.2 + 1, rect.3 + 1, radius, radius);
                let _ = SetWindowRgn(*h, Some(rgn), true);
            }
        }
    });
}

// ---------------------------------------------------------------- shared texture

type GlGetString = unsafe extern "system" fn(u32) -> *const u8;
type GlGenTextures = unsafe extern "system" fn(i32, *mut u32);
type GlCreateTextures = unsafe extern "system" fn(u32, i32, *mut u32);
type GlTextureStorage2D = unsafe extern "system" fn(u32, i32, u32, i32, i32);
type GlCopyImageSubData = unsafe extern "system" fn(u32, u32, i32, i32, i32, i32, u32, u32, i32, i32, i32, i32, i32, i32, i32);
type GlGetError = unsafe extern "system" fn() -> u32;
type WglDXOpenDeviceNV = unsafe extern "system" fn(*mut c_void) -> HANDLE;
type WglDXRegisterObjectNV = unsafe extern "system" fn(HANDLE, *mut c_void, u32, u32, u32) -> HANDLE;
type WglDXLockObjectsNV = unsafe extern "system" fn(HANDLE, i32, *mut HANDLE) -> BOOL;
type WglDXUnlockObjectsNV = unsafe extern "system" fn(HANDLE, i32, *mut HANDLE) -> BOOL;

const GL_TEXTURE_2D: u32 = 0x0DE1;
const GL_RGBA8: u32 = 0x8058;
const GL_VENDOR: u32 = 0x1F00;
const GL_RENDERER: u32 = 0x1F01;
const WGL_ACCESS_READ_ONLY_NV: u32 = 0;

/// What the producer thread shares with the UI thread: the NT handle, and that a frame is ready.
struct Shared {
    handle: HANDLE,
    width: u32,
    height: u32,
    adapter_luid: LUID,
    fresh: AtomicBool,
    frames: AtomicU64,
}
unsafe impl Send for Shared {}
unsafe impl Sync for Shared {}

struct Consumer {
    shared: Arc<Shared>,
    #[allow(dead_code)]
    device: ID3D11Device,
    /// When the driver will not register the shared texture: a texture of this device, and its context.
    local: Option<(ID3D11Texture2D, ID3D11DeviceContext)>,
    shared_texture: ID3D11Texture2D,
    mutex: IDXGIKeyedMutex,
    interop_device: HANDLE,
    interop_object: HANDLE,
    interop_texture: u32,
    display: [u32; 2],
    /// Which display texture the image shows; the next copy goes there.
    target: usize,
    pending: bool,
    lock: WglDXLockObjectsNV,
    unlock: WglDXUnlockObjectsNV,
    copy: GlCopyImageSubData,
    get_error: GlGetError,
    copy_times: Vec<f64>,
}

thread_local! {
    static CONSUMER: RefCell<Option<Consumer>> = const { RefCell::new(None) };
    static SHARED: RefCell<Option<Arc<Shared>>> = const { RefCell::new(None) };
    static UI: RefCell<Option<slint::Weak<AppWindow>>> = const { RefCell::new(None) };
}

fn adapter_for(vendor: &str) -> Option<(IDXGIAdapter1, LUID, String)> {
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().ok()?;
        let mut first = None;
        for i in 0.. {
            let Ok(a) = factory.EnumAdapters1(i) else { break };
            let Ok(desc) = a.GetDesc1() else { continue };
            let name = String::from_utf16_lossy(&desc.Description).trim_end_matches('\0').to_string();
            if first.is_none() {
                first = Some((a.clone(), desc.AdapterLuid, name.clone()));
            }
            if !vendor.is_empty() && name.to_lowercase().contains(&vendor.to_lowercase()) {
                return Some((a, desc.AdapterLuid, name));
            }
        }
        first
    }
}

fn create_device(adapter: &IDXGIAdapter1) -> windows::core::Result<(ID3D11Device, ID3D11DeviceContext)> {
    let mut device = None;
    let mut context = None;
    unsafe {
        D3D11CreateDevice(
            &adapter.cast::<IDXGIAdapter>()?,
            D3D_DRIVER_TYPE_UNKNOWN,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&[D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0]),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )?;
    }
    Ok((device.unwrap(), context.unwrap()))
}

/// The producer: the stand-in for Chromium's GPU process. It owns its device and texture and
/// hands over only the NT handle. Painting is Direct2D and DirectWrite on the GPU.
fn start_producer(adapter: IDXGIAdapter1, luid: LUID, width: u32, height: u32, reduced: Arc<AtomicBool>, ui: slint::Weak<AppWindow>) -> windows::core::Result<Arc<Shared>> {
    let (tx, rx) = std::sync::mpsc::channel::<windows::core::Result<Arc<Shared>>>();
    std::thread::Builder::new()
        .name("shared-texture-page".into())
        .spawn(move || {
            let run = || -> windows::core::Result<()> {
                let (device, context) = create_device(&adapter)?;
                let desc = D3D11_TEXTURE2D_DESC {
                    Width: width,
                    Height: height,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                    Usage: D3D11_USAGE_DEFAULT,
                    BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
                    CPUAccessFlags: 0,
                    MiscFlags: (D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0 | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0) as u32,
                };
                let mut texture = None;
                unsafe { device.CreateTexture2D(&desc, None, Some(&mut texture))? };
                let texture = texture.unwrap();
                let handle = unsafe { texture.cast::<IDXGIResource1>()?.CreateSharedHandle(None, DXGI_SHARED_RESOURCE_READ.0 | DXGI_SHARED_RESOURCE_WRITE.0, PCWSTR::null())? };
                let mutex: IDXGIKeyedMutex = texture.cast()?;
                let d2d: ID2D1Factory = unsafe { D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None)? };
                let props = D2D1_RENDER_TARGET_PROPERTIES {
                    r#type: D2D1_RENDER_TARGET_TYPE_DEFAULT,
                    pixelFormat: D2D1_PIXEL_FORMAT { format: DXGI_FORMAT_B8G8R8A8_UNORM, alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED },
                    dpiX: 144.0,
                    dpiY: 144.0,
                    ..Default::default()
                };
                let target = unsafe { d2d.CreateDxgiSurfaceRenderTarget(&texture.cast::<IDXGISurface>()?, &props)? };
                let dwrite: IDWriteFactory = unsafe { DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)? };
                let heading = unsafe { dwrite.CreateTextFormat(w!("Segoe UI"), None, DWRITE_FONT_WEIGHT_SEMI_BOLD, DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL, 15.0, w!("en-us"))? };
                let body = unsafe { dwrite.CreateTextFormat(w!("Segoe UI"), None, DWRITE_FONT_WEIGHT_NORMAL, DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL, 12.0, w!("en-us"))? };
                let ink = unsafe { target.CreateSolidColorBrush(&D2D1_COLOR_F { r: 0.12, g: 0.12, b: 0.12, a: 1.0 }, None)? };
                let teal = unsafe { target.CreateSolidColorBrush(&D2D1_COLOR_F { r: 0.12, g: 0.48, b: 0.5, a: 1.0 }, None)? };
                let field = unsafe { target.CreateSolidColorBrush(&D2D1_COLOR_F { r: 0.95, g: 0.95, b: 0.94, a: 1.0 }, None)? };
                let shared = Arc::new(Shared { handle, width, height, adapter_luid: luid, fresh: AtomicBool::new(false), frames: AtomicU64::new(0) });
                let _ = tx.send(Ok(shared.clone()));
                let start = Instant::now();
                let (lw, lh) = (width as f32 / 1.5, height as f32 / 1.5);
                loop {
                    // Key 0: the producer may write. Key 1: the UI side may read.
                    unsafe { mutex.AcquireSync(0, INFINITE)? };
                    let t = if reduced.load(Ordering::Relaxed) { 0.0 } else { start.elapsed().as_secs_f32() };
                    unsafe {
                        target.BeginDraw();
                        target.Clear(Some(&D2D1_COLOR_F { r: 1.0, g: 1.0, b: 1.0, a: 1.0 }));
                        let x = (t * 0.5).fract() * lw;
                        target.FillRectangle(&D2D_RECT_F { left: x, top: 0.0, right: x + lw / 6.0, bottom: 4.0 }, &teal);
                        let h: Vec<u16> = "Stand-in page in a shared D3D11 texture".encode_utf16().collect();
                        target.DrawText(&h, &heading, &D2D_RECT_F { left: 16.0, top: 18.0, right: lw - 16.0, bottom: 60.0 }, &ink, D2D1_DRAW_TEXT_OPTIONS_NONE, DWRITE_MEASURING_MODE_NATURAL);
                        let b: Vec<u16> = format!("Painted by Direct2D on another device; frame {}. No CPU copy.", shared.frames.load(Ordering::Relaxed)).encode_utf16().collect();
                        target.DrawText(&b, &body, &D2D_RECT_F { left: 16.0, top: 56.0, right: lw - 16.0, bottom: 100.0 }, &ink, D2D1_DRAW_TEXT_OPTIONS_NONE, DWRITE_MEASURING_MODE_NATURAL);
                        target.FillRoundedRectangle(&D2D1_ROUNDED_RECT { rect: D2D_RECT_F { left: 16.0, top: 104.0, right: lw - 16.0, bottom: 136.0 }, radiusX: 6.0, radiusY: 6.0 }, &field);
                        target.EndDraw(None, None)?;
                        context.Flush();
                        mutex.ReleaseSync(1)?;
                    }
                    shared.frames.fetch_add(1, Ordering::Relaxed);
                    shared.fresh.store(true, Ordering::Release);
                    let _ = ui.upgrade_in_event_loop(|ui| ui.window().request_redraw());
                    let _ = lh;
                    std::thread::sleep(Duration::from_millis(33));
                }
            };
            if let Err(e) = run() {
                eprintln!("event=shared-texture-producer-failed error={e}");
                let _ = tx.send(Err(e));
            }
        })
        .map_err(|_| windows::core::Error::from(E_FAIL))?;
    rx.recv().map_err(|_| windows::core::Error::from(E_FAIL))?
}

/// Called from the rendering notifier, where Slint's GL context is current.
pub fn on_render(state: &slint::RenderingState, api: &slint::GraphicsAPI<'_>) {
    match (state, api) {
        (slint::RenderingState::RenderingSetup, slint::GraphicsAPI::NativeOpenGL { get_proc_address }) => {
            let Some(shared) = SHARED.with(|s| s.borrow().clone()) else { return };
            match setup_consumer(shared, get_proc_address) {
                Ok(c) => {
                    let ids = c.display;
                    let (w, h) = (c.shared.width, c.shared.height);
                    CONSUMER.with(|cell| *cell.borrow_mut() = Some(c));
                    let _ = slint::invoke_from_event_loop(move || show_display(ids[0], w, h));
                }
                Err(e) => eprintln!("event=shared-texture-consumer-failed error={e}"),
            }
        }
        (slint::RenderingState::RenderingSetup, _) => {
            if SHARED.with(|s| s.borrow().is_some()) {
                eprintln!("event=shared-texture-unsupported reason=renderer-is-not-opengl");
            }
        }
        (slint::RenderingState::BeforeRendering, _) => CONSUMER.with(|cell| {
            if let Some(c) = cell.borrow_mut().as_mut() {
                c.copy_if_fresh();
            }
        }),
        _ => {}
    }
}

fn show_display(id: u32, w: u32, h: u32) {
    UI.with(|u| {
        if let Some(ui) = u.borrow().as_ref().and_then(|w| w.upgrade()) {
            // SAFETY: the texture lives as long as the consumer, which lives as long as the GL context.
            let image = unsafe { slint::BorrowedOpenGLTextureBuilder::new_gl_2d_rgba_texture(std::num::NonZeroU32::new(id).unwrap(), (w, h).into()).build() };
            ui.set_web_frame(image);
        }
    });
}

fn setup_consumer(shared: Arc<Shared>, gpa: &dyn Fn(&CStr) -> *const c_void) -> Result<Consumer, String> {
    macro_rules! load {
        ($name:literal, $ty:ty) => {{
            let p = gpa(CStr::from_bytes_with_nul(concat!($name, "\0").as_bytes()).unwrap());
            if p.is_null() {
                return Err(format!("{} is not available", $name));
            }
            // SAFETY: the GL implementation returned this entry point for this name.
            unsafe { std::mem::transmute::<*const c_void, $ty>(p) }
        }};
    }
    let get_string = load!("glGetString", GlGetString);
    let text = |e: u32| unsafe {
        let p = get_string(e);
        if p.is_null() { String::new() } else { CStr::from_ptr(p as *const _).to_string_lossy().into_owned() }
    };
    eprintln!("event=shared-texture-gl vendor=\"{}\" renderer=\"{}\"", text(GL_VENDOR), text(GL_RENDERER));
    let gen_textures = load!("glGenTextures", GlGenTextures);
    let create_textures = load!("glCreateTextures", GlCreateTextures);
    let storage = load!("glTextureStorage2D", GlTextureStorage2D);
    let copy = load!("glCopyImageSubData", GlCopyImageSubData);
    let get_error = load!("glGetError", GlGetError);
    let open_device = load!("wglDXOpenDeviceNV", WglDXOpenDeviceNV);
    let register = load!("wglDXRegisterObjectNV", WglDXRegisterObjectNV);
    let lock = load!("wglDXLockObjectsNV", WglDXLockObjectsNV);
    let unlock = load!("wglDXUnlockObjectsNV", WglDXUnlockObjectsNV);

    // The UI side's own D3D11 device, on the adapter the producer used (the one the GL context runs on).
    let adapter = unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().map_err(|e| e.to_string())?;
        let mut found = None;
        for i in 0.. {
            let Ok(a) = factory.EnumAdapters1(i) else { break };
            if a.GetDesc1().map(|d| d.AdapterLuid == shared.adapter_luid).unwrap_or(false) {
                found = Some(a);
                break;
            }
        }
        found.ok_or("the producer's adapter is gone")?
    };
    let (device, _context) = create_device(&adapter).map_err(|e| e.to_string())?;
    let texture: ID3D11Texture2D = unsafe { device.cast::<ID3D11Device1>().map_err(|e| e.to_string())?.OpenSharedResource1(shared.handle).map_err(|e| format!("OpenSharedResource1: {e}"))? };
    let mutex: IDXGIKeyedMutex = texture.cast().map_err(|e| e.to_string())?;
    let interop_device = unsafe { open_device(device.as_raw()) };
    if interop_device.is_invalid() || interop_device.0.is_null() {
        return Err("wglDXOpenDeviceNV failed: this GL context and the D3D11 device are not on one adapter".into());
    }
    let mut interop_texture = 0u32;
    unsafe { gen_textures(1, &mut interop_texture) };
    // First, register the opened shared texture itself. If the driver refuses, register a texture this
    // device made and fill it from the shared one with CopyResource: still GPU to GPU.
    let mut local = None;
    let mut interop_object = unsafe { register(interop_device, texture.as_raw(), interop_texture, GL_TEXTURE_2D, WGL_ACCESS_READ_ONLY_NV) };
    if interop_object.0.is_null() {
        let code = unsafe { GetLastError() };
        eprintln!("event=shared-texture-register-direct-failed last_error={:#x}", code.0);
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { texture.GetDesc(&mut desc) };
        desc.MiscFlags = 0;
        let mut t = None;
        unsafe { device.CreateTexture2D(&desc, None, Some(&mut t)).map_err(|e| e.to_string())? };
        let t = t.unwrap();
        interop_object = unsafe { register(interop_device, t.as_raw(), interop_texture, GL_TEXTURE_2D, WGL_ACCESS_READ_ONLY_NV) };
        if interop_object.0.is_null() {
            let code = unsafe { GetLastError() };
            return Err(format!("wglDXRegisterObjectNV failed for the local texture too, last_error={:#x}", code.0));
        }
        eprintln!("event=shared-texture-register-local ok=true");
        local = Some((t, _context.clone()));
    } else {
        eprintln!("event=shared-texture-register-direct ok=true");
    }
    let mut display = [0u32; 2];
    unsafe {
        create_textures(GL_TEXTURE_2D, 2, display.as_mut_ptr());
        for id in display {
            storage(id, 1, GL_RGBA8, shared.width as i32, shared.height as i32);
        }
    }
    let err = unsafe { get_error() };
    eprintln!("event=shared-texture-ready width={} height={} gl_error={err:#x}", shared.width, shared.height);
    Ok(Consumer { shared, device, local, shared_texture: texture, mutex, interop_device, interop_object, interop_texture, display, target: 0, pending: false, lock, unlock, copy, get_error, copy_times: Vec::new() })
}

impl Consumer {
    fn copy_if_fresh(&mut self) {
        if !self.shared.fresh.swap(false, Ordering::AcqRel) && !self.pending {
            return;
        }
        let t0 = Instant::now();
        unsafe {
            if self.mutex.AcquireSync(1, 0).is_err() {
                self.pending = true;
                return;
            }
            if let Some((local, context)) = &self.local {
                context.CopyResource(local, &self.shared_texture);
                context.Flush();
            }
            let mut obj = self.interop_object;
            if !(self.lock)(self.interop_device, 1, &mut obj).as_bool() {
                eprintln!("event=shared-texture-lock-failed");
                let _ = self.mutex.ReleaseSync(0);
                return;
            }
            let dst = self.display[self.target];
            // Clear any error the renderer left pending, so the check below is about this copy alone.
            let mut stale = 0;
            while (self.get_error)() != 0 && stale < 16 {
                stale += 1;
            }
            if stale > 0 && self.copy_times.is_empty() {
                eprintln!("event=shared-texture-stale-gl-errors count={stale}");
            }
            (self.copy)(self.interop_texture, GL_TEXTURE_2D, 0, 0, 0, 0, dst, GL_TEXTURE_2D, 0, 0, 0, 0, self.shared.width as i32, self.shared.height as i32, 1);
            let err = (self.get_error)();
            let _ = (self.unlock)(self.interop_device, 1, &mut obj);
            let _ = self.mutex.ReleaseSync(0);
            if err != 0 {
                eprintln!("event=shared-texture-copy-error gl_error={err:#x}");
            }
        }
        self.pending = false;
        self.copy_times.push(t0.elapsed().as_secs_f64() * 1000.0);
        if self.copy_times.len() == 120 {
            let mut v = self.copy_times.clone();
            v.sort_by(|a, b| a.partial_cmp(b).unwrap());
            eprintln!("event=shared-texture-copies n=120 median_ms={:.3} max_ms={:.3} frames_painted={}", v[60], v[119], self.shared.frames.load(Ordering::Relaxed));
        }
        // Show the texture just written, and write the other one next time.
        let (id, w, h) = (self.display[self.target], self.shared.width, self.shared.height);
        self.target ^= 1;
        let _ = slint::invoke_from_event_loop(move || show_display(id, w, h));
    }
}

/// Starts the chosen experiment once the window has its size. Returns a timer to keep alive.
pub fn start(ui: &AppWindow, mode: Mode, reduced: Arc<AtomicBool>) -> Option<slint::Timer> {
    ui.set_web_surface_mode(match mode {
        Mode::Image => 0,
        Mode::Child => 1,
        Mode::Shared => 2,
    });
    UI.with(|u| *u.borrow_mut() = Some(ui.as_weak()));
    match mode {
        Mode::Image => None,
        Mode::Child => {
            let timer = slint::Timer::default();
            let w = ui.as_weak();
            timer.start(slint::TimerMode::Repeated, Duration::from_millis(16), move || {
                if let Some(ui) = w.upgrade() {
                    place_child(&ui);
                }
            });
            Some(timer)
        }
        Mode::Shared => {
            // The producer is started before the window's GL context exists, so RenderingSetup finds it.
            let vendor = std::env::var("SOTTO_SHARED_ADAPTER").unwrap_or_default();
            let Some((adapter, luid, name)) = adapter_for(&vendor) else {
                eprintln!("event=shared-texture-failed error=no-adapter");
                return None;
            };
            eprintln!("event=shared-texture-adapter name=\"{name}\"");
            // A fixed size, the pane's surface at 1600x1000 and 150% (776x613 physical); stretched if the pane differs.
            let (w, h) = (std::env::var("SOTTO_SHARED_SIZE").ok().and_then(|s| s.split_once('x').and_then(|(a, b)| Some((a.parse().ok()?, b.parse().ok()?))))).unwrap_or((776, 613));
            match start_producer(adapter, luid, w, h, reduced, ui.as_weak()) {
                Ok(shared) => SHARED.with(|s| *s.borrow_mut() = Some(shared)),
                Err(e) => eprintln!("event=shared-texture-failed error={e}"),
            }
            None
        }
    }
}
