# Sotto Owl also ships for Apple silicon Macs

## Status

Accepted by Zach on October 19, 2026. **Number provisional until merge:** 0092 is free on `origin/main` at the time of writing, where 0091 is worker roles; recheck before merging (docs/agents/domain.md). It amends [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md), whose track was Windows only, and [ADR-0001](0001-macos-unsigned-arm64-distribution.md), whose Mac build had no CI, no zip, no update feed and no signing identity. Stable on the Mac keeps every part of ADR-0001.

Amended October 20, 2026: [ADR-0096](0096-stable-mac-builds-in-github-actions.md) builds stable Mac in GitHub Actions too. Below, "built by hand on a Mac" now describes only the fallback; stable Mac is otherwise unchanged.

The decision lands in two stages. Stage 1 needs no Apple credentials and is built. Stage 2 needs a Developer ID certificate and a notarization key in GitHub's secrets, and is built when Zach has added them.

## Context

Sotto Owl was cut only for Windows, so Mac users got Owl features only when they reached stable. Zach's brother tested an Owl build on a Mac on October 18 and it worked. Zach wants every Owl release to ship for Mac users too, from the same source commit and version as the Windows Owl, with no Mac on hand, and with the same one-click in-app update Windows has.

Two constraints shape the answer. A Mac build has to be made on macOS, and Zach's development machine is Windows. GitHub's hosted macOS runners already build the iPhone app (ADR-0032). And macOS's updater (Squirrel.Mac, which electron-updater drives) refuses an update unless it is signed by the same developer as the app that is running. An ad-hoc signed app, like stable Mac today, has no developer, so it cannot update itself at all.

## Decision

Zach's answers, October 19:

- **Apple silicon only.** Intel Macs stay unsupported, as in ADR-0001.
- **Stable Mac stays as it is**: built by hand on a Mac, ad-hoc signed, a disk image only, no updater. Only Owl changes.
- **Each Owl carries the Mac build from Stage 1**, unsigned, with the Gatekeeper steps in its notes. Mac users do not wait for signing.
- **The release lead starts the Mac build by hand** for each Owl, as they cut the Windows build by hand. Nothing builds on a schedule.

### Stage 1: the Mac Owl is built in GitHub Actions and attached to the Owl release

`npm run package:owl` runs on macOS as well as Windows. On a Mac it builds an Apple silicon disk image and a zip, `Sotto-Owl-<version>-arm64.dmg` and `Sotto-Owl-<version>-arm64-mac.zip`, from the same Owl overrides as Windows: the packaged version, the `owl` publish channel, and Sotto's app ID, product name and data directory unchanged. It checks the packaged resources and the disk image, compares the app inside the zip with the verified app, launches the packaged app on a throwaway profile to check every Owl feature is on, and writes a receipt, `release/owl-mac-package.json`, naming the version, the full source commit, and each file's size and SHA-256. Signing stays ad-hoc, as `electron-builder.yml` already says for the Mac.

Given `--version` and `--source`, `package:owl` refuses a checkout that is not clean, a HEAD other than that commit, or a version that is not an Owl version of the checkout's manifest. This is how a build is pinned to the Windows Owl's commit and version.

The workflow **Sotto Owl for Mac** (`.github/workflows/owl-mac.yml`) runs only when started by hand with an Owl version and a full source commit. On a hosted Apple silicon runner it checks out that commit, runs `npm ci` and `package:owl` with both, attests the disk image and zip with GitHub's build provenance, and keeps the receipt and the files it names as a workflow artifact for two weeks. It reads no secrets in Stage 1 and publishes nothing.

On the Windows release machine, `npm run release:owl -- --mac-artifacts <folder>` takes the downloaded workflow artifact. It checks the receipt names the packaged Windows Owl's version and source commit, every file's size and digest, and that the app inside the zip carries that source commit and version. The printed commands first verify each file's attestation, then attach the disk image, zip and blockmaps to the same Owl prerelease. Their lines go into `SHA256SUMS.txt`, which still uploads last. `owl-mac.yml` is not attached in Stage 1: nothing on a Mac reads it yet, and an unsigned build must never be offered to a signed one.

An Owl release's notes no longer say Windows only. With the Mac build attached, they say it is for Windows and Apple silicon Macs and carry the Gatekeeper steps: System Settings, Privacy & Security, **Open Anyway**, or `xattr -dr com.apple.quarantine /Applications/Sotto.app`.

### Stage 2: the Mac Owl is signed, notarized and updates itself

When Zach has added the credentials (`docs/release/macos-owl-signing.md`):

- The workflow signs the Mac Owl with Sotto's **Developer ID Application** certificate, turns on the hardened runtime with the entitlements ADR-0001 already wrote for it, notarizes the app with Apple's notary service through an App Store Connect API key, and staples the ticket. The certificate and key live in a GitHub environment, `owl-mac`, that only this workflow's job reads, the way the `testflight` environment holds the iPhone app's key. The runner's temporary keychain and key file are removed when the job ends. Signing happens only in CI. Stable's `electron-builder.yml` Mac section is unchanged, and the Owl overrides are passed to the build as `package:owl` passes its other overrides.
- The receipt says the build is signed and notarized. `release:owl` checks that it is, and attaches `owl-mac.yml` beside `owl.yml`. electron-updater on a Mac with the `owl` channel reads `owl-mac.yml`, and the Owl GitHub provider validates it the way it validates `owl.yml`.
- The in-app updater turns on for Owl on a Mac. Whether a platform updates in the app becomes a question of platform and track: Windows on both tracks, a Mac on Owl only, Linux on neither. The update control, its progress and its restart question are the ones Windows shows. The Mac app menu's **Check for Updates…**, already written and left out on the Mac, appears in Owl. Automatic download and install on quit stay off. Consent, check cadence and privacy settings are unchanged.
- Stable Mac's update message says where updates do run: in the installed Windows app and in Sotto Owl on a Mac.

## Consequences

- The Mac Owl adds no host on the user's Mac. The updater reads the same `github.com` release feed and download hosts Windows already reads. Notarization talks to Apple from GitHub's runner, not from a user's Mac. No production dependency is added: electron-updater is already bundled, Squirrel.Mac is part of Electron, and the notarization tool is part of electron-builder.
- A Mac user on a Stage 1 build installs the first signed Owl by hand, once. An ad-hoc app cannot accept a signed update. After that, updates take one click.
- Once signed, the Mac Owl keeps the same signature across builds, so macOS stops asking for the microphone, automation and accessibility again after each update. Moving between stable (ad-hoc) and Owl (signed) still asks again, because the signature changes.
- Owl and stable install to the same place on a Mac, `/Applications/Sotto.app`, as they replace each other on Windows. Installing stable's disk image over Owl returns to stable, and the stable app has no updater.
- Each Owl costs one hosted macOS run. Standard hosted runners are free while the source repository is public.
- Every Owl still needs its Windows build first. The Mac workflow is pinned to the Windows Owl's version and commit, and `release:owl` refuses Mac files that disagree with the Windows package.
