# Sotto Owl also ships for Linux

## Status

Accepted by Zach on October 21, 2026. **Number provisional until merge:** 0098 is the newest on `origin/main` at the time of writing, where it is main's one-minute recording; recheck before merging (docs/agents/domain.md). It amends [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md), which kept Linux out of Owl ("Linux still has no Owl desktop build"), [ADR-0062](0062-the-desktop-app-runs-on-linux-omarchy-first.md), whose Linux build is cut by hand on forge and checked there, and [ADR-0093](0093-sotto-owl-also-ships-for-apple-silicon-macs.md), whose scope was Windows and Apple silicon Macs. Stable Linux keeps every part of ADR-0062.

## Context

Owl ships for Windows and Apple silicon Macs. A Linux user on Omarchy gets Owl features only when they reach stable. Stable Linux is cut by hand on forge, Zach's Omarchy machine, and its release check launches the package inside a nested Hyprland session there. The Mac half of each Owl is already built in GitHub Actions from the Windows Owl's commit and version (ADR-0093), so the pinned build, the source-history check, the attestation and `release:owl`'s artifact check are proved.

Two facts about pacman shape the answer. pacman cannot hold a hyphen in a package version, so the Owl version `0.1.38-owl.20261021.1` cannot be one as it is. And pacman's version comparison has no pre-release marker: a tilde or a dot after the patch is an ordinary separator, so `0.1.38~owl.20261021.1` sorts after `0.1.38`, and stable could never replace that Owl.

## Decision

Zach's answers, October 21:

- **Each Owl prerelease carries a Linux build**: the x64 tarball and the `sotto-bin` pacman package, as stable Linux does.
- **Owl and stable replace each other**, as on Windows and the Mac: the same package name `sotto-bin`, the same `/opt/sotto`, the same data.
- **No in-app updater on Linux.** ADR-0062 and ADR-0093 are unchanged on this: each Owl is installed by hand with `sudo pacman -U`.
- **No Omarchy or Hyprland check for Owl.** `scripts/verify-linux-package.mjs` in a nested Hyprland session stays a stable-release step on forge. Owl ships once the workflow's checks pass.
- **Started by hand** with the Windows Owl's version and full source commit, like the Mac workflow, never on a push or a pull request. It attests its files and publishes nothing.

### The build

`npm run package:owl` runs on x64 Linux, and only pinned with `--version` and `--source`, so the Linux build is always the Windows Owl's twin. It builds `Sotto-Owl-<version>-linux-x64.tar.gz` from the same Owl overrides as Windows and the Mac: the packaged version, the `owl` publisher, and Sotto's app ID, product name and data directory unchanged. As stable Linux does, it turns on the native rebuild in its plan. Only the `linux` section's artifact name changes; no shared top-level `electron-builder.yml` key does (ADR-0062, Packaging constraints). It compares the tarball with the unpacked app file by file, launches the app on a throwaway profile to check its resources and that every Owl feature is on, and writes `release/owl-linux-package.json` last, naming the version, source commit, build-input revision and the tarball's size and SHA-256.

The workflow **Sotto Owl for Linux** (`.github/workflows/owl-linux.yml`) has three jobs. It reads no secrets and uses no environment.

- **Package**, on `ubuntu-24.04`: the same input checks and source-history check as the Mac workflow, before anything from the checkout runs, then `npm ci`, Electron's download and `xvfb-run -a npm run package:owl`. Ubuntu 24.04 stops unprivileged programs making user namespaces, which Chromium's sandbox uses; Arch allows them. The job lifts that limit on the runner (`kernel.apparmor_restrict_unprivileged_userns=0`) so the app's launch checks run with its whole sandbox, as on Omarchy, rather than with `--no-sandbox`. The packaged files are untouched.
- **Pacman**, in a pinned `archlinux:base-devel` container brought up to date first: it builds `sotto-bin` from the tarball with the same recipe, `makepkg` and checks as stable (the file list, `/opt/sotto`, the launcher, desktop entry, icons, licence, the Omarchy setup pieces, `chrome-sandbox` root:root 4755, and the app's version and source), as an ordinary user because `makepkg` refuses root. It also checks the package carries the tarball's `app.asar` and setup pieces unchanged and records the Owl's pacman version, and writes `owl-linux-pacman.json` last. There is no Hyprland step.
- **Attest**, the only job with write scopes, attests the tarball and the package with GitHub's build provenance and runs nothing from the checkout.

The artifact `sotto-owl-linux-<version>` keeps the tarball, the package, `PKGBUILD`, `.SRCINFO` and both receipts for 14 days.

### The pacman version

An Owl's pacman version is its version without the hyphen: `0.1.38-owl.20261021.1` is `0.1.38owl.20261021.1`, and its package is `sotto-bin-0.1.38owl.20261021.1-1-x86_64.pkg.tar.zst`. pacman sorts letters straight after a number before the bare number, as `1.0rc` comes before `1.0`. So an Owl falls after stable `0.1.37` and before stable `0.1.38`, builds of a day and days follow in order, `.10` comes after `.9`, and the next base's Owl comes after `0.1.38`. Installing stable over an Owl of the same base is an upgrade; pacman calls installing an older stable over a newer Owl a downgrade and installs it all the same.

A tilde, `0.1.38~owl.20261021.1`, was considered first, as RPM and Debian mark a pre-release. pacman's comparison gives the tilde no meaning, so that form would sort after stable. The name is also free of characters GitHub might rename in a release asset. The pacman job runs every ordering above through pacman's own `vercmp` before it builds anything, and fails in plain words if one is wrong.

The committed recipe takes its release version and archive name from `pkgver` through two variables, `_version` and `_archive_name`. Stable's `pkgver`, archive, download address, folder and `.SRCINFO` expand exactly as before. An Owl build sets `pkgver` to the Owl's pacman version and those two to the Owl version and its tarball, so the recipe downloads from the Owl prerelease's tag on `millZach/Sotto-releases`. `package()` is the same for both.

### Publishing

On the Windows release machine, `npm run release:owl -- --linux-artifacts <folder>` takes the downloaded artifact, beside `--mac-artifacts`. It checks both receipts name the Windows Owl's version and source, that the package was built from that tarball, every file's size and SHA-256 with nothing extra, that the app in the tarball records that source and version, and that the package's `.PKGINFO`, `PKGBUILD` and `.SRCINFO` name the Owl's pacman version. The printed commands verify the tarball's and package's attestations before the create command, then attach both. Their lines join `SHA256SUMS.txt`, which still uploads last. `PKGBUILD` and `.SRCINFO` stay in the artifact; Owl has no Release pull request to record them in.

The default notes name Linux (Omarchy, x64), say to install the package with `sudo pacman -U` over Sotto, that it does not update itself, and that installing a stable package returns to stable.

## Consequences

- A Linux user on Omarchy can run Owl. Nothing new reaches their computer: no updater, no host, no dependency. The package and its data are stable's.
- Owl is not checked on Omarchy before it ships. The launch checks run under a virtual X display on Ubuntu, not on Hyprland: dictation keys, paste, the shell plugin and the widget on Omarchy are untried in an Owl until someone installs it. Stable keeps forge's checks.
- Each Owl costs two hosted Linux runs and a short third, free while the source repository is public.
- The Linux build adds no step on forge and no machine to the Owl procedure. Every Owl still needs its Windows build first, and `release:owl` refuses Linux files that disagree with it.
- What only the first run can show: that the runner's sandbox setting lets the app start, that the Arch container comes up and builds as an ordinary user, and that pacman's `vercmp` agrees with the ordering above.
