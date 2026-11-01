# Cutting a release

Stable releases are cut by hand on the Windows PC and forge, with the Mac half built in GitHub Actions. Each Sotto Owl is cut every night in GitHub Actions by the **Sotto Owl nightly** workflow, all three platforms, and can still be cut by hand. Both are published to the public `millZach/Sotto-releases` repository, not to the source repository. First-time macOS setup is `macos-bringup.md`; the rationale for the unsigned Apple silicon build is ADR-0001, and ADR-0096 moved its stable build to GitHub Actions. ADR-0001's "no auto-updater on any platform" is superseded on Windows by the in-app updater (#103); macOS and Linux still have none.

## Cutting stable from main

Owl features sit behind their switch; everything else goes straight to stable (ADR-0072). Choose a clean commit on `origin/main` with successful Gates (Windows) and Package result checks. Stable needs no published Owl build. Windows, Mac, Linux and the release host use the same source commit and stable version.

`npm run release:check` fetches `origin/main` and reads the public Sotto check-runs API and `millZach/Sotto-releases` feed without a token; only the **Sotto stable for Mac** workflow sets `SOTTO_RELEASE_CHECK_TOKEN` to its read-only job token, for the rate limit. It refuses a dirty checkout, a commit outside main, missing or unsuccessful required CI, and a version no newer than the newest published stable. Superseded plain stable tags still count even when marked prerelease; Owl and speech-model tags do not. The default is the next patch of the source `package.json`, such as `0.1.37` to `0.1.38`. Choose another plain stable version with `npm run release:check -- --version X.Y.Z`, and pass the same `--version X.Y.Z` to each stable packaging command. Commands always perform a fresh release check. Rate limits and unreadable responses stop the check with a retry instruction.

The check records its source, main reference, source and selected versions, latest published stable and successful check runs in the ignored `release/stable-promotion.json`. The filename is retained for existing tooling; it records main eligibility now. Packaging rechecks the clean checkout, main membership and saved evidence before and after building.

Before cutting the Windows release, run `npm ci` and `npm run test:desktop-smoke` on the chosen main checkout in an interactive Windows desktop. Record the commit and passing result in release evidence before packaging or publishing. The check builds that checkout once and runs isolated fake-provider recovery, Settings, daily-workspace and widget dictation journeys, including a real temporary shell, Git repository and local-only push. It makes no paid provider call and does not publish a release or regenerate design baselines. Run it without another Electron journey using the desktop; see [the desktop check](../ci.md#manual-windows-desktop-check). Normal CI gates must also pass.

The first desktop release whose Add host turns on a host's tailnet connections (ADR-0053, October 6 amendment) waits for the iPhone build that reads a host's 403 `forbidden` as a reason to keep trying. Check that build is on TestFlight before publication, or publish both together. An older iPhone paired with that host reads the refusal as unpaired while the host's phone access is off.

First-run setup's **Get the iPhone beta** opens `IPHONE_BETA_URL` in `src/shared/phones.ts`, the iPhone app's public TestFlight link (ADR-0063). If Apple's link changes, update it in a reviewed main commit before a release.

1. Fetch `origin/main` and choose the clean, CI-green source commit. Check out that exact commit on each release machine; the Mac half is built from it in GitHub Actions in step 3. Do not bump `package.json` first. Run `npm ci`, the normal gates and the Windows desktop smoke check above. Agree the stable version across machines; the next patch is the default.
2. Move that machine's previous installers, disk images and blockmaps from `release/` into `release/archive/`, so `release/` holds only the current version.
3. Run `npm run package:win` on Windows or `npm run package:linux:stable` on forge, and build the Mac half with the **Sotto stable for Mac** workflow below. On forge, finish the pacman package with `node scripts/release-linux.mjs` as described below. Build a host archive for every platform paired hosts run on, each with `npm run package:host:release` on its native release machine from this same checked main commit: Linux x64 on forge and Apple silicon Mac on a Mac (see [Host archives for a stable release](#host-archives-for-a-stable-release)). It packages the same stable version without changing the source manifest. Stable packaging commands run `release:check` first, then override the packaged manifest's version to the checked stable version without editing either source package manifest. Output names use that packaged version. Each verifies assets, builds, records provenance and checks packaged resources. Desktop packaging then runs `scripts/verify-owl-features-package.mjs` against the unpacked app on a throwaway profile, with every development override set to turn features on. Stable fails if a feature held in Owl is on or a feature sent to stable is off. The check uses the platform's executable and isolated profile, including the Mac's mock keychain, and writes its answers and screenshot to `release/owl-features-stable-package-status.json` and `release/owl-features-stable-package.png`. Windows still packages NSIS, and Mac still packages an Apple silicon DMG. Mac packaging first builds the Core ML speech helper with `swift build` (ADR-0094), so the Mac, or the workflow's runner, needs Xcode with Swift 6 or later; `package:dir:mac` and Owl's Mac build do the same, and the packaged-resources check runs the helper. `package:dir`, `package:dir:mac`, `package:linux` and CI's Package (Windows) remain offline, unchecked verification commands. Linux stable packaging checks its tarball and Owl feature answers too; `package:linux` remains unchecked.

   Build the Mac half in GitHub Actions from the same full source commit and stable version (ADR-0096). The workflow file is read from `main`:

   ```powershell
   gh workflow run stable-mac.yml --repo millZach/Sotto --ref main -f version=X.Y.Z -f source=<full sha>
   gh run list --repo millZach/Sotto --workflow stable-mac.yml --limit 1
   gh run watch <run id> --repo millZach/Sotto
   gh run download <run id> --repo millZach/Sotto --name sotto-stable-mac-X.Y.Z --dir release/stable-mac
   gh attestation verify release/stable-mac/Sotto-X.Y.Z-arm64.dmg --repo millZach/Sotto
   gh attestation verify release/stable-mac/Sotto-X.Y.Z-arm64.dmg.blockmap --repo millZach/Sotto
   ```

   The run checks out that commit on an Apple silicon runner with full history and runs `npm run package:mac -- --version X.Y.Z`, the same command and checks as by hand; its read-only job token only lifts the public rate limit on the release check's reads. It writes the receipt `release/mac-desktop-package.json`, naming the version, source commit and each file's size and SHA-256, keeps the disk image and blockmap for 14 days as the artifact `sotto-stable-mac-X.Y.Z` with the receipt, `stable-promotion.json`, the Owl feature answers and screenshot, and `SHA256SUMS-mac.txt`. A second job, the only one with write scopes, attests the disk image and blockmap. It publishes nothing. Download it into an empty `release/stable-mac`, and check the receipt names the same source commit and version as the Windows build before attaching anything. If the workflow cannot run, the fallback is the hand path: check out the same commit on an Apple silicon Mac with the Xcode Command Line Tools (`xcode-select --install`), because packaging builds the key listener with `swiftc`, run `npm ci`, `node node_modules/electron/install.js` and `npm run package:mac -- --version X.Y.Z`.
4. Create `vX.Y.Z`, titled `Sotto X.Y.Z (beta)`, on public `millZach/Sotto-releases`, and attach the installers, the Mac disk image and blockmap from `release/stable-mac`, available Linux artifacts, and every host archive with its `.sha256` sidecar. Assemble `SHA256SUMS.txt` across platforms, adding each sidecar's line, appending the Mac lines from `release/stable-mac/SHA256SUMS-mac.txt` after checking them against `Get-FileHash -Algorithm SHA256` on the downloaded files, and upload it last. Mark the superseded **stable** release as a prerelease so the newest stable is the only Latest. Owl tags contain `-owl.` and remain prereleases, never Latest; do not promote an Owl tag during stable cleanup.
5. After publication, branch `release/X.Y.Z` from current `main`. Run `npm version X.Y.Z --no-git-tag-version`, updating `package.json` and `package-lock.json` together, and update any `package:*` paths that still carry a literal version (currently the unchecked `package:linux`). If Linux shipped, copy forge’s verified `release/PKGBUILD` and `release/.SRCINFO` into `apps/omarchy/` in this Release PR. These record the shipped version, `pkgrel=1` and every source checksum; do not regenerate them from a different build. Commit as `Release X.Y.Z`, with a body naming the shipped source and version. Open the Release pull request and merge it like every other change, once Gates (Windows), Package result and Desktop result are green and the overlap rule in AGENTS.md is satisfied. The source repository carries no release tag. This records the shipped version so the next Owl builds on the next patch; it does not add newer `main` commits to the release already published.

## Keeping a feature in Owl and sending it to stable

When Zach calls something an Owl feature, add an entry to `src/shared/owlFeatures.ts` with its ID, plain-words name, first Owl date, owning ADR or plan and `sentToStable: false`. Every part asks the list before it exists: main reads all answers once at startup and passes them to owners; the renderer uses `useOwlFeature(id)`. Stable hides and starts none of it and preserves its saved records. Watcher is the first entry; its existing gate names are compatibility wrappers.

When Zach says the feature can go to stable, change that entry's `sentToStable: false` to `sentToStable: true`. The next stable release from main carrying that change turns the feature on. Other features keep their own answers. Once stable has carried it, remove its code's switches in a later change and keep the sent entry as the record. Remove Watcher's compatibility names only after its branches in flight no longer need them.

Unpackaged development, e2e and design runs can use `SOTTO_OWL_FEATURES=watcher=1` or `watcher=0`; separate multiple entries with commas. Explicit entries override the old `SOTTO_WATCHER_ENABLED` alias, and the last valid entry wins. Unknown IDs and invalid values are ignored. Packaged builds ignore both variables. To rerun the package check by hand, use `node scripts/verify-owl-features-package.mjs release/win-unpacked stable` (or `release/mac-arm64 stable` on the Mac, `release/linux-unpacked stable` inside nested Hyprland on forge, or `release/win-unpacked owl` for Owl).

## Artifacts

Each machine or workflow produces only its own platform's artifacts:

- Windows PC: `Sotto Setup X.Y.Z.exe`, the dashed `Sotto-Setup-X.Y.Z.exe` copies for GitHub upload, blockmaps, `latest.yml`.
- forge (x64 Linux): `Sotto-X.Y.Z-linux-x64.tar.gz`, plus the `sotto-bin-X.Y.Z-<pkgrel>-x86_64.pkg.tar.zst` built from it.
- **Sotto stable for Mac** (`stable-mac.yml` on GitHub's Apple silicon runner, or an Apple silicon Mac as the fallback): `Sotto-X.Y.Z-arm64.dmg` and its blockmap, with the receipt `mac-desktop-package.json` and `SHA256SUMS-mac.txt` in the workflow artifact. There is no `latest-mac.yml`: the mac build has a dmg target only, no zip target, and no auto-updater.

The local `release/` folder (gitignored) holds only the CURRENT version's artifacts for the machine it was built on, and `release/stable-mac` the downloaded Mac artifact.

`SHA256SUMS.txt` spans all three platforms: each platform's hashes are appended as `<hash>  <filename>` (two spaces, lower-case hex), and the assembled file is uploaded LAST, after every platform artifact is attached. The Mac workflow writes its lines to `SHA256SUMS-mac.txt` (by hand on a Mac, `shasum -a 256 <file>`); on the Windows PC:

```powershell
Get-ChildItem release\Sotto-Setup-*.exe, release\*.blockmap, release\latest.yml |
  ForEach-Object { (Get-FileHash -Algorithm SHA256 $_).Hash.ToLower() + '  ' + $_.Name }
```

## Release notes

macOS builds are ad-hoc signed (`identity: '-'`) and not notarized, so the release notes must carry the Gatekeeper instructions from the README (Privacy & Security → **Open Anyway**, or `xattr -dr com.apple.quarantine /Applications/Sotto.app`) plus "Apple silicon only".

## Where the feeds point

electron-builder's publish config and the Windows auto-update feed point at `millZach/Sotto-releases`. Windows installs are offered the new version by the in-app updater; macOS users download the disk image by hand. Linux users install the next pacman package; once `sotto-bin` is in the AUR, `omarchy update` brings it.

## Cutting a Sotto Owl build

Sotto Owl is the preview track for Windows, Apple silicon Macs and Linux (Omarchy, x64), installed in place of Sotto (ADR-0072, ADR-0093, ADR-0099). Owl carries every Owl feature Zach has not yet sent to stable; on October 23, 2026 he sent all nineteen, so none is held until he names a new one. Owl is built from `main` once a night when something has merged and passed CI, rather than after every merge. The **Sotto Owl nightly** workflow does that at midnight UTC with no computer of Zach's switched on ([below](#the-nightly-owl)). A hand cut on the Windows PC ([after it](#cutting-an-owl-by-hand)) follows the same rules and stays available.

### The nightly Owl

`.github/workflows/owl-nightly.yml` runs at `0 0 * * *` (midnight UTC) on `main`, and when started by hand (ADR-0072, November 1, 2026). One night runs at a time; a second start waits for the first.

**Whether it builds.** It reads `main`'s commit, the newest published Owl's `Source commit:` line and the required checks on `main`'s commit. It builds only when `main` has moved since that Owl and Gates (Windows), Package result and Desktop result all succeeded on `main`'s commit. A check that is missing, still running or failed skips the night, and so does an unchanged `main`; the run's summary says which. The next night tries again, so a commit whose CI finished after midnight is built then.

**The version.** The next patch of `main`'s package version, then `-owl.<UTC date of the run>.<n>`, where `n` is one past the highest Owl of that day on `millZach/Sotto-releases`, whatever its base, counting tags as well as releases. A night after a hand cut on the same day takes the next number. If a hand cut publishes the version a running nightly chose, the nightly finds the tag taken and stops before publishing anything.

**What it does,** all from that one commit and version:

1. **Windows**, on `windows-latest`: `npm run package:owl -- --version <version> --source <sha>`, the hand cut's command and checks, pinned. The installer is unsigned, as every Owl has been so far; Windows code signing is a separate step that waits on its certificate. It keeps the installer, blockmap, `owl.yml`, the app's `app.asar` and `out/build-provenance.json` as `sotto-owl-windows-<version>`.
2. **Mac and Linux**: it calls `owl-mac.yml` and `owl-linux.yml` with the same version and source, so each runs exactly as when started by hand and keeps the same artifacts. The Mac half signs in the `owl-mac` environment, which admits only `main`.
3. **The Linux host archive**, on `ubuntu-24.04` rather than forge: `npm run test:socket`, then `npm run package:host:owl -- --version <version> --source <sha>`.
4. **Launch checks**, each on a runner that did not build it: the Windows installer is installed silently (`/S`), Sotto.app is copied out of the disk image and Gatekeeper is asked about the copy, and the Linux tarball is extracted under a virtual display. `tools/verify-owl-package.mjs <version> --app <folder>` opens each on a throwaway profile, waits for the window's **Get started** and checks it reports this version on the Owl track. Screenshots are kept as `owl-launch-<platform>-<version>`.
5. **Verify and gather**, on `windows-latest` against a clean checkout of the source: `release:owl`'s checks, the same as step 5 below, with both host archives and the default notes. Every asset, `owl-notes.md` and `SHA256SUMS.txt` are kept as `sotto-owl-nightly-<version>`.
6. **Attest** every release file, then check each attestation.
7. **Publish**, in the `owl-release` environment: check every file's checksum and attestation again, refuse a tag already on the release repository, create the prerelease with `--prerelease --latest=false` and the default notes, and upload `SHA256SUMS.txt` last. Then check the release carries exactly those files, Latest is still the newest stable, and every file downloaded again matches its checksum.
8. **The site.** Publishing starts **Deploy site** on `millZach/Sotto-releases`, which can report success and leave saysotto.com on the previous builds (#1894). The job waits for that run, then checks for up to twelve minutes, the page's cache time, that saysotto.com links the new Owl for Windows, the Mac, the Linux package and the Linux tarball. If it does not, the job starts Deploy site from `main` once more and checks again. If the page is still stale, the job fails and says so. The release itself stands; run Deploy site by hand.

**The token.** Publishing to another repository needs one credential the hand cut never stored: `SOTTO_RELEASES_TOKEN`, a fine-grained personal access token for `millZach/Sotto-releases` only, with **Contents: read and write** (create the release, upload its files) and **Actions: read and write** (start and follow Deploy site). It lives in the `owl-release` environment, which admits only `main`, and only the publish and site jobs read it. Without it, the publish job fails at its first step and nothing is published, after every build and check has passed.

**A dry run.** Started by hand, the workflow publishes only when **publish** is ticked, and only from `main`. Otherwise it is a dry run: it builds, launches, verifies and attests whatever the skip rules say, reports what a publishing run would have done, and publishes nothing. From another branch it builds the newest `main` commit that branch holds. The Mac half needs the `owl-mac` environment, which admits only `main`, so a dry run from another branch needs that branch added to the environment for the run and removed afterwards.

```powershell
gh workflow run owl-nightly.yml --repo millZach/Sotto --ref main                 # dry run
gh workflow run owl-nightly.yml --repo millZach/Sotto --ref main -f publish=true # publish now, skip rules apply
```

**When a night fails.** Nothing is published unless the Publish job ran. Re-run the failed jobs from the run's page; the run keeps its version. A run whose only failure is the site check needs only Deploy site.

### Cutting an Owl by hand

The steps below cut an Owl from the Windows PC, as before the nightly. Fetch `origin/main` and compare its full SHA with the newest published Owl release's source commit. If they match, skip today's build. If they differ, build the clean `origin/main` commit once its Gates (Windows), Package result and Desktop result have succeeded. The first Owl, `v0.1.35-owl.20261010.1`, predates source lines; its verified source is `dee763ec8320a19ce43f070f8897710553abf35a` for this initial daily comparison only.

For example, inspect the public feed and current main without reading private release data:

```powershell
gh api repos/millZach/Sotto-releases/releases --paginate --slurp --jq '[.[][] | select(.draft == false and (.tag_name | contains("-owl.")))] | sort_by(.published_at) | last | {tag: .tag_name, body: .body}'
git rev-parse origin/main
```

Run the normal gates and manual Windows desktop check before publishing. Publish only a reviewed clean-commit build; rebuild after committing local verification changes.

The version is the next patch of `main`'s stable package version followed by `-owl.<UTC YYYYMMDD>.<n>`. The lead chooses the next positive number for that date, checking existing Owl tags first, including any the nightly published. `0.1.36` becomes `0.1.37-owl.20261011.1`, then `.2` for another build that day. Never reuse a published version or replace its assets.

Owl uses the source manifest's stable version for remote hosts, so it can use the currently published stable host before the next stable release exists. A stable cut from manifest `0.1.37` ships desktop and host `0.1.38`, while an Owl built from that manifest still expects host `0.1.37`. After the host moves to `0.1.38`, that Owl can report that the host is newer. Publish the Release PR promptly, then build and install a new Owl from the updated main manifest before pairing it with that newer stable host. An already installed Owl keeps its compiled host-version choice; the Release PR alone does not update it. Keep each desktop and its hosts on matching versions during this window. This compatibility window predates the stable-from-main rule, and it applies only to an Owl built with Usage and every hosted provider held. Every Owl since Usage reached it asks for its own Owl host version, as the steps below build.

1. Archive previous output, then run `npm run package:owl -- --date 20261011 --number 1`. Omit `--date` to use today's UTC date. It verifies assets, builds, records `out/build-provenance.json`, builds x64 NSIS with `--publish never`, checks packaged resources and manifest agreement, and makes the dashed upload copies. The packaged Owl feature check launches the unpacked app on a throwaway profile with every override set to 1 and fails if any listed feature is off. Its answers and screenshot are `release/owl-features-owl-package-status.json` and `release/owl-features-owl-package.png`. It does not edit either source package manifest, install or publish.
2. Build the Mac and Linux halves in GitHub Actions from the same version and full source commit (the `sourceCommit` in `out/build-provenance.json`). Both workflow files are read from `main`, and both runs can go at once. The Mac half:

   ```powershell
   gh workflow run owl-mac.yml --repo millZach/Sotto --ref main -f version=0.1.37-owl.20261011.1 -f source=<full sha>
   gh run list --repo millZach/Sotto --workflow owl-mac.yml --limit 1
   gh run watch <run id> --repo millZach/Sotto
   gh run download <run id> --repo millZach/Sotto --name sotto-owl-mac-0.1.37-owl.20261011.1 --dir release/owl-mac
   gh run download <run id> --repo millZach/Sotto --name sotto-owl-mac-host-0.1.37-owl.20261011.1 --dir release/owl-mac-host
   ```

   The run checks out that commit on an Apple silicon runner and runs `package:owl -- --version <version> --source <sha>`, which refuses a checkout that is not clean and at that commit, or a version that is not this manifest's next Owl. It builds `Sotto-Owl-<version>-arm64.dmg` and `Sotto-Owl-<version>-arm64-mac.zip`, signs the app with Sotto's Developer ID from the `owl-mac` environment, with the hardened runtime, and has Apple notarize it and staple the ticket. It then checks the signature with `codesign --verify --deep --strict`, the Developer ID authority, that `spctl` accepts it as a Notarized Developer ID and that `xcrun stapler validate` passes, checks the disk image, compares the app in the zip with the verified app, runs the Owl feature check, writes the receipt `release/owl-mac-package.json`, attests the disk image and zip, and keeps them with `owl-mac.yml` as the artifact for 14 days. It publishes nothing. The `owl-mac` environment allows only `main`, so start the run with `--ref main`; a run without the five secrets fails and builds nothing (`macos-owl-signing.md`). Download it into an empty `release/owl-mac`.

   After the signing keychain is removed and the app is kept, the same run builds the Mac host archive with `package:host:owl -- --version <version> --source <sha>` and keeps `Sotto-host-<version>-darwin-arm64.tar.gz` and its `.sha256` sidecar as a second artifact, `sotto-owl-mac-host-<version>`, for 14 days. It is a separate artifact because `release/owl-mac` must hold only the files the Mac receipt lists. Download it into an empty `release/owl-mac-host`. Every Owl carries a Mac host archive, so a run that fails here is started again with the same version and source; nothing was published.

   The Linux half:

   ```powershell
   gh workflow run owl-linux.yml --repo millZach/Sotto --ref main -f version=0.1.37-owl.20261011.1 -f source=<full sha>
   gh run list --repo millZach/Sotto --workflow owl-linux.yml --limit 1
   gh run watch <run id> --repo millZach/Sotto
   gh run download <run id> --repo millZach/Sotto --name sotto-owl-linux-0.1.37-owl.20261011.1 --dir release/owl-linux
   ```

   The run refuses a source outside `main`'s history, then runs `package:owl -- --version <version> --source <sha>` on an Ubuntu runner under a virtual display, with the same refusals as the Mac. It builds `Sotto-Owl-<version>-linux-x64.tar.gz`, compares it file by file with the unpacked app, launches the app to check its resources and that every Owl feature is on, and writes `release/owl-linux-package.json`. An Arch Linux container then runs pacman's `vercmp` on the orderings the Owl needs, builds `sotto-bin` from that tarball with the stable recipe as an ordinary user, checks it as stable Linux is checked, without the Hyprland launch, and writes `owl-linux-pacman.json`. The package's version is the Owl's without the hyphen, so `0.1.37-owl.20261011.1` is `sotto-bin-0.1.37owl.20261011.1-1-x86_64.pkg.tar.zst`: pacman sorts it after stable `0.1.36` and before stable `0.1.37` (ADR-0099). A last job attests the tarball and the package. The artifact keeps them with `PKGBUILD`, `.SRCINFO` and both receipts for 14 days. It reads no secrets and publishes nothing. Download it into an empty `release/owl-linux`.
3. Build the matching Linux host on an x64 Linux machine (Forge), from a clean checkout of the same full source commit with Node 24 and `npm ci`: run `npm run test:socket`, then `npm run package:host:owl -- --version 0.1.37-owl.20261011.1 --source <full sha>`. An Owl desktop asks a paired host for exactly its own version, as a stable desktop does, so without `Sotto-host-<Owl version>-linux-x64.tar.gz` and its `.sha256` sidecar on the Owl release, a Linux host has nothing to update to. Bring both back into `release/`, beside the Windows installer, and pass the archive to `release:owl` in step 5. The Mac host archive comes from the Mac run in step 2.
4. Review `release/win-unpacked`, `release/Sotto Owl Setup 0.1.37-owl.20261011.1.exe`, its blockmap and `release/owl.yml`. Upload `Sotto-Owl-Setup-0.1.37-owl.20261011.1.exe` and `.exe.blockmap`, the names `owl.yml` references. Keep any stable `latest.yml` out of the Owl release.
5. Run `npm run release:owl -- --mac-artifacts release/owl-mac --linux-artifacts release/owl-linux --host-archive release/owl-mac-host/Sotto-host-0.1.37-owl.20261011.1-darwin-arm64.tar.gz --host-archive release/Sotto-host-0.1.37-owl.20261011.1-linux-x64.tar.gz --notes-file release/notes.md` (omit `--notes-file` for default preview notes). Each `--host-archive` is checked as [Matching Owl host archives](#matching-owl-host-archives) describes, and its sidecar must sit beside it. With `--mac-artifacts` it also checks the Mac receipt names this Windows Owl's version and source commit, every file's size and SHA-256, and that the app inside the zip carries that commit and version. It refuses a receipt that does not say the app is signed, notarized and stapled. With `--linux-artifacts` it checks both Linux receipts name this Windows Owl's version and source commit, that the package was built from that tarball, every file's size and SHA-256 with nothing extra, that the app inside the tarball carries that commit and version, that the package installs that same `app.asar`, and that the package records the Owl's pacman version. The default notes then name the platforms attached, say the Mac build updates itself, tell a Mac on an earlier, unsigned Owl to install this one by hand once, and say Linux installs with `sudo pacman -U` and does not update itself. The helper checks the clean source checkout, build inputs and packaged provenance. It takes the full source SHA from `out/build-provenance.json`, writes `release/owl-notes.md` with `Source commit: <full sha>` and `release/SHA256SUMS.txt`, and **prints** the PowerShell `gh` commands for review. It never runs them. With Mac or Linux files, the first line checks the disk image's and zip's, and the tarball's and pacman package's, attestations with `gh attestation verify` and then creates the release; a failed check throws before the create command, so nothing is published. The title includes the first twelve SHA characters, for example `Sotto Owl 0.1.37-owl.20261011.1 (abc123def456)`.
6. After review, run the printed create line, which checks any Mac and Linux attestations first: a prerelease on `millZach/Sotto-releases`, tagged `v0.1.37-owl.20261011.1`, explicitly `--latest=false`, with the dashed installer, blockmap, `owl.yml`, the Mac disk image, zip, their blockmaps and `owl-mac.yml`, the Linux tarball and pacman package, the Mac and Linux host archives and their sidecars, and `--notes-file release/owl-notes.md`. `PKGBUILD` and `.SRCINFO` stay in the downloaded folder. `release/SHA256SUMS.txt` already lists every one of those files; run the printed checksum upload command last. Do not attach `latest.yml` or change which stable release is Latest.
7. Inspect the published title, body, prerelease flag and every asset the create and upload commands named with the printed view command. Confirm the latest-release endpoint still names the stable tag. Download the published files and verify SHA256 sums. Packaging and preparing commands do not authorize publication.

To switch from stable to Owl, close Sotto and run the Owl installer over the existing installation. App ID `com.sotto.desktop`, product name Sotto, installer identity, executable and data directory stay unchanged, keeping threads, settings, keys and the dictation shortcut. Never uninstall or delete the profile. Owl offers only newer Owl tags with matching `owl.yml`; stable retains its stable feed and `latest.yml`. Both ask before download and restart.

On a Mac, quit Sotto, open the Owl disk image and drag Sotto into Applications, replacing the stable app. Bundle ID `com.sotto.desktop` and the data folder stay the same. The Mac Owl is signed and notarized, so it opens without Gatekeeper steps, and it offers only newer Owl tags with a matching `owl-mac.yml`, asking before download and restart as on Windows. A Mac on an Owl from before signing cannot take a signed update and installs the first signed Owl by hand once. To return, drag stable's app over it the same way; stable on a Mac does not update itself.

On Linux, download the Owl's `sotto-bin` package and run `sudo pacman -U sotto-bin-<Owl pacman version>-1-x86_64.pkg.tar.zst`. It replaces stable's `sotto-bin` in `/opt/sotto`, and the data folder stays the same. Linux has no updater, so each new Owl is installed the same way. Installing a stable `sotto-bin` returns to stable; pacman calls it a downgrade only when that stable is older than the Owl's base. Owl on Linux is not checked on Omarchy before it ships: the workflow's launch checks run under a virtual display on Ubuntu, and forge's Hyprland checks are for stable.

To return, close Owl and install stable over it. Stable builds carrying the October 10 Watcher gate show and start none of Watcher and keep its saved record, thread kinds, settings and histories whole for a later return to Owl, even with Keep local history off in stable. A pane layout or selection pointing at Watcher does not survive the stable session; stable treats those views like missing threads rather than preserving or restoring hidden panes. The main records remain whole. To clear Watcher history, turn that setting off in Owl. The [gate verification](../verification/2026-10-10-watcher-owl-gate.md) exercises the real load/save paths. Older published stable builds, including 0.1.35 and 0.1.36, still drop Watcher's control record, thread kinds and capacity when saving; back up the closed profile before returning to one. The [October 9 note](../verification/2026-10-09-sotto-owl.md) records that older behavior.

Owl ships for Windows, Apple silicon Macs and Linux (Omarchy, x64). The Mac Owl is signed with Sotto's Developer ID, notarized, and updates itself from its `owl-mac.yml` feed (ADR-0093, Stage 2); `macos-owl-signing.md` lists the credentials and how they were made. Mac stable is built by the **Sotto stable for Mac** workflow from the checked main commit (ADR-0096), ad-hoc signed, with no updater (ADR-0001). The Linux Owl is built by the **Sotto Owl for Linux** workflow and has no updater (ADR-0099); stable Linux is still cut and checked on forge.

### Matching Owl host archives

A desktop asks a paired host for exactly its own version: stable always has, and Owl does while Usage (ADR-0078) or a provider hosts run is on, which is every Owl build. Plain Node Owl host archives can accompany the desktop builds on the same prerelease; they are separate from the Linux Owl desktop build. Each host enables features from its own packaged full version. An Owl desktop never activates a collector in a stable host.

The Mac host archive is built by the **Sotto Owl for Mac** workflow with every Owl (step 2 above), so it needs no Mac at hand. The Linux archive is built on forge. On any other host archive's native release machine, use the reviewed Windows Owl's exact full version and source commit from its provenance:

```sh
npm run package:host:owl -- --version 0.1.38-owl.20261012.1 --source <full-source-sha>
```

The command requires the requested clean checkout, preserves source manifests, verifies and smoke-tests the native archive, and writes its checksum sidecar and an Owl receipt. It refuses an existing output of that version. A Windows archive cannot serve as Linux evidence. The host and desktop inventories differ, so compare their full source commit and full version rather than their build-input hashes.

Bring each verified native archive and its `.sha256` sidecar to the release preparation machine, then pass each archive explicitly:

```sh
npm run release:owl -- --notes-file release/notes.md --host-archive release/Sotto-host-0.1.38-owl.20261012.1-linux-x64.tar.gz --host-archive release/owl-mac-host/Sotto-host-0.1.38-owl.20261012.1-darwin-arm64.tar.gz
```

Repeat `--host-archive` for other native platforms. Preparation inspects and verifies the archive's bytes, contents, own version, source and platform agreement; a receipt alone is insufficient. The printed create command attaches those archives and sidecars to the same Owl prerelease, and the combined checksum file still uploads last. Preparation never publishes, installs or restarts a host.

After publication, the user can choose the matching host update from the desktop. Busy-host and restart checks still apply. Equal-base stable hosts can explicitly switch to the chosen Owl target; Owl date and daily number order numerically, and newer hosts are not downgraded. Older hosts remain connected while Usage says unavailable. Returning to stable 0.1.39 or earlier preserves the dormant Usage database; stable from 0.1.40 runs Usage itself. Stable release hosts use the checked main source and stable version described below; offline `package:host` remains available for verification.

### Host archives for a stable release

From 0.1.40, when Update all reached stable, a stable desktop that finds its next version asks `github.com` whether that version's host archive and checksum are published before it offers to move a host, and a stable desktop asks each paired host for exactly its own version. So every stable release attaches `Sotto-host-X.Y.Z-<platform>-<arch>.tar.gz` and its `.sha256` sidecar for each platform paired hosts run on: Linux x64, built on forge as in [Linux host archive](#linux-host-archive), and Apple silicon Mac, built the same way on a Mac with Node 24.22.1 or a later Node 24 (`npm ci`, `npm run release:check -- --version X.Y.Z`, `npm run test:socket`, `npm run package:host:release -- --version X.Y.Z`). Neither Mac workflow builds a host archive. A host on a platform the release does not carry is told there is none and keeps its version. Add each sidecar's line to `SHA256SUMS.txt` before uploading that file last.

## Speech model

No speech model is in any installer (ADR-0071, ADR-0094). Each of Sotto's three is four files published as release assets on `millZach/Sotto-releases` under its own tag, and Sotto downloads the one the user chooses: `speech-model-parakeet-tdt-0.6b-v3-int8-1` (Parakeet v3), `speech-model-parakeet-ultra-int8-1` (Parakeet Ultra) and `speech-model-parakeet-tdt-0.6b-v2-int8-1` (Parakeet v2). Publish each release once, and again only when its model changes:

- Create it as a **pre-release** and never mark it Latest. The updater reads only the release marked Latest, so an app release stays Latest and update checks are unaffected.
- Upload `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx` and `tokens.txt`. For v3 and v2 they are exactly as sherpa-onnx publishes them (`sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`, `sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8`). Parakeet Ultra is Sotto's own conversion: `scripts/speech-models/map-hf-to-nemo.py` maps Moondream's weights onto NVIDIA's v3 `.nemo`, then sherpa-onnx's `scripts/nemo/parakeet-tdt-0.6b-v3/export_onnx.py` exports it, with the encoder's `url` metadata naming Ultra. Its release description credits NVIDIA and Moondream under CC-BY-4.0 and lists the changes. Their sizes and SHA-256 sums must match the model's entry in `SOTTO_SPEECH_MODELS` in `src/shared/speechModel.ts`, or every download is refused.
- Before publishing, load each folder with `scripts/asr-bench/verify-speech-models.mjs` and compare its transcripts with v3's.
- A new model version gets a new tag and new pins in the same change; never replace the assets under an existing tag, because installed copies would refuse them.

## Linux desktop package

Cut on forge (Omarchy, x64), using Node 24.22.1, a clean, CI-green main commit and a clean `npm ci`. Run the four normal gates in [CI](../ci.md) first. Never change shared electron-builder keys for Linux: the Linux packaging plan enables the native rebuild and x64 tar.gz target; Windows and macOS keep their targets.

```sh
mise exec node@24.22.1 -- npm ci
mise exec node@24.22.1 -- node node_modules/electron/install.js
mise exec node@24.22.1 -- npm run package:linux:stable
mise exec node@24.22.1 -- node scripts/release-linux.mjs
```

The first release command runs `release:check`, requires a clean commit on main with successful required CI and a newer stable version, and sets only the packaged manifest to that version. It produces `release/linux-unpacked` and `release/Sotto-X.Y.Z-linux-x64.tar.gz` without changing either source package manifest. It verifies provenance, assets, notices, the external import allowlist, normal startup, SQLite, the native PTY and speech engine. The tarball is extracted and every file compared with the verified unpacked build. A second probe reads the packaged app’s real stable Owl feature answers with every development override set to 1. Both GUI checks use owned nested Hyprland sessions, isolated HOME/XDG profiles and `--password-store=basic`; the release machine’s keyring is untouched. Feature evidence is saved as `release/owl-features-stable-package-status.json` and `release/owl-features-stable-package.png`.

Starting either Linux packaging stage invalidates its prior finishing outputs and completion record. Tarball inputs, archived files and other platforms stay intact. The finishing command checks the source, version, release mode and tarball hash against `release/linux-desktop-package.json`, written only after packaging succeeds. It works in an owned temporary folder under `.cache/linux-release/`. It copies the recipe, sets `pkgver` to the stable version and `pkgrel=1`, hashes the archive and every local recipe source, and generates `.SRCINFO` with `makepkg --printsrcinfo` using the public download URL. It builds with `SOTTO_TARBALL` and `makepkg --cleanbuild --force`; no root is needed and dependencies must already be installed on forge.

It checks the pacman file list, `/opt/sotto`, the launcher, desktop entry, icons, license and the keys, theme and shell plugin under `/opt/sotto/resources/omarchy/` and `/usr/share/sotto/`. `chrome-sandbox` must be root:root with mode 4755 in the package. It extracts a temporary root, checks the packaged version, source and all Omarchy resources, then runs that root’s launcher and `sotto dictation toggle` in another owned nested Hyprland session. This checks real libsecret, tray registration and Settings writing, generating and removing an isolated XDG autostart entry. Rootless extraction cannot retain the helper’s root ownership, so that probe disables only the setuid helper and keeps the user namespace sandbox.

After all checks pass, `release/` holds the tarball, `sotto-bin-X.Y.Z-1-x86_64.pkg.tar.zst`, updated `PKGBUILD`, `.SRCINFO`, and `SHA256SUMS.txt` containing the two distributable hashes (lower-case hex and two spaces before each filename). The recipe and `.SRCINFO` belong in step 5’s Release PR after publication. Source recipes stay untouched during packaging. The finished bundle is prepared in the temporary folder and moved into `release/` only after the checks; `release/linux-release-verification.json` arrives last and records completion. A failed finishing run removes partial outputs. Stable also rereads the stable release check after the GUI probe and refuses a changed source or version. Before step 5 copies either recipe file, require this completion record with `publishable: true` and the checked main source and version. Logs and working evidence stay in the ignored `.cache/` folder.

For a rehearsal on any clean commit, give the same version to both commands:

```sh
mise exec node@24.22.1 -- npm run package:linux:rehearse -- 0.1.38
mise exec node@24.22.1 -- node scripts/release-linux.mjs --rehearse 0.1.38
```

This runs the same build and checks, skips `release:check`, and prints **REHEARSAL ONLY — NOT PUBLISHABLE** before and after. The packaging record marks the result as a rehearsal; the stable finishing command refuses it. Never install, upload or publish a rehearsal. `npm run package:linux` remains the offline, unchecked source-version verification command. It does not check main, CI, stable version or packaged Owl features and cannot produce a stable packaging record.

Installation and publication are manual owner actions, separate from these commands. Neither command installs, uploads or publishes. The optional `apps/omarchy/install.sh` requires sudo and is never run by the pipeline. A release pass on the installed app still finishes onboarding, dictates into Chromium and a terminal, and opens a thread (ADR-0062). Publish the two reviewed clean-commit distributables beside Windows and macOS artifacts, assemble all platforms’ checksum lines and upload that file last. Confirm the downloaded artifacts against it. AUR publication follows under the owner’s account once packaging is proven.

## Linux host archive

The host is a Node process, not a Linux desktop app. For a stable release, use the same clean, CI-green main commit as the desktop, Node 24.22.1 or a later Node 24 and a clean `npm ci`, then run `npm run test:socket` and `npm run package:host:release`, adding `-- --version X.Y.Z` when the release chose a version other than the next patch, as every stable packaging command takes it. That command runs `release:check` and packages the checked stable version in the archive, runtime manifest and bundled host. The desktop can then find the matching versioned archive. The ordinary `package:host` and the CI job **Host archive and socket contract (Linux)** stay offline and use the checkout manifest version for verification. CI retains its archive for review and never publishes a release.

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

The manifest requires Node `>=24.22.1 <25`: Node 24.22.1 is the first Node 24 that stops trusting the compromised eMudhra intermediate CAs (October 2026). Node itself and provider CLIs are not included. Install Node 24.22.1 or a later Node 24 and the desired provider CLI on the host and sign in there. The reviewed runtime closure is Node built-ins and zod, with no bundled dependencies or native modules. Packaging refuses a new external, an unexpected transitive dependency, or a native binary. The existing notices check covers the host inventory. Provenance records the source commit, dirty-tree status, build-input digest, Node/build platform, and every packaged file's size and digest. Only a reviewed clean-commit build is eligible for publication.

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
