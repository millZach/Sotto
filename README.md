# Sotto

Sotto is a private, offline-first Windows dictation app. Press the global shortcut, speak, press it again, and Sotto copies the local transcript and optionally pastes it at the active cursor. Raw audio stays in memory and is discarded after transcription.

Download the latest installer from [Releases](https://github.com/millZach/Sotto/releases/latest).

Sotto was formerly named TalkType; version 3.0.0 renamed the app and its visual identity. On first launch, Sotto automatically migrates settings, history, and downloaded models from an existing TalkType installation.

## Requirements

- Windows 10 or Windows 11, x64
- A working microphone and permission for desktop apps to use it
- At least 1.5 GB of free space during installation for the installer, temporary extraction, the app, bundled Balanced speech model, and safe working headroom; the installed app is about 500 MB before optional models
- Node.js 22 or newer only when developing from source; installed users do not need Node.js, Python, an account, an API key, or a separate model download

## Privacy and cost

The included Balanced Whisper model and inference runtime run on this computer. Sotto has no cloud transcription, analytics, crash upload, update telemetry, account, subscription, or per-use fee. Audio is never persisted. Transcript history is local, optional, bounded, searchable, and clearable.

Optional Fast and Accurate models are not downloaded until you review their source, approximate size, license, and network-metadata disclosure and explicitly consent. Those downloads contact Hugging Face, so that provider receives ordinary request metadata such as IP address and request time; audio and transcripts are not sent.

Optional AI formatting is the one feature that sends transcript text off this computer, and it is off by default. When you enable it and supply your own OpenRouter API key, the finished transcript (never audio) is sent to OpenRouter for punctuation and self-correction cleanup. If the network is slow or offline, Sotto silently falls back to the raw local transcript.

## Install and first run

Run the `Sotto Setup <version>.exe` installer and choose the per-user installation folder. The desktop shortcut is optional and unchecked by default; the installer always creates a Start Menu shortcut. Uninstalling removes either shortcut but preserves settings, history, and optional downloaded models by default so an accidental uninstall does not silently destroy local data.

Upgrading from TalkType: because the application identity changed in 3.0.0, Sotto installs alongside TalkType instead of replacing it. Your data migrates automatically the first time Sotto starts; uninstall TalkType afterward from Windows Settings → Apps.

Locally built artifacts are not code-signed because no Windows signing certificate is stored in this repository. Windows may therefore show an **Unknown publisher** or SmartScreen prompt. A public release should be Authenticode-signed by its distributor without changing application behavior.

First-run setup explains privacy, tests microphone access, verifies the included Balanced model, and shows the active shortcut and safe paste-test field. The default global shortcut is `Ctrl+Shift+Space`. Press it once to start and again to stop and transcribe. `Escape` cancels an active session.

Sotto closes to the system tray. Use the tray menu to show the window, start or stop dictation, toggle automatic paste, or quit completely.

## Settings

- Appearance: System, Light, or Dark theme; system or reduced motion
- Capture: microphone, global shortcut, recording limit, and local sound cues
- Transcription: Fast, Balanced, or Accurate preset; language; WebGPU or CPU/WASM preference; conservative whitespace formatting
- Formatting: optional AI cleanup via OpenRouter (off by default, needs your API key) with quality tiers, a personal dictionary for tricky words, and streaming transcription so long dictations finish almost immediately after you stop
- Output: mandatory clipboard safety copy, optional automatic paste, paste delay, and success-message duration
- Application and privacy: Windows startup, start minimized, local history, retention, clear history, and reset settings

Automatic paste is best effort. Windows blocks synthetic input into elevated applications, password fields, protected desktops, and some custom editors. When paste is rejected, Sotto shows **Copied — paste manually** and leaves the complete text in the clipboard. If the target app is running as administrator, either paste manually or run both apps at the same integrity level.

## Development

```powershell
npm ci
npm run model:verify
npm run dev
```

The pinned Balanced model and ONNX runtime are already represented by hash-locked manifests. If a clean source checkout does not contain their large files, prepare them once with network access:

```powershell
npm run model:prepare
npm run model:verify
```

Normal transcription is local-only; model preparation is a release-engineering step, not an end-user first-run download.

## Test matrix

```powershell
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run model:verify
```

Unit and integration tests cover settings recovery, history privacy, audio math and lifecycle, model/runtime integrity, IPC validation, hotkeys, clipboard-before-paste output, startup, tray, window security, transcription orchestration, and widget synchronization. Electron end-to-end tests use an admitted non-packaged boundary with deterministic in-memory microphone, shortcut, clipboard, paste, startup, tray, and model adapters. They cover onboarding, registered-hotkey dictation, in-app paste, history on/off, theme and settings reload, hotkey conflict, microphone denial recovery, silence, paste fallback, hide-to-tray, single-instance behavior, and transcription failure. Widget visual tests verify ten 420x92 light/dark state images and transparent corners.

The deterministic boundary is rejected in packaged builds and accepts calls only from the trusted main renderer. It never logs transcript text or PCM.

## Build Windows artifacts

```powershell
npm run package:dir
npm run package:win
```

Artifacts are written to:

- `release/win-unpacked/Sotto.exe` — unpacked x64 application
- `release/Sotto Setup <version>.exe` — assisted, per-user x64 NSIS installer

Brand assets (`build/icon.png`, `build/icon.ico`, `build/installer-sidebar.bmp`) are generated from the SVG masters in `build/` with `node scripts/generate-brand-assets.mjs`.

The packaged `resources` directory contains `models/`, `runtime/`, `README.md`, and `THIRD_PARTY_NOTICES.md`. Each packaging command automatically verifies the source model before packaging and verifies the packaged model, runtime, notices, bridge, worker, and worklet afterward.

## Troubleshooting

- **Microphone denied:** Open Windows Settings → Privacy & security → Microphone, enable microphone access and desktop-app access, then retry.
- **No microphone found:** Connect or enable an input in Windows Settings → System → Sound, then select it in Sotto Settings.
- **Shortcut conflict:** Choose another accelerator in Settings. Sotto keeps the last working shortcut if registration fails.
- **No speech detected:** Move closer to the microphone and confirm the level meter responds. Silence does not replace the clipboard or create history.
- **Paste did not occur:** Paste manually with `Ctrl+V`; the transcript is already in the clipboard. Elevated and protected targets commonly reject automation.
- **Model unavailable:** Use the included Balanced preset, run the model verification again in a source build, or remove and reinstall only the affected optional preset.
- **WebGPU failed:** Choose Auto or CPU/WASM. Sotto falls back locally without uploading audio.
- **AI formatting not applied:** Check that AI formatting is enabled with a valid OpenRouter API key and that the computer is online. When formatting fails or times out, Sotto delivers the raw local transcript instead of failing the dictation.
- **Window disappeared:** Sotto is probably in the notification area. Open it from the tray icon or start Sotto again; the existing instance will be shown.

Third-party licenses and brand-generation provenance are recorded in `THIRD_PARTY_NOTICES.md`.
