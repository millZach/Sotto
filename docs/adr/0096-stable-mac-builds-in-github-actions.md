# Stable Mac builds in GitHub Actions

## Status

Accepted by Zach on October 20, 2026. **Number provisional until merge:** 0094 is claimed by two open pull requests and 0095 is the next either of them takes, so this ADR takes 0096; recheck before merging (docs/agents/domain.md). It amends [ADR-0001](0001-macos-unsigned-arm64-distribution.md), whose stable Mac build was made by hand on the owner's Mac with no CI, and [ADR-0093](0093-sotto-owl-also-ships-for-apple-silicon-macs.md), which kept stable Mac on that hand path.

## Context

Stable Mac was built by hand: the release lead checked out the chosen main commit on an Apple silicon Mac and ran `npm run package:mac -- --version X.Y.Z`. The lead cutting the next stable cannot reach a Mac. The Mac Owl has been built on GitHub's hosted Apple silicon runner since October 19 (ADR-0093), so the runner, the Electron download, the mock keychain the package check launches with, and the attestation are already proved there.

## Decision

The Mac half of a stable release is built by the workflow **Sotto stable for Mac** (`.github/workflows/stable-mac.yml`). The release lead starts it by hand with the stable version and the full main commit the Windows release ships. It never runs on a push, a pull request or a schedule.

On a hosted Apple silicon runner it checks out that commit with full history, confirms HEAD is that commit, runs `npm ci`, downloads Electron, and runs the same command the hand path runs: `npm run package:mac -- --version X.Y.Z`. That runs `release:check` first, so the build refuses a dirty checkout, a commit outside `origin/main`, missing or failed Gates (Windows) and Package result checks, and a version no newer than the newest published stable. It then builds, records provenance, checks the packaged resources and the disk image, and launches the packaged app with the mock keychain to check every Owl feature is held to its stable answer.

`release:check` reads the same public data from the runner. A hosted runner shares its address with other jobs, so the workflow passes its own read-only job token as `SOTTO_RELEASE_CHECK_TOKEN` to stay clear of the public rate limit; the hand path sets nothing and stays tokenless.

`package:mac` now writes a receipt, `release/mac-desktop-package.json`, last, so it exists only for a build that passed every check. It names the version, the source commit from the build provenance, the build-input revision, and each file's size and SHA-256. The workflow checks the receipt and the release-check record describe the requested version and commit, attests the disk image and blockmap with GitHub's build provenance, and keeps them for 14 days as the artifact `sotto-stable-mac-<version>` with the receipt, `release/stable-promotion.json`, the Owl feature answers and screenshot, and `SHA256SUMS-mac.txt`, the lines the lead appends to the release's `SHA256SUMS.txt`.

The lead downloads the artifact, checks the attestation with `gh attestation verify`, and attaches the files to the stable release (`docs/release/releasing.md`).

What stays as ADR-0001 decided: Apple silicon only, ad-hoc signed with `identity: '-'`, not notarized, a disk image only with no zip and no `latest-mac.yml`, and no updater. The workflow reads no secrets and publishes nothing. Building by hand on a Mac stays the documented fallback and runs the same command.

## Consequences

- A stable release no longer needs a Mac on hand. Every stable costs one hosted macOS run, free while the source repository is public.
- The workflow file is read from `main` when started, so it can build only once this change has merged.
- The disk image carries an attestation tied to the source repository and the run, which a hand build never had. The Gatekeeper steps in the release notes do not change: the app is still ad-hoc signed.
- Functional checks on a real Mac (the microphone prompt, auto-paste, the Gatekeeper flow) are no longer part of making the build. They remain the `macos-bringup.md` checklist, run on a downloaded disk image when a change touches the Mac.
