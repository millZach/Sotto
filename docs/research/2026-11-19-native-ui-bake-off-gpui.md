# The native UI bake-off: GPUI

Issue #2689, Stage 0 item 1 of [the Rust port plan](../plans/2026-11-14-rust-native-port.md). This is the GPUI half: the hard screen built in GPUI on Zach's Windows 11 laptop, tested against the must-pass rows, and measured beside today's Electron Sotto the same way. The Slint half is a separate build and was not looked at. Everything here was run on November 18 and 19, 2026, on the laptop (24 logical CPUs, 32 GB, RTX 5070 laptop GPU with Intel graphics driving the panel, a 2560x1600 display at 150% and 60 Hz). Other Sotto threads and Zach's Sotto Owl were running throughout, as they would be in use.

The code is in `native-ui-gpui/` on `prototype/native-ui-gpui`, a Cargo workspace of its own outside npm. It never merges. Captures are in `artifacts/native-ui-bake-off-gpui/`, raw figures in `native-ui-gpui/measurements/`.

## The short answer

| Must-pass row | Windows (run here) | Evidence |
| --- | --- | --- |
| Screen reader reads it by role and name | **Pass** for the UI Automation tree Narrator reads; not listened to | UIA tree and focus walk below |
| Keyboard path, eye order, Escape closes | **Pass** | Tab walk read through UIA |
| Arabic and Urdu right to left | **Fail** | Glyphs reversed and unjoined, transcript and composer |
| Japanese and Chinese IME in the composer | **Not verified** | Could not switch an IME on by automation, even in a plain WinForms box |
| Hyprland on Wayland | Not run (source only) | Wayland backend present |
| Reduced motion holds | **Pass** | System setting read; motion stops |

| Figure | GPUI | Electron Sotto 0.1.44 source (Electron 43.8, Chrome 150) |
| --- | --- | --- |
| Frame interval while streaming (median / p95 / p99 / worst) | 16.7 / 18.2 / 18.7–18.8 / 19.4–19.6 ms | 16.7 / 16.8 / 16.9–17.0 / 83.3–83.7 ms |
| Frames over 33 ms in a 20.4 s stream | 0 | 2–3, plus 1–2 long animation frames of 97–114 ms |
| UI-thread work per frame (median / p99 / worst) | 2.1–2.3 / 3.5–5.1 / 4.5–7.7 ms | no equivalent (see method) |
| Keypress to pixels while streaming (median / p95 / worst) | 33.4–33.5 / 34.3–34.5 / 35.5–36.0 ms | 33.4–34.5 / 34.7–51.0 / 51.7–66.9 ms |
| Memory 3 s after the stream (working set / private) | 380 / 322 MB, 4 processes (app alone 276–287 / 253–264 MB) | 1,245–1,259 / 998–1,012 MB, 6 processes |
| Launch to first painted frame (median of 5) | 473 ms (413–627) | 1,737 ms (1,463–3,988, first run cold) |
| Binary size | 16.1 MB, one exe, fonts inside | 443 MB installed (`Sotto.exe` 229 MB); `out/` 45.5 MiB |
| Save to screen, CSS-like look change | 8.7–13.7 s (release rebuild + relaunch), 5.8–7.5 s debug | 33–66 ms (Vite hot update) |
| Save to screen, component change | same as above | not seen: Vite asks for a page reload, the window never showed it |
| GPUI hot reload (`dx serve --hot-patch`) | patch applied in 1.8–2.0 s, then the app crashed (stack overflow) both times | n/a |

My view, in three lines, is at the end.

## What was built

One window, 1600x1000 by default, 820x560 minimum, resizable, under Sotto's thin strip:

- **The strip.** Sotto's mark, the thread's name and project, a segmented switch for the three composer variants, the theme switch (Light/Dark), and the window's own minimise, maximise and close, drawn by the app. The rest of the strip drags the window (GPUI's `WindowControlArea`, which answers Windows' hit test, so snap layouts and double-click to maximise work). When reduced motion is on, the strip says so.
- **The thread pane.** 200 invented earlier messages, the last ask, then one reply of 4,020 words streamed as 20-character chunks every 16 ms from a generator thread on its own schedule (chunk *i* is due at start + 16·*i* ms, as a provider would send it). The reply has headings, nested lists to three levels, two tables (one with right-aligned numbers), inline code, links, six fenced code blocks with syntax colour (two TypeScript, two Rust, JSON, shell), a 199-line unified diff drawn as a diff (added and removed lines washed and edged in Sotto's own diff colours), and twelve activity rows that open and close. It is a virtualised GPUI `list`: one row per earlier message and one per block of the reply, so a chunk re-lays only the block it lands in. The pane follows the stream until you scroll up, then offers **Jump to latest**.
- **Selection across blocks.** GPUI has no selection across elements, so the transcript has its own: every run of text knows its place in reading order, a drag runs from one run to another across blocks and messages, and Ctrl+C copies the model's text (a table copies cells, a diff its lines). Ctrl+A selects the whole transcript.
- **The composer.** Multi-line editing on GPUI's `EntityInputHandler` (the interface the Windows IME, macOS input methods and Wayland's text-input talk to), with inline pills: an attached file and a quoted reply sit in the text, the arrows step over them, Backspace and Delete remove them whole, a click inside lands at the nearer edge, and they copy as their labels. Under it, attach, permissions, model and effort chips, each opening a menu (arrows move, Enter chooses, Escape closes back onto the chip), and one round send button that becomes stop while the reply streams. Enter sends, Shift+Enter starts a line. Sending adds the message and streams the reply again.
- **The terminal.** The user's shell on a real pseudo-terminal (ConPTY), through `alacritty_terminal`, drawn natively by GPUI: the shell Sotto picks today (`pwsh.exe` if on PATH, else Windows PowerShell), Sotto's own ANSI palettes for each mode, 10,000 lines of scrollback (wheel, Shift+PageUp/PageDown), mouse selection (double-click a word, triple a line) with Ctrl+Shift+C and Ctrl+Shift+V, bracketed paste, and a resize that reflows. Tab and Escape go to the shell; Ctrl+Tab or F6 leaves.
- **Two themes.** Sotto's default theme in both modes, generated at build time from the real `--theme-*` roles in `src/renderer/src/styles/tokens.css` (`build.rs`), with the `--tt-*` tokens derived in `src/theme.rs` the way `tokens.css` derives them, the Sotto theme's own dark and light blocks included (the warm room by night, the 7% card and 4% composer by day). The switch is live. A unit test checks 20 inks on their surfaces in both modes: the lowest is 4.64:1 (the composer's hint by day), and all 40 pairs are in `measurements/contrast.txt`.
- **The web pane region.** A rounded rectangle in the Tools column holding a stand-in page drawn by another renderer, two ways (below). At under 1,100 px wide the Tools column becomes Page and Terminal tabs.
- **Reduced motion.** Read from Windows' "Animation effects" every second (below).

Fonts are Sotto's own: Figtree and Spline Sans Mono, turned from the app's WOFF2 files into static TTF instances (`tools/make_fonts.py`) and embedded in the exe.

Captures: `screen-1600x1000-dark.png`, `screen-1600x1000-light.png`, `screen-1280x800-*.png`, `screen-820x560-*.png` and the composer variants `composer-{A,B,C}-{dark,light}.png` in `artifacts/native-ui-bake-off-gpui/`. Nothing overflows or clips at 820x560: code blocks and tables scroll sideways inside themselves, as in Electron.

## Crates and licences

GPUI comes from Zed's repository at `4e161e70b5c02b0f63a50beb6937f9cd249c1678` (main on November 19). Only Zed's Apache-2.0 GPUI crates are used, and only they were read: the source was checked out sparsely (`crates/gpui*` and the few Apache-2.0 crates they need), so no GPL application crate (`editor`, `markdown`, `terminal`, `terminal_view`, `ui`, …) was even on disk. Longbridge's `gpui-component` (Apache-2.0) was considered and not used: version 0.10 depends on `gpui-pre` 0.3.12, a republished GPUI snapshot that predates upstream's accessibility work, and two GPUIs cannot share a window.

| Crate | Licence | For |
| --- | --- | --- |
| `gpui`, `gpui_platform`, `gpui_windows`, `gpui_macros`, `gpui_util`, `gpui_shared_string`, and Zed's `collections`, `refineable`, `sum_tree`, `scheduler`, `http_client`, `util` | Apache-2.0 | The toolkit |
| `accesskit`, `accesskit_windows` (via GPUI) | MIT OR Apache-2.0 | Screen readers |
| `taffy` (via GPUI) | MIT | Layout |
| `alacritty_terminal` 0.26, `vte` | Apache-2.0; Apache-2.0 OR MIT | Terminal state and parser, ConPTY |
| `pulldown-cmark` 0.13 | MIT | Markdown |
| `syntect` 5.3 with `fancy-regex` | MIT | Syntax colour |
| `two-face` 0.5 | MIT OR Apache-2.0 | TypeScript and other grammars, from bat |
| `windows` 0.62 | MIT OR Apache-2.0 | Win32 for reduced motion, the child window, GDI, the IME test |
| `image`, `smallvec`, `async-channel`, `unicode-segmentation`, `raw-window-handle` | MIT OR Apache-2.0 (raw-window-handle also Zlib) | Plumbing |
| Figtree, Spline Sans Mono | SIL OFL 1.1 | Fonts, as in the Electron app |

All 402 crates in the Windows build: 191 MIT OR Apache-2.0, 67 MIT, 37 Apache-2.0 OR MIT, 22 Unicode-3.0, 20 Apache-2.0, and smaller counts of BSD-2/3, Zlib, Unlicense OR MIT, CC0 and 0BSD combinations, one Apache-2.0 OR BSL-1.0. None is GPL; the only non-permissive entry is the prototype itself. `two-face`'s grammars come from bat's set of Sublime syntaxes, which carry their own (permissive) licences; a release would list them. Tools used but not linked: `dx` 0.7.10 (Dioxus CLI, MIT OR Apache-2.0, prebuilt, checksum checked) for the hot-reload test, and Python's fontTools for the fonts.

## The must-pass rows

### Screen reader: pass in the tree Narrator reads; not listened to

The November 14 search was out of date. Upstream GPUI has had AccessKit since May 2026 (zed-industries/zed#56065, "gpui: Accesskit support"), with landmarks and menus in July (#60397), accessibility identifiers in August (#61926) and an adapter fix on macOS in September (#64143). It is on by default (`Application::inaccessible()` opts out). An element joins the tree when it has an id and a role; divs take `.role()`, `.aria_label()`, `.aria_expanded()`, `.aria_toggled()`, `.aria_level()`, `.aria_value()` and the rest; custom elements return a role and can add synthetic children such as text runs; `aria_active_descendant` covers menus. One open upstream PR is relevant: #66631, "gpui_windows: Report window focus to AccessKit when activated without WM_ACTIVATE".

What was done: every part of the screen has a role and a name. The transcript is a Log; each message an Article named by its author and time; paragraphs, headings (with levels), list items, code (named by language), table cells (rows, column headers) and diff lines carry their text as their name; an activity row is a Button named by its title and "Collapsed" or "Expanded", with its expanded state; the composer is a MultilineTextInput named Message with its value, hint and a text run with the caret; chips are Buttons named by what they say ("Permissions: Ask first") with their expanded state; menus are Menus of MenuItemRadio with the checked one toggled; the strip's controls, the surface switch and the tool tabs have roles; the terminal is a Terminal whose description is its visible text; the web pane is a Document.

How it was checked: `tools/uia.ps1` reads the window through Windows UI Automation, the interface Narrator reads. The tree came back as built, for example:

```
Window 'Sotto (GPUI)'
  Pane 'Sotto'  (the strip: Composer variant A/B/C, Switch to the light theme, Minimize, Maximize, Close)
  Group 'Thread: Harbor scheduler'
    Group 'Transcript'
      Text 'Rust code: /// One line in the ledger for every hand-off between two workers. …'
      Button 'Edited config/harbor.json. Collapsed' expand=Collapsed
      Group 'The dock ledger treats a missing manifest as an error the user can fix, …'
      StatusBar 'Writing a reply'
    Group 'Composer'
      Edit 'Message' [TextPattern]
      Button 'Attach a file or quote a reply' expand=Collapsed
      Button 'Permissions: Ask first' expand=Collapsed
      Button 'Model: Sonnet 4.5' expand=Collapsed
      Button 'Effort: High' expand=Collapsed
      Button 'Stop the reply'
  Group 'Tools'
    Group 'Web page' / RadioButton 'Show the page as a Texture' / Document 'Web page (stand-in, texture surface)'
    Group 'Terminal, powershell' / Document 'Terminal output'
```

UIA's reported focus followed every keyboard step (next section), and the composer's value updated as text and pills changed (`Edit 'Message' value='see “Every berth is full…” now'`, then `'see  now'` after one Backspace on the pill).

Two GPUI behaviours to know: a custom element cannot hold focus itself, so UIA reports focus on the div that tracks the focus handle; the composer's wrapper therefore carries the edit's role, name and value (and the inner element keeps the TextPattern and caret). And the list is virtualised, so only rows on screen are in the tree, as in a virtualised web list.

Not done: nobody listened to Narrator. That is the one step for Zach (below). VoiceOver: GPUI's macOS backend wraps `accesskit_macos`'s subclassing adapter; not run. Orca: the Linux backend creates an `accesskit_unix` adapter (AT-SPI) on both Wayland and X11; not run.

### Keyboard path: pass

Tab walks the screen in the order the eye moves, read back through UIA after each press: the strip's variant switch and theme button, the transcript (arrows, Page Up/Down, Home, End scroll it), the activity rows on screen, Jump to latest when shown, the composer's text, attach, permissions, model, effort, send, the page's surface switch, into the page (its field, then its button) and out to the terminal. Shift+Tab goes back. In the terminal, Tab and Escape belong to the shell, so Ctrl+Tab / Ctrl+Shift+Tab or F6 / Shift+F6 move between the four regions (transcript, composer, page, terminal) from anywhere. Enter or Space on a chip opens its menu with focus on the current choice; arrows move; Enter chooses; Escape closes the menu and returns focus to its chip (checked through UIA: `RadioButton 'Ask first'` → Escape → `Button 'Permissions: Ask first'`). Enter or Space opens and closes an activity row. Focus rings appear only for keyboard focus. New shortcuts were checked against the dictation hotkey (Ctrl+Shift+Space): Ctrl+Shift+L for the theme, Alt+1/2/3 for the variants, Ctrl+Shift+R to stream again.

What GPUI asked for: a focusable element that tracks a handle created by its view is only a tab stop when the handle says so (`cx.focus_handle().tab_stop(true)`); without it the transcript, composer, chips, page and terminal were silently skipped. And GPUI dispatches key bindings before key-down listeners, so a terminal or page that wants Tab needs bindings in its own key context (the more specific context wins), not a listener.

### Arabic and Urdu right to left: fail on Windows

In both the transcript and the composer, Arabic and Urdu come out with each run's letters in reverse order and partly unjoined, and a paragraph starting in Arabic is laid out left to right (captures: `rtl-transcript.png`, `rtl-composer.png`). Right-aligning the paragraph, which the transcript does for text whose first strong letter is right to left, does not help.

Cause, in `crates/gpui_windows/src/direct_write.rs`: GPUI lays a line out with DirectWrite's `CreateTextLayout`, which does the bidirectional analysis, but its `DrawGlyphRun` callback ignores the run's `bidiLevel` and the `baselineOriginX` DirectWrite passes, and places every glyph left to right by adding up advances. Nothing sets a paragraph's reading direction either. GPUI's core is partly ready (its line code notes that "bidirectional shaping can put glyphs out of byte order", and wrapping has a right-to-left test), and the Linux text system (cosmic-text, with `unicode-bidi`) and the macOS one (CoreText) do bidirectional layout themselves.

Wall or work: work, in Apache-2.0 code Sotto could patch or upstream: place right-to-left runs from DirectWrite's origin leftwards, expose a paragraph direction, and check caret movement, hit testing and wrapping across direction changes. That last part is where the effort is. Not tried here. Linux and macOS: not run, and the source suggests they lay out correctly; that needs checking on the Mac and on forge.

### Japanese and Chinese input methods: not verified

GPUI's Windows backend handles `WM_IME_STARTCOMPOSITION` and `WM_IME_COMPOSITION`, places the composition and candidate windows with `ImmSetCompositionWindow` and `ImmSetCandidateWindow` from the editor's `bounds_for_range`, and marks the composed text; the composer implements all of `EntityInputHandler` (marked text, replace-and-mark, bounds for a range), the same path GPUI's own input example uses.

Under automation it could not be tried. I added the built-in Japanese (Microsoft IME) and Chinese (Microsoft Pinyin) input methods, switched the window's language (it reported layout `0x04110411`) and sent keys with `SendInput`; the keys arrived as romaji. The same sequence did the same in a plain WinForms text box, so it was my harness, not GPUI. Having the app switch the IME on for itself (`SOTTO_GPUI_IME=ja`, which calls `ImmSetOpenStatus`) showed the IME open at 0.8 s and closed again by 5 s with no input at all: GPUI re-associates the window's input context whenever its text-input state changes (`update_ime_enabled`, on every paint), which drops an open state set from outside. A user switches the IME on with a key while the composer has focus, which this does not test. The language list was put back to English (US) only afterwards.

So this row is the one hand test that needs Zach: steps below.

### Hyprland on Wayland: not run (source only)

`gpui_linux` builds a Wayland client by default (alongside X11) with `xdg_decoration` (and client-side decorations), `wp_fractional_scale`, `wp_viewporter`, `xdg_activation`, `wp_cursor_shape`, primary selection, `zwlr_layer_shell` (layer-shell surfaces), `org_kde_kwin_blur`, `zwp_text_input_v3` for input methods, and AccessKit over AT-SPI. It renders through `gpui_wgpu` (wgpu). The prototype's Windows-only parts would need Linux equivalents: reduced motion (the portal's `enable-animations`), the shell (`$SHELL`, already handled), and the web pane surfaces. Not built or run on forge.

### Reduced motion: pass

GPUI has `App::set_reduce_motion`, which its own animations, animated images and SVGs honour, but no platform reads the system setting, so the app does: Windows' "Animation effects" (`SPI_GETCLIENTAREAANIMATION`, the setting Chromium maps `prefers-reduced-motion` to), every second. With it off, the composer's caret stops blinking, the streaming caret stops pulsing, "Writing a reply" stops breathing, and the stand-in page's live stripe stops, and the strip shows "Reduced motion". Checked by turning the setting off and on (`tools/motion.ps1`, restored afterwards): UIA showed `StatusBar 'Reduced motion is on'` within a second, and over three 230 ms intervals the composer's caret row changed 54 pixels with motion on and 0 with it off. The stream's own text changes either way; that is content, not motion. macOS (`NSWorkspace.accessibilityDisplayShouldReduceMotion`) and Linux are not wired.

## The web pane region: what is real and what is stood in

Stood in: the page. It is drawn by Windows GDI on its own thread (a heading, a field, a button, and a stripe that moves twice a second so a stale frame shows), not by Chromium. Real: the hosting. Two ways, the two ways CEF can embed on Windows, switched live in the pane's header:

- **Texture (works).** The other renderer hands GPUI a BGRA frame, as CEF's off-screen rendering does; GPUI draws it as an image with 10 px rounded, anti-aliased corners. Keys and clicks are forwarded to the page. Tab walks into the page's field, then its button, then out to the terminal; Shift+Tab out the other way, as CEF's `OnTakeFocus` does. The cost is a CPU copy and an atlas upload per changed frame (old frames are dropped from the atlas); GPUI has no API to take a shared D3D texture, so CEF's accelerated paint path would need work in `gpui_windows`.
- **Child window (fails to show).** A real Win32 child window at the pane's rectangle with a rounded window region (GDI regions are not anti-aliased). Focus works through it: Tab gives it keyboard focus (UIA reports `Pane 'Stand-in page'`), typing reaches it, Enter presses its button, and Tab leaves to the terminal. But it never appears (capture: `web-pane-child-window-hidden.png`): GPUI's window uses DirectComposition with `WS_EX_NOREDIRECTIONBITMAP`, so there is no redirection surface for a GDI child to draw into, and with `GPUI_DISABLE_DIRECT_COMPOSITION=1` GPUI's flip-model swap chain still covers it. The child was confirmed visible and correctly placed (`visible=True`, at the page's rectangle). Chromium's own child windows present through DirectComposition themselves, so they may well show where GDI does not; that is for the web pane spike to find out, and is the first thing it should check on Windows.

## Figures, with their methods

All on the release build (`opt-level 3`, line tables only), dark theme, 1600x1000 at 150%, after the machine had settled (about 7% CPU, 10 GB free; other Sotto threads and Zach's Sotto Owl running).

The Electron side is today's Sotto built from this branch's `main` (`npm run build`), launched by `native-ui-gpui/electron-baseline/measure.mjs` with Playwright through the e2e support (`SOTTO_E2E=1`, scenario `success`, its own profile), the window at 1600x1000, dark. It loads the same 200 messages and last ask (`sotto-gpui --dump-content` writes them) as history into one thread and streams the same reply text through the e2e `stream` event, 20 characters every 16 ms on the same schedule. What differs: each update goes from the renderer over IPC to main's e2e fake provider (`src/main/e2e/agentEffects.ts`), through the coordinator and back, so main and IPC are included and only the provider adapter and its child process are skipped; each update carries the whole reply so far (that is the event's shape); the generator runs on the renderer's own timers; Playwright's debugging connection is attached; Electron's window also has a sidebar the GPUI screen does not; the ```` ```activity ```` blocks render as ordinary code blocks labelled "activity" (Electron has no folding for them); the diff is a code block while it streams and becomes Sotto's diff view when its fence closes. The GPUI screen has a live terminal (with its shell) and the stand-in page; Electron's has neither open. The Electron reply is 25,502 characters after JSON round-tripping, GPUI's 25,705 bytes (the same text; Arabic, Urdu and CJK are multibyte).

**Frame time while streaming.** GPUI: the app logs every frame (`src/metrics.rs`): the interval is the time between the starts of consecutive root renders, and the work is the time from the start of the root render to the end of its paint (the last element painted marks it), CPU on the UI thread before GPUI submits to the GPU. Over the whole 20.4 s stream, three runs. GPUI only draws when something changed, and a chunk changes something every 16 ms, so it drew 1,224 frames in each run, one per vsync. Electron: the harness's `requestAnimationFrame` loop over the stream; rAF fires on every vsync whether or not anything changed and reports the frame's begin time, which is why its median and p95 sit at exactly 16.7 and 16.8 ms. So the two interval columns are not identical clocks: GPUI's is measured where its work starts, Chromium's at vsync. The fair comparison is the tail. GPUI's worst frame in three runs was 19.6 ms; Electron had 2–3 frames over 33 ms and 1–2 long animation frames (`PerformanceObserver` `long-animation-frame`) of 97–114 ms each run, with 47–52 ms of it blocking. Electron has no counterpart of GPUI's per-frame work figure.

Before two fixes, GPUI also had long frames (141–180 ms, then 70–80 ms). They were not the toolkit: the first was syntect compiling each grammar the first time a block of that language appeared, and the second was re-colouring a growing TypeScript block on every chunk, which takes bat's TypeScript grammar up to 74 ms. Colouring now runs on a worker thread and a growing block draws with the colour of its last finished version until the new colour lands; the grammars warm up at start. Both are the obvious design. The runs before the fixes are described here, not kept; the three runs after are in `measurements/`.

**Typing latency while streaming.** The same outside method for both (`tools/probe.rs type`): click the composer, then for each of 40 keys, read a band of screen pixels around the caret row through GDI `BitBlt` (the composed desktop), send the key with `SendInput`, and poll the band until it changes; 80–150 ms between keys; two runs of 40 each, while the reply streams in a loop (`SOTTO_GPUI_LOOP=1`; the harness's `--hold`). The caret's blink would trip the check, so it was off in both: GPUI by its reduced-motion switch, Electron by setting Windows' caret blink to none (restored to 530 ms afterwards). This includes DWM composition and the probe's poll (about 1 ms), so it is keypress to pixels on screen, not to photons. GPUI: median 33.4–33.5 ms, p95 34.3–34.5, worst 35.5–36.0 (160 keys and backspaces). Electron: median 33.4–34.5, p95 34.7–51.0, worst 51.7–66.9. Both sit at two frames on this 60 Hz panel; GPUI's tail is tighter. Inside GPUI, a key reaches the end of a painted frame in a median 1.9 ms (p95 3.1, worst 3.9), so nearly all of the 33 ms is presentation and composition. The probe found a real bug on the way: clicking an empty composer mapped the click through the hint's layout and crashed on the next key; fixed.

**Memory after the stream.** Three seconds after the stream ends, working set and private bytes summed over the process and all its descendants (`probe mem --tree`, `GetProcessMemoryInfo`). GPUI: 373–388 MB working set, 316–330 MB private, 4 processes, of which the app alone is 276–287 MB and 253–264 MB (the rest is the terminal's PowerShell and its console host). Electron: 1,245–1,259 MB and 998–1,012 MB over 6 processes (browser 325–331 MB, GPU 279–287, the window's renderer 423–430, the floating widget's renderer 150–152, a utility process 55, and the harness's `cmd` wrapper), with no shell running.

**Launch to first frame.** The same outside method (`probe launch`): start the process with `CreateProcessW`, find its own window by title and process id, and poll the window's pixels every 2 ms; the frame is painted when at least 0.5% of every-fourth-pixel samples differ by more than 24 levels from the window's most common colour (text alone passes, a blank fill does not). Five runs each. GPUI shows the whole screen, 200 messages and all, in its first frame: 413–627 ms, median 473. Electron through the plain launch command the harness prints (the same build and profile, no Playwright): 1,463–3,988 ms, median 1,737, the first run cold. GPUI's own log puts its first paint at 409–571 ms after `main` starts.

**Binary size.** GPUI: `sotto-gpui.exe` is 16,090,624 bytes, the whole app with both fonts, all grammars and the terminal; nothing else ships. Electron: Sotto 0.1.44 as installed in `C:\Program Files\Sotto` is 443.4 MB (`Sotto.exe` 228.5 MB, `resources` 82.4 MB of which `app.asar` 51.8 MB, `locales` 46.6 MB, `dxcompiler.dll` 24.4 MB); the built JavaScript in `out/` is 45.5 MiB.

**Edit to screen.** GPUI without hot reload (`tools/edit-to-screen.ps1`): write the edit, run the incremental `cargo build`, relaunch, and time to the first painted frame (`probe launch`); the app's state is lost each time. Release, warm: 8.7–10.2 s for most one-line changes in `main.rs` (build 7.7–9.4 s, then about 1 s to paint), and 13.1–13.7 s for two others in the same file (the build took 12–13 s; the reason was not looked into); the first edit after other work took 26.1 s. Debug, warm: 5.8–7.5 s (build 4.1–5.8 s, launch 1.6–1.7 s). GPUI's hot reload (`hot-reload` feature, debug only, through Dioxus's Subsecond with `dx serve --hot-patch`, 0.7.10): the first fat build took 114 s (13 s when cached); `dx` applied each patch in 1.8–2.0 s, and the app then crashed with a stack overflow (`0xc000041d`) both times, also with a 16 MB main stack (checked in the exe's header), so it is not the default 1 MB. Not usable on Windows today; not investigated further. Electron through `npm run dev` (electron-vite, the same e2e profile), timed with `probe watch`, which writes the edit and polls the screen: a CSS edit (an outline on the composer) reached the screen in 33–66 ms. An edit to `ThreadComposer.tsx` (its hint text, then an inline style) made Vite log a full page reload each time, and the window did not change within 30 s in any of six tries; Sotto's window most likely refuses the reload navigation, so a component edit needs a restart, which was not timed.

**For design review.** The three composer variants and the time from an edit to each to the screen (release rebuild and relaunch into that variant): A (the card as today: text above, attach and permissions left, model, effort and the round send right) 8.7 and 10.2 s; B (one slim rounded row, chips as quiet words, pills outlined) 8.9 and 10.1 s; C (the text in its own outlined field with a larger accent send beside it, outlined chips in a toolbar underneath, pills on the accent surface) 13.7 and 13.1 s. The pick is Zach's.

## What GPUI made easy

- Speed with no effort spent on it: one frame per vsync through the whole stream with 2 ms of work, a two-frame keypress-to-pixels, a first frame with 200 messages in under half a second, a third of Electron's memory, a 16 MB exe.
- Accessibility, which the plan feared most: roles, names, states and focus in a few builder calls, and UI Automation saw all of it.
- The pieces it does have are solid: the virtualised list with tail following, text shaping and wrapping (left to right), the input handler that IMEs talk to, focus and tab order, key contexts, custom window chrome with real hit-testing, `canvas` and custom elements when a div is not enough.
- Writing whole custom widgets is ordinary Rust: the terminal renderer, the composer and the transcript's selection are each one file.
- Theme tokens: generating the theme from `tokens.css` at build time worked first time, so a token change in the Electron app flows into the GPUI build.

## What GPUI made hard

- **Text beyond a single run.** No selection across elements, no rich-text editor, no Markdown view, no inline objects in text: Zed has all of these, in GPL crates. Each had to be written: the transcript's selection, the composer with its pills (as styled runs with drawn backgrounds, not real inline elements), and the Markdown blocks. Matter of work, and much of it; the composer here is a prototype, not an editor (no undo, no IME-aware word movement, no drag and drop, no spell check).
- **Right to left on Windows** (above). Work in the toolkit, not around it.
- **Foreign surfaces.** No shared-texture import, and the windowed path hides GDI children (above).
- **The edit loop.** About 9 s to see a look change in release, 6–7 s in debug, with the app's state lost each time, against Vite's tenth of a second for CSS. Hot reload exists and crashed. This is the cost the plan named, now measured.
- **Some sharp edges, each found by testing:** handles that are not tab stops unless asked; bindings that beat listeners; `TextLayout::bounds` panicking if read before prepaint; GPUI's IME re-association overriding outside changes; the `Text`/`text!` ID rules (the same call site in a loop gives every item the same accessibility id).
- **Moving target.** Upstream GPUI is the only one with accessibility, so Sotto would pin Zed's `main` and absorb breaking changes; the crates.io `gpui` (0.2.2) is a year old.

## What was not verified

- Narrator speaking it (the UIA tree is what Narrator reads; nobody listened). VoiceOver and Orca: not run.
- The Windows IME composing in the composer, and the candidate window's place.
- Hyprland on Wayland, Omarchy, and the Apple silicon Mac: nothing was built or run there.
- Right to left on macOS and Linux.
- Chromium in the web pane, and whether a Chromium child window shows over GPUI's surface.
- Frame timing at the GPU and compositor: GPUI's figure stops at the end of the UI thread's paint; a present-to-present tool (PresentMon) was not used.
- Typing latency to photons; the probe sees the composed desktop.
- The composer as a full editor: undo, word-wise IME handling, very long input, drag and drop.
- Long sessions: memory growth over hours, thousands of messages, many threads.
- High refresh rates: the panel here is 60 Hz.

## Hand tests for Zach

These need ears or a person at the keyboard. The window opens with:

```
D:\sotto-cargo-target\release\sotto-gpui.exe
```

1. **Feel.** Watch the reply stream, scroll up during it (Jump to latest appears), type in the composer while it streams, open an activity row, select across a code block and a paragraph and paste it somewhere, try the terminal, switch Light/Dark and the composer variants in the strip. Ctrl+Shift+R streams the reply again.
2. **Narrator.** Press Ctrl+Win+Enter, then Tab through the window and use Narrator's scan mode (Caps Lock+Space) over the transcript. Listen for: the composer read as "Message, edit", chips by name and whether they are expanded, activity rows as buttons with "collapsed", headings with levels. Ctrl+Win+Enter turns it off.
3. **IME.** Settings → Time & language → Language & region → Add a language → Japanese (and Chinese, simplified). Click in the composer, press Win+Space to pick Japanese, Alt+` to turn the IME on, type `nihongo`, press Space: the candidates should appear under the text you are typing. Remove the languages afterwards if you do not want Alt+Shift switching.

## Zach's picks (November 19, 2026)

- **Composer: variant A**, with the note that "it is not a perfect match to today's composer". A is the closest of the three to today's layout but was drawn from the baseline captures and the brief's chip row, not measured against `composer.css`, so its padding, chip spacing, hint size and the model chip's provider mark differ from Electron's. Matching it exactly is ordinary styling work in either toolkit, not a toolkit limit.
- **Feel: passes.** He ran the window on this laptop.

## My view

I would build Sotto's whole window in GPUI if the bake-off is about feel and weight: it streams without a dropped frame, types as fast as the screen allows, starts in under half a second and uses a third of the memory, and its accessibility is real today. What would hurt most is text: right to left on Windows has to be fixed in the toolkit, and the editor, Markdown view and selection Zed keeps in GPL crates have to be written again, which is months of careful work. Close behind is the edit loop: nine seconds and lost state where React and CSS take a tenth of a second.
