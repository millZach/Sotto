# Linux without window controls

Verified October 8, 2026 for [#849](https://github.com/millZach/Sotto/issues/849), on top of the Linux platform profile in #848. This follows the owner's chrome 1 choice on [#839](https://github.com/millZach/Sotto/issues/839). The prototype on `origin/prototype/omarchy-widget-chrome` was opened with `#chrome=1` and inspected.

## What changed

Only Windows draws Sotto's custom window controls. macOS keeps its native traffic lights. Linux keeps the title areas without buttons, and drops their reserved space from the Threads header, host update pill and Settings feedback. The existing native close handler already hides to the tray and keeps the window available for reopening; no main-process behavior changed.

README, the guide and the strip's glossary entry explain that Super+W closes Sotto to the tray on Omarchy. No dictation, onboarding or hotkey implementation changed.

## Running app

Built this checkout with Node 24.21.0 and launched its Electron 43.1.0 executable in forge's Hyprland 0.56.2 session, using the session environment read from quickshell and an isolated configuration folder inside this worktree. No `SOTTO_E2E` flags or personal profile were used. The inspector was on 9342 and renderer CDP on 9343. The capture probe remained in the ignored `.cache/issue-849/` scratch area.

Completed first launch through the UI, skipping microphone and key setup. Opened Threads, Dictate, Settings, History and Help at 1600x1000, 1280x800 and 820x560. Checked light appearance and reduced motion at the minimum too. Every capture had zero custom controls, an intact drag region, and root scroll dimensions equal to the renderer dimensions. Settings' long form scrolls inside its room. The images were opened and inspected.

The locked session throttles main-window frames. The probe temporarily disabled background throttling, waited for the destination page and two animation frames, then captured through Electron's `webContents.capturePage()`. It restored throttling before closing. The session also clamped the declared 820x560 native minimum to 840x580; the probe temporarily lowered that one window's native constraint to 800x540 to obtain an actual 820x560 renderer, then restored the app's 820x560 constraint. Neither adjustment changes production code or desktop configuration.

Retained evidence:

- [Threads, 1600x1000, dark](../../artifacts/linux-no-window-controls/threads-1600x1000-dark.png): the title area remains; the corner has no controls.
- [Threads, 820x560, dark](../../artifacts/linux-no-window-controls/threads-820x560-dark.png): the sidebar, title area and room fit the minimum.
- [Settings, 820x560, light and reduced motion](../../artifacts/linux-no-window-controls/settings-820x560-light-reduced-motion.png): no controls or reserved feedback gap; the form keeps its own scrollport.
- [Checks](../../artifacts/linux-no-window-controls/checks.json): dimensions, drag regions, zero Threads control inset, close result, tray ownership and stopped PIDs.

## Compositor close

Ran the requested command verbatim:

```sh
XDG_RUNTIME_DIR=/run/user/1000 HYPRLAND_INSTANCE_SIGNATURE=$(ls -t /run/user/1000/hypr | head -1) hyprctl dispatch closewindow class:sotto
```

It returned exit 7, because this session uses Lua configuration:

```text
error: [string "return hl.dispatch(closewindow class:sotto)"]:1: ')' expected near 'class'
```

Then ran the current [Lua dispatcher syntax](https://wiki.hypr.land/configuring/core/advanced-configuration/using-hyprctl/), which sends the compositor's graceful close request:

```sh
hyprctl dispatch 'hl.dsp.window.close({ window = "class:sotto" })'
```

It returned `ok`. The main window reported hidden and its address disappeared from `hyprctl clients`. Electron PID 2728954 was still running. The tray item remained registered, and D-Bus `GetConnectionUnixProcessID` confirmed it belonged to that PID:

```text
as 1 ":1.6154/org/chromium/StatusNotifierItem/1"
```

The installed Omarchy binding in `/usr/share/omarchy/default/hypr/bindings/tiling.lua` maps Super+W to `hl.dsp.window.close()`, the same close dispatcher. No shortcut was sent to the lock screen. All probe processes were stopped by PID, including Electron 2728954 and its descendants; afterward the main PID and its Hyprland client were absent.

## Gates and limits

All npm commands used `mise exec node@24.21.0 --`. Suites ran serially, with at most two Vitest workers and one Playwright worker.

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test -- --maxWorkers=2`: 610 files passed, 50 skipped; 8,953 tests passed, 182 skipped; no failures.
- `npm run notices:verify`: 174 components verified.
- `npm run build`: passed.
- Targeted Playwright: 3 passed — native close-to-tray, second-instance reopening, and Linux profile onboarding/storage/copy with the new no-controls and no-reserve assertions.

The early scratch probes needed corrections for inspector startup, the compositor's Lua syntax, native minimum clamping and stale or stalled captures while locked. The final probe completed successfully. Standards and ticket reviews found no remaining issue.

Windows and macOS control/lifecycle behavior passed the platform unit tests. Native Windows/macOS desktop checks were not available here. Their design baselines were not regenerated or edited. No installer, pull request or merge was made.
