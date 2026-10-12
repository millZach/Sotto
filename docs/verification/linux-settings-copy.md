# Settings says what applies on Linux

October 11, 2026, on `fix/linux-settings-copy` from `e1b3225e`. Follow-up to the effort mapped in [#833](https://github.com/millZach/Sotto/issues/833): an agent testing the installed Sotto 0.1.37 on Omarchy found three places where Settings told a Linux user something untrue or left them without a next step.

## What changed

| Where | Before | After, on Linux |
| --- | --- | --- |
| Application › Show floating widget when idle, while the shell pill is in use | "Keep the small dictation sliver on screen between sessions. Click it to dictate." The switch worked, and changed nothing anyone could see. | The switch keeps its saved value but cannot be changed: "On Omarchy, Sotto’s owl in the bar takes the floating widget’s place. Remove the shell plugin to bring the widget back." Without the plugin, or before its state file is live, the row is as before. |
| Application › Updates | "Sotto looks for new releases on GitHub and installs them itself." "Update checks run only in the installed Windows app." **Check now**, and **Check for updates automatically** with the GitHub privacy notice. The sidebar foot's update control. | "Sotto never updates itself on Linux. New versions come through pacman." Under the version: "Install the next sotto-bin package with sudo pacman -U. Once sotto-bin is in a package repository, omarchy update brings it." No buttons, no switch, and no update control in the sidebar foot. |
| Dictation › Compositor bindings | "Compositor bindings live in Hyprland. Omarchy defaults: hold F9 to talk, or press Super+Ctrl+X to start and stop. Install Sotto’s bindings first." Nothing to press. | "Compositor bindings live in Hyprland, not in Sotto. Once Sotto’s bindings are installed, hold F9 to talk, or press Super+Ctrl+X to start and stop." **Open setup steps** opens the Omarchy guide's [Install the bindings](../../apps/omarchy/README.md#install-the-bindings) in the browser. If the browser cannot open it: "The setup steps could not open in your browser. They are at https://github.com/millZach/Sotto/blob/main/apps/omarchy/README.md#install-the-bindings" |

Sotto still never writes Hyprland's files. A link was picked over a **Copy setup command** button because the setup is two steps, one of which appends to the user's own `bindings.lua`; `install.sh` and the guide already leave that edit to the user, and a pasted one-liner would hide it. The guide's section now names the package's copy at `/usr/share/sotto/bindings.lua`, so the link is a complete next step for an installed package.

Main already knew when the shell pill stands in: `ShellWidgetMonitor` reports the plugin folder plus a live state file, and the window manager hides the widget on it. Main now also projects that into settings reads as `shellPillInUse`, the way the Omarchy theme is projected, and re-publishes settings when it changes. It is never saved, and IPC refuses it in a patch on every platform. Only Linux supplies it, and the renderer reads it only on Linux.

Windows and macOS do not change. Their update copy, controls and switch, the global shortcut field, and the idle widget row are pinned by unit tests, and the new style rules match only the Linux row's elements.

## Native proof

**VERIFIED on forge:** the built, unpackaged Sotto 0.1.37 (Electron 43.1.0) on Hyprland 0.56, in an owned nested Hyprland inside a second owned one, with a private HOME, XDG folders, runtime folder and TMPDIR, and its own `dbus-run-session` that activates nothing (no desktop portal). The run used `scripts/verify-linux-window-minimum.mjs --exec` around [the spec](../../tests/e2e/linux-settings-copy.spec.ts), with `SOTTO_E2E_EVIDENCE=publish`; the spec gave Sotto a HOME of its own inside that. [proof.txt](../../artifacts/linux-settings-copy/proof.txt) is the run: one pass, owned compositors and processes stopped, live Omarchy, Hyprland and Sotto folders unchanged.

What the spec drove, in order:

1. Started Sotto with no plugin and waited for its live `dictation-state.json`. The floating widget showed.
2. Dictation: the bindings copy; **Open setup steps** handed exactly the guide's URL to the system browser (recorded, not opened). No update control in the sidebar foot.
3. Application: the Linux update copy, no button or switch under Updates, no "GitHub" there; the idle widget switch enabled with its usual description.
4. Captured each of those at 1600×1000, 1280×800 and 820×560, in Light and Dark, with no sideways overflow at any size.
5. Created a fake `$HOME/.config/omarchy/plugins/sotto.dictation/` folder. The widget hid, and the open Settings page changed live: the switch disabled, still on, with the shell pill sentence. A press saved nothing. Captured at the three sizes in both modes.
6. Made the browser fail: the alert gives the steps' address.
7. Removed the folder. The widget came back and the switch worked again.

The window was floated and sized through the nested compositor and captured with grim, with the pointer parked outside it. Every capture was opened. The ten cited here are kept; the other fifteen (the remaining size and mode pairs) are ignored run output.

- Bindings: [1600×1000 Dark](../../artifacts/linux-settings-copy/bindings-1600x1000-dark.png), [820×560 Light](../../artifacts/linux-settings-copy/bindings-820x560-light.png), [browser failure, 820×560 Dark](../../artifacts/linux-settings-copy/bindings-open-failed-820x560-dark.png).
- Updates: [1280×800 Dark](../../artifacts/linux-settings-copy/updates-1280x800-dark.png), [820×560 Light](../../artifacts/linux-settings-copy/updates-820x560-light.png).
- Idle widget row with the plugin: [1600×1000 Dark](../../artifacts/linux-settings-copy/widget-with-plugin-1600x1000-dark.png), [1280×800 Light](../../artifacts/linux-settings-copy/widget-with-plugin-1280x800-light.png), [820×560 Dark](../../artifacts/linux-settings-copy/widget-with-plugin-820x560-dark.png).
- Idle widget row without it: [1280×800 Light](../../artifacts/linux-settings-copy/widget-without-plugin-1280x800-light.png), [820×560 Dark](../../artifacts/linux-settings-copy/widget-without-plugin-820x560-dark.png).

The first run's frames showed the bindings label sitting a paragraph's margin above its description; the row's label is a `<p>`, not a `<label>`, and kept the browser's margins. The row now sheds them, and the frames above are from the final run, after review.

## Review

The two-axis review ran on Sol (gpt-6.1-sol) at max reasoning. Standards found that the browser-failure notice named a file the installed package does not carry; it now gives the guide's address. The guide said the idle widget switch stays unavailable until the plugin is removed; it now says the switch also returns when Sotto loses its state file. The spec chose its own capture folder; it now captures through the shared evidence helper. Standards also flagged `settingsUpdatesByHand: string | null` doubling as "this platform has no updater" as possible Primitive Obsession. It is kept: it is the same idiom as `accessibilityHelp: string | null` beside it. Spec found that the setup steps' link pointed into a private repository. `millZach/Sotto` is public (GitHub's API reports it so, and the guide's address answers 200 without signing in); `docs/release/releasing.md` still calls it private, which this change leaves alone.

## The saved-setting notice

The agent also noted that a save inserts a notice above the page and pushes the controls down. That is left as it is. The notice sits in the flow above the scrolling form and stays until the page is left. Reserving its room would add a band to the top of every Settings page on every platform. Overlaying it would cover the section heading, since the form's top padding (42 pixels, 22 at the 820×560 minimum) is shorter than the notice. Moving it, for example into the page's bottom-right sentence, is a design decision. Every option also changes the Windows `settings-feedback` design baselines, which only the Windows PC can regenerate.

## Gates

Run on forge with Node 24.21.0: before the first commit, and typecheck, lint, notices and the suite again after the review fixes.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm test -- --maxWorkers=2` | PASS before review, 779 files and 9,800 tests; 55 files and 194 tests skipped. After the review fixes, 9,799 passed and 1 failed: `tests/integration/watcherTools.test.ts` › "refunds a queued prompt after a definite reconciled failure exactly once" (`promptCount` 0, expected 1). That file failed 3 of 5 runs alone on this branch and 4 of 5 on `main` at `e1b3225e`; it is a Watcher flake this change does not touch. |
| `npm run notices:verify` | PASS, 189 components |
| `npm run build`, then the built `out/` externals against `scripts/release-external-dependencies.mjs` | PASS: main imports only reviewed names, dynamic imports `node-pty` and `sherpa-onnx-node`, preload `electron`; `package.json` and the lockfile unchanged |
| Linux specs in the nested desktop: `linux-platform-profile`, `linux-dictation-command`, `linux-shell-plumbing`, `linux-settings-copy` | PASS, 8 of 8 ([log](../../artifacts/linux-settings-copy/linux-specs-proof.txt)) |

The first run of those four specs also passed 8 of 8, with `settings-index` skipped as Windows-only, but the harness then refused its cleanup: the live desktop's `~/.local/state/omarchy/clipboard-history.json` had changed. It changed twice more after that run had ended, with no proof running, so the live session wrote it. The rerun above left every live folder unchanged.

## Reproduce

```sh
mise exec node@24.21.0 -- npm ci
mise exec node@24.21.0 -- node node_modules/electron/install.js
mise exec node@24.21.0 -- npm run build
mise exec node@24.21.0 -- node scripts/verify-linux-window-minimum.mjs --exec $PWD/node_modules/.bin/playwright test tests/e2e/linux-settings-copy.spec.ts
```

Inside the harness the spec captures into `artifacts/e2e-runs/linux-settings-copy/`, through the shared evidence helper (`docs/ci.md`). To refresh the frames kept here, run the harness's command as `/usr/bin/env SOTTO_E2E_EVIDENCE=publish $PWD/node_modules/.bin/playwright test …`. Outside the harness the spec checks the same behaviour and captures nothing. It always gives Sotto its own HOME, so the plugin folder it creates and removes is never the user's.
