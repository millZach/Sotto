# Linux main-window minimum

October 11, 2026. Follow-up to [#833](https://github.com/millZach/Sotto/issues/833), on `fix/linux-window-minimum`, initially based on `2bcc127a` and merged with main `73e4f8c8` after its guide edit overlapped this change. Merge `fa48a2e6` then brought in main `e1785ce2` after #932 changed the same Watcher fixture.

## Cause and correction

Electron 43.1.0's [Linux window host](https://github.com/electron/electron/blob/v43.1.0/shell/browser/ui/electron_desktop_window_tree_host_linux.cc#L102) inflates minimum constraints by the restored frame insets. Its [frame layout](https://github.com/electron/electron/blob/v43.1.0/shell/browser/ui/views/electron_frame_view_layout_linux.cc#L24) returns zero insets for a transparent native surface. A frameless window without that flag still gets the resize-border insets, even when its visible content and window bounds coincide. The extra 10 pixels on each side explain the observed 840×580 content floor for an 820×560 constraint.

Linux alone now requests the transparent native surface. The main window keeps its existing solid black background and the renderer paints its usual opaque room; this does not offer frost on Linux. Minimum constants remain 820 and 560. There is no fixed-pixel subtraction, Wayland environment detection or change to the widget. The complete Windows and macOS constructor options remain pinned by their existing strict tests; a new strict Linux test pins its options, background and minimum.

## Native proof

**VERIFIED on forge:** the built, unpackaged Sotto 0.1.37, Electron 43.1.0 and Hyprland 0.56.2 on native Wayland. The main build's SHA-256 is `d27d1c9d3376a6064ec44e3e2ff622d4b8382124f9b9413dc0c9d5e67547604c`; the source commit in the latest observations is `cfd48a2f`, including the harness review fixes and private bus configuration. This build includes the merged Omarchy theme work.

The isolated Electron probe produced these actual renderer/content floors after a 100×100 compositor resize, with minimum constraints of 820×560 in every case:

| Constructor option | Renderer and content minimum |
| --- | --- |
| Default frameless | 840×580 |
| `useContentSize: true` | 840×580 |
| `hasShadow: false` | 840×580 |
| `transparent: true` | 820×560 |

[probe.json](../../artifacts/linux-window-minimum/probe.json) records the constructor options, compositor size, window bounds, Electron content/minimum and renderer size.

All eight built-app measurements passed: 1600×1000, 1280×800, 820×560 and a 100×100 request in both Light and Dark. The last clamps to exactly 820×560. Electron's reported minimum stayed 820×560 throughout; no minimum override, viewport emulation or setContentSize was used. [sizes.json](../../artifacts/linux-window-minimum/sizes.json) records all observations. The final harness asserts that compositor size, Electron content and renderer size all agree, and that Electron’s minimum stays 820×560. Root scroll dimensions equal the viewport; there is no horizontal page overflow.

The four 820×560 frames were captured with grim on the owned nested output and opened for inspection. Threads' sidebar, search, empty room, mode tabs and footer controls fit. Settings' fixed column, mode controls and two theme columns fit; its long content and category list scroll vertically, with no inaccessible clipped control. The room stays opaque in both modes.

- [Light Threads](../../artifacts/linux-window-minimum/minimum-light.png)
- [Dark Threads](../../artifacts/linux-window-minimum/minimum-dark.png)
- [Light Settings](../../artifacts/linux-window-minimum/minimum-settings-light.png)
- [Dark Settings](../../artifacts/linux-window-minimum/minimum-settings-dark.png)

[proof.txt](../../artifacts/linux-window-minimum/proof.txt) records the final passing native run and owned cleanup: sizing PID 1688851, session PID 1688905 and private journey PID 1688930 stopped; all recorded PIDs/cgroups were empty. Both owned instance folders and `/tmp/slm-0n56IF` were removed. Prior instances and all four protected live trees, including `.sotto`, were unchanged. The whole harness exited successfully. Earlier repeats that detected concurrent live-host state changes are recorded below.

The [repeatable harness](../../scripts/verify-linux-window-minimum.mjs) compares Electron options with `--probe`, then drives the built app without changing its minimum. It floats and resizes only the owned main window through the nested Hyprland instance and reads content size from both Electron and the renderer. It checks 1600×1000, 1280×800, 820×560 and a below-minimum request in Light and Dark, with reduced motion enabled. It captures with grim, never the desktop portal.

## Reproduce

```sh
mise exec node@24.21.0 -- npm ci
mise exec node@24.21.0 -- node node_modules/electron/install.js
mise exec node@24.21.0 -- npm run build
mise exec node@24.21.0 -- node scripts/verify-linux-window-minimum.mjs --probe
mise exec node@24.21.0 -- node scripts/verify-linux-window-minimum.mjs
```

The harness requires the installed Hyprland/hyprctl, D-Bus, user systemd and grim. It takes the live display identity from Quickshell's process environment. A sizing compositor hosts an owned second compositor at 1800×1200; no resize, focus or input request is sent to the live instance. HOME, the XDG folders and TMPDIR are private; the app has its own `dbus-run-session` and no live portal access. Every long-lived process and descendant is in the owned proof slice. Cleanup stops that slice, removes only the owned compositor folders and temporary root, and checks the prior instances and protected live trees unchanged.

## Gates and review

Both the initial and post-merge runs of the selected `linux-dictation-command.spec.ts` and `linux-shell-plumbing.spec.ts` run under the private-bus harness had 3 passes and 1 failure. The failing “publishes private shell state, retries and discards, remembers placement and steps aside for the plugin” case reached its final raw Electron `app.exit()` launch, then received no state file (line 331, expected idle, read `{}`). Its earlier dictation, retry, discard, placement, cancellation and restart observations passed. An untouched detached base/main `2bcc127a`, using its unchanged build, reproduced the same 3 passes and 1 failure in the identical isolated environment. Review confirmed the cause was the test environment: Playwright adds `--password-store=basic`, but the raw launch omitted it. On the fresh private bus, Sotto selected gnome-libsecret, started a keyring prompt and waited before publishing state. The same environment passed after changing only that launch flag. The earlier failure does not demonstrate failed recovery after an unclean exit. No live bus was used, and no test deadline or assertion was weakened. The direct native minimum proof above passed and cleaned up independently.

The initial four gates ran sequentially under `mise exec node@24.21.0`, with two test workers:

| Gate | Result |
| --- | --- |
| Typecheck | PASS |
| Lint | PASS; repeated after final harness cleanup changes |
| Unit/integration | 769 files passed, 1 failed, 54 skipped (824 total); 9,564 tests passed, 11 failed, 192 skipped (9,767 total); 526.53 s |
| Notices | PASS, 189 components |
| Build | PASS |
| Native resize proof | PASS, eight measurements and four inspected 820×560 captures; clean exit and cleanup |

The 11 unit failures are the same `owlUpdates.test.ts` fixture cases [named in the integration rerun](https://github.com/millZach/Sotto/blob/454f9fbde4aa4564ced3578ac667551397261ee0/docs/verification/omarchy-shell-integration.md#gates-and-review): stable/latest selection, newer Owl selection, same-version/downgrade checks for four tags, next-patch Owl selection, stable-manifest rejection with fallback off/on, mismatched Owl tag and manifest overwriting the selected Atom tag. The untouched base/main `2bcc127a` reproduced all 11 (1 pass). The Windows-only manifest fixture rejects Linux's `latest-linux.yml` request. No tests, deadlines or skips were weakened.

The current four-name main/preload dependency allowlist must pass before pushing. Standards and request reviews checked the platform isolation, unchanged Windows/macOS options, exact native clamp, opaque rendering, private input/capture and owned cleanup. The review tightened owned cleanup when a compositor dies during startup and made later cleanup tasks run even if a preservation check fails. Greptile’s two harness findings were also fixed: assert every native size, and treat an already removed compositor folder as cleaned up rather than skipping cleanup of later records. The native proof passed again with these final checks. No findings remain. No capture baselines are regenerated: this corrects the documented minimum and follows ADR-0062's Linux verification-note gate.

## After main advanced

Main `73e4f8c8` landed the Omarchy theme during this run. Its guide edit conflicted with the minimum sentence; merge `02920367` retains both. The branch is rebuilt and its gates and native proof rerun after that merge. Main also pins the NSIS updater fixture's Windows platform, correcting the 11 baseline Linux unit failures recorded above.

Both Linux follow-up PRs carry the isolated Watcher fixture publication repair found by #932's first Windows gate: save `agents.json` through the same AtomicJsonStore path production uses, so a fast same-size write changes file identity and cannot reuse a cached old host. The changed-host rejection and production cache stay intact. A controlled unchanged-timestamp reproduction fails with the former in-place writer and passes with atomic replacement; all 12 permanent profile cases pass in the focused run. The final native proof above was repeated after the merge and both harness review fixes. The four refreshed captures were opened and inspected; Settings now includes the Omarchy entries from main, falling back to Sotto because the isolated HOME has no Omarchy palette. The selected extra E2E run at that stage still had the same 3 passes and 1 raw-launch failure, corrected below; its private root and all owned processes were removed, and all four protected live trees remained unchanged. Post-merge typecheck and lint passed. The full two-worker suite was rerun sequentially with notices; its final counts and the latest-head Windows CI results are recorded in [PR #934](https://github.com/millZach/Sotto/pull/934).

## Finish editor teardown inside the fixture

The first complete post-merge suite had 773 files pass and 54 skip (827 total), with all 9,661 tests passing and 192 skipping. Vitest nevertheless exited red because a delayed Tiptap destruction callback ran after jsdom removed `document`, attributed to `threadBranchNotice.test.tsx`. The unchanged isolated file passed its nine cases; the library schedules destruction one tick after unmount, so that isolated pass does not clear the full gate.

The fixture now records both mounted prompt editors and destroys them synchronously after React cleanup, matching the existing queue, skill and file-mention fixtures. The delayed callback sees an already destroyed editor. No production code, test assertion, timer deadline or skip changes. All nine focused cases pass after the repair. The complete two-worker gate was repeated; its final counts and latest-head CI remain in PR #934. The built app and native minimum proof are unaffected by this fixture-only change.

## Isolate the forced-exit fixture

The raw Electron launch now passes `--password-store=basic`, matching Playwright's other launches, and inherits stderr for startup diagnosis. This is fixture isolation; production's Linux password-store choice is unchanged. The shell proof runner supplies a private HOME and XDG folders, a mode-0700 TMPDIR and a fresh `dbus-run-session` for Playwright and Electron. Its owned nested compositor receives every input request; captures use grim on that output, with no access to the live portal.

After rebuilding, the complete spec passed through the prescribed runner:

```sh
mise exec node@24.21.0 -- npm run build
mise exec node@24.21.0 -- node scripts/verify-shell-plumbing.mjs tests/e2e/linux-shell-plumbing.spec.ts
```

**VERIFIED: 3 tests passed in 13.4 seconds.** The raw app (PID 1455103) published idle, accepted dictation and removed `dictation-state.json` when Electron's real exit event fired. The other two cases also passed. The refreshed [curated proof](../../artifacts/linux-window-minimum/shell-plumbing-proof.txt) records the final repeat below. Owned compositor PID 1453906 and proof PID 1453965 stopped; all recorded PIDs and cgroups were empty, the prior compositor instances survived and `/tmp/sp-rTswvh` was removed. All four protected live trees were unchanged. No assertion, deadline or skip was weakened.

## Make the repeated shell proof independent of the desktop

A repeat after the final build passed forced-exit cleanup but exposed another fixture assumption: the legacy point `(0, 500)` migrated to Bottom on that nested output, while the test expected Left. The parent compositor can change a nested output's actual geometry despite its requested mode. The fixture now seeds the middle of the actual monitor's left edge, read from the owned Hyprland instance, and retains every Left, version-3 persistence and widget-suppression assertion. The failed repeat also detected concurrent changes under the live `.sotto` tree, including another thread's screenshot files; cleanup stopped the proof and removed its private root without restoring or writing to that tree.

Both proof runners now use a private D-Bus configuration with no service directories or included session configuration. A fresh session bus alone can still activate installed portal services; this configuration removes that activation path as well as keeping the live bus out of the app. No production option changes.

The complete shell spec passed again with those final checks: **3 passed in 15.2 seconds**. No portal service was activated. Raw PID 1613562 published idle, accepted dictation and removed state on exit. Owned compositor PID 1610601 and proof PID 1610659 stopped, all process/cgroup checks were empty, `/tmp/sp-dPvZSd` was removed and all four protected live trees were unchanged. The curated shell proof is refreshed to this run. The initial 13.4-second run above records the password-store repair separately.

## Final post-merge checks

At merge `fa48a2e6`, under `mise exec node@24.21.0`, the sequential typecheck, lint, full two-worker Linux suite, notices and build all passed. The suite had **9,661 tests passed, 192 skipped; 773 files passed, 54 skipped (827 total)** in **546.55 seconds**, with no failures or unhandled errors. Notices verified **189 components**. The later refinements change only standalone proof runners and the E2E spec excluded from that suite; typecheck, lint, notices and build were repeated after them and all passed.

The moved minimum harness passed on the final proof code at `91e228e9`, with all eight measurements and the below-minimum clamp unchanged. Its private bus activated no portal services. The four existing grim captures are byte-for-byte unchanged and were opened and inspected. That run recorded its source, build hash and complete cleanup; the linked proof and sizes now record the later repeat below. The complete shell spec also passes with the final private bus, as recorded above. Every review finding is corrected. The minimum harness stays under `scripts/`; the tracked proofs owned by other work remain at their original `tools/` paths. The final build-output dependency allowlist passed before push. Final-head Windows CI results are recorded in [PR #934](https://github.com/millZach/Sotto/pull/934); the pull request stays open and unmerged.


The first final-head CI run at `8a19f398` passed packaging but failed the Windows queued-steering capture at its first short-window resize. The failure was a test synchronization race: width settled before React collapsed the queue. The [queue verification note](queued-message-steering.md#synchronize-the-desktop-check-after-resizing) records the source diagnosis, admission-readiness repair and passing isolated Linux journey. All production options, assertions and deadlines remain intact. The final head includes that CI fixture repair and reruns Windows CI; the pull request remains unmerged.

## Restore shared tools and repeat the review proof

The follow-up restores all seven tracked `tools/` files to exactly main `e4b81331`'s paths and content, removes their relocated `scripts/` copies and restores every changed caller and historical reference. This PR's own harness remains `scripts/verify-linux-window-minimum.mjs`. Merge `256b1f04` brings in that main commit without a conflict and keeps #933's prototype proof at `tools/verify-omarchy-theme-prototype.mjs`. The PR's `git diff origin/main...HEAD --name-status` has no `tools/` entries; a byte comparison of all seven files against main also passes.

Both review fixes were already implemented by `bc0a88e5` and remain in the harness: before each observation it asserts minimum `[820, 560]`, Electron content equal to target and compositor client size equal to target. Cleanup skips an absent compositor folder before reading its lock or identity.

After the merge, sequential `mise exec node@24.21.0` typecheck, lint and build passed. `npx vitest run tests/unit/main/windowConstruction.test.ts tests/unit/renderer/threadBranchNotice.test.tsx --maxWorkers=2` passed **36 tests in two files**. Notices verified **189 components**, and the exact four-name build-output dependency allowlist passed. Standards and request reviews found no remaining code or scope findings.

The native harness was run three times with its private HOME/XDG/TMPDIR, private bus without service activation and two owned nested compositors. **All eight native measurements passed on every run**, including the 100×100 request clamping to 820×560 in both modes. The four fresh grim frames are byte-for-byte unchanged and were opened and inspected. Each run then failed its live `.sotto` preservation guard because the active live host changed agents, usage and thread database state during the proof. Every owned PID and cgroup was empty, both compositor folders and each private root were removed, and all three protected Omarchy config/state trees stayed unchanged. The guard was retained; no live process was stopped or live state restored to manufacture a passing result. The native proof at that stage marked the failed guard explicitly; the linked proof now records the successful latest-main run below.

The two touched Playwright specs also ran together through `scripts/verify-shell-plumbing.mjs` on its isolated bus: **four tests passed in 16.6 seconds**. Its wrapper hit the same live-host preservation failure after successful owned cleanup, so its overall exit was red. That run recorded both the passing journeys and the guard failure; the linked [shell proof](../../artifacts/linux-window-minimum/shell-plumbing-proof.txt) now records the latest-main repeat below. Fresh transient shell screenshots were discarded; no unrelated evidence or design baseline changed. Final-head Windows CI is recorded in [PR #934](https://github.com/millZach/Sotto/pull/934), which remains open and unmerged.

## Final proof after main's readability correction

Main advanced with #935 during the first follow-up push. Merge `cfd48a2f` brings in main `5a8d818d`; the sole conflict was the artifact lists in `.gitignore`, resolved by keeping both lists. All **nine** tracked `tools/` files now match that main commit byte-for-byte, and the PR diff still has no `tools/` entries. Typecheck, lint, build and the two-file **36-test** focused run passed again on this merged tree. The dependency lockfile did not change.

**VERIFIED: the final native harness passed completely on `cfd48a2f`.** All eight compositor/Electron/renderer measurements and the below-minimum clamp passed against the rebuilt app. The four refreshed 820×560 grim frames were opened and inspected; controls fit and long Settings content scrolls. All four protected live trees stayed unchanged, prior instances survived, every owned PID/cgroup was empty and the two compositor folders and private root were removed. No portal service was activated. The latest proof and sizes above record this successful run and its build hash.

The three Linux shell cases passed again (**10.1 s for the full state/forced-exit case**) on that build, with all protected trees unchanged and complete cleanup. The fourth, queued-steering case failed twice at its initial button count because the single nested compositor's actual output was only **508 pixels high**: the queue correctly began collapsed, so its ordinary rows were absent. This was separate from the admission/resize synchronization fix already in the PR. Running that **unchanged** spec through the native harness's sized, two-compositor sandbox passed **one test in 3.3 s**, including all six captures and both keyboard steers. That queue wrapper later detected concurrent live-host `.sotto` updates; it stopped every owned process and removed both compositor folders and its private root. No assertion, timeout, production option or preservation check was changed. The curated shell proof retains the failed short-desktop attempt, passing sized journey and cleanup outcomes.

The final build-output allowlist must pass before the final push. Final-head Gates (Windows), Package result and Desktop result are recorded in [PR #934](https://github.com/millZach/Sotto/pull/934). The pull request remains open and unmerged.
