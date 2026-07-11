# TalkType Desktop Dictation — Design Specification

**Status:** Approved product direction  
**Date:** 2026-07-11  
**Target:** Windows 10 and Windows 11 desktop  
**Working product name:** TalkType

## 1. Product intent

TalkType is a privacy-conscious desktop dictation application inspired by the speed and low-friction interaction of WhisperFlow. A user presses a system-wide hotkey, speaks, presses the hotkey again, and receives polished text at the active cursor. The same text is always copied to the clipboard so a failed paste never loses the transcription.

The application must feel dependable enough to remain running in the system tray throughout the day. It must explain model downloads and permission requirements, show visible state changes, recover cleanly from failures, and expose important behavior through understandable settings.

## 2. Success criteria

The first release is successful when all of the following are true:

1. A Windows user can install and launch TalkType without installing Python or supplying a cloud API key.
2. First-run setup guides the user through microphone access, offline model download, hotkey registration, and a recording test.
3. `Ctrl+Shift+Space` starts dictation globally by default; pressing it again ends dictation. The shortcut is configurable.
4. A compact always-on-top widget appears without taking focus from the application containing the user's cursor.
5. Recorded speech is transcribed locally after the selected Whisper model has been downloaded.
6. Successful text is automatically copied and, when enabled, pasted into the previously focused application.
7. Light, dark, and system-following themes are complete and visually consistent.
8. Settings cover microphone, hotkey, transcription model, language, inference preference, output behavior, sound cues, startup, and history privacy.
9. Recent transcripts can be searched, copied, and deleted when history is enabled.
10. Failure states leave the app usable and provide a concrete recovery action.
11. Unit, integration, and end-to-end tests cover critical state, settings, recording, transcription orchestration, clipboard, paste fallback, and window behavior.
12. A design-review subagent and an adversarial QA subagent inspect the running application, and all critical or high-severity findings are resolved.

## 3. Scope and constraints

### Included

- Offline-first transcription using Whisper-compatible ONNX models through Transformers.js.
- A Windows installer and an unpacked development build.
- A main management window, a compact dictation widget, and a tray menu.
- A toggle-style global shortcut. The first press starts recording and the second stops it.
- In-memory microphone capture and post-recording transcription.
- Local settings and optional local transcript history.
- Automatic clipboard copy and best-effort Windows paste automation.
- English and multilingual model choices exposed as plain-language speed/accuracy presets.

### Deliberately excluded from the first release

- Cloud transcription accounts or paid API integrations.
- Live word-by-word streaming while the user is still speaking.
- macOS and Linux installers.
- Team accounts, synchronization, shared dictionaries, or analytics services.
- Persisting raw audio or exporting audio recordings.
- A press-and-hold shortcut, which would require a lower-level global keyboard hook and creates additional accessibility and packaging risk.

These exclusions preserve a coherent offline desktop product while leaving clear extension points for later providers and platforms.

## 4. Technical approach

TalkType uses Electron, React, and TypeScript. Electron provides the application lifecycle, system tray, global shortcut, clipboard, native windows, and Windows startup integration. React provides the main interface and widget UI. Transformers.js runs Whisper inference in a dedicated Web Worker so model loading and transcription do not freeze the interface.

The renderer captures mono floating-point audio with Web Audio, resamples it to 16 kHz, and transfers the sample buffer to the transcription worker. The worker attempts WebGPU when requested and available, then falls back to the supported browser/WASM path. Model assets download during onboarding and remain in the application's persistent browser cache for offline reuse.

The main and renderer processes communicate only through a narrow, typed preload bridge. Node integration remains disabled in renderers, context isolation remains enabled, and every IPC operation validates its input.

## 5. Component boundaries

### Electron main process

Responsibilities:

- Own application startup, single-instance behavior, tray lifecycle, and controlled shutdown.
- Create the main and widget windows with secure defaults.
- Register, unregister, and validate the global hotkey.
- Store validated settings in the Electron user-data directory.
- Store optional transcript history in the user-data directory.
- Copy successful text with Electron's clipboard API.
- Trigger best-effort Windows `Ctrl+V` input after the widget is hidden.
- Keep the widget positioned above the taskbar on the active display.
- Expose only typed IPC commands through the preload bridge.

The main process does not capture audio or run model inference.

### Main renderer

Responsibilities:

- Render onboarding, Home, History, Settings, and Help views.
- Enumerate microphones after permission is granted.
- Own the recording state machine and user-facing notifications.
- Coordinate model setup and transcription-worker messages.
- Send successful results to the main process for output and persistence.
- Reflect settings changes immediately when safe to do so.

### Widget renderer

Responsibilities:

- Render the compact always-on-top experience.
- Display `idle`, `listening`, `processing`, `success`, `cancelled`, and `error` states.
- Show a timer, input activity visualization, and short recovery messages.
- Never become the active typing target during global dictation.

The widget receives state snapshots over IPC and does not own recording or transcription logic.

### Audio recorder

Responsibilities:

- Request the chosen microphone.
- Collect mono PCM samples through Web Audio.
- Calculate low-cost RMS levels for the waveform.
- Stop at the configured maximum duration.
- Resample to 16 kHz using a deterministic pure function.
- Release every media track and audio node on completion, cancellation, or error.

Raw audio remains in memory and is discarded after worker completion.

### Transcription worker

Responsibilities:

- Lazily load exactly one model configuration at a time.
- Report model download and initialization progress.
- Transcribe transferred 16 kHz audio without blocking the UI thread.
- Apply language and generation options supported by the chosen model.
- Return structured success or normalized error responses.
- Dispose and reload the pipeline when a changed model requires it.

### Settings and history stores

Settings are versioned and migrated through a typed schema. Invalid persisted values fall back at field level rather than resetting the entire configuration. History entries contain only an identifier, text, creation time, duration, detected language, and model preset. History has a bounded retention setting and is never written when disabled.

## 6. Dictation data flow

1. The user presses the registered global shortcut.
2. The main process sends a toggle request to the main renderer and shows the widget without activation.
3. The recorder requests the selected microphone and begins collecting audio.
4. The renderer streams level samples to the widget and updates elapsed time locally.
5. The next shortcut press, the widget stop action, or the duration limit ends capture. `Escape` cancels without transcription.
6. The recorder closes its media resources, resamples the audio, and transfers the buffer to the worker.
7. The worker loads the selected model if necessary and returns transcribed text.
8. A conservative formatter trims outer whitespace, normalizes repeated internal whitespace, and preserves the words and punctuation produced by Whisper.
9. The renderer sends the result to the main process.
10. The main process writes the text to the clipboard, hides the widget, waits for the configured paste delay, and attempts `Ctrl+V` when auto-paste is enabled.
11. If history is enabled, the metadata is persisted locally.
12. The widget briefly shows success, then hides. The main window and tray remain available.

Only one dictation session may be active. A stale worker result is ignored when its session identifier no longer matches the active session.

## 7. Output and paste behavior

Clipboard copy is mandatory for every non-empty successful transcription. Empty or silence-only results do not overwrite the clipboard.

Auto-paste is enabled by default after onboarding explains it. The widget is shown without activation so the prior application's cursor normally remains active. Before paste, TalkType hides the widget and waits for the configured delay, defaulting to 150 milliseconds. Windows paste automation uses a fixed, encoded PowerShell command that sends `Ctrl+V`; transcript text never enters the command line because it is already in the clipboard.

Windows may reject synthetic input in elevated applications, password fields, protected desktops, or applications with custom input handling. Such a failure is non-destructive: the widget reports “Copied — paste manually” and the transcript remains in the clipboard.

## 8. Interaction design

### Onboarding

Onboarding contains four focused steps:

1. Welcome and privacy explanation.
2. Microphone permission and input-level test.
3. Speed/accuracy preset selection and model download with file-level progress.
4. Hotkey and paste test inside a safe TalkType text field.

The user can return to any step. Setup is considered complete only after microphone access and a usable model are confirmed.

### Main window

The main window is approximately 1080 by 720 logical pixels and uses a compact left navigation rail:

- **Home:** ready status, prominent record control, shortcut reminder, current model status, and recent entries.
- **History:** local search, copy, delete, and clear controls with explicit confirmation for destructive actions.
- **Settings:** grouped configuration with inline explanations and validation.
- **Help:** concise shortcut, privacy, model, paste, and troubleshooting guidance.

The custom title area supports drag, minimize, and close. Closing the main window keeps TalkType in the tray unless the user explicitly quits.

### Floating widget

The widget is a frameless pill positioned near the bottom center of the active display. It contains a state icon, short status label, animated level bars, elapsed time, and a compact cancel affordance. It never resembles a modal dialog.

- **Listening:** accent glow, live input bars, timer, and “Press shortcut to finish.”
- **Processing:** calm progress animation and current stage.
- **Success:** check mark and “Pasted” or “Copied.”
- **Error:** concise cause and recovery action.

The widget respects reduced-motion preferences and never uses animation as the only state indicator.

## 9. Visual system

The visual direction is quiet, modern, and focused rather than overtly futuristic.

- **Typography:** system UI typography with a readable 14–16 px body scale and strong numeric timer alignment.
- **Shape:** 12–18 px surface radii, one-pixel neutral borders, and restrained elevation.
- **Accent:** indigo as the primary action color with cyan used only for live audio activity.
- **Light theme:** warm off-white canvas, white elevated surfaces, graphite text, and low-chroma borders.
- **Dark theme:** deep graphite canvas, slightly lighter elevated surfaces, near-white text, and desaturated borders.
- **Status colors:** teal success, amber warning, and coral error, each paired with text or iconography.
- **Motion:** 140–220 ms transitions, waveform motion only while recording, and a complete reduced-motion mode.

Both themes meet WCAG AA contrast for normal text and focus indicators. Keyboard focus is always visible.

## 10. Settings model

### Appearance

- Theme: System, Light, or Dark.
- Reduced motion: follow system or force on.

### Capture

- Microphone device.
- Global shortcut, validated before replacing the active registration.
- Maximum recording duration: 30 seconds, 1 minute, 2 minutes, or 5 minutes.
- Start and stop sound cues.

### Transcription

- Preset: Fast, Balanced, or Accurate.
- Language: Auto-detect, English, or a supported multilingual language.
- Inference preference: Auto, WebGPU, or CPU/WASM.
- Conservative whitespace formatting toggle.

### Output

- Automatic clipboard copy, shown as always enabled in the first release.
- Automatic paste toggle.
- Paste delay from 50 to 1000 milliseconds.
- Success notification duration.

### Application

- Launch when Windows starts.
- Start minimized to tray.
- Keep local history.
- History retention: 25, 100, 500, or unlimited entries.
- Clear history.
- Reset settings while preserving or separately clearing models.

## 11. State and concurrency rules

The recording coordinator uses an explicit state machine:

`idle → requesting-permission → listening → processing → success → idle`

Cancellation may transition from permission, listening, or processing to `cancelled → idle`. Any operational failure transitions to `error → idle` after it has been surfaced. Invalid transitions are ignored and logged in development builds.

Every session receives a unique identifier. Stop and cancel operations are idempotent. Repeated hotkey events during `requesting-permission` or `processing` do not start a second session. Quitting stops tracks, terminates the worker, unregisters shortcuts, and removes tray resources.

## 12. Failure handling

- **Microphone denied:** show the Windows permission path and a retry button.
- **No input device:** keep manual navigation usable and link to device settings.
- **Hotkey conflict:** preserve the previous working shortcut and explain that another application owns the proposed combination.
- **Model download interrupted:** retain cached parts where supported and expose retry without restarting onboarding.
- **WebGPU unavailable or failed:** retry once through CPU/WASM and remember the working backend for the session.
- **Out of memory:** recommend a smaller preset and unload the failed pipeline.
- **Silence-only audio:** do not alter the clipboard or history; show “No speech detected.”
- **Paste rejected:** report copy success and keep the text in the clipboard.
- **Corrupt settings/history:** preserve the original file with a timestamped recovery suffix, load field-level defaults, and show a non-blocking notice.
- **Unexpected renderer exit:** recreate the main window on demand and reset the dictation state in the main process.

Production logs contain operational metadata but never transcript text or raw audio.

## 13. Security and privacy

- Renderer windows use `contextIsolation: true`, `nodeIntegration: false`, sandboxing where compatible, and a restrictive Content Security Policy.
- The preload bridge exposes named methods rather than a generic IPC sender.
- IPC settings and history payloads are schema-validated in the main process.
- Navigation, new-window creation, and unexpected permission requests are denied.
- Microphone access is granted only to the trusted application origin.
- Model downloads are restricted to the selected Hugging Face model identifiers over HTTPS.
- Audio is kept only in memory and transferred to the local worker.
- History is local, optional, bounded, and clearable.
- Paste automation uses a static command and never interpolates user text.
- No analytics, crash upload, cloud transcription, or update telemetry is included.

## 14. Testing strategy

### Unit tests

- Settings defaults, validation, migrations, and field-level recovery.
- Recording state transitions and stale-session rejection.
- Audio downsampling, empty input, duration limits, and level calculation.
- Transcript formatting without semantic modification.
- Model preset mapping and backend fallback decisions.
- History retention, search, deletion, and disabled persistence.
- Hotkey normalization and conflict rollback.
- Paste command encoding and output fallback decisions.

### Integration tests

- Preload contracts and main-process IPC validation.
- Clipboard copy before paste invocation.
- Widget state synchronization across the two renderers.
- Tray and global-hotkey lifecycle.
- Model-worker progress, success, cancellation, and error messages using a deterministic worker seam.
- Startup settings and single-instance behavior.

### End-to-end tests

- First-run onboarding with deterministic media and transcription fixtures.
- Hotkey start/stop through the application command boundary.
- Successful copy-and-paste workflow into an in-app test target.
- Light, dark, and system theme screenshots.
- History-disabled privacy workflow.
- Permission denial, model failure, silence, and paste-fallback recovery.

### Manual Windows verification

- Real microphone capture and transcription using the downloaded model.
- Global shortcut while Notepad, a browser text field, and Microsoft Word are active.
- Paste behavior in a normal process and documented fallback against an elevated process.
- Tray behavior, startup registration, multi-monitor positioning, sleep/wake, and quit cleanup.
- Installer launch on a clean user profile.

## 15. Review gates

Implementation is not considered complete until:

1. Automated checks, type checking, builds, and packaging pass.
2. A design subagent reviews screenshots of onboarding, Home, Settings, History, and every widget state in both themes.
3. Design findings affecting hierarchy, consistency, contrast, clipping, focus, or feedback are corrected and rechecked.
4. An adversarial QA subagent maps every requirement in this specification to evidence, exercises unhappy paths, and reports severity-ranked findings.
5. Every critical and high-severity QA finding is fixed and regression-tested.
6. The final requirement-by-requirement completion audit has authoritative evidence for each success criterion.

## 16. Delivery artifacts

- Complete source code and locked dependency manifest.
- Development and test commands in `README.md`.
- Windows installer and unpacked build under the release output directory.
- Automated test suite and coverage report.
- Design screenshots used for visual review.
- Verification record mapping success criteria to test or manual evidence.

