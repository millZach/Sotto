# Dictation state and commands for the Omarchy shell

October 9, 2026. Ticket [#850](https://github.com/millZach/Sotto/issues/850), Sotto plumbing only, on `feat/linux-omarchy-shell-plumbing` from `6495c602`. The contract addendum follows `e691a9c6`, with the HOME-folder change in `a410b110`. Review fixes follow `55028971`; merge commit `bd1bcc75` brings in `origin/main` at `f77c40f2`, including the accepted Linux desktop ADR and AGENTS platform guidance.

**VERIFIED on forge:** the built, unpackaged Electron 43.1.0 app, with isolated profiles and HOME folders, driven through the checkout’s actual `apps/omarchy/sotto dictation …` command and Unix socket. Node 24.21.0 ran every Node command. Microphone samples, transcription failures and output effects used the existing development-only e2e fixtures; no paid provider or live microphone was needed. This verifies Sotto’s command, controller, state publication, placement and window boundaries, not provider availability or the separately built Quickshell plugin.

## Evidence

- [Real-check output](../../artifacts/linux-shell-plumbing/real-check.txt), verbatim, includes every state JSON with its actual main-process `pid`, folder mode `700`, file mode `600`, five shell-journey app PIDs, the absent state file after graceful and forced exits, the nested compositor PID and process and temporary-folder cleanup results.
- [Plugin folder present](../../artifacts/linux-shell-plumbing/plugin-present.png): the main window remains and the Electron widget is absent. Both Electron visibility and Hyprland’s mapped client list were checked before capture. The proof requests a native main-window frame first because the locked parent can suspend frame callbacks; compositor tiling and frame timing still control these captures.
- [Plugin folder removed](../../artifacts/linux-shell-plumbing/widget-returned.png): the Electron widget returns during dictation. Its placement here is controlled by the nested compositor; the shell pill’s layer-shell placement belongs to the other half of #850.

The proof creates an owned nested Hyprland through `systemd-run --user --scope`. It discovers that compositor by its PID, exports its own Wayland socket and Hyprland signature, and refuses the live signature before compositor observations. No key events reach the locked live session. Animations are disabled only in the nested config so captures show the final mapped state rather than unmap fade-out. Cleanup stops owned PIDs and scopes, removes only the owned instance folder, preserves pre-existing Hyprland instances and reports no remaining processes.

## Reproduce

After the documented install and runtime preparation, run from this worktree:

```sh
mise exec node@24.21.0 -- npm run build
mise exec node@24.21.0 -- node scripts/verify-shell-plumbing.mjs tests/e2e/linux-dictation-command.spec.ts tests/e2e/linux-platform-profile.spec.ts tests/e2e/linux-shell-plumbing.spec.ts
```

The wrapper creates one short owned `/tmp/sp-XXXXXX` folder with mode `0700`. Profiles and their isolated HOME folders, caches, Playwright transforms and test results, the nested compositor config and `TMPDIR` all live there, so Unix socket paths stay short regardless of the checkout path. Cleanup stops the owned processes before removing that folder, including on interruption, and prints the removed path. No root ignores conceal proof debris. The journey waits for published idle state before sending to a restarted app, rather than treating window readiness as socket readiness. The other Linux specs regenerate their existing captures; restore those incidental changes when the look was not changed on purpose. This change does not update design baselines.

## What was driven

Start and stop produced listening, a kept rate-limit failure, another kept failure on Retry, and a copied result on the next Retry. Another start and Cancel returned to idle. Automatic output produced delivered. All four `place` edges appeared in the state file and in placement record v3, and left survived restart. Unsafe edges and unknown verbs were refused. Creating the isolated `$HOME/.config/omarchy/plugins/sotto.dictation/` folder hid and unmapped the widget; removing it restored and mapped the widget during dictation. With the folder present before restart, the widget stayed hidden from startup. A second failed recording was retried and discarded, and Retry with no recording left idle unchanged. Separate runs observed transcribing and starting, then cancelled each to idle. Each of four graceful quits removed the file. A fifth run started listening and called Electron's `app.exit()` directly; the process exit hook removed the state file too, before the harness reaped any remaining raw-app handles by PID.

The state publisher takes only widget snapshots and reviewed static copy. It reconstructs the schema instead of serializing caller objects. Tests attach synthetic transcript, message and unknown error-code fields and inspect every write to prove they are excluded. Filesystem tests inspect the complete temporary JSON and old published JSON at rename, check inode replacement and mode, reject unsafe or replaced runtime folders, and prove a burst retains its final state without meter/progress writes. Window tests cover a plugin arriving during a pending reveal, normal hidden-idle policy, top on Linux and unchanged bottom defaults on Windows and macOS. Socket tests keep existing stamp ordering and the 40-byte limit, including shell verbs with valid, expired and future stamps.

## Gates

| Gate | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm test -- --maxWorkers=2` | PASS, 628 files and 9,353 tests; 50 files and 182 tests skipped |
| `npm run notices:verify` | PASS, 174 components |
| `npm run build` | PASS |
| Three Linux Playwright specs in the nested session | PASS, 5 tests |
| Built main/preload external dependency inventories | `allowlist check: PASS` |

## Review

1. **Forced exit:** `LinuxDictationShell` owns the publisher, socket and plugin monitor. Its Linux-only process exit handler synchronously unlinks the state and stops publication. It leaves native handles to separately idempotent runtime disposal. A unit test holds the drain past its ten-second timeout with listening state and checks removal without a second `before-quit`. The built-app journey also calls real `app.exit()` and observes Electron’s process exit event, then checks the absent file before the harness stops any remaining raw-app handles. This proves publication cleanup at the exit event; it does not assert that the raw app finishes by itself. Commits `8ddbb94d` and `b5045c96`.
2. **Startup after disposal:** the owner marks itself stopped before teardown, checks that flag before startup and immediately after its socket await, and creates nothing after disposal. A unit test holds real socket startup across disposal and checks that resuming leaves no state file or socket endpoint and cannot restart the resources. Commit `89b25096`.
3. **Script location:** the verifier lives in `scripts/`, imports its ownership helper from that folder, and uses the reproduction command above. There is no top-level `tools/` folder. Commit `d6cd1520`.
4. **Temporary files:** one private, short folder outside the checkout holds all proof profiles, caches, config and temporary output. Cleanup removes it after process termination. The broad root Git and ESLint ignores are removed; curated evidence rules remain. Old checkout-local proof config and transform caches were removed. A post-run `ls` confirms no proof profiles, cache folders or `tools/` remain in the checkout root. Commits `c5567f09` and `d4e47cdc`.
5. **Watcher reuse:** periodic refresh retains one watcher while its parent path and directory identity match. A changed or replaced parent, or a watcher error, re-arms it. Tests count watch creation across periodic checks and parent changes, alongside installation, removal and reinstall checks. Commit `5d834d2b`.
6. **Main merge:** `bd1bcc75` brings in the accepted Linux desktop ADR and platform guidance. The Linux command proof now walks that merged nine-step setup through the shared helpers, using Get started on Welcome and Continue on Shortcut. It retains the keyboard advance and the three-size dark, light and reduced-motion layout checks. Commit `93596cae` fixes its obsolete setup path.

Standards review: production changes are Linux-only; the widget’s Windows and macOS paths and defaults remain pinned by tests. Main adds no external module beyond the reviewed inventory. No transcript, audio, provider body or key enters this runtime file or an operational log. No runtime dependency, host, setting or permission grant was added. The plugin source and the main checkout were not edited.

Ticket review: the implementation follows the owner’s #850 decisions and [version-1 contract addendum](https://github.com/millZach/Sotto/issues/850#issuecomment-6084649108), including centred saved edges, top on Linux, the existing retry and dismiss actions, HOME-based widget ownership and the main-process pid in every state write. No new ADR decision was needed. Merge commit `bd1bcc75` brings in main’s accepted Linux guidance. Commit `9e3c503b` keeps the owl decision under its unique ADR-0064 number; that commit is retained as requested after the same correction landed through #873. The new term shell pill is added to CONTEXT. README and guide describe the new verbs, folder and schema.

## Re-review: unavailable runtime directory

Socket construction now runs inside `LinuxDictationShell.start()`, reached through the controller's guarded command-service startup. An unset or relative `XDG_RUNTIME_DIR` rejects that service, logs only `native-dictation-command-start-failed` and leaves shell state unpublished while Sotto continues opening. Stopped checks still precede construction and follow the socket await; disposal tolerates an unconstructed socket. Regression tests use the real shell owner and runtime controller for both invalid paths, assert main-window creation and reveal, no socket startup or command dispatch, no state publication, the stable event and safe disposal. The lifecycle file passes all 5 tests, including held startup and forced-exit cleanup. The final gates and built-app startup proof are recorded below after they run.

## Earlier kept-failure copy

Commit `91b373a5`. Every known error and the unknown-code fallback is checked with and without a kept recording. All details are under 60 characters, and every kept detail says “Recording kept.” The shell buttons provide Try again and Discard; key and credit failures keep the step needed before retry. The transcription reasons follow the Windows widget’s titles and kept-failure wording, shortened to fit the shell.

| Failure | Before | After (`kept: true`) | Characters |
| --- | --- | --- | --- |
| `MIC_PERMISSION_DENIED` | Microphone access was denied. Allow it, then try again. | Microphone access denied. Recording kept. | 41 |
| `MIC_DEVICE_NOT_FOUND` | No microphone was found. Connect one, then try again. | No microphone found. Recording kept. | 36 |
| `MIC_START_FAILED` | The microphone could not start. Try again. | Microphone could not start. Recording kept. | 43 |
| `MIC_NOT_SET_UP` | Set up your microphone in Settings. | No microphone set up. Recording kept. Check Settings. | 53 |
| `RECORDING_FAILED` | Recording stopped unexpectedly. Dictate again. | Recording stopped unexpectedly. Recording kept. | 47 |
| `NO_SPEECH` | No speech was heard. Dictate again. | No speech was heard. Recording kept. | 36 |
| `TRANSCRIPTION_UNCONFIGURED` | Add your OpenRouter key in Settings. | No OpenRouter key. Recording kept. Add it in Settings. | 54 |
| `TRANSCRIPTION_UNAUTHORIZED` | OpenRouter rejected the key. Check it in Settings. | API key rejected. Recording kept. Check it in Settings. | 55 |
| `TRANSCRIPTION_OFFLINE` | Sotto could not reach OpenRouter. Check your connection. | Sotto could not reach OpenRouter. Recording kept. | 49 |
| `TRANSCRIPTION_BILLING` | OpenRouter has no credit left. Add credit, then try again. | OpenRouter has no credit. Recording kept. Add credit. | 53 |
| `TRANSCRIPTION_RATE_LIMITED` | The transcription service is busy. Try again in a moment. | The transcription service is busy. Recording kept. | 50 |
| `TRANSCRIPTION_SERVICE_ERROR` | OpenRouter could not transcribe. Try again. | OpenRouter returned an error. Recording kept. | 45 |
| `TRANSCRIPTION_FAILED` | Sotto did not get usable text back. Try again. | Sotto did not get usable text back. Recording kept. | 51 |
| `OUTPUT_UNAVAILABLE` | Text could not be delivered. Open Sotto to check it. | Text could not be delivered. Recording kept. Open Sotto. | 56 |
| `OUTPUT_FAILED` | Text could not be delivered. Open Sotto to check it. | Text could not be delivered. Recording kept. Open Sotto. | 56 |
| `DESKTOP_CLIPBOARD_UNAVAILABLE` | Text kept in Sotto. Open Dictate to copy it. | Clipboard unavailable. Recording kept. Open Dictate. | 52 |
| `HISTORY_FAILED` | Text was delivered, but history could not be saved. | Text delivered; history failed. Recording kept. | 47 |
| `SETTINGS_UNAVAILABLE` | Settings could not be read. Open Sotto and try again. | Settings could not be read. Recording kept. Open Sotto. | 55 |
| Unknown code | Dictation failed. Open Sotto to try again. | Dictation failed. Recording kept. | 32 |

## Re-review: recording and text outcomes

The refined contract distinguishes six failures before any usable recording from twelve failures after captured audio. The two static copy maps form an exhaustive, disjoint partition of `WidgetErrorCode`; tests independently enumerate both groups and require every code exactly once. Every captured failure with `kept: false` positively states loss or names where the text is. Every `kept: true` detail says “Recording kept.”, even for a synthetic kept snapshot of a pre-recording error. Both unknown-code outcomes start “Dictation failed.” and follow `kept`. All 38 known/fallback variants stay under 60 characters and reject unreviewed provider copy.

The actual controller retains completed output before attempting history for `OUTPUT_UNAVAILABLE`, `OUTPUT_FAILED` and `DESKTOP_CLIPBOARD_UNAVAILABLE`. AppContext keeps those entries in Dictate’s selectable recovery list, independent of history; a history save failure does not erase them. The existing controller tests cover unavailable, empty and throwing delivery, history off and history failure. `HISTORY_FAILED` alone follows successful clipboard delivery, so its copy points to the clipboard. Nothing about retention itself changed. The guide now describes these outcomes. Focused copy/state tests pass all 40 tests; the controller file passes all 92 tests.

This table compares all copy with the re-reviewed `125df400` baseline. The group describes `kept: false`; an explicit `kept: true` always reports a kept recording.

| Code | Group when not kept | Before (`kept: false`) | After (`kept: false`) | Before (`kept: true`) | After (`kept: true`) |
| --- | --- | --- | --- | --- | --- |
| `MIC_PERMISSION_DENIED` | Nothing recorded | Microphone access was denied. Allow it, then try again. | Microphone access was denied. Allow it, then try again. | Microphone access denied. Recording kept. | Microphone access denied. Recording kept. |
| `MIC_DEVICE_NOT_FOUND` | Nothing recorded | No microphone was found. Connect one, then try again. | No microphone was found. Connect one, then try again. | No microphone found. Recording kept. | No microphone found. Recording kept. |
| `MIC_START_FAILED` | Nothing recorded | The microphone could not start. Try again. | The microphone could not start. Try again. | Microphone could not start. Recording kept. | Microphone could not start. Recording kept. |
| `MIC_NOT_SET_UP` | Nothing recorded | Set up your microphone in Settings. | Set up your microphone in Settings. | No microphone set up. Recording kept. Check Settings. | No microphone set up. Recording kept. Check Settings. |
| `RECORDING_FAILED` | Audio captured; recording gone or text retained | Recording stopped unexpectedly. Dictate again. | Recording stopped and was lost. Dictate again. | Recording stopped unexpectedly. Recording kept. | Recording stopped unexpectedly. Recording kept. |
| `NO_SPEECH` | Nothing recorded | No speech was heard. Dictate again. | No speech was heard. Dictate again. | No speech was heard. Recording kept. | No speech was heard. Recording kept. |
| `TRANSCRIPTION_UNCONFIGURED` | Audio captured; recording gone or text retained | Add your OpenRouter key in Settings. | No OpenRouter key. Recording lost. Add it in Settings. | No OpenRouter key. Recording kept. Add it in Settings. | No OpenRouter key. Recording kept. Add it in Settings. |
| `TRANSCRIPTION_UNAUTHORIZED` | Audio captured; recording gone or text retained | OpenRouter rejected the key. Check it in Settings. | OpenRouter key rejected. Recording lost. Check Settings. | API key rejected. Recording kept. Check it in Settings. | API key rejected. Recording kept. Check it in Settings. |
| `TRANSCRIPTION_OFFLINE` | Audio captured; recording gone or text retained | Sotto could not reach OpenRouter. Check your connection. | OpenRouter unreachable. Recording lost. Check connection. | Sotto could not reach OpenRouter. Recording kept. | Sotto could not reach OpenRouter. Recording kept. |
| `TRANSCRIPTION_BILLING` | Audio captured; recording gone or text retained | OpenRouter has no credit left. Add credit, then try again. | OpenRouter has no credit. Recording lost. Add credit. | OpenRouter has no credit. Recording kept. Add credit. | OpenRouter has no credit. Recording kept. Add credit. |
| `TRANSCRIPTION_RATE_LIMITED` | Audio captured; recording gone or text retained | The transcription service is busy. Try again in a moment. | Transcription busy. Recording lost. Dictate again later. | The transcription service is busy. Recording kept. | The transcription service is busy. Recording kept. |
| `TRANSCRIPTION_SERVICE_ERROR` | Audio captured; recording gone or text retained | OpenRouter could not transcribe. Try again. | OpenRouter error. Recording lost. Dictate again. | OpenRouter returned an error. Recording kept. | OpenRouter returned an error. Recording kept. |
| `TRANSCRIPTION_FAILED` | Audio captured; recording gone or text retained | Sotto did not get usable text back. Try again. | No usable text returned. Recording lost. Dictate again. | Sotto did not get usable text back. Recording kept. | Sotto did not get usable text back. Recording kept. |
| `OUTPUT_UNAVAILABLE` | Audio captured; recording gone or text retained | Text could not be delivered. Open Sotto to check it. | Text kept in Sotto. Open Dictate to copy it. | Text could not be delivered. Recording kept. Open Sotto. | Text could not be delivered. Recording kept. Open Sotto. |
| `OUTPUT_FAILED` | Audio captured; recording gone or text retained | Text could not be delivered. Open Sotto to check it. | Text kept in Sotto. Open Dictate to copy it. | Text could not be delivered. Recording kept. Open Sotto. | Text could not be delivered. Recording kept. Open Sotto. |
| `DESKTOP_CLIPBOARD_UNAVAILABLE` | Audio captured; recording gone or text retained | Text kept in Sotto. Open Dictate to copy it. | Text kept in Sotto. Open Dictate to copy it. | Clipboard unavailable. Recording kept. Open Dictate. | Clipboard unavailable. Recording kept. Open Dictate. |
| `HISTORY_FAILED` | Audio captured; recording gone or text retained | Text was delivered, but history could not be saved. | Text on clipboard. History not saved. Paste with Super+V. | Text delivered; history failed. Recording kept. | Text delivered; history failed. Recording kept. |
| `SETTINGS_UNAVAILABLE` | Nothing recorded | Settings could not be read. Open Sotto and try again. | Settings could not be read. Open Sotto and try again. | Settings could not be read. Recording kept. Open Sotto. | Settings could not be read. Recording kept. Open Sotto. |
| Unknown code | Outcome follows `kept` | Dictation failed. Open Sotto to try again. | Dictation failed. Recording lost. Dictate again. | Dictation failed. Recording kept. | Dictation failed. Recording kept. |

## Notes for the plugin

The file is replaced by rename; watch the containing folder or re-arm a file watch after replacement. Status bursts coalesce within 50 ms, so short intermediate states may not be observed. The final state is retained. There is no heartbeat: meter/progress changes do not advance `updatedAt`, and a long listening session can legitimately keep the same timestamp. Treat a missing file as idle. `since` changes with the state; edge-only changes leave it alone. `discard` routes to the widget’s existing dismiss action, separate from Cancel, which preserves a kept recording during retry. The request limit remains 40 bytes.

## Contract addendum: plugin folder

The watch follows Omarchy’s `PluginRegistry.qml`: `$HOME/.config/omarchy/plugins/sotto.dictation/`, regardless of `XDG_CONFIG_HOME`. The monitor no longer accepts a config-home override. Its regression test leaves a plugin installed under an alternate XDG config folder and observes only HOME-folder installation and removal. The built-app journey uses an isolated HOME inside its owned temporary profile and leaves the alternate XDG plugin in place while the HOME plugin hides, restores and hides the widget across restart. The two focused monitor and lifecycle files pass all 9 tests. The complete gates and nested proof passed again with the pid addition below. The alternate XDG plugin remained installed while the HOME plugin was removed; the Electron widget returned and mapped in the nested compositor. Both cited captures were opened and inspected.

## Contract addendum: main process ID

The additive version-1 field `pid` is initialized from `process.pid` in main and retained through state and placement updates. Atomic-write tests inspect it in the old and replacement JSON; debounce tests reject a caller-supplied pid, and failure-copy tests inspect every serialized write. The built-app journey compares each published pid with its actual Electron main PID across five launches, including startup, listening, processing, failure, success, placement and the forced-exit check. Readers still use version 1. The file has no heartbeat, so a long dictation does not change `updatedAt` merely to show liveness. The plugin’s process-liveness handling belongs to its separate branch.

The latest proof passed all five tests across the three Linux specs in 27.6 seconds. Main PID `899178` published listening while the isolated HOME plugin was present; restart published PID `899718`, and the other launches published `899906`, `900126` and `900274`. Every state kept version 1, folder mode `700` and file mode `600`. The allowlist printed `allowlist check: PASS` before the proof. Incidental Linux paste captures were restored; only the cited shell-plumbing evidence is updated. Cleanup stopped nested Hyprland PID `898291` and Playwright PID `898305`, reported empty recorded-PID, cgroup and owned-process lists, preserved earlier Hyprland instances and removed `/tmp/sp-pMQVFA`. The checkout root has no proof profiles, Chromium scope folders, transform caches or `tools/`; the empty test-results folder from the unit gate was removed.
