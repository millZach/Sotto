# TalkType adversarial QA

Date: 2026-07-16  
Scope: Task 15 hostile-path, privacy, native-runtime, and release audit  
Status: Accepted Critical/High/Medium fixes, clean automated release gate, and final Windows observations complete; independent adversarial recheck pending.

## Method

The adversarial QA lead inspected the approved specification, source, tests, deterministic Electron workflows, unpacked application, installer, model/runtime inventory, IPC and local-protocol boundaries, and the approved 112-capture design matrix. A dedicated package attacker and a separate Windows environment auditor supplied independent evidence. Unperformed manual checks are recorded as limitations rather than inferred as passes.

Initial automated evidence:

- Coverage: 51 files passed; 786 tests passed, 1 skipped; 83% statements.
- E2E: 24 passed, 1 failed, 6 skipped. The failing hotkey-conflict workflow is an accepted High release blocker.
- Focused package/security boundary checks: 241 passed.
- Existing packaged Balanced/WASM worker reached ready with zero HTTP(S) model/runtime requests.
- Initial worktree remained clean at `476e08808faef065581051439e5bb4129a855dcc`.

## Findings and accepted dispositions

| ID | Severity | Finding and reproduction | Affected requirement | Accepted disposition / regression seam | Status |
| --- | --- | --- | --- | --- | --- |
| AQ-01 | High | The installer and unpacked app predate Task 14. Embedded CSS lacks `.tt-toggle__copy`, Home named grid/tone markers, and contained widget styles. | SC 1, 2, 7, 12; delivery artifacts | Rebuild both artifacts only after every fix; verifier must bind the package to current build outputs and record final hashes. | Resolved: fresh installer/unpacked artifacts include current build and pass exact provenance/equivalence verification. |
| AQ-02 | High | If the main renderer exits during permission, listening, or processing, renderer cleanup stops capture but native tray, Escape, and widget state can remain dictating/listening. | SC 4, 10, 11; failure handling | At the native renderer-loss lifecycle seam, publish idle, reset tray while retaining auto-paste, release Escape, hide/reset widget, and prove a subsequent session starts cleanly. | Resolved in `ae2ce66`; 156 focused tests passed. |
| AQ-03 | High | `npm run test:e2e` fails the hotkey-conflict workflow because the UI emits canonical `CommandOrControl+Alt+9` while the deterministic adapter compares an uncanonicalized `Ctrl+Alt+9` fixture. | SC 3, 10, 11 | Canonicalize at the deterministic native adapter boundary and prove a conflict preserves the old shortcut. | Resolved in `119fd90`; full E2E now passes 25 with 6 intentional capture skips. |
| AQ-04 | Medium | WebGPU failure falls back only under `auto`; explicit WebGPU fails, and a working WASM fallback is not remembered for the session. | SC 5, 10; failure handling | `TranscriptionClient` must perform one fresh-worker WASM retry for `auto` and `webgpu`, then reuse the working backend. | Resolved in `ca938bb`; transcription suite 15/15 and full coverage gate pass. |
| AQ-05 | Medium | The packaged verifier validates shape and operation but can approve stale output unrelated to current `out/` or HEAD. | SC 1, 2, 7, 11; delivery artifacts | Compare package contents with just-built main/preload/renderer outputs and validate build/source provenance; verify installer and unpacked archive equivalence. | Resolved in `119fd90` and `65abea9`; schema v2 binds exact output bytes to deterministic release inputs and installer/unpacked ASAR equality. |
| AQ-06 | Medium | Model readiness is cached after the first verification, so same-path tampering after that check may be served until restart. | SC 2, 5, 10; security/privacy | Revalidate allowlisted content before local protocol delivery or pipeline load; a same-size post-verification overwrite must be rejected. | Resolved in `691c1da`; model/protocol 99/99 and security/integration 135/135. |
| AQ-07 | Medium | Corrupt settings/history are backed up and defaulted, but no sanitized non-blocking recovery notice reaches the renderer. | SC 10; failure handling | Surface a typed recovery notice after backup/default recovery, without exposing paths or transcript content. | Resolved in `c49e36a`; typed deduplicated safe notices, preserved backups/defaults, and disabled-history privacy are covered in the 812-test gate. |
| AQ-08 | Medium | The active microphone track ending/removal is not observed, so UI may remain listening until duration timeout. | SC 10, 11; audio recorder | End the active track during capture and require a finite device-unavailable error plus complete cleanup. | Resolved in `ca938bb`; recorder 33/33 and controller 45/45. |
| AQ-09 | Medium | Widget placement follows the mouse-cursor display; the specification says active display, which is ambiguous when typing focus and mouse are on different monitors. | SC 4; native windows | The approved implementation and original plan operationally define active display through Electron's cursor-nearest display. Retain the non-activating, bounded implementation rather than adding an invasive foreground-window bridge; document the one-monitor manual limitation. | Accepted specification clarification; geometry remains tested and no two-monitor hardware is available. |
| AQ-10 | Low | Release executables are unsigned; public distribution may show Windows trust warnings. | Delivery quality | Keep the existing local-build disclosure. Require signing before broad public distribution; it is not available for this local release. | Accepted limitation |
| AQ-11 | Medium | A controlled Edge textarea run copied the transcript but the old `System.Windows.Forms.SendKeys` command could exit successfully without inserting it, falsely reporting “pasted.” | SC 6, 10; output reliability | Replace `SendKeys` with a static transcript-free `user32.SendInput` sequence that exits nonzero unless Windows accepts all four key events, preserving clipboard-first copied fallback. | Resolved in `fe57ff0`; focused 26/26, native TextBox smoke pass, and natively+DOM-focused Edge textarea smoke pass. |

## Attack matrix

| Attack | Initial result | Evidence / next action |
| --- | --- | --- |
| Rapid shortcut repetition; repeated stop/cancel; stale results | Pass | Controller and recorder concurrency tests. |
| Renderer reload/crash | Fail | AQ-02. |
| Corrupt settings/history | Partial | Backup/default behavior passes; AQ-07 notice missing. |
| Missing/tampered model | Partial | Startup tamper passes; AQ-06 post-verification cache gap. |
| Offline startup/local inference | Pass (automated) | Packaged Balanced/WASM ready; zero HTTP(S) model/runtime requests. Real offline mic run remains manual. |
| Microphone denial | Pass | Deterministic denial workflow and recovery copy. |
| Microphone removal | Fail | AQ-08. |
| Silence and maximum duration | Pass | Controller/E2E evidence. |
| WebGPU fallback | Partial | Auto fallback exists; AQ-04 covers explicit preference and session memory. |
| Clipboard preservation and paste spawn failure | Pass (automated) | Clipboard-first output and copied fallback tests. Elevated real target remains manual. |
| Hotkey conflict | Fail | AQ-03; current E2E gate red. |
| Multiple instances | Pass | Live second process exited while original remained responsive. |
| Tray close/restore | Pass | Live WM_CLOSE hid the window; a later launch restored it without a new instance. Tray-menu Quit remains manual. |
| Sleep/wake | Not proven | Only one live machine; no suspend cycle performed. Recorder/device lifecycle coverage is being strengthened. |
| Multi-monitor bounds | Partial | Geometry tests pass; one physical monitor is available; AQ-09 is closed by the approved cursor-nearest operational definition. |
| Path traversal and malformed IPC | Pass | Hostile local-protocol and typed IPC probes. |
| Remote network attempts | Pass (scoped) | Packaged inference trace saw no HTTP(S) model/runtime requests; no OS-wide packet capture. |
| Transcript/audio logging | Pass | Static and automated inspection found no transcript or PCM logging. |
| History disabled | Pass | No-write and privacy tests. |
| Theme, scale, reduced motion | Pass | Approved deterministic 112-capture matrix. |
| Installer resources | Partial | Inventory passes; AQ-01/AQ-05 stale provenance. |
| Install/uninstall | Not proven | Static NSIS inspection only; no clean-user install/uninstall yet. |

## Success-criterion audit at initial review

| # | Success criterion | Initial status |
| --- | --- | --- |
| 1 | Install/launch without Python, API key, or separate model download | Partial: existing package proves the architecture but is stale. |
| 2 | Installer bundles Balanced model/runtime and guides first run | Partial: existing package/E2E pass; final package must be rebuilt. |
| 3 | Default configurable global shortcut | Fail: AQ-03 makes the authoritative conflict workflow red. |
| 4 | Compact non-activating widget | Partial: automated evidence passes; cross-app/multi-monitor manual evidence is limited. |
| 5 | Local bundled/optional-model transcription | Pass in packaged deterministic/local-only worker evidence; real spoken verification pending. |
| 6 | Clipboard-first output and optional auto-paste | Pass automated; real target/elevated checks pending. |
| 7 | Complete light/dark/system themes | Source approved; distributed artifact is stale. |
| 8 | Complete settings | Pass. |
| 9 | Search/copy/delete history | Pass. |
| 10 | Usable actionable failure recovery | Fail: AQ-02, AQ-04, AQ-07, AQ-08. |
| 11 | Critical automated coverage and green gates | Fail while E2E is red. |
| 12 | Design/adversarial review and no Critical/High findings | Fail while AQ-01 through AQ-03 remain. |

## Direct Windows observations

- Windows 11 Home x64 build 26200; one 1707×1067 display at 150% scaling.
- Realtek Microphone Array present and Windows microphone policy allowed.
- Notepad, Edge, Chrome, and Microsoft Word are installed.
- Existing unpacked app launched with five responsive Electron processes.
- Second launch exited without creating another instance.
- `WM_CLOSE` hid the main window while the process stayed alive; a later launch restored the existing window.
- Both release executables report `NotSigned`.

Not yet exercised and not inferred as passes: a unique real spoken transcript, global dictation into each target, elevated-target fallback, two-monitor placement, sleep/wake, startup mutation, tray-menu Quit, clean-user installation/uninstallation, and real-model transcription with networking disabled.

## Fix verification

- Clean `npm ci`: 531 packages installed; zero reported vulnerabilities.
- Model/runtime verification: 12 model files and 4 runtime files passed pinned hashes.
- Lint and both TypeScript projects: passed.
- Coverage: 55 files passed, 1 opt-in Windows integration file skipped; 814 tests passed, 3 skipped; 83.57% statements, 78.72% branches, 81.75% functions, 88.00% lines.
- Full Electron E2E: 25 passed, 6 intentional design-capture skips; hotkey conflict is green.
- Native output integration: fixed `SendInput` command passed an ordinary Windows TextBox and a natively+DOM-focused Edge textarea.
- `package:dir`: passed current-output/provenance checks and real packaged Balanced/WASM worker smoke.
- `package:win`: passed; installer-embedded and unpacked `app.asar` are byte-identical at 31,813,139 bytes, SHA-256 `1668B32D57E6BEEC1F7D9371B017C97BF5F22A76AFF5749D46E1AE0B3565DBE7`.
- Authoritative build-input revision: `CAD61094C0E1F43FD233EDDBE6432932D57DA196D809FB0A5DB6ED4D51EA9FCF`.

## Final Windows evidence

- The fresh final installer and unpacked application were independently hashed, installed to a verified temporary per-user directory, launched, tray-quit, silently uninstalled, and fully cleaned. Installed executable and `app.asar` hashes matched the release artifacts exactly.
- Onboarding, physical Realtek microphone permission/input, bundled Balanced readiness, single-instance restoration, close-to-tray, tray menu/quit, Start Menu shortcut, uninstall registration, and documented app-data preservation were directly observed.
- A real acoustic microphone path used Microsoft David Desktop through Realtek speakers into the physical Realtek Microphone Array. Global `Ctrl+Shift+Space` kept Notepad foreground; the resulting transcript matched clipboard and Notepad exactly.
- A proxy-blocked run with Chromium HTTP(S) forced to `127.0.0.1:9` still completed bundled local transcription and delivery. This is not claimed as full OS network disconnection.
- After AQ-11, a native keystroke probe first established an Edge textarea's true keyboard focus. The final installed package kept Edge foreground through recording and placed identical text in clipboard and the textarea.
- Cleanup restored the original profile and clipboard exactly and left zero TalkType processes, temp directories, shortcuts, or uninstall registry entries.

Manual limitations: human speech was not used (the acoustic source was synthetic); Microsoft Word, an elevated target, startup mutation, sleep/wake, and multi-monitor hardware were unavailable or intentionally not exercised. The release is unsigned. These are recorded limitations, not inferred passes.

## Recheck

Pending independent adversarial recheck of the fixes and this evidence. No known Critical or High code/release finding remains.
