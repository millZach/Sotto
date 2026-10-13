# Linux stable release command

The release-source rule recorded here is historical, superseded by ADR-0072's October 13 switch rule. Stable now ships a clean, CI-green main commit without an Owl prerequisite. The checks and results below record what was verified at the time.

VERIFIED on forge (Omarchy, x64), October 13, 2026, with Node 24.21.0 and Electron 43.1.0. The complete `0.1.38` rehearsal used clean source commit `02026faccaff42048ebd2cd39e7e5c74f0a77d9e` on `chore/linux-stable-package`, after the external review fixes. These are rehearsal artifacts: **not publishable**. Nothing was installed, uploaded, published or merged.

## The two commands

After a clean worktree `npm ci` and Electron installation, ran:

```sh
mise exec node@24.21.0 -- npm run package:linux:rehearse -- 0.1.38
mise exec node@24.21.0 -- node scripts/release-linux.mjs --rehearse 0.1.38
```

Builder downloads and its large temporary archive were routed to ignored worktree caches with `ELECTRON_CACHE`, `ELECTRON_BUILDER_CACHE` and `APP_BUILDER_TMP_DIR`. Test runs left `TMPDIR` unset. Each GUI probe used `with-nested-hyprland.mjs`; its cleanup reported no remaining owned processes and preserved the live compositor. Work logs are in `.cache/linux-release/`.

Both commands passed. `release/` contains `Sotto-0.1.38-linux-x64.tar.gz`, `sotto-bin-0.1.38-1-x86_64.pkg.tar.zst`, the copied `PKGBUILD`, generated `.SRCINFO` and the two-line checksum file. The [packaging record](../../artifacts/linux-release-command/linux-desktop-package.json) binds the source, version, rehearsal mode and archive hash. Neither source package manifest nor `apps/omarchy/PKGBUILD` or `.SRCINFO` changed during the rehearsal. The procedure records the generated recipe in the later Release PR after publication.

The packaged-resource probe compared all 288 shipped files with the tarball, verified provenance and notices, loaded SQLite 3.53.1 with migration 4 and FTS5, ran the packaged PTY, loaded the speech engine, and checked normal startup and the audio worklet. Main and preload imports passed `verifyExternalDependencyInventories` against the reviewed allowlist. The packaged module roots were `node-addon-api`, `node-pty`, `sherpa-onnx-linux-x64`, `sherpa-onnx-node` and `zod`.

The [Owl feature answers](../../artifacts/linux-release-command/owl-features-stable-package-status.json) report stable `0.1.38`, packaged and isolated, with Watcher off even though both development overrides were set to 1. The [onboarding capture](../../artifacts/linux-release-command/owl-features-stable-package.png) was inspected: the Sotto mark, text and Get started action render clearly.

## Pacman and extracted launcher

The finishing command generated `.SRCINFO` with the canonical public download URL and built with the local archive. Independently reran `makepkg --printsrcinfo` from `release/`; it matched the saved `.SRCINFO` byte for byte. All seven source checksums passed makepkg. The pacman file list contained 373 entries.

The [package verification](../../artifacts/linux-release-command/linux-release-verification.json) records root:root 4755 on `chrome-sandbox`, the executable, launcher and PATH link, desktop entry, three hicolor icons and license. The bindings, theme and shell plugin and their helpers exist under both `/opt/sotto/resources/omarchy/` and `/usr/share/sotto/`; all 15 setup resource files matched the unpacked build.

In an extracted temporary root, drove Get started and every remaining setup step, skipped the tour, opened Settings → Application, pressed Space to turn on Launch when you sign in, checked the isolated XDG file and generated systemd unit, then turned it off and checked removal. The packaged app reported ready, `gnome_libsecret` available and a registered tray. The extracted launcher delivered `sotto dictation toggle` with exit code 0. Rootless extraction used `--disable-setuid-sandbox`; the user namespace sandbox remained enabled. No key was saved and no desktop configuration outside the temporary profile was changed.

Both lines in the retained [SHA256SUMS.txt](../../artifacts/linux-release-command/SHA256SUMS.txt) passed `sha256sum -c` against the actual distributables in `release/`. They use lower-case hex and two spaces.

The first rehearsal exposed two older probe assumptions. Its fixed seven-step loop stopped before Finish setup after the added Omarchy step; it now reads and waits for the displayed step count. Its private socket path was 113 bytes in this worktree and a minimal AF_UNIX reproduction failed with EINVAL. The probe now reserves a short owned 0700 runtime in `.cache/`; the regression test binds a real socket at this worktree's path length. Repeated the complete pipeline after these fixes, with all checks passing.

## Promotion refusal and checks

`npm run package:linux:stable` exited 1 before packaging. The retained [command output](../../artifacts/linux-release-command/stable-rejection.txt) says:

```text
This checkout is 02026faccaff42048ebd2cd39e7e5c74f0a77d9e. Check out 99cb180b0201a0ada48a6bd88ae12ceb7411fd37, the commit Sotto Owl 0.1.37-owl.20261011.2 carried, or publish an Owl build of this commit first.
```

The focused release tests passed: 66 tests in seven files. The Linux platform-profile Playwright spec passed all three journeys in nested Hyprland: clipboard failure recovery, Settings key storage and platform copy, and retained transcript after paste failure. Two independent session-model reviewers, routed by Zach's Codex models setting, reviewed standards and brief coverage separately, including the probe fixes, editor cleanup fix and external review fixes. Neither axis reported an unresolved finding.

The external review found that a failed finish left earlier recipes and checksum records behind. Reproduced this by finishing `0.1.39` after a successful `0.1.38` rehearsal: the missing tarball error left the old finishing records present. After the fix, the same command gave the matching-packaging retry instruction and removed those records while preserving the tarball input. Both stages now invalidate prior finishing outputs; the finish stages its bundle and moves the completion record last. Regression tests also cover missing receipt/archive guidance, a saved promotion changed during the probe, and a failed build that also changes the source manifest. The last case retains both errors. Repeated the full rehearsal after all four fixes.

The first full suite passed 10,160 cases but exited with one unhandled Tiptap teardown error in `threadActivity.test.tsx`. Its prompt editor was still alive after cleanup; a lifecycle assertion reproduced that deterministically. The test now closes its owned editors before jsdom releases `document`. All 29 targeted cleanup/release checks passed. The final full rerun after the review fixes passed: 801 test files and 10,167 cases, with 56 files and 197 cases skipped and no unhandled errors. `npm run typecheck` and `npm run lint` passed; `npm run notices:verify` verified 189 components. CI and external review are recorded in the PR.

Installation, dictation into real applications and live provider threads are outside this task: installation and publication were explicitly prohibited. Windows packaging and desktop behavior are checked by the PR's Package and Desktop jobs; macOS execution was not tested on forge. Shared electron-builder settings and the Windows/macOS targets are unchanged.
