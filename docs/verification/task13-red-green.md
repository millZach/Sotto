# Task 13 release verification record

This is a durable retrospective checkpoint record, not a claim that raw terminal logs were preserved. Counts and failure descriptions below come from the observed command results during Task 13; final release sizes and hashes are added only after rebuilt artifacts pass their packaged checks.

## Original workflow seam

- RED: the first `tests/e2e/app.spec.ts` workflow run timed out at onboarding before the deterministic microphone seam was connected: **1 failed in approximately 30 seconds**.
- GREEN: after admitting the non-packaged deterministic boundary, the complete Electron workflow suite passed. Packaged builds continue to reject that boundary.

## Reviewer-fix tracer bullets

- Packaged worklet URL RED: `tests/unit/renderer/audioRecorder.test.ts` reported **1 failed, 29 passed** because `addModule` received `/audio-capture-worklet.js` instead of a packaged renderer-relative `file:///.../out/renderer/audio-capture-worklet.js` URL. GREEN: **30 passed** after the recorder accepted the resolved renderer URL.
- Release contract RED: `tests/unit/release/packaging.test.ts` reported **3 failed** for missing pre/post packaging verification, no explicit installer page, and stale disk/shortcut documentation. GREEN: **3 passed** after the packaging and assisted-installer contract was implemented.
- Notice inventory RED: `tests/unit/release/notices.test.ts` failed at import with **0 tests** because the verifier did not exist. GREEN: **1 passed**, and the standalone verifier covers **27 components** plus complete MIT/ISC/BSD-3-Clause/Apache-2.0 text and Electron/Chromium notice artifacts.
- Launch cleanup RED: `tests/unit/release/e2eLaunchCleanup.test.ts` failed at import with **0 tests** because failure-safe launch support did not exist. GREEN: **3 passed** for first-window failure, launch failure, and caller-owned profile preservation. The path-validated cleanup removed **1** stale `talktype-e2e-*` directory and no other temp entries.

## Final release evidence

- `npm test`: **48 files passed; 771 passed, 1 skipped (772 total)**.
- `npm run test:e2e`: **25 passed** across application workflows and the ten-state visual matrix.
- `npm run lint`, `npm run typecheck`, `npm run model:verify`, and `npm run notices:verify`: passed; model verification covers **12 model files and 4 runtime files**, and notice verification covers **27 components**.
- `npm run package:dir`: passed its source model check, build, package, packaged hash/resource verification, and real packaged launch smoke.
- `npm run package:win`: produced the assisted NSIS installer and passed the same packaged checks. The compiled custom include presents the desktop-shortcut checkbox, defaults it unchecked for a first install, persists the choice, and preserves upgrade/uninstall shortcut semantics.
- Packaged smoke evidence: normal preload bridge available; packaged E2E bridge rejected; Balanced model reported `bundled`; model and runtime custom protocols returned allowlisted files; renderer-relative audio worklet loaded from inside `app.asar`; the real local transcription worker loaded the Balanced q8 model and reached `ready` on WASM.
- Production module archive: exactly `zod`; renderer/build dependencies are bundled and inventoried separately.

## Release artifact comparison

| Artifact | Original Task 13 build | Verified rebuilt release |
|---|---:|---:|
| `app.asar` | 208,558,356 bytes | 31,788,840 bytes |
| `app.asar.unpacked` | 64,002,906 bytes | 0 bytes |
| `win-unpacked` total | 754,463,099 bytes | 513,678,869 bytes |
| NSIS installer | 199,208,898 bytes | 158,679,925 bytes |

- `app.asar` SHA-256: `4995fb31e51c4268a7d9e92135605cdf4eb4c2faaef58d83277e0f8e37e41e98`
- Installer SHA-256: `0ad8a7a3698d9f3e13fc8fd37a28e7c1977deb76f16bf6210390677e85e35d7a`
- Block map: 165,144 bytes; SHA-256 `aa16fca383318122800cb0147f8ec4b9650b0dc25a26418f3a2f1cf0b4796ce8`
- Packaged notice SHA-256: `8e65220a0f030f93c28133c7623fc4873d47f614eef833f2fc11e39570e23d93`
- README requires at least **1.5 GB free during installation** to cover the 513,678,869-byte installed tree, the 158,679,925-byte installer, temporary extraction, and conservative working headroom.
