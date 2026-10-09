# Dictation state and commands for the Omarchy shell

October 9, 2026. Ticket [#850](https://github.com/millZach/Sotto/issues/850), Sotto plumbing only, on `feat/linux-omarchy-shell-plumbing` from `6495c602`. Review fixes follow `55028971`; merge commit `bd1bcc75` brings in `origin/main` at `f77c40f2`, including the accepted Linux desktop ADR and AGENTS platform guidance.

**VERIFIED on forge:** the built, unpackaged Electron 43.1.0 app, with isolated profiles and XDG config folders, driven through the checkout’s actual `apps/omarchy/sotto dictation …` command and Unix socket. Node 24.21.0 ran every Node command. Microphone samples, transcription failures and output effects used the existing development-only e2e fixtures; no paid provider or live microphone was needed. This verifies Sotto’s command, controller, state publication, placement and window boundaries, not provider availability or the separately built Quickshell plugin.

## Evidence

- [Real-check output](../../artifacts/linux-shell-plumbing/real-check.txt), verbatim, includes every state JSON, folder mode `700`, file mode `600`, five shell-journey app PIDs, the absent state file after graceful and forced exits, the nested compositor PID and process and temporary-folder cleanup results.
- [Plugin folder present](../../artifacts/linux-shell-plumbing/plugin-present.png): the main window remains and the Electron widget is absent. Both Electron visibility and Hyprland’s mapped client list were checked before capture. The proof requests a native main-window frame first because the locked parent can suspend frame callbacks; compositor tiling and frame timing still control these captures.
- [Plugin folder removed](../../artifacts/linux-shell-plumbing/widget-returned.png): the Electron widget returns during dictation. Its placement here is controlled by the nested compositor; the shell pill’s layer-shell placement belongs to the other half of #850.

The proof creates an owned nested Hyprland through `systemd-run --user --scope`. It discovers that compositor by its PID, exports its own Wayland socket and Hyprland signature, and refuses the live signature before compositor observations. No key events reach the locked live session. Animations are disabled only in the nested config so captures show the final mapped state rather than unmap fade-out. Cleanup stops owned PIDs and scopes, removes only the owned instance folder, preserves pre-existing Hyprland instances and reports no remaining processes.

## Reproduce

After the documented install and runtime preparation, run from this worktree:

```sh
mise exec node@24.21.0 -- npm run build
mise exec node@24.21.0 -- node scripts/verify-shell-plumbing.mjs tests/e2e/linux-dictation-command.spec.ts tests/e2e/linux-platform-profile.spec.ts tests/e2e/linux-shell-plumbing.spec.ts
```

The wrapper creates one short owned `/tmp/sp-XXXXXX` folder with mode `0700`. Profiles, caches, Playwright transforms and test results, the nested compositor config and `TMPDIR` all live there, so Unix socket paths stay short regardless of the checkout path. Cleanup stops the owned processes before removing that folder, including on interruption, and prints the removed path. No root ignores conceal proof debris. The journey waits for published idle state before sending to a restarted app, rather than treating window readiness as socket readiness. The other Linux specs regenerate their existing captures; restore those incidental changes when the look was not changed on purpose. This change does not update design baselines.

## What was driven

Start and stop produced listening, a kept rate-limit failure, another kept failure on Retry, and a copied result on the next Retry. Another start and Cancel returned to idle. Automatic output produced delivered. All four `place` edges appeared in the state file and in placement record v3, and left survived restart. Unsafe edges and unknown verbs were refused. Creating the isolated plugin folder hid and unmapped the widget; removing it restored and mapped the widget during dictation. With the folder present before restart, the widget stayed hidden from startup. A second failed recording was retried and discarded, and Retry with no recording left idle unchanged. Separate runs observed transcribing and starting, then cancelled each to idle. Each of four graceful quits removed the file. A fifth run started listening and called Electron's `app.exit()` directly; the process exit hook removed the state file too, before the harness reaped any remaining raw-app handles by PID.

The state publisher takes only widget snapshots and reviewed static copy. It reconstructs the schema instead of serializing caller objects. Tests attach synthetic transcript, message and unknown error-code fields and inspect every write to prove they are excluded. Filesystem tests inspect the complete temporary JSON and old published JSON at rename, check inode replacement and mode, reject unsafe or replaced runtime folders, and prove a burst retains its final state without meter/progress writes. Window tests cover a plugin arriving during a pending reveal, normal hidden-idle policy, top on Linux and unchanged bottom defaults on Windows and macOS. Socket tests keep existing stamp ordering and the 40-byte limit, including shell verbs with valid, expired and future stamps.

## Gates

| Gate | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm test -- --maxWorkers=2` | PASS, 628 files and 9,352 tests; 50 files and 182 tests skipped |
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

Ticket review: the implementation follows the owner’s last #850 comment, including centred saved edges, top on Linux, the existing retry and dismiss actions, and folder-based widget ownership. No new ADR decision was needed. Merge commit `bd1bcc75` brings in main’s accepted Linux guidance. Commit `9e3c503b` keeps the owl decision under its unique ADR-0064 number; that commit is retained as requested after the same correction landed through #873. The new term shell pill is added to CONTEXT. README and guide describe the new verbs, folder and schema.

## Kept-failure copy

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

## Notes for the plugin

The file is replaced by rename; watch the containing folder or re-arm a file watch after replacement. Status bursts coalesce within 50 ms, so short intermediate states may not be observed. The final state is retained. There is no heartbeat: meter/progress changes do not advance `updatedAt`, and a long listening session can legitimately keep the same timestamp. Treat a missing file as idle. `since` changes with the state; edge-only changes leave it alone. `discard` routes to the widget’s existing dismiss action, separate from Cancel, which preserves a kept recording during retry. The request limit remains 40 bytes.
