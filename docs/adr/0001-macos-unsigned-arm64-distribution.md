# 1. Unsigned Apple silicon macOS distribution

## Status

Accepted — 2026-08-03.

## Context

Sotto shipped as a Windows-only app. Adding macOS support raised distribution questions that packaging configuration alone does not explain, and several of the answers look wrong without their reasoning.

Constraints at the time of the decision:

- No Apple Developer Program membership, so no Developer ID certificate, no notarization ticket, and no Apple-blessed Gatekeeper path.
- Sotto has no auto-updater on any platform; users download installers from GitHub Releases.
- Releases are cut by hand on the owner's machines; there is no CI runner, and macOS builds legally and practically require macOS.
- The ASR stack is architecture-neutral WASM, so nothing in the app is CPU-architecture specific — but every extra architecture doubles the build, verification, and functional-test cost.

## Decision

**Apple silicon (arm64) only.** The `mac` target is `[{ target: dmg, arch: [arm64] }]`. Intel Macs and universal binaries are not built. Every Mac the app is being developed and tested on is Apple silicon, Apple silicon is the whole current lineup, and a universal build would double artifact size and, more importantly, double the manual functional pass that is the actual bottleneck. The README states plainly that Intel Macs are not supported.

**Ad-hoc signed with `identity: '-'`, never `identity: null`.** These are not two spellings of "unsigned". With `identity: null`, electron-builder's `MacPackager.sign()` short-circuits into `handleNullIdentity()` (`app-builder-lib/out/mac/MacTargetHelper.js` in electron-builder 26.15.3), which logs `skipped macOS code signing` with reason `identity explicitly is set to null` and returns `false` — the bundle is emitted with no signature at all. On arm64, macOS requires a valid code signature to execute a Mach-O at all, so that artifact is killed by the kernel at launch, on the build machine as well as on users' machines. `identity: '-'` produces an ad-hoc signature, which satisfies the kernel while carrying no developer identity. The tripwire during bring-up is `codesign -dv --verbose=4 release/mac-arm64/Sotto.app` reporting `Signature=adhoc`.

**`hardenedRuntime: false` for now, entitlements written as if it were true.** The hardened runtime only buys anything with notarization, and turning it on adds a way for the ONNX/WASM JIT paths to fail that cannot be diagnosed from Windows. `build/entitlements.mac.plist` already carries the JIT, unsigned-executable-memory, library-validation, dyld-environment, audio-input, and Apple-events entitlements the notarized configuration needs. Flipping to notarized distribution is deliberately a one-word diff (`hardenedRuntime: true`) plus a real signing identity and `notarize: true`; the entitlements do not change.

**DMG only — no zip, no `latest-mac.yml`, no updater.** A zip target exists in electron-builder mainly to feed `electron-updater`. Sotto has no updater on Windows either, so a zip would be an unverified second artifact for every release with no consumer.

**Manual builds on the owner's Apple silicon Mac; no CI.** The release ritual is already two machines and hand-run verification scripts (see the Release artifacts section of `CLAUDE.md`). Adding hosted macOS CI would require uploading a signing identity that does not exist yet and would not remove the manual functional pass that unsigned Gatekeeper flows demand.

**Electron's license files are re-added through `mac.extraResources`.** electron-builder deletes `LICENSE` and `LICENSES.chromium.html` from the macOS output tree. Shipping without them would break the license-compliance guarantee that `THIRD_PARTY_NOTICES.md` and `scripts/verify-notices.mjs` enforce, so the mac configuration copies `node_modules/electron/dist/LICENSE` back as `LICENSE.electron.txt` and re-adds `LICENSES.chromium.html`, both landing in `Sotto.app/Contents/Resources` rather than beside the executable as on Windows.

## Consequences

- **Gatekeeper friction is permanent until signing lands.** A downloaded, quarantined, unsigned app is refused with "Sotto is damaged and can't be opened". Users must go through System Settings → Privacy & Security → **Open Anyway** (macOS 15 removed the Control-click → Open bypass for this case) or run `xattr -dr com.apple.quarantine /Applications/Sotto.app`. The README carries these steps and every release note must repeat them.
- **TCC grants re-prompt on every update.** macOS keys Microphone, Automation, and Accessibility grants to the app's code signature, and an ad-hoc signature changes on every rebuild. Users are re-prompted after each update, and stale entries sometimes must be removed from the permission lists first. The app degrades safely — auto-paste failure falls back to "Copied — paste manually" with the transcript in the clipboard — and the README documents `tccutil reset Microphone|AppleEvents|Accessibility com.sotto.desktop` as the escape hatch. During development this also means a fresh prompt after every local rebuild.
- **Intel Mac users get nothing.** The arm64 build refuses to launch; there is no informative error beyond an immediate quit, so the README troubleshooting list names it explicitly.
- **Artifact verification stays symmetric.** Because the DMG is the only macOS distributable, `scripts/verify-packaged-resources.mjs` needs exactly one open-the-distributable strategy per platform (`hdiutil attach`/`detach` vs 7za extraction of the NSIS installer).
- **Moving to Developer ID signing is additive.** Nothing decided here has to be undone: the target list, entitlements, and DMG layout stay; identity, hardened runtime, and notarization change. This ADR should be superseded rather than edited when that happens.
