# Native app options for Sotto

Researched October 26, 2026. Two read-only passes did the outside and inside work. One read primary sources for each candidate: official docs, release notes and issue trackers. The other read Sotto's code for line counts, Electron API use and the hard requirements. The baseline numbers were measured by hand on the Windows laptop, once, and the method is in the baseline section. Nothing was built, no spike was run and no product code changed. Sources are linked inline. Claims marked **unverified** were not confirmed from a primary page. Where a claim rests on a secondary source, the text says so.

## Summary

**Stay on Electron. Fix three measured problems first.** None of the three depends on the framework.

1. **The shell's own memory.** On the owner's live instance the main process alone holds 1.3 GB of private memory. A clean profile's whole shell holds 298 MB. Most of the difference sits in the main process, and what fills it is not known yet.
2. **Idle CPU.** A clean launch with no threads used 30% to 68% of one core across two 20-second samples. That was one run, so it is a lead, not a result.
3. **Unused Chromium locales.** 46 MB of the 55 locale packs in the installed app are never used. electron-builder's `electronLanguages` option can drop them.

**Tauri 2 is the only candidate worth a spike, and only as a shell.** Keep the React renderer. Move the Electron-coupled shell, about 11,000 lines, to Rust. Run the agent runtime as a Node sidecar, since the headless host already runs that code under plain Node. A native toolkit rewrite is not worth it. It would rebuild about 81,000 lines of renderer, the rich-text editor, the Canvas-drawn Watcher scene and the i18n catalogues. Most toolkits are also not ready on Linux. Swift has an official toolchain on Windows and Linux, but I found no UI toolkit for it that is ready.

**Effort, my estimates and not measured:** the three fixes, 2 to 4 engineer-weeks. A Tauri spike, 2 to 3 weeks. A full Tauri shell migration, 12 to 16 weeks. A native toolkit rewrite, more than 40 weeks.

## Baseline on this laptop

**Machine.** Windows 11 Home 10.0.26200, Intel Core Ultra 9 275HX with 24 logical cores, 31.4 GB RAM and 7.7 GB free at the time of measuring. Electron is 43.8.3 ([`package.json`](../../package.json)).

**Method.** One packaged launch of the installed Owl 0.1.41 build (`C:\Program Files\Sotto\Sotto.exe`), with a throwaway `--user-data-dir`. A separate profile lets the launch skip Electron's single-instance lock, so it did not join the owner's running instance. I measured the first visible window, waited 60 seconds idle, took two 20-second CPU samples, then stopped the launched processes and deleted the throwaway profile. The owner's instance was not touched, and both of its checked processes were still running afterwards. The launch may have shown a tray icon and tried to register the dictation hotkey, which the running instance already held.

| Measure | Result | Notes |
| --- | --- | --- |
| Time to first visible window, clean profile | 1,845 ms | From the `Start-Process` call. One run. |
| Processes after 60 s idle, clean profile | 7 | 1 browser, 1 GPU, 3 utility, 2 renderer |
| Private working set, clean profile | 298 MB | Sum of private working sets, close to Task Manager's view |
| Summed working set, clean profile | 1,067 MB | Counts shared pages in every process, so it overstates |
| Idle CPU, clean profile | 68% of one core, then 30% | Two 20 s samples, starting about 60 s after launch. Of all 24 cores, 2.8% then 1.2% |
| Installed footprint | 435 MB, 284 files | `Sotto.exe` 228.5 MB; `app.asar` 43.7 MB; `dxcompiler.dll` 24.4 MB; `LICENSES.chromium.html` 19.4 MB; sherpa `onnxruntime.dll` 17.0 MB; `icudtl.dat` 10.4 MB |
| Locale packs in the installed app | 55 files, 46.6 MB | `en-US.pak` is 0.54 MB. The other 54 total 46.1 MB. `electronLanguages` is not set in [`electron-builder.yml`](../../electron-builder.yml). |
| Owl installer on disk | 113.3 MB | `Sotto-Owl-Setup-0.1.41-owl.20261024.1.exe` |
| Stable installer on disk | 107.2 MB | `Sotto-Setup-0.1.17.exe`. An older stable; the current one was not on disk. |
| Owner's live instance, shell | 7 processes, 1,313 MB private | Main process 1,301 MB. Started at 17:44, relaunched after an update. |
| Owner's live instance, whole tree | 132 processes, 4,783 MB private | `claude.exe` 12 processes, 2,323 MB; `codex.exe` 6 processes, 611 MB; `opencode.exe` 188 MB; `node.exe` 10 processes, 106 MB |
| Owner's live shell CPU, 15 s | 37% of one core | Taken while provider CLIs were active, so not idle |
| Battery | Not measured | No power meter here. Idle CPU is the proxy, and it is the thing to fix first. |

**Reading the numbers.**

- A clean Sotto shell is about 0.3 GB. The owner's live shell is 1.3 GB, and the provider CLIs in that session add about 3.5 GB more. A framework change touches only the shell figure.
- Most of the 1 GB gap between the clean and live shells sits in the main process. The clean run was not split by process, so this is an inference from the live split.
- The CPU figures come from one clean run. The first sample began about 60 seconds after launch, so some start-up work may still have been running. A five-minute sample is the next step before drawing a conclusion.

## 1. Candidates

Each cell gives the state documented by the project. Maturity names the latest stable release the research read. Where a year is not shown on the source page, the table says so.

| Candidate (latest read) | Windows | macOS | Linux | Accessibility | IME | Packaging, signing, update | Backer | Licence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Tauri 2** (v2.12.5, 21 Oct; year inferred) | Ready (WebView2) | Ready (WKWebView) | Partial (WebKitGTK, version set by distro) | Inherited from the webview; not tested here | Inherited from the webview; unverified | Installers, plus AppImage, deb and RPM. Updater plugin requires signatures. | Tauri Programme, under The Commons Conservancy | MIT or Apache-2.0 |
| **Slint** (1.18.1, 21 Sep 2026) | Ready on x86-64 | Ready on arm64. Sotto ships arm64 only, so this is enough. | Partial: Wayland or X11, with glibc and D-Bus | Role API present; backend unconfirmed | Open since 2023 (#3811). #4698 closed "not planned" on 18 Oct 2026. | No updater found | SixtyFPS GmbH | Royalty-free 2.0, GPLv3 or commercial. Royalty-free needs an About widget. |
| **egui** (0.37.0, 15 Oct) | Ready; AccessKit on | Ready; AccessKit on | Runs; Linux accessibility not stated | AccessKit on Windows and macOS | Composition underlined since 0.35 | None | Community | MIT or Apache-2.0 |
| **iced** (0.14.0, 7 Dec 2025) | Partial: no 0.15 release; one app builds against git | Partial | Partial | None; issue #552 open | IME support added in 0.14 | None | Community. COSMIC is built on it. | MIT |
| **GPUI** (Zed, pre-1.0) | Ready in Zed since 15 Oct 2025 | Ready in Zed | Partial: needs the `wayland` or `x11` feature | Not stated | Zed asked for IME feedback on Windows | None | Zed Industries | Apache-2.0 |
| **Compose Multiplatform** (1.12.2, 15 Oct) | Partial: Java Access Bridge, off by default | Ready | Runs, but accessibility "Not supported" | Per OS as above | Not documented | `jpackage` msi/exe, dmg/pkg, deb/rpm. No updater. | JetBrains | Apache-2.0 |
| **.NET MAUI** (MAUI 10 docs) | Ready (WinUI 3) | Ready (Mac Catalyst) | Not a target | Semantic properties | Not found in the docs read | MSIX or unpackaged. No updater. | Microsoft | MIT |
| **Avalonia** (12.1.4, 9 Oct; year inferred) | Ready | Ready | Partial: XWayland by default; native Wayland opt-in and early | UI Automation, NSAccessibility and AT-SPI, varying by platform | Documented full on Windows and macOS; Linux via IBus or Fcitx | No built-in updater. Velopack (C#). | AvaloniaUI | MIT. Accelerate is commercial. |
| **Flutter** (3.47.0, page dated 12 Aug 2026) | Ready (MSIX, Store) | Ready (macOS 12+) | Partial: Snap is the only documented route | Narrator, VoiceOver, Orca | Windows Korean caret fixed in 3.47 | No built-in updater. `velopack_flutter` is third-party. | Google | BSD-3-Clause |
| **Qt 6.12 LTS** (Sep 2026) | Ready | Ready | Ready. AT-SPI is opt-in. | UIA, NSAccessibility and AT-SPI named in the overview | Preedit and commit documented; candidate placement not covered | `windeployqt`, `macdeployqt`. No updater. | The Qt Company | LGPLv3, GPL or commercial. Some modules are GPL-only. |
| **Swift** toolchain, with SwiftCrossUI | Partial: WinUI backend, work in progress | Partial: AppKit backend | Partial: GTK 4 backend | Not mentioned | Not mentioned | None | Community; toolchain by Apple and Swift.org | MIT (SwiftCrossUI); toolchain licence not checked |

### Tauri 2

- **Renderer.** Each OS uses its own system webview: WebView2 on Windows, preinstalled on Windows 11; WKWebView on macOS; WebKitGTK on Linux, with its version set by the distro ([webview versions](https://v2.tauri.app/reference/webview-versions/)). Electron ships one Chromium everywhere. Under Tauri, the renderer engine differs by OS. That is the main new risk for design captures and Watcher performance.
- **Signing.** Windows uses `signtool` or Azure Artifact Signing ([Windows](https://v2.tauri.app/distribute/sign/windows/)). Developer ID macOS builds must be notarized ([macOS](https://v2.tauri.app/distribute/sign/macos/)).
- **Updater.** Updates must be signed. Losing the private key blocks further updates. Channels are separate endpoint URLs, not a named setting ([updater](https://v2.tauri.app/plugin/updater/)).
- **Global shortcuts.** The shortcut plugin's callback does not fire on Wayland. Issue #3267 has been open since 8 Feb 2026 ([issue](https://github.com/tauri-apps/plugins-workspace/issues/3267)). Sotto's Omarchy path already uses compositor bindings over a socket (`src/main/hotkeys/dictationSocket.ts`, `apps/omarchy/bindings.lua`), so the gap matters for toggle keys on Linux only.
- **Tray.** `icon_as_template` is macOS-only ([docs](https://docs.rs/tauri/latest/tauri/tray/struct.TrayIconBuilder.html)). Tray events do not fire on Linux, though the icon and menu still work ([docs](https://v2.tauri.app/learn/system-tray/)).
- **WebDriver.** Checked this session. Driven directly, `tauri-driver` supports only Windows and Linux, "as macOS has no WKWebView driver tool available". macOS is supported through the WebdriverIO service ([WebDriver](https://v2.tauri.app/develop/tests/webdriver/)).
- **Backing.** A Programme under The Commons Conservancy, with a board ([governance](https://v2.tauri.app/about/governance/)).
- **Production use.** None verified. The awesome-tauri list has templates only ([list](https://github.com/tauri-apps/awesome-tauri)).

### Native Rust UI: Slint, egui, iced, GPUI

- **Slint.** Latest docs list Windows 10 and 11 on x86-64, macOS 14, 15 and 26 on arm64, and Linux on Wayland or X11 ([platforms](https://docs.slint.dev/latest/docs/slint/guide/platforms/desktop/)). Accessibility roles are in the API ([AccessibleRole](https://docs.slint.dev/latest/docs/rust/slint/language/enum.AccessibleRole)). IME is the gap. Issue #4698 was closed "not planned" on 18 Oct 2026 ([issue](https://github.com/slint-ui/slint/issues/4698)). The royalty-free licence excludes standalone toolkit distribution and requires an About widget or a web badge ([licence](https://unpkg.com/slint-ui@1.12.0/LICENSES/LicenseRef-Slint-Royalty-free-2.0.md)).
- **egui.** eframe targets Linux, Mac, Windows, web and Android. AccessKit covers Windows and macOS and is on by default in eframe. Linux is not stated ([README](https://github.com/emilk/egui)). The Rerun viewer is built on it ([Rerun](https://github.com/rerun-io/rerun/blob/main/ARCHITECTURE.md)).
- **iced.** 0.14.0 is the latest release on GitHub. Accessibility is absent; issue #552 is open ([issue](https://github.com/iced-rs/iced/issues/552)). The maintainers said in June 2024 that accessibility was planned "for the release after the next one", and it is still open.
- **GPUI.** The README says "still pre-1.0" with breaking changes. Windows uses Win32 and DirectWrite, and macOS uses Metal ([README](https://github.com/zed-industries/zed/tree/main/crates/gpui)). Zed on Windows went stable on 15 Oct 2025 ([Zed](https://zed.dev/blog/zed-for-windows-is-here)). The README says nothing about accessibility.

### Compose Multiplatform (Desktop)

- **Linux accessibility.** The docs say "Not supported" on Linux. Windows uses the Java Access Bridge, which is off by default. macOS is "fully supported". The page shows "03 December 2024", which may be its last update ([docs](https://kotlinlang.org/docs/multiplatform/compose-desktop-accessibility.html)). Sotto's AGENTS.md requires the whole app to work from the keyboard with named controls on every platform, so this gap counts.
- **Hotkeys.** The JDK has no global hotkey API. The request, JDK-6246275, dates from 2005 and is unresolved ([OpenJDK](https://bugs.openjdk.org/browse/JDK-6246275)).
- **Packaging and updates.** `jpackage` covers msi, exe, dmg, pkg, deb and rpm. Each builds only on its own OS ([docs](https://kotlinlang.org/docs/multiplatform/compose-native-distribution.html)). Velopack's Java SDK is "planned" ([Velopack](https://docs.velopack.io/)).
- **Shared code.** The Android wire core is Kotlin, so it could be shared with a Compose desktop app. The iOS client is Swift and could not share it without a Kotlin/Native build, which was not evaluated.

### .NET MAUI

Desktop targets are Windows, on WinUI 3, and Mac Catalyst. Linux is not a target ([supported platforms](https://learn.microsoft.com/en-us/dotnet/maui/supported-platforms)). MAUI fails the three-OS requirement as documented. Its accessibility is semantic properties per platform ([accessibility](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/accessibility)).

### Avalonia

- **Linux.** Avalonia 12.0 shipped 7 Apr 2026. Linux runs on X11 through XWayland by default. The native Wayland backend is opt-in in 12.1 and "at an early stage" ([Linux guide](https://docs.avaloniaui.net/docs/platform-specific-guides/linux)). On Hyprland, which is Omarchy's compositor, that means XWayland, which affects hotkeys and typing. Hyprland itself is not stated on the source page; that is inferred.
- **Accessibility and IME.** UIA, NSAccessibility and AT-SPI, varying by platform ([accessibility](https://docs.avaloniaui.net/docs/app-development/accessibility)). The IME table lists full support on Windows and macOS and IBus or Fcitx on Linux. Extraction flattened the table, so that reading is unverified ([text input](https://docs.avaloniaui.net/docs/input-interaction/text-input)).
- **Tray.** Linux needs StatusNotifier or AppIndicator, and GNOME may need an extension ([tray](https://docs.avaloniaui.net/docs/controls/trayicon)).
- **Production.** Devolutions says it moved Remote Desktop Manager's Windows UI to Avalonia and ships on three OSes. This is a vendor claim ([case study](https://avaloniaui.net/success/devolutions)).

### Flutter desktop

Desktop is documented on all three OSes. Linux packaging is documented only as Snap ([deployment](https://docs.flutter.dev/deployment/linux)). Accessibility names Narrator, VoiceOver and Orca ([assistive technologies](https://docs.flutter.dev/ui/accessibility/assistive-technologies)). There is no built-in updater. The backer is Google. A secondary report names Canonical as steward, which is **unverified**.

### Qt 6 (C++) and PySide6

- **Maturity.** The only candidate documented as ready on all three OSes, Linux included. Qt 6.12 is LTS with five years of maintenance ([what's new](https://doc.qt.io/QT-6/whatsnew612.html)).
- **Accessibility.** The overview names UI Automation, macOS Accessibility and AT-SPI ([docs](https://doc.qt.io/qt-6.0/accessible.html)). The `QAccessible` page names MSAA on Windows ([docs](https://doc.qt.io/qt-6/qaccessible.html)). Which Windows backend is current is **unverified**.
- **IME.** `QInputMethodEvent` carries preedit and commit. Candidate placement is not covered ([docs](https://doc.qt.io/qt-6/qinputmethodevent.html)).
- **Tray.** On Linux the tray uses StatusNotifier or XEmbed. Some GNOME activations need extensions ([docs](https://doc.qt.io/qt-6/qsystemtrayicon.html)).
- **Licence.** LGPLv3 or commercial. Some modules are GPL-only ([licensing](https://doc.qt.io/qt-6/licensing.html)). The repository is public and MIT-licensed ([signing note](2026-10-22-windows-code-signing.md)). Dynamic LGPL linking fits that in principle. A legal check is still needed.
- **Cost.** Neither C++ nor Python matches the TypeScript the logic is written in, so all of it would be translated.
- **Production.** Telegram Desktop ships on Qt 6 on Windows, macOS and Linux. Its own code is GPLv3 ([repository](https://github.com/telegramdesktop/tdesktop)).

### Swift on Windows and Linux

- **Toolchain.** The toolchain is official on Windows, through WinGet or a manual installer ([install](https://www.swift.org/install/windows/)). Windows and Linux are listed as deployment platforms ([platform support](https://www.swift.org/platform-support/)).
- **UI.** SwiftCrossUI has WinUI, GTK 4 and AppKit backends. Its README calls it a work in progress and says nothing about accessibility or IME ([repository](https://github.com/stackotter/swift-cross-ui)). SwiftOpenUI is a different project, which the Swift forums call "not ready for production" ([thread](https://forums.swift.org/t/swiftui-for-linux-windows-and-web-still-experimental/85463)).
- **Verdict.** Not viable for Sotto's UI on Windows and Linux. The `SottoCore` package targets iOS 17 and macOS 13 in its manifest, so whether it builds on Windows or Linux is **unverified**.

### Platform hooks every option shares

Every candidate calls the same OS APIs. None of them adds a hotkey or typing API.

- **Windows.** `RegisterHotKey` has no key-up event and fails on conflicts ([docs](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey)). A low-level keyboard hook needs a message loop and is removed silently on timeout ([docs](https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelkeyboardproc)). `SendInput` is blocked by UIPI for higher-integrity targets and returns zero without saying why ([docs](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)). Sotto already has the hook helper, `native/key-listener/win32.cs`, which uses `WH_KEYBOARD_LL`. Any stack would reuse it as a child process or through FFI.
- **macOS.** Sotto's helper is a listen-only `CGEventTap` in `native/key-listener/darwin.swift`. Forum reports say an active tap asks for Accessibility and a listen-only tap asks for Input Monitoring ([forum](https://developer.apple.com/forums/thread/828052)). Apple's own page could not be read, so this is **unverified**.
- **Linux.** The xdg GlobalShortcuts portal sends activation signals regardless of focus, and the user approves bindings in a dialog ([spec](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.GlobalShortcuts.html)). The Rust `global-hotkey` crate is X11-only on Linux ([README](https://github.com/tauri-apps/global-hotkey)). `xdotool` does not work on Wayland ([README](https://github.com/jordansissel/xdotool)). `wtype` depends on compositor support for the virtual-keyboard protocol ([man page](https://man.archlinux.org/man/wtype.1)).
- **PTY.** ConPTY needs Windows 10 1809 or later ([docs](https://learn.microsoft.com/en-us/windows/console/createpseudoconsole)). `portable-pty` in Rust is cross-platform, but its docs do not name ConPTY, which is **unverified** ([docs.rs](https://docs.rs/portable-pty/latest/portable_pty/)). Sotto uses `node-pty` today ([ADR-0018](../adr/0018-terminals-run-on-node-pty.md)).
- **Speech runtime.** Linux ONNX Runtime wheels are about 15 to 17 MB compressed, and GPU builds are 264 to 294 MB ([PyPI](https://pypi.org/project/onnxruntime)). Parakeet v3 is about 670 MB per model. It is downloaded on use, not bundled ([`src/shared/speechModel.ts`](../../src/shared/speechModel.ts) lines 25 to 35).

## 2. What Sotto needs

The requirements come from the code. The first column says what Sotto does today. Ratings for the other columns:

- **Keep**: unchanged.
- **Port**: the logic is rewritten in the new language with the same behaviour.
- **Rebuild**: a new UI or surface.
- **Gap**: the candidate has no equivalent, so a workaround is needed.

| Requirement | Today (Electron) | Tauri 2, React UI kept | Native toolkit (Qt, Avalonia, Compose, Flutter, Slint) |
| --- | --- | --- | --- |
| **Global hotkeys and typing at the cursor** | Toggle keys through `globalShortcut` (`src/main/hotkeys/hotkeyManager.ts`). Hold keys through the native helpers, `win32.cs` and `darwin.swift`. Paste through PowerShell `SendInput`, `osascript`, or `wtype` (`src/main/output`). | **Keep** the helpers as child processes. Toggle keys use the global-shortcut plugin, with the Wayland gap. Omarchy keeps its socket. | **Keep** the helpers. No candidate adds a hotkey API, and Compose has none. |
| **Menu-bar and tray owl** | Tray and template image (`src/main/index.ts`, tray setup). Animator is plain TypeScript (`src/main/tray/owl/`). | **Port**. Template icon is macOS-only. Tray events do not fire on Linux. | **Port**. Qt has a tray on all three OSes; Avalonia and Qt need StatusNotifier on Linux. |
| **Agent CLIs and PTYs** (Codex, Claude Code, Grok) | `child_process` and `node-pty` ([ADR-0018](../adr/0018-terminals-run-on-node-pty.md)). Protocol clients are plain TypeScript: `claudeProtocol.ts`, `codexProcess.ts`, `grokRpc.ts`. | **Keep** in a Node sidecar. Or port the PTY to `portable-pty`, with ConPTY unverified. | **Port** the 73,000 lines of adapter code. Replace `node-pty` with a native PTY library per OS. |
| **Git and worktrees** | `execFile('git')` and `gh` (`src/main/tools/gitChanges.ts`, `src/main/agents/gitActions.ts`). No library. | **Keep**. Process calls work from a sidecar or from Rust. | **Keep** the process calls. Port the logic. |
| **SQLite** | `node:sqlite` `DatabaseSync` in four stores: memory, threads, usage, subagents ([ADR-0003](../adr/0003-memory-store-sqlite.md)). | **Keep** `node:sqlite` in the sidecar. Or move to `rusqlite`. | **Port** to any SQLite binding. The schema is small. WAL checkpointing is the subtle part. |
| **SSH and Tailscale hosts** | `ssh` spawned by `sshProcess.ts`, askpass socket, `tailscale` CLI, WebSocket framing in `src/host/socketFrames.ts`. `HOST_PROTOCOL_VERSION = 1` in `src/shared/hostProtocol.ts`. | **Keep** in the sidecar. | **Port** the framing and protocol v1. The iOS and Android clients mirror it by hand, so the port must match both. |
| **Local speech models** (Parakeet) | `sherpa-onnx-node` in main on Windows and Linux. A Core ML helper, `native/coreml-asr`, on Apple silicon. | **Keep** `sherpa-onnx-node` in the sidecar. The Core ML helper is unchanged. | **Port**. Needs a sherpa or ONNX Runtime binding per language. The Core ML helper is unchanged. |
| **Watcher night scene and animations** | Canvas 2D on two canvases, about 8,400 lines of Watcher code including layout (`src/renderer/src/watcher/`). No WebGL found. | **Keep**. Canvas 2D exists in WKWebView and WebKitGTK. Performance per engine is unverified. | **Rebuild** the drawing on the toolkit's 2D API. The layout maths ports directly. |
| **Rich-text composer (TipTap)** | `PromptEditor.tsx` on `@tiptap/react` and ProseMirror. A custom `Skill` node view and a `Ghost` extension. | **Keep**. | **Rebuild**. No ProseMirror equivalent in Qt, Compose or Avalonia. The document model needs redesign. |
| **i18n (Lingui)** | 224 `.po` catalogues in `src/locales/`, 210,688 entries, React macros. | **Keep**. | **Port**. Convert `.po` to the toolkit's format and re-create the macros. |
| **Auto-updater, Owl and stable tracks** | `electron-updater` 6.8.9 with the GitHub provider, an `owl` channel, and Squirrel.Mac on macOS (`src/main/updates/electronUpdaterAdapter.ts`). | **Port**. Tauri's updater needs its own signing key. Two channels become two endpoints. The Owl and stable logic is re-implemented. | **Port**. Velopack for Avalonia and MAUI. None found for Qt, Compose or Flutter. |
| **Notarization and signing** | Stable Mac is ad hoc and not notarized. Owl Mac is Developer ID with notarization in `owl-mac.yml`. Windows is unsigned ([signing note](2026-10-22-windows-code-signing.md)). | **Keep** the Apple steps; Tauri requires notarization too. Windows signing is a new decision, as it is for every stack. | **Keep** the Apple steps per toolkit. The Windows signing decision applies to any stack. |
| **iOS client sharing code** | Nothing shared in source. The wire is hand-mirrored in Swift (`apps/ios/Sources/SottoCore`) and Kotlin (`apps/android`). Desktop schemas are zod. | **Keep**. The desktop stays TypeScript, so nothing new is shared. | Swift desktop could share `SottoCore` only if it builds on Windows and Linux, which is unverified. A Kotlin desktop could share the Android wire core, not the Swift one. |

**Swift on all three.** The Swift toolchain runs on Windows and Linux. Without a UI toolkit that is ready on those OSes, a Swift desktop would be a Swift core behind a second UI, not one app.

## 3. Benefits, with numbers

| Measure | Measured today | Expected with a native stack or Tauri | Confidence |
| --- | --- | --- | --- |
| **Memory** | Clean shell 298 MB. Owner's live shell 1.3 GB. Other processes in the owner's live tree, mostly provider CLIs, about 3.5 GB. | Tauri drops the Chromium payload: most of `Sotto.exe`, `dxcompiler.dll`, the locales, ICU and GL. A Node sidecar keeps the V8 heap, and the 1.3 GB main process is state, so a shell change does not shrink it. | Low. Estimate only. |
| **Startup** | 1.8 s to first window on a clean profile, one run. | Not measured for any alternative. Native toolkits and Tauri usually start faster, but no build was made here. | None |
| **Installer size** | Owl 113.3 MB. Installed 435 MB, of which at least 340 MB is Electron's own files, by the largest files listed. | A Tauri shell with a Node sidecar might install at about 150 to 200 MB: the app's 44 MB asar, ONNX Runtime at 17 MB, a Tauri binary of about 10 MB, and a Node binary of about 80 to 100 MB uncompressed. Those are my estimates from the file list, not a build. WebView2 is preinstalled on Windows 11, so it is not counted. | Low. Not built. |
| **Idle CPU** | 30% to 68% of one core on a clean profile, one run. 37% on the live shell with providers active. | Unknown. The cause is not identified. A shell change may or may not help. | Low. Profile first. |
| **Battery** | Not measured. | Follows idle CPU and timers. Fix idle CPU first. | None |
| **Native look and feel** | Custom design: a quiet single-window design with theme tokens, and an always-solid window ([ADR-0084](../adr/0084-the-window-and-its-surfaces-are-always-solid.md)). | Native toolkits add platform controls, which the design does not use. Re-skinning them costs more than the gain. Tauri keeps the same design code. | Qualitative |
| **Accessibility** | Runs on all three OSes today, on the Chromium the app already ships. | The candidates are less proven on Linux, as the table shows. Qt is the only one documented ready on all three. | Qualitative |

The installed-size and startup rows are the ones most likely to move. They are also the ones this research could not measure.

## 4. Costs

### 4a. Code by layer and what happens to it

Counts are non-blank lines of TypeScript, TSX and CSS. Test counts are the same, plus fixtures. The iOS and Android counts are Swift and Kotlin source only.

| Layer | Non-blank lines | Native rewrite | Tauri, React UI kept |
| --- | --- | --- | --- |
| Renderer: TS, TSX and CSS (`src/renderer`) | about 81,000 (69,000 TS and TSX; 11,700 CSS). Watcher about 8,400; Threads page about 30,400. | Rebuild | Keep |
| Electron-coupled shell: `index.ts` 2,299; tray, hotkeys, output, windows, app, notifications, updates and startup 7,811; preload 1,089 | about 11,200 | Rewrite | Rewrite in Rust, behind the bridge. `tools/browser*` and `tools/cloudIphone` also use Electron views and are not separated here. |
| Agent runtime and provider adapters (`src/main/agents`) | 73,022 | Port | Keep in the Node sidecar |
| Hosts, SSH and Tailscale (`src/main/hosts`) | 9,518 | Port | Keep in the sidecar |
| Other main logic: asr, tools, memory, storage, llm, performance | 9,830 | Port | Keep in the sidecar. `sherpa-onnx-node` stays with it. |
| Shared types, zod schemas, themes (`src/shared`) | 16,659 | Port zod to the new language's types | Keep |
| Headless host (`src/host`) | 4,159 | Keep. It already runs as plain Node and imports no Electron ([ADR-0025](../adr/0025-headless-host-and-client-identity.md)). | Keep |
| Tests (`tests/`): unit 162,000; integration 61,000; e2e 46,000; perf 8,000; fixtures 14,000 | about 290,000 | Rewrite e2e and design captures; port unit and integration | Rewrite e2e and design captures; keep unit and integration |
| Native clients, iOS and Android (`apps/ios`, `apps/android`) | iOS Swift 29,500; Android Kotlin 5,900 | Unchanged | Unchanged |

Totals from the rows above: about 206,000 lines in the desktop layers. The shell is about 5% of them. The renderer is about 39%. The logic that a sidecar would keep is about 45%. Shared and host code is about 10%. Under Tauri with a sidecar, about 94% of the desktop lines stay (renderer, logic, shared and host). Under a native rewrite, only the shared types and the host are left as they are.

### 4b. What is lost or changes

- **Playwright e2e.** 229 spec files and about 510 tests. Playwright cannot drive a Tauri window directly, which is **unverified**. Direct `tauri-driver` covers Windows and Linux only. macOS needs the WebdriverIO service ([WebDriver](https://v2.tauri.app/develop/tests/webdriver/)). Every e2e spec has to be ported.
- **Design captures.** 159 committed PNG baselines, verified by `design:verify`. Tauri on Windows uses WebView2, close to today's Chromium. macOS and Linux use WebKit engines. Each engine needs its own baselines or a tolerance rule.
- **React components.** Kept under Tauri. Rebuilt under a native toolkit: about 81,000 lines.
- **Rich text.** TipTap and ProseMirror are web-only. Kept under Tauri, rebuilt under a native toolkit.
- **Watcher scene.** Kept under Tauri, with Canvas 2D performance per engine unverified. Rebuilt under a native toolkit: about 8,400 lines of drawing and layout. The maths in `nightScene.ts` ports.
- **i18n.** Kept under Tauri. Under a native toolkit, the catalogue format and the message macros change.
- **In-app browser and iPhone test page.** These use Electron's `webContents` and `session` partitions ([ADR-0029](../adr/0029-a-thread-uses-the-browser-without-asking-by-default.md), [ADR-0045](../adr/0045-the-test-iphone-is-a-page-in-sottos-browser.md), `src/main/tools/browser.ts`, `src/main/tools/cloudIphone/service.ts`). Tauri's multi-webview support is **unverified**. A native toolkit needs an embedded browser control on each OS. This is high cost.
- **Sealed visual pages.** These run in a custom privileged scheme ([ADR-0060](../adr/0060-an-interactive-visual-runs-in-a-sealed-page.md), `protocol.registerSchemesAsPrivileged`). Tauri has custom protocols. Their behaviour there is **unverified**.
- **Web-site sharing.** This repository has no public website. `marketing/` holds a Remotion launch-video composition, 2,265 lines. I read the phrase as the sealed pages and the browser-hosted pages above. If something else was meant, the costs change.
- **Node runtime.** `node-pty`, `sherpa-onnx-node`, `node:sqlite` and the protocol clients run in Node today. Under Tauri they stay in a sidecar. Under a native toolkit they are all ported.
- **One engine.** Electron gives one Chromium on all three OSes. Tauri gives three engines. That is the loss the design gate would have to absorb.

### 4c. Migration paths

| Option | What moves | What stays | Effort (my estimate) | Verdict |
| --- | --- | --- | --- | --- |
| **A. Stay on Electron and fix the three measured problems** | Nothing | Everything | 2 to 4 engineer-weeks | **Recommended** |
| **B. Tauri shell, Node sidecar, React UI** | The Electron-coupled shell, about 11,200 lines, to Rust. The preload bridge, about 210 `window.sotto` members, to Tauri commands and events. | Renderer, agents, hosts, shared, host | 2 to 3 weeks for a spike, then 12 to 16 weeks | Only shell candidate worth a spike |
| **C. Tauri with the core in Rust** | B, plus porting about 92,000 lines of main logic and the zod schemas | Renderer | More than 40 weeks. I would not estimate it tighter. | Not worth it now |
| **D. Rust native addons inside Electron for hot modules** | SQLite or PTY, through N-API | Everything else | 1 to 3 weeks per module | Small win with no shell change. The ABI rebuild cost is in [ADR-0003](../adr/0003-memory-store-sqlite.md). Not measured. |
| **E. Native toolkit rewrite** (Qt, Avalonia, Compose, Flutter, Slint) | Everything except shared types and host | Native clients | Well over 40 weeks | Not recommended |
| **F. Swift on all three** | Not viable | | | No UI toolkit is ready on Windows or Linux |

**Staged path for B, if it is chosen after A.**

1. **Spike, 2 to 3 weeks.** Test these on each OS: the hold-key helper driven from a Tauri process; paste at the cursor; the tray owl's animation; the Watcher canvas at the owner's scale; a WebView2 and Electron capture diff; `sherpa-onnx-node` in the sidecar; an updater with two channels and a test key. Measure RAM, idle CPU, first-window time and installer size on each OS.
2. **Shell port, 6 to 8 weeks.** Windows, tray, hotkeys, output, notifications, updates, startup, and the bridge.
3. **Test port, 3 to 4 weeks.** Playwright to WebdriverIO and `tauri-driver`. Design captures per engine.
4. **Platform QA and release, 2 to 3 weeks.** macOS notarization as before. The Windows signing decision ([signing note](2026-10-22-windows-code-signing.md)). Linux checks on Omarchy ([ADR-0062](../adr/0062-the-desktop-app-runs-on-linux-omarchy-first.md)).

## 5. Recommendation

**Stay on Electron. Fix three things first.**

1. **Find what fills the main process.** Take a heap snapshot, or a per-process memory breakdown, of the main process after a representative session. The aim is to tell V8 heap held in state apart from anything else. If it is state, the fix is in how history is kept, which the AGENTS.md performance rules already point toward. A framework change would not fix it.
2. **Measure idle CPU properly.** Run five minutes idle on a clean profile and on a seeded one. Profile the main and renderer processes. Check timers and animation loops: the menu-bar owl animator (`src/main/tray/owl/animator.ts`), the widget, and the Watcher scene while idle.
3. **Set `electronLanguages` to keep en-US.** The option is in electron-builder's platform-specific options. It keeps only the listed Chromium locales, which is 46 MB installed. The compressed installer saving is not measured. Check that nothing depends on Chromium's other locales, such as spell-check dictionaries. The option's page was found through search, not fetched, so check it against the installed electron-builder version before use.

**Revisit Tauri only after these three.** Open the Tauri spike if the clean shell is still a large cost, or if a smaller installer matters more than one engine on every OS. The spike is the next step, not the migration.

**Effort, my estimates:** the three fixes, 2 to 4 engineer-weeks. The Tauri spike, 2 to 3 weeks. The full Tauri shell migration, 12 to 16 weeks. A native toolkit rewrite, more than 40 weeks.

**Main risks.**

- *Stay on Electron.* The Chromium payload stays at about 300 MB installed. The idle CPU may not be a bug with a clean fix. Memory grows with use until state changes.
- *Tauri.* Three engines instead of one. Design captures and e2e are rebuilt. The updater key must be guarded, because losing it blocks updates. `tauri-driver` has no macOS path. The Wayland shortcut gap is open. A Node sidecar brings a runtime back into the bundle. The in-app browser and sealed pages are unverified.
- *Native rewrite.* A rebuild of about 200,000 lines. Linux accessibility and IME gaps in most toolkits. Loss of the one-engine design gate. TipTap, Lingui and Canvas work redone. The iOS wire, hand-mirrored today in three languages, would be mirrored in four.

**What would change the pick.** A measured clean-shell memory or idle CPU that stays high after the three fixes. A measured Tauri spike that holds the hotkey, paste and tray behaviour on all three OSes. Or a decision to drop the one-engine guarantee for a smaller installer.

## Other findings

- **`AGENTS.md` is out of date on the artifacts size.** It says `artifacts/` is "about 240 MiB". Measured: 3,638 files and 437.2 MB, which is 416.9 MiB. Not changed here, since this is research only.
- **Test stand-ins are compiled into the product.** `src/main/e2e` (9 files) and `src/renderer/src/e2e` (2 files) are imported by `src/main/index.ts` at lines 39 to 42. AGENTS.md says tests live under `tests/`. The boundary file `e2eBoundary.ts` keeps them out of release builds, but I did not read it in full.

## Unverified

- Tauri's accessibility and IME inside WebView2, WKWebView and WebKitGTK. Tauri production apps.
- Tauri's multi-webview support, for the in-app browser. Whether Playwright can drive a Tauri window.
- Slint's accessibility backend, and its IME beyond #4698.
- egui and GPUI accessibility and Linux IME. iced's IME per OS and its 0.15 timing.
- Compose's accessibility page date, which the page does not label.
- MAUI's IME, tray and hotkey APIs, and any desktop production app.
- Qt's current Windows accessibility backend, candidate placement, and Qt's hotkey, typing and PTY APIs.
- Avalonia's IME table, which extraction flattened.
- Flutter's tray and IME per OS, and Canonical's role.
- Apple's `CGEventTap` permission rules, and Apple's notarization steps. The Apple pages could not be read.
- Whether `portable-pty` supports ConPTY.
- Whether `SottoCore` builds on Windows or Linux.
- `electronLanguages` was found through a search summary. The official page returned 404 when fetched.
- The Tauri-plus-sidecar installed size: my arithmetic from the file list, not a build.
- Effort estimates: judgement, not measurement.
- Battery: not measured.
- Third-party size and memory comparisons of Tauri and Electron: not used.
