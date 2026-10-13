# Omarchy setup with one press

October 12, 2026, on forge, Omarchy / Hyprland 0.56 and Electron 43.1.0.

**Verified in the built and packaged app.** The real first-run and Settings journeys pass inside a private HOME and nested Omarchy shell. The final Linux tarball passed its resource, native-module, normal-startup and archive checks. Its packaged first-run, repeated setup and removal journey passed too. The Arch package was built and inspected without installing it. The local suite and review results are recorded below. Final GUI and package inputs are 1f1166d8; later commits only record the recipe checksum and evidence.

The owner chose variant A and every recommendation, including straight to stable, on October 12. The [plan](../plans/omarchy-setup.md) records that choice and the [prototype](../prototypes/omarchy-setup-prototype.html) is carried from d07469e0 at the build brief’s request. Windows and macOS keep their shortcut field, nine first-run steps and resources; unit checks cover the absence of the setup bridge and handlers on both.

## Real journeys

`npm run build`, followed by:

```sh
TMPDIR="$PWD/.cache/omarchy-setup" mise exec node@24.21.0 -- node scripts/with-nested-hyprland.mjs .cache/omarchy-setup/outer node scripts/verify-omarchy-setup.mjs
```

The built journey passed all these checks (one Playwright test):

- Welcome → Omarchy → Set up all three, with Voxtype initially holding both keys. The real compositor exposes Sotto’s start, release and toggle afterwards, with no configuration errors. The Shortcut step says Hold F9 to try it. The journey finishes first-run setup and its Threads tour before opening Settings.
- Running setup again leaves the key file unchanged and skips completed pieces.
- An owned owl enabled only as a shell service is incomplete. **Set up the owl** moves it onto the real bar; native service options survive the move.
- Each Remove, setup again and Remove all. The original binding file and Voxtype bindings return, and the backup remains. The theme’s preceding Appearance choices return.
- A real non-Voxtype F9 binding, answered both ways. Leave my keys alone keeps the file byte for byte while the owl and theme install. Give F9 to Sotto sets up only the keys still left.
- The private shell actually stopped: the owl fails without leaving a plugin folder. Restarting that shell and pressing Try again installs it.
- A Lua-valid configuration that injects a real Hyprland error only once Sotto’s require is present. The row shows the compositor’s line, the original binding file returns and the snippet is removed. Correcting that configuration and retrying succeeds.
- A simulated package update changes the bundled copies in the disposable profile and restarts the app. Keys and theme refresh quietly with notes in Settings. The owl stays on its old copy, Escape cancels the update question, and the affirmative press restarts only the owned private bar.
- Simulated package removal takes the private sotto command off PATH. The guarded snippet leaves Voxtype holding both keys. The actual shell glyph disappears after its next five-second check. The proof waits until its bright foreground pixels disappear, rather than accepting changes to the bar background. The real installed `/usr/bin/sotto` is excluded from this proof’s command directory, without moving or changing it.
- Keys, owl and theme installed by hand count as done. A request to remove all leaves their files byte for byte unchanged.

Native `hyprctl binds -j` reports Lua callbacks as `__lua` and an opaque callback ID, rather than their command. New Sotto snippets use distinct descriptions; recognised loaded legacy snippets supplement the older generic descriptions. This was found in the real proof and is covered by the unit checks. Hyprland documents descriptions as the exposed bind metadata in [bind flags](https://wiki.hypr.land/configuring/core/binds/flags/).

## Captures inspected

The first-run offers at 1280×800 and 820×560, in both modes, are `built-offer-<size>-<mode>.png`. Settings has light and dark captures at 1600×1000, 1280×800 and 820×560 as `built-settings-<size>-<mode>.png`. Reduced motion is on. The card and Settings body scroll internally; the first-run footer stays visible. Geometry checks reject horizontal overflow or clipped controls.

Additional states: `built-working-1280x800-dark.png`, `built-done-1280x800-dark.png`, `built-service-only-1280x800-light.png` (incomplete service placement), `built-conflict-1280x800-light.png`, `built-shell-down-1280x800-light.png` (partly done), `built-rollback-1280x800-light.png` (failed), `built-undo-1280x800-light.png`, `built-update-1280x800-dark.png`, `built-uninstalled-1280x800-dark.png` and `built-by-hand-1280x800-dark.png`. `built-bar-installed.png` and `built-bar-uninstalled.png` show the actual owl disappearing. All live under [artifacts/omarchy-setup](../../artifacts/omarchy-setup); `built-results.json` records the successful journeys, source revision and capture geometry. Only cited evidence is retained. Windows design baselines are unchanged.

The packaged journey has the same first-run and Settings matrix, working, done, service-only and undo captures, with the `packaged-` prefix and `packaged-results.json`. It uses the actual packaged executable and resources, isolated password storage and no provider account. It proves setup and removal, rather than real microphone capture or transcription.

## Isolation

Every written configuration lives under this checkout’s `.cache/su-*/h`. The shell enables only the bar, empty indicators and Sotto, with all other services disabled, on a private bus that cannot activate portals or desktop services. Executable lookup links live outside the configuration trees. A short private runtime under `.cache/rN` keeps Quickshell’s socket below Qt’s path limit. The only compositor commands and input target the nested display. The restart helper uses the private shell’s registry, checks the owned process group and waits for its previous instance to leave before starting another; the real any-display restart is never used by this proof. Owned process groups are empty after the passing runs. The live shell’s PID remained 2861240, started October 11, throughout the proof.

## Package, gates and review

`npm run package:linux` and the final packaged journey passed. `makepkg --cleanbuild --force --noconfirm` produced `sotto-bin-0.1.37-1-x86_64.pkg.tar.zst`, without installation. The recipe and .SRCINFO use the verified tarball checksum. `package-resources.json` records both archive hashes and 30 byte-for-byte checks across `/opt/sotto/resources/omarchy` and `/usr/share/sotto`. The packaged `chrome-sandbox` has root ownership and mode 4755. The build and packaged dependency inventories pass the external-dependency allowlist.

Typecheck and lint pass. Notices verifies 189 components. The review revision passes 263 focused tests across 11 files, including the engine, renderer, real-child-process integration, IPC, preload, packaging, shell helpers, onboarding and theme tokens. The neighboring onboarding microphone journeys pass (three tests), and Linux Settings passes (one test). Hyprland’s error text never enters an application log.

The full suite before the review fixes passed: **10,082 passed, 194 skipped**, across 795 passing and 55 skipped files, in 542.58 seconds. Zach authorized one corrected run with `TMPDIR` unset, so fixtures used normal `/tmp`; no namespace was used for this gate. The earlier worktree-local temporary paths made Git fixtures discover the enclosing repository and made Unix listener names exceed 108 bytes. The normal-temp run removes those environment failures without changing production code. A before/after inventory identified three remaining `finishedUnreadControl` fixture directories. After ownership and identity checks, those were removed; no new `/tmp` entries remain and pre-existing entries were preserved. `full-suite.json` records the gate and cleanup. That authorized full run was not repeated after review; `review-checks.json` records the regression checks on the review revision, and CI runs both platform suites.

```sh
env -u TMPDIR -u TMP -u TEMP mise exec node@24.21.0 -- npm test -- --maxWorkers=2
```

Independent Standards and Spec reviewers inspected the pinned-base diff and verified the fixes. Standards found the missing Escape collapse and shared evidence destination. Spec found inactive manual keys, missing theme renders, an off-bar owl bypassing its update question, new conflicts on owned key updates and removal after keeping such keys. All findings are fixed and both reviewers report zero unresolved findings. The minimum first-run setup button is fully visible, and its geometry is now asserted.

The PR review identified six valid file-recovery findings. Updates now retain the first key backup, originally absent binding files return to absence unless edited later, and Remove all mentions a backup only after a successful owned removal with an existing copy. Atomic writes preserve file modes and sync the file and parent directory. Pending ownership is saved before any piece changes; reopened unfinished operations wait for an explicit retry or removal. Fixed owl scratch folders are recovered only on that press, and unfamiliar old or changed copies are refused. Token-owned theme staging distinguishes an interrupted Sotto render from a pending desktop theme switch. Eight real SIGKILL scenarios cover setup and removal of all three pieces, plus service-to-bar repair before and after placement. They verify removal remains possible, saved options survive and later option edits stay whole. The crash runner bundles its dependencies so it also runs outside the repository.

The independent follow-up reviews found and resolved misleading setup choices on removal retries and loss of owl options during interrupted service repair. Both axes report zero unresolved findings. The non-Omarchy suggestion is outside the approved brief: ADR-0062 makes Omarchy the supported Linux desktop, and Linux already used compositor bindings before this change. The new first-run step can be skipped.
