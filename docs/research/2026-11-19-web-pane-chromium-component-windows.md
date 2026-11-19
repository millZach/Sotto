# The web pane spike: Chromium as a component, on Windows

Researched November 19, 2026, on the Windows 11 laptop (Windows 11 Home 26200, Intel Graphics driving a 2560x1600 panel at 150%, with an RTX 5070 Laptop GPU beside it, 32 GB), for issue #2690: stage 0, item 2 of `docs/plans/2026-11-14-rust-native-port.md`. It closes the Windows column of section 8 in [the Linux note](2026-11-19-web-pane-chromium-component.md), which comes first and which this note does not repeat. Same code (`web-pane-spike/` on `prototype/web-pane-chromium`), same CEF 156.0.31 through the `cef` crate 156.7.0, built with MSVC 14.50 for `x86_64-pc-windows-msvc`. Evidence: `artifacts/web-pane-chromium/windows/`. Every run was from an ordinary shell; nothing was elevated.

Tags as in the first note: **[m]** measured here, **[d]** documented, **[i]** inferred, **[e]** my judgement.

## What threatens the plan

1. **Off screen, a screen reader sees nothing of the page.** UI Automation, which Narrator reads, found one element in the off-screen pane's window: the window itself [m]. CEF's own child window, in the same window, gave Narrator the whole page: document, heading, link, the "Press me" button, the text field [m]. CEF says why: off screen it computes the tree but "platform accessibility objects are not created", and the app may build them from `CefAccessibilityHandler` [d]. The tree does arrive (Chromium's `AXTreeUpdate` as CEF values: ids, roles, names, bounds, child ids, about 13 KB for a small page) [m]. Two gaps showed: each node's state list arrives as one state name and empty strings, and CEF has no call for a screen reader to act on a node (press, focus, set a value) [m][d]. So the off-screen path on Windows means building a bridge from that feed into AccessKit (or straight into UI Automation), with actions sent through the DevTools protocol's `Accessibility` and `DOM` domains, which do carry DOM node ids [i]. That is real work in stage 4, not a polish item, and the bake-off's screen-reader row has to include a web pane.
2. **On a laptop with two GPUs, a wrong guess is a blank pane.** wgpu took the Intel GPU by default, and so did CEF's GPU process: frames flowed [m]. Asking wgpu for the NVIDIA GPU while CEF stayed on Intel made every frame fail to open (`OpenSharedHandle`: `E_INVALIDARG`), and the pane stayed blank with no other sign [m]. `--force_high_performance_gpu` moved CEF to the same NVIDIA GPU and frames flowed again (2.8 ms per frame p50) [m]. Sotto has to choose CEF's adapter from the one its own window uses (Chromium's `--use-adapter-luid` is the precise form [i]), and fall back to software frames when an open fails.
3. **CEF reads other programs' Chrome extensions from the Windows registry.** With CEF's defaults, the profile took two extensions that other programs on this laptop had registered for Google Chrome, downloaded both from the Chrome Web Store, and installed them (disabled until a user approves them, so they did not run) [m]. Both ask for scripts on every site. With the first note's hardened switches and preferences nothing was fetched or installed [m]; which single switch stops it is not settled. This is Windows-only and must be turned off on purpose in the shipped settings and checked in the capture gate.

Neither of the first note's two changes to the plan moves: the component is still a helper process, and the codec question is the same on Windows (question 8).

## The questions

| # | Question | Answer on Windows | What decides it |
| --- | --- | --- | --- |
| 1 | Builds and runs | Yes | A handful of fixes: four type errors in Windows-only code and two Windows bugs in the spike (section 1). The command list passes 34 of 37 and the iPhone 11 of 12, the same misses as Linux. |
| 2 | Embedding | Yes, off screen | Shared texture (D3D11 NT handle into wgpu DX12) at 1.5 ms p50 per frame at 1280x800 and 2.6 ms at 2560x1600, 59 fps; rounded corners and native drawing over the page both work. Two GPUs must agree. |
| 3 | The helper process | Yes, both ways | Off screen across processes: the handle is duplicated into the window in 3 µs; the round trip to acknowledgement is 2.3 ms p50, 5.7 ms p95; typing reaches the page; nothing is left after stop. CEF's child window parented across processes also works, after two fixes, with square corners and no native drawing over it. |
| 4 | What off screen leaves Sotto to build | Everything has a callback; accessibility is the big one | `<select>`, cursors, drag out and in, file picker, IME composition, context menu and a scale of 1.5 all worked through CEF's callbacks, 11 of 11. Narrator sees nothing until Sotto builds the bridge. |
| 5 | Start, stop, size | Yes | First paint 0.75 to 0.85 s warm, 1.5 to 1.9 s when Defender meets new files. 184 to 194 MB private working set for one page; 165 MB with CEF up and no page. 356 MB installed, 147 MB compressed. |
| 6 | Its own network calls | Yes with the hardened settings, plus one Windows caller | Ten minutes, no page: no request outside loopback. Windows' proxy auto-detection (WPAD) asked the local network six times; `--no-proxy-server` stops it. Packet capture needs an elevated shell. |
| 7 | The seal | Held, partly proven | All layers: nothing reached a canary on this laptop or on forge, and the NetLog shows no request outside loopback. No firewall and no capture without elevation. |
| 8 | Codecs | Same as Linux | H.264 and AAC "no", and a real H.264/AAC file fails to play; Windows' own decoders are not used. VP9 and Opus play. |

---

## 1. Builds and runs

**Toolchain.** Rust 1.99.1 (MSVC) was here. CMake 4.2.3 and Ninja 1.12.1 came from the Visual Studio 18 Build Tools already installed, put on `PATH` for the build only by `vcvars64.bat` and a wrapper script outside the worktree. Nothing was installed. `cef-dll-sys` downloaded the Windows minimal archive into `CEF_PATH` and built the wrapper library [m].

**What the Linux-only code needed** [m]:

- `AcceleratedPaintInfo` on Windows has `shared_texture_handle`, not planes and a modifier; and CEF's window handle is an `HWND` newtype, not an integer. Four compile errors, behind `cfg`.
- **A child window needs a style.** CEF's `WindowInfo` on Windows has a `style` field that defaults to 0. With it 0, CEF made a hidden top-level window owned by the parent, not a child. `WindowInfo::set_as_child` sets `WS_CHILD | WS_VISIBLE | ...` [m][d].
- **Closing a windowed browser closes Sotto's window.** When `DoClose` returns false, CEF sends `WM_CLOSE` to the browser's top-level window [d]. With the child parented into another process, that window is Sotto's own, and it closed [m]. The helper now returns true and destroys only CEF's child window.

**The command list** (`q1-cdp.json`): 34 of 37 checks and all 25 commands, the same three misses as Linux (a detach does not end emulation, a hidden page holds wheel input, codecs) [m]. Windows also draws a 15 px classic scrollbar, so `cssVisualViewport` is 1265 wide, as on Linux [m].

**The test iPhone** (`q3-iphone.json`): 11 of 12, the same informational miss: a pointer click through CEF's mouse input reaches the page as a mouse event, so the pane sends touch itself [m].

**Not run:** the CEF sandbox. Every run set `WP_NO_SANDBOX`. On Windows the sandbox needs CEF's `bootstrap.exe` model and the crate's `sandbox` feature wired to it; open.

## 2. Embedding

`embed` on Windows: winit 0.30 and wgpu 30 on DX12, the page imported with cef-rs's D3D11 importer (`OpenSharedHandle` on the D3D12 device, then a copy into a texture the window owns). Records `q4-embed-*.json`, with the process tree's memory and CPU over 10 s in `q4-embed-*-tree.json`. `WP_SCALE=1` fixed the page's scale to compare with Linux; the native run used the display's 1.5.

| Page (pixels), path | Frames/s (animated page) | Cost per frame in the window process, p50 / p95 | Whole tree CPU | Tree private working set |
| --- | --- | --- | --- | --- |
| 1280x800, shared texture | 58.9 | 1.53 / 2.20 ms | 36% of one core | 460 MB |
| 1280x800, software | 59.3 | 1.99 / 2.76 ms | 59% | 477 MB |
| 2560x1600, shared texture | 59.0 | 2.60 / 6.61 ms | 43% | 494 MB |
| 2560x1600, software | 59.2 | 7.67 / 10.05 ms | 163% | 533 MB |
| 1530x1086 (scale 1.5), shared texture, with input | 57.4 | 1.81 / 2.89 ms | | |
| 1280x800, shared texture, both on NVIDIA | 58.8 | 2.80 / 4.20 ms | 44% | 245 MB (602 MB commit) |
| 1280x800, wgpu on NVIDIA, CEF on Intel | 0 | every open fails, `E_INVALIDARG` | | |

[m] all rows. The cost is mostly the wait for the copy, as on Linux. Software frames cost more CPU and, at 2560x1600, take most of a 16 ms frame [m].

**The page draws, with rounded corners.** The shader's 14 px anti-aliased corners and the focus ring work as on Linux, and the stand-in for a native menu draws over the page (`q4-offscreen-menu-over-page.png`, `q4-helper-typed.png`) [m].

**Input.** Clicks, keys and the window's focus reached the page as trusted events at scale 1.5, with one keydown and one input per character, and keys stayed with the native UI after a click on the sidebar (`q4-embed-acc-native.json`) [m]. They were driven by messages posted to the window, not by the real keyboard (section 9).

**Which GPU.** Chromium and wgpu each take the adapter Windows lists first unless told otherwise. On this laptop both took Intel. Every module list showed it: wgpu loaded `igd12umd64.dll`, the GPU process `igd10iumd64.dll` [m]. Item 2 above has what happens when they differ.

## 3. The helper process

Built for Windows in `web-pane-spike/src/remote_win.rs`. The window starts `webpane` as a helper and makes two named pipes first, one each way, because synchronous reads and writes on one pipe handle wait for each other. Both pipes refuse remote clients and a second instance of the name. The window never starts CEF.

**Off screen, frames across the boundary** (`WP_REMOTE=1`). The helper sends each frame's NT handle *value* and a 64-byte record. The window holds the helper's process handle from starting it, so it duplicates the handle into itself (`DuplicateHandle`), opens it on its own D3D12 device, copies it, closes its duplicate and acknowledges. Then the helper hands the texture back to CEF. Input goes the other way as Linux's 64-byte records. Records `q4-helper-*.json`.

- At 1280x800: `DuplicateHandle` 3 µs p50, 6 µs p95; the helper's send-to-acknowledgement round trip 2.27 ms p50, 5.65 ms p95, max 16 ms over 1,504 frames, at 58 fps while shown [m]. About twice Linux's 1.13 ms, and still well inside a frame.
- A posted click and "hello pane" reached the page in the helper as trusted events, one keydown and one input per character, and a click on the sidebar took focus back (`q4-helper-1280-helper-side.json`) [m].
- Five cycles of show, hold 3 s, close (`q4-helper-cycles.json`): first frame in the window 777 to 834 ms after the helper starts; the helper 160 to 165 MB private working set in 7 processes (221 to 224 MB commit); stop 0.68 to 0.99 s; no helper process alive 2 s after any stop [m].
- The window process held 278 MB private working set before the first pane and 280 MB after the last. That is wgpu on the Intel driver, with `libcef.dll` mapped and never started [m]. Linux's window process was 121 MB [m]. The budget for the window process belongs to the toolkit choice in stage 1, not here [e].

**CEF's child window, parented across processes** (`WP_REMOTE=child`, `scripts/childx.ps1`). The note says a child view cannot live in another process. On Windows it can: the helper created CEF's windowed browser with Sotto's `HWND` as parent, and Windows put `CefBrowserWindow`, `Chrome_WidgetWin_1` and `Chrome_RenderWidgetHostHWND`, all owned by the helper's process, inside Sotto's window at the rectangle (`q4-child-window-hwnds.txt`, `q4-child-window-cross-process.png`) [m].

- **Loaded and drew:** the page loaded 1.32 s after the helper started; typing posted to the child reached it as trusted events (`q4-child-window-helper-side.json`); the helper held 143 MB private working set in 6 processes and stopped in 0.63 s with nothing left [m].
- **It needed `--disable-direct-composition` on this laptop.** With Chromium's default DirectComposition output, the GPU process crashed three times (`0x80000003`, a release-build check) and the child drew only white, in one process as well as across two [m]. With the switch it drew. I did not find the check that fails [e].
- **What it costs.** Square corners: the child is a rectangle the window cannot clip with anti-aliasing [m]. Native drawing cannot go over it: the menu stand-in is cut off where the child starts (`q4-child-window-cross-process.png`, against `q4-offscreen-menu-over-page.png`) [m]. The window must move and size it itself, and must keep it from closing the window (section 1) [m].
- **A stuck helper.** Windows joins the input queues of a parent and a child window from different threads, so a hung helper could stall Sotto's own window [d]. The helper blocked its UI thread for 6 s while a click was posted to Sotto's sidebar; Sotto's window answered every 100 ms poll within 8 ms and was never called hung (`q4-child-window-helper-hang-respond.txt`) [m]. Posted clicks do not take the real activation and focus path, so this does not clear the risk; it needs a real click (section 9).
- **Screen readers:** this path gives Narrator the whole page (section 4).

So on Windows the child window trades the shape (corners, overlap) for accessibility. It cannot be the shared path: Wayland has no child window for it (first note, section 4) [m].

## 4. What off-screen drawing leaves Sotto to build

`WP_MODE=osr` (`web-pane-spike/src/osr.rs`, page `server/pages/osr.html`) drives each one through CEF's off-screen interface at a scale of 1.5. Record `q4-offscreen-probes.json`: 11 of 11 [m].

| Feature | Does CEF hand Sotto a callback? | What happened | What Sotto builds |
| --- | --- | --- | --- |
| Scale other than 1 | `GetScreenInfo` | `devicePixelRatio` 1.5; an 800x600 view paints 1200x900 [m] | Send the window's scale and its changes (`NotifyScreenInfoChanged`) |
| Cursors | `OnCursorChange` | A hand over the link, an I-beam over the field [m] | Map CEF's cursor types to the window's cursors |
| `<select>` | `OnPopupShow`, `OnPopupSize`, `OnPaint(PET_POPUP)` | The list showed at (20,40) 200x82 and painted as its own layer; Down then Enter chose "Banana" [m] | Draw the pop-up layer over the page at that rectangle, clip and hit-test it |
| Drag out of the page | `StartDragging` with the data | Called with the page's text at the pointer [m] | Start an OS drag (`DoDragDrop`) and report its end (`DragSourceEndedAt`) |
| Drop into the page | `DragTargetDragEnter`, `...Over`, `...Drop` | Text dropped through them reached the page's `drop` handler [m] | An OLE drop target on the window that forwards to these |
| File picker | `CefDialogHandler::OnFileDialog` | Called with the mode; the file the handler chose reached the page [m] | Show the OS picker (`IFileOpenDialog`) and answer |
| IME | `ImeSetComposition`, `ImeCommitText`, `OnImeCompositionRangeChanged` | `compositionstart`, updates with "にほん", then `compositionend` and "日本" in the field; CEF reported each character's box for the candidate window [m] | Turn winit's `Ime` events (or `WM_IME_*`) into these calls and place the candidate window from the boxes [i] |
| Context menu | `RunContextMenu` with CEF's model | Called with 5 items at the right-click point [m] | Draw Sotto's own menu, or none |
| Accessibility | `CefAccessibilityHandler` | The tree and its updates arrived; the button's new name came through as an update [m] | The bridge in item 1 above |

Each row tests CEF's half: the spike called the methods the window would call. The OS half (the IME itself, the Windows drag loop, the picker) was not driven. Each of those is a known Win32 interface, and cefclient's `osr_*_win.cc` files show the shape [d]. **Rough sizes** [e]: cursors, scale and the context menu are hours each; `<select>` and file pickers a day each; drag and drop two to three days (OLE in both directions); IME two to three days to get right with real input methods.

**Accessibility, measured.** `scripts/uia.ps1` opened the command test page and walked the window's UI Automation tree as Narrator does:

- Off screen (`q4-uia-offscreen.txt`): **1 element**, `Window 'Sotto web pane spike'`. Nothing of the page [m].
- CEF's child window (`q4-uia-child-window.txt`): 12 elements: `Document 'CDP test page'`, `Text 'Page automation test'`, `Group 'Main'`, `Hyperlink 'Link one'`, `Button 'Press me'`, `Edit 'Type here'`, `Text 'Deep heading'` under CEF's panes [m].
- Off screen with `SetAccessibilityState(STATE_ENABLED)`, the handler gets Chromium's tree as values (`q4-offscreen-ax-sample.json`): 28 nodes for the probe page, with role names (`button`, `comboBoxSelect`, `textField`, `link`, `menuListOption` ...), `name`, `value`, `htmlTag`, `location` and `child_ids`, then updates as the page changes [m]. Each node's `state` arrived as one name and empty strings (`["focusable","","",...]`) [m], so states such as expanded, checked or disabled would be lost. Nothing in CEF's API carries an action back [d].
- AccessKit's tree model is close to Chromium's (ids, roles, bounds, children). A bridge is a translation, plus the states from somewhere else, plus actions through the DevTools protocol, plus a Windows adapter for UI Automation. AccessKit has one [i]. That is roughly one to two weeks per platform to make Narrator, VoiceOver and Orca read a web page as well as they do in Electron today [e]. I did not build it: it is well over the hour this spike allowed.

## 5. Start, stop, size

**Start and stop** (`scripts/lifecycle.ps1`, `q6-lifecycle-*.json`). Each set copies the install to a new folder first, so its first start meets files Defender has never scanned, as an install's first run does. Real-time protection was on [m]. Without elevation the file cache cannot be emptied, so "cold" here means new files, not files out of memory.

- **First paint**, from spawning the process to the page's first frame: 1,851 and 1,520 ms on the first start from new files; 751 to 852 ms after [m]. **Defender's part is about 0.7 to 1.1 s** on the first start [i]. Inside the process, CEF's own start to first paint was 337 to 445 ms in every run [m].
- **Memory** while one animated page shows: 184 to 194 MB private working set in 6 processes, 242 to 251 MB commit [m]. Private working set is the nearest Windows figure to Linux's PSS; the two are not the same measure.
- **With the browser closed and CEF still up:** 165 to 170 MB in 5 processes [m]. The helper-process conclusion holds on Windows.
- **Stop:** 392 to 679 ms from quit to exit; no process from the install left after any run [m].

**Size** (`q7-size.txt`) [m]:

- **Archive:** `cef_binary_156.0.31+ge603d97+chromium-156.0.8078.100_windows64_minimal.tar.bz2`, 175,156,160 bytes, SHA-256 `c691636862b5f6bab05e76d77bd1b57799659552a25a5bc8b7eaa365de6e63fd`. `libcef.dll` SHA-256 `058e4ec7e02e2b5f0544463a7f54b1e9b055e62c71407e696d2e89024429c32b`.
- **Installed:** 356 MB for CEF in 14 files with one locale (`libcef.dll` alone 281 MB, ships without symbols); 364 MB with the spike's binary. All 220 locales add 50 MB.
- **Compressed:** 147 MB with zstd at level 12.
- **Not signed.** `libcef.dll`, `chrome_elf.dll` and `bootstrap.exe` carry no Authenticode signature [m]. Sotto's release signs its own binaries; these would need the same, or SmartScreen and Defender treat them as unknown [i].

## 6. Its own network calls

`scripts/net.ps1`: ten minutes with no page, then one local page for five seconds, with the first note's hardened switches and seeded preferences, a NetLog, and every 2 s the OS's own tables of the tree's TCP connections and UDP sockets. Summaries `q5-*.txt`; no NetLog bodies kept.

**Hardened** (`q5-net-hardened.txt`) [m]:

- **No request outside loopback.** The only requests were the redirected component updater's two POSTs to `http://127.0.0.1:9/` (at 0 s and 60 s) and the local page.
- **One Windows-only caller: proxy auto-detection.** Windows' default proxy setting is "Automatically detect settings", and CEF follows the system's setting (`{"auto_detect": true, "from_system": true}`). It ran WPAD six times in ten minutes, each a DHCP query for a proxy script (`WPAD_DHCP_WIN_FETCH`) and a DNS lookup of `wpad`: twice in the first second, twice at 8 s, then before the updater's second loopback POST (60 s) and before the page (600 s). These go to the local network's DHCP server and resolver, not to Google.
- With `--no-proxy-server` added (`q5-net-noproxy.txt`), no `wpad` lookup and no DHCP fetch happened [m]. Electron follows the same system setting today [i], so whether Sotto's browser pane honours the user's proxy is a product choice. The component with no page open should not run it [e].
- **The socket poll saw nothing** from the tree in ten minutes [m]. It misses a socket that opens and closes between two reads, so it does not stand in for a capture.

**CEF's defaults, from the other runs.** The seal runs without the hardened settings (`q2-seal-all.txt`, `q2-seal-none.txt`) show the same Google callers as Linux: `update.googleapis.com`, `edgedl.me.gvt1.com`, `clients2.google.com`, `www.google.com`. Windows adds `chromewebstore.googleapis.com` and `clients2.googleusercontent.com`, the registry extensions' fetch (`q5-registry-extensions.txt`, item 3 above) [m].

**Not done here: a packet capture.** `net session` failed with error 5, so this shell is not elevated, and `pktmon` and firewall rules need it. Section 9 has the commands.

## 7. The seal

`scripts/seal.ps1` runs `server/hostile.html` with its second address pointed at a canary on **a second machine** (forge, over the tailnet, `server/testserver.py` bound to its tailnet address) and the first at this laptop's loopback canary. Every run kept a NetLog. Summaries `q2-*.txt`.

| Layers | Loopback canary | Canary on forge | NetLog outside loopback |
| --- | --- | --- | --- |
| None | 20 hits: TCP and WebRTC UDP | 24 hits: TCP, UDP, an HTTP download | Every escape, plus the page's DNS name |
| Page only: CSP, filter, refusals | 26 hits: 25 WebRTC UDP, 1 TCP | 25 hits: 24 WebRTC UDP, 1 TCP | CEF's own Google calls (defaults) |
| All | **0** | **0** | CEF's own Google calls (defaults); 14 connections held at the dead proxy |
| All, with the hardened settings | **0** | **0** | **None.** 12 connections held at the dead proxy; WPAD's `wpad` lookups |

[m] all rows. As on Linux, the page layer alone leaks WebRTC and the network layer holds. With all layers no request from the page reached the network service outside loopback, so the dead proxy and the page's policy stopped everything before a socket. Navigation was refused 5 times and the second load of the address found nothing [m].

**What is proven and what is not.** Proven: from this laptop, nothing the hostile page tried reached either canary, and the network service logged no attempt to leave loopback [m]. Not proven: that no packet left at all. A NetLog does not see WebRTC's raw UDP or mDNS sockets as requests, and the first note's IGMP reports on Linux came from exactly there. That needs `pktmon` and a firewall that blocks everything but the canary (section 9). The forge canary only proves its own address was not reached.

## 8. Codecs

`q1-cdp.json` gives the same answers as Linux: `{"h264":"no","aac":"no","hevc":"no","vp9":"probably","av1":"probably","opus":"probably","mp3":"probably"}` [m].

**Windows' own decoders are not used for H.264 or AAC** (`q1-codecs-playback.json`, `server/pages/media.html`, clips made with ffmpeg at run time) [m]:

- A 2 s H.264/AAC MP4 failed with `MEDIA_ERR_SRC_NOT_SUPPORTED` (code 4).
- `MediaSource.isTypeSupported` was false for H.264 and AAC, and `mediaCapabilities.decodingInfo` said H.264 is not supported.
- The same clip in VP9/Opus played.

`libcef.dll` does contain Media Foundation playback code (`MediaFoundationRenderer`) and Chromium's D3D11 video decoder, but the H.264 and AAC formats are switched off in the build itself [m][i]. A CEF built from source with proprietary codecs is still the only way back; not attempted.

## 9. Steps only Zach can do

Every step needs, from the repository root: the spike built (`cmd /c D:\sotto-webpane-work\build.cmd web-pane-spike`, which puts the Build Tools' CMake and Ninja on `PATH`), laid out (`powershell -File web-pane-spike\scripts\dist.ps1`), and the test server running (`python -I web-pane-spike\server\testserver.py --pages web-pane-spike\server\pages > D:\sotto-webpane-work\server.log`; `seal.ps1` reads that log).

**An elevated shell** (Windows Terminal, "Run as administrator"):

```powershell
# 1. A packet capture of ten idle minutes, hardened, with nothing else talking if possible.
pktmon filter remove; pktmon start --capture --pkt-size 128 --file-name D:\sotto-webpane-work\net.etl
powershell -File web-pane-spike\scripts\net.ps1 net-hardened-pcap -Hardened -IdleSeconds 600
pktmon stop; pktmon etl2pcap D:\sotto-webpane-work\net.etl --out D:\sotto-webpane-work\net.pcapng
# Then count packets by remote address (any non-loopback, non-tailnet destination is a finding).

# 2. The seal behind a firewall: one Block rule for webpane.exe covering every address but loopback and the canary
#    (forge's tailnet address). A Block rule wins over any Allow rule, so the exceptions are cut out of its ranges.
$others = "0.0.0.0-100.106.126.3", "100.106.126.5-126.255.255.255", "128.0.0.0-255.255.255.255", "::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"
New-NetFirewallRule -DisplayName "wp-seal" -Direction Outbound -Program D:\sotto-webpane-work\dist\webpane.exe -RemoteAddress $others -Action Block
auditpol /set /subcategory:"Filtering Platform Packet Drop" /failure:enable
# start the canary on forge as section 7 says, then:
powershell -File web-pane-spike\scripts\seal.ps1 seal-firewalled "csp,filter,proxy,webrtc,deny" D:\sotto-webpane-work\seal\hostile-forge.html -Hardened
Get-WinEvent -FilterHashtable @{LogName='Security'; Id=5152; StartTime=(Get-Date).AddMinutes(-5)} | Where-Object { $_.Message -match 'webpane' } | Measure-Object
# Remove the rule and the audit setting afterwards:
Remove-NetFirewallRule -DisplayName "wp-seal"; auditpol /set /subcategory:"Filtering Platform Packet Drop" /failure:disable
```

The drop log (event 5152) is the measure: every packet it records from `webpane.exe` is an attempt that got past the page's own layers. The canary on forge says whether anything reached the one address left open [d][i].

**His hands and ears:**

- **Real input in the off-screen pane.** Run `powershell -File web-pane-spike\scripts\embed.ps1 feel -Seconds 60 -NoInput WP_PATH=accelerated WP_REMOTE=1 WP_REMOTE_HOLD_S=55`, click the text field and type, scroll with the touchpad, press Win+. and pick an emoji. The emoji panel will not reach the page: the spike forwards plain keys only and has no IME code (section 4). Say how typing and scrolling feel.
- **Narrator.** Start Narrator (Ctrl+Win+Enter). Run `powershell -File web-pane-spike\scripts\uia.ps1 hear-offscreen` and then `$env:WP_MODE_OVERRIDE="child"; powershell -File web-pane-spike\scripts\uia.ps1 hear-child WP_SWITCHES=disable-direct-composition`, and move into each window's page with Caps Lock+arrows. The first should say only the window; the second should read the page.
- **A stuck helper under real input.** `powershell -File web-pane-spike\scripts\childx.ps1 hang-by-hand -Hang WP_SWITCHES=disable-direct-composition`: within 3 s of the window opening, click inside the page, then click the dark sidebar and drag the window. Say whether the window froze for the 6 s the helper is stuck.

## What changes for Apple silicon macOS (noticed on the way, not run)

- The two-GPU problem does not exist on Apple silicon (one GPU); it does on Intel Macs, which Sotto does not target [i].
- The helper link would send an IOSurface as a Mach port (`IOSurfaceCreateMachPort`) over XPC or a Mach message, where Windows duplicates an NT handle. The ownership rule is the same: the window process starts the helper and holds the right to its handles [i].
- A windowed browser's `DoClose` sends `performClose:` to the top-level window [d]. A child `NSView` cannot be put into another process's window at all, so the off-screen path, and therefore the accessibility bridge (to VoiceOver through AccessKit's macOS adapter), is the only path there [i].
- The registry-extension behaviour is Windows-only; on macOS the equivalent is Chrome's external extensions folder under Library, which the same hardening needs checking against [i].

## Could not verify

- A packet capture and a firewalled seal (no elevation; section 9 has the commands).
- Which single switch stops the registry-extension fetch; the hardened set as a whole does (section 6).
- What makes the GPU process crash with DirectComposition in CEF's windowed mode on this laptop.
- The CEF sandbox on Windows (`bootstrap.exe`); every run had it off.
- Real keyboard, IME and emoji-panel input, real drag and drop with the OS, a real file picker, and Narrator by ear. Everything in section 4 drove CEF's half only.
- A true cold start (file cache emptied): needs elevation.
- Whether a hung helper stalls Sotto's window under real clicks (section 3).
- A second Windows machine, an AMD GPU, or a display at scale 1.
