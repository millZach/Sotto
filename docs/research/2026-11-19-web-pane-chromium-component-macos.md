# The web pane spike: Chromium as a component, on Apple silicon macOS

Researched November 19, 2026, for issue #2690: stage 0, item 2 of `docs/plans/2026-11-14-rust-native-port.md`. It closes the macOS column of section 8 in [the Linux note](2026-11-19-web-pane-chromium-component.md), which comes first, and follows [the Windows note](2026-11-19-web-pane-chromium-component-windows.md). Neither is repeated here. Same code (`web-pane-spike/` on `prototype/web-pane-chromium`), same CEF 156.0.31 through the `cef` crate 156.7.0, built with Rust 1.100.0 for `aarch64-apple-darwin`.

There is no Mac to work on. Everything here ran on GitHub's hosted `macos-26` runner, the label `stable-mac.yml` and `owl-mac.yml` use: macOS 26.7.2 (25G332) in a virtual machine, "Apple M1 (Virtual)" with 3 cores and 7 GB, an "Apple Paravirtual device" GPU on Metal, a 1024x768 display, System Integrity Protection off, logged in to a GUI session as `runner` [m]. Evidence: `artifacts/web-pane-chromium/macos/`. The workflow that ran it is gone from the branch; the end of this note says how to put it back.

Tags as in the first note: **[m]** measured here, **[d]** documented, **[i]** inferred, **[e]** my judgement. A measurement on a runner is a measurement of a virtual Mac; where that matters, the line says so.

## What threatens the plan

1. **On macOS a VoiceOver user gets nothing from a web pane unless Sotto builds the bridge, and there is no fallback.** From outside, through the Accessibility API VoiceOver uses, the off-screen pane is a window with three title-bar buttons and no page [m]. CEF's own native window gives the whole page: web area, headings, landmark, link, button, text field [m]. On Windows that native view could live in the helper's process inside Sotto's window, so it was a fallback with square corners [m]. On macOS a view cannot cross processes [i], and a CEF view in Sotto's own process is what the helper-process finding rules out. So the off-screen pane plus an accessibility bridge (CEF's tree into AccessKit's macOS adapter, actions through the DevTools protocol) is the only way a web pane is readable on macOS, and it has to be built in stage 4, not after it [i]. One piece of good news: CEF's tree does carry every state. The Windows note read its padded state lists as truncated; they are not, on either system (section 4) [m].
2. **CEF's defaults reach into the Mac outside its profile.** On its first start CEF writes a "Chromium Safe Storage" item into the user's login keychain [m]. With an ad hoc signed app, each update is a new code identity, so that item would likely cost a keychain prompt per update [i]. It also reads `/Library/Application Support/Google/Chrome/External Extensions`, where any installer can register an extension for Chrome, and fetches and installs what it finds from the Chrome Web Store [m]. The Windows note found the same through the registry [m]. `use-mock-keychain` stops the first and the hardened settings stop the second [m]. `use-mock-keychain` is not in `config/hardened-switches.txt` yet and must be in what ships, and the capture gate each CEF update needs (first note, section 5) must plant an extension in that folder [e].
3. **CEF arrives unsigned, as six bundles.** The framework and its three dylibs carry only the linker's ad hoc signature, and Sotto's bundle adds five helper apps [m]. Today's ad hoc release signing carries over if everything is signed from the inside out. Notarization, when it comes, needs a hardened-runtime entitlements file per helper [d]. That is release work, not a reason the plan cannot hold (section 8) [e].

Neither of the first note's two changes to the plan moves. The component is still a helper process, and macOS's link (an IOSurface's Mach port, 25 µs to look up) works [m]. The codec question is the same here (section 9) [m].

A runner is a virtual Mac. Everything about timing on a real Apple GPU, VoiceOver itself, the keychain prompt, Gatekeeper and real input methods needs a person at a Mac (the end of this note).

## The questions

| # | Question | Answer on macOS (runner) | What decides it |
| --- | --- | --- | --- |
| 1 | Builds and starts | Yes | The bundle with five helper apps, the framework loaded through cef-rs's library loader, and an NSApplication that speaks `CefAppProtocol`. The command list passes 34 of 37 and the iPhone 11 of 12, the same misses as Linux and Windows. CEF's sandbox runs too (34 of 37 with it on). |
| 2 | Embedding | Yes, both paths, on a virtual GPU | Shared texture (IOSurface into Metal through cef-rs) and software frames both draw at the rectangle with rounded corners. On the paravirtual GPU the shared texture costs 12.8 ms a frame at 1280x800 and software 2.0 ms; indicative only. |
| 3 | The helper process | Yes | Each frame's IOSurface crosses as a Mach send right (`IOSurfaceCreateMachPort`) through a launchd service name; lookup 25 µs, round trip to acknowledgement 5.7 to 9 ms p50 on the virtual GPU. Scripted and real typing reach the page as trusted events. Nothing left after any of ten stops. |
| 4 | Accessibility | No off screen; yes in CEF's own window; the callback feed has the Windows shape | The Accessibility API from outside sees the off-screen pane's window and title-bar buttons only. CEF's own native window gives the whole page. CEF's state lists are padded, not truncated, here and in the Windows sample; there is still no call to act on a node. |
| 5 | Its own network calls | Yes with the hardened settings, plus two macOS callers | Ten minutes hardened: no request outside loopback, and every packet `pktap` and `pf` tied to the spike was on loopback. With CEF's defaults: Linux's Google callers, a "Chromium Safe Storage" item in the login keychain, and extensions read from `/Library/Application Support/Google/Chrome` and installed from the Web Store. `use-mock-keychain` and the hardened settings stop both. |
| 6 | The seal | Held, and proven by firewall | All layers with the hardened settings: no canary hit, no DNS question for the page, and `pf` blocking every TCP and UDP packet from the spike's processes to anywhere but loopback matched none. The page layer alone leaks WebRTC to both canaries, as elsewhere. |
| 7 | Start, stop, size | Yes | First paint 0.94 to 1.26 s warm, 7.2 to 7.4 s after `purge` on the runner's virtual disk. 219 to 253 MB physical footprint for one page; 145 to 152 MB with CEF up and no page; stop 0.12 to 0.33 s, nothing left. Framework 335 MB (298 MB with one locale), 129 MB with zstd. Archive SHA-256 `1bd39ff3…0ee8`. |
| 8 | What shipping needs | Read, not done | CEF's framework is not signed as published (the linker's ad hoc signature, no Team ID, no sealed resources). Today's ad hoc signing (ADR-0001) carries over if the bundle is signed inside out; notarization would need the hardened runtime and `allow-jit` on the Renderer and GPU helpers. |
| 9 | Codecs | Same as Linux and Windows | H.264 and AAC "no"; a real H.264/AAC file fails (`MEDIA_ERR_SRC_NOT_SUPPORTED`) and VP9/Opus plays. VideoToolbox is linked into the framework but not used for them. |

---

## 1. Builds and starts

**What macOS needed** (all in the spike now, behind `cfg`) [m]:

- **The bundle.** `scripts/mac/bundle.sh` lays out `webpane.app` with `Chromium Embedded Framework.framework` in `Contents/Frameworks` and five helper apps beside it (`webpane Helper`, `(GPU)`, `(Renderer)`, `(Plugin)`, `(Alerts)`), each with its own `Info.plist`, as CEF requires and cef-rs's `bundle-cef-app` does [d]. All six run the same binary, which tells them apart by `--type`.
- **The framework is loaded, not linked.** `cef::library_loader::LibraryLoader` loads it before any CEF call, from `../Frameworks` for the main executable and three folders up for a helper (`src/mac.rs`).
- **An NSApplication that speaks `CefAppProtocol`**, made before anything asks for `NSApp`, adapted from cef-rs's cefsimple. winit 0.30 accepts an existing application object and swizzles its own `sendEvent:` in front of ours, which it then calls [d], so the spike's class and winit coexist [m]. Only the browser process makes one: a helper that did crashed under CEF's sandbox with "required built-in appearance SystemAppearance not found" [m], and cef-rs's own helper makes none [d].
- **CEF runs only on the main thread.** macOS has no `multi_threaded_message_loop`, so the in-process window sets `external_message_pump` and calls `do_message_loop_work` between winit's `pump_app_events` turns, and creates the browser with the synchronous call on that thread (`src/embed.rs`). The helper and the scripted modes keep `run_message_loop`.
- **Compile errors:** none in the first runner build. The Linux build checked the shared code; the macOS paths were checked against cef-rs's macOS bindings by reading them, which found one signature that differs (`on_cursor_change` takes `*mut u8`, not `HCURSOR`) [m].

The first build from nothing, including CEF's 135 MB download and its wrapper library, took 4 minutes on the runner [m].

**The command list** (`q1-cdp.json`): 34 of 37 checks and all 25 commands, the same three misses as Linux and Windows: a detach does not end emulation, a hidden page holds wheel input, codecs [m]. The off-screen view draws a 15 px classic scrollbar here too (`cssVisualViewport` 1265 wide). That follows the runner's pointing device (a mouse, not a trackpad) and says nothing about a laptop [i].

**The test iPhone** (`q3-iphone.json`): 11 of 12, the same informational miss: a pointer click through CEF's mouse input arrives as a mouse event, so the pane sends touch itself [m].

**CEF's sandbox runs** (`q1-cdp-sandbox.txt`): with the sandbox on, each helper starts it through `libcef_sandbox.dylib` before loading the framework (cef-rs's `Sandbox`), and the command list passes 34 of 37 with no process crashing [m]. Windows did not run its sandbox; here it is one call. Every other run set `WP_NO_SANDBOX`, as on Windows.

## 2. Embedding

`embed` in process: winit 0.30 and wgpu 30 on Metal, CEF pumped by hand on the main thread, the page imported with cef-rs's IOSurface importer (`newTextureWithDescriptor:iosurface:plane:`, then a copy into a texture the window owns, waited for) [d]. `WP_VIEW` fixed the page at 1280x800 or 2560x1600 inside a 1024x645 window (the runner's display is 1024x768) [m]. Records `q2-embed-*.json`, with the process tree's CPU and footprint over 10 s in `q2-embed-*-tree.json`.

**The GPU is virtual.** wgpu reports "Apple Paravirtual device (Metal, IntegratedGpu)" and Chromium's GPU process uses the same device [m]. Its shared-texture path is the one Apple silicon has, but its costs are a hypervisor's [e]. Treat the times as proof the path runs, not as Sotto's frame budget.

| Page (pixels), path | Frames/s (animated page) | Cost per frame in the window process, p50 / p95 | Tree CPU (one core = 100%) | Tree footprint |
| --- | --- | --- | --- | --- |
| 1280x800, shared texture | 34.0 | 12.8 / 47.1 ms | 86% | 286 MB |
| 1280x800, software | 53.1 | 2.0 / 3.6 ms | 117% | 281 MB |
| 2560x1600, shared texture | 38.6 | 17.4 / 39.0 ms | 75% | 465 MB |
| 2560x1600, software | 51.5 | 9.0 / 18.1 ms | 120% | 544 MB |

[m] all rows. On this virtual GPU the shared texture is slower than copying pixels: the cost is the wait for the GPU copy, and the paravirtual device makes that wait long [i]. On Linux and Windows the shared texture was the cheaper path at 2560x1600 [m]. Whether it is on a real M-series GPU is the first thing a Mac at a desk should measure (end of this note).

**The page draws, with rounded corners.** The window saved its own frame (`q2-embed-*.png`, drawn into an offscreen texture and read back), and the runner's screen capture shows the same window (`q2-screen-embed.png`): the page inside the 14 px anti-aliased rounded rectangle over the stand-in sidebar and strip [m].

## 3. The helper process

Built for macOS in `web-pane-spike/src/remote_mac.rs`. The window process never starts CEF. It checks in a per-helper launchd service name (`bootstrap_check_in`, as Chromium's own Mach rendezvous does [d]), starts `webpane` as a helper with the name and one end of a Unix stream socket pair, and receives Mach messages on the service's port.

**Frames.** In `on_accelerated_paint` the helper turns CEF's IOSurface into a Mach send right (`IOSurfaceCreateMachPort`) and moves it in a port descriptor with the 64-byte record inline. The window looks the surface up (`IOSurfaceLookupFromMachPort`), copies it into its own Metal texture with the same cef-rs importer, from an `AcceleratedPaintInfo` it fills in itself, acknowledges over the socket, and releases the surface and the right. The helper waits for the acknowledgement before returning the surface to CEF, as on Linux. Input goes the other way as Linux's 64-byte records over the socket (macOS has no `SOCK_SEQPACKET` for Unix sockets, so it is a stream of fixed records).

- **The rendezvous works unprivileged:** `bootstrap_check_in` gave every cycle its channel; the `bootstrap_register` fallback was never needed [m].
- **Cost** (`q3-remote-*.json`, `q3-remote-cycles-helpers.txt`): `IOSurfaceCreateMachPort` 5 to 9 µs p50; `IOSurfaceLookupFromMachPort` 24 to 32 µs p50; the helper's send-to-acknowledgement round trip 5.7 to 9.0 ms p50 and 10 to 53 ms p95 at 1280x800, over 12 helpers and about 4,300 frames [m]. Nearly all of it is the copy on the virtual GPU: the in-process import alone was 12.8 ms p50 [m]. The Mach handoff itself costs tens of microseconds [m].
- **Typing reaches the page** (`q3-remote-input-helper-side.json`). The window's scripted input, sent through the same path winit's events take, gave a trusted `mousedown` on the field and "across the socket" one `input` event per character [m]. Then real input from outside: `tools/macprobe.swift` posted CGEvent clicks and key presses to the window, winit turned them into the spike's records, and the page got trusted `mousedown` events at the click points and " real keys" typed where the caret was (`q3-screen-remote.png`) [m].
- **Key identity needs Mac codes and characters.** CEF on macOS reads `native_key_code` as a Carbon virtual key code; with Windows codes there, letters reached the page as `F18` and `AudioVolumeUp` [m]. With Mac codes the text is right, but keydown's `key` is still "Unidentified", because CEF on macOS takes it from the characters on the keydown, which the spike sends only on the char event [m][i]. The pane has to build each key event from the NSEvent, as cefclient does [d].
- **Cycles** (`q3-remote-cycles.json`, ten across two rounds): first frame in the window 973 to 1,698 ms after the helper starts; the helper 212 to 269 MB physical footprint in 6 processes; stop 185 to 686 ms; no helper process and no process from the bundle left 2 s after any stop [m].
- **The window process:** 25 to 26 MB footprint before the first pane and 39 to 40 MB after the last, with the framework mapped and never started [m]. Linux's window process was 121 MB PSS and Windows' 278 MB private working set; the measures differ and the runner's virtual GPU driver is small, so this is not a comparison [e].

**A child view in the window: not available.** AppKit has no public way to put one process's `NSView` into another process's window [i]; Windows could do it with an HWND, Wayland cannot at all (the first note's section 4). CEF's own native view therefore means CEF in Sotto's own process, which the one-start-per-process and memory findings already rule out. The off-screen path is the only shape on macOS [i].

## 4. Accessibility

**Does the runner allow walking the tree from outside? Yes.** `AXIsProcessTrusted()` was true for the probe, and the runner image's TCC database already grants Accessibility to `/bin/bash` and Screen Recording to the provisioner (`q4-ax-trust.txt`) [m]. So the walks below are what VoiceOver's API would see, without VoiceOver speaking.

**The off-screen pane gives nothing of the page** (`q4-ax-offscreen-pane.txt`). The walker saw the application, its window "Sotto web pane spike", the three title-bar buttons, the title and the menu bar: 67 elements, none from the page, also with `force-renderer-accessibility` on [m]. The same as Narrator on Windows.

**CEF's own native window gives the whole page** (`q4-ax-windowed.txt`, `q4-screen-windowed.png`): an `AXWebArea` "CDP test page" with the heading "Page automation test", the "Main" landmark, the link "Link one", the button "Press me", the text field and the heading "Deep heading" [m]. That needed `force-renderer-accessibility`. Setting `AXManualAccessibility` or `AXEnhancedUserInterface` on the application failed (`kAXErrorAttributeUnsupported`, `kAXErrorNotImplemented`), because the spike's NSApplication does not take them. cefclient's application turns CEF's accessibility on when VoiceOver sets them [d]. Sotto's would have to do the same for any native view.

**CEF's callbacks** (`osr` mode, `q4-offscreen-ax-sample.json`): `on_accessibility_tree_change` delivers Chromium's tree as CEF values, about 14 KB for the probe page, with ids, roles, names, bounds and child ids, then updates (the button's new name arrived) [m]. Against the Windows note's two gaps:

- **State lists: the same shape, and not lost.** Each state name is followed by six empty strings, so a list is 7, 14 or 21 long for one, two or three states: `["editable","focusable","multiline","",…]`, `["collapsed","focusable","",…]`, `["focusable","linked","",…]` [m]. The Windows sample in the repository has exactly these lists for the same nodes [m]. The Windows note read one-state nodes as one name and empty strings and concluded states such as expanded or checked would be lost; with several states every name is there. A bridge drops the empty strings [i].
- **No call to act on a node: the same.** CEF's API is the same on every system; actions still go through the DevTools protocol [d].

**The rest of the off-screen work** (`q4-offscreen-probes.json`, 10 of 11 at a scale of 2): device scale, cursors (hand, I-beam), the `<select>` pop-up shown and painted as its own layer, IME composition and commit into the field, drag out (`start_dragging`), drop in, the file picker and the context menu all reached their CEF callbacks [m]. The miss: one Down then Enter in the pop-up picked "Cherry", not "Banana". The pop-up takes keys, but the spike's Mac key events moved it two items [m]. The first round, with Windows key codes, did not move it at all [m]. As on Windows, this tests CEF's half; the macOS halves (`NSTextInputClient` for IME, `NSDraggingSource`, `NSOpenPanel`, `NSMenu`) were not driven.

So on macOS the accessibility bridge is not one option among two, as it was on Windows. A VoiceOver user reads web panes only if Sotto builds it (AccessKit's macOS adapter, fed from CEF's tree, actions through the DevTools protocol) [i].

## 5. Its own network calls

Each run kept a NetLog, and the runner captured every packet on every interface through macOS's `pktap`, which tags each packet with the process that sent or received it (`tcpdump -i pktap,all -k NP`) [d][m]. So the spike's packets can be told from the runner's own traffic (GitHub's agent, Apple's services) without a quiet machine. The spike also ran with a group of its own (`wpnet`, through `scripts/mac/as_group.py`), and a `pf` rule that logs every packet from that group's sockets gave a second, independent attribution [m]. macOS's DNS daemon asks on an app's behalf; `pktap` names the app it asked for (`mDNSResponder … eproc webpane Helper`), so those count too [m]. Summaries `q5-*.txt`; no packet dumps or NetLog bodies kept.

**CEF's defaults** (`q5-net-default.txt`: 240 s with no page, then one local page for 60 s). The same callers as Linux, in the same order: network time and the AI Mode eligibility request (`www.google.com/async/folae`) in the first second, 21 component-update checks to `update.googleapis.com`, 19 component downloads from `edgedl.me.gvt1.com` (one in the first second, 18 from 184 s), and Safe Browsing at 270 s [m]. Every far address the spike's processes reached, apart from the runner's DNS resolver, was Google's: 14,144 packets in all, most of them the downloads [m]. The network process also sent 40 DNS packets to the runner's resolver itself: Chromium's own DNS client runs on macOS with the defaults [m].

**Two macOS-only callers**, each settled with its own runs:

- **The login keychain.** On its first start with CEF's defaults, CEF created a "Chromium Safe Storage" item in the user's login keychain [m] (`q5-keychain-first-run.txt`: none before the first run, one after). The runner's keychain is unlocked, so there was no prompt there [m]. With the item deleted, a run with `use-mock-keychain` created nothing; the next run without it created the item again [m] (`q5-keychain-mock.txt`). On a real Mac the item's access list names the app that made it. An ad hoc signature changes with every build, so each update would likely meet a keychain prompt in front of the user [i]. That needs a real Mac to see. `use-mock-keychain` belongs in the shipped switches, and it also means cookies in the browser pane are not encrypted with a keychain key [i]. Electron has the same choice today (`safeStorage`) [e].
- **Other programs' extensions, from `/Library`.** The Windows registry finding has a macOS twin. With an entry planted in each of four External Extensions folders in turn (`q5-extensions.txt`), CEF's defaults read only `/Library/Application Support/Google/Chrome/External Extensions`: it asked the Chrome Web Store about the extension, downloaded it and installed it in the profile (42 matching NetLog lines, 3 extension folders) [m]. The user-level folders and the Chromium-named ones were not read [m]. That folder is where other programs' installers register extensions for Google Chrome, machine-wide [d]. With all four planted and the hardened settings, nothing was fetched or installed [m].

**Hardened** (`q5-net-hardened.txt`: the first note's switches and preferences plus `use-mock-keychain`, 540 s with no page, then one page for 60 s). **No request outside loopback** in the NetLog: two POSTs to the redirected updater at `http://127.0.0.1:9/` and the local page [m]. `pktap` attributed 28 packets to the spike's processes in ten minutes, every one on loopback, and `pf`'s log of the spike's group agrees: 28 packets, all on `lo0` [m]. No DNS question was asked on its behalf [m]. No proxy auto-detection appeared; the runner has no proxy setting to follow, so Windows' WPAD finding is unchecked here [i].

**A caution about the profile.** CEF made a `Default` profile folder beside the configured `profile` one, which is where the seeded preferences go [m]. The hardened result does not depend on the preferences: the first note's one-out runs tied every caller to a switch, and spell check to either [m]. Which folder CEF reads preferences from on macOS is unchecked.

## 6. The seal

`seal` mode with `server/hostile.html`, its second address pointed at a canary on the runner's own network address (`192.168.64.x` on `en0`; macOS delivers that over `lo0`, but Chromium treats it as an ordinary network address) and its first at the loopback canary. A `pf` anchor (`com.apple/wpspike`) let loopback through and blocked and logged every TCP and UDP packet from the spike's group to anywhere else, with `pktap` capturing everything and a capture of every DNS question on the machine. Summaries `q6-seal-*.txt`.

| Layers | Loopback canary | Canary on the network address | Blocked by `pf` (the spike's sockets) | DNS naming the page's hosts |
| --- | --- | --- | --- | --- |
| None | 23 hits: TCP and WebRTC UDP | 25 hits: TCP, UDP, an HTTP download | 310 packets: CEF's own Google calls and DNS | `wpspike-fetch`, `wpspike-stun` |
| Page only: CSP, filter, refusals | 26 hits: 25 WebRTC UDP, 1 TCP | 25 hits: 24 WebRTC UDP, 1 TCP | 146 packets, CEF's own Google calls | none |
| All | **0** | **0** | 102 packets, all CEF's own Google calls and their DNS | none |
| All, with the hardened settings | **0** | **0** | **0 packets** | none |

[m] all rows. As on Linux and Windows, the page layer alone leaks WebRTC to both canaries and the network layer holds. With all layers the dead proxy held 6 connections, navigation was refused 5 times, the page's second load found nothing, and no DNS question for any of the page's names was asked [m]. The only traffic that tried to leave was CEF's own default callers (time, AI Mode, component updates), which `pf` blocked. With the hardened settings, `pf`'s block rules matched nothing at all [m].

**What is proven.** Nothing the hostile page tried reached either canary or any other machine. No TCP or UDP packet from the spike's processes tried to leave the machine with all layers and the hardened settings, as counted by a firewall that would have dropped it. The macOS DNS daemon asked nothing for it [m]. This closes what the Windows note left open, a capture and a firewall around the seal, for macOS [m]. No IGMP or other multicast came from the spike's processes (Linux saw IGMP reports) [m].

**What is not.** `pf`'s group match covers TCP and UDP sockets only [d], so ICMP and raw sockets were watched only by `pktap`, whose ICMP lines carried no process; none named the spike [m]. The canary on the runner's own address proves that address was not reached, not that a real second machine would not be. The seal's no-layer row ran under a first `pf` rule that broke connections into the spike's own listeners, so its HTTP count is a floor. The full-seal rows were run again with that fixed (round 4) [m]. A compromised renderer, side channels and the bridge (ADR-0060's steps and Escape) are untested, as on the other systems.

## 7. Start, stop, size

**Start and stop** (`scripts/mac/lifecycle.py`, `q7-lifecycle.json`). Eight starts of `pane` mode, alternating a true cold start (`sudo purge` empties the file cache first, which the runner's passwordless sudo allows) and a warm one [m]:

- **First paint**, from spawning the process to the page's first frame: 7.2 to 7.4 s cold, and 15.3 s on the very first start; 0.94 to 1.26 s warm [m]. Inside the process, CEF's own start to first paint was 1.7 to 2.9 s cold and 0.56 to 0.71 s warm [m]. So most of a cold start, about 5 s, passes before CEF starts: loading a 238 MB framework from the runner's virtual disk [i]. The first start's extra 8 s is most likely macOS checking binaries it has never seen; a downloaded app's first launch adds Gatekeeper on top [i]. A real Mac's SSD and a real first launch are the measurement that matters here.
- **Memory** while one animated page shows: 219 to 253 MB physical footprint in 6 or 7 processes [m]. Physical footprint is what Activity Monitor shows as Memory; it is not Linux's PSS or Windows' private working set.
- **With the browser closed and CEF still up:** 145 to 152 MB in 5 processes [m]. The helper-process conclusion holds on macOS.
- **Stop:** 121 to 325 ms from quit to exit, and no process from the bundle left after any run [m].
- **As a helper under the window** (section 3): first frame in the window 0.97 to 1.7 s, the helper 212 to 269 MB in 6 processes, stop 185 to 686 ms, nothing left [m].

**Size** (`q7-size.txt`) [m]:

- **Archive:** `cef_binary_156.0.31+ge603d97+chromium-156.0.8078.100_macosarm64_minimal.tar.bz2`, 134,916,866 bytes, SHA-256 `1bd39ff38db20baa5b52768919d6599aafb4aacbc7fd192458496749a0630ee8`.
- **The framework binary:** 238,066,432 bytes, arm64 only, SHA-256 `3088635f27b47e3a3d39ca86f43aa10935af861e61c78bc6c135e342a294191e`. It ships without debug symbols (5,244 symbols in all), as Windows' does and Linux's does not.
- **Installed:** the framework is 335 MB with all 220 locale folders (51 MB of them) and 298 MB with `en.lproj` alone; the whole app with the spike's binary and five helper copies is 379 MB. The framework holds the binary, `libcef_sandbox.dylib`, SwiftShader and its Vulkan loader, the `.pak` resources, ICU data, the V8 snapshot and a GPU shader cache.
- **Compressed:** 129 MB with zstd at level 12, 118 MB with `en.lproj` alone.

The five helpers are copies of the spike's binary here, 7 MB each. Sotto's would be one small helper binary, linked to the framework through its library loader [i].

## 8. What shipping needs (read, not done)

No signing identity was available and none was looked for. What the runner measured and what CEF and Sotto's own release say:

- **CEF's framework is not signed as published** (`q8-signing.txt`). `codesign -dvvv` on the framework from the Spotify CDN archive shows `flags=0x20002(adhoc,linker-signed)`, `Signature=adhoc`, `TeamIdentifier=not set`, `Sealed Resources=none`, and the same for `libcef_sandbox.dylib`, `libvk_swiftshader.dylib` and `libvulkan.dylib` [m]. `codesign --verify --strict` on the copied bundle fails ("code has no resources but signature indicates they must be present"), and so does Gatekeeper's assessment of the unsigned app [m]. Like the Windows DLLs, Sotto's release has to sign all of it.
- **Today's Mac release is ad hoc signed, not notarized** (`electron-builder.yml`: `identity: '-'`, `hardenedRuntime: false`; ADR-0001, ADR-0096) [d]. The same works for CEF: sign ad hoc from the inside out (the framework's `Libraries` dylibs, the framework, each helper app, then the app), without `--deep` [d]. The spike's bundle ran unsigned beyond the linker's signature only because nothing quarantined it [m][i].
- **Notarization, when Sotto turns it on**, needs the hardened runtime on every helper with its own entitlements: `com.apple.security.cs.allow-jit` for `(Renderer)` and `(GPU)`, an empty set for the plain, `(Plugin)` and `(Alerts)` helpers in CEF's example, the main app's device entitlements, no `get-task-allow`, and no `allow-unsigned-executable-memory` or `disable-library-validation` unless shown to be needed, with everything signed by one Team ID [d] (CEF's Code Signing page, https://chromiumembedded.github.io/cef/code_signing.html , and Chromium's `chrome/app/helper-*-entitlements.plist`). Sotto's current entitlements already carry `allow-jit`, `allow-unsigned-executable-memory` and `disable-library-validation` for Electron [d]; CEF's page asks for less.
- **The helpers are where it gets long.** Each of the five helper apps is a separately signed bundle [d]. Electron's are the same today [d], so the release procedure gains no new kind of step, only CEF's names [i].
- **The keychain item follows the signature.** See section 5: with CEF's defaults the item's access list names the app that made it, and an ad hoc signature changes with every build [i].

## 9. Codecs

`q1-cdp.json`: `{"h264":"no","aac":"no","hevc":"no","vp9":"probably","av1":"probably","opus":"probably","mp3":"probably"}`, the same as Linux and Windows [m].

Played (`q9-codecs-playback.json`, `server/pages/media.html`, the two 2 s clips now in `server/media/`, made with ffmpeg on forge): the H.264/AAC MP4 failed with `MEDIA_ERR_SRC_NOT_SUPPORTED` (code 4); `MediaSource.isTypeSupported` was false for H.264 and AAC, and `mediaCapabilities.decodingInfo` said H.264 is not supported; the VP9/Opus WebM played [m].

**VideoToolbox is linked but not used for H.264 or AAC** (`q9-codecs-static.txt`). The framework links VideoToolbox, AudioToolbox, CoreMedia and AVFoundation, and names `VTDecompressionSession` [m]. The formats are switched off in the build before any decoder is chosen, as on Windows with Media Foundation [i]. A CEF built with proprietary codecs is still the only way back; not attempted.

## What a runner could not tell

- **Frame cost on a real Apple GPU.** The runner's GPU is paravirtual, and on it the shared texture (12.8 ms) is slower than software frames (2.0 ms). On Linux and Windows it was the other way at the larger size [m]. Which path Sotto uses on macOS is open until a real M-series Mac measures both, at Retina scale 2 and on a 120 Hz display; the runner's display is 1024x768 at scale 1 [m].
- **VoiceOver itself.** The walk used the same Accessibility API, not VoiceOver's speech, rotor or focus following. And the AX tree of CEF's native window needed `force-renderer-accessibility`, because the spike's NSApplication does not take `AXManualAccessibility` as cefclient's does [m].
- **The keychain prompt.** The runner's login keychain is unlocked and nothing ever changed the app's signature between runs [m]. Whether two differently signed builds meet a prompt is [i].
- **Gatekeeper and quarantine.** Nothing on the runner was downloaded, so no quarantine flag and no first-launch assessment [m]; and no notarization was possible.
- **Real input methods and the OS halves.** IME through a real input source (Japanese, the emoji picker), trackpad scrolling and pinch, drag and drop with Finder, `NSOpenPanel` and a native context menu were not driven. The probes test CEF's half only [m].
- **A cold start on a real SSD**, and memory and energy on real hardware.
- **System proxy settings.** The runner has none, so the Windows finding (proxy auto-detection) is unchecked on macOS [i].
- **The child view across processes** was not attempted. The note says it cannot be done through public AppKit [i].

## Steps only a person at a Mac can do

On an Apple silicon Mac with Rust and Xcode's command line tools, from the repository root on `prototype/web-pane-chromium`:

```sh
cd web-pane-spike
export CEF_PATH=$HOME/.cache/sotto-cef CARGO_TARGET_DIR=$HOME/.cache/sotto-cargo-target
cargo build --release
bash scripts/mac/bundle.sh "$CARGO_TARGET_DIR/release/webpane" "$CEF_PATH"/156.0.31/cef_macos_aarch64 /tmp/wp
python3 -I server/testserver.py --pages server/pages > /tmp/wp/server.log &
```

- **Frame cost on the real GPU:** `python3 -I scripts/mac/run.py /tmp/wp/webpane.app /tmp/wp/runs embed acc 60 WP_NO_SANDBOX=1 WP_PATH=accelerated WP_VIEW=2560x1600 WP_EMBED_SECONDS=20`, the same with `WP_PATH=software`, and both again with `WP_REMOTE=1`; compare `import_us` in each `embed.json` with section 2.
- **VoiceOver by ear:** turn VoiceOver on (Command-F5), run the off-screen pane (`… embed vo 90 WP_NO_SANDBOX=1 WP_REMOTE=1 WP_REMOTE_HOLD_S=60 WP_EMBED_SECONDS=70`) and move into the page with Control-Option-arrows: it should find nothing. Then `… windowed vo2 60 WP_NO_SANDBOX=1 WP_HOLD_S=45 WP_SWITCHES=force-renderer-accessibility`: it should read the test page.
- **The keychain prompt:** run `… cdp kc1 120 WP_NO_SANDBOX=1`, rebuild after any one-line change to the spike (a new ad hoc signature), bundle again, run `… cdp kc2 120 WP_NO_SANDBOX=1`, and say whether macOS asked about "Chromium Safe Storage".
- **Real typing and IME:** in the pane from the frame-cost step, click the field, type, switch to a Japanese input source, and press Control-Command-Space for the emoji picker. Say what arrives (the spike sends plain keys only, so composition should not).

## Putting the workflow back

The workflow ran on this branch only and was removed in the branch's last commit so it stops spending runner minutes. To run it again:

```sh
git checkout 9c593efd9 -- .github/workflows/web-pane-spike-mac.yml
echo "info cdp iphone" > web-pane-spike/scripts/mac/phases.txt    # or empty the file for every phase
git commit -m "Run the macOS web pane spike again" && git push origin HEAD:prototype/web-pane-chromium
```

It runs on pushes to `prototype/web-pane-chromium` that touch `web-pane-spike/**` or the workflow, on `macos-26`, with a read-only token and no secrets. `scripts/mac/ci.sh` lists the phases; `phases.txt` picks them (`SEAL_VARIANTS=` there picks seal runs).

**What it cost:** four workflow runs, five attempts. Two attempts of the third run were never given a runner ("not acquired … even after multiple attempts", with GitHub's notice about macOS arm64 capacity) and billed nothing. Runner time was 11.0, 5.0, 23.9 and 7.2 minutes: 47 minutes, 49 billed by the started minute, at GitHub's macOS rate [m].

## Could not verify

- Everything in "What a runner could not tell" above.
- Which profile folder CEF on macOS reads seeded preferences from (section 5).
- The `<select>` pop-up's keys with key events built from real NSEvents, and keydown's `key` (section 4 and section 3).
- The seal against a real second machine, ICMP or raw sockets by process, a compromised renderer, and ADR-0060's bridge in CEF (section 6).
