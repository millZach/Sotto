# Cutting a release

Releases are cut by hand on three machines and published to the public `millZach/Sotto-releases` repository, not to the private source repository. First-time macOS setup is `macos-bringup.md`; the rationale for the unsigned Apple silicon build is ADR-0001. ADR-0001's "no auto-updater on any platform" is superseded on Windows by the in-app updater (#103); macOS and Linux still have none.

## Promoting a Sotto Owl build to stable

Every change reaches Sotto Owl before Sotto (ADR-0072). Choose the Owl build Zach has run and wants to promote, normally the newest published Owl. Its release body names `Source commit: <full sha>`. Stable ships that exact source commit with the Owl version's base: `0.1.37-owl.20261011.1` ships as `0.1.37`. Commits merged to `main` after that Owl build wait for the next Owl.

`npm run release:check` reads only the public releases on `millZach/Sotto-releases`, without a token. It requires a clean checkout at the newest published Owl's full source commit; it never guesses from a tag target or falls back to an older named build. If the newest Owl names no source, publish a new clean Owl build with its source named first. If the desired build is older than the newest published Owl, publish a new Owl of the desired source commit before promoting it. The check records the checked source and versions in the ignored `release/stable-promotion.json`; packaging rechecks the checkout before consuming it.

Before cutting the Windows release, run `npm ci` and `npm run test:desktop-smoke` on the promoted checkout in an interactive Windows desktop. Record the commit and passing result in release evidence before packaging or publishing. The check builds that checkout once and runs isolated fake-provider recovery, Settings, daily-workspace and widget dictation journeys, including a real temporary shell, Git repository and local-only push. It makes no paid provider call and does not publish a release or regenerate design baselines. Run it without another Electron journey using the desktop; see [the desktop check](../ci.md#manual-windows-desktop-check). Normal CI gates must also pass.

The first desktop release whose Add host turns on a host's tailnet connections (ADR-0053, October 6 amendment) waits for the iPhone build that reads a host's 403 `forbidden` as a reason to keep trying. Check that build is on TestFlight before publication, or publish both together. An older iPhone paired with that host reads the refusal as unpaired while the host's phone access is off.

First-run setup's **Get the iPhone beta** opens `IPHONE_BETA_URL` in `src/shared/phones.ts`, which is a placeholder until external TestFlight testing has a public link (ADR-0063). Set it to that link in an Owl-tested commit before a release.

1. Read the chosen Owl release's source commit and base version. On each release machine, check out that exact source commit, keeping the tree clean. Do not bump `package.json` first. Run `npm ci`, the normal gates and the Windows desktop smoke check above. Mac stable ships the same promoted commit; macOS has no Owl stage yet.
2. Move that machine's previous installers, disk images and blockmaps from `release/` into `release/archive/`, so `release/` holds only the current version.
3. Run `npm run package:win` on Windows or `npm run package:mac` on the Mac. Build any host archive with `npm run package:host:release` on its release machine from this same promoted commit; it packages the same stable base version without changing the source manifest. Both run `release:check` first, then override the packaged manifest's version to the promoted Owl base without editing either source package manifest. Output names use that packaged version. Each verifies assets, builds, records provenance and checks packaged resources. Desktop packaging then runs `scripts/verify-owl-features-package.mjs` against the unpacked app on a throwaway profile, with every development override set to turn features on. Stable fails if a feature held in Owl is on or a feature sent to stable is off. The check uses the platform's executable and isolated profile, including the Mac's mock keychain, and writes its answers and screenshot to `release/owl-features-stable-package-status.json` and `release/owl-features-stable-package.png`. Windows still packages NSIS, and Mac still packages an Apple silicon DMG. `package:dir`, `package:dir:mac`, `package:linux` and CI's Package (Windows) remain offline, unchecked verification commands. Linux packaging keeps its separate manual procedure below; `package:linux` is unchanged.
4. Create `vX.Y.Z`, titled `Sotto X.Y.Z (beta)`, on public `millZach/Sotto-releases`, and attach the installers, disk image and available Linux artifacts as today. Assemble `SHA256SUMS.txt` across platforms and upload it last. Mark the superseded **stable** release as a prerelease so the newest stable is the only Latest. Owl tags contain `-owl.` and remain prereleases, never Latest; do not promote an Owl tag during stable cleanup.
5. After publication, branch `release/X.Y.Z` from current `main`. Run `npm version X.Y.Z --no-git-tag-version`, updating `package.json` and `package-lock.json` together, and update any `package:*` paths that still carry a literal version (currently `package:linux`). Commit as `Release X.Y.Z`, with a body saying which Owl and source were promoted. Open the Release pull request and merge it like every other change, once Gates (Windows) and Package result are green and it is up to date with `main`. The source repository carries no release tag. This records the shipped version so the next Owl builds on the next patch; it does not add newer `main` commits to the release already published.

## Keeping a feature in Owl and sending it to stable

When Zach calls something an Owl feature, add an entry to `src/shared/owlFeatures.ts` with its ID, plain-words name, first Owl date, owning ADR or plan and `sentToStable: false`. Every part asks the list before it exists: main reads all answers once at startup and passes them to owners; the renderer uses `useOwlFeature(id)`. Stable hides and starts none of it and preserves its saved records. Watcher is the first entry; its existing gate names are compatibility wrappers.

When Zach says the feature can go to stable, change that entry's `sentToStable: false` to `sentToStable: true`. That one-line change reaches Owl first; the next promotion carrying it turns the feature on in stable. This does not bypass the chosen Owl source commit or change other features. Once stable has carried it, remove its code's switches in a later change and keep the sent entry as the record. Remove Watcher's compatibility names only after its branches in flight no longer need them.

Unpackaged development, e2e and design runs can use `SOTTO_OWL_FEATURES=watcher=1` or `watcher=0`; separate multiple entries with commas. Explicit entries override the old `SOTTO_WATCHER_ENABLED` alias, and the last valid entry wins. Unknown IDs and invalid values are ignored. Packaged builds ignore both variables. To rerun the package check by hand, use `node scripts/verify-owl-features-package.mjs release/win-unpacked stable` (or `release/mac-arm64 stable` on the Mac, or `release/win-unpacked owl` for Owl).

## Artifacts

Each machine produces only its own platform's artifacts:

- Windows PC: `Sotto Setup X.Y.Z.exe`, the dashed `Sotto-Setup-X.Y.Z.exe` copies for GitHub upload, blockmaps, `latest.yml`.
- forge (x64 Linux): `Sotto-X.Y.Z-linux-x64.tar.gz`, plus the `sotto-bin-X.Y.Z-<pkgrel>-x86_64.pkg.tar.zst` built from it.
- Apple silicon Mac: `Sotto-X.Y.Z-arm64.dmg` and its blockmap. There is no `latest-mac.yml`: the mac build has a dmg target only, no zip target, and no auto-updater.

The local `release/` folder (gitignored) holds only the CURRENT version's artifacts for the machine it was built on.

`SHA256SUMS.txt` spans all three platforms: each machine appends its own hashes as `<hash>  <filename>` (two spaces, lower-case hex), and the assembled file is uploaded LAST, after every platform artifact is attached. On the Mac that is `shasum -a 256 <file>`; on the Windows PC:

```powershell
Get-ChildItem release\Sotto-Setup-*.exe, release\*.blockmap, release\latest.yml |
  ForEach-Object { (Get-FileHash -Algorithm SHA256 $_).Hash.ToLower() + '  ' + $_.Name }
```

## Release notes

macOS builds are ad-hoc signed (`identity: '-'`) and not notarized, so the release notes must carry the Gatekeeper instructions from the README (Privacy & Security → **Open Anyway**, or `xattr -dr com.apple.quarantine /Applications/Sotto.app`) plus "Apple silicon only".

## Where the feeds point

electron-builder's publish config and the Windows auto-update feed point at `millZach/Sotto-releases`. Windows installs are offered the new version by the in-app updater; macOS users download the disk image by hand. Linux users install the next pacman package; once `sotto-bin` is in the AUR, `omarchy update` brings it.

## Cutting a Sotto Owl build (Windows)

Sotto Owl is the Windows preview track, installed in place of Sotto. Watcher is available only in Owl builds. Build from `main` once a day when something has merged since the last Owl build, rather than after every merge. Fetch `origin/main` and compare its full SHA with the newest published Owl release's source commit. If they match, skip today's build. If they differ, build the clean `origin/main` commit. The first Owl, `v0.1.35-owl.20261010.1`, predates source lines; its verified source is `dee763ec8320a19ce43f070f8897710553abf35a` for this initial daily comparison only. `release:check` still refuses its missing source line.

For example, inspect the public feed and current main without reading private release data:

```powershell
gh api repos/millZach/Sotto-releases/releases --paginate --slurp --jq '[.[][] | select(.draft == false and (.tag_name | contains("-owl.")))] | sort_by(.published_at) | last | {tag: .tag_name, body: .body}'
git rev-parse origin/main
```

Run the normal gates and manual Windows desktop check before publishing. Publish only a reviewed clean-commit build; rebuild after committing local verification changes.

The version is the next patch of `main`'s stable package version followed by `-owl.<UTC YYYYMMDD>.<n>`. The lead chooses the next positive number for that date, checking existing Owl tags first. `0.1.36` becomes `0.1.37-owl.20261011.1`, then `.2` for another build that day. Never reuse a published version or replace its assets.

1. Archive previous output, then run `npm run package:owl -- --date 20261011 --number 1`. Omit `--date` to use today's UTC date. It verifies assets, builds, records `out/build-provenance.json`, builds x64 NSIS with `--publish never`, checks packaged resources and manifest agreement, and makes the dashed upload copies. The packaged Owl feature check launches the unpacked app on a throwaway profile with every override set to 1 and fails if any listed feature is off. Its answers and screenshot are `release/owl-features-owl-package-status.json` and `release/owl-features-owl-package.png`. It does not edit either source package manifest, install or publish.
2. Review `release/win-unpacked`, `release/Sotto Owl Setup 0.1.37-owl.20261011.1.exe`, its blockmap and `release/owl.yml`. Upload `Sotto-Owl-Setup-0.1.37-owl.20261011.1.exe` and `.exe.blockmap`, the names `owl.yml` references. Keep any stable `latest.yml` out of the Owl release.
3. Run `npm run release:owl -- --notes-file release/notes.md` (omit the argument for default preview notes). The helper checks the clean source checkout, build inputs and packaged provenance. It takes the full source SHA from `out/build-provenance.json`, writes `release/owl-notes.md` with `Source commit: <full sha>` and `release/SHA256SUMS.txt`, and **prints** the PowerShell `gh` commands for review. It never runs them. The title includes the first twelve SHA characters, for example `Sotto Owl 0.1.37-owl.20261011.1 (abc123def456)`.
4. After review, run the printed create command: a prerelease on `millZach/Sotto-releases`, tagged `v0.1.37-owl.20261011.1`, explicitly `--latest=false`, with the dashed installer, blockmap and `owl.yml`, and `--notes-file release/owl-notes.md`. Run the printed checksum upload command last. Do not attach `latest.yml` or change which stable release is Latest.
5. Inspect the published title, body, prerelease flag and four assets with the printed view command. Confirm the latest-release endpoint still names the stable tag. Download the published files and verify SHA256 sums. Packaging and preparing commands do not authorize publication.

To switch from stable to Owl, close Sotto and run the Owl installer over the existing installation. App ID `com.sotto.desktop`, product name Sotto, installer identity, executable and data directory stay unchanged, keeping threads, settings, keys and the dictation shortcut. Never uninstall or delete the profile. Owl offers only newer Owl tags with matching `owl.yml`; stable retains its stable feed and `latest.yml`. Both ask before download and restart.

To return, close Owl and install stable over it. Stable builds carrying the October 10 Watcher gate show and start none of Watcher and keep its saved record, thread kinds, settings and histories whole for a later return to Owl, even with Keep local history off in stable. A pane layout or selection pointing at Watcher does not survive the stable session; stable treats those views like missing threads rather than preserving or restoring hidden panes. The main records remain whole. To clear Watcher history, turn that setting off in Owl. The [gate verification](../verification/2026-10-10-watcher-owl-gate.md) exercises the real load/save paths. Older published stable builds, including 0.1.35 and 0.1.36, still drop Watcher's control record, thread kinds and capacity when saving; back up the closed profile before returning to one. The [October 9 note](../verification/2026-10-09-sotto-owl.md) records that older behavior.

Owl packaging and updates are Windows only for now. Mac stable ships the same promoted source commit without a Mac Owl stage; it has no updater (ADR-0001). Linux is outside this preview track.

### Matching Owl host archives

Usage is an Owl feature on every owning computer (ADR-0075). Plain Node Owl host archives can accompany the Windows desktop on the same prerelease; this adds no macOS or Linux Owl desktop. Each host enables features from its own packaged full version. An Owl desktop never activates a collector in a stable host.

On each host archive's native release machine, use the reviewed Windows Owl's exact full version and source commit from its provenance:

```sh
npm run package:host:owl -- --version 0.1.38-owl.20261012.1 --source <full-source-sha>
```

The command requires the requested clean checkout, preserves source manifests, verifies and smoke-tests the native archive, and writes its checksum sidecar and an Owl receipt. It refuses an existing output of that version. A Windows archive cannot serve as Linux evidence. The host and desktop inventories differ, so compare their full source commit and full version rather than their build-input hashes.

Bring each verified native archive and its `.sha256` sidecar to the release preparation machine, then pass each archive explicitly:

```sh
npm run release:owl -- --notes-file release/notes.md --host-archive release/Sotto-host-0.1.38-owl.20261012.1-linux-x64.tar.gz
```

Repeat `--host-archive` for other native platforms. Preparation inspects and verifies the archive's bytes, contents, own version, source and platform agreement; a receipt alone is insufficient. The printed create command attaches those archives and sidecars to the same Owl prerelease, and the combined checksum file still uploads last. Preparation never publishes, installs or restarts a host.

After publication, the user can choose the matching host update from the desktop. Busy-host and restart checks still apply. Equal-base stable hosts can explicitly switch to the chosen Owl target; Owl date and daily number order numerically, and newer hosts are not downgraded. Older hosts remain connected while Usage says unavailable. Returning to stable preserves the dormant Usage database. Stable host promotion and offline `package:host` remain unchanged.
## Speech model

The speech model is not in any installer (ADR-0071). Its four files are release assets on `millZach/Sotto-releases` under their own tag, `speech-model-parakeet-tdt-0.6b-v3-int8-1`, and every Sotto downloads them on first run. Publish that release once, and again only when the model changes:

- Create it as a **pre-release** and never mark it Latest. The updater reads only the release marked Latest, so an app release stays Latest and update checks are unaffected.
- Upload `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx` and `tokens.txt` exactly as sherpa-onnx publishes them in its `asr-models` release (`sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`). Their sizes and SHA-256 sums must match `SPEECH_MODEL` in `src/shared/speechModel.ts`, or every download is refused.
- A new model version gets a new tag and new pins in the same change; never replace the assets under an existing tag, because installed copies would refuse them.

## Linux desktop package

Cut by hand on forge (Omarchy, x64), using Node 24.21.0 and a clean `npm ci`. Never change shared electron-builder keys for Linux: `package:linux` enables the native rebuild on its command line and the `linux:` block owns the target. Windows and macOS keep their release commands.

```sh
mise exec node@24.21.0 -- npm ci
mise exec node@24.21.0 -- node node_modules/electron/install.js
mise exec node@24.21.0 -- npm run package:linux
```

The command produces `release/linux-unpacked` and `release/Sotto-X.Y.Z-linux-x64.tar.gz`. It verifies provenance, release assets, notices, normal startup, SQLite and the native PTY. The tarball is extracted and every file compared with the verified unpacked build, including external dependencies and native resources. Smoke profiles use `--password-store=basic` and an isolated HOME/XDG configuration so the release machine's keyring is untouched.

Run the four normal gates in [CI](../ci.md) and the external import allowlist check. For the real packaged launch, run `scripts/verify-linux-package.mjs` in the nested Hyprland wrapper described in its usage comment: verify `ready`, `gnome_libsecret`, tray registration and Settings writing/removing XDG autostart. Never send keys to forge's locked live desktop.

Set `pkgver`, `pkgrel` and the archive SHA-256 in `apps/omarchy/PKGBUILD` from the verified archive. The recipe's initial checksum records the ticket's local verification build, which is not a published release. Recalculate package-source hashes if the launcher, desktop entry, bindings, install helper or icons changed. Run `makepkg --printsrcinfo > .SRCINFO` after updating the recipe, before submitting it to the AUR. Build with the local archive:

```sh
cd apps/omarchy
SOTTO_TARBALL="$PWD/../../release/Sotto-X.Y.Z-linux-x64.tar.gz" makepkg --cleanbuild --force
pacman -Qlp "$(makepkg --packagelist)"
```

No root is needed to build. Check `/opt/sotto`, `/usr/bin/sotto`, the desktop entry and hicolor icons. `bsdtar -tvf` must show `chrome-sandbox` owned by root:root with mode 4755. Extract into a temporary root and run that root's launcher and dictation client before installing with `sudo pacman -U`. The optional `install.sh` requires sudo and is not part of automated verification. A release pass on the installed app finishes onboarding, dictates into Chromium and a terminal, and opens a thread (ADR-0062).

Hash the tarball and pacman package with `sha256sum`; append their lines to `SHA256SUMS.txt` with lower-case hex and two spaces before each filename. Publish both to `millZach/Sotto-releases` beside Windows and macOS artifacts, then upload the assembled checksum file last. Only reviewed clean-commit builds may be published. Confirm the downloaded artifacts against that file. Publishing and installation are manual owner actions, separate from verification; CI and package scripts never upload anything. The AUR publication follows once packaging is proven, under the owner's account.

## Linux host archive

The host is a Node process, not a Linux desktop app. For a stable release, use the same clean source commit the promoted Owl carried, Node 24 and a clean `npm ci`, then run `npm run test:socket` and `npm run package:host:release`. That command runs `release:check` and packages the promoted stable base version in the archive, runtime manifest and bundled host. The desktop can then find the matching versioned archive. The ordinary `package:host` and the CI job **Host archive and socket contract (Linux)** stay offline and use the checkout manifest version for verification. CI retains its archive for review and never publishes a release.

`package:host` builds only the headless entry. It produces `release/Sotto-host-X.Y.Z-linux-x64.tar.gz` and a matching `.tar.gz.sha256` sidecar on the x64 Linux runner. Local builds carry their actual platform and architecture in the filename; a Windows smoke build is not a Linux release. There is no cross-platform native-module copy or Electron packaging step.

`build-host.mjs` and `package-host.mjs` use the checkout's `out/host` folder by default; `package-host.mjs` writes archives into the checkout's `release` folder. Set `SOTTO_HOST_OUT_DIR` and `SOTTO_HOST_RELEASE_DIR` to use other output folders, as the packaging regression test does. Relative overrides resolve from the checkout, regardless of the command's working folder. The test builds once through packaging and removes its temporary build and archive folders afterward.

The archive extracts directly into an installation directory:

```text
host/index.js
host/external-dependencies.json
host/bundled-dependencies.json
node_modules/zod/
package.json
runtime-manifest.json
build-provenance.json
LICENSE.md
THIRD_PARTY_NOTICES.md
```

The manifest requires Node `>=24 <25`; Node itself and provider CLIs are not included. Install Node 24 and the desired provider CLI on the host and sign in there. The reviewed runtime closure is Node built-ins and zod, with no bundled dependencies or native modules. Packaging refuses a new external, an unexpected transitive dependency, or a native binary. The existing notices check covers the host inventory. Provenance records the source commit, dirty-tree status, build-input digest, Node/build platform, and every packaged file's size and digest. Only a reviewed clean-commit build is eligible for publication.

The packaging command verifies the staged directory, extracts the resulting archive into a fresh temporary directory, verifies all hashes again, starts its `host/index.js` outside the checkout with every provider turned off, so no client installed on the machine starts, checks the loopback listener's identity, and verifies that shutdown saved the workspace. Linux delivers a real SIGTERM. A Windows development smoke substitutes that signal through a test-only IPC handler; it is not evidence of Linux execution.

After reviewing the green Linux job and its matching provenance, attach the Linux archive and its `.sha256` sidecar beside the desktop installers on `millZach/Sotto-releases`; a host update downloads and checks both. Add its sidecar line to the combined `SHA256SUMS.txt` before uploading that file last. Do not publish a Windows smoke archive as Linux. Publishing is still a separate manual release action.

A host that runs an older release is updated from the desktop's Threads page (ADR-0040): the host downloads `Sotto-host-X.Y.Z-<platform>-<arch>.tar.gz` and its `.sha256` sidecar from `https://github.com/millZach/Sotto-releases/releases/download/vX.Y.Z/`, so both must be attached to the release under exactly those names, and a platform without an archive is told there is none. The update unpacks the archive into the installation folder's `versions/X.Y.Z/` and writes the version into the folder's `current` file, which is what the launch script starts.

To do the same by hand on Forge, verify the release checksum, extract into a version folder, point `current` at it, and restart the host (Stop host in Settings > Hosts, then switch it on):

```sh
cd "$HOME/.local/share/sotto-host"
sha256sum -c Sotto-host-X.Y.Z-linux-x64.tar.gz.sha256
mkdir -p versions/X.Y.Z
tar -xzf Sotto-host-X.Y.Z-linux-x64.tar.gz -C versions/X.Y.Z
printf 'X.Y.Z\n' > current
```

A folder without `current` holds one flat install, extracted into the folder itself, and the launch script starts its `host/index.js` as before. To run a version by hand instead, start it from its folder:

```sh
cd "$HOME/.local/share/sotto-host/versions/X.Y.Z"
node host/index.js --data "$HOME/.sotto"
```

No `npm install` is needed in the extracted archive. Keep the data directory outside the versioned installation. A new empty host can start without a credential key; saving hosted-provider credentials requires a separately stored key file passed with `--key-file` or `SOTTO_HOST_KEY_FILE`. Never copy the desktop credential store to Forge. The listener binds loopback only. Point the desktop's SSH host settings at the installation folder (`~/.local/share/sotto-host`, not a version folder inside it), then pair explicitly. Installing an archive grants no permission authority.

The scripts and CI job do not establish that an archive has been published or that Forge has been tested. Record the release URL, Linux CI run, and actual Forge SSH connection evidence when those acceptance checks are completed.
