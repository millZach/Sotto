# Stable from main, October 13, 2026

**VERIFIED on forge:** the revised release check and Linux stable desktop/finishing pipeline against clean main `503991806efa249e12b33b9f3213c424afa5fc9f`. Source manifest `0.1.37`, packaged stable `0.1.38`. Nothing was installed, uploaded or published. Windows and Mac release packaging were not run here.

## Source and tools

The release tools in this PR are not on main yet, and this run must not merge. Running their normal stable entry points on the unmerged tool branch correctly refuses it. To prove the new rule without bypassing it, an owned clone at `.cache/stable-from-main/main-source/` was checked out at the main commit above, given its own `npm ci`, and kept clean. The revised tools target that checkout through their exported source-root APIs. They fetch origin/main and read live public GitHub releases and CI; no eligibility result is mocked. The source and tool revisions are deliberately distinct.

`tools/verify-stable-from-main.mjs` retains that harness. With an owned clean checkout and its own dependencies, use Node 24.21.0:

```sh
mise exec node@24.21.0 -- node tools/verify-stable-from-main.mjs .cache/stable-from-main/main-source check
mise exec node@24.21.0 -- node tools/verify-stable-from-main.mjs .cache/stable-from-main/main-source package
mise exec node@24.21.0 -- node tools/verify-stable-from-main.mjs .cache/stable-from-main/main-source finish
```

The package and finish runs used equivalent small runners calling these same exported functions. After merge, the ordinary `npm run release:check`, `npm run package:linux:stable` and `node scripts/release-linux.mjs` entry points use their own clean main checkout. Before merge those exact successful entry-point invocations on main cannot be claimed; main still contains the superseded tools.

## Release check and refusals

The live success output was:

```text
Sotto 0.1.38 will ship source commit 503991806efa249e12b33b9f3213c424afa5fc9f from origin/main. The checkout is clean. Gates (Windows) and Package result succeeded. Newest published stable: 0.1.37.
```

The [saved check](../../artifacts/stable-from-main/release-check.json) names the exact successful GitHub Actions check runs, main reference, source version and selected version. The check requires completed success, rejects missing checks, and uses the newest run for each required name. It reads paginated public APIs without credentials. Plain stable tags count even when an older stable was marked prerelease; Owl and model tags do not.

`npm run release:check` was run on the dirty tool tree, then on its clean committed branch. Its real refusal messages were:

```text
This checkout has uncommitted changes. Save them in a commit, then check out a clean commit on origin/main before making a stable release.

This checkout, 49c53a7cb744a9c9436b2aaea6cb68313c6523aa, is not on origin/main. Check out a clean commit on origin/main before making a stable release.
```

Calling the same release check against the owned clean main checkout with explicit `version: '0.1.37'` produced:

```text
Stable version 0.1.37 is not newer than the newest published stable, 0.1.37. Choose a newer version with --version X.Y.Z.
```

A failed check removes its old record. The valid check was repeated after this intentional refusal. Regression tests also cover red, pending, cancelled, skipped, missing, wrong-commit and foreign-app CI; a newer failed retry cannot hide behind an older success.

## Linux artifacts and running package

The checked outputs remain in the owned source checkout's ignored `release/`:

- `Sotto-0.1.38-linux-x64.tar.gz`
- `sotto-bin-0.1.38-1-x86_64.pkg.tar.zst`
- `PKGBUILD`, `.SRCINFO`, `SHA256SUMS.txt`
- `linux-desktop-package.json`, `linux-release-verification.json`

The [checksums](../../artifacts/stable-from-main/SHA256SUMS.txt) were independently checked against both finished archives. The source manifest, lockfile and source package recipes stayed unchanged, and the source tree remained clean. The tarball has the packaged version and main provenance and is compared file by file with the verified unpacked app. Packaged-resource verification checked the dependency allowlist, notices, SQLite, native PTY and the speech-engine module.

The stable feature probe launched the packaged app on an isolated profile with `SOTTO_OWL_FEATURES=watcher=1` and `SOTTO_WATCHER_ENABLED=1`. The real startup answer was `releaseTrack: stable`, `currentVersion: 0.1.38`, `owlFeatures: { watcher: false }`. Its [screenshot](../../artifacts/stable-from-main/owl-features-stable.png) was opened and inspected. Held features remain off; sent features are required on by the same probe on Windows, Mac and Linux.

The pacman finishing command verified all source hashes, 373 file-list entries, launcher, desktop entry, icons, license and Omarchy resources. The sandbox helper was `root:root` with mode `4755`. It extracted the actual package and launched its own `/opt/sotto/bin/sotto`: libsecret ready, tray registered, isolated autostart generated and removed, `sotto dictation toggle` exit 0. The [completion record](../../artifacts/stable-from-main/linux-verification.json) names these checks and `publishable: true`; this is artifact eligibility, not publication authorization. GUI probes used owned nested Hyprland sessions and cleaned up their process groups. The live desktop was untouched.

Two verification-run issues were resolved: an initial inline Node runner passed `--input-type` into native rebuild subprocesses, so it was replaced by a file runner; the long source checkout exceeded the extracted probe's private Unix socket limit, so that probe runs from the shorter tool checkout's cache. Normal CLI packaging uses the same checkout for both and retains its behavior. The original failing finishing path then passed.

## Gates and review

The required commands ran with Node 24.21.0 and two Vitest workers. The full suite subsequently passed: 803 files passed, 57 skipped; 10,227 tests passed, 200 skipped. The focused release/package/ADR tests passed before the full suite. Typecheck, lint and third-party notices passed. The external dependency allowlist passed in the real packaged-resource check.

Independent Standards and Spec reviewers inherited the session model and effort per Zach's models file. The initial reviews found no actionable issues; the final Standards pass caught premature wording about pending PR results, corrected here. The final Spec review also inspected the shorter probe working directory and saved evidence. No UI change or design baseline regeneration was made. Linux release-script verification uses the real packaged probes above rather than an unrelated Electron spec. PR checks and external reviews were still pending when this local note was written. The PR is the record for their final results.

## External review

Sotto Bug Bot reviewed `e5d1f0ec45c25db12185f29cf389a20aa9404dea`: no blockers or likely bugs, two nits. The existing Owl/stable host-version window is now documented in the release procedure and exercised by a mixed-track client regression. Owl retains the currently published source-manifest host version before the next stable host exists; installing a new Owl after the Release PR closes that window. No runtime host-version policy changed.

The proposed additional mandatory Linux and host CI checks were not adopted: the brief explicitly names Gates (Windows) and Package result, matching the repository's required checks. Linux result is informational in `docs/ci.md`; making it mandatory is the owner's decision. This PR's Linux, host, Windows desktop and package checks all passed, and local Linux artifact proof passed.

After the review changes, the four local gates passed again. The focused mixed-track/client/release-check run passed 39 tests; the full rerun passed 10,227 tests with 200 skipped across 803 passing and 57 skipped files (552.03 seconds). The real packaged external-dependency inventory passed again. Both independent axes found no actionable issues in this small review delta.
