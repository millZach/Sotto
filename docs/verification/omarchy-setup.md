# Omarchy setup with one press

October 12, 2026, on forge, Omarchy / Hyprland 0.56 and Electron 43.1.0.

**Verified in the built app.** The real first-run and Settings journeys pass inside a private HOME and nested Omarchy shell. The first Linux tarball passed its resource, native-module, normal-startup and archive checks, and its packaged first-run, repeated setup and removal journey passed too. Final package rebuild, makepkg, full gates and independent review results are recorded below as they finish; this note does not establish those pending results.

The owner chose variant A and every recommendation, including straight to stable, on October 12. The [plan](../plans/omarchy-setup.md) records that choice and the [prototype](../prototypes/omarchy-setup-prototype.html) is carried from d07469e0 at the build brief’s request. Windows and macOS keep their shortcut field, nine first-run steps and resources; unit checks cover the absence of the setup bridge and handlers on both.

## Real journeys

`npm run build`, followed by:

```sh
TMPDIR="$PWD/.cache/omarchy-setup" mise exec node@24.21.0 -- node scripts/with-nested-hyprland.mjs .cache/omarchy-setup/outer node scripts/verify-omarchy-setup.mjs
```

The current built journey passed all these checks (one Playwright test, 19.9 seconds):

- Welcome → Omarchy → Set up all three, with Voxtype initially holding both keys. The real compositor exposes Sotto’s start, release and toggle afterwards, with no configuration errors. The Shortcut step says Hold F9 to try it. The journey finishes first-run setup and its Threads tour before opening Settings.
- Running setup again leaves the key file unchanged and skips completed pieces.
- Each Remove, setup again and Remove all. The original binding file and Voxtype bindings return, and the backup remains. The theme’s preceding Appearance choices return.
- A real non-Voxtype F9 binding, answered both ways. Leave my keys alone keeps the file byte for byte while the owl and theme install. Give F9 to Sotto sets up only the keys still left.
- The private shell actually stopped: the owl fails without leaving a plugin folder. Restarting that shell and pressing Try again installs it.
- A Lua-valid configuration that injects a real Hyprland error only once Sotto’s require is present. The row shows the compositor’s line, the original binding file returns and the snippet is removed. Correcting that configuration and retrying succeeds.
- A simulated package update changes the bundled copies in the disposable profile and restarts the app. Keys and theme refresh quietly with notes in Settings. The owl stays on its old copy, Escape cancels the update question, and the affirmative press restarts only the owned private bar.
- Simulated package removal takes the private sotto command off PATH. The guarded snippet leaves Voxtype holding both keys. The actual shell glyph disappears; the before/after bar pixels differ. The real installed `/usr/bin/sotto` is excluded from this proof’s command directory, without moving or changing it.
- Keys, owl and theme installed by hand count as done. A request to remove all leaves their files byte for byte unchanged.

Native `hyprctl binds -j` reports Lua callbacks as `__lua` and an opaque callback ID, rather than their command. New Sotto snippets use distinct descriptions; recognised loaded legacy snippets supplement the older generic descriptions. This was found in the real proof and is covered by the unit checks. Hyprland documents descriptions as the exposed bind metadata in [bind flags](https://wiki.hypr.land/configuring/core/binds/flags/).

## Captures inspected

The first-run offers at 1280×800 and 820×560, in both modes, are `built-offer-<size>-<mode>.png`. Settings has light and dark captures at 1600×1000, 1280×800 and 820×560 as `built-settings-<size>-<mode>.png`. Reduced motion is on. The card and Settings body scroll internally; the first-run footer stays visible. Geometry checks reject horizontal overflow or clipped controls.

Additional states: `built-done-1280x800-dark.png`, `built-conflict-1280x800-light.png`, `built-shell-down-1280x800-light.png` (partly done), `built-rollback-1280x800-light.png` (failed), `built-undo-1280x800-light.png`, `built-update-1280x800-dark.png`, `built-uninstalled-1280x800-dark.png` and `built-by-hand-1280x800-dark.png`. `built-bar-installed.png` and `built-bar-uninstalled.png` show the actual owl disappearing. All live under [artifacts/omarchy-setup](../../artifacts/omarchy-setup); `built-results.json` records the successful journeys and capture geometry. Only cited evidence is retained. Windows design baselines are unchanged.

The packaged journey has the same first-run and Settings matrix, done and undo captures, with the `packaged-` prefix and `packaged-results.json`. It uses the actual packaged executable and resources, isolated password storage and no provider account. It proves setup and removal, rather than real microphone capture or transcription.

## Isolation

Every written configuration lives under this checkout’s `.cache/su-*/h`. The shell enables only the bar, empty indicators and Sotto, with all other services disabled, on a private bus that cannot activate portals or desktop services. Executable lookup links live outside the configuration trees. A short private runtime under `.cache/rN` keeps Quickshell’s socket below Qt’s path limit. The only compositor commands and input target the nested display. The restart helper uses the private shell’s registry, checks the owned process group and waits for its previous instance to leave before starting another; the real any-display restart is never used by this proof. Owned process groups are empty after the passing runs. The live shell’s PID remained 2861240, started October 11, throughout the proof.

## Package, gates and review

The first `npm run package:linux` and packaged journey passed. The final rebuild, makepkg resource listing, full suite, notices and two-axis review remain to be recorded before the pull request opens. Targeted main, renderer, preload and process-integration checks pass; they use private files and scripted desktop commands, including real child processes for fake hyprctl and luac. Hyprland’s error text never enters an application log.
