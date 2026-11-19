//! Question 4, the part the Linux half left: what an off-screen pane leaves Sotto to build. WP_MODE=osr opens
//! server/pages/osr.html off screen at device scale WP_SCALE (default 1.5, this laptop's) and checks, for each of
//! `<select>` pop-ups, cursors, drag and drop, file pickers, IME composition, context menus and the accessibility
//! tree, whether CEF hands the app a callback and whether the page sees the result.

use crate::cefapp::*;
use crate::hub::hub;
use cef::*;
use serde_json::{Value as Json, json};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

static SEEN: Mutex<Vec<Json>> = Mutex::new(Vec::new());
static VIEW_PAINT: Mutex<Option<(i32, i32)>> = Mutex::new(None);
static POPUP_PAINTS: AtomicU64 = AtomicU64::new(0);
static AX_TREE_EVENTS: AtomicU64 = AtomicU64::new(0);
static AX_LOCATION_EVENTS: AtomicU64 = AtomicU64::new(0);
static AX_SAMPLE: Mutex<Vec<Json>> = Mutex::new(Vec::new());

fn rec(kind: &str, detail: Json) {
    eprintln!("[osr] {kind} {detail}");
    SEEN.lock().unwrap().push(json!({ "ms": (hub().ms() as u64), "callback": kind, "detail": detail }));
}
fn seen(kind: &str) -> Vec<Json> {
    SEEN.lock().unwrap().iter().filter(|e| e["callback"] == kind).cloned().collect()
}
fn scale() -> f32 {
    std::env::var("WP_SCALE").ok().and_then(|v| v.parse().ok()).unwrap_or(1.5)
}

/// A CEF value as JSON, to see what the accessibility feed carries.
fn to_json(v: &cef::Value, depth: usize) -> Json {
    if depth > 40 { return json!("…") }
    match *v.get_type().as_ref() {
        sys::cef_value_type_t::VTYPE_BOOL => json!(v.bool() != 0),
        sys::cef_value_type_t::VTYPE_INT => json!(v.int()),
        sys::cef_value_type_t::VTYPE_DOUBLE => json!(v.double()),
        sys::cef_value_type_t::VTYPE_STRING => json!(CefString::from(&v.string()).to_string()),
        sys::cef_value_type_t::VTYPE_DICTIONARY => {
            let Some(d) = v.dictionary() else { return Json::Null };
            let mut keys = CefStringList::new();
            d.keys(Some(&mut keys));
            let mut out = serde_json::Map::new();
            for k in keys.into_iter().map(|k| k.to_string()) {
                if let Some(child) = d.value(Some(&CefString::from(k.as_str()))) { out.insert(k, to_json(&child, depth + 1)); }
            }
            Json::Object(out)
        }
        sys::cef_value_type_t::VTYPE_LIST => {
            let Some(l) = v.list() else { return Json::Null };
            Json::Array((0..l.size()).filter_map(|i| l.value(i)).map(|c| to_json(&c, depth + 1)).collect())
        }
        _ => Json::Null,
    }
}

wrap_accessibility_handler! {
    struct OsrA11y {}
    impl AccessibilityHandler {
        fn on_accessibility_tree_change(&self, value: Option<&mut cef::Value>) {
            let n = AX_TREE_EVENTS.fetch_add(1, Ordering::Relaxed);
            if let Some(v) = value { if n < 400 { AX_SAMPLE.lock().unwrap().push(to_json(v, 0)); } }
        }
        fn on_accessibility_location_change(&self, _value: Option<&mut cef::Value>) {
            AX_LOCATION_EVENTS.fetch_add(1, Ordering::Relaxed);
        }
    }
}

wrap_render_handler! {
    struct OsrRender {}
    impl RenderHandler {
        fn accessibility_handler(&self) -> Option<AccessibilityHandler> { Some(OsrA11y::new()) }
        fn view_rect(&self, _browser: Option<&mut Browser>, rect: Option<&mut Rect>) {
            if let Some(rect) = rect { let (w, h) = *hub().view.lock().unwrap(); rect.x = 0; rect.y = 0; rect.width = w; rect.height = h; }
        }
        fn screen_info(&self, _browser: Option<&mut Browser>, info: Option<&mut ScreenInfo>) -> ::std::os::raw::c_int {
            let Some(info) = info else { return 0 };
            info.device_scale_factor = scale();
            let (w, h) = *hub().view.lock().unwrap();
            info.rect = Rect { x: 0, y: 0, width: w, height: h };
            info.available_rect = info.rect.clone();
            1
        }
        fn screen_point(&self, _browser: Option<&mut Browser>, view_x: ::std::os::raw::c_int, view_y: ::std::os::raw::c_int, screen_x: Option<&mut ::std::os::raw::c_int>, screen_y: Option<&mut ::std::os::raw::c_int>) -> ::std::os::raw::c_int {
            // A pane at (240,56) in a window at (100,100): the pop-up and IME code need screen points.
            if let (Some(x), Some(y)) = (screen_x, screen_y) { *x = 340 + view_x; *y = 156 + view_y; return 1 }
            0
        }
        fn on_paint(&self, _browser: Option<&mut Browser>, type_: PaintElementType, _dirty: Option<&[Rect]>, _buffer: *const u8, w: ::std::os::raw::c_int, h: ::std::os::raw::c_int) {
            hub().paints.fetch_add(1, Ordering::Relaxed);
            hub().first_paint();
            if type_ == PaintElementType::default() { *VIEW_PAINT.lock().unwrap() = Some((w, h)); }
            else if POPUP_PAINTS.fetch_add(1, Ordering::Relaxed) == 0 { rec("on_paint PET_POPUP", json!({ "w": w, "h": h })); }
        }
        fn on_popup_show(&self, _browser: Option<&mut Browser>, show: ::std::os::raw::c_int) { rec("on_popup_show", json!(show)); }
        fn on_popup_size(&self, _browser: Option<&mut Browser>, rect: Option<&Rect>) {
            if let Some(r) = rect { rec("on_popup_size", json!([r.x, r.y, r.width, r.height])); }
        }
        fn start_dragging(&self, _browser: Option<&mut Browser>, drag_data: Option<&mut DragData>, allowed_ops: DragOperationsMask, x: ::std::os::raw::c_int, y: ::std::os::raw::c_int) -> ::std::os::raw::c_int {
            let text = drag_data.map(|d| CefString::from(&d.fragment_text()).to_string()).unwrap_or_default();
            rec("start_dragging", json!({ "x": x, "y": y, "ops": allowed_ops.as_ref().0, "fragment_text": text }));
            // Sotto would start an OLE drag here (DoDragDrop) and report the end; the spike cancels it.
            0
        }
        fn on_ime_composition_range_changed(&self, _browser: Option<&mut Browser>, range: Option<&Range>, bounds: Option<&[Rect]>) {
            let b: Vec<Json> = bounds.unwrap_or(&[]).iter().take(3).map(|r| json!([r.x, r.y, r.width, r.height])).collect();
            rec("on_ime_composition_range_changed", json!({ "range": range.map(|r| [r.from, r.to]), "first_character_bounds": b }));
        }
    }
}

wrap_display_handler! {
    struct OsrDisplay {}
    impl DisplayHandler {
        fn on_cursor_change(&self, _browser: Option<&mut Browser>, _cursor: sys::HCURSOR, type_: CursorType, _info: Option<&CursorInfo>) -> ::std::os::raw::c_int {
            rec("on_cursor_change", json!(format!("{:?}", type_.as_ref())));
            0
        }
        fn on_console_message(&self, _browser: Option<&mut Browser>, _level: LogSeverity, message: Option<&CefString>, _source: Option<&CefString>, _line: ::std::os::raw::c_int) -> ::std::os::raw::c_int {
            if let Some(m) = message { hub().console.lock().unwrap().push(m.to_string()); }
            0
        }
    }
}

wrap_dialog_handler! {
    struct OsrDialogs {}
    impl DialogHandler {
        fn on_file_dialog(&self, _browser: Option<&mut Browser>, mode: FileDialogMode, title: Option<&CefString>, _default_file_path: Option<&CefString>, accept_filters: Option<&mut CefStringList>, _accept_extensions: Option<&mut CefStringList>, _accept_descriptions: Option<&mut CefStringList>, callback: Option<&mut FileDialogCallback>) -> ::std::os::raw::c_int {
            let filters: Vec<String> = accept_filters.map(|l| { let c = std::mem::take(l); c.into_iter().map(|s| s.to_string()).collect() }).unwrap_or_default();
            rec("on_file_dialog", json!({ "mode": format!("{:?}", mode.as_ref()), "title": title.map(|t| t.to_string()), "filters": filters }));
            // Sotto would show its own picker (IFileOpenDialog) here; the spike answers with one file of its own.
            if let Some(cb) = callback {
                let mut list = CefStringList::new();
                list.append(&std::env::var("WP_PICK").unwrap_or_else(|_| std::env::current_exe().unwrap().with_file_name("icudtl.dat").to_string_lossy().into_owned()));
                cb.cont(Some(&mut list));
            }
            1
        }
    }
}

wrap_context_menu_handler! {
    struct OsrMenu {}
    impl ContextMenuHandler {
        fn run_context_menu(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>, params: Option<&mut ContextMenuParams>, model: Option<&mut MenuModel>, callback: Option<&mut RunContextMenuCallback>) -> ::std::os::raw::c_int {
            let items = model.map(|m| m.count()).unwrap_or(0);
            let at = params.map(|p| [p.xcoord(), p.ycoord()]);
            rec("run_context_menu", json!({ "items": items, "at": at }));
            // Sotto would draw its own menu; the spike dismisses it.
            if let Some(cb) = callback { cb.cancel(); }
            1
        }
    }
}

wrap_client! {
    struct OsrClient {}
    impl Client {
        fn render_handler(&self) -> Option<RenderHandler> { Some(OsrRender::new()) }
        fn life_span_handler(&self) -> Option<LifeSpanHandler> { Some(Life::new()) }
        fn load_handler(&self) -> Option<LoadHandler> { Some(Load::new()) }
        fn display_handler(&self) -> Option<DisplayHandler> { Some(OsrDisplay::new()) }
        fn dialog_handler(&self) -> Option<DialogHandler> { Some(OsrDialogs::new()) }
        fn context_menu_handler(&self) -> Option<ContextMenuHandler> { Some(OsrMenu::new()) }
        fn request_handler(&self) -> Option<RequestHandler> { Some(Requests::new()) }
    }
}

fn eval(expr: &str) -> Json {
    cdp("Runtime.evaluate", json!({ "expression": expr, "returnByValue": true, "awaitPromise": true })).map(|v| v["result"]["value"].clone()).unwrap_or(Json::Null)
}
fn page_log() -> Vec<Json> {
    eval("JSON.stringify(window.log)").as_str().and_then(|s| serde_json::from_str(s).ok()).unwrap_or_default()
}
fn host(f: impl FnOnce(&BrowserHost) + Send + 'static) {
    on_ui_wait(move || { if let Some(h) = current_host() { f(&h) } });
}
fn mouse(x: i32, y: i32, modifiers: u32) -> MouseEvent { MouseEvent { x, y, modifiers } }
fn click(x: i32, y: i32, button: sys::cef_mouse_button_type_t) {
    host(move |h| {
        let b = MouseButtonType::from(button);
        h.send_mouse_move_event(Some(&mouse(x, y, 0)), 0);
        h.send_mouse_click_event(Some(&mouse(x, y, 0)), b, 0, 1);
        h.send_mouse_click_event(Some(&mouse(x, y, 0)), b, 1, 1);
    });
}
fn key(code: i32) {
    host(move |h| {
        for t in [sys::cef_key_event_type_t::KEYEVENT_RAWKEYDOWN, sys::cef_key_event_type_t::KEYEVENT_KEYUP] {
            let k = KeyEvent { type_: KeyEventType::from(t), windows_key_code: code, native_key_code: code, ..Default::default() };
            h.send_key_event(Some(&k));
        }
    });
}
fn pause(ms: u64) { std::thread::sleep(Duration::from_millis(ms)) }

pub fn run_osr() -> Json {
    let mut checks: Vec<Json> = Vec::new();
    let mut check = |name: &str, pass: bool, detail: Json| {
        eprintln!("[check] {} {name}", if pass { "PASS" } else { "FAIL" });
        checks.push(json!({ "check": name, "pass": pass, "detail": detail }));
    };
    *hub().view.lock().unwrap() = (800, 600);
    let url = format!("{}/osr.html", std::env::var("WP_BASE").unwrap_or_else(|_| "http://127.0.0.1:8765".into()));
    let seen_loads = hub().load_count();
    on_ui(move || {
        let window_info = WindowInfo { windowless_rendering_enabled: 1, ..Default::default() };
        let settings = BrowserSettings { windowless_frame_rate: 30, ..Default::default() };
        let mut client = OsrClient::new();
        browser_host_create_browser(Some(&window_info), Some(&mut client), Some(&CefString::from(url.as_str())), Some(&settings), None, None);
    });
    if hub().wait_load(seen_loads, Duration::from_secs(30)).is_none() { return json!({ "error": "page did not load" }) }
    attach_observer();
    host(|h| h.set_focus(1));
    pause(500);

    // Device scale factor: a 800x600 view at 1.5 paints 1200x900 and the page reports devicePixelRatio 1.5.
    let dpr = eval("devicePixelRatio");
    let paint = *VIEW_PAINT.lock().unwrap();
    let want = ((800.0 * scale()).round() as i32, (600.0 * scale()).round() as i32);
    check("Device scale factor: page's devicePixelRatio and the painted buffer follow screen_info", dpr.as_f64() == Some(scale() as f64) && paint == Some(want), json!({ "devicePixelRatio": dpr, "paint": paint, "expected": want }));

    // Cursors: the pointer over the link, then over the text field.
    host(|h| h.send_mouse_move_event(Some(&mouse(280, 28, 0)), 0));
    pause(300);
    host(|h| h.send_mouse_move_event(Some(&mouse(100, 100, 0)), 0));
    pause(300);
    let cursors: Vec<String> = seen("on_cursor_change").iter().map(|e| e["detail"].as_str().unwrap_or("").to_string()).collect();
    check("Cursors: on_cursor_change gives a hand over the link and an I-beam over the field", cursors.iter().any(|c| c.contains("HAND")) && cursors.iter().any(|c| c.contains("IBEAM")), json!(cursors));

    // <select>: a click opens CEF's pop-up widget, which arrives as on_popup_show/on_popup_size and PET_POPUP paints
    // that the pane must draw itself; keys then go to the pop-up.
    click(60, 30, sys::cef_mouse_button_type_t::MBT_LEFT);
    pause(600);
    let shown = seen("on_popup_show");
    let size = seen("on_popup_size");
    check("<select>: CEF reports the pop-up (on_popup_show, on_popup_size) and paints it as PET_POPUP", !shown.is_empty() && !size.is_empty() && POPUP_PAINTS.load(Ordering::Relaxed) > 0, json!({ "show": shown, "size": size, "popup_paints": POPUP_PAINTS.load(Ordering::Relaxed) }));
    key(0x28); // Down
    pause(150);
    key(0x0D); // Enter
    pause(500);
    let value = eval("document.getElementById('sel').value");
    check("<select>: Down then Enter, sent to the browser while the pop-up shows, chooses Banana", value == "Banana", json!({ "value": value, "popup_events": seen("on_popup_show") }));

    // IME: compose, then commit, through CEF's IME calls (what a pane does with WM_IME_* or TSF), into the textarea.
    click(100, 100, sys::cef_mouse_button_type_t::MBT_LEFT);
    pause(300);
    eval("window.log = []; true");
    host(|h| {
        let under = CompositionUnderline { size: std::mem::size_of::<CompositionUnderline>(), range: Range { from: 0, to: 3 }, color: 0, background_color: 0, thick: 0, style: Default::default() };
        h.ime_set_composition(Some(&CefString::from("にほん")), Some(&[under]), Some(&Range { from: u32::MAX, to: u32::MAX }), Some(&Range { from: 3, to: 3 }));
    });
    pause(300);
    let composing = eval("document.getElementById('text').value");
    host(|h| h.ime_commit_text(Some(&CefString::from("日本")), Some(&Range { from: u32::MAX, to: u32::MAX }), 0));
    pause(300);
    let log = page_log();
    let value = eval("document.getElementById('text').value");
    let kinds: Vec<Json> = log.iter().map(|e| e["type"].clone()).collect();
    check("IME: ime_set_composition gives compositionstart/update with the text, ime_commit_text gives compositionend and the value", kinds.contains(&json!("compositionstart")) && kinds.contains(&json!("compositionend")) && value == "日本", json!({ "while_composing": composing, "value": value, "events": log }));
    check("IME: CEF reports where the composition is (on_ime_composition_range_changed), so the pane can place the candidate window", !seen("on_ime_composition_range_changed").is_empty(), json!(seen("on_ime_composition_range_changed").into_iter().take(2).collect::<Vec<_>>()));

    // Drag out of the page: press on the draggable box and move with the button held.
    eval("window.log = []; true");
    host(|h| {
        let left = MouseButtonType::from(sys::cef_mouse_button_type_t::MBT_LEFT);
        h.send_mouse_move_event(Some(&mouse(60, 180, 0)), 0);
        h.send_mouse_click_event(Some(&mouse(60, 180, 0)), left, 0, 1);
    });
    for step in 1..=8 { host(move |h| h.send_mouse_move_event(Some(&mouse(60 + step * 6, 180 + step * 3, 16)), 0)); pause(30); }
    pause(400);
    let drags = seen("start_dragging");
    check("Drag from the page: CEF calls start_dragging with the page's data; the pane must run the OS drag itself", !drags.is_empty(), json!({ "start_dragging": drags, "page": page_log() }));
    host(|h| {
        h.drag_source_ended_at(60, 180, DragOperationsMask::from(sys::cef_drag_operations_mask_t::DRAG_OPERATION_NONE));
        h.drag_source_system_drag_ended();
        h.send_mouse_click_event(Some(&mouse(60, 180, 0)), MouseButtonType::from(sys::cef_mouse_button_type_t::MBT_LEFT), 1, 1);
    });
    pause(200);

    // Drop into the page: what the pane's OLE drop target would forward, as CEF drag-target calls.
    eval("window.log = []; true");
    host(|h| {
        if let Some(mut data) = drag_data_create() {
            data.set_fragment_text(Some(&CefString::from("dropped from outside")));
            let every = DragOperationsMask::from(sys::cef_drag_operations_mask_t::DRAG_OPERATION_EVERY);
            h.drag_target_drag_enter(Some(&mut data), Some(&mouse(380, 210, 16)), every.clone());
            h.drag_target_drag_over(Some(&mouse(381, 211, 16)), every);
        }
    });
    pause(200);
    host(|h| { h.drag_target_drop(Some(&mouse(381, 211, 0))); });
    pause(400);
    let log = page_log();
    check("Drop into the page: drag_target_* calls deliver a drop event with the text", log.iter().any(|e| e["type"] == "drop" && e["text"] == "dropped from outside"), json!(log));

    // File picker: a click on the file input calls the dialog handler; Sotto would show the OS picker itself.
    eval("window.log = []; true");
    click(60, 310, sys::cef_mouse_button_type_t::MBT_LEFT);
    pause(800);
    let dialogs = seen("on_file_dialog");
    let log = page_log();
    check("File picker: on_file_dialog is called and the file the handler returns reaches the page", !dialogs.is_empty() && log.iter().any(|e| e["type"] == "file change"), json!({ "on_file_dialog": dialogs, "page": log }));

    // Context menu: a right click calls run_context_menu with CEF's model; Sotto would draw its own menu.
    click(500, 450, sys::cef_mouse_button_type_t::MBT_RIGHT);
    pause(500);
    check("Context menu: run_context_menu is called with a menu model", !seen("run_context_menu").is_empty(), json!(seen("run_context_menu")));

    // Accessibility: off screen, the page's tree reaches the app only as CEF values through AccessibilityHandler,
    // once the app turns accessibility on. Nothing reaches UI Automation by itself.
    host(|h| h.set_accessibility_state(State::ENABLED));
    pause(1500);
    eval("document.getElementById('press').textContent = 'Press me now'; true");
    pause(800);
    let samples = AX_SAMPLE.lock().unwrap().clone();
    let text = serde_json::to_string(&samples).unwrap_or_default();
    check("Accessibility: on_accessibility_tree_change delivers the tree (the button's name is in it) and its updates", AX_TREE_EVENTS.load(Ordering::Relaxed) > 0 && text.contains("Press me") && text.contains("Press me now"), json!({ "tree_events": AX_TREE_EVENTS.load(Ordering::Relaxed), "location_events": AX_LOCATION_EVENTS.load(Ordering::Relaxed), "bytes": text.len() }));
    if let Ok(dir) = std::env::var("WP_RUN_DIR") {
        std::fs::write(format!("{dir}/ax-sample.json"), serde_json::to_string_pretty(&samples.iter().take(3).collect::<Vec<_>>()).unwrap()).ok();
    }

    crate::runs::close_and_quit();
    json!({ "rows": checks, "callbacks": *SEEN.lock().unwrap(), "hub": hub().summary() })
}
