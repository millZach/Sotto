# The web pane spike: Chromium as a component, on Linux

Researched November 18 to 19, 2026, on forge (Omarchy, Hyprland 0.56.2 on Wayland, RTX 4060 with NVIDIA 610.57.04), for issue #2690: stage 0, item 2 of `docs/plans/2026-11-14-rust-native-port.md`. The code is throwaway, in `web-pane-spike/` on `prototype/web-pane-chromium`, branched from `61f9e269b`. Its README says how to run each part. The evidence (summaries, records and captures, no packet dumps) is in `artifacts/web-pane-chromium/`.

The component is CEF 156.0.31 (Chromium 156.0.8078.100), the minimal Linux distribution, driven from Rust through the `cef` crate 156.7.0 (tauri-apps/cef-rs). Windows and Apple silicon macOS were not run; section 8 says what to run there.

Tags: **[m]** measured here, **[d]** documented (a header, a source file or a primary page), **[i]** inferred, **[e]** my judgement.

## What threatens the plan

1. **The component has to be a helper process, and the plan does not say so.** CEF starts once per process: a second `initialize` after `shutdown` crashed with SIGSEGV [m]. Closing the last browser and keeping CEF loaded still holds 212 MB in nine processes [m]. So "started when a pane shows and stopped when the last closes" means a separate process that Sotto starts and ends, with every frame and every input event crossing a process boundary. I built that on Linux and it works (section 4): frames cross as dmabuf descriptors over a Unix socket in about 1.1 ms each at 1280x800, input crosses back, and nothing is left 100 to 220 ms after the pane closes [m]. On Windows (a D3D11 shared NT handle) and macOS (an IOSurface sent as a Mach port) it is unbuilt. The plan should name this helper and its frame-and-input protocol as part of stage 4.
2. **H.264 and AAC do not play.** CEF's published builds answer `canPlayType` "no" for H.264, AAC and HEVC; VP9, AV1, Opus and MP3 play [m]. Electron's Chromium plays H.264 and AAC, so a dev server serving an `.mp4` would play in today's browser pane and not in this one [i]. Getting it back means building CEF from source with proprietary codecs, on all three systems, for every CEF update. Electron's builds carry the same codecs today, so the patent position would be the same as now. That is Zach's call: accept the loss, or own a CEF build.
3. **Out of the box, CEF talks to Google constantly.** In ten minutes with no page open it made 22 component-update checks, downloaded 146 MB of Chrome components (the Widevine DRM module, an on-device suggestion model and a text-to-speech engine among them), and fetched Safe Browsing lists, a spell-check dictionary and the time. It also made an "AI Mode" eligibility request that Chromium's own annotation says carries the user's google.com cookies [m][d]. Every one of these can be turned off and I proved each by capture (section 5). Nothing I saw needs an ADR. But the switches are feature names that change between Chromium versions (the AI Mode request is new), so each CEF update needs the capture rerun as a gate.
4. **On Wayland only the off-screen path works.** CEF's own child window cannot be placed inside a Wayland window: it ignored the parent and the rectangle and opened as a separate top-level window [m]. Off screen, Sotto draws the page itself and owns everything a native view would have done: input, IME composition, `<select>` pop-ups, cursors, drag and drop, file pickers and the accessibility tree. I proved pointer, wheel, typing and focus. The rest is unverified, and screen readers reading a web page are the one most likely to be expensive (section 4).

None of these says the plan cannot work. The first two change it: it needs a helper process, and a decision on codecs.

## The eight questions

| # | Question | Answer on Linux | What decides it |
| --- | --- | --- | --- |
| 1 | The command list | Yes | All 25 commands and 6 events `pageAutomation.ts` uses work through CEF's in-process DevTools channel. Two behave differently: a detach does not end emulation, and a hidden page holds input as Electron's does. |
| 2 | The seal | Yes, rebuilt and held | 81 escape attempts (65 from script, 16 in the markup). Nothing reached a canary, no DNS question left, the only connections were to the dead proxy. The page layer alone leaks WebRTC, preconnect and DNS, as ADR-0060 expected. |
| 3 | The test iPhone | Yes | 393x852, iOS Safari's user agent (page and request headers), a touch screen, and taps landing at (110,200) at page zoom 1 and 0.75. A pointer click is not turned into touch; the pane must send touch itself. |
| 4 | Embedding under Wayland | Yes, off screen; no as a child window | Shared texture (dmabuf into Vulkan) works on NVIDIA under Hyprland, also across processes. Rounded corners are a shader. 0.9 ms per frame at 1280x800. A child window only works under XWayland, with square corners. |
| 5 | Its own network calls | Yes, all off | Eight distinct callers. Each is tied by a one-out capture to the setting that stops it. With all settings, ten minutes and one page made no request and no packet. |
| 6 | Start and stop | Yes, as a helper process | First frame in the window 0.3 s warm, 1.8 s on the first start. About 250 MB headless, 315 to 376 MB with a GPU process. Nothing left after stop. In-process restart crashes. |
| 7 | Licence and binding | Open, one licensing question | cef-rs is Apache-2.0 or MIT; CEF is BSD-3-Clause; Chromium's notices ship as `CREDITS.html` (492 components). ffmpeg (LGPL) is linked into `libcef.so`, where Electron ships it as a separate library. 333 MB installed, 125 MB compressed. |
| 8 | Windows and macOS | Open | Section 8 lists what to expect and exactly what to run. |

---

## 1. The command list

`src/main/tools/pageAutomation.ts` sends 25 DevTools commands and listens for 6 events. `web-pane-spike/src/runs.rs` (`run_cdp`) sends each with the parameters `pageAutomation.ts` uses, against a local page, from a Rust host process. It goes through `CefBrowserHost::SendDevToolsMessage` and a `CefDevToolsMessageObserver`, which needs no port and no pipe, like Electron's `webContents.debugger` [d]. Record: `artifacts/web-pane-chromium/q1-cdp.json`.

**All 25 commands answered**, each in under 1 ms except input that waits for a frame (up to 19 ms) and screenshots (up to 47 ms) [m]:
`Network.enable`, `Runtime.enable`, `Runtime.evaluate` (with `returnByValue`, `awaitPromise` and `objectGroup`), `Runtime.releaseObjectGroup`, `DOM.enable`, `DOM.getDocument`, `DOM.describeNode` (by `objectId`, `backendNodeId` and `nodeId`), `DOM.getNodeForLocation`, `DOM.getBoxModel`, `DOM.getOuterHTML`, `Accessibility.getFullAXTree`, `Accessibility.getPartialAXTree`, `Overlay.enable`, `Overlay.setInspectMode`, `Overlay.hideHighlight`, `Page.getLayoutMetrics`, `Page.captureScreenshot` (PNG, JPEG at scale 0.5, a clip), `Emulation.setDeviceMetricsOverride`, `Emulation.clearDeviceMetricsOverride`, `Emulation.setTouchEmulationEnabled`, `Emulation.setEmitTouchEventsForMouse`, `Input.dispatchMouseEvent` (press, release, move, wheel), `Input.dispatchKeyEvent` (`keyDown` with text, `rawKeyDown`, `keyUp`), `Input.dispatchTouchEvent`, `Input.insertText`.

**All 6 events arrived:** `Network.responseReceived` (a 404), `Network.loadingFailed` (a refused connection), `Runtime.exceptionThrown`, `Runtime.consoleAPICalled` (`error`), `Overlay.nodeHighlightRequested` and `Overlay.inspectNodeRequested` [m].

**Behaviour checked, 34 of 37 checks passing.** The accessibility tree names the button, heading and text field. The hit test finds the button, and on a scrolled page with `pageY` added it finds a heading 900 px down. Off the page it errors with "No node found", the string `nodeAt()` matches. Clicks, keys and `insertText` (Unicode included) arrive as trusted events. Backspace edits. The wheel scrolls, and the settle expression returns in 33 ms. Point mode reports hover and click, keeps the click from the page and names the button. That holds both for protocol input and for CEF's own `SendMouse*Event`, which is how a native pane forwards the user's pointer [m]. The PNG is 1280x800; `cssVisualViewport` is 1265 wide on a tall page, because Linux draws a 15 px classic scrollbar, as Electron does there [m].

**What behaves differently.**

- **A detach does not end emulation.** `pageAutomation.ts` relies on Chromium dropping the viewport override with the attachment (`reset()`, and the comment on `viewport`). In CEF the session lives while the browser does. Dropping the observer's registration and attaching again found the 900-wide override still in force [m]. The Rust side has to clear emulation itself (`Emulation.clearDeviceMetricsOverride`, touch emulation off) where it used to detach. Pending commands are not rejected by a detach either, so the deadline in `send()` has to be the only way out.
- **A hidden page holds wheel and touch input**, as in Electron: with `WasHidden(true)` a wheel got no answer in 20 s [m]. A screenshot of the hidden page still answered, in 54 ms. `prepareCapture()` carries over directly: showing the page for the input (`WasHidden(false)`, then hidden again) made the same wheel answer in 2 ms [m].
- **Codecs** (the second threat above): `{"h264":"no","aac":"no","hevc":"no","vp9":"probably","av1":"probably","opus":"probably","mp3":"probably"}` [m].

**Not verified:** a host's headless Chromium over `--remote-debugging-pipe` (ADR-0198) was not part of this. That path drives the user's own Chrome, not the component.

## 2. The seal

ADR-0060's seal, rebuilt in CEF (`web-pane-spike/src/cefapp.rs`):

| ADR-0060 layer | In CEF |
| --- | --- |
| A session on an in-memory partition | A request context with no cache path (`RequestContextSettings` with an empty `cache_path`) |
| `sotto-visual://` registered as standard and nothing more | `OnRegisterCustomSchemes` with `CEF_SCHEME_OPTION_STANDARD` only; a scheme handler factory on that context alone |
| One load per address, 30 s, one-time token | The factory hands the page out once; a second load of the address is refused |
| The CSP, `X-DNS-Prefetch-Control`, `Permissions-Policy` and other headers | Set on the scheme's response |
| Every request but the page's one load cancelled | `CefResourceRequestHandler::OnBeforeResourceLoad` returns `RV_CANCEL` |
| A SOCKS5 proxy that closes every connection, `<-loopback>`, no bypass | The context's `proxy` preference, pointed at a loopback port the process holds |
| WebRTC `disable_non_proxied_udp` | The context's `webrtc.ip_handling_policy` preference |
| Permissions, devices, downloads, popups, navigation and dialogs refused | `CefPermissionHandler`, `CefDownloadHandler`, `OnBeforePopup`, `OnBeforeBrowse`, `CefJSDialogHandler` |
| `RTCPeerConnection` removed by the guest preload | `Page.addScriptToEvaluateOnNewDocument` (see below) |

The proxy and WebRTC preferences belong to the sealed context alone. The global context kept `default` [m], so the browser pane keeps ordinary WebRTC. One trap: `cef-rs` passes a default `CefString` as a null pointer, and CEF refuses a null error out-parameter. Every `set_preference` call failed silently, with no error, until I passed `CefString::from("")` [m]. The first runs of the seal ran without its network layers because of it.

**The attempt.** `web-pane-spike/server/hostile.html` tries 81 ways out (65 from its script, 16 in its markup) against a canary on the namespace's loopback (127.0.0.1) and one across its only link (10.99.0.1), plus names only a DNS logger would hear. It runs in a network namespace with no route off forge, with tcpdump on the link and on the loopback. The ways out: fetch, XHR, WebSocket, EventSource, beacon, image, WebTransport, and WebRTC STUN, TURN over UDP and TURN over TCP to each address and by name. Then preconnect, DNS prefetch, prefetch, preload, stylesheet, `@import`, CSS background, font, manifest, video, `<object>`, iframe, dedicated, data and shared workers, a service worker, fetch and WebRTC from an `about:blank` frame, a `srcdoc` frame, `window.open` (with and without a write), `target=_blank`, `<a ping>`, `<a download>` for data, http and blob, form posts in place and to a new window, a redirect, `mailto:`, top and self navigation, a meta refresh, a second load of its own address, and 22 permission requests: camera and microphone, geolocation, notifications, clipboard read and write, MIDI, persistent storage, local storage, IndexedDB, cookies, alert, fullscreen, screen capture, USB, serial, HID, Bluetooth, idle detection, wake lock, local fonts, window management and storage access, plus `execCommand('copy')`. The host's firewall dropped packets to the link-side canaries, so they logged nothing even when something arrived; the capture on the link is the evidence there [m].

**Each layer on its own** (`artifacts/web-pane-chromium/q2-seal-*.txt`):

| Layers | Reached a canary or left the namespace |
| --- | --- |
| None | Everything: 121 connection attempts to the link canary, and the page never finished loading |
| Page only: CSP, request filter, refusals | **WebRTC**: 25 STUN and TURN packets to the loopback canary, 24 UDP packets across the link and TURN over TCP to both. **Preconnect**: TCP connections to 10.99.0.1:8765. **DNS**: 8 questions for the STUN server's name. **mDNS**: 5 packets to 224.0.0.251. |
| Network only: dead proxy and WebRTC policy | Nothing. 48 connections held at the dead proxy. |
| No CSP: filter, proxy, WebRTC policy, refusals | Nothing. The filter cancelled 27 requests, the navigation guard 8, the dead proxy held 12. |
| **All** | **Nothing.** The dead proxy held 7 connections. The page's policy stopped everything else first. |
| All, plus `RTCPeerConnection` removed | Nothing |

The page layer is not a seal on its own, and the network layer is, which is ADR-0060's reasoning. What held in the full seal:

- **Network and storage.** Fetch, XHR, WebSocket, EventSource, image and redirect were refused by the policy. `sendBeacon` returned true, but the policy refused the request. WebTransport and service workers are absent from the page. Shared workers, storage and cookies are refused by the opaque origin.
- **Frames and windows.** Both frames could not reach their parent. Popups, `window.open` and form posts were blocked by the sandbox. Self navigation, `mailto:` and the second load were refused by the navigation guard, and the page was still there after its meta refresh time.
- **Downloads and permissions.** `<a download>` did nothing under the sandbox; with the CSP off, the download handler refused it. Every permission was refused, most because the scheme is not a secure context, so the API is not there at all. `alert` was ignored. `execCommand('copy')` returned false.

**Gaps I found.**

- With the network layers on, the namespace's link still carried 4 **IGMP membership reports** (to 224.0.0.22) per run. A socket in Chromium joined a multicast group, most likely WebRTC's mDNS. The reports name only the group; no mDNS query went out [m].
- **Removing `RTCPeerConnection`** through the protocol happens after the page's own script has started. In the run, one WebRTC attempt still found the constructor. Electron's guest preload runs before the page. The CEF equivalent is a render-process handler's `OnContextCreated`, which I did not build [i].
- **ADR-0060's bridge** (steps, theme, measured height, the user's own Escape) needs a render-process handler and process messages in place of the guest preload. Not built.

**Not verified:** a compromised renderer, side channels, a page that lies about its height, and every escape not on the list. The same limits as ADR-0060's own tests.

## 3. The test iPhone

`run_iphone` does what `src/main/tools/browser.ts` does for a phone page: the view at 393x852, the user agent, touch emulation on attach and scrollbars hidden. Record: `artifacts/web-pane-chromium/q3-iphone.json`, picture `q3-iphone-screenshot.png`.

| ADR-0045 | Electron | CEF | Result |
| --- | --- | --- | --- |
| 393 by 852 CSS pixels | `view.setBounds` | The off-screen view's rectangle | 393x852 [m] |
| iOS Safari's user agent | `webContents.setUserAgent` | `Emulation.setUserAgentOverride` (CEF has no per-browser setter) | `navigator.userAgent` and the request's `User-Agent` header both iOS Safari's [m] |
| A touch screen | The two touch emulation commands | The same commands | `maxTouchPoints` 5, `ontouchstart`, `(pointer: coarse)` [m] |
| A tap at (110,200) lands at (110,200) | `Input.dispatchTouchEvent` | The same | A trusted `touchstart` on the target at (110,200), then a click [m] |
| A swipe scrolls | Ten touch moves | The same | Scrolled [m] |
| Scaled by page zoom, not device emulation | `setZoomFactor` | `SetZoomLevel(log₁.₂ 0.75)` in a 295x639 view | Layout still 393 wide. A protocol tap at (110,200) still lands at (110,200). A 393x852 screenshot is still 393x852 [m]. |
| Scrollbars hidden | Injected CSS | `Emulation.setScrollbarsHidden` | Sent; not checked by eye |

11 of 12 checks pass. The one that fails is informational: a pointer click through CEF's mouse input reaches the page as a mouse event, not a touch, even with `setEmitTouchEventsForMouse` [m]. Electron converts the user's mouse on the phone because it arrives through the view's own input path. In CEF the pane has to send touch itself. CEF's `SendTouchEvent` from the pane did reach the page as a trusted touch, also at zoom 0.75: view (82,150) landed at CSS (109.3, 200) [m]. One run under heavy load failed four checks, because the swipe's fling was still moving the page when the next tap landed. The coordinates were right. The script now waits for the fling to stop.

## 4. Embedding under Wayland

Both paths ran in my own nested Hyprland (the repository's `scripts/with-nested-hyprland.mjs`), driven by a virtual pointer that refuses the live display (`web-pane-spike/tools/vpointer.c`) and by `wtype`. The window is plain winit 0.30 and wgpu 30 on Vulkan. A shader draws a sidebar and a strip as stand-ins for native chrome, the page inside a rectangle with 14 px anti-aliased rounded corners, and a focus ring when the page has the keyboard (`q4-accelerated-typed.png`). The nested display's size followed the live session's tiling (894x448 at first, 419x196 later). `WP_VIEW` fixed the page at 1280x800 or 2560x1600 to measure a real pane's cost.

**Off screen, shared texture: works.** CEF hands each frame to `OnAcceleratedPaint` as a single-plane BGRA dmabuf with NVIDIA's block-linear modifier (`0x300000000606014`). cef-rs's importer copies it into a wgpu texture through Vulkan external memory and waits for the copy, so CEF can reuse the buffer [m][d]. The GPU process logged "`--ozone-platform=wayland` is not compatible with Vulkan" and worked anyway [m].

**Off screen, software (`OnPaint`): also works**, at more CPU.

| Page size, path | Frames/s (animated page) | Cost per frame in Sotto's process, p50 / p95 | Whole tree CPU |
| --- | --- | --- | --- |
| 634x372, shared texture | 58 | 0.93 / 1.55 ms | 23–25% of one core |
| 634x372, software | 59.6 | 0.39 / 0.71 ms | 23% |
| 1280x800, shared texture | 59.6 | 0.88 / 4.70 ms | 23% |
| 1280x800, software | 59.1 | 1.46 / 2.87 ms | 28% |
| 2560x1600, shared texture | 59.5 | 2.87 / 3.85 ms | 21% |
| 2560x1600, software | 59.6 | 2.09 / 5.73 ms | 40% |

The shared-texture cost is mostly waiting for the GPU copy; a design that held the buffer for the frame would not need the copy [i]. Records: `q4-embed-*.json`.

**Across processes: works.** This is the shape question 6 forces. With `WP_REMOTE=1` the window process never starts CEF. It starts `webpane` as a helper with one end of a `SOCK_SEQPACKET` pair. The helper sends each frame's dmabuf descriptor (`SCM_RIGHTS`) and a 64-byte record, and waits for an acknowledgement before handing the buffer back to CEF. The window imports the frame with the same cef-rs importer, from an `AcceleratedPaintInfo` it fills in itself. Input goes the other way as 64-byte records (`src/wire.rs`, `src/remote.rs`).

- At 1280x800, the helper's send-to-acknowledgement round trip was 1.13 ms p50 and 3.2 ms p95 over 900 frames [m].
- A click and "across the socket", typed with `wtype` into the nested compositor, reached the page as trusted events, one keydown and one input event per character [m].

Records: `q4-remote-1280.json`, `q4-remote-cycles.json`.

**Input and focus.** The pane forwards what winit gives it, offset by the rectangle's origin: pointer moves, enter and leave, clicks, the wheel, and keys as raw keydown plus char plus keyup. A click inside the page gives it focus (`SetFocus(true)`). A click on native chrome takes focus back, and keys typed then stay with the native UI, the page sees `blur`, and the ring goes [m]. Typed text, clicks and the wheel all arrived as trusted events [m]. Not built or verified:

- IME composition (`ImeSetComposition`), so Japanese and Chinese input in a page
- `<select>` pop-ups, which CEF paints as a separate `PET_POPUP` layer the pane must place
- cursor changes, drag and drop, context menus and file pickers
- device scale factors other than 1
- the page's accessibility tree: off screen, CEF hands it to an `AccessibilityHandler` for the app to bridge into AccessKit or the platform's tree. In Electron a screen reader reads the page directly. The bake-off's must-pass row for Orca, Narrator and VoiceOver has to include a web pane for this reason [i].

**Child window: no on Wayland.** CEF's windowed mode takes an X11 window as its parent on Linux. Under native Wayland, winit's window has no X11 id. CEF opened its own top-level window, which the compositor tiled beside Sotto's, outside the rectangle (`q4-child-window-wayland.png`) [m]. Under XWayland (the nested compositor's own `:1`), the child sat inside the winit window at the rectangle (`q4-child-window-xwayland.png`) [m]. That costs the whole app running as an X11 client. The corners stay square: X11's shape extension cuts a 1-bit mask, with no anti-aliasing. Native drawing cannot overlap the page, so a menu over the pane would need its own window. The child also does not follow the parent's layout; the app moves it [i]. The off-screen path is the one to build.

## 5. Its own network calls

CEF ran in its own network namespace with real connectivity through `pasta`, whose capture holds only that namespace's traffic. The test page was served on the namespace's own loopback. CEF's NetLog (`--log-net-log`) named every request. Each run was ten minutes, five or seven with no page and the rest with one local page, on a persistent profile like an install's. Summaries: `q5-*.txt`; what the baseline downloaded: `q5-baseline-components.txt`.

**Baseline, CEF's defaults.** No new caller appeared in the one-page phase, and no metrics upload, variations fetch or crash upload happened in either phase. No crash handler process ran: CEF starts crash reporting only when a `crash_reporter.cfg` is present [m][d].

| Caller | What it sent | When | Chromium's annotation |
| --- | --- | --- | --- |
| Component updater | 22 POSTs to `update.googleapis.com/service/update2/json`, some over plain HTTP | From the first second | `update_client` |
| Component downloads | About 20 GETs from `edgedl.me.gvt1.com`, 146 MB unpacked. Widevine CDM, OnDeviceHeadSuggest model, WASM TTS engine, CRLSet, PKI metadata, Safe Browsing's file-type policies, Privacy Sandbox attestations, Trust Token keys, optimization hints and model manifest, Crowd Deny, Safety Tips, hyphenation data, captcha providers, MEI preload, actor safety lists | From 180 s | `update_client` |
| Safe Browsing | `safebrowsing.googleapis.com/v4/threatListUpdates:fetch` | 197 s | |
| Spell check | `redirector.gvt1.com/edgedl/chrome/dict/en-us-10-2.bdic`, redirected to a `gvt1.com` mirror | First second | |
| Network time | `clients2.google.com/time/1/current` | First second | |
| AI Mode eligibility | `www.google.com/async/folae` | First second | `aim_eligibility_fetch`, `components/omnibox/browser/aim_eligibility_service.cc`: cookies allowed, the user's store, on startup and periodically, "Not gated by policy" [d] |

I matched the AI Mode request to its source with the traffic annotation hash in the NetLog (109231476), computed from annotation ids in Chromium 156's `annotations.xml` [m][d]. In Sotto's browser, where the user signs in to Google, that request would carry their Google cookies [i].

**Hardened.** The switches in `web-pane-spike/config/hardened-switches.txt` and a seeded profile, `config/hardened-prefs.json`. In ten minutes (seven with no page, three with one): **no request in the NetLog except the local page and two attempts at `http://127.0.0.1:9/`, and no IP packet from CEF in the capture.** The 39 packets there were the kernel's IPv6 neighbour discovery [m].

**Which setting stops which call.** One-out runs, 240 s each, no page:

| Caller | Stopped by | Not stopped by |
| --- | --- | --- |
| Component updater and downloads | `--component-updater=url-source=http://127.0.0.1:9/` alone | `--disable-component-update`: with only that, CEF still made 3 checks and downloaded the model manifest. With neither, 21 checks and the full set of downloads. |
| Safe Browsing | `--disable-background-networking` | The seeded `safebrowsing.enabled: false` |
| Network time | `--disable-features=NetworkTimeServiceQuerying` | `--disable-background-networking` |
| AI Mode eligibility | `--disable-features=AimEnabled,AimServerEligibilityEnabled,AimServerRequestOnStartupEnabled` | Everything else |
| Spell-check dictionary | Either the seeded `browser.enable_spellchecking: false` or `--disable-background-networking`; each alone sufficed | |
| Optimization guide features | Made no difference within 240 s once the component updater was redirected | |

The rest of the list (`disable-domain-reliability`, `disable-client-side-phishing-detection`, `safebrowsing-disable-auto-update`, `disable-sync`, `no-pings`, `metrics-recording-only`, `disable-breakpad`, MediaRouter and DIAL off, Translate off, autofill server off) stopped nothing I could see in these windows. They are cheap insurance. I did not test them one by one.

**Nothing found that cannot be turned off**, so nothing here needs an ADR or a README change yet. Three cautions:

- The redirected updater still makes a plain-HTTP POST to loopback port 9 twice per run. If something listens there, it would receive Chromium's version, the component list and an install ID. Point it at an address that cannot connect, or check that port 0 refuses.
- Turning off the updater freezes CRLSet and the PKI metadata at what shipped. That is fresher than Electron's (which has no component updater) only if Sotto ships them.
- Feature names drift. A capture like `scripts/net.sh` belongs in each CEF update, failing on any non-loopback packet.

**Not verified:**

- Timers longer than ten minutes (the component updater's default is hours).
- What a signed-in Google profile adds.
- HTTPS pages: certificate fetching (AIA, OCSP) happens only when a site's chain needs it.
- DNS over HTTPS. Chromium upgrades only when the system resolver is a known DoH provider; pasta's forwarder is not one, and Sotto's users' resolvers may be.
- Windows and macOS: section 8.

## 6. Start and stop

**One process cannot do it.** Two in-process facts:

- **A second start crashes.** After `shutdown()`, a second `initialize()` in the same process crashed with SIGSEGV [m]. CEF's documentation allows one initialize per process [d].
- **A loaded CEF holds memory with no browser.** With the last browser closed and CEF still loaded, the tree held 212 MB in nine processes. With one page it held 250 MB [m].

So the component is a helper process.

**Headless, without a GPU process** (`scripts/lifecycle.py`, `q6-lifecycle-headless.json`). Eight starts, alternating cold (CEF's files evicted from the page cache first) and warm:

- **First paint:** 671 ms on the first cold start, about 440 ms on later cold ones, 375 to 478 ms warm. That is from spawning the process to the page's first painted frame.
- **Memory:** 250 MB PSS for one animated page in 10 processes.
- **Stop:** 113 to 214 ms from the stop request to exit.
- **After exit:** no process from the install left.

**In the window, with a GPU process, as a helper** (`q4-remote-cycles.json`). Five cycles of: show the pane, hold 3 s, close it.

- **First frame in Sotto's window:** 1.8 s, then 0.7 s, then 0.29 to 0.32 s. The first start builds the GPU's shader caches in the profile.
- **Helper memory:** 315 to 376 MB PSS in 10 processes.
- **Stop:** 97 to 218 ms.
- **After stop:** no helper process left.
- **The window process:** 121 MB before the first pane and 131 MB after the last. That is wgpu and the NVIDIA Vulkan driver, and CEF's library mapped but never started.

In process, with a GPU, one 1280x800 page showed 487 MB across the tree: the app's own process 181 MB with wgpu, GPU about 136 MB, renderer 67 MB, network service 29 MB (`q4-embed-pss.json`).

**Size on disk** [m]:

- **Download:** the minimal archive is 333 MB (`.tar.bz2`).
- **`libcef.so`:** ships at 1.48 GB with its symbols, and strips to 278 MB.
- **Installed:** 333 MB for the stripped library, ICU data, the V8 snapshot, the `.pak` resources, SwiftShader and Vulkan loader, `chrome-sandbox` and one locale.
- **Locales:** all 220 add 51 MB. Sotto has 32 locales; CEF's names include gendered variants.
- **Compressed:** 125 MB with zstd at level 12.

I did not compare this with today's Electron install on Linux.

## 7. Licence and binding

**The binding.** `cef` 156.7.0, with `cef-dll-sys` and `download-cef`, from tauri-apps/cef-rs: Apache-2.0 or MIT [d]. Its bindings are generated; the Linux file alone is 59,740 lines. It tracks CEF releases: `156.7.0+156.0.31` is the seventh binding release for CEF 156. It ships the shared-texture importers for all three systems (dmabuf into Vulkan, D3D11 into D3D12 or Vulkan, IOSurface into Metal) and macOS bundling tools [d]. Three things to know [m]:

- the null `CefString` trap in section 2
- `browser_host_create_browser_sync` returns nothing off CEF's UI thread, so with CEF's own message-loop thread the async call is the one to use
- CEF objects are not `Send`, so code on another thread wraps them in `unsafe impl Send`

The alternatives I found build on it (`welding`, `bevy_cef`). `chromiumoxide` only drives an external Chrome over the protocol. That is ADR-0198's route, not an embedded pane.

**The Chromium build.** CEF's own builds from the Spotify CDN (`cef-builds.spotifycdn.com`), Chromium-branded. CEF's licence is BSD-3-Clause [d]. The distribution carries `CREDITS.html`, generated by Chromium's `licenses.py`: 492 components. It contains 940 Apache, 56 MPL, 21 LGPL and 5 GPL licence texts [m]. It takes the place of `LICENSES.chromium.html` in `THIRD_PARTY_NOTICES.md`'s second paragraph, beside the binary on every system. The one licensing question I could not settle: ffmpeg is LGPL. Electron ships it as a separate `libffmpeg` that a user can replace. CEF's Linux build links it into `libcef.so` (the library's strings include 55 `avcodec_` symbols) [m]. Whether the LGPL's relinking terms are met by the complete corresponding source being public is a question for whoever signs off the notices, not for me.

**ADR-0018's rule.** CEF is one binary component plus one crate family. Under the plan's `cargo deny` allow-list they are three crates (`cef`, `cef-dll-sys`, `download-cef`) and one fetched binary, which needs an ADR line of its own like `node-pty`'s [i].

**Fetching, pinning, checksums.** `cef-dll-sys`'s build script downloads the archive named by the CDN's own index and checks its SHA-1 against that same index [d]. That proves the download is intact, not that it is the file Sotto chose. For a release, pin the archive's SHA-256 in the repository, refuse anything else, and keep a copy where releases are built. Point `CEF_PATH` at the checked folder so the build script finds it and downloads nothing. The CDN is a build-time host, not one the app contacts, so the README's privacy list does not change [i]. For this spike:

- archive `cef_binary_156.0.31+ge603d97+chromium-156.0.8078.100_linux64_minimal.tar.bz2`: SHA-256 `a6c3452c47f344f9f125c71dfc9d8965149bac7c8df1e23ffd80442a28ce1b62`
- `libcef.so`: SHA-256 `0b45a0795ce2f036def5e4e481a60a8c1826827fa06beb501ff991382fd4f444`

## 8. Windows and Apple silicon macOS

Nothing here was run on either system. The code compiles on Linux. Windows and macOS paths are behind `cfg` and have never been compiled. `web-pane-spike/README.md` says how to build and run it on Windows.

| Question | Windows: what I expect | macOS: what I expect | What closes it |
| --- | --- | --- | --- |
| 1. Commands | The same: it is the same Chromium and protocol | The same | `WP_MODE=cdp` and `WP_MODE=iphone` on each, then `scripts/summarize.py` on the record. 34 of 37 and 11 of 12 checks, the same three and one informational misses. |
| 2. Seal | The same layers. Windows adds no WebRTC route that the policy misses, as far as I know [e]. | The same | `WP_MODE=seal` with `server/hostile.html` served on a second machine's address, and the Windows firewall or macOS `pf` blocking everything but that canary and loopback. Record drops, and check the canary hears nothing. |
| 3. iPhone | The same | The same | `WP_MODE=iphone` |
| 4. Embedding | A shared D3D11 texture (NT handle) into D3D12, which cef-rs already imports. A child HWND would work, with square corners and native UI unable to draw over the page; Electron's views avoid that by compositing. | An IOSurface into Metal (cef-rs). A child NSView could have rounded corners through its layer, but the helper-process shape rules child views out on every system: a view cannot live in another process. | `WP_MODE=embed WP_PATH=accelerated` and `software` at 1280x800 and 2560x1600. Then the helper link, unbuilt there: `DuplicateHandle` of the NT handle over a named pipe on Windows, `IOSurfaceCreateMachPort` over XPC or a Mach port on macOS. |
| 5. Network | The same callers, plus Windows-only ones I could not see. I would expect none for CEF with crash reporting off [e]. | The same, plus keychain prompts unless `use-mock-keychain` is set | NetLog with the hardened switches for 10 minutes, and a packet capture with nothing else running (`pktmon` on Windows, `tcpdump` on a spare Mac). |
| 6. Start and stop | Slower first start under Defender's scan [e] | The helper must be four helper app bundles, each signed and notarized, as Electron's are today [d] | `scripts/lifecycle.py`'s steps, by hand or ported |
| 7. Size and licence | `libcef.dll` and its resources; not measured | `Chromium Embedded Framework.framework`; not measured | Download each minimal distribution, strip where needed, measure, and record SHA-256s |

## Could not verify

- Anything on Windows and macOS (section 8), and on Linux with AMD or Intel graphics (Mesa), X11 sessions or other compositors.
- IME, `<select>` pop-ups, cursors, drag and drop, file pickers, device scale factors other than 1, and the page's accessibility tree in the off-screen pane (section 4).
- ADR-0060's bridge in CEF, and removing `RTCPeerConnection` before page script runs (section 2).
- The component's network behaviour beyond ten minutes, with a signed-in profile, or on HTTPS pages (section 5).
- The LGPL question for ffmpeg linked into `libcef.so` (section 7).
- How the off-screen pane's memory and frame cost compare with today's Electron `WebContentsView`; I did not measure Electron.
