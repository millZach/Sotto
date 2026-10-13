# Owl features stay in preview until Zach sends them to stable

October 12, 2026. Verified on Windows in `feat/owl-features`, based on `6adc78c402d39008bb01e15354c877b9e6dc55be`. The Mac package launch is not verified on this Windows machine; the check uses the existing Mac platform profile, bundle executable and mock-keychain arguments, whose platform tests run in the normal suite. Nothing was installed or published.

`src/shared/owlFeatures.ts` now owns the release eligibility of every Owl feature. Watcher is its first entry, dated October 10 and not sent to stable. Main takes a frozen snapshot at startup, supplies Watcher's existing owners and carries all answers in update status. `useOwlFeature(id)` reads those answers, and the existing Watcher gate names remain compatibility wrappers. Stable still keeps Watcher off and its records whole; Owl keeps it on.

## Packaged checks

Ran `npm run package:dir` and then `node scripts/verify-owl-features-package.mjs release/win-unpacked stable` against the real packaged app. Ran `npm run package:owl -- --date 20261012 --number 1`, including its new feature probe and the existing resource, installer, manifest and Owl identity checks. Both returned success. A final stable directory build leaves `release/win-unpacked` on stable; the uninstalled Owl installer remains local verification output.

| Package | Version | Feature override | Watcher alias override | Startup map and alias |
| --- | --- | --- | --- | --- |
| Stable | `0.1.37` | `watcher=1` | `1` | `watcher: false`, `watcherEnabled: false` |
| Owl | `0.1.38-owl.20261012.1` | `watcher=1` | `1` | `watcher: true`, `watcherEnabled: true` |

Each probe confirmed `app.isPackaged`, the packaged version, Sotto's app identity and its owned throwaway profile through the real preload bridge, then closed the app and removed that profile. [The recorded answers](../../artifacts/watcher-gate/owl-features-package-status.json) contain no prompt or transcript. The [stable first-run capture](../../artifacts/watcher-gate/owl-features-packaged-stable.png) and [Owl first-run capture](../../artifacts/watcher-gate/owl-features-packaged-owl.png) were opened and inspected. The probe primes the compositor before saving a capture: an early Electron frame could be empty despite a ready DOM. No app styling changed.

The release scripts invoke the probe only for `package:win`, `package:mac` and `package:owl`. Directory and Linux package commands and CI's Package (Windows) are unchanged. The probe checks every list entry, failing stable for a held feature on or a sent feature off, and Owl for any feature off. Tests include a second feature and a sent feature, missing answers, a wrong track and a divergent Watcher alias.

## Gates and journeys

The focused pass ran seven files and 84 tests: the list and track rule, second-feature graduation, unpackaged overrides and packaged rejection, immutable startup answers, update-status schema, both renderer hooks, legacy Watcher behavior and package-check failures.

The required checks ran in order. `npm run typecheck` and `npm run lint` passed, as did a final lint after the probe's capture-only edit. The first full suite returned one `launchScriptBoot` restart failure and a worker-exit error: 9,693 tests passed, 283 skipped and one failed. Its completion cache held 835 of 836 candidate files; `providerRetirement.test.ts` was the missing file. The boot file passed alone (35 passed, one skipped), and the missing file passed alone (18 passed). No code changes were needed. A full rerun with the same `npm test -- --maxWorkers=2` command then passed: 778 files passed, 58 skipped; 9,712 tests passed, 283 skipped; no failures or unhandled errors. It took 1,472.77 seconds. The required memory readings before the full runs were 6,749,184 KB and 9,409,928 KB, both above 3 GB.

`npm run notices:verify` verified 189 components. `npm run build` passed. After the design check below, `npx playwright test tests/e2e/watcher-gate.spec.ts tests/e2e/sotto-owl-branding.spec.ts` passed all ten journeys in 34.9 seconds. They checked saved Watcher records and ordinary thread actions on both tracks, refusal with the local host off, changed Watcher capacity, stable and Owl branding, light, dark, reduced motion, Help, Settings, first-run setup and the 820x560 minimum. The minimum-width stable-light and Owl-dark captures and the reduced-motion Owl header were opened and inspected.

## Existing design-gate failure

`npm run design:verify` remains red: five cases fail and four do not run after those serial failures. It fails on `theme-hush-dark.png` (2,448 changed pixels; limit 388), `onboarding-step-2-look.png` (511; limit 353), `threads-search.png` (499; limit 388), `scale-125-onboarding.png` (1340x829 actual versus 1340x828 baseline), and `widget-idle-light.png` (124x56 actual versus 124x54 baseline).

To distinguish a regression from existing capture drift, temporarily replaced the six changed, consumed source files with their exact `HEAD` versions from the base commit above, keeping a byte backup and the staged feature diff intact. Ran the same `npm run design:verify`, restored every source byte in `finally`, rebuilt the feature, and ran its design check again. No branch switch, stash, worktree, dependency install or baseline regeneration was used. The base reproduced all five failures with the same counts and dimensions. All five actual PNGs from the restored feature and base builds are byte-for-byte identical, including their SHA-256 hashes: [the comparison record](../../artifacts/watcher-gate/owl-features-design-comparison.json). This establishes that these failures predate this feature change; the underlying capture/baseline drift is not resolved in this change. No design baseline was regenerated.

## Review

Separate Standards and Spec reviewers ran in-session, respecting the ban on nested `codex exec`. Both reported no material findings. The source manifests, production dependencies, Electron builder configuration and CI workflow are unchanged.
