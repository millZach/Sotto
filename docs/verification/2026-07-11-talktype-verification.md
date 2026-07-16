# TalkType completion verification

Date: 2026-07-16  
Build-input revision: `CAD61094C0E1F43FD233EDDBE6432932D57DA196D809FB0A5DB6ED4D51EA9FCF`  
Status: Automated, packaged, and final Windows gates complete; independent adversarial recheck pending.

## Final automated release gate

| Gate | Authoritative result |
| --- | --- |
| `npm ci` | Exit 0; 531 packages installed; 0 vulnerabilities reported. |
| `npm run model:verify` | Exit 0; 12 pinned Balanced model files and 4 runtime files verified. |
| `npm run lint` | Exit 0. |
| `npm run typecheck` | Exit 0 for node and renderer TypeScript projects. |
| `npm run test:coverage` | Exit 0; 55 files passed, 1 opt-in Windows integration file skipped; 814 passed, 3 skipped; 83.57% statements, 78.72% branches, 81.75% functions, 88.00% lines. |
| `npm run test:e2e` | Exit 0; 25 passed, 6 intentional design-capture skips. |
| `npm run package:dir` | Exit 0; exact current-output/provenance validation and real packaged Balanced/WASM worker smoke passed. |
| `npm run package:win` | Exit 0; NSIS build, exact installer/unpacked ASAR equality, model/runtime protocols, and real packaged worker smoke passed. |
| `npm run design:verify` | Task 14 no-update replay passed 6/6; 112 exact deterministic tuples. |
| Widget visual previews | 14/14 passed. |

Build provenance v2 records 17 compiled artifacts, exact byte counts and SHA-256 values, informational source commit `fe57ff096432a5608d76064a0d28ceb6b2b739e4`, authoritative release-input revision `cad61094c0e1f43fd233eddbe6432932d57da196d809fb0a5db6ed4d51ea9fcf`, and compiled-output aggregate `a74278e6a91c9b704e9dcf4f1ff9d81009e6c8c5a691f8a4d7c957db31c0d330`.

## Success criteria

| # | Requirement | Evidence | Status |
| --- | --- | --- | --- |
| 1 | A Windows user can install and launch without Python, a cloud API key, or a separate model download. | NSIS package contains Electron application, model, and runtime; real temporary per-user install/launch/uninstall and package worker passed without Python or credentials. | Pass. |
| 2 | Installer includes Balanced model/runtime; first run covers microphone, model verification, hotkey, and recording test. | `resources/models`, `resources/runtime`, 12+4 hashes, packaged Balanced/WASM smoke, onboarding E2E and approved onboarding captures. | Pass. |
| 3 | Default `Ctrl+Shift+Space` globally toggles dictation and is configurable. | Hotkey manager/unit coverage; full Electron E2E conflict workflow; real global-hotkey acoustic runs into Notepad and Edge. | Pass. |
| 4 | Compact always-on-top widget appears without stealing target focus. | Exact BrowserWindow options, 420×92 baselines, focusability/position tests, 112-capture matrix, widget 14/14, and foreground HWND retained by Notepad/Edge during real runs. | Pass. |
| 5 | Speech is transcribed locally using bundled or explicitly installed models. | Packaged Balanced/WASM worker reaches ready; local schemes; zero HTTP(S) trace; proxy-blocked real acoustic transcription; consent-gated optional downloads; tamper invalidation. | Pass. |
| 6 | Successful text is always copied and optionally auto-pasted to the prior app. | Clipboard-first `OutputService`, transcript-free fixed `SendInput`, copied fallback tests, 25-test E2E suite, real acoustic Notepad pass, and focused native Edge textarea smoke. | Pass; Word/elevated manual checks remain limitations. |
| 7 | Light, dark, and system themes are complete and consistent. | Independent approved design recheck; both themes and system settings; 112 exact captures at 100–200%. | Pass. |
| 8 | Settings cover microphone, hotkey, model, language, inference, output, sound, startup, and history privacy. | Settings schema/view/component tests and complete Settings captures. | Pass. |
| 9 | Recent transcripts can be searched, copied, and deleted when history is enabled. | Repository, IPC, renderer, and E2E coverage; disabled-history no-read/no-write privacy regressions. | Pass. |
| 10 | Failure states remain usable and provide recovery. | Permission, silence, model, paste, hotkey conflict, renderer loss, WebGPU→WASM, mic removal, corrupt-store notice, and model tamper tests; widget/UI error captures. | Pass. |
| 11 | Unit, integration, and E2E cover critical state/native behavior. | 814 coverage tests, 25 E2E, native paste integrations, package/security attacks, 83.57% statement coverage. | Pass. |
| 12 | Design and adversarial subagents review the running app and all Critical/High findings are resolved. | Approved Task 14 review; Task 15 initial attack; High fixes `ae2ce66`, `119fd90`; fresh final artifacts and Windows evidence. Final adversarial recheck pending. | Pending final recheck. |

## Adversarial finding closure

| Finding | Resolution evidence |
| --- | --- |
| AQ-01 stale release | Fresh current-input installer/unpacked build and exact archive equality. |
| AQ-02 renderer-loss native state | `ae2ce66`; fail-closed idle/widget/tray/Escape recovery, 156 focused tests. |
| AQ-03 hotkey conflict E2E | `119fd90`; canonical deterministic adapter and green full E2E. |
| AQ-04 WebGPU fallback/session memory | `ca938bb`; 15/15 transcription client. |
| AQ-05 stale verifier provenance | `119fd90`, `65abea9`; schema v2 deterministic input digest plus exact compiled/archive/installer bytes. |
| AQ-06 post-verification model tamper | `691c1da`; changed metadata invalidates cache and forces hash verification before protocol delivery. |
| AQ-07 corrupt-store notice | `c49e36a`; sanitized deduplicated typed notices and preserved backups/defaults. |
| AQ-08 active microphone removal | `ca938bb`; track-ended/removetrack finite error and cleanup. |
| AQ-09 active display ambiguity | Approved implementation operationally defines active display as cursor-nearest; one-monitor limitation recorded. |
| AQ-10 unsigned local build | Disclosed limitation; code signing is required before broad public distribution. |
| AQ-11 browser paste false-positive | `fe57ff0`; transcript-free `SendInput` requires all four accepted events, with native TextBox and focused Edge integration passes. |

## Delivery artifacts

| Artifact | Path / evidence | Status |
| --- | --- | --- |
| Complete source and locked dependencies | Repository source plus `package-lock.json`; clean `npm ci`. | Present. |
| Development/test commands | `README.md` and `package.json`. | Present. |
| Windows installer | `release/TalkType Setup 0.1.0.exe`, 158,685,584 bytes, SHA-256 `CFC5634851EEB38E31DB586499F57D9AF4914FD82929700486EB188CFE8AF0B7`. | Present and verified. |
| Installer blockmap | `release/TalkType Setup 0.1.0.exe.blockmap`, 165,266 bytes, SHA-256 `383355FD4786801C33BA017D2D2B54AE9D2CCF9842E44C41DDD109FF5559177E`. | Present. |
| Unpacked application | `release/win-unpacked/TalkType.exe`, 225,468,416 bytes, SHA-256 `ED4912024EC3DDBDA70159ACCA9B25EB872A2C7372FD6105BD3D57C66479BD97`. | Present and smoke-tested. |
| Application archive | `release/win-unpacked/resources/app.asar`, 31,813,139 bytes, SHA-256 `1668B32D57E6BEEC1F7D9371B017C97BF5F22A76AFF5749D46E1AE0B3565DBE7`; identical to installer-embedded archive. | Present and verified. |
| Balanced model/runtime | `release/win-unpacked/resources/models` and `resources/runtime`; 12+4 pinned files. | Present and verified. |
| Third-party notices | `release/win-unpacked/resources/THIRD_PARTY_NOTICES.md`, 28,605 bytes, SHA-256 `8E65220A0F030F93C28133C7623FC4873D47F614EEF833F2FC11E39570E23D93`. | Present and inventory-verified. |
| Automated tests/coverage | Vitest coverage report and Playwright E2E/design suites. | Present and green. |
| Design screenshots | `artifacts/design/app-review/manifest.json` plus 102 app-review and 10 widget tuples. | Present and independently approved. |
| Verification record | This document and `docs/qa/adversarial-review.md`. | Present; final adversarial verdict pending. |

## Direct Windows observations and limitations

Environment: Windows 11 Home x64 build 26200; one 1707×1067 display at 150%; Realtek Microphone Array and speakers; Notepad, Edge, Chrome, and Word installed.

Directly observed on the final artifact:

- Silent per-user install exited 0 in 9.977 seconds. Installed executable and `app.asar` hashes exactly matched release; Start Menu shortcut and HKCU uninstall registration were correct.
- Installed app launched, completed fresh onboarding and real microphone permission/input test, and reported bundled Balanced ready without a separate download.
- Close-to-tray, reveal existing single instance, visible tray actions, and tray Quit passed. Final tray Quit ended every process in 391 ms.
- Acoustic synthetic voice (explicitly not human speech) played through speakers into the physical microphone. Global hotkey recording preserved target foreground. Clipboard and Notepad matched exactly.
- With Chromium HTTP(S) forced through the unusable proxy `127.0.0.1:9`, a second real acoustic run still transcribed and delivered locally. This is proxy-blocked evidence, not full OS disconnection.
- The final fixed package passed Edge auto-paste after a native `x` probe proved the textarea had real keyboard focus: spoken “Fixed browser paste seven one five confirms reliable local dictation,” recognized `I'm sorry.`, with exact clipboard/textarea equality and retained focus.
- Silent uninstall exited 0 in 5.445 seconds and removed program files, shortcut, and uninstall registry entry. The documented settings/history preservation policy held.
- Original 42-file profile tree digest `FE1B8F27906DB283C4DFB2A1EC48A25D641F664218FDCDC27E6838B35DFE0B8E` and empty clipboard state were restored exactly. Zero TalkType/test processes or temporary directories remained.

Limitations: Word and an elevated target were not exercised; startup mutation and sleep/wake were not performed; only one monitor was available; the acoustic source was synthetic rather than human; code signing is not available for this local build. Automated/unit evidence covers startup, paste fallback, sleep-independent cleanup, and multi-monitor geometry, but these limitations are not represented as manual passes.

## Final adversarial verdict

Pending.
