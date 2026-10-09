# The desktop app runs on Linux, Omarchy first

## Status

Proposed October 8, 2026, for the owner's decision. On October 8 the owner agreed to the proposals and answered the three questions marked **Owner** below; the answers follow each question. It is accepted when the owner merges it.

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

## Decision (proposed)

**Linux is a desktop platform, and Omarchy is the Linux desktop Sotto supports.** On another Linux desktop, whatever happens to work is welcome, but nothing is checked there. Linux is x64 only, as the host archive is.

**A Linux platform profile.** `SottoPlatform` gains `linux` (#835). The profile has:

- a PNG tray icon;
- no frost;
- no in-app updater;
- the `gnome-libsecret` password store unless the user passed one;
- copy-only dictation output until paste on Hyprland lands (#838).

The window chrome comes from the prototype the owner picks (#839).

**Dictation input comes from the compositor, not from Electron.** A command that a Hyprland binding runs (#837) replaces `globalShortcut` on Linux. Settings says the binding lives in Hyprland, rather than showing a shortcut that never fires.

**Release path.** Three options were considered:

1. **electron-builder's `pacman` target.** It produces a `.pkg.tar.zst` with Sotto's own Electron, installed with `pacman -U`. Nothing is published to a package repository, so `omarchy update` never offers a new version.
2. **A `sotto-bin` package.** electron-builder produces a `tar.gz` of the unpacked app, with Sotto's own Electron, and publishes it to `millZach/Sotto-releases` beside the other installers. A `sotto-bin` PKGBUILD in `apps/omarchy/` installs it to `/opt/sotto`, with a `.desktop` file, an icon and a `sotto` command. Published to the AUR, `omarchy update` keeps it current. This is the shape of `t3code-bin`.
3. **An AUR package on Arch's `electron43`.** It ships only `app.asar` and a `node-pty` rebuilt against Arch's Electron. It is smaller and the most Arch-like. But it ties Sotto to whatever Electron 43 minor Arch ships rather than the exact 43.1.0 Sotto verifies, and `verify-packaged-resources.mjs` assumes Sotto's own Electron.

Proposed: **option 2**. The tarball is verified the same way the Windows and macOS builds are, and the PKGBUILD is the path Omarchy's own agent apps take. A later step is asking Omarchy to carry `sotto-bin` in `[omarchy]` and list it under Install › AI. The pacman target (option 1) remains useful for testing a build locally.

**Owner:**

- (a) Option 2, or another? **Answered: option 2.**
- (b) Publish to the AUR under the owner's account, or ship only the release tarball and a `pacman -U`-able package from `Sotto-releases` at first? **Answered: `Sotto-releases` first, the AUR once packaging (#841) is proven.**

**Who cuts it.** The Linux build is cut by hand on forge with Node 24 and a clean `npm ci`, the way the Windows PC and the Mac cut theirs, and it joins `SHA256SUMS.txt`. Steps:

- `docs/release/releasing.md` gains a Linux section.
- `scripts/release-platform-profile.mjs` gains a Linux profile instead of throwing.
- `verify-packaged-resources.mjs` gains a Linux strategy: extract the tarball and check the same resources.

**Runtime manifest.** Unchanged. `resources/runtime` is WebAssembly (`ort-wasm-*`) and is not tied to a platform. `npm run runtime:verify` runs the same way on forge. The only native module, `node-pty`, is rebuilt for linux-x64 by electron-builder on forge.

**Updates.** None in the app. A packaged Linux build must not take the Windows updater path. New versions arrive through the package (option 2 with the AUR), or by downloading the next package.

**Design gate.**

- The shared renderer stays gated by the Windows captures (`npm run design:verify`). Linux draws the same pages.
- Linux-only surfaces get verification notes with screenshots taken on forge, under `docs/verification/` and `artifacts/<slug>/`: the window chrome, the widget on Omarchy and the Omarchy theme.
- Linux does not get its own capture baselines until a Linux CI runner can draw them.

**Owner:** (c) whether that is enough, or Linux captures should be a gate now. **Answered: verification notes are enough until a Linux CI runner can draw captures.**

**CI.** `Gates (Windows)` stays the merge gate. The existing Linux job adds `npm run typecheck` and the unit suite, so a change that breaks Linux shows up before a release.

**Omarchy integration lives in `apps/omarchy/`.** That covers the Hyprland binding snippet, the theme template (#840), the shell plugin if the owner picks one (#839), the PKGBUILD and `.desktop` file (#841), and an install script in the style of Omarchy's `omarchy-install-ai-*`. Nothing there is loaded by the app; it is configuration Omarchy reads.

## Consequences

- **A third release machine.** Each release adds a manual Linux pass on forge: install the package, finish onboarding, dictate into Chromium and a terminal, open a thread.
- **Sotto takes over Omarchy's dictation keys.** Voxtype owns F9 and Super+Ctrl+X when installed. The owner decided that Sotto's setup offers to take those keys over ([Decide whether Sotto replaces Voxtype or sits beside it](https://github.com/millZach/Sotto/issues/836)), and that Voxtype's engine can become a local transcription option on Omarchy. That option amends ADR-0006 and has its own ticket.
- **The hotkey setting means something different on Linux.** It names a compositor binding rather than a shortcut Sotto registers. Copy in Settings and `docs/guide.md` says so.
- **Credential storage depends on a Secret Service.** On Omarchy that is gnome-keyring, which runs on forge and which Electron finds available once the password store is set. What happens when the keyring is locked has not been tried. Where no Secret Service runs, Sotto says so with the existing "Secure credential storage is unavailable" message.
- **Linux lacks the system reply voice.** Reply voice has Windows and macOS system speech only. The hosted voices work. Voice is gated for the beta (ADR-0012).
- **Documents change on acceptance.** `AGENTS.md` ("Windows first, Apple silicon macOS second"), the README's platform list and `docs/release/releasing.md` change when this is accepted, not before.
- **The Windows build must not break.** The owner's condition for merging Linux work. Three measures apply:
  - `Gates (Windows)` becomes a required check on `main`;
  - CI packages and verifies the Windows app (`npm run package:dir`, the job **Package (Windows)**). It runs on every pull request that changes anything beyond documents, tests or the phone clients, including the documents the package ships, and on every push to `main`. Its **Package result** job is what a ruleset requires, because a skipped job reads as passing (#847);
  - Linux behaviour lives only behind the `linux` profile, with Windows and macOS values pinned by tests, and `electron-builder.yml` changes stay inside a new `linux` block.

  The desktop smoke check on the Windows PC before each release stays as it is.
- **Nothing is undone.** A Linux target is additive. Windows and macOS keep their installers, gates and captures.
