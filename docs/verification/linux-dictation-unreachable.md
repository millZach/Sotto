# Linux dictation command feedback

October 11, 2026 (Pacific). Branch `fix/linux-dictation-unreachable`, based on `82f7da274` (the merge of #953), Node 24.21.0 and Electron 43.1.0 on forge. Omarchy 4.0.4-1, Quickshell 0.3.1-1, Hyprland 0.56.2-2, libnotify 0.8.8-1, wtype 0.4-2 and ydotool 1.0.4-2.

## Notification

Copy for start and toggle: **Sotto isn't open. Open Sotto, then try again.** The hotkey does not launch Sotto because a cold start that immediately opens the microphone would surprise people.

The installed daemon does not group by app name. `NotificationLogic.js` snapshots `appName` and `appIcon`; `Service.qml` tracks replacement by `originalId`, inserts new IDs into `popupModel`, and renders one card per row. The old mako grouping behavior and the Quickshell regression are also described in [Omarchy #10145](https://github.com/omacom/omarchy/issues/10145). `notify-send` receives `--app-name Sotto --app-icon sotto --icon sotto`. The first real press exposed a missing icon: with libnotify 0.8.8, `--icon` is the content image and Omarchy draws `appIcon`. Adding `--app-icon` fixed the rendered card, and the unit expectation was updated. The [libnotify CLI source](https://github.com/GNOME/libnotify/blob/master/tools/notify-send.c) documents these separate fields. Sotto supplies the cooldown independently of the daemon.

A throwaway HTML copy preview was made before the patch. The desktop owns the final card layout. The preview is retained in this checkout at `.cache/dictation-unreachable/notification-prototype.html`; it is not part of the app.

**VERIFIED:** two real F9 taps with Sotto closed showed one notification with Sotto's owl icon. The app remained closed and no windows opened or closed. Opened and inspected the [grim capture](../../artifacts/linux-dictation-unreachable/f9-notification.png); the [observations](../../artifacts/linux-dictation-unreachable/notification-proof.json) record the fixed copy, icon, two taps and one notification.

The desktop was left to its other tester until `/home/zach/.zstack/live-busy` cleared. The environment came from the live Quickshell process, and `hyprctl locked -j` was false before any input. Sotto's existing F9 binding runs `sotto` through PATH. For this proof only, `hl.env` briefly put this checkout's `apps/omarchy/` first in the compositor PATH; the existing binding therefore ran the built branch's launcher. It was restored in `finally`, and the binding list was unchanged. No configuration file was edited. Input was `YDOTOOL_SOCKET=$XDG_RUNTIME_DIR/.ydotool_socket ydotool key 67:1 67:0`, including both down and up. `grim -g '1400,20 520x260'` captured the notification itself. No dictation took place.

The notification was tested with the checkout's built Electron command client and the desktop's installed icon. The installed `/opt/sotto` package was not replaced.

The [capture is also served on forge's tailnet](https://forge.tail5728ca.ts.net/linux-dictation-unreachable/f9-notification.png) for laptop and phone review. It returned HTTP 200. The preview serves only this evidence folder and stays up for review. From this checkout, bring it back with:

```sh
XDG_STATE_HOME="$PWD/.cache/checkpoint-state" bash /home/zach/.codex/skills/checkpoint/scripts/preview.sh up linux-dictation-unreachable "$PWD/artifacts/linux-dictation-unreachable"
```

Use the same command with `down linux-dictation-unreachable` instead of `up` and the directory to stop it when review is over.

## Clipboard proof

The proof now seeds **Wrong clipboard: this must be replaced** before Sotto delivers each synthetic text; foot also gets the different PRIMARY sentinel. The Chromium result can only pass if Sotto replaces the clipboard and pastes the expected text.

After `mise exec node@24.21.0 -- npm run build`, with the live desktop available and unlocked:

```sh
mise exec node@24.21.0 -- node scripts/verify-hyprland-paste-keyboards.mjs artifacts/linux-dictation-unreachable
```

**VERIFIED: all four cases passed.** Each returned `pasted`, kept the target focused, and received exactly `x` followed by the synthetic delivered text, including accents and emoji. [Results JSON](../../artifacts/linux-dictation-unreachable/results.json) and [complete proof output](../../artifacts/linux-dictation-unreachable/paste-proof.txt) retain the assertions and cleanup.

| Target | Last keyboard | Result | Capture |
| --- | --- | --- | --- |
| Chromium | wtype | Exact text; pasted | [Screen](../../artifacts/linux-dictation-unreachable/chromium-wtype.png) |
| Chromium | ydotool | Exact text; pasted | [Screen](../../artifacts/linux-dictation-unreachable/chromium-ydotool.png) |
| stock foot | wtype | Exact text; pasted | [Screen](../../artifacts/linux-dictation-unreachable/foot-wtype.png) |
| stock foot | ydotool | Exact text; pasted | [Screen](../../artifacts/linux-dictation-unreachable/foot-ydotool.png) |

All captures were opened and inspected. The terminal intentionally has echo off, so its screenshot shows focus rather than pasted text; its received bytes are checked and saved in the results. The script quit only its own Sotto, Chromium, foot and clipboard owners, restored the previous focus, and reported zero owned processes left running.

## Automated verification

- `mise exec node@24.21.0 -- npm test -- --maxWorkers=2 tests/unit/main/dictationClient.test.ts tests/unit/main/dictationUnavailableNotice.test.ts tests/integration/dictationUnavailable.test.ts tests/integration/dictationSocket.test.ts`: 88 passed.
- Real child clients and a recording notify-send fixture prove one notification across an F9 start/stop pair, cancellation, concurrent repeats and cooldown expiry, plus refused sockets, accepted/rejected commands and SIGKILL recovery.
- Unit coverage checks argv, fixed copy, quiet verbs, invalid runtime and endpoint, notification failure, timeouts and rejected replies.
- Independent standards review: no findings. Independent specification review: no findings. Both read the batch through the implementation commits and the lock-recovery follow-up; neither ran suites or touched the live desktop.

The gates for the lock-recovery revision ran sequentially with Node 24.21.0:

```sh
mise exec node@24.21.0 -- npm run typecheck
mise exec node@24.21.0 -- npm run lint
mise exec node@24.21.0 -- npm test -- --maxWorkers=2
mise exec node@24.21.0 -- npm run notices:verify
```

**VERIFIED:** typecheck and lint passed; 781 test files passed and 55 were skipped, with 9,827 tests passed and 194 skipped; 189 notice components verified. The first full run had one failure in `watcherTools.test.ts` ("refunds a queued prompt after a definite reconciled failure exactly once"). Its isolated rerun passed all 57 tests, then the entire suite above passed. It was repeated after the lock-recovery fix and passed with the counts shown here.

After the build, the affected Playwright spec ran on an owned nested compositor:

```sh
mise exec node@24.21.0 -- node scripts/with-nested-hyprland.mjs .cache/dictation-unreachable/nested npx playwright test tests/e2e/linux-dictation-command.spec.ts --workers=1
```

**VERIFIED:** one spec passed. It exercises compositor start/stop/toggle/cancel commands and quick taps, then checks light, dark and reduced-motion layouts at 1600×1000, 1280×800 and 820×560. The nested compositor and its owned scopes were cleaned up. No design baselines changed; Omarchy draws the notification.

**PASS:** the production dependency allowlist is exactly `node-pty`, `sherpa-onnx-node` and `zod`. The built main/preload external inventories passed `verifyExternalDependencyInventories` from `scripts/release-external-dependencies.mjs`, and each dependency's installed package was present.

## Review recovery

PR #958's review identified that a client killed between claiming the directory lock and its cleanup could suppress every later notification. A real-client fixture reproduced it: it pauses after lock acquisition and before the stamp write, then is killed with SIGKILL. Eight subsequent clients produced no notice before the fix.

`deb07e4af` replaces the directory lock with a Linux abstract Unix socket scoped to the runtime directory's uid/device/inode. No files hold lock ownership, and [Node 24's IPC documentation](https://github.com/nodejs/node/blob/v24.21.0/doc/api/net.md#identifying-paths-for-ipc-connections) confirms the kernel removes an abstract socket when its references close. The empty file still supplies the five-second cooldown. The fixture now verifies another client stays quiet while the owner is alive; after SIGKILL, eight concurrent clients produce exactly one notification. It passed with the fix. An older client's abandoned directory also no longer prevents a notice, and is left intact.

The build, all four live paste cases, real F9 proof and affected Playwright spec were repeated against this follow-up. All passed, and the refreshed observations name the implementation commit. Both review axes checked it again with no findings.


## Shared copy

A later review noted that a custom start binding could name a different key. `6316d2511` gives start the same neutral next step as toggle: **Open Sotto, then try again.** The guide's general instructions still apply. The Omarchy README, copy preview and exact-argv tests match the final copy.

**VERIFIED after this copy refinement:** 88 focused tests passed; typecheck, lint, build and notices passed. Both independent reviews found no issue. Two more real F9 taps with the rebuilt client and Sotto closed produced one notice with Sotto's icon. The refreshed capture and notification observations above are from this revision, and the exact served image URL returned HTTP 200 and was opened and inspected. The full-suite counts above are from the lock-recovery revision; the final copy change was checked with these focused tests and the real press. The clipboard script and paste path did not change in this refinement.

## Gate fixture recovery

October 12: repeating the full suite on `188a3a2f` reproduced the Watcher failure named above: 9,826 passed, 194 skipped, one failed. The fixture changed a failed receipt back to uncertain after the observer could already refund its reservation. That left a pre-refund receipt with a post-refund budget, so the next refresh refunded it again.

The same failure was reproduced against the original `82f7da274` source and tests, projected into this checkout's ignored cache. Adding one explicit refresh immediately before the original fixture rewound the receipt forced the observer to finish first; the assertion then received 0 instead of 1. This was an instrumented scheduling reproduction, not an unmodified main-suite run. Restoring the uncertain receipt and its reserved count of 2 together made that same case pass against main's production source.

The fixture now explicitly observes the failure before restoring both fields as a consistent stale checkpoint. Existing assertions still require exactly one refund, no duplicate command, retry refusal and the prompt limit. Production Watcher code is unchanged. **VERIFIED:** all 57 Watcher tool tests passed; independent standards and specification reviews found no issue. A new full gate run follows this correction; its result is recorded in PR #958. The desktop proofs above remain applicable because this correction changes only test setup.
