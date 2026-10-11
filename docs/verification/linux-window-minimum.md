# Linux main-window minimum

October 11, 2026. Follow-up to [#833](https://github.com/millZach/Sotto/issues/833), based on `2bcc127a`, on `fix/linux-window-minimum`.

## Cause and correction

Electron 43.1.0's [Linux window host](https://github.com/electron/electron/blob/v43.1.0/shell/browser/ui/electron_desktop_window_tree_host_linux.cc#L102) inflates minimum constraints by the restored frame insets. Its [frame layout](https://github.com/electron/electron/blob/v43.1.0/shell/browser/ui/views/electron_frame_view_layout_linux.cc#L24) returns zero insets for a transparent native surface. A frameless window without that flag still gets the resize-border insets, even when its visible content and window bounds coincide. The extra 10 pixels on each side explain the observed 840×580 content floor for an 820×560 constraint.

Linux alone now requests the transparent native surface. The main window keeps its existing solid black background and the renderer paints its usual opaque room; this does not offer frost on Linux. Minimum constants remain 820 and 560. There is no fixed-pixel subtraction, Wayland environment detection or change to the widget. The complete Windows and macOS constructor options remain pinned by their existing strict tests; a new strict Linux test pins its options, background and minimum.

## Native proof

**VERIFIED on forge:** the built, unpackaged Sotto 0.1.37, Electron 43.1.0 and Hyprland 0.56.2 on native Wayland. The main build's SHA-256 is `5dae6149ab107bd2d5160f8eb9065bdfbe926b2d5151570f3c0d7672a0d2988b`; the base commit in the observations is `2bcc127a`, with the Linux option change in the working tree.

The isolated Electron probe produced these actual renderer/content floors after a 100×100 compositor resize, with minimum constraints of 820×560 in every case:

| Constructor option | Renderer and content minimum |
| --- | --- |
| Default frameless | 840×580 |
| `useContentSize: true` | 840×580 |
| `hasShadow: false` | 840×580 |
| `transparent: true` | 820×560 |

[probe.json](../../artifacts/linux-window-minimum/probe.json) records the constructor options, compositor size, window bounds, Electron content/minimum and renderer size.

All eight built-app measurements passed: 1600×1000, 1280×800, 820×560 and a 100×100 request in both Light and Dark. The last clamps to exactly 820×560. Electron's reported minimum stayed 820×560 throughout; no minimum override, viewport emulation or setContentSize was used. [sizes.json](../../artifacts/linux-window-minimum/sizes.json) records all observations. Root scroll dimensions equal the viewport; there is no horizontal page overflow.

The four 820×560 frames were captured with grim on the owned nested output and opened for inspection. Threads' sidebar, search, empty room, mode tabs and footer controls fit. Settings' fixed column, mode controls and two theme columns fit; its long content and category list scroll vertically, with no inaccessible clipped control. The room stays opaque in both modes.

- [Light Threads](../../artifacts/linux-window-minimum/minimum-light.png)
- [Dark Threads](../../artifacts/linux-window-minimum/minimum-dark.png)
- [Light Settings](../../artifacts/linux-window-minimum/minimum-settings-light.png)
- [Dark Settings](../../artifacts/linux-window-minimum/minimum-settings-dark.png)

[proof.txt](../../artifacts/linux-window-minimum/proof.txt) records the passing native run and cleanup: sizing PID 1073445, session PID 1073460 and private journey PID 1073482 were stopped with the proof slice; all recorded PIDs/cgroups were empty. Both owned instance folders and `/tmp/slm-NNhDI5` were removed. Prior instances and all four protected live trees, including `.sotto`, were unchanged.

 The [repeatable harness](../../tools/verify-linux-window-minimum.mjs) compares Electron options with `--probe`, then drives the built app without changing its minimum. It floats and resizes only the owned main window through the nested Hyprland instance and reads content size from both Electron and the renderer. It checks 1600×1000, 1280×800, 820×560 and a below-minimum request in Light and Dark, with reduced motion enabled. It captures with grim, never the desktop portal.

## Reproduce

```sh
mise exec node@24.21.0 -- npm ci
mise exec node@24.21.0 -- node node_modules/electron/install.js
mise exec node@24.21.0 -- npm run build
mise exec node@24.21.0 -- node tools/verify-linux-window-minimum.mjs --probe
mise exec node@24.21.0 -- node tools/verify-linux-window-minimum.mjs
```

The harness requires the installed Hyprland/hyprctl, D-Bus, user systemd and grim. It takes the live display identity from Quickshell's process environment. A sizing compositor hosts an owned second compositor at 1800×1200; no resize, focus or input request is sent to the live instance. HOME, the XDG folders and TMPDIR are private; the app has its own `dbus-run-session` and no live portal access. Every long-lived process and descendant is in the owned proof slice. Cleanup stops that slice, removes only the owned compositor folders and temporary root, and checks the prior instances and protected live trees unchanged.

## Gates and review

The selected `linux-dictation-command.spec.ts` and `linux-shell-plumbing.spec.ts` run under the private-bus harness had 3 passes and 1 failure. The failing “publishes private shell state, retries and discards, remembers placement and steps aside for the plugin” case reached its final raw Electron `app.exit()` launch, then received no state file (line 331, expected idle, read `{}`). Its earlier dictation, retry, discard, placement, cancellation and restart observations passed. An untouched detached base/main `2bcc127a`, using its unchanged build, reproduced the same 3 passes and 1 failure in the identical isolated environment. That raw-launch fixture fails in this private-bus sandbox as it does on main; no live bus was used, and no test deadline or assertion was weakened. The direct native minimum proof above passed and cleaned up independently.

The four gates ran sequentially under `mise exec node@24.21.0`, with two test workers:

| Gate | Result |
| --- | --- |
| Typecheck | PASS |
| Lint | PASS; repeated after final harness cleanup changes |
| Unit/integration | 769 files passed, 1 failed, 54 skipped (824 total); 9,564 tests passed, 11 failed, 192 skipped (9,767 total); 526.53 s |
| Notices | PASS, 189 components |
| Build | PASS |
| Native resize proof | PASS, eight measurements and four inspected 820×560 captures; clean exit and cleanup |

The 11 unit failures are the same `owlUpdates.test.ts` fixture cases [named in the integration rerun](https://github.com/millZach/Sotto/blob/454f9fbde4aa4564ced3578ac667551397261ee0/docs/verification/omarchy-shell-integration.md#gates-and-review): stable/latest selection, newer Owl selection, same-version/downgrade checks for four tags, next-patch Owl selection, stable-manifest rejection with fallback off/on, mismatched Owl tag and manifest overwriting the selected Atom tag. The untouched base/main `2bcc127a` reproduced all 11 (1 pass). The Windows-only manifest fixture rejects Linux's `latest-linux.yml` request. No tests, deadlines or skips were weakened.

The current four-name main/preload dependency allowlist must pass before pushing. Standards and request reviews checked the platform isolation, unchanged Windows/macOS options, exact native clamp, opaque rendering, private input/capture and owned cleanup. The review tightened owned cleanup when a compositor dies during startup and made later cleanup tasks run even if a preservation check fails; the native proof passed again with this final harness. No findings remain. No capture baselines are regenerated: this corrects the documented minimum and follows ADR-0062's Linux verification-note gate.

## After main advanced

Main `73e4f8c8` landed the Omarchy theme during this run. Its guide edit conflicted with the minimum sentence; merge `02920367` retains both. The branch is rebuilt and its gates and native proof rerun after that merge. Main also pins the NSIS updater fixture's Windows platform, correcting the 11 baseline Linux unit failures recorded above.

Both Linux follow-up PRs carry the isolated Watcher fixture publication repair found by #932's first Windows gate: save `agents.json` through the same AtomicJsonStore path production uses, so a fast same-size write changes file identity and cannot reuse a cached old host. The changed-host rejection and production cache stay intact. A controlled unchanged-timestamp reproduction fails with the former in-place writer and passes with atomic replacement; all 12 permanent profile cases pass in the focused run. Final merged-branch counts and proof follow the rerun below.
