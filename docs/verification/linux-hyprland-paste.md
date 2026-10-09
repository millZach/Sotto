# Hyprland dictation paste

October 9, 2026. Review fixes for [#838](https://github.com/millZach/Sotto/issues/838), based on `80053911` on `feat/linux-hyprland-paste`. Built on forge with Node 24.21.0 and Electron 43.1.0. Hyprland 0.56.2 (`efb50993780079460b0cbed1363e2166a2de1d9f`) and the installed Omarchy Lua clipboard and terminal-tag rules.

**VERIFIED: real paste into foot, Alacritty and Chromium inside an owned nested Hyprland.** The focused window, process ownership, tags, `pasted` result and exact received text are assertions. Forge's live session stayed locked. No real key event went to it. The clipboard-only proof used the real output path while Sotto was unfocused and a recording hyprctl stub for every dispatch.

Physical modifier release on a keyboard remains unverified. Windows and macOS behavior was preserved; their packaging and physical paste were not exercised on forge. No installer or release target changed.

## Review fixes

1. Recheck `hyprctl locked -j` after modifier polling and active-window lookup, immediately before down. Locked, malformed and failed checks send no down. A dispatched down always gets an up attempt, including a lock between them. Unit tests cover a lock during polling, a lock during target lookup, a failed final check and locking after down.
2. A failed Wayland write returns `clipboard-unavailable` through IPC and preload, even when Electron’s fallback also fails. Dictation keeps the completed text in its existing recovery area, including with history off, and publishes the persistent widget error **Text kept in Sotto**. It says to open Sotto, then Dictate, and use **Copy text** or select the text. Neither surface offers Super+V or **Copied — paste manually** for this result. The built Electron test hides main, leaves a stale desktop selection, dictates through the private compositor-command socket, checks zero paste attempts and the widget's recovery instructions, then opens Dictate and checks the exact retained text.
3. Match the nested instance and Wayland display to the spawned Hyprland PID. Assert that both differ from Quickshell's live session before dispatch and output delivery. Verify inspector `process.pid` against the spawned Sotto PID before changing settings or hiding windows. Early inspector identity checks run synchronously so Electron startup cannot discard their promise.
4. Start the clipboard proof's Electron and sentinel writer in dedicated process groups. Forked wl-copy owners inherit those groups even when reparented. Stop only those groups; no global before/after PID difference is used. A process-ownership integration test keeps an unrelated process alive while stopping a reparented owned child.
5. On stdin failure, process error or timeout, terminate a running clipboard child with SIGTERM and escalate after 250 ms with SIGKILL. Clear escalation on exit. Unit tests cover stdin failure, timeout and graceful termination.
6. Use one monotonic 300 ms modifier deadline, including query time. Each query receives the remaining budget and races a deadline. A release received after the deadline is rejected. Slow-query and late-reply tests require zero dispatches.
7. Start the compositor inside `try/finally`. Bound HTTP discovery, WebSocket connection and evaluation; reject close and error; close debugger sockets in `finally`; stop every owned process group. Remove a runtime folder only after matching the spawned PID and the original folder's device/inode. Integration tests exercise dropped replies, connection deadlines and disconnects.
8. The nested proof asserts the focused target's address, PID, class, title and tags, checks `deliverOutput === 'pasted'`, and compares exact received text. Both terminals use raw-mode cat. Initial window activation settles before target delivery. Every mismatch exits non-zero. The final three-target run passed.
9. While recording on Linux, the Dictate hint promises copy and paste only with **Automatic paste** on. With it off, the hint says Sotto copies and names Super+V. Renderer and built-app tests exercise both settings.

This follows the staged Hyprland paste decision in ADR-0062 on `origin/feat/linux-desktop-adr`. No new domain term, network host, runtime dependency, theme token or Windows/macOS copy was introduced. The desktop clipboard failure reuses Dictate's existing completed-text recovery. Widget snapshots carry its error code; completed text stays in Dictate, outside the widget and logs.

## Real nested paste

After `mise exec node@24.21.0 -- npm run build`:

```sh
mise exec node@24.21.0 -- node scripts/verify-hyprland-paste-nested.mjs /tmp/nested-paste-final
```

The proof starts its own Hyprland, loads Omarchy's terminal-tag rules, launches its own targets and Sotto profile, and sends only to that compositor. Alacritty was absent from the system, so its [Arch package](https://archlinux.org/packages/extra/x86_64/alacritty/) was extracted to this worktree's ignored `.cache/alacritty/` and passed to the proof as `SOTTO_ALACRITTY=.cache/alacritty/usr/bin/alacritty`; no system package was installed. With Alacritty installed, the proof uses it from `PATH`. Version: `alacritty 0.17.0 (94e7c887)`.

| Target | Tags | Chord | Result |
| --- | --- | --- | --- |
| foot | `terminal*` | Shift+Insert | Exact transcript received; `pasted`. |
| Alacritty | `terminal*` | Shift+Insert | Exact transcript received; `pasted`. |
| Chromium text box | none | Ctrl+V | Exact transcript received; `pasted`. |

Opened and inspected the [nested screen](../../artifacts/linux-hyprland-paste/nested-paste-real.png). The terminals have echo off and write their received bytes to files; Chromium visibly contains its exact transcript. The [results JSON](../../artifacts/linux-hyprland-paste/nested-paste-results.json) records each target's identity and exact text.

Verbatim [nested proof output](../../artifacts/linux-hyprland-paste/nested-proof.txt), including cleanup:

```text
nested: efb50993780079460b0cbed1363e2166a2de1d9f_1791540303_711471819 on wayland-2; live: efb50993780079460b0cbed1363e2166a2de1d9f_1789793874_889692923 on wayland-1 (untouched)
foot: focused=foot tags=["terminal*"] deliverOutput=pasted
foot received: "Sotto pasted into foot — café 🚀"
Alacritty: focused=Alacritty tags=["terminal*"] deliverOutput=pasted
Alacritty received: "Sotto pasted into Alacritty — café 🚀"
Chromium: focused=chrome-_text_html,_title_pastebox__title__textarea_id=t_autofocus_style=_width_95vw;height_90vh____textarea_-Default tags=[] deliverOutput=pasted
Chromium received: "Sotto pasted into Chromium — naïve façade ✓"
screenshot: /tmp/nested-paste-final/nested.png
PASS: exact paste into foot, Alacritty and Chromium
Stopped Hyprland process group 3896502
Stopped foot process group 3896518
Stopped Alacritty process group 3896519
Stopped Chromium process group 3896520
Stopped Sotto process group 3896521
Owned processes still running: []
Hyprland instance folders after cleanup: ["efb50993780079460b0cbed1363e2166a2de1d9f_1789793874_889692923"]
```

Three earlier proof attempts failed on inspector startup or pending window activation. Each executed cleanup, reported no owned processes still running and left only the live session folder. Those failures sent no live keys. The revised assertions made the activation problem visible rather than reporting a false success.

## Real desktop clipboard

```sh
mise exec node@24.21.0 -- node scripts/verify-hyprland-paste.mjs
```

The script reads Quickshell's session environment, removes e2e overrides, starts the built app with an isolated worktree profile, verifies its inspector PID, hides its windows and invokes `window.sotto.deliverOutput`. This traverses the real preload bridge, IPC validation, output queue and Wayland adapter. Only hyprctl is stubbed. No provider or transcription request is made.

Verbatim [clipboard output](../../artifacts/linux-hyprland-paste/clipboard-proof.txt), including cleanup:

```text
session locked (read-only query): true
wl-paste before: "before-hyprland-paste-proof"
Sotto focused: false
real output result: "copied"
wl-paste after real output: "Sotto Wayland output while unfocused — café 🚀\nSecond line."
wl-paste after settle (no automatic restore): "Sotto Wayland output while unfocused — café 🚀\nSecond line."
stubbed app output result: "pasted"
stubbed terminal output result: "pasted"
live key dispatch: "NONE — every dispatch used a recording stub"
Stopped Electron and clipboard children process group 3897022
Stopped wl-copy sentinel process group 3897155
Owned processes still running: []
Hyprland instance folders after cleanup: ["efb50993780079460b0cbed1363e2166a2de1d9f_1789793874_889692923"]
```

No platform restores the previous clipboard after dictation, so Linux does not either. The transcript stays on the desktop clipboard through output settling. Cleanup retires the synthetic selection owner in its owned process group. [Recording stub arguments](../../artifacts/linux-hyprland-paste/hyprctl-arguments.jsonl) include both lock checks before each down, and app and terminal down/up chords. No dispatch in this proof reaches the compositor.

## Built renderer and gates

The two Linux Playwright specs run with Quickshell's Hyprland session environment exported, Node 24.21.0, one worker, and Sotto's scripted transcription and clipboard adapters. They exercise Linux compositor commands, onboarding, settings, copy/paste refusal, the hidden-window stale-selection result, retained text and both recording hints. The real clipboard and real paste paths are proved separately above.

Light, dark and reduced motion are checked at 1600×1000, 1280×800 and the 820×560 minimum. Copy text stays in the viewport and the document has no horizontal overflow. Native Electron captures keep painting awake while the session is locked; capture dimensions are checked against the requested viewport. Opened and inspected:

- [Onboarding, light, minimum size](../../artifacts/linux-hyprland-paste/onboarding-820x560-light.png).
- [Output settings, dark, minimum size](../../artifacts/linux-hyprland-paste/settings-820x560-dark.png).
- [Dictate, light, minimum size](../../artifacts/linux-hyprland-paste/dictate-820x560-light.png).
- [Clipboard failure widget](../../artifacts/linux-hyprland-paste/clipboard-failure-widget.png).
- [Retained text, light, minimum size](../../artifacts/linux-hyprland-paste/clipboard-recovery-820x560-light.png).
- [Retained text, dark, minimum size](../../artifacts/linux-hyprland-paste/clipboard-recovery-820x560-dark.png).

Final gates, each under `mise exec node@24.21.0 --`, with one suite at a time:

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed all three TypeScript projects. |
| `npm run lint` | Passed, no errors or warnings. |
| `npm test -- --maxWorkers=2` | 623 files passed, 50 skipped (673); 9,181 tests passed, 182 skipped (9,363). No failures. 475.97 seconds. |
| `npm run notices:verify` | Verified 174 third-party notice components. |
| Linux Playwright specs, `--workers=1` | Both files passed, all four tests, 12.5 seconds. Session environment exported; captures inspected. |
| `npm run build` | Passed. |
| Nested proof | Passed all three targets; no owned process or nested runtime folder remains. |
| Clipboard-only proof | Passed; no live dispatch and no owned process remains. |

Reviewed the diff twice: against AGENTS.md's privacy, platform, document and test rules, and against all nine review findings. Windows/macOS command builders, platform copy, runtime wiring and packaging remain unchanged. No finding remains in scope.
