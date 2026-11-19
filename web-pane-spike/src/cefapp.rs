//! The CEF side: the app, its handlers, the DevTools client and the sealed scheme.

use crate::hub::{UiJob, hub, job};
use cef::rc::Rc as _;
use cef::*;
use serde_json::{Value, json};
use std::cell::RefCell;
use std::sync::atomic::Ordering;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// The seal's layers, each switchable so a run can show what each one stops on its own.
#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct Seal {
    /// The page's Content-Security-Policy and the other response headers ADR-0060 names.
    pub csp: bool,
    /// Every request but the page's own one load is cancelled.
    pub filter: bool,
    /// The request context goes through a SOCKS5 proxy that answers nothing, with no bypass.
    pub proxy: bool,
    /// WebRTC may use only the proxy (`disable_non_proxied_udp`).
    pub webrtc_policy: bool,
    /// Permissions, downloads, popups, navigations and dialogs are refused.
    pub deny: bool,
    /// RTCPeerConnection removed from the page's world before its script runs.
    pub no_rtc: bool,
}

pub struct Config {
    pub mode: String,
    pub switches: Vec<(String, Option<String>)>,
    pub root_cache: String,
    pub seal: Option<Seal>,
    pub dead_proxy_port: u16,
    /// The sealed page: its one-time address and its HTML. Taken by its one load.
    pub sealed_page: Mutex<Option<(String, Vec<u8>)>>,
    /// The page address the filter lets through once.
    pub sealed_url: Mutex<Option<String>>,
    pub log_requests: bool,
}

/// The newest browser, for code on threads other than CEF's UI thread (the embed window's). CEF's browser and host
/// objects are reference counted across threads, and the host's input and resize methods post to the UI thread.
pub struct SendBrowser(pub Browser);
unsafe impl Send for SendBrowser {}
pub static LAST_BROWSER: Mutex<Option<SendBrowser>> = Mutex::new(None);

static CONFIG: OnceLock<Config> = OnceLock::new();
pub fn set_config(config: Config) {
    let _ = CONFIG.set(config);
}
pub fn config() -> &'static Config {
    CONFIG.get().expect("config")
}
fn config_opt() -> Option<&'static Config> {
    CONFIG.get()
}

pub const SCHEME: &str = "sotto-visual";
pub const SEALED_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts";

thread_local! {
    pub static BROWSER: RefCell<Option<Browser>> = const { RefCell::new(None) };
    static OBSERVER: RefCell<Option<Registration>> = const { RefCell::new(None) };
    pub static CONTEXT: RefCell<Option<RequestContext>> = const { RefCell::new(None) };
}

// ---------------------------------------------------------------- tasks

wrap_task! {
    pub struct JobTask { job: UiJob }
    impl Task {
        fn execute(&self) {
            if let Some(f) = self.job.lock().unwrap().take() { f() }
        }
    }
}

/// Runs `f` on CEF's UI thread.
pub fn on_ui(f: impl FnOnce() + Send + 'static) {
    let mut task = JobTask::new(job(f));
    post_task(ThreadId::from(sys::cef_thread_id_t::TID_UI), Some(&mut task));
}
pub fn on_ui_delayed(ms: i64, f: impl FnOnce() + Send + 'static) {
    let mut task = JobTask::new(job(f));
    post_delayed_task(ThreadId::from(sys::cef_thread_id_t::TID_UI), Some(&mut task), ms);
}
/// Runs `f` on the UI thread and waits for its answer.
pub fn on_ui_wait<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    let (tx, rx) = std::sync::mpsc::channel();
    on_ui(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(Duration::from_secs(30)).expect("UI thread answered")
}

// ---------------------------------------------------------------- DevTools

wrap_dev_tools_message_observer! {
    pub struct Observer {}
    impl DevToolsMessageObserver {
        fn on_dev_tools_method_result(&self, _browser: Option<&mut Browser>, message_id: ::std::os::raw::c_int, success: ::std::os::raw::c_int, result: Option<&[u8]>) {
            let value: Value = result.and_then(|r| serde_json::from_slice(r).ok()).unwrap_or(Value::Null);
            hub().put_result(message_id, success != 0, value);
        }
        fn on_dev_tools_event(&self, _browser: Option<&mut Browser>, method: Option<&CefString>, params: Option<&[u8]>) {
            let method = method.map(|m| m.to_string()).unwrap_or_default();
            let value: Value = params.and_then(|p| serde_json::from_slice(p).ok()).unwrap_or(Value::Null);
            hub().put_event(method, value);
        }
    }
}

/// One DevTools protocol command, sent in process through CEF (no port, no pipe), as Electron's
/// `webContents.debugger` does. Blocks the calling (non-UI) thread until the answer.
pub fn cdp(method: &str, params: Value) -> Result<Value, Value> {
    let id = hub().next_id.fetch_add(1, Ordering::SeqCst);
    let message = json!({ "id": id, "method": method, "params": params }).to_string();
    on_ui(move || {
        let sent = current_host().map(|h| h.send_dev_tools_message(Some(message.as_bytes()))).unwrap_or(0);
        if sent == 0 {
            hub().put_result(id, false, json!({ "message": "not sent: no browser or not accepted" }));
        }
    });
    match hub().take_result(id, Duration::from_secs(20)) {
        Some((true, value)) => Ok(value),
        Some((false, value)) => Err(value),
        None => Err(json!({ "message": "no answer in 20 s" })),
    }
}

pub fn attach_observer() {
    on_ui_wait(|| {
        if let Some(host) = current_host() {
            let mut observer = Observer::new();
            let registration = host.add_dev_tools_message_observer(Some(&mut observer));
            OBSERVER.with(|o| *o.borrow_mut() = registration);
        }
    });
}

pub fn drop_observer() {
    OBSERVER.with(|o| *o.borrow_mut() = None);
}

pub fn navigate(url: &str) {
    let url = url.to_string();
    on_ui(move || {
        let frame = BROWSER.with(|b| b.borrow().as_ref().and_then(|b| b.main_frame()));
        if let Some(frame) = frame {
            frame.load_url(Some(&CefString::from(url.as_str())));
        }
    });
}

// ---------------------------------------------------------------- the app

wrap_app! {
    pub struct SpikeApp {}
    impl App {
        fn on_before_command_line_processing(&self, process_type: Option<&CefString>, command_line: Option<&mut CommandLine>) {
            let Some(command_line) = command_line else { return };
            // Only the browser process (empty type) takes the run's switches; Chromium hands the ones that matter to children.
            let is_browser = process_type.map(|t| t.to_string().is_empty()).unwrap_or(true);
            if !is_browser { return }
            if let Some(config) = config_opt() {
                for (name, value) in &config.switches {
                    match value {
                        Some(value) => command_line.append_switch_with_value(Some(&CefString::from(name.as_str())), Some(&CefString::from(value.as_str()))),
                        None => command_line.append_switch(Some(&CefString::from(name.as_str()))),
                    }
                }
            }
        }
        fn on_register_custom_schemes(&self, registrar: Option<&mut SchemeRegistrar>) {
            // Registered as standard and nothing more: not secure, no fetch, no CORS, no service workers (ADR-0060).
            if let Some(registrar) = registrar {
                registrar.add_custom_scheme(Some(&CefString::from(SCHEME)), sys::cef_scheme_options_t::CEF_SCHEME_OPTION_STANDARD as i32);
            }
        }
        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> {
            Some(SpikeBrowserProcess::new())
        }
    }
}

wrap_browser_process_handler! {
    pub struct SpikeBrowserProcess {}
    impl BrowserProcessHandler {
        fn on_context_initialized(&self) {
            hub().note(format!("context initialized at {:.0} ms", hub().ms()));
            hub().set_ready();
        }
    }
}

// ---------------------------------------------------------------- the client

wrap_render_handler! {
    pub struct OffscreenRender {}
    impl RenderHandler {
        fn view_rect(&self, _browser: Option<&mut Browser>, rect: Option<&mut Rect>) {
            if let Some(rect) = rect {
                let (w, h) = *hub().view.lock().unwrap();
                rect.x = 0; rect.y = 0; rect.width = w; rect.height = h;
            }
        }
        fn screen_info(&self, _browser: Option<&mut Browser>, screen_info: Option<&mut ScreenInfo>) -> ::std::os::raw::c_int {
            if let Some(info) = screen_info {
                info.device_scale_factor = 1.0;
                let (w, h) = *hub().view.lock().unwrap();
                info.rect = Rect { x: 0, y: 0, width: w, height: h };
                info.available_rect = info.rect.clone();
                return 1;
            }
            0
        }
        fn on_paint(&self, _browser: Option<&mut Browser>, _type_: PaintElementType, _dirty: Option<&[Rect]>, _buffer: *const u8, _w: ::std::os::raw::c_int, _h: ::std::os::raw::c_int) {
            hub().paints.fetch_add(1, Ordering::Relaxed);
            hub().first_paint();
        }
        fn on_accelerated_paint(&self, _browser: Option<&mut Browser>, _type_: PaintElementType, _dirty: Option<&[Rect]>, _info: Option<&AcceleratedPaintInfo>) {
            hub().accelerated_paints.fetch_add(1, Ordering::Relaxed);
            hub().first_paint();
        }
    }
}

wrap_life_span_handler! {
    pub struct Life {}
    impl LifeSpanHandler {
        fn on_before_popup(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>, _popup_id: ::std::os::raw::c_int, target_url: Option<&CefString>, _target_frame_name: Option<&CefString>, _target_disposition: WindowOpenDisposition, _user_gesture: ::std::os::raw::c_int, _popup_features: Option<&PopupFeatures>, _window_info: Option<&mut WindowInfo>, _client: Option<&mut Option<Client>>, _settings: Option<&mut BrowserSettings>, _extra_info: Option<&mut Option<DictionaryValue>>, _no_javascript_access: Option<&mut ::std::os::raw::c_int>) -> ::std::os::raw::c_int {
            hub().refuse("popup", target_url.map(|u| u.to_string()).unwrap_or_default());
            1
        }
        fn on_after_created(&self, browser: Option<&mut Browser>) {
            if let Some(browser) = browser {
                *LAST_BROWSER.lock().unwrap() = Some(SendBrowser(browser.clone()));
                let b = browser.clone();
                BROWSER.with(|slot| *slot.borrow_mut() = Some(b));
            }
            hub().note(format!("browser created at {:.0} ms", hub().ms()));
        }
        fn do_close(&self, browser: Option<&mut Browser>) -> ::std::os::raw::c_int {
            // A windowed browser parented into another process's window (WP_PARENT_HWND): returning false would make
            // CEF send WM_CLOSE to the top-level window, which is Sotto's own window. Destroy only CEF's child instead.
            #[cfg(target_os = "windows")]
            if std::env::var("WP_PARENT_HWND").is_ok() {
                if let Some(host) = browser.and_then(|b| b.host()) {
                    let hwnd = host.window_handle();
                    unsafe { windows_sys::Win32::UI::WindowsAndMessaging::DestroyWindow(hwnd.0 as _); }
                    hub().note("do_close: destroyed CEF's child window instead of closing the parent");
                    return 1;
                }
            }
            let _ = browser;
            0
        }
        fn on_before_close(&self, _browser: Option<&mut Browser>) {
            OBSERVER.with(|o| *o.borrow_mut() = None);
            BROWSER.with(|slot| *slot.borrow_mut() = None);
            hub().closed.store(true, Ordering::SeqCst);
            hub().note(format!("browser closed at {:.0} ms", hub().ms()));
        }
    }
}

wrap_load_handler! {
    pub struct Load {}
    impl LoadHandler {
        fn on_load_end(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, http_status_code: ::std::os::raw::c_int) {
            if let Some(frame) = frame {
                if frame.is_main() != 0 {
                    let url = CefString::from(&frame.url()).to_string();
                    hub().put_load(http_status_code, url);
                }
            }
        }
        fn on_load_error(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, error_code: Errorcode, error_text: Option<&CefString>, failed_url: Option<&CefString>) {
            let main = frame.map(|f| f.is_main() != 0).unwrap_or(false);
            hub().note(format!("load error main={main} code={:?} {} {}", error_code, error_text.map(|t| t.to_string()).unwrap_or_default(), failed_url.map(|t| t.to_string()).unwrap_or_default()));
        }
    }
}

wrap_display_handler! {
    pub struct Display {}
    impl DisplayHandler {
        fn on_console_message(&self, _browser: Option<&mut Browser>, _level: LogSeverity, message: Option<&CefString>, _source: Option<&CefString>, _line: ::std::os::raw::c_int) -> ::std::os::raw::c_int {
            if let Some(message) = message {
                hub().console.lock().unwrap().push(message.to_string());
            }
            0
        }
    }
}

wrap_permission_handler! {
    pub struct Permissions {}
    impl PermissionHandler {
        fn on_request_media_access_permission(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>, origin: Option<&CefString>, requested: u32, callback: Option<&mut MediaAccessCallback>) -> ::std::os::raw::c_int {
            if !sealed_deny() { return 0 }
            hub().refuse("permission", format!("media access {requested:#x} from {}", origin.map(|o| o.to_string()).unwrap_or_default()));
            if let Some(callback) = callback { callback.cancel(); }
            1
        }
        fn on_show_permission_prompt(&self, _browser: Option<&mut Browser>, _prompt_id: u64, origin: Option<&CefString>, requested: u32, callback: Option<&mut PermissionPromptCallback>) -> ::std::os::raw::c_int {
            if !sealed_deny() { return 0 }
            hub().refuse("permission", format!("prompt {requested:#x} from {}", origin.map(|o| o.to_string()).unwrap_or_default()));
            if let Some(callback) = callback { callback.cont(PermissionRequestResult::from(sys::cef_permission_request_result_t::CEF_PERMISSION_RESULT_DENY)); }
            1
        }
    }
}

wrap_download_handler! {
    pub struct Downloads {}
    impl DownloadHandler {
        fn can_download(&self, _browser: Option<&mut Browser>, url: Option<&CefString>, _method: Option<&CefString>) -> ::std::os::raw::c_int {
            let url = url.map(|u| u.to_string()).unwrap_or_default();
            if sealed_deny() { hub().refuse("download", url); return 0 }
            hub().note(format!("download asked: {url}"));
            0
        }
        fn on_before_download(&self, _browser: Option<&mut Browser>, _item: Option<&mut DownloadItem>, name: Option<&CefString>, _callback: Option<&mut BeforeDownloadCallback>) -> ::std::os::raw::c_int {
            hub().refuse("download", format!("before download {}", name.map(|n| n.to_string()).unwrap_or_default()));
            0
        }
    }
}

wrap_jsdialog_handler! {
    pub struct Dialogs {}
    impl JsdialogHandler {
        fn on_jsdialog(&self, _browser: Option<&mut Browser>, origin: Option<&CefString>, _type_: JsdialogType, message: Option<&CefString>, _default: Option<&CefString>, _callback: Option<&mut JsdialogCallback>, suppress: Option<&mut ::std::os::raw::c_int>) -> ::std::os::raw::c_int {
            hub().refuse("dialog", format!("{} {}", origin.map(|o| o.to_string()).unwrap_or_default(), message.map(|m| m.to_string()).unwrap_or_default()));
            if let Some(suppress) = suppress { *suppress = 1; }
            0
        }
    }
}

fn sealed_deny() -> bool {
    config_opt().and_then(|c| c.seal).map(|s| s.deny).unwrap_or(false)
}
fn sealed_filter() -> bool {
    config_opt().and_then(|c| c.seal).map(|s| s.filter).unwrap_or(false)
}

wrap_request_handler! {
    pub struct Requests {}
    impl RequestHandler {
        fn on_before_browse(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, request: Option<&mut Request>, _user_gesture: ::std::os::raw::c_int, is_redirect: ::std::os::raw::c_int) -> ::std::os::raw::c_int {
            let url = request.map(|r| CefString::from(&r.url()).to_string()).unwrap_or_default();
            let main = frame.map(|f| f.is_main() != 0).unwrap_or(false);
            if !sealed_deny() { return 0 }
            // Allowed: the one page load, in the main frame, not a redirect. Everything else is refused.
            let sealed = config().sealed_url.lock().unwrap().clone();
            if main && is_redirect == 0 && sealed.as_deref() == Some(url.as_str()) && config().sealed_page.lock().unwrap().is_some() { return 0 }
            hub().refuse("navigation", format!("main={main} redirect={is_redirect} {url}"));
            1
        }
        fn resource_request_handler(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>, _request: Option<&mut Request>, _is_navigation: ::std::os::raw::c_int, _is_download: ::std::os::raw::c_int, _initiator: Option<&CefString>, _disable_default_handling: Option<&mut ::std::os::raw::c_int>) -> Option<ResourceRequestHandler> {
            Some(ResourceRequests::new())
        }
        fn on_render_process_terminated(&self, _browser: Option<&mut Browser>, status: TerminationStatus, error_code: ::std::os::raw::c_int, _error_string: Option<&CefString>) {
            hub().note(format!("render process terminated {status:?} {error_code}"));
        }
    }
}

wrap_resource_request_handler! {
    pub struct ResourceRequests {}
    impl ResourceRequestHandler {
        fn on_before_resource_load(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, request: Option<&mut Request>, _callback: Option<&mut Callback>) -> ReturnValue {
            let url = request.map(|r| CefString::from(&r.url()).to_string()).unwrap_or_default();
            if config_opt().map(|c| c.log_requests).unwrap_or(false) { hub().note(format!("request {url}")); }
            if !sealed_filter() { return ReturnValue::from(sys::cef_return_value_t::RV_CONTINUE) }
            let main = frame.map(|f| f.is_main() != 0).unwrap_or(false);
            let sealed = config().sealed_url.lock().unwrap().clone();
            if main && sealed.as_deref() == Some(url.as_str()) && config().sealed_page.lock().unwrap().is_some() {
                return ReturnValue::from(sys::cef_return_value_t::RV_CONTINUE);
            }
            hub().refuse("request-filter", url);
            ReturnValue::from(sys::cef_return_value_t::RV_CANCEL)
        }
        fn on_protocol_execution(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>, request: Option<&mut Request>, allow: Option<&mut ::std::os::raw::c_int>) {
            let url = request.map(|r| CefString::from(&r.url()).to_string()).unwrap_or_default();
            hub().refuse("external-protocol", url);
            if let Some(allow) = allow { *allow = 0; }
        }
    }
}

wrap_client! {
    pub struct SpikeClient { render: Option<RenderHandler> }
    impl Client {
        fn render_handler(&self) -> Option<RenderHandler> { self.render.clone() }
        fn life_span_handler(&self) -> Option<LifeSpanHandler> { Some(Life::new()) }
        fn load_handler(&self) -> Option<LoadHandler> { Some(Load::new()) }
        fn display_handler(&self) -> Option<DisplayHandler> { Some(Display::new()) }
        fn permission_handler(&self) -> Option<PermissionHandler> { Some(Permissions::new()) }
        fn download_handler(&self) -> Option<DownloadHandler> { Some(Downloads::new()) }
        fn jsdialog_handler(&self) -> Option<JsdialogHandler> { Some(Dialogs::new()) }
        fn request_handler(&self) -> Option<RequestHandler> { Some(Requests::new()) }
    }
}

// ---------------------------------------------------------------- the sealed scheme

wrap_scheme_handler_factory! {
    pub struct SealedSchemes {}
    impl SchemeHandlerFactory {
        fn create(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>, _scheme: Option<&CefString>, request: Option<&mut Request>) -> Option<ResourceHandler> {
            let url = request.map(|r| CefString::from(&r.url()).to_string()).unwrap_or_default();
            // One load per address: the page is taken, so a second load of it finds nothing.
            let page = {
                let mut slot = config().sealed_page.lock().unwrap();
                match slot.as_ref() {
                    Some((address, _)) if *address == url => slot.take().map(|(_, html)| html),
                    _ => None,
                }
            };
            match page {
                Some(html) => Some(SealedPage::new(std::sync::Arc::new(Mutex::new((html, 0usize))))),
                None => { hub().refuse("scheme", format!("no page at {url}")); None }
            }
        }
    }
}

wrap_resource_handler! {
    pub struct SealedPage { body: std::sync::Arc<Mutex<(Vec<u8>, usize)>> }
    impl ResourceHandler {
        fn open(&self, _request: Option<&mut Request>, handle_request: Option<&mut ::std::os::raw::c_int>, _callback: Option<&mut Callback>) -> ::std::os::raw::c_int {
            if let Some(handle) = handle_request { *handle = 1; }
            1
        }
        fn response_headers(&self, response: Option<&mut Response>, response_length: Option<&mut i64>, _redirect: Option<&mut CefString>) {
            let length = self.body.lock().unwrap().0.len() as i64;
            if let Some(response) = response {
                response.set_status(200);
                response.set_mime_type(Some(&CefString::from("text/html")));
                response.set_charset(Some(&CefString::from("utf-8")));
                let csp = config_opt().and_then(|c| c.seal).map(|s| s.csp).unwrap_or(false);
                if csp {
                    for (name, value) in [
                        ("Content-Security-Policy", SEALED_CSP),
                        ("X-DNS-Prefetch-Control", "off"),
                        ("Permissions-Policy", "accelerometer=(), ambient-light-sensor=(), autoplay=(), battery=(), bluetooth=(), camera=(), display-capture=(), document-domain=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), hid=(), idle-detection=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), usb=(), web-share=(), xr-spatial-tracking=(), clipboard-read=(), clipboard-write=()"),
                        ("Referrer-Policy", "no-referrer"),
                        ("X-Content-Type-Options", "nosniff"),
                        ("Cache-Control", "no-store"),
                    ] {
                        response.set_header_by_name(Some(&CefString::from(name)), Some(&CefString::from(value)), 1);
                    }
                }
            }
            if let Some(len) = response_length { *len = length; }
        }
        fn read(&self, data_out: *mut u8, bytes_to_read: ::std::os::raw::c_int, bytes_read: Option<&mut ::std::os::raw::c_int>, _callback: Option<&mut ResourceReadCallback>) -> ::std::os::raw::c_int {
            let mut body = self.body.lock().unwrap();
            let (ref data, ref mut offset) = *body;
            let left = data.len().saturating_sub(*offset);
            let n = left.min(bytes_to_read.max(0) as usize);
            if n == 0 { if let Some(r) = bytes_read { *r = 0; } return 0 }
            unsafe { std::ptr::copy_nonoverlapping(data.as_ptr().add(*offset), data_out, n); }
            *offset += n;
            if let Some(r) = bytes_read { *r = n as i32; }
            1
        }
        fn cancel(&self) {}
    }
}

/// Creates the request context a sealed page runs in: in memory (no cache path), with the scheme's factory. Its
/// preferences (the dead proxy, the WebRTC policy) can only be set once CEF says the context is initialized, so the
/// handler sets them then and the hub's `context_ready` note says so. Must run on the UI thread.
pub fn sealed_context(seal: Seal, dead_proxy_port: u16) -> Option<RequestContext> {
    let mut settings = RequestContextSettings::default();
    if std::env::var("WP_SEAL_CACHE").is_ok() {
        // A profile of its own, in a folder under the root cache, so its preferences are its own.
        settings.cache_path = CefString::from(format!("{}/sealed", config().root_cache).as_str());
    }
    let mut handler = SealedContextHandler::new(seal, dead_proxy_port);
    let context = request_context_create_context(Some(&settings), Some(&mut handler))?;
    let mut factory = SealedSchemes::new();
    context.register_scheme_handler_factory(Some(&CefString::from(SCHEME)), Some(&CefString::from("page")), Some(&mut factory));
    Some(context)
}

pub static CONTEXT_READY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

wrap_request_context_handler! {
    pub struct SealedContextHandler { seal: Seal, port: u16 }
    impl RequestContextHandler {
        fn on_request_context_initialized(&self, context: Option<&mut RequestContext>) {
            let Some(context) = context else { return };
            let mut error = CefString::from("");
            if self.seal.proxy {
                if let (Some(mut dict), Some(mut value)) = (dictionary_value_create(), value_create()) {
                    dict.set_string(Some(&CefString::from("mode")), Some(&CefString::from("fixed_servers")));
                    dict.set_string(Some(&CefString::from("server")), Some(&CefString::from(format!("socks5://127.0.0.1:{}", self.port).as_str())));
                    dict.set_string(Some(&CefString::from("bypass_list")), Some(&CefString::from("<-loopback>")));
                    value.set_dictionary(Some(&mut dict));
                    let ok = context.set_preference(Some(&CefString::from("proxy")), Some(&mut value), Some(&mut error));
                    hub().note(format!("proxy preference set={ok} {}", error.to_string()));
                }
            }
            if self.seal.webrtc_policy {
                if let Some(mut value) = value_create() {
                    value.set_string(Some(&CefString::from("disable_non_proxied_udp")));
                    let ok = context.set_preference(Some(&CefString::from("webrtc.ip_handling_policy")), Some(&mut value), Some(&mut error));
                    hub().note(format!("webrtc policy preference set={ok} {}", error.to_string()));
                }
            }
            if self.seal.deny {
                for name in ["browser.enable_spellchecking", "download.prompt_for_download"] {
                    if let Some(mut value) = value_create() {
                        value.set_bool(0);
                        let ok = context.set_preference(Some(&CefString::from(name)), Some(&mut value), Some(&mut error));
                        hub().note(format!("{name}=false set={ok} {}", error.to_string()));
                    }
                }
            }
            for name in ["proxy", "webrtc.ip_handling_policy", "browser.enable_spellchecking"] {
                let can = context.can_set_preference(Some(&CefString::from(name)));
                hub().note(format!("can_set {name}={can}"));
            }
            if let Some(global) = request_context_get_global_context() {
                let same = global.is_same(Some(&mut context.clone()));
                let sharing = global.is_sharing_with(Some(&mut context.clone()));
                hub().note(format!("sealed context is the global one: {same}, shares storage with it: {sharing}"));
                let value = global.preference(Some(&CefString::from("webrtc.ip_handling_policy"))).map(|v| describe_value(&v)).unwrap_or_default();
                hub().note(format!("global context webrtc.ip_handling_policy: {value}"));
            }
            for name in ["proxy", "webrtc.ip_handling_policy"] {
                let has = context.has_preference(Some(&CefString::from(name)));
                let value = context.preference(Some(&CefString::from(name))).map(|v| describe_value(&v)).unwrap_or_default();
                hub().note(format!("read back {name}: has={has} {value}"));
            }
            CONTEXT_READY.store(true, Ordering::SeqCst);
        }
    }
}

fn describe_value(value: &cef::Value) -> String {
    if let Some(dict) = value.dictionary() {
        let mut keys = CefStringList::new();
        dict.keys(Some(&mut keys));
        let keys: Vec<String> = keys.into_iter().map(|k| k.to_string()).collect();
        return keys.iter().map(|k| format!("{k}={}", CefString::from(&dict.string(Some(&CefString::from(k.as_str())))).to_string())).collect::<Vec<_>>().join(" ");
    }
    CefString::from(&value.string()).to_string()
}

/// Creates one off-screen browser on the UI thread. `context` None means the global context.
pub fn create_offscreen(url: &str, context: Option<RequestContext>, frame_rate: i32) {
    let url = url.to_string();
    on_ui(move || {
        let window_info = WindowInfo { windowless_rendering_enabled: 1, ..Default::default() };
        let settings = BrowserSettings { windowless_frame_rate: frame_rate, ..Default::default() };
        let mut client = SpikeClient::new(Some(OffscreenRender::new()));
        let mut context = context;
        let created = browser_host_create_browser(Some(&window_info), Some(&mut client), Some(&CefString::from(url.as_str())), Some(&settings), None, context.as_mut());
        if created == 0 { hub().note("browser_host_create_browser returned 0"); }
    });
}

/// The current browser's host, cloned out of the slot so a call that re-enters a handler finds the slot free.
pub fn current_host() -> Option<BrowserHost> {
    BROWSER.with(|b| b.borrow().as_ref().and_then(|b| b.host()))
}

pub fn close_browser() {
    on_ui(|| {
        if let Some(host) = current_host() {
            host.close_browser(1);
        }
    });
}
