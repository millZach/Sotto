# The native UI bake-off: GPUI on Linux

Issue #2689. The GPUI half of the bake-off was built and tested on Zach's Windows 11 laptop ([the Windows note](2026-11-19-native-ui-bake-off-gpui.md)). This note is the same build run on forge (Omarchy, Hyprland 0.56.2 on Wayland, RTX 4060 with NVIDIA 610.57, 16 GB shared with other threads), tested the way [the Slint half](https://github.com/millZach/Sotto/blob/prototype/native-ui-slint/docs/research/2026-11-19-native-ui-bake-off-slint.md) was tested there, so the two can be read side by side on one machine. Everything here ran on November 19, 2026, in a nested Hyprland (B inside A inside the live session) and, for every row that starts a desktop service, on a private D-Bus session with its own home folder. Nothing ran on the live display.

The code is `native-ui-gpui/` on `prototype/native-ui-gpui`. The Linux tools are in `native-ui-gpui/tools/linux/`, the evidence in `artifacts/native-ui-bake-off-gpui/linux/`. Tags: **[m]** measured here, **[d]** read in GPUI's source, **[i]** inferred.

## The short answer

| Must-pass row | Linux (forge) | Evidence |
| --- | --- | --- |
| Orca reads the transcript, composer, chips and folded rows by role and name | **Fail for the transcript's text and for typing; pass for the controls** | `orca-walk.txt`, `orca-reading-commands.txt`, `atspi-tree.txt`, `atspi-events-composer.txt` |
| Keyboard path in eye order, Escape closes what opens | **Pass, after two fixes** found here (both in code Windows shares) | `orca-walk.txt`, `orca-focus-loss-and-shift-tab.txt`, `keyboard-*.png` |
| Arabic and Urdu right to left, transcript and composer | **Pass in the transcript; fail in the composer** (the caret) | `rtl-transcript.png`, `rtl-composer-*.png`, `rtl-caret-steps.png`, `rtl-caret-scan.txt` |
| Japanese and Chinese input methods (fcitx5, Mozc and Pinyin) | **Pass, after one fix** found here | `ime-*.png`, `ime-text-input.txt` |
| Native Wayland under Hyprland at 1.25 and 1.5 | **Pass** | `scale-1.25.png`, `scale-1.5.png`, `scale-protocol.txt` |
| Reduced motion holds | **Pass** | `reduced-motion.txt`, `reduced-motion-on.png` |
| The window: strip drags it, 820x560 with nothing clipped, tiling and floating | **Pass, after one fix** found here | `window-*.png`, `screen-820x560-*.png` |

The figures, beside the Slint note's own (taken on forge in the same nested setup; Electron was not measured again):

| Figure | GPUI, Linux | Slint, Skia GL (Slint note) | Electron (Slint note) |
| --- | --- | --- | --- |
| Frame interval while streaming, median | 16.6 ms | 16.7 ms | 16.7 ms |
| p95 / p99 | 17.6 / 19.6 ms | 18.1 / 20.7 ms | 17.9 / 19.3 ms |
| Worst frame | 24.0 ms (23.5–24.8) | 45.8 ms | 99.9 ms |
| Frames over 33.3 ms | 0 of 1,304–1,309, each run | 3 of 1,239 | 2 of 1,166 |
| UI-thread work per frame, median / p99 | 1.4 / 4.3 ms | 1.1 / 2.8 ms (render) | not measured |
| Typing latency during the stream, median / p95 / max | 1.9 / 3.7 / 4.4 ms | 2.4 / 3.6 / 8.3 ms | 12.3 / 23.3 / 25.7 ms |
| Memory 5 s after the stream | 261 MiB PSS, 300 MiB RSS | 161 MiB PSS, 171 MiB RSS | 753 MiB PSS, 1,275 MiB RSS |
| Launch to first frame | 243 ms (first run 403) | 628 ms | 2,163 ms |
| Binary size, stripped | 33.8 MiB, with or without thin LTO | 33 MiB (thin LTO) | 370 MiB installed |
| Edit to screen, rebuild and relaunch | 3.6–6.0 s debug, 7.6–9.5 s release | 10.0 s debug, 26.9 s release | 42.3 s |
| Edit to screen, live | none (not tried on Linux) | 692 ms live preview | 91 ms Vite |
| Load average (1 min) at the start of each run | 3.8–5.9 | 5–10 | 12–22 |

Each column is a median of three runs unless it says otherwise. GPUI's runs saw a lower load than Slint's; the tails are flattered by that, as the Slint note says of its own against Electron's.

## Building it on Linux

`cargo build --release` works after three changes. First, a plain build would clone Zed's whole repository into `~/.cargo/git`, GPL application crates included. `tools/linux/zed-sparse.sh` instead checks out only the 22 crates GPUI needs (a blob-less partial clone with a sparse checkout, so no other crate's files are on disk), checks each is `Apache-2.0`, and writes a Cargo config that patches the git source to them: `cargo build --release --config ~/.cache/sotto-gpui-zed-patch.toml`. The committed `Cargo.lock` still names the git source; it gains the Linux packages. Second, GPUI's Linux display backends are opt-in: without `gpui_platform`'s `wayland` and `x11` features a Linux build starts headless and never opens a window, with no error [m]. `Cargo.toml` now turns them on; they do nothing on Windows. Third, the Windows-only parts:

- **Reduced motion** reads `org.gnome.desktop.interface enable-animations` through the desktop portal's Settings interface with `ashpd` (already in GPUI's tree), and listens for changes, falling back to `gsettings` when no portal answers (`src/motion.rs`). This is the setting the Slint build reads.
- **The shell** is `$SHELL` on a pty, started in `$HOME` (it was already `$SHELL`; the folder was `USERPROFILE`).
- **The web pane's stand-in page** is drawn in software on its own thread: rectangles and glyphs rasterised by `swash` (already in GPUI's tree) from the app's own Figtree, into a BGRA buffer handed to GPUI as an image with rounded corners, as before. The child-window surface is Win32-only, so on Linux the switch offers the texture alone.
- **Memory** is read from `/proc/self/smaps_rollup` (RSS and PSS); **launch** can be measured from `SOTTO_LAUNCH_T0`; the frame log also records the interval between the ends of frames, the Slint note's clock.

### A dmabuf from a Chromium helper

GPUI on Linux has no way to take a dmabuf, or any GPU texture, without a CPU copy [d]. Its `surface()` element takes only a macOS `CVPixelBuffer` (`elements/surface.rs`), and the wgpu renderer draws nothing for surface batches (`PrimitiveBatch::Surfaces(_) => {}` in `gpui_wgpu/src/wgpu_renderer.rs`). `gpui_linux` uses `zwp_linux_dmabuf_v1` only to find which GPU the compositor runs on. It offers no Wayland subsurface either, so the child-window route has no Linux counterpart. So a page reaches GPUI the way this stand-in does: copied into an image, then uploaded to GPUI's atlas, once per changed frame. A zero-copy path would be new work in `gpui_wgpu`: import the dmabuf as a Vulkan image (`VK_EXT_external_memory_dma_buf`) through wgpu's `create_texture_from_hal`, and give the scene a primitive that draws it. Or it would be new work in `gpui_linux`: a subsurface the helper's buffer is attached to. wgpu enumerates every backend; on forge it loaded the NVIDIA Vulkan libraries and Mesa's EGL [m], and which one it chose was not logged [i].

## The must-pass rows

### Screen reader: fail for the transcript's text and for typing

Orca 51.1 ran on a private accessibility bus beside the app, as in the Slint run, and its debug log was read for what it said. GPUI's AccessKit tree reaches AT-SPI on Wayland and carries the roles and names the Windows note lists. What Orca said, key by key, is in `orca-walk.txt` [m]:

- Start: "Sotto (GPUI)", "landmark Thread: Harbor scheduler", "Composer form", "Message entry Ask for a change, or reply".
- Tab: "Attach a file or quote a reply button", "Permissions: Ask first button"; Enter: "Permissions menu", "Ask first radio menu item selected"; Down: "Allow edits radio menu item not selected"; Escape: back on "Permissions: Ask first button". Then "Model: Sonnet 4.5 button", "Effort: High button", "Stop the reply button".
- On into the tools: "landmark Tools", "landmark Web page", "Show the page as a Texture selected radio button", "Web page (stand-in, texture surface) document frame Stand-in page. Field: empty. Booked 0 times.", "landmark Terminal, bash".
- F6 into the transcript: "Transcript log". Tab: "Ran npm run lint. Collapsed button"; Enter: "Ran npm run lint. Expanded"; Enter: "Ran npm run lint. Collapsed". A folded row announces its new state.

What fails [m]:

- **The transcript's text cannot be reached.** On F6 Orca says "Transcript log" and nothing else. Orca on Hyprland cannot grab its own keys, so its commands were driven through its D-Bus remote control (`org.gnome.Orca1.Service`) with focus on the transcript: structural navigation said "No more headings", "No more paragraphs", "No more tables", "No more list items" and "No more links" (and "Headings: 0 items found"); flat review read only "Sotto (GPUI)"; say all read nothing; object navigation said "No next." (`orca-reading-commands.txt`). The paragraphs, headings, list items and table cells are in the AT-SPI tree with their roles and their text as names, but each offers only the Component interface, no Text (`atspi-interfaces.txt`), and the transcript is a log, not a document. The Windows note's pass was the UI Automation tree, which has the same shape; nobody listened there. [i] This is the build's to fix rather than a wall: the Slint build passed this row by making the transcript's rows focusable list items with spoken labels, and GPUI's folded rows already show that a focusable node is read by name. Giving the text runs a Text interface (AccessKit text runs, as the composer has) is the other way.
- **Typing and the caret are silent.** Typing "check the ledger", then Left, Ctrl+Left and Backspace, Orca said nothing. The app sent `object:text-changed:insert` for each character, twice (the composer is two nested entry nodes, the wrapper that holds focus and the inner element that holds the text), and no `object:text-caret-moved` at all (`atspi-events-composer.txt`). [i] AccessKit raises the caret event for the focused node's text selection, and the selection lives on the inner node, not the focused one; the Windows note describes the same split.
- **Noise.** While the reply streams, the tree changes constantly: in 14 s, 937 `defunct` and 836 name-change events, as rows are rebuilt with each chunk. Orca coped; a screen reader that follows those events would not.

### Keyboard path: pass, after two fixes

The order is right both ways: composer, attach, the chips, send, the page's surface switch, into the page, out to the terminal; F6 and Shift+F6 between the four regions; Shift+Tab back from the composer through the folded rows to the transcript (`orca-walk.txt`). Escape closes a chip's menu onto its chip. As with Slint, `wtype -P Shift_L` reads as a plain Tab; `wtype -M shift` works [m].

Found here, and fixed, both in code Windows runs too [m]:

- **The window went deaf.** Shift+Tab from the composer while the reply streams lands on a folded row; the stream scrolls it out of the virtualised list, its focus handle is dropped, and GPUI then sends keys to the window's root, above every handler, so Tab, F6, Escape and typing all did nothing until a click. Orca said "Sotto (GPUI) frame" and then nothing (`orca-focus-loss-and-shift-tab.txt` shows the fixed build). The fix is GPUI's own hook for this: `on_focus_lost` with `focus_lost_restore_target`, which puts focus back on the transcript. [i] The Windows walk did not hit it, likely because it ran after the stream.
- **Up, Down and Page Up did nothing at the end of the transcript**, streaming or not. GPUI's `ListState::scroll_by` measures from one past the last item when a bottom-aligned list is at its end, so any step shorter than the viewport leaves too little to fill it and the list snaps back [d]. The transcript now scrolls through the scrollbar offset, which is measured from the real top. [i] This is not Linux-specific; the Windows note says the keys scroll, so it may have been checked away from the end.

### Right to left: pass in the transcript, fail in the composer

The Windows failure (DirectWrite placing every glyph left to right) does not happen here. GPUI's Linux text system shapes through cosmic-text, and in the transcript Arabic and Urdu join correctly, paragraphs that start right to left are right-aligned, and the Latin file names and commands inside them keep their own direction: "تم تحديث الملف config/harbor.json بنجاح، ويمكنك الآن تشغيل npm test مرة أخرى." reads in the right order (`rtl-transcript.png`) [m].

In the composer, the mixed line "مرحبا، please check الملف crash-after.json قبل الدمج" and an Urdu line after it are shaped, joined and in the right bidi order (`rtl-composer-mixed.png`, `rtl-composer-urdu.png`), but:

- **The caret is wrong.** Home puts it at the far left of the line; End puts it inside the last Arabic word; at every position between, it is not drawn at all. The same scan on an English line moves the caret smoothly from x 40 to 187 (`rtl-caret-scan.txt`, `rtl-caret-steps.png`) [m]. The cause is in GPUI's core, not its Linux backend [d]: `LineLayout::x_for_index` walks glyphs in visual order and returns the first whose byte index is at least the one asked for, which assumes glyphs are in byte order; bidi shaping breaks that, and `WrappedLineLayout::position_for_index` (what the composer uses) builds on it. Hit testing (`closest_index_for_x`) shares the assumption [i]. Clicks into right-to-left text were not checked.
- **Alignment.** A right-to-left paragraph in the composer stays left-aligned; the composer has no per-paragraph direction, as the Slint composer did not.

Fixing the caret is work in GPUI's line layout: map an index to a caret position through the run's direction, and handle the edges between runs. That is the part the Windows note expected to cost effort; on Linux the shaping is free and the caret is not.

### Input methods: pass, after one fix

fcitx5 5 with Mozc and Pinyin ran in the private session on the nested compositor, as in the Slint run. GPUI talks `zwp_text_input_v3`; "nihongo" composed in place, underlined, converted to 日本語 and then ニホンゴ through Mozc's candidate list, and "zhongwen" opened Pinyin's candidates and committed 中文; the committed text stayed where it was typed (`ime-committed.png`) [m].

Before the fix the candidate window opened at the bottom left of the output, nowhere near the text (`ime-before-fix-candidates-misplaced.png`). GPUI had sent one cursor rectangle, `(40, 1108, 1, 24)`, when the window first appeared tiled at 1800x1200, and never another (`ime-text-input.txt`). On Wayland GPUI only sends the rectangle when the editor calls `window.invalidate_character_coordinates()` [d]; Windows asks for it when a composition starts, which is why the Windows build never needed the call. The composer now makes it whenever its caret moves. After that the rectangle follows the caret, and Mozc's list and Pinyin's row open directly under the composing text (`ime-japanese-candidates.png`, `ime-chinese-candidates.png`), at scale 1 and at 1.5 (`ime-chinese-candidates-scale-1.5.png`) [m].

### Native Wayland and fractional scale: pass

Every run was a Wayland client: `hyprctl clients` says `xwayland: false`. At output scales 1.25 and 1.5 Hyprland sent `wp_fractional_scale_v1.preferred_scale` of 150 and 180 (in 120ths), GPUI drew at 1,375x900 and 1,650x1,080 pixels for a 1,100x720 window and set `wp_viewport.set_destination(1100, 720)`, and text is crisp (`scale-*.png`, `scale-protocol.txt`) [m].

### Reduced motion: pass

In the private session, with `enable-animations` turned off and on while the reply streamed, the app logged `reduced-motion source=portal enable-animations=true`, then each change as the portal announced it. With animation, the composer's caret changed 18 pixels between samples, "Writing a reply" 122 to 321, and the stand-in page's stripe 210 to 228; with motion reduced all three changed 0 pixels in every sample, and the strip said "Reduced motion"; turned back on, all three moved again (`reduced-motion.txt`) [m]. The stream's text changes either way; that is content.

### The window: pass, after one fix

GPUI's Linux backends ignore `WindowControlArea` (the Wayland window's hit-test hook is empty) [d], so dragging the strip did nothing and the window buttons did nothing. On Linux the strip now calls `window.start_window_move()` on a press, and the buttons call `minimize_window`, `zoom_window` and `remove_window`. The Windows path is unchanged. With the repository's nested virtual pointer (`scripts/omarchy-nested-pointer.c`) [m]:

- A drag in the strip moved the floating window by exactly the pointer's travel (0,0 to 200,222).
- Maximise filled the output (1,798x1,198) and a second press restored 1,280x800; Close closed it. Minimise sends `set_minimized`, which Hyprland does not act on. A double press in the strip does not maximise: the first press has already handed the pointer to the compositor's move.
- Asked for 600x400, Hyprland held the window at its 820x560 minimum; at 820x560 nothing clips (`screen-820x560-*.png`).
- Tiled alone, it filled the workspace (1,758x1,158); with a second window, each took 873x1,158 and switched to the narrow layout with Page and Terminal tabs (`window-tiled-two.png`).

### Selection across blocks, which the Windows note left open

This nested session had a pointer, unlike the Slint run's. A drag from a table row across a folded row and two paragraphs selected all of it, and Ctrl+C put it on the Wayland clipboard, read back with `wl-paste`: the row's cells, the folded row's title and both paragraphs (`select-across-blocks.png`, `select-across-blocks-clipboard.txt`) [m]. One gap: the table row highlights only its first cell, though the whole row is copied.

## Figures, with their methods

All in nested Hyprland B at 1,800x1,200, scale 1, Hyprland's animations off, the window floated at 1,280x800, dark theme, release build (`opt-level 3`, line tables, no LTO), every run under the bake-off's shared lock (`~/.cache/sotto-tmp/bakeoff-measure.lock`, the Slint runs' lock), the 1-minute load average recorded at the start of each (`bench/*.load`). Raw figures are in `artifacts/native-ui-bake-off-gpui/linux/bench/`; `tools/linux/bench.sh`, `launch.sh`, `rebuild_time.sh` and `summarize.py` repeat them.

The content is not the Slint build's: each half invented its own conversation. GPUI streams a 4,020-word reply as 20 characters every 16 ms for 20.4 s, behind 200 earlier messages; Slint streamed 3,899 words the same way. Both have headings, lists, two tables, six code blocks, a diff and twelve folded rows.

- **Frame interval while streaming.** The time between the ends of consecutive frames' paint (Slint's clock: `AfterRendering` to `AfterRendering`), over the whole stream. Three runs, at loads 3.8, 4.9 and 5.7: median 16.6 ms in each, p95 17.4–17.7, p99 18.9–20.3, worst 23.5–24.8, none over 33.3 ms, 1,304–1,309 frames. The Windows note's clock, between the starts of frames, gives the same median and a worst of 27.8–39.0 ms, one frame over 33.3 ms in one run. GPUI drew slightly more than one frame per vsync (about 64 a second); [i] keys and the caret add frames between chunks.
- **UI-thread work per frame.** From the start of the root view's render to the end of its paint, before GPUI submits to the GPU: median 1.4–1.6 ms, p95 2.6–3.0, p99 3.5–5.2, worst 20.7–29.3. Slint's figure is render time, `BeforeRendering` to `AfterRendering`; neither includes the GPU or the compositor.
- **Typing latency during the stream.** 60 keys from `wtype -d 150` into the focused composer, four seconds into the stream, as in the Slint runs; 58 reached the composer as separate frames each run. From the composer receiving the key to the end of the paint of the first frame that includes it: median 1.9–2.0 ms, p95 3.3–3.7, max 3.5–4.8. Slint's figure starts when winit delivers the key, a little earlier in the path.
- **Memory.** `/proc/self/smaps_rollup` five seconds after the stream ends: PSS 257–262 MiB, RSS 299–300 MiB, the one process (the terminal's shell is its own process and is not counted, as in the Slint runs). At rest before any stream, PSS is about 197 MiB: about 107 MiB anonymous and 90 MiB file-backed; the NVIDIA and Mesa driver libraries and the NVIDIA device mappings come to about 60 MiB, the binary to 25 MiB, the heap to 23 MiB (`bench/smaps-idle.txt`).
- **Launch to first frame.** From `date +%s%N` taken just before the process starts to the end of the first paint, six runs: 403 ms (first) then 225–256, median of runs 2 to 6 243 ms. Captured from outside, the first frame that reaches the screen already shows the 200 messages: a capture started at 283 ms is blank, one at 356 ms shows the whole screen, with the first paint logged at 291 ms [m].
- **Binary size.** The release binary stripped: 33.8 MiB, no LTO (the profile the Windows note used; its Windows exe is 16.1 MB). It links only libc, libm, libgcc, libxcb and libxkbcommon, and loads Wayland, Vulkan and GL at run time. With thin LTO it is the same (below).
- **Edit to screen.** Change the strip's colour in `src/main.rs`, run the incremental `cargo build`, relaunch, to the end of the first paint (`rebuild_time.sh`, two runs of two edits each). Release: 7.6–9.5 s (build 7.3–9.2 s), at a load of 5.6. Debug: 3.6–6.0 s (build 2.4–5.4 s), at 4.0. GPUI's hot reload (Subsecond through `dx serve --hot-patch`) crashed on Windows and was not tried here; it would have meant installing `dx`.

### Thin LTO

Built again with `CARGO_PROFILE_RELEASE_LTO=thin` in its own target folder (1 min 58 s with the dependencies already compiled elsewhere): stripped, 35,449,944 bytes against 35,424,224 without, so 33.8 MiB either way [m]. It launched the same (four runs: 567 ms cold, then 205–261 ms).

## What was easy and hard on Linux

Easy:

- Right to left shaping, joining and bidi order, which failed on Windows, came with the Linux text system.
- Fractional scale and native Wayland needed nothing.
- fcitx5's composition and the in-place underline worked once the composer said where its caret was.
- AccessKit's tree reached AT-SPI and Orca without any Linux-specific code, and the controls read well.
- The figures: one frame per vsync through the stream with no frame over 33 ms, a 2 ms keypress to paint, and a first frame with 200 messages in a quarter of a second.

Hard, or found broken:

- GPUI's Linux backends are off by default; a missing feature gives a headless app with no error.
- GPUI on Wayland leaves to the app what Windows does for it: moving the window from the strip, the window buttons, and telling the input method where the caret is.
- The caret in right-to-left text is a GPUI core problem, now visible because the shaping works.
- Two keyboard traps that are platform-independent: focus dropped with a virtualised row, and `scroll_by` at the bottom of a list.
- A screen reader can reach the controls but not the transcript's text, and hears nothing while typing.
- No dmabuf or texture import, and no subsurface, for the web pane.
- Memory: 261 MiB PSS against Slint's 161 MiB on the same machine; nearly a third of it at rest is the graphics drivers.

Lines for other parts of the port:

- The Chromium web pane will need zero-copy texture import (or a subsurface) added to GPUI on Linux; the Windows note found the same gap for D3D textures.
- A Rust transcript should expose its text runs through AccessKit's text interfaces, on every platform, not names alone.
- GPUI's `x_for_index` and `closest_index_for_x` need to be bidi-aware before any right-to-left editing ships, on Linux and macOS alike.

## What was not verified

- Orca's own key commands (Hyprland gives Orca no key grab); they were driven over Orca's D-Bus remote control instead. Nobody listened to the speech; its debug log was read.
- IBus. The X11 backend and XWayland.
- Clicks into right-to-left text, and right to left with pills in the composer.
- The real Chromium component in the web pane, and any zero-copy path.
- Which wgpu backend GPUI chose on forge (Vulkan or GL).
- GPUI's hot reload on Linux.
- Frame timing at the GPU and the compositor; typing to photons.
- Long sessions, thousands of messages, several panes.
- The Windows build after these changes. Every change outside `cfg(not(windows))` was checked only by building and running on Linux; the Windows thread should rebuild once.

## Left on forge

Nothing was installed with pacman. Every process started here was stopped and the nested compositors were removed. Build output is in `~/.cache/sotto-cargo-target-gpui` and `~/.cache/sotto-cargo-target-gpui-lto`, the sparse Zed checkout and its patch file in `~/.cache/sotto-gpui-zed` and `~/.cache/sotto-gpui-zed-patch.toml`, scratch files in `~/.cache/sotto-tmp/gpui-linux`. The live dconf database was compared before the first session and after the last: the same file, unchanged since 07:43 that morning, and the same `dconf dump /` (`dconf-check.txt`).
