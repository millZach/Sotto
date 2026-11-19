//! The scripted runs. Each runs on its own thread while CEF's message loop runs on the main thread, and returns a
//! JSON record of what happened.

use crate::cefapp::*;
use crate::hub::hub;
use cef::*;
use serde_json::{Value, json};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

pub const IPHONE_UA: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const SETTLE_EXPRESSION: &str = "new Promise(done => { const timer = setTimeout(done, 500); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); done() })) })";

fn base() -> String {
    std::env::var("WP_BASE").unwrap_or_else(|_| "http://127.0.0.1:8765".into())
}

/// One command, timed, kept as a row of the evidence.
struct Rows(Vec<Value>);
impl Rows {
    fn call(&mut self, method: &str, params: Value) -> Result<Value, Value> {
        let start = Instant::now();
        let result = cdp(method, params.clone());
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        let row = match &result {
            Ok(v) => json!({ "method": method, "ok": true, "ms": round(ms), "result": shorten(v) }),
            Err(e) => json!({ "method": method, "ok": false, "ms": round(ms), "error": e }),
        };
        eprintln!("[cdp] {} {} {:.1} ms", method, if result.is_ok() { "ok" } else { "FAILED" }, ms);
        self.0.push(row);
        result
    }
    fn check(&mut self, name: &str, pass: bool, detail: Value) {
        eprintln!("[check] {} {name}", if pass { "PASS" } else { "FAIL" });
        self.0.push(json!({ "check": name, "pass": pass, "detail": detail }));
    }
}

fn round(ms: f64) -> f64 {
    (ms * 10.0).round() / 10.0
}

fn shorten(v: &Value) -> Value {
    let text = v.to_string();
    if text.len() <= 600 { v.clone() } else { json!(format!("{}… ({} bytes)", &text[..600.min(text.len())], text.len())) }
}

fn eval(expr: &str) -> Value {
    cdp("Runtime.evaluate", json!({ "expression": expr, "returnByValue": true, "awaitPromise": true }))
        .map(|v| v["result"]["value"].clone())
        .unwrap_or(Value::Null)
}

fn page_log() -> Vec<Value> {
    eval("JSON.stringify(window.log || [])").as_str().and_then(|s| serde_json::from_str(s).ok()).unwrap_or_default()
}
fn clear_log() {
    eval("window.log = []; true");
}
fn events_named(method: &str) -> Vec<Value> {
    hub().events.lock().unwrap().iter().filter(|(_, m, _)| m == method).map(|(_, _, p)| p.clone()).collect()
}

fn open(url: &str, view: (i32, i32), context: Option<RequestContext>) -> bool {
    *hub().view.lock().unwrap() = view;
    let seen = hub().load_count();
    create_offscreen(url, context, 60);
    let loaded = hub().wait_load(seen, Duration::from_secs(30));
    if loaded.is_none() {
        hub().note(format!("{url} did not finish loading in 30 s"));
        return false;
    }
    attach_observer();
    true
}

fn load(url: &str) -> bool {
    let seen = hub().load_count();
    navigate(url);
    hub().wait_load(seen, Duration::from_secs(30)).is_some()
}

fn host_mouse(x: i32, y: i32, kind: &'static str) {
    on_ui_wait(move || {
        {
            let Some(host) = current_host() else { return };
            let event = MouseEvent { x, y, modifiers: 0 };
            match kind {
                "move" => host.send_mouse_move_event(Some(&event), 0),
                "click" => {
                    let left = MouseButtonType::from(sys::cef_mouse_button_type_t::MBT_LEFT);
                    host.send_mouse_move_event(Some(&event), 0);
                    host.send_mouse_click_event(Some(&event), left, 0, 1);
                    host.send_mouse_click_event(Some(&event), left, 1, 1);
                }
                _ => {}
            }
        }
    });
}

/// The pane turning the user's pointer into a touch itself, through CEF's own touch input.
fn host_tap(x: f32, y: f32) {
    on_ui_wait(move || {
        let Some(host) = current_host() else { return };
        for kind in [sys::cef_touch_event_type_t::CEF_TET_PRESSED, sys::cef_touch_event_type_t::CEF_TET_RELEASED] {
            let event = TouchEvent { id: 1, x, y, radius_x: 4.0, radius_y: 4.0, rotation_angle: 0.0, pressure: 1.0, type_: TouchEventType::from(kind), modifiers: 0, pointer_type: PointerType::from(sys::cef_pointer_type_t::CEF_POINTER_TYPE_TOUCH) };
            host.send_touch_event(Some(&event));
        }
    });
}

fn host_call(f: impl FnOnce(&BrowserHost) + Send + 'static) {
    on_ui_wait(move || {
        if let Some(host) = current_host() {
            f(&host)
        }
    });
}

fn png_size(b64: &str) -> Option<(u32, u32)> {
    let bytes = decode_b64(&b64[..b64.len().min(64)]);
    if bytes.len() < 24 || &bytes[1..4] != b"PNG" { return None }
    Some((u32::from_be_bytes(bytes[16..20].try_into().ok()?), u32::from_be_bytes(bytes[20..24].try_into().ok()?)))
}
fn decode_b64(s: &str) -> Vec<u8> {
    let table = |c: u8| -> Option<u8> {
        Some(match c { b'A'..=b'Z' => c - b'A', b'a'..=b'z' => c - b'a' + 26, b'0'..=b'9' => c - b'0' + 52, b'+' => 62, b'/' => 63, _ => return None })
    };
    let mut out = Vec::new();
    let mut buf = 0u32;
    let mut bits = 0;
    for c in s.bytes() {
        let Some(v) = table(c) else { continue };
        buf = (buf << 6) | v as u32;
        bits += 6;
        if bits >= 8 { bits -= 8; out.push((buf >> bits) as u8); }
    }
    out
}

// ------------------------------------------------------------------ question 1: the command list

pub fn run_cdp() -> Value {
    let mut rows = Rows(Vec::new());
    if !open(&format!("{}/cdp.html", base()), (1280, 800), None) {
        return json!({ "error": "page did not load", "hub": hub().summary() });
    }
    // ready(): the commands pageAutomation sends on attach.
    rows.call("Network.enable", json!({})).ok();
    rows.call("Runtime.enable", json!({})).ok();
    // Reload so the page's console error, exception, 404 and refused connection arrive while enabled.
    hub().events.lock().unwrap().clear();
    load(&format!("{}/cdp.html?again", base()));
    std::thread::sleep(Duration::from_millis(600));
    let not_found = events_named("Network.responseReceived").into_iter().filter(|p| p["response"]["status"].as_i64().unwrap_or(0) >= 400).count();
    rows.check("Network.responseReceived carries the 404", not_found > 0, json!({ "count": not_found }));
    let failed = events_named("Network.loadingFailed");
    rows.check("Network.loadingFailed for the refused connection", !failed.is_empty(), json!(failed.iter().map(|p| p["errorText"].clone()).collect::<Vec<_>>()));
    let exceptions = events_named("Runtime.exceptionThrown");
    rows.check("Runtime.exceptionThrown", !exceptions.is_empty(), json!(exceptions.iter().map(|p| p["exceptionDetails"]["exception"]["description"].clone()).collect::<Vec<_>>()));
    let console = events_named("Runtime.consoleAPICalled").into_iter().filter(|p| p["type"] == "error").count();
    rows.check("Runtime.consoleAPICalled type error", console > 0, json!({ "count": console }));

    // Codecs: Electron's Chromium plays H.264 and AAC; CEF's published builds are Chromium-branded.
    let codecs = eval("JSON.stringify(Object.fromEntries([['h264','video/mp4; codecs=\"avc1.42E01E\"'],['aac','audio/mp4; codecs=\"mp4a.40.2\"'],['hevc','video/mp4; codecs=\"hvc1.1.6.L93.B0\"'],['vp9','video/webm; codecs=\"vp9\"'],['av1','video/mp4; codecs=\"av01.0.05M.08\"'],['opus','audio/webm; codecs=\"opus\"'],['mp3','audio/mpeg']].map(([k,t]) => [k, document.createElement('video').canPlayType(t) || 'no']))) ");
    rows.check("Codecs the page can play (informational: h264 and aac matter for Electron parity)", codecs.as_str().map(|c| c.contains("\"h264\":\"probably\"")).unwrap_or(false), codecs.clone());

    // Viewport: setDeviceMetricsOverride, then clearDeviceMetricsOverride.
    rows.call("Emulation.setDeviceMetricsOverride", json!({ "width": 1000, "height": 700, "deviceScaleFactor": 1, "mobile": false })).ok();
    let inner = eval("[innerWidth, innerHeight]");
    rows.check("setDeviceMetricsOverride gives a 1000x700 viewport", inner == json!([1000, 700]), inner);
    rows.call("Emulation.clearDeviceMetricsOverride", json!({})).ok();
    let inner = eval("[innerWidth, innerHeight]");
    rows.check("clearDeviceMetricsOverride gives back the 1280x800 view", inner == json!([1280, 800]), inner);

    // inspect(): the full accessibility tree and the element list.
    if let Ok(tree) = rows.call("Accessibility.getFullAXTree", json!({})) {
        let nodes = tree["nodes"].as_array().cloned().unwrap_or_default();
        let named: Vec<_> = nodes.iter().filter(|n| n["ignored"] != true).map(|n| format!("{}:{}", n["role"]["value"].as_str().unwrap_or(""), n["name"]["value"].as_str().unwrap_or(""))).collect();
        let has = |s: &str| named.iter().any(|n| n == s);
        rows.check("AX tree has button 'Press me', heading and the text field", has("button:Press me") && has("heading:Page automation test") && named.iter().any(|n| n.starts_with("textbox")), json!({ "nodes": nodes.len(), "sample": named.iter().take(14).collect::<Vec<_>>() }));
    }
    let elements = rows.call("Runtime.evaluate", json!({ "expression": "Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],h1,h2,h3')).slice(0,100).map(el => { const r=el.getBoundingClientRect(); return { tag:el.tagName.toLowerCase(), name:(el.getAttribute('aria-label')||el.innerText||el.getAttribute('placeholder')||'').slice(0,200), x:r.x,y:r.y,width:r.width,height:r.height }; })", "returnByValue": true }));
    rows.check("Runtime.evaluate returnByValue gives the element list", elements.as_ref().map(|v| v["result"]["value"].as_array().map(|a| a.len()).unwrap_or(0) >= 5).unwrap_or(false), json!(null));

    // snapshot(): layout metrics and screenshots, PNG at 1 and JPEG at a scale.
    let layout = rows.call("Page.getLayoutMetrics", json!({})).unwrap_or_default();
    let vv = layout["cssVisualViewport"].clone();
    // A tall page has a classic 15 px scrollbar on Linux, as in Electron, so the visible width is 1265.
    rows.check("Page.getLayoutMetrics cssVisualViewport is the view less its scrollbar", vv["clientWidth"].as_f64().map(|w| w == 1280.0 || w == 1265.0).unwrap_or(false) && vv["clientHeight"].as_f64() == Some(800.0), vv.clone());
    let shot = rows.call("Page.captureScreenshot", json!({ "format": "png", "fromSurface": true, "captureBeyondViewport": true, "clip": { "x": 0, "y": 0, "width": 1280, "height": 800, "scale": 1 } }));
    let size = shot.as_ref().ok().and_then(|v| v["data"].as_str()).and_then(png_size);
    rows.check("PNG screenshot is 1280x800", size == Some((1280, 800)), json!(size));
    if let Ok(v) = &shot {
        if let (Some(data), Ok(dir)) = (v["data"].as_str(), std::env::var("WP_RUN_DIR")) {
            let _ = std::fs::write(format!("{dir}/cdp-screenshot.png"), decode_b64(data));
        }
    }
    let jpeg = rows.call("Page.captureScreenshot", json!({ "format": "jpeg", "quality": 70, "fromSurface": true, "captureBeyondViewport": true, "clip": { "x": 0, "y": 0, "width": 1280, "height": 800, "scale": 0.5 } }));
    rows.check("JPEG screenshot at scale 0.5 returns data", jpeg.as_ref().map(|v| v["data"].as_str().map(|d| d.starts_with("/9j/")).unwrap_or(false)).unwrap_or(false), json!(null));
    let region = rows.call("Page.captureScreenshot", json!({ "format": "png", "fromSurface": true, "captureBeyondViewport": true, "clip": { "x": 40, "y": 120, "width": 200, "height": 60, "scale": 1 } }));
    let size = region.as_ref().ok().and_then(|v| v["data"].as_str()).and_then(png_size);
    rows.check("Region screenshot is 200x60", size == Some((200, 60)), json!(size));

    // target(): hit testing at a point, and the focused node.
    let at = rows.call("DOM.getNodeForLocation", json!({ "x": 140, "y": 150, "includeUserAgentShadowDOM": true })).unwrap_or_default();
    let backend = at["backendNodeId"].as_i64().unwrap_or(0);
    let described = rows.call("DOM.describeNode", json!({ "backendNodeId": backend, "depth": 1, "pierce": true })).unwrap_or_default();
    rows.check("getNodeForLocation(140,150) is the button", described["node"]["nodeName"] == "BUTTON", described["node"]["nodeName"].clone());
    let nothing = cdp("DOM.getNodeForLocation", json!({ "x": 5000, "y": 5000, "includeUserAgentShadowDOM": true }));
    rows.check("getNodeForLocation off the page errors with 'No node found'", nothing.as_ref().err().map(|e| e.to_string().to_lowercase().contains("no node found")).unwrap_or(false), json!(nothing.err()));

    // dispatch(): a click.
    clear_log();
    rows.call("Input.dispatchMouseEvent", json!({ "type": "mousePressed", "x": 140, "y": 150, "button": "left", "clickCount": 1 })).ok();
    rows.call("Input.dispatchMouseEvent", json!({ "type": "mouseReleased", "x": 140, "y": 150, "button": "left", "clickCount": 1 })).ok();
    let log = page_log();
    rows.check("Click reaches the button as a trusted click", log.iter().any(|e| e["type"] == "click" && e["trusted"] == true), json!(log));

    // type: click the field, then insertText; the focused node check first.
    clear_log();
    rows.call("Input.dispatchMouseEvent", json!({ "type": "mousePressed", "x": 100, "y": 212, "button": "left", "clickCount": 1 })).ok();
    rows.call("Input.dispatchMouseEvent", json!({ "type": "mouseReleased", "x": 100, "y": 212, "button": "left", "clickCount": 1 })).ok();
    let focused = rows.call("Runtime.evaluate", json!({ "expression": "document.activeElement", "objectGroup": "sotto-browser-target" })).unwrap_or_default();
    let object_id = focused["result"]["objectId"].as_str().unwrap_or("").to_string();
    let node = rows.call("DOM.describeNode", json!({ "objectId": object_id })).unwrap_or_default();
    rows.call("Runtime.releaseObjectGroup", json!({ "objectGroup": "sotto-browser-target" })).ok();
    rows.check("Focused node after clicking the field is the INPUT", node["node"]["nodeName"] == "INPUT", node["node"]["nodeName"].clone());
    rows.call("Input.insertText", json!({ "text": "héllo wörld 日本語" })).ok();
    let value = eval("document.getElementById('field').value");
    rows.check("insertText types Unicode into the field", value == "héllo wörld 日本語", value);
    let log = page_log();
    rows.check("insertText fires a trusted input event", log.iter().any(|e| e["type"] == "input" && e["trusted"] == true), json!(log.len()));

    // key: Enter (keyDown with text) and Backspace (rawKeyDown).
    clear_log();
    for (key, code, text) in [("Enter", 13, Some("\r")), ("Backspace", 8, None), ("Escape", 27, None), ("ArrowDown", 40, None)] {
        let event = json!({ "key": key, "code": key, "windowsVirtualKeyCode": code, "nativeVirtualKeyCode": code });
        let mut down = event.clone();
        down["type"] = json!(if text.is_some() { "keyDown" } else { "rawKeyDown" });
        if let Some(t) = text { down["text"] = json!(t); down["unmodifiedText"] = json!(t); }
        rows.call("Input.dispatchKeyEvent", down).ok();
        let mut up = event.clone();
        up["type"] = json!("keyUp");
        rows.call("Input.dispatchKeyEvent", up).ok();
    }
    let log = page_log();
    let keys: Vec<_> = log.iter().filter(|e| e["type"] == "keydown").map(|e| e["key"].clone()).collect();
    rows.check("Keys arrive as trusted keydowns", keys == vec![json!("Enter"), json!("Backspace"), json!("Escape"), json!("ArrowDown")] && log.iter().all(|e| e["trusted"] != false), json!(keys));
    let value = eval("document.getElementById('field').value");
    rows.check("Backspace removed one character", value == "héllo wörld 日本", value);

    // scroll: mouseWheel, then the settle expression; then a hit test on the scrolled page.
    clear_log();
    rows.call("Input.dispatchMouseEvent", json!({ "type": "mouseWheel", "x": 600, "y": 400, "deltaX": 0, "deltaY": 500 })).ok();
    let settle = Instant::now();
    rows.call("Runtime.evaluate", json!({ "expression": SETTLE_EXPRESSION, "awaitPromise": true })).ok();
    let settle_ms = settle.elapsed().as_secs_f64() * 1000.0;
    let scrolled = eval("scrollY");
    rows.check("Wheel scrolls the page", scrolled.as_f64().unwrap_or(0.0) > 0.0, json!({ "scrollY": scrolled, "settle_ms": round(settle_ms) }));
    let layout = cdp("Page.getLayoutMetrics", json!({})).unwrap_or_default();
    let page_y = layout["cssVisualViewport"]["pageY"].as_f64().unwrap_or(0.0);
    let deep = eval("(() => { const r = document.getElementById('deep').getBoundingClientRect(); return [r.x + 20, r.y + 10]; })()");
    if let (Some(x), Some(y)) = (deep[0].as_f64(), deep[1].as_f64()) {
        let at = cdp("DOM.getNodeForLocation", json!({ "x": x.round(), "y": (page_y + y).round(), "includeUserAgentShadowDOM": true })).unwrap_or_default();
        let d = cdp("DOM.describeNode", json!({ "backendNodeId": at["backendNodeId"] })).unwrap_or_default();
        rows.check("Hit test on the scrolled page (pageY added) finds the deep heading", d["node"]["nodeName"] == "H2", json!({ "pageY": page_y, "node": d["node"]["nodeName"] }));
    }

    // pointed()/describe(): the node's box, markup and partial AX tree.
    let at = cdp("DOM.getNodeForLocation", json!({ "x": 140, "y": 150 - page_y as i64, "includeUserAgentShadowDOM": true }));
    let _ = at;
    eval("scrollTo(0, 0); true");
    std::thread::sleep(Duration::from_millis(200));
    let at = cdp("DOM.getNodeForLocation", json!({ "x": 140, "y": 150, "includeUserAgentShadowDOM": true })).unwrap_or_default();
    let backend = at["backendNodeId"].clone();
    let partial = rows.call("Accessibility.getPartialAXTree", json!({ "backendNodeId": backend, "fetchRelatives": false })).unwrap_or_default();
    rows.check("getPartialAXTree names the button", partial["nodes"][0]["name"]["value"] == "Press me", partial["nodes"][0]["name"].clone());
    let model = rows.call("DOM.getBoxModel", json!({ "backendNodeId": backend })).unwrap_or_default();
    rows.check("getBoxModel border quad at (40,120) 200x60", model["model"]["border"].as_array().map(|q| q.iter().map(|v| v.as_f64().unwrap_or(-1.0)).collect::<Vec<_>>()) == Some(vec![40.0, 120.0, 240.0, 120.0, 240.0, 180.0, 40.0, 180.0]), model["model"]["border"].clone());
    let html = rows.call("DOM.getOuterHTML", json!({ "backendNodeId": backend })).unwrap_or_default();
    rows.check("getOuterHTML is the button's markup", html["outerHTML"].as_str().map(|h| h.starts_with("<button")).unwrap_or(false), html["outerHTML"].clone());

    // point(): Chromium's inspect overlay. Hover and click arrive through the pane's own input path (CEF's
    // SendMouse*Event, which is how a native pane forwards the user's pointer) and then through CDP input.
    rows.call("DOM.enable", json!({})).ok();
    rows.call("DOM.getDocument", json!({ "depth": 0 })).ok();
    rows.call("Overlay.enable", json!({})).ok();
    let highlight = json!({ "showInfo": true, "showAccessibilityInfo": true, "showExtensionLines": false, "showStyles": false, "showRulers": false, "contentColor": { "r": 80, "g": 120, "b": 255, "a": 0.3 }, "paddingColor": { "r": 80, "g": 120, "b": 255, "a": 0.4 }, "borderColor": { "r": 80, "g": 120, "b": 255, "a": 0.7 }, "marginColor": { "r": 80, "g": 120, "b": 255, "a": 0.15 } });
    for path in ["host", "cdp"] {
        hub().events.lock().unwrap().clear();
        clear_log();
        rows.call("Overlay.setInspectMode", json!({ "mode": "searchForNode", "highlightConfig": highlight })).ok();
        if path == "host" {
            host_mouse(60, 60, "move");
            std::thread::sleep(Duration::from_millis(150));
            host_mouse(140, 150, "move");
            std::thread::sleep(Duration::from_millis(300));
            host_mouse(140, 150, "click");
        } else {
            for (x, y) in [(60, 60), (140, 150)] {
                cdp("Input.dispatchMouseEvent", json!({ "type": "mouseMoved", "x": x, "y": y })).ok();
                std::thread::sleep(Duration::from_millis(150));
            }
            cdp("Input.dispatchMouseEvent", json!({ "type": "mousePressed", "x": 140, "y": 150, "button": "left", "clickCount": 1 })).ok();
            cdp("Input.dispatchMouseEvent", json!({ "type": "mouseReleased", "x": 140, "y": 150, "button": "left", "clickCount": 1 })).ok();
        }
        std::thread::sleep(Duration::from_millis(400));
        let hovered = events_named("Overlay.nodeHighlightRequested");
        let picked = events_named("Overlay.inspectNodeRequested");
        let reached = page_log().iter().any(|e| e["type"] == "click");
        rows.check(&format!("Point mode via {path} input: hover reports a node"), !hovered.is_empty(), json!(hovered.len()));
        rows.check(&format!("Point mode via {path} input: click reports the node and does not reach the page"), !picked.is_empty() && !reached, json!({ "picked": picked, "click_reached_page": reached }));
        if let Some(p) = picked.first() {
            let d = cdp("DOM.describeNode", json!({ "backendNodeId": p["backendNodeId"] })).unwrap_or_default();
            rows.check(&format!("Point mode via {path} input: picked node is the button"), d["node"]["nodeName"] == "BUTTON", d["node"]["nodeName"].clone());
        }
        rows.call("Overlay.setInspectMode", json!({ "mode": "none", "highlightConfig": {} })).ok();
        rows.call("Overlay.hideHighlight", json!({})).ok();
    }
    // nodeHighlightRequested names a DOM nodeId; describe it as hover() does.
    // (Covered by the describeNode rows above with backendNodeId; nodeId works once DOM.getDocument has run.)
    let doc = cdp("DOM.getDocument", json!({ "depth": 0 })).unwrap_or_default();
    let with_node_id = cdp("DOM.describeNode", json!({ "nodeId": doc["root"]["nodeId"] }));
    rows.check("describeNode by nodeId after getDocument", with_node_id.is_ok(), json!(with_node_id.ok().map(|v| v["node"]["nodeName"].clone())));

    // A hidden pane: CEF's was_hidden stops frames, as an off-screen WebContentsView does. Does a wheel still answer?
    host_call(|h| h.was_hidden(1));
    std::thread::sleep(Duration::from_millis(300));
    let start = Instant::now();
    let hidden_wheel = cdp("Input.dispatchMouseEvent", json!({ "type": "mouseWheel", "x": 600, "y": 400, "deltaX": 0, "deltaY": 300 }));
    let hidden_ms = start.elapsed().as_secs_f64() * 1000.0;
    let start = Instant::now();
    let hidden_shot = cdp("Page.captureScreenshot", json!({ "format": "png", "fromSurface": true }));
    let shot_ms = start.elapsed().as_secs_f64() * 1000.0;
    rows.check("Hidden page: wheel answers (informational)", hidden_wheel.is_ok(), json!({ "ms": round(hidden_ms), "error": hidden_wheel.err() }));
    rows.check("Hidden page: screenshot answers (informational)", hidden_shot.is_ok(), json!({ "ms": round(shot_ms), "error": hidden_shot.err() }));
    // prepareCapture()'s answer in CEF: show the page for the input (was_hidden(0)), hide it again after.
    host_call(|h| h.was_hidden(1));
    std::thread::sleep(Duration::from_millis(300));
    let start = Instant::now();
    host_call(|h| h.was_hidden(0));
    let lent = cdp("Input.dispatchMouseEvent", json!({ "type": "mouseWheel", "x": 600, "y": 400, "deltaX": 0, "deltaY": 300 }));
    let lent_ms = start.elapsed().as_secs_f64() * 1000.0;
    host_call(|h| h.was_hidden(1));
    rows.check("Hidden page shown just for the wheel (CEF's prepareCapture) answers", lent.is_ok(), json!({ "ms": round(lent_ms), "error": lent.err() }));
    host_call(|h| h.was_hidden(0));

    // detach(): pageAutomation counts on Chromium dropping emulation with the attachment. In CEF the session lives
    // while an observer is registered; dropping the registration is the nearest thing to a detach.
    cdp("Emulation.setDeviceMetricsOverride", json!({ "width": 900, "height": 600, "deviceScaleFactor": 1, "mobile": false })).ok();
    let before = eval("innerWidth");
    on_ui_wait(drop_observer);
    std::thread::sleep(Duration::from_millis(500));
    attach_observer();
    let after = eval("innerWidth");
    rows.check("Dropping the observer registration ends the session and its emulation (informational)", before == 900 && after != 900, json!({ "before": before, "after": after }));
    cdp("Emulation.clearDeviceMetricsOverride", json!({})).ok();

    // Touch emulation commands are covered by the iPhone run; send them here too so the list is complete.
    rows.call("Emulation.setTouchEmulationEnabled", json!({ "enabled": true, "maxTouchPoints": 5 })).ok();
    rows.call("Emulation.setEmitTouchEventsForMouse", json!({ "enabled": true, "configuration": "mobile" })).ok();
    rows.call("Input.dispatchTouchEvent", json!({ "type": "touchStart", "touchPoints": [{ "x": 140, "y": 150 }] })).ok();
    rows.call("Input.dispatchTouchEvent", json!({ "type": "touchEnd", "touchPoints": [] })).ok();

    close_and_quit();
    json!({ "rows": rows.0, "hub": hub().summary(), "console": *hub().console.lock().unwrap() })
}

// ------------------------------------------------------------------ question 3: the test iPhone

pub fn run_iphone() -> Value {
    let mut rows = Rows(Vec::new());
    if !open(&format!("{}/idle.html", base()), (393, 852), None) {
        return json!({ "error": "page did not load", "hub": hub().summary() });
    }
    // What Sotto does: the page's own user agent (Electron's setUserAgent, here the protocol's override), touch
    // emulation on attach, the view at 393x852, scrollbars hidden.
    rows.call("Emulation.setUserAgentOverride", json!({ "userAgent": IPHONE_UA, "platform": "iPhone" })).ok();
    rows.call("Network.enable", json!({})).ok();
    rows.call("Runtime.enable", json!({})).ok();
    rows.call("Emulation.setTouchEmulationEnabled", json!({ "enabled": true, "maxTouchPoints": 5 })).ok();
    rows.call("Emulation.setEmitTouchEventsForMouse", json!({ "enabled": true, "configuration": "mobile" })).ok();
    rows.call("Emulation.setScrollbarsHidden", json!({ "hidden": true })).ok();
    load(&format!("{}/iphone.html", base()));
    let facts = eval("facts()");
    rows.check("Lays out at 393x852", facts["innerWidth"] == 393 && facts["innerHeight"] == 852, facts.clone());
    rows.check("navigator.userAgent is iOS Safari's", facts["ua"] == IPHONE_UA, facts["ua"].clone());
    rows.check("A touch screen: maxTouchPoints 5, ontouchstart, pointer coarse", facts["maxTouchPoints"] == 5 && facts["ontouchstart"] == true && facts["coarse"] == true, json!({ "maxTouchPoints": facts["maxTouchPoints"], "ontouchstart": facts["ontouchstart"], "coarse": facts["coarse"], "hover": facts["hover"] }));
    let header_ua = eval("fetch('/canary/ua').then(() => true)");
    let _ = header_ua;

    // tap at (110,200): the red pad is at 100..140 x 190..230.
    clear_log();
    rows.call("Input.dispatchTouchEvent", json!({ "type": "touchStart", "touchPoints": [{ "x": 110, "y": 200 }] })).ok();
    rows.call("Input.dispatchTouchEvent", json!({ "type": "touchEnd", "touchPoints": [] })).ok();
    cdp("Runtime.evaluate", json!({ "expression": SETTLE_EXPRESSION, "awaitPromise": true })).ok();
    std::thread::sleep(Duration::from_millis(400));
    let log = page_log();
    let start = log.iter().find(|e| e["type"] == "touchstart").cloned().unwrap_or_default();
    rows.check("Tap at (110,200) reaches the pad at (110,200) as a trusted touch", start["target"] == "pad" && start["x"] == 110 && start["y"] == 200 && start["trusted"] == true, start.clone());
    rows.check("Tap also gives the page a click (tap gesture)", log.iter().any(|e| e["type"] == "click" && e["target"] == "pad"), json!(log.iter().map(|e| e["type"].clone()).collect::<Vec<_>>()));

    // swipe: 10 moves up the page.
    clear_log();
    rows.call("Input.dispatchTouchEvent", json!({ "type": "touchStart", "touchPoints": [{ "x": 200, "y": 700 }] })).ok();
    for step in 1..=10 {
        let y = 700.0 + (200.0 - 700.0) * step as f64 / 10.0;
        cdp("Input.dispatchTouchEvent", json!({ "type": "touchMove", "touchPoints": [{ "x": 200, "y": y.round() }] })).ok();
    }
    rows.call("Input.dispatchTouchEvent", json!({ "type": "touchEnd", "touchPoints": [] })).ok();
    cdp("Runtime.evaluate", json!({ "expression": SETTLE_EXPRESSION, "awaitPromise": true })).ok();
    std::thread::sleep(Duration::from_millis(800));
    let y = eval("scrollY");
    rows.check("Swipe up scrolls the page", y.as_f64().unwrap_or(0.0) > 100.0, y);
    // Let the fling finish before putting the page back, or later taps land on a page still moving.
    let mut last = -1.0;
    for _ in 0..50 { let now = eval("scrollY").as_f64().unwrap_or(0.0); if now == last { break } last = now; std::thread::sleep(Duration::from_millis(200)); }
    eval("scrollTo(0,0); true");
    std::thread::sleep(Duration::from_millis(300));

    // The pane's own pointer: a mouse click through CEF's input path, with touch emitted for the mouse.
    clear_log();
    host_mouse(110, 200, "click");
    std::thread::sleep(Duration::from_millis(500));
    let log = page_log();
    rows.check("A pointer click through CEF's mouse input arrives as touch (emitTouchEventsForMouse) (informational)", log.iter().any(|e| e["type"] == "touchstart"), json!(log.iter().map(|e| format!("{}@{},{}", e["type"].as_str().unwrap_or(""), e["x"], e["y"])).collect::<Vec<_>>()));
    clear_log();
    host_tap(110.0, 200.0);
    std::thread::sleep(Duration::from_millis(500));
    let log = page_log();
    rows.check("The pane's pointer sent as CEF touch input arrives as a trusted touch on the pad", log.iter().any(|e| e["type"] == "touchstart" && e["target"] == "pad" && e["trusted"] == true), json!(log.iter().map(|e| format!("{}@{},{}", e["type"].as_str().unwrap_or(""), e["x"], e["y"])).collect::<Vec<_>>()));

    // Page zoom fit (ADR-0045): the view drawn at 0.75 of the phone, zoom 0.75 so layout stays 393 wide, and a
    // touch at (110,200) still lands at (110,200).
    let level = (0.75f64).ln() / (1.2f64).ln();
    *hub().view.lock().unwrap() = (295, 639);
    host_call(move |h| { h.set_zoom_level(level); h.was_resized(); });
    std::thread::sleep(Duration::from_millis(800));
    let facts = eval("facts()");
    rows.check("At page zoom 0.75 in a 295x639 view, layout is still 393 wide", facts["innerWidth"] == 393, json!({ "innerWidth": facts["innerWidth"], "innerHeight": facts["innerHeight"], "dpr": facts["dpr"] }));
    clear_log();
    cdp("Input.dispatchTouchEvent", json!({ "type": "touchStart", "touchPoints": [{ "x": 110, "y": 200 }] })).ok();
    cdp("Input.dispatchTouchEvent", json!({ "type": "touchEnd", "touchPoints": [] })).ok();
    std::thread::sleep(Duration::from_millis(400));
    let log = page_log();
    let start = log.iter().find(|e| e["type"] == "touchstart").cloned().unwrap_or_default();
    rows.check("Zoomed: CDP touch at (110,200) lands at (110,200) on the pad", start["x"] == 110 && start["y"] == 200 && start["target"] == "pad", start);
    let shot = cdp("Page.captureScreenshot", json!({ "format": "png", "fromSurface": true, "captureBeyondViewport": true, "clip": { "x": 0, "y": 0, "width": 393, "height": 852, "scale": 1 } }));
    let size = shot.as_ref().ok().and_then(|v| v["data"].as_str()).and_then(png_size);
    rows.check("Zoomed: a 393x852 screenshot is still 393x852", size == Some((393, 852)), json!(size));
    if let (Ok(v), Ok(dir)) = (&shot, std::env::var("WP_RUN_DIR")) {
        if let Some(data) = v["data"].as_str() { let _ = std::fs::write(format!("{dir}/iphone-screenshot.png"), decode_b64(data)); }
    }
    // The pane's pointer at zoom: a click at view (82,150) is CSS (110,200) at 0.75.
    clear_log();
    host_tap(82.0, 150.0);
    std::thread::sleep(Duration::from_millis(500));
    let log = page_log();
    let start = log.iter().find(|e| e["type"] == "touchstart").cloned().unwrap_or_default();
    rows.check("Zoomed: the pane's touch at view (82,150) lands at CSS (~110,~200) on the pad", start["target"] == "pad", json!(log));

    close_and_quit();
    json!({ "rows": rows.0, "hub": hub().summary() })
}

// ------------------------------------------------------------------ question 2: the seal

pub fn run_seal(seal: Seal) -> Value {
    let html = std::fs::read(std::env::var("WP_HOSTILE").expect("WP_HOSTILE")).expect("hostile page");
    let token = format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
    let address = format!("{SCHEME}://page/{token}");
    *config().sealed_page.lock().unwrap() = Some((address.clone(), html));
    *config().sealed_url.lock().unwrap() = Some(address.clone());
    let port = config().dead_proxy_port;
    let context = on_ui_wait(move || sealed_context(seal, port).map(SendBox));
    let Some(SendBox(context)) = context else { return json!({ "error": "no context" }) };
    let deadline = Instant::now() + Duration::from_secs(10);
    while !CONTEXT_READY.load(Ordering::SeqCst) && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(10)); }
    if !open(&address, (900, 700), Some(context)) {
        return json!({ "error": "sealed page did not load", "hub": hub().summary(), "console": *hub().console.lock().unwrap() });
    }
    if seal.no_rtc {
        // The guest preload's job in Electron: remove RTCPeerConnection before the page's script runs. CEF has no
        // preload; a render-process handler or this protocol command does it. The page loads again after it.
        cdp("Page.enable", json!({})).ok();
        cdp("Page.addScriptToEvaluateOnNewDocument", json!({ "source": "delete window.RTCPeerConnection; delete window.webkitRTCPeerConnection;", "runImmediately": true })).ok();
    }
    // Let the hostile page run every attempt; it says DONE when finished.
    let deadline = Instant::now() + Duration::from_secs(70);
    while Instant::now() < deadline {
        if hub().console.lock().unwrap().iter().any(|m| m.starts_with("DONE")) { break }
        std::thread::sleep(Duration::from_millis(200));
    }
    // Then ask for a second load of the same address, as a page that tries to reload itself would.
    let seen = hub().load_count();
    navigate(&address);
    let second = hub().wait_load(seen, Duration::from_secs(5));
    std::thread::sleep(Duration::from_secs(3));
    close_and_quit();
    json!({ "seal": seal, "address": address, "second_load": second.map(|(_, s, u)| json!({"status": s, "url": u})), "hub": hub().summary(), "console": *hub().console.lock().unwrap() })
}

struct SendBox(RequestContext);
unsafe impl Send for SendBox {}

// ------------------------------------------------------------------ question 5: its own network calls

pub fn run_net() -> Value {
    let idle_s: u64 = std::env::var("WP_IDLE_S").ok().and_then(|v| v.parse().ok()).unwrap_or(180);
    let page_s: u64 = std::env::var("WP_PAGE_S").ok().and_then(|v| v.parse().ok()).unwrap_or(180);
    let mut marks = vec![json!({ "mark": "initialized, no page", "ms": hub().ms() })];
    eprintln!("[net] idle for {idle_s} s");
    std::thread::sleep(Duration::from_secs(idle_s));
    marks.push(json!({ "mark": "opening one page", "ms": hub().ms() }));
    let opened = open(&format!("{}/idle.html", base()), (1280, 800), None);
    marks.push(json!({ "mark": format!("page loaded={opened}"), "ms": hub().ms() }));
    eprintln!("[net] one page for {page_s} s");
    std::thread::sleep(Duration::from_secs(page_s));
    marks.push(json!({ "mark": "closing", "ms": hub().ms() }));
    close_and_quit();
    json!({ "marks": marks, "hub": hub().summary() })
}

// ------------------------------------------------------------------ question 6: one pane, for the start/stop driver

/// A pane process: opens WP_URL, prints FIRST_PAINT when the page first draws, then waits for "close" on stdin.
pub fn run_pane() -> Value {
    let url = std::env::var("WP_URL").unwrap_or_else(|_| format!("{}/anim.html", base()));
    let started = hub().ms();
    *hub().view.lock().unwrap() = (1280, 800);
    create_offscreen(&url, None, 60);
    let deadline = Instant::now() + Duration::from_secs(30);
    while hub().first_paint_ms.lock().unwrap().is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(2));
    }
    let first = *hub().first_paint_ms.lock().unwrap();
    println!("FIRST_PAINT {}", first.map(|f| format!("{f:.1}")).unwrap_or("none".into()));
    let mut line = String::new();
    let _ = std::io::stdin().read_line(&mut line);
    // The last pane closed: the browser goes, CEF stays up until told to quit, so the driver can see what an
    // in-process CEF holds with no browser.
    close_browser();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !hub().closed.load(Ordering::SeqCst) && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(20)); }
    println!("CLOSED");
    line.clear();
    let _ = std::io::stdin().read_line(&mut line);
    on_ui(|| quit_message_loop());
    json!({ "started_ms": started, "first_paint_ms": first, "paints": hub().paints.load(Ordering::Relaxed) + hub().accelerated_paints.load(Ordering::Relaxed) })
}

/// One page and one expression: opens WP_URL, waits WP_WAIT_MS, evaluates WP_EVAL (awaiting a promise), records it.
pub fn run_eval() -> Value {
    let url = std::env::var("WP_URL").unwrap_or_else(|_| format!("{}/idle.html", base()));
    if !open(&url, (800, 600), None) { return json!({ "error": "page did not load" }) }
    std::thread::sleep(Duration::from_millis(std::env::var("WP_WAIT_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(500)));
    let result = eval(&std::env::var("WP_EVAL").unwrap_or_else(|_| "document.title".into()));
    close_and_quit();
    json!({ "url": url, "result": result })
}

pub fn close_and_quit() {
    close_browser();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !hub().closed.load(Ordering::SeqCst) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    on_ui(|| quit_message_loop());
}
