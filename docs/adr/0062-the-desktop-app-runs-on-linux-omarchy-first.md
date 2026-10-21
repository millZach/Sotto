# The desktop app runs on Linux, Omarchy first

October 9, 2026 amendment: [ADR-0068](0068-remove-voice-control-and-thread-management.md) removes every reply voice and the ONNX runtime assets and manifest described below. Packaging verifies the surviving Claude SDK and terminal assets with `npm run assets:verify`. Linux's dictation, compositor bindings, paste and desktop profile remain unchanged.

October 21, 2026 amendment: [ADR-0099](0099-sotto-owl-also-ships-for-linux.md) ships Sotto Owl for Linux too, built in GitHub Actions from the Windows Owl's commit and version, with no Hyprland check and no updater. "Who cuts it" and the release checks on forge below now describe stable Linux only. The October 12 amendment's "Linux has no Owl build" is historical. The packaging constraints hold for Owl as they do for stable.

## Status

Accepted October 9, 2026, by the owner. He agreed to the proposals on October 8, answered the three questions marked **Owner** below (the answers follow each question), and approved the merge on October 9. Revised the same day to describe what had been built by then (#847, #848, #856, #858, #868), and to settle the points the Sotto bug review raised on this pull request.

Amends [ADR-0025](0025-headless-host-and-client-identity.md), which says "Linux is host-only". Map: [Map: run the desktop app on Linux, made for Omarchy](https://github.com/millZach/Sotto/issues/833). Ticket: [Decide in an ADR how Linux becomes a desktop platform, Omarchy first](https://github.com/millZach/Sotto/issues/834).

## Context

**Linux runs only the host today.** The host runs threads, approvals, worktrees and the event store under plain Node. It starts at boot under systemd (ADR-0054) and has its own CI job. The desktop app has never had a Linux target.

**A third platform needs this ADR first.** `AGENTS.md` says a third platform is unbudgeted rather than forbidden, and needs an ADR covering the release path, the runtime manifest and the design gate before a target goes into `electron-builder.yml`.

**The owner's direction (October 8, recorded on the map):**

- The Electron desktop app is the Linux client. Its edges are rebuilt for Omarchy: a dictation command for compositor bindings, paste on Hyprland, the widget, the Omarchy theme and packaging.
- An Electron-free client of the host was rejected. So was the React UI served to a browser. Terminals, browser tasks, visuals and checkpoints only work in-process, so both would lose them.
- The work lives in this repository: Linux code in `src/`, Omarchy-only pieces in `apps/omarchy/`.

**What Omarchy is.** Omarchy 4 is Arch Linux with the Hyprland compositor (0.56, configured in Lua) and a Quickshell desktop shell: bar, notifications, OSD and menus.

- It ships its own dictation, Voxtype, on F9 and Super+Ctrl+X.
- Its Install › AI menu offers Electron agent apps. T3 Code and Hermes Desktop come from Omarchy's own pacman repository, `[omarchy]`. `t3code-bin` bundles its own Electron.
- Updates arrive through `omarchy update`, which runs pacman and the AUR.
- It is the owner's Linux machine (forge).

**What happens today on Omarchy** (forge, unpackaged `c53d290`, detail on #835):

- The app quits at startup. Linux takes the Windows profile, the tray loads an `.ico` that Electron on Linux cannot decode, and startup fails.
- Chromium picks the `basic_text` password store on Hyprland, so the OpenRouter key cannot be saved.
- The global dictation shortcut never fires, because Wayland gives an app no global key grab.
- With those worked around, the main window renders as a native Wayland window, tiled by Hyprland, and the tray shows in the Omarchy bar.

## Decision

**October 12, 2026 amendment: one-press Omarchy setup.** Zach chose variant A and every recommendation in the approved [prototype](../prototypes/omarchy-setup-prototype.html). This goes straight to stable; Linux has no Owl build. After Welcome, Linux first-run setup offers the keys, owl and theme with **Set up all three**. Settings → Dictation keeps the same rows, below the dictation shortcut rows that, since ADR-0097, write the keys. No `sotto setup` CLI is added yet.

Sotto may write these Omarchy files only on the user’s press, with a `bindings.lua.bak.<epoch>` copy before changing keys. Main checks ownership, active compositor bindings and the shell first. Manual pieces count as done and stay untouched. New Hyprland errors roll keys back and appear only in the row, never in logs. A stopped shell leaves the owl wholly absent. Theme setup renders under Omarchy’s switch lock, chooses Omarchy in both Appearance columns with Match Linux and keeps the previous choices for removal. Remove takes out only Sotto’s key line and its own unchanged pieces, retaining unrelated edits and the backup.

Main saves an unfinished operation before changing a piece, so closing Sotto during setup or removal does not lose ownership. Settings offers an explicit retry or removal after an interruption; inspection and startup never finish it unasked. An interrupted owl update keeps its restart question. The first key backup remains the original backup through updates. Writes preserve existing file permissions and sync the replacement before recording completion.

That press also authorizes quiet startup refreshes of Sotto’s unchanged keys and theme when a package changes them, reported in Settings. A new key conflict waits for a choice. Updating the owl asks first because it restarts the bar. The snippet runs only with `sotto` on PATH and the owl hides without it. Before `pacman -R`, Remove all cleans the home files; pacman itself never writes or cleans a home. The three pieces and helper scripts ship as Linux-only resources, with public copies in `/usr/share/sotto/`. This amends the earlier statement below that nothing in `apps/omarchy/` is loaded by the app. Windows and macOS retain their resources, IPC and first-run journeys.

**Linux is a desktop platform, and Omarchy is the Linux desktop Sotto supports.** On another Linux desktop, whatever happens to work is welcome, but nothing is checked there. Linux is x64 only, as the host archive is.

**A Linux platform profile** (built in #848 for #835). `SottoPlatform` gains `linux`. Other platforms still fall back to the Windows profile on purpose (`src/shared/platform.ts`), and are not supported. The profile has:

- the colour app icon from `build/icon.png`, sized for the tray and bundled into `out/`, so it is packaged with the app;
- no frost (since ADR-0084, no platform has it);
- no in-app updater;
- the `gnome-libsecret` password store, unless the user passed one or the desktop is KDE, where Chromium's own choice stands;
- login items kept away from Electron's, which do nothing on Linux. Launch when you sign in is disabled until the package provides it (#841).

The owner picked no window controls on Linux (#839, built in #856): Super+W sends Sotto to the tray.

**Dictation input comes from the compositor, not from Electron** (built in #858 for #837). Hyprland bindings run `sotto dictation start|stop|toggle|cancel`. That small client reaches the running app over a private socket in `$XDG_RUNTIME_DIR/sotto/` (folder 0700, socket 0600), not through Electron's second-instance path, which would reopen the main window. Push-to-talk commands carry the key event's time, so a quick tap never starts a stray recording. Processes running as the same user are trusted, as Hyprland's own socket trusts them. `apps/omarchy/bindings.lua` unbinds Voxtype's F9 and Super+Ctrl+X and binds Sotto's. Omarchy loads it from `~/.config/hypr/bindings.lua` after its defaults, so it survives `omarchy update`; `omarchy refresh hyprland` resets it. Settings says the keys live in Hyprland.

**Output reaches the Wayland clipboard and pastes on Hyprland** (built in #868 for #838). Electron's clipboard write never reaches Wayland while Sotto is unfocused, so Linux writes through `wl-copy` (and the primary selection for terminals). With automatic paste on, Sotto sends Ctrl+V to apps and Shift+Insert to terminals, as Omarchy's universal paste does, through a temporary wtype keyboard with its own matching keymap, and never while the session is locked. This October 11, 2026 amendment replaces the single Hyprland dispatcher request: Hyprland 0.56 resolves named keys against the last keyboard, and numeric codes alone failed stock foot after a minimal virtual keyboard. wtype sends the press, 50 ms hold and release in one bounded child process, without a daemon or a change to the physical keyboard configuration. The existing modifier-release wait, focus and lock checks, terminal PRIMARY write and copied fallback remain. The Linux package therefore depends on wtype as well as wl-clipboard. See the [source research](../research/hyprland-paste-keyboards.md) and [live proof](../verification/linux-hyprland-paste.md#paste-after-either-keyboard-october-11-2026).

**The widget on Omarchy is a shell plugin** (#850). The owner picked a Sotto glyph in the bar and a pill in the shell's style (widget B), placed at the top centre under the bar, dragged to snap to an edge as on Windows, and shown on the display the mouse is on when dictation starts. While the plugin is installed and Sotto’s dictation socket has started with a live state file, the Electron widget steps aside. If commands cannot start or publication is lost, the Electron widget remains available and steps aside again when publication recovers (#877).

**Release path.** Three options were considered:

1. **electron-builder's `pacman` target.** It produces a `.pkg.tar.zst` with Sotto's own Electron, installed with `pacman -U`. Nothing is published to a package repository, so `omarchy update` never offers a new version.
2. **A `sotto-bin` package.** electron-builder produces a `tar.gz` of the unpacked app, with Sotto's own Electron, and publishes it to `millZach/Sotto-releases` beside the other installers. A `sotto-bin` PKGBUILD in `apps/omarchy/` installs it to `/opt/sotto`, with a `.desktop` file, an icon, a `sotto` command and `wl-clipboard` and `wtype` as dependencies. Once it is published to the AUR, `omarchy update` keeps it current. This is the shape of `t3code-bin`.
3. **An AUR package on Arch's `electron43`.** It ships only `app.asar` and a `node-pty` rebuilt against Arch's Electron. It is smaller and the most Arch-like. But it ties Sotto to whatever Electron 43 minor Arch ships rather than the exact 43.1.0 Sotto verifies, and `verify-packaged-resources.mjs` assumes Sotto's own Electron.

Proposed: **option 2**. The tarball is verified the same way the Windows and macOS builds are, and the PKGBUILD is the path Omarchy's own agent apps take. A later step is asking Omarchy to carry `sotto-bin` in `[omarchy]` and list it under Install › AI. The pacman target (option 1) remains useful for testing a build locally.

**Owner:**

- (a) Option 2, or another? **Answered: option 2.**
- (b) Publish to the AUR under the owner's account, or ship only the release tarball and a `pacman -U`-able package from `Sotto-releases` at first? **Answered: `Sotto-releases` first, the AUR once packaging (#841) is proven.**

**Who cuts it.** The Linux build is cut by hand on forge with Node 24 and a clean `npm ci`, the way the Windows PC and the Mac cut theirs, and it joins `SHA256SUMS.txt`. Steps:

- `docs/release/releasing.md` gains a Linux section.
- `scripts/release-platform-profile.mjs` gains a Linux profile instead of throwing.
- `verify-packaged-resources.mjs` gains a Linux strategy: extract the tarball and check the same resources.

**Runtime manifest.** Unchanged. `resources/runtime` is WebAssembly (`ort-wasm-*`) and is not tied to a platform. `npm run runtime:verify` runs the same way on forge.

**Packaging constraints** (for #841):

- **The native module.** `node-pty` must be built for Electron on linux-x64. `electron-builder.yml` keeps `npmRebuild: false`, which `tests/unit/release/packaging.test.ts` pins; the Linux package script turns the rebuild on with a command-line flag, as the macOS script does. Nothing shared changes, so the Windows release PC, whose folders have spaces in their names, never rebuilds.
- **Shared settings.** Linux settings go in a `linux:` block or the Linux package script, never in the top-level keys (`npmRebuild`, `asarUnpack`, `files`, `extraResources`, `publish`) that every platform reads. Package (Windows) catches a slip.
- **The Chromium sandbox.** Arch enables unprivileged user namespaces, so Chromium's sandbox works without a setuid helper. The PKGBUILD still sets `chrome-sandbox` to `root:root 4755`, as many Electron `-bin` packages do, for systems without them.
- **The release smoke check** runs with an isolated password store (`--password-store=basic`), as the macOS check uses a mock keychain, so it never reads or writes the release machine's keyring.
- **Shutdown** (October 12 amendment, #871). The host quit drain receives `powerMonitor` on Linux as well as macOS. Electron 43 emits Linux's logind notice without quitting the app; Sotto prevents that event to retain Electron's delay inhibitor and explicitly starts quitting. Linux shutdown allows four seconds for the drain, leaving room for exit inside logind's default five-second delay. The configured `InhibitDelayMaxUSec` wins if shorter. Local provider cancellation, accepted-write persistence and cloud iPhone release start before waiting on phone access, whose own cleanup can take eight seconds; phone access still closes before remote hosts. This Linux-only ordering prioritizes accepted local writes, owned provider teardown and billable sessions over network cleanup. Linux preparation stops new sweeps and provider work immediately, even if an ordinary quit or a worktree sweep is already waiting. Stores remain open until the current sweep and ordinary final drain finish; Windows and macOS keep their sweep-first ordering. At the app's cutoff, or when the system proceeds, incomplete writes and the latest output are not guaranteed saved. Remote work can continue on its host. Windows and macOS behavior and ordinary Quit's ten-second bound stay unchanged. See the [source research](../research/linux-shutdown-drain.md) and [isolated proof](../verification/linux-shutdown-drain.md).

**Updates.** None in the app. A packaged Linux build must not take the Windows updater path. Until the AUR, a new version is the next package downloaded from `Sotto-releases` and installed with `pacman -U`. Once `sotto-bin` is in the AUR, `omarchy update` brings it.

**Design gate.**

- The shared renderer stays gated by the Windows captures (`npm run design:verify`). Linux draws the same pages.
- Linux-only surfaces get verification notes with screenshots taken on forge, under `docs/verification/` and `artifacts/<slug>/`: the window chrome, the widget on Omarchy and the Omarchy theme.
- Linux does not get its own capture baselines until a Linux CI runner can draw them.

**Owner:** (c) whether that is enough, or Linux captures should be a gate now. **Answered: verification notes are enough until a Linux CI runner can draw captures.**

**CI.** `Gates (Windows)` stays the merge gate, required on `main` by a ruleset, and Package (Windows) packages and verifies the Windows app on code pull requests (#847). Linux code is checked on forge before each pull request: the unit suite, the Linux end-to-end specs and the verification scripts.

A Linux unit job in CI is its own ticket. It needs its own changed-area filter, because the host job skips renderer and preload changes. It also needs the suite's Linux-only CI blockers fixed first, such as the real-sshd tripwire under CI and the release verifier refusing Linux. Until it lands, Linux breakage shows up on forge, not in CI.

**October 12, 2026 amendment (#870).** Six Linux shards now run the unit and integration suite whenever Changed areas asks for the full Windows suite, and on every push to `main`. The first shard also typechecks on Linux. The real-sshd tripwire belongs to the dedicated host journey; the release verifier already supports Linux. **Linux result** reports failure unless Changed areas succeeded and every shard passed, or documents-only changes skipped the shards. It is informational until the owner decides to require it. Linux desktop journeys and captures stay on forge ([CI](../ci.md)).

**Omarchy integration lives in `apps/omarchy/`.** That covers the Hyprland bindings and the `sotto` launcher (#858), the shell plugin (#850), the theme template (#840), the PKGBUILD and `.desktop` file (#841), and an install script in the style of Omarchy's `omarchy-install-ai-*`. Nothing there is loaded by the app; it is configuration Omarchy reads.

## Consequences

- **A third release machine.** Each release adds a manual Linux pass on forge: install the package, finish onboarding, dictate into Chromium and a terminal, open a thread.
- **Sotto takes over Omarchy's dictation keys.** Voxtype owns F9 and Super+Ctrl+X when installed. The owner decided that Sotto's setup takes those keys over ([Decide whether Sotto replaces Voxtype or sits beside it](https://github.com/millZach/Sotto/issues/836)), through the bindings snippet described above; `omarchy menu keybindings --print` shows which tool holds them. Voxtype's engine can become a local transcription option on Omarchy, which amends ADR-0006 and has its own ticket (#845).
- **The hotkey setting means something different on Linux.** It names a compositor binding rather than a shortcut Sotto registers. Copy in Settings and `docs/guide.md` says so. *October 20, 2026 amendment ([ADR-0097](0097-dictation-shortcuts-listen-for-held-keys.md), decision 9):* the hotkey and the hold shortcuts now name the compositor bindings Sotto writes. Settings › Dictation records them as on Windows and macOS, F9 held and Super+Ctrl+X pressed by default, and a save is the user's press under the rules above: Sotto rewrites only its own snippet, never `bindings.lua`, refuses keys Hyprland already binds, rolls back on a new Hyprland error and shows errors only in the row. Until Sotto's keys are set up the rows offer that setup instead of writing anything.
- **Credential storage depends on a Secret Service.** On Omarchy that is gnome-keyring, which runs on forge and which Electron finds available once the password store is set. What happens when the keyring is locked has not been tried. Where no Secret Service runs, Sotto says so with the existing "Secure credential storage is unavailable" message.
- **Linux lacks the system reply voice.** Reply voice has Windows and macOS system speech only. The hosted voices work. Voice is gated for the beta (ADR-0012).
- **Documents change with acceptance and packaging.** `AGENTS.md`'s platform line changes with this decision. The README's platform list and `docs/release/releasing.md` change in the packaging pull request (#841), when there is a Linux download to list and a procedure to follow.
- **The Windows build must not break.** The owner's condition for merging Linux work. Three measures apply:
  - `Gates (Windows)` becomes a required check on `main`;
  - CI packages and verifies the Windows app (`npm run package:dir`, the job **Package (Windows)**). It runs on every pull request that changes anything beyond documents, tests or the phone clients, including the documents the package ships, and on every push to `main`. Its **Package result** job is what a ruleset requires, because a skipped job reads as passing (#847);
  - Linux behaviour lives only behind the `linux` profile, with Windows and macOS values pinned by tests. Linux packaging never changes the shared top-level `electron-builder.yml` keys (see Packaging constraints), and main's external imports stay on the reviewed allow-list that Package (Windows) checks.

  The desktop smoke check on the Windows PC before each release stays as it is.
- **Nothing is undone.** A Linux target is additive. Windows and macOS keep their installers, gates and captures.
