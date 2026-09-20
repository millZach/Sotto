<div align="center">

<img src="build/icon.png" alt="Sotto icon" width="96" />

# Sotto

**Dictation that spells your world right, with a desktop control center for your agents in development.**

Sotto is a dictation app for Windows and Apple silicon Macs. Press the global shortcut, speak, press it again, and Sotto copies the transcript and optionally pastes it at the active cursor. Transcription runs on Microsoft MAI-Transcribe-2 through OpenRouter with your own API key, and your personal dictionary is sent along as spelling hints so names and product terms come back the way you write them.

[![Latest release](https://img.shields.io/github/v/release/millZach/Sotto-releases?label=release&color=e8833a)](https://github.com/millZach/Sotto-releases/releases/latest)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20x64%20%C2%B7%20macOS%20arm64-2f6f6a)](https://github.com/millZach/Sotto-releases/releases/latest)
[![Transcription](https://img.shields.io/badge/transcription-MAI--Transcribe--2%20via%20OpenRouter-2f6f6a)](#privacy-and-cost)
[![License](https://img.shields.io/badge/license-freeware-555)](LICENSE.md)

<img src="artifacts/design/baseline/listening-dark.png" alt="Sotto recording widget while listening" width="260" />

**[⬇ Download the latest installer or disk image](https://github.com/millZach/Sotto-releases/releases/latest)**

</div>

---

## Why Sotto

- 🎯 **Spells names right** — the words in your personal dictionary are sent with every request as spelling hints. In our bench that took proper-noun accuracy from 56% to 100% on the same audio.
- ⚡ **One shortcut, anywhere** — a global hotkey works in any app. Sotto always copies the transcript to the clipboard and can paste it at your cursor automatically.
- 🗣️ **One transcription model, no setup** — Microsoft MAI-Transcribe-2 through OpenRouter. Paste an API key once; there is nothing to download, pick or tune.
- ✨ **Optional AI cleanup** — punctuation, fillers, self-corrections and spoken lists, using the same OpenRouter key, with a silent fallback to the raw transcript when the network is slow.
- 🔒 **No account, no telemetry** — Sotto has no analytics or crash upload. Audio is never written to disk, and transcript history stays on this computer.
- 💸 **Free app, pay-as-you-go transcription** — no Sotto subscription. OpenRouter bills about a cent per hundred short dictations.

Sotto was formerly named TalkType; version 3.0.0 renamed the app and its visual identity. On first launch, Sotto automatically migrates settings and history from an existing TalkType installation.

## Requirements

### Windows

- Windows 10 or Windows 11, x64
- A working microphone and permission for desktop apps to use it
- An OpenRouter API key from [openrouter.ai/keys](https://openrouter.ai/keys) and an internet connection while dictating
- At least 1 GB of free space during installation for the installer, temporary extraction, the app and safe working headroom

### macOS

- macOS 11 (Big Sur) or newer — TODO(mac-bringup): replace with the LSMinimumSystemVersion read from the built bundle
- Apple silicon (arm64) only — Intel Macs are not supported
- An OpenRouter API key and an internet connection while dictating
- At least 1 GB of free space while the disk image is mounted and copied into Applications
- A working microphone and microphone permission for Sotto in System Settings → Privacy & Security → Microphone
- Automation and Accessibility permission for Sotto if you want automatic paste; without them Sotto still copies every transcript to the clipboard

Node.js 22 or newer is needed on either platform only when developing from source.

## Privacy and cost

Dictation audio is uploaded to OpenRouter and transcribed by Microsoft MAI-Transcribe-2 only while you dictate. Your personal dictionary words travel with each request as spelling hints, and the text comes back. Nothing is transcribed on this computer, so Sotto needs your OpenRouter key and a network connection to dictate; when either is missing, Sotto says so instead of transcribing elsewhere. OpenRouter charges your balance at the model's published audio rate (about $0.10 per hour of audio at the time of writing). Read [OpenRouter's privacy policy](https://openrouter.ai/privacy) for what it and its providers retain.

Sotto has no analytics or crash upload. Dictation audio is never persisted. Transcript history is local, optional, bounded, searchable, and clearable.

Generated thread titles also enable names for new worktree branches. With an OpenRouter key and Keep local history on, the writing model receives the first prompt alone, capped at 2,000 characters, to name a new worktree's temporary branch. It uses the same key and model as Sotto's other short writing; no request is made for a shared project folder or an existing worktree. Naming failure leaves the temporary name and the turn continues. Turn off Generated thread titles to disable both kinds of automatic naming. Choosing Start from origin for a new worktree fetches that branch from the project's configured Git origin before setup; Git contacts that remote using its existing authentication.

Automatic update checks are on by default. Shortly after launch and then every few minutes, the installed Windows app asks the GitHub releases page whether a newer version exists, which means GitHub sees an ordinary web request from your computer: IP address, time, and the version you are running. No audio, transcripts, settings, or identifiers are sent. When a release is found, the update control at the end of the sidebar foot offers it: one press downloads it, the next press asks before restarting into the installer, and nothing is installed behind your back when you quit. The whole check can be turned off under Settings → Updates, and "Check for Updates…" in the tray menu (the application menu on macOS) runs one on demand.

Optional AI cleanup is off by default. When you enable it, the finished transcript (never audio) is sent to OpenRouter with the same key for punctuation and self-correction cleanup. If the network is slow or offline, Sotto delivers the raw transcript instead. Optional agent control also sends the prompts you submit to the connected harness and, when configured, sends assignment text and relevant thread context to your selected reasoning provider. Agent replies default to Grok Altair, which sends reply text to xAI using a separately saved xAI API key. Kokoro Heart is a lower-cost choice that sends reply text through OpenRouter using the existing OpenRouter key. Voice previews incur the same provider usage charges; neither option silently falls back to another provider. The optional natural voice is generated on this computer after a one-time voice download. Provider usage is billed separately from Sotto access. Credentials are encrypted using the operating system credential store and are not returned to the UI.

## Agent control center (development beta)

The **Agents** view coordinates threads running in installed Codex, Claude Code and Grok Build clients, collects prompts until you say **“send it,”** and supervises only the threads you assign. It queues questions one at a time and yields a thread to manual control when you send directly in the native client. Connect clients independently in **Settings → Providers** and choose a model for each thread. **Settings → Agents**, directly below Providers, configures Sotto's separate coordinator inline for deep reasoning and thread management. The floating widget retains click-to-dictate and dragging. In a thread composer, open the effort chip to slide between the model’s supported reasoning levels. Release to save, or use the arrow keys and level buttons. At the highest level, pixel fire melts tokens into a gold bar and word; reduced motion shows the finished state. Claude’s **Add Ultrathink to prompt** puts a visible instruction in the current draft without changing effort or permissions. Ultracode workflow orchestration is not currently exposed in Sotto.

A thread's messages are Sotto's own record, kept in `threads.sqlite` in the app's data folder rather than rebuilt from the provider each time Sotto starts. A thread pane opens on its newest ten turns; press **Show earlier messages** above the oldest one to read further back. A provider session starts when you open or send to a thread, not at connect, and one left idle for thirty minutes is stopped until the next time it is needed. With **Keep local history** off, no message text is written to disk; turning it off removes the text already written, and what was not kept cannot be recovered. See [ADR-0016](docs/adr/0016-sotto-owned-history-on-an-event-store.md).

This is an unreleased development feature. Native clients retain their own subscription sign-in and model catalogs. Wake control requires separately supplied compatible local model/runtime files; their distribution, real microphone acceptance, and macOS live checks remain release gates. Production sign-in, checkout, and billing webhooks are not deployed. Until a membership service is configured, every build, installed or unpackaged, labels access **Private beta** and allows agent actions; that is not a paid entitlement.

Paste a screenshot into a thread's prompt, drag it in, or choose **Attach screenshots**. Codex models that accept images and Claude Code models support screenshots; text-only models keep the control unavailable. Send an image on its own or alongside text, with up to eight images, 10 MB per image and 20 MB total. Grok Build currently cannot receive screenshots through its native client.

Read the [agent setup and behavior guide](docs/agent-control.md), [implementation evidence and remaining gates](docs/verification/issue-9-implementation.md), and [membership service contract](docs/verification/issue-9-membership-service.md) before using or distributing this feature.

You can create a thread from the Threads page while another thread has a saved coordinator draft. The draft stays with its original thread, including while the voice coordinator is hidden for the beta.

New threads use the **Project folder** by default, including its uncommitted edits. Threads in that folder share files and branch; choose **New worktree** for independent parallel work. A new worktree is created on the first send from the selected base branch, or you can reuse an existing worktree. Before that send, change the choice in the thread's working-copy control. Settings under Application sets the global default, and New thread can override it for a project. Existing threads keep their folders and unfinished work.

The branch label follows the actual checkout. A shared project folder that changes branches can show a dismissible notice while you draft; sending continues on the current branch. **Restore branch** switches back by your choice, asking first about uncommitted changes. Worktree-backed threads follow their branch without that notice.

## Install and first run

### Windows

Run the `Sotto Setup <version>.exe` installer and choose the per-user installation folder. The desktop shortcut is optional and unchecked by default; the installer always creates a Start Menu shortcut. Uninstalling removes either shortcut but preserves settings and history by default so an accidental uninstall does not silently destroy local data.

Upgrading from TalkType: because the application identity changed in 3.0.0, Sotto installs alongside TalkType instead of replacing it. Your data migrates automatically the first time Sotto starts; uninstall TalkType afterward from Windows Settings → Apps.

Locally built artifacts are not code-signed because no Windows signing certificate is stored in this repository. Windows may therefore show an **Unknown publisher** or SmartScreen prompt. A public release should be Authenticode-signed by its distributor without changing application behavior.

### macOS

1. **Copy the app to Applications.** Open `Sotto-<version>-arm64.dmg` and drag **Sotto** onto the **Applications** shortcut in the same window, then eject the disk image and launch Sotto from Applications. Do not run Sotto from the mounted image: macOS App Translocation launches downloaded apps from a randomized read-only path, which changes the app location on every launch and makes permission grants and settings unreliable.

2. **Allow the unsigned build to open.** Sotto is ad-hoc signed but has no Apple Developer signature, so the first launch is refused with a message such as *"Sotto" is damaged and can't be opened* or *macOS cannot verify that this app is free from malware*. Open **System Settings → Privacy & Security**, scroll to the Security section, and click **Open Anyway** next to the message about Sotto, then confirm and launch Sotto again. Use this path first: macOS 15 and newer no longer offer the old Control-click → Open bypass for this case. As an alternative, clear the quarantine flag in Terminal and launch normally:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Sotto.app
   ```

3. **Grant the permissions Sotto asks for.** The first dictation asks for microphone access. The first automatic paste asks for Automation ("Sotto wants to control System Events") and needs Sotto enabled in **System Settings → Privacy & Security → Accessibility** as well. Denying or missing either grant never loses a transcript: Sotto shows **Copied — paste manually** and leaves the complete text in the clipboard, and automatic paste starts working as soon as both grants are in place.

4. **Expect the permission prompts again after every update.** macOS keys these grants to the app's code signature, and an ad-hoc signed build gets a fresh identity on every rebuild. After installing a new version, macOS treats Sotto as a new app and asks for microphone, Automation, and Accessibility again; a stale entry may need to be removed from the list before the new one takes effect. This stops once Sotto ships Developer ID-signed builds.

### First run

First-run setup explains what leaves the computer, tests microphone access, takes your OpenRouter API key (you can add it later in Settings), and shows the active shortcut and safe paste-test field. The default global shortcut is `Ctrl+Shift+Space` on Windows and `⌃⇧Space` (the literal Control key) on macOS. Press it once to start and again to stop and transcribe. `Escape` cancels an active session.

Sotto closes to the Windows notification area or the macOS menu bar. Use that menu to show the window, start or stop dictation, toggle automatic paste, or quit completely. On macOS the Dock icon appears only while the Sotto window is open; the menu-bar icon is always there.

## Settings

- Dictation: microphone, global shortcut, recording limit, local sound cues, and streaming transcription so long dictations finish almost immediately after you stop
- Transcription: MAI-Transcribe-2 through OpenRouter (the only model), your OpenRouter API key with a verify button, language, and conservative whitespace formatting
- Cleanup: optional AI cleanup with quality tiers and the personal dictionary that also feeds transcription spelling hints
- Output: mandatory clipboard safety copy, optional automatic paste, paste delay, and success-message duration
- Updates: the version you are running, an automatic GitHub release check that is on by default and can be turned off, and a manual check (the update control in the sidebar foot, the tray menu and the macOS application menu run the same check)
- Application and privacy: launch at login, start minimized, local history, retention, clear history, and reset settings

Automatic paste is best effort. Windows blocks synthetic input into elevated applications, password fields, protected desktops, and some custom editors. macOS blocks it in secure input fields and until both the Automation and Accessibility grants exist. When paste is rejected, Sotto shows **Copied — paste manually** and leaves the complete text in the clipboard. If a Windows target app is running as administrator, either paste manually or run both apps at the same integrity level.

## Development

```powershell
npm ci
npm run runtime:verify
npm run dev
```

The ONNX WASM runtime that powers the optional natural voice is represented by a hash-locked manifest. If a clean source checkout does not contain its large files, prepare them once with network access:

```powershell
npm run runtime:prepare
npm run runtime:verify
```

Transcription itself needs no local assets: run the app, paste an OpenRouter key in Settings, and dictate.

The same commands run in Terminal on macOS.

## Test matrix

```powershell
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run runtime:verify
```

Unit and integration tests cover settings recovery, history privacy, audio math and lifecycle, the OpenRouter transcription request and its failure reasons, runtime integrity, IPC validation, hotkeys, clipboard-before-paste output, startup, tray, window security, transcription orchestration, and widget synchronization. Electron end-to-end tests use an admitted non-packaged boundary with deterministic in-memory microphone, shortcut, clipboard, paste, startup, tray, and transcription adapters. They cover onboarding, registered-hotkey dictation, in-app paste, history on/off, theme and settings reload, hotkey conflict, microphone denial recovery, silence, paste fallback, hide-to-tray, single-instance behavior, and transcription failure. Widget visual tests verify ten 420x92 light/dark state images and transparent corners.

The deterministic boundary is rejected in packaged builds and accepts calls only from the trusted main renderer. It never logs transcript text or PCM.

Every push to `main` and every pull request against it runs typecheck, lint, `vitest run` and the third-party notices check on a Windows runner (`.github/workflows/ci.yml`). End-to-end tests, live provider suites and packaging stay local. See the [continuous integration guide](docs/ci.md) for what each step does and how to read a failed check.

## Build Windows artifacts

```powershell
npm run package:dir
npm run package:win
```

Artifacts are written to:

- `release/win-unpacked/Sotto.exe` — unpacked x64 application
- `release/Sotto Setup <version>.exe` — assisted, per-user x64 NSIS installer

Brand assets (`build/icon.png`, `build/icon.ico`, `build/installer-sidebar.bmp`) are generated from the SVG masters in `build/` with `node scripts/generate-brand-assets.mjs`.

The packaged `resources` directory contains `runtime/`, `README.md`, and `THIRD_PARTY_NOTICES.md`. Each packaging command automatically verifies the source runtime before packaging and verifies the packaged runtime, notices, bridge and worklet afterward.

## Build macOS artifacts

```bash
npm run package:dir:mac
npm run package:mac
```

Artifacts are written to:

- `release/mac-arm64/Sotto.app` — unpacked arm64 application bundle
- `release/Sotto-<version>-arm64.dmg` — arm64 disk image with an Applications shortcut

Both commands verify the source runtime before packaging and the packaged runtime, notices, bridge and worklet afterward, exactly like the Windows commands. After `npm install`, a fresh clone must run `npm run runtime:prepare` once to copy the runtime files from the installed ONNX Runtime package; this preparation step needs no network access.

The macOS icon is derived automatically from `build/icon.png` at packaging time; no `.icns` file is committed. The menu-bar template images (`resources/tray/sottoTemplate.png` and its `@2x` companion) come from the same `node scripts/generate-brand-assets.mjs` run as the Windows brand assets.

Builds are ad-hoc signed and not notarized, so anyone installing the disk image needs the macOS install steps above. Widget design captures (`npm run design:capture`) stay Windows-only; the committed reference images are captured on Windows.

## Troubleshooting

### Either platform

- **Shortcut conflict:** Choose another accelerator in Settings. Sotto keeps the last working shortcut if registration fails.
- **No speech detected:** Move closer to the microphone and confirm the level meter responds. Silence does not replace the clipboard or create history.
- **"Add your OpenRouter API key":** Transcription needs a key. Paste one under Settings → Transcription and press **Verify key**.
- **"OpenRouter rejected the API key":** The key is wrong, revoked, or out of credit. Check it at [openrouter.ai/keys](https://openrouter.ai/keys) and verify it again in Settings.
- **"Sotto could not reach OpenRouter":** Check the internet connection and any proxy or firewall, then dictate again. Nothing was lost except that recording.
- **AI cleanup not applied:** Check that AI cleanup is enabled and that the computer is online. When cleanup fails or times out, Sotto delivers the raw transcript instead of failing the dictation.
- **Window disappeared:** Sotto is probably hidden in the Windows notification area or the macOS menu bar. Open it from that icon or start Sotto again; the existing instance will be shown.

### Windows

- **Microphone denied:** Open Windows Settings → Privacy & security → Microphone, enable microphone access and desktop-app access, then retry.
- **No microphone found:** Connect or enable an input in Windows Settings → System → Sound, then select it in Sotto Settings.
- **Paste did not occur:** Paste manually with `Ctrl+V`; the transcript is already in the clipboard. Elevated and protected targets commonly reject automation.

### macOS

- **"Sotto is damaged and can't be opened":** This is Gatekeeper refusing an unsigned download, not a corrupted file. Use **System Settings → Privacy & Security → Open Anyway**, or run `xattr -dr com.apple.quarantine /Applications/Sotto.app`, then launch Sotto again.
- **Microphone denied:** Open System Settings → Privacy & Security → Microphone, allow Sotto, then retry.
- **Paste does nothing:** Sotto needs both System Settings → Privacy & Security → **Automation** (Sotto allowed to control System Events) and → **Accessibility**. Enable both, then dictate again; meanwhile the transcript is already in the clipboard, so `⌘V` works.
- **A permission prompt never reappears:** macOS remembers the denial. Reset the grants in Terminal and relaunch Sotto:

  ```bash
  tccutil reset Microphone com.sotto.desktop
  tccutil reset AppleEvents com.sotto.desktop
  tccutil reset Accessibility com.sotto.desktop
  ```

- **Sotto quits immediately after launching:** Check that the Mac has Apple silicon (Apple menu → About This Mac). Intel Macs are not supported and the arm64 build cannot run on them.

## License

MIT License
