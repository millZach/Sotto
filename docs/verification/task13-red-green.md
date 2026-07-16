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
- Direct verifier dependency RED: `tests/unit/release/packaging.test.ts` reported **1 failed, 2 passed** because `@electron/asar` was only transitively available. GREEN: **3 passed**, and `npm ls @electron/asar --depth=0` resolves the exact direct development dependency `@electron/asar@3.4.1`.
- External dependency metadata RED: the focused release run reported **2 failed files** because no Rollup inventory producer or validator existed. GREEN: **7 passed** after main and preload builds emitted sorted static/dynamic external inventories and the packaged verifier enforced their exact reviewed allowlists plus Node builtin and packaged-module existence. The verifier no longer parses generated `require` formatting.
- Shared profile policy RED: the focused profile run reported **1 failed suite** because the shared policy module did not exist while the existing **3 launch-cleanup tests passed**. GREEN: **5 passed** after both Playwright launch support and stale-profile cleanup imported the same typed path/name validator.

## Final release evidence

- `npm test`: **50 files passed; 777 passed, 1 skipped (778 total)**.
- `npm run test:e2e`: **25 passed** across application workflows and the ten-state visual matrix.
- `npm run lint`, `npm run typecheck`, `npm run model:verify`, and `npm run notices:verify`: passed; model verification covers **12 model files and 4 runtime files**, and notice verification covers **27 components**.
- `npm run package:dir`: passed its source model check, build, package, packaged hash/resource verification, and real packaged launch smoke.
- `npm run package:win`: produced the assisted NSIS installer and passed the same packaged checks. The compiled custom include presents the desktop-shortcut checkbox, defaults it unchecked for a first install, persists the choice, and preserves upgrade/uninstall shortcut semantics.
- Packaged smoke evidence: normal preload bridge available; packaged E2E bridge rejected; Balanced model reported `bundled`; model and runtime custom protocols returned allowlisted files; renderer-relative audio worklet loaded from inside `app.asar`; the real local transcription worker loaded the Balanced q8 model and reached `ready` on WASM.
- Production module archive: exactly `zod`; main and preload external dependencies match packaged Rollup metadata exactly, while renderer/build dependencies are bundled and inventoried separately.

## Release artifact comparison

| Artifact | Original Task 13 build | Verified rebuilt release |
|---|---:|---:|
| `app.asar` | 208,558,356 bytes | 31,789,766 bytes |
| `app.asar.unpacked` | 64,002,906 bytes | 0 bytes |
| `win-unpacked` total | 754,463,099 bytes | 513,679,795 bytes |
| NSIS installer | 199,208,898 bytes | 158,683,631 bytes |

- `app.asar` SHA-256: `1a12e7f13022e9b2cb7e4446a8aa8fe079b64205fbf91fe0b79c12f0e6e1d30e`
- Installer SHA-256: `55135ae577348353aee2321fa3e5d712646eb5ede7e2c99de1465f40f72851a3`
- Block map: 165,266 bytes; SHA-256 `64fcfec01b9d4a12f71f89b8016468a66f2b17bf643f58f7d3aec8dfea188c80`
- Packaged notice SHA-256: `8e65220a0f030f93c28133c7623fc4873d47f614eef833f2fc11e39570e23d93`
- README requires at least **1.5 GB free during installation** to cover the 513,679,795-byte installed tree, the 158,683,631-byte installer, temporary extraction, and conservative working headroom.
