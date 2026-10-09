# Dictation state and commands for the Omarchy shell

October 9, 2026. Ticket [#850](https://github.com/millZach/Sotto/issues/850), Sotto plumbing only, on `feat/linux-omarchy-shell-plumbing` from `6495c602`.

**VERIFIED on forge:** the built, unpackaged Electron 43.1.0 app, with isolated profiles and XDG config folders, driven through the checkout’s actual `apps/omarchy/sotto dictation …` command and Unix socket. Node 24.21.0 ran every Node command. Microphone samples, transcription failures and output effects used the existing development-only e2e fixtures; no paid provider or live microphone was needed. This verifies Sotto’s command, controller, state publication, placement and window boundaries, not provider availability or the separately built Quickshell plugin.

## Evidence

- [Real-check output](../../artifacts/linux-shell-plumbing/real-check.txt), verbatim, includes every state JSON, folder mode `700`, file mode `600`, four app PIDs, each quit’s absent state file, the nested compositor PID and process cleanup results.
- [Plugin folder present](../../artifacts/linux-shell-plumbing/plugin-present.png): the main window remains and the Electron widget is absent. Both Electron visibility and Hyprland’s mapped client list were checked before capture.
- [Plugin folder removed](../../artifacts/linux-shell-plumbing/widget-returned.png): the Electron widget returns during dictation. Its placement here is controlled by the nested compositor; the shell pill’s layer-shell placement belongs to the other half of #850.

The proof creates an owned nested Hyprland through `systemd-run --user --scope`. It discovers that compositor by its PID, exports its own Wayland socket and Hyprland signature, and refuses the live signature before compositor observations. No key events reach the locked live session. Animations are disabled only in the nested config so captures show the final mapped state rather than unmap fade-out. Cleanup stops owned PIDs and scopes, removes only the owned instance folder, preserves pre-existing Hyprland instances and reports no remaining processes.

## Reproduce

After the documented install and runtime preparation, run from this worktree:

```sh
mise exec node@24.21.0 -- npm run build
mise exec node@24.21.0 -- node tools/verify-shell-plumbing.mjs tests/e2e/linux-dictation-command.spec.ts tests/e2e/linux-platform-profile.spec.ts tests/e2e/linux-shell-plumbing.spec.ts
```

The wrapper keeps temporary profiles in the worktree root: a longer temporary path exceeds Linux’s Unix socket path limit for Chromium or the dictation listener. Generated profiles and Playwright transforms are ignored. The journey waits for published idle state before sending to a restarted app, rather than treating window readiness as socket readiness. The other Linux specs regenerate their existing captures; restore those incidental changes when the look was not changed on purpose. This change does not update design baselines.

## What was driven

Start and stop produced listening, a kept rate-limit failure, another kept failure on Retry, and a copied result on the next Retry. Another start and Cancel returned to idle. Automatic output produced delivered. All four `place` edges appeared in the state file and in placement record v3, and left survived restart. Unsafe edges and unknown verbs were refused. Creating the isolated plugin folder hid and unmapped the widget; removing it restored and mapped the widget during dictation. With the folder present before restart, the widget stayed hidden from startup. A second failed recording was retried and discarded, and Retry with no recording left idle unchanged. Separate runs observed transcribing and starting, then cancelled each to idle. Each of four graceful quits removed the file.

The state publisher takes only widget snapshots and reviewed static copy. It reconstructs the schema instead of serializing caller objects. Tests attach synthetic transcript, message and unknown error-code fields and inspect every write to prove they are excluded. Filesystem tests inspect the complete temporary JSON and old published JSON at rename, check inode replacement and mode, reject unsafe or replaced runtime folders, and prove a burst retains its final state without meter/progress writes. Window tests cover a plugin arriving during a pending reveal, normal hidden-idle policy, top on Linux and unchanged bottom defaults on Windows and macOS. Socket tests keep existing stamp ordering and the 40-byte limit, including shell verbs with valid, expired and future stamps.

## Gates

| Gate | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm test -- --maxWorkers=2` | PASS, 625 files and 9,279 tests; 50 files and 182 tests skipped |
| `npm run notices:verify` | PASS, 174 components |
| `npm run build` | PASS |
| Three Linux Playwright specs in the nested session | PASS, 5 tests |
| Built main/preload external dependency inventories | `allowlist check: PASS` |

## Review

Standards review: production changes are Linux-only; the widget’s Windows and macOS paths and defaults remain pinned by tests. Main adds no external module beyond the reviewed inventory. No transcript, audio, provider body or key enters this runtime file or an operational log. No runtime dependency, host, setting or permission grant was added. The plugin source and the main checkout were not edited.

Ticket review: the implementation follows the owner’s last #850 comment, including centred saved edges, top on Linux, the existing retry and dismiss actions, and folder-based widget ownership. No new ADR decision was needed. The new term shell pill is added to CONTEXT. README and guide describe the new verbs, folder and schema.

## Notes for the plugin

The file is replaced by rename; watch the containing folder or re-arm a file watch after replacement. Status bursts coalesce within 50 ms, so short intermediate states may not be observed. The final state is retained. There is no heartbeat: meter/progress changes do not advance `updatedAt`, and a long listening session can legitimately keep the same timestamp. Treat a missing file as idle. `since` changes with the state; edge-only changes leave it alone. `discard` routes to the widget’s existing dismiss action, separate from Cancel, which preserves a kept recording during retry. The request limit remains 40 bytes.
