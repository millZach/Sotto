# Native UI bake-off: the Slint half

Built November 18 to 19, 2026, on forge (Omarchy, Hyprland on Wayland, RTX 4060, 16 GB shared with other agents), on `prototype/native-ui-slint` from `61f9e269b`. This is Stage 0 item 1 of [the Rust port plan](../plans/2026-11-14-rust-native-port.md), issue #2689. The GPUI half is built separately on the Windows laptop; I did not look at it. The code is in `native-ui-slint/`, outside npm, and never merges.

Tags: **[m]** measured here, **[d]** read in Slint's documentation or source, **[i]** inferred. "Not verified" is at the end.

## Licence first

Slint 1.19.0 is offered under GPL-3.0-only, the Slint Royalty-free Desktop, Mobile and Web Applications License 2.0, or a paid licence. [d] Sotto is MIT, so the GPL is out, and the royalty-free licence is the one Sotto would ship under. It costs nothing and lets Sotto distribute Slint inside a desktop application on one condition: show Slint's `AboutSlint` widget in an About screen, or put the "Made with Slint" badge on the page Sotto is downloaded from. Two limits apply: it does not cover embedded systems (Sotto is not one), and it forbids shipping an application that exposes Slint's own API (Sotto would not). The licence is not an open-source licence, so a fork of Sotto inherits the same attribution condition for the Slint part. This is not a blocker. It is a condition Zach has to accept, and an About screen or badge Sotto has to carry. Every other crate in the build is permissive; none is GPL-only (below).

## What was built

One window, its own drag strip and window buttons, at 1600x1000, 1280x800 and the 820x560 minimum:

| Part | What it is | Real or stood in |
| --- | --- | --- |
| Theme | `build.rs` reads Sotto's default theme (id `t3-code`) from `src/shared/themes/palettes.ts` and every `--tt-*` derivation from `src/renderer/src/styles/tokens.css`, evaluates `color-mix()`, `oklch()` and `var()` as CSS does (`themegen/css.rs`), and writes a Slint `Theme` global with both halves. A dozen reading-surface colours from `rich-messages.css` and `changes.css` (syntax and diff washes) are copied as the CSS expressions they are. Switching theme is one property. | Real. The night canvas samples `#0e0d0b` in both this build and `artifacts/design/app-review/baseline/threads-populated.png`. [m] |
| Transcript | 200 earlier messages (`content/history.json`, invented, some in Arabic and Urdu), then a 3,899-word reply (`content/reply.md`) streamed from a timer in the app, 20 characters every 16 ms. Headings, nested lists, two tables, inline code, links, six fenced code blocks coloured with syntect, a 191-line diff drawn as a diff (gutters, washes, edges), twelve folding tool-call rows. A virtualised `ListView` follows the stream until the reader scrolls up, then shows Jump to latest. | Real, with the gaps under "What Slint made hard". |
| Composer | `TextInput` with two inline pills (a file and a quoted reply). Backspace deletes a pill whole, the arrow keys step over it, a click inside one snaps to its edge. Attach, Permissions, Model and Effort chips with keyboard menus; one round Send button that becomes Stop while a reply streams. Three variants. | Real. The pill is drawn behind its own label, not a widget in the text (see below). |
| Terminal | `alacritty_terminal` 0.26 runs the user's shell on a real pty; Slint draws the grid as runs of one style each, in Sotto's terminal palette (`tools/terminalView.ts`). Colour, 5,000 lines of scrollback (wheel, Shift+PageUp), mouse selection, Ctrl+Shift+C, resize that reflows. | Real. Paste and the bell are not wired. |
| Web pane | A page painted by another renderer on its own thread (fontdue and a few lines of rasterising), handed to Slint as RGBA frames the way Chromium's off-screen mode hands frames to a host, shown as an image clipped to rounded corners. Keys go to the page while the region has the focus; Tab moves through the page's field and button and then out. | The hosting is real: thread, frame hand-off, rounded clip, focus in and out. The page and its engine are stood in. The page's own accessibility tree is not bridged. The zero-copy path (`BorrowedOpenGLTexture`) was not tried. |
| Reduced motion | Read from GNOME's `enable-animations` (what GTK and Chromium follow on Linux) and watched while running. | Real; see the must-pass row. |

Run it: see `native-ui-slint/README.md`.

## Must-pass rows

Evidence is in `artifacts/native-ui-bake-off-slint/`.

| Row | Result | Evidence |
| --- | --- | --- |
| Orca reads the transcript, composer, chips and folded rows by role and name | **Pass** on forge | [m] `artifacts/native-ui-bake-off-slint/orca-walk.txt`, `atspi-tree.txt` |
| Narrator (Windows) and VoiceOver (macOS) | Not run | [d] same AccessKit tree through `accesskit_windows` 0.35 (UI Automation) and `accesskit_macos` 0.27 (NSAccessibility) |
| The whole screen from the keyboard, focus in eye order, Escape closes what opens | **Pass**, with two gaps | [m] `keyboard-menu.png`, `keyboard-strip.png`, `keyboard-shift-tab.png`, `pill-keys.png`, `orca-walk.txt` |
| Arabic and Urdu right to left, mixed with English, in transcript and composer | **Pass**, with one gap in the composer | [m] `rtl-transcript.png`, `rtl-composer.png`, `rtl-composer-mixed.png` |
| Japanese and Chinese input methods compose, candidate window in place | **Pass** (fcitx5 5 with Mozc and Pinyin) | [m] `ime-japanese.png`, `ime-chinese-candidates.png`, `ime-committed.png`, `ime-events.txt` |
| Native Wayland under Hyprland, at fractional scale | **Pass** (1.25 and 1.5) | [m] `scale-1.5.png`, `xwayland: false` |
| Reduced motion holds | **Pass**, through the app's own reading of the setting | [m] `reduced-motion.txt` |

### Screen reader (Orca 51.1 on forge)

Slint's winit backend publishes an AccessKit tree; on Linux, AccessKit speaks AT-SPI. Orca ran on a private accessibility bus beside the app in a nested Hyprland, and its debug log records what it would say. It said, as focus moved [m]:

- "Sotto: Shelf loses entries after a crash", "landmark Thread", "Composer form", "Message entry holds." (the field, then the word at the caret)
- "Attach a file button", "Permissions, Ask before edits combo box", "Model, Opus 5.5 combo box", "Effort, High combo box", "Send button"; Enter on Permissions: "Permissions List with 3 items", then each item as Down moves; Escape: back on "Permissions, Ask before edits combo box"
- F6 into the transcript: "Transcript List with 9 items", then each row as Up moves: the paragraph's words, "Heading level 2: What I could not check", "Ran git diff --stat main -- src/shelf src/sync, folded. Enter opens it.", "Shell code, 2 lines. Enter copies it. git diff --stat …"
- "landmark Tools", "landmark Browser: Lantern shelf preview", "zach@forge:~ entry. Shell. Tab goes to the shell; F6 leaves the terminal."

What it took: the transcript is a list whose rows each carry a spoken label, with `accessible-delegate-focus` pointing at the row Up and Down move to. Out of the box, Slint exposed the rows as labels inside a list box that Orca announced but did not move through. Gaps, all in this build rather than in Slint's reach:

- Slint has no heading, link, document or article role ([d] `AccessibleRole` in 1.19 has 29 roles, none of them). Headings say "Heading level 2" in their name instead, so Orca's heading navigation (H) will not find them.
- The list is virtualised, so Orca counts the nine rows that exist ("List with 9 items"), not 600. `accessible-item-count` is set, and Orca still counted children.
- Toggling a folded row does not announce the new state; its name says folded or open the next time focus lands on it.
- Every icon and focus scope is an extra unnamed node ("unknown") in the tree. Orca skips them; they are noise for object navigation.
- The web pane's page has no accessibility tree. When Chromium arrives, its tree has to be joined to Slint's, and Slint 1.19 has no API to graft a foreign AccessKit subtree in. That is a wall for this toolkit unless upstream adds it or the web pane stays a separate native window.

### Keyboard

Tab and Shift+Tab walk the strip's buttons, the transcript, its folded rows and Copy buttons, Jump to latest, the composer's text, Attach, the three chips and Send, the browser region and the terminal, in the order the eye reads them. F6 and Shift+F6 move between the four regions; that is how focus leaves the terminal, where Tab belongs to the shell. Escape closes the chip menus and gives focus back to the chip; Left or Escape folds an open tool-call row. Up and Down move through the transcript's rows; Enter opens a folded row or copies a code block. [m]

Gaps: Shift+Tab from the web pane always lands on the page's first control rather than its last ([i] Slint's `focus-gained` does not say which way focus came). And one testing note: Slint 1.19 takes Shift from Shift's own key event, so a tool that only sends modifier state (`wtype -M shift`) is read as plain Tab; a real keyboard, or `wtype -P Shift_L`, works. [m]

### Right to left

Slint lays text out with parley, which finds each paragraph's direction itself. Arabic and Urdu shape and join correctly; mixed lines ("مرحبا، please check الملف crash-after.json قبل الدمج") come out in the right bidi order, with Arabic-Indic digits in place. In the transcript every paragraph is its own element, so an RTL message is right-aligned and an LTR one left-aligned. [m]

The gap is in the composer. Slint's `TextHorizontalAlignment.start` maps to parley's `Left`, not to parley's direction-aware `Start` ([d] `textlayout/sharedparley/layout.rs`), so one text element has one alignment for all its paragraphs. This build right-aligns the composer when its first strong character is RTL. A composer that holds an English paragraph and then an Urdu one shows the Urdu right to left but left-aligned. Upstream, this is a small change, since parley already has the alignment; for Sotto it is a matter of work, not a wall.

### Input methods

fcitx5 5 ran on the nested compositor with Mozc and Pinyin. Slint received `Ime::Enabled`, 21 preedit updates and two commits through winit and Wayland's text-input protocol. "nihongo" composed in place, underlined, and converted; "zhongwen" opened Pinyin's candidate window directly under the composing text, which means Slint reported the caret rectangle correctly. The committed text stayed in the composer, between pills. [m] Not checked: fcitx5's own popup at fractional scale, and IBus.

### Wayland and fractional scale

Every run was a native Wayland client: `hyprctl clients -j` says `xwayland: false`, and the app's own check of its window handle says `RawWindowHandle::Wayland`. At output scales 1.25 and 1.5 the window drew at physical resolution (1,650x1,080 pixels for a 1,100x720 window at 1.5), with crisp text and pills measured in the right place. [m]

### Reduced motion

Slint 1.19 reads the system's motion setting on Windows only; on Linux its desktop-settings reader takes colour scheme, accent, font and cursor blink from the portal, and not the animations switch ([d] `i-slint-backend-winit/xdg_desktop_settings.rs`, `windows_settings.rs`). So this build reads `org.gnome.desktop.interface enable-animations` itself and watches it. With the setting turned off while a reply streamed, the breathing dot of "Writing a reply" held one brightness across six captures (92 of 255 in all six), where with animation it ranged 47 to 92; turned back on, it breathed again (53 to 92). The page in the web pane stops its loading bar and caret blink too. [m] What still moves: Slint's own flick coasting, which this build cannot switch off on Linux, because the app cannot set Slint's internal motion preference through a public API. A one-line upstream change or a public setter would close it.

## Figures, beside Electron

Both apps ran in the same nested Hyprland (B inside A, 1800x1200 output, scale 1, animations off), Wayland-native, the window at 1280x800, three measured runs each, every build and run under one shared lock so neither skewed the other. Electron is Sotto from `origin/main` at `61f9e269b` (0.1.43, Electron 43.8.3), streaming the same reply through Sotto's real Claude adapter over the repo's fake Claude CLI; its 12 tool-call fences arrived as real tool calls. Its full method is in `native-ui-slint/electron-baseline/results.md`.

The load on forge was not the same: the Electron runs saw a 1-minute load average of 12 to 22, the Slint runs 5 to 10. That flatters Slint's tails. The medians differ by more than the load explains.

Slint has two GPU renderers on Linux, and both were measured. Skia over OpenGL is the one to ship; femtovg is lighter and slower to draw text. Slint's default renderer in this build is Skia over Vulkan, where the rendering notifier never fires, so it could not be measured by this method.

| Figure | Slint, Skia GL | Slint, femtovg | Electron | Method |
| --- | --- | --- | --- | --- |
| Frame interval while streaming, median | 16.7 ms | 16.7 ms | 16.7 ms | Slint: time between the ends of consecutive rendered frames (rendering notifier, `AfterRendering`); the animated dot makes Slint draw every vsync during a stream, so this is the analogue of Electron's `requestAnimationFrame` intervals |
| p95 / p99 | 18.1 / 20.7 ms | 23.9 / 31.7 ms | 17.9 / 19.3 ms | same |
| Worst frame | 45.8 ms | 52.6 ms | 99.9 ms | same; Electron's worst is one 73 to 114 ms long task when the diff closes |
| Frames over 33.3 ms | 3 of 1,239 | 9 of 1,279 | 2 of 1,166 | same |
| Render time per frame, median / p99 | 1.1 / 2.8 ms | 1.2 / 14.4 ms | not measured | Slint: `BeforeRendering` to `AfterRendering`, before the buffer swap |
| Typing latency during the stream, median / p95 / max | 2.4 / 3.6 / 8.3 ms | 3.8 / 15.2 / 19.5 ms | 12.3 / 23.3 / 25.7 ms | 58 or 60 keys from `wtype -d 150` into the focused composer while streaming. Slint: winit delivering the key press to the end of the first frame rendered after the text changed. Electron: a capturing keydown listener to a MessageChannel callback posted from the next `requestAnimationFrame`. Neither includes the compositor's presentation |
| Memory 5 s after the stream | 161 MiB PSS, 171 MiB RSS | 130 MiB PSS, 167 MiB RSS | 753 MiB PSS, 1,275 MiB RSS | `/proc/<pid>/smaps_rollup`. Slint: the one process (the shell in its terminal excluded). Electron: all 9 processes (the fake provider excluded; the widget's renderer, about 60 MiB, included) |
| Launch to first frame | 628 ms | 630 ms | 2,163 ms | from a `date +%s%N` taken just before the process starts to the first frame with the 200 messages on screen (Electron: the first rAF after the thread shows its newest words). Median of runs 2 to 6 (Slint) and 1 to 3 (Electron); page cache warm. Electron is the dev build in e2e mode |
| Binary size | 33 MiB, one file, both renderers | | 370 MiB installed (`sotto-bin` 0.1.38) | Slint: the stripped release binary (thin LTO); it links only system libraries (libstdc++, freetype, fontconfig, zlib, libpng, bzip2, brotli, expat) and loads GL and Wayland at run time. Electron: `pacman -Qi` |
| Edit to screen, live reload | 692 ms (692 / 692 / 662) | | 91 ms Vite HMR (91 / 91 / 61) | change the composer card's colour in its source file, then capture a 40x6 region of the card with grim every ~30 ms until it changes. Slint: the `live-preview` feature in a debug build. Resolution about 30 ms |
| Edit to screen, rebuild and relaunch | 10.0 s debug (11.4 / 9.5 / 9.1 / 10.4); 26.9 s release (26.7 / 27.1) | | 42.3 s (`npm run build` and relaunch) | from the file write, through `cargo build` (incremental) and launch, to the first frame |

Every Slint run is in `artifacts/native-ui-bake-off-slint/bench/` (the summary, each run's JSON and raw intervals, and the load average at its start). `native-ui-slint/tools/bench.sh`, `launch.sh`, `edit_poll.py` and `rebuild_time.sh` repeat them.

Where Slint's frames go long: the 191-line diff and the long code blocks are each one `StyledText`, and every chunk that lands in one re-parses and re-lays out the whole block. With femtovg that pushed the render time's p99 to 14 ms. A transcript that splits long blocks into per-line rows would remove it; that is work, not a wall.

## Three composers for design review

- **A, the card**: the baseline's composer. One card, chips and Send inside it under the text.
- **B, the floating card**: a larger corner (the overlay radius), a hairline and a soft shadow, Send inside the card, and the chips in an outlined tray under it with the stream's word count.
- **C, the slim bar**: a pill-shaped bar with Send beside the text, and the chips as plain words in a tray under it.

Edit to screen for each, with live preview, by switching the composer's `variant` in `app.slint`: B 692 ms (two runs, 692 and 692), C 662 ms (662 and 662), back to A 752 to 782 ms. [m] Building them took me one sitting: A first (most of the time went into the pill, below), then B and C as about 60 lines of conditional layout on the same component.

### The link, and Slint in a browser

The composer runs in a browser as Slint compiled to WebAssembly (`native-ui-slint/web/`): the same `composer.slint`, the same pill logic (`src/composer.rs`, included by path) and the same generated theme, with A, B and C and the theme as buttons at the top. It built for `wasm32-unknown-unknown` with Slint's winit backend and femtovg over WebGL, with no change to the composer: 3.8 MB of wasm, 1.5 MB gzipped. [m] It rendered in headless Chromium at 1280x800 and 500x900 (`web-composer-*.png`). Two things needed work in the page, not the composer: Slint sizes the canvas from the window rather than the other way round, so the demo sets its window to the browser's viewport and follows it; and a pill could break at a hyphen, so pill labels now carry a word joiner after each hyphen and slash (the desktop build has the same fix).

What the browser build is not: the whole screen. The terminal needs a pty and the stand-in page a thread, neither of which a browser gives; the transcript would build, but was not tried. It has no accessibility tree: AccessKit is not used on wasm, so a screen reader sees one canvas. Typing on a phone's on-screen keyboard and IME in the browser were not checked by me; that is the first thing to try on the phone.

## Crates and licences

Direct dependencies of the desktop build, all in `native-ui-slint/CRATES.md` with the other 450 they bring in:

| Crate | Version | Licence | Used for |
| --- | --- | --- | --- |
| slint, slint-build | 1.19.0 | GPL-3.0-only OR Slint Royalty-free 2.0 OR Slint Software 3.0 | the toolkit |
| alacritty_terminal | 0.26.0 | Apache-2.0 | the terminal's parser, grid and pty |
| syntect | 5.3.0 | MIT | syntax colour (its bundled grammars carry their own permissive licences) |
| pulldown-cmark | 0.13.6 | MIT | Markdown into blocks |
| fontdue | 0.9.5 | MIT OR Apache-2.0 OR Zlib | the stand-in page's text |
| serde, serde_json | 1 | MIT OR Apache-2.0 | reading the invented history |
| libc | 0.2 | MIT OR Apache-2.0 | the settings watcher dies with the app |
| wasm-bindgen (web demo only) | 0.2.128 | MIT OR Apache-2.0 | the WebAssembly entry point |

Of the 459 crates in the Linux build, 14 are Slint's under its three licences, 27 are ICU's under Unicode-3.0, and the rest are MIT, Apache-2.0, BSD, Zlib, ISC, Unlicense or CC0, alone or as choices. None is GPL-only. [m] Skia itself (inside `skia-bindings`) is BSD-3-Clause. Fonts: Figtree (OFL-1.1, already in the repository); JetBrains Mono is the system's and is not bundled.

## What Slint made easy

- **Accessibility, IME, bidi and Wayland come with the toolkit.** AccessKit, winit's text-input and parley did the work behind four of the six must-pass rows; this build only had to name things well.
- **The theme pipeline.** A Slint global with every token, driven by one `dark` flag, generated at build time from the real CSS. Switching is instant.
- **Selectable styled text.** `StyledText` (new in 1.19's line) parses Markdown, selects, copies and follows links, and takes `<font color>` spans, which carried the syntax colour.
- **Speed and size.** Drawing a frame takes about a millisecond; one process of 130 to 160 MiB; first frame in about 0.6 s; a 33 MiB binary.
- **The language.** Layouts, bindings, `changed` handlers and per-element accessibility properties read well and caught mistakes at compile time (binding loops, wrong property names).

## What Slint made hard

- **Inline widgets in text.** `TextInput` holds only text. The pill is its label in the text between two invisible markers, with a rounded rectangle drawn behind it at a position a hidden twin `TextInput` measures (its `cursor-position-changed` callback reports the caret's pixel position when its selection is set). Backspace, Delete, the arrows and clicks are made atomic in Rust. It works and reads well, including in a screen reader, but it is a workaround: a pill cannot hold a button, wrap differently from its text, or show anything the text cannot.
- **Selection across blocks.** Each `StyledText` selects on its own, and "at most one element shows a mouse selection at a time" ([d] 1.19 docs). Selecting a paragraph, a code block and the next paragraph in one drag, as a browser does, is not possible with the built-in elements. Copy buttons, and Enter on a code row, copy whole blocks (checked with `wl-paste`: the exact two lines of the shell block [m]); whether Ctrl+C copies a mouse selection inside one block I did not check, because the nested desktop had no pointer to drag with. Getting browser-like selection means a transcript that lays text out itself, for which Slint exposes no text-measuring API to Rust. That is the biggest single gap for Sotto's transcript, and it is a wall within the built-in elements.
- **Text styling inside `StyledText`.** No headings, tables, block quotes or images ([d]); no line height (prose sits tighter than Sotto's 1.6); no hanging indent for wrapped list items; whitespace preservation needs tricks (each code line opens with a `<font>` tag so its indentation is not stripped).
- **Renderers.** The default (Skia over Vulkan) gave no rendering notifier, so it could not be measured; femtovg draws text noticeably slower than Skia over OpenGL. Shipping means choosing the renderer explicitly per system.
- **Window chrome** needs the `unstable-winit-030` feature for dragging the window by its strip.
- **Live preview is slower than Vite.** About 0.7 s from save to screen, against 0.09 s, because the interpreter recompiles the whole UI. A full debug rebuild is about 10 s.
- **Gaps the platform leaves to the app:** reduced motion on Linux (above), the clipboard (no public API; this build copies through a hidden `TextInput`), and grafting a foreign accessibility tree (above).

## Not verified

- Narrator, VoiceOver, Windows and macOS at all. Everything above ran on forge only.
- IBus, and fcitx5's popup at fractional scale.
- The real Chromium component in the web pane, its shared-texture path, and its accessibility tree.
- Skia over Vulkan, Slint's default, and the software renderer.
- Memory and frames with a much longer history (thousands of messages), and with several thread panes.
- Terminal paste, mouse reporting to full-screen programs, and the bell.
- Mouse selection inside a block and Ctrl+C; anything else that needs a pointer drag (the nested desktop had none).
- The browser build on a phone: touch, the on-screen keyboard and its IME.
- Electron's figures and Slint's were taken at different load averages (above); the Electron launch is the dev build in e2e mode, and its installed size is an older version (0.1.38).
- My test sessions changed two of the live desktop's settings for a few minutes before I noticed: `dconf-service`, started by the private bus, inherited the real home folder, so `enable-animations` and `screen-reader-enabled` were written to the real user database. Both were reset to their defaults (animations on, screen reader off), and every later run went through `tools/private-session.sh`, which gives the bus daemon itself a private home; the live database was compared before and after the reduced-motion run and was unchanged. `toolkit-accessibility=true` was already set and was left alone.
