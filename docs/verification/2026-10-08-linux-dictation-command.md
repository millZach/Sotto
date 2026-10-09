# Linux compositor dictation — issue 837

Checked on forge on October 8, 2026: Omarchy, Hyprland on Wayland, Electron 43.1.0, Node 24.21.0 and Sotto 0.1.33. This branch is stacked on `feat/linux-platform-profile` at `c08e9a9aa4189c43d9928a9db21a6763eb1db66d` (PR #848). The built main entry has SHA-256 `c8aeaf46d9508b4c0d0473b553bfc8f915e9a8e8bfd25ab956eba6d68fd4c110`.

## Choice and scope

The Unix socket is the selected transport. The command is `sotto dictation start|stop|toggle|cancel` in the packaged launcher layout, or `/absolute/checkout/apps/omarchy/sotto dictation start|stop|toggle|cancel` after building a checkout. Its tiny client runs with bundled Electron in Node mode, so packaged users need no separate Node. Main opens only `$XDG_RUNTIME_DIR/sotto/dictation.sock`; the folder is 0700, the socket 0600. It accepts four fixed words, bounds input and clients, refuses symlinks and non-sockets, leaves an active listener alone, recovers a stale socket and closes on quit. No text, audio or key crosses this command channel. No dependency or contacted host was added.

The existing preload command subscription routes to the dictation controller. That controller already ignores an unpaired stop and a repeated start, and remembers stop during microphone startup; push-to-talk adds no alternative recording lifecycle. Windows and macOS keep global toggle and Escape registration. Linux registers neither, keeps the saved hotkey for settings reset/rollback, and explains compositor bindings in Settings. Onboarding and Dictate name F9 and Super+Ctrl+X and still say to paste copied text. Escape inside Sotto and a compositor `cancel` command follow the existing cancellation rules.

The Omarchy snippet unbinds F9 and Super+Ctrl+X before binding Sotto. [Hyprland's unbind documentation](https://wiki.hypr.land/configuring/core/binds/#unbind) says it removes all prior occurrences; this includes Voxtype's F9 release binding. A Lua mock loaded forge's actual Voxtype defaults, then the snippet, and checked that all three became Sotto's start, release-stop and toggle. Voxtype stays installed. No live Hyprland file or binding changed. ADR-0062 on `origin/feat/linux-desktop-adr`, the map #833 and the owner's decision #836 govern this work. No window controls or chrome changed.

## Latency

Commands were run from an already-running, built checkout with a real microphone. The probe copied the Hyprland session environment from Quickshell, used inspector port 9341, and isolated configuration and runtime files inside this worktree's ignored `.cache/`. An absolute Wayland display and the session's PulseAudio socket preserved access to the real compositor and microphone despite the isolated runtime directory.

Each sample begins immediately before spawning the command and ends at the main process receiving the first accepted `listening` publication from the recorder. Both clocks use `process.hrtime.bigint()`. This includes process startup, command delivery and real microphone startup, rather than just socket acknowledgement. Ten runs per transport were interleaved; each session was cancelled between runs. The socket runs used the actual launcher. The second-instance trial launched a second Electron with checkout and argv, and used a temporary inspector-installed argv router to forward the same command over the same renderer channel, without raising the window. That router is measurement scaffolding only and is absent from the product and commit.

| Transport | Runs | Median | Worst |
| --- | --- | --- | --- |
| Unix socket, bundled Electron in Node mode | 10 | 89.048 ms | 92.236 ms |
| Electron single-instance lock and argv | 10 | 262.451 ms | 276.975 ms |

The socket's median was 2.95 times faster. Its worst sample was also lower than every single-instance sample.

Raw samples, in milliseconds:

```json
{
  "socket": [
    88.558,
    88.541,
    90.649,
    85.832,
    90.238,
    90.543,
    89.538,
    87.959,
    92.236,
    87.458
  ],
  "secondInstance": [
    276.975,
    260.705,
    270.148,
    260.271,
    261.605,
    268.149,
    263.296,
    264.305,
    258.79,
    261.136
  ]
}
```

## Gates

All Node commands used `mise exec node@24.21.0 --`. No two test suites in this worktree ran together.

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed, three TypeScript projects |
| `npm run lint` | Passed, no errors |
| `npm test -- --maxWorkers=2` | 8,964 passed in 611 files; 182 skipped in 50 files; zero failed; 530.33 seconds |
| `npm run notices:verify` | 174 components verified |
| `luac -p apps/omarchy/bindings.lua` | Passed |
| `npm run build` | Passed |
| Focused dictation tests | 136 passed in five files |
| Linux command and platform Playwright journeys | Two passed, one worker |
| Packaged-layout ASAR client check | Four verbs delivered; invalid command exited 2; closed listener exited 1 with guidance |

The full suite's canvas and optional OpenSlide warnings also appear in the base branch's verification note; neither failed a test. The Playwright journey drives first-run setup and keyboard completion, sends actual launcher commands to the running main process, checks all four controller routes, and verifies copied fixture text without a paste attempt. It checks welcome and final onboarding copy, Settings and Dictate in light/dark with reduced motion, at 1600×1000, 1280×800 and 820×560. Viewports are set in the renderer because Hyprland owns the native tiled bounds. It uses no screenshots.

Three existing cases in `tests/e2e/onboarding-microphone-step.spec.ts` failed on the locked desktop:

- `onboarding resolves the microphone step before continuing (successful test)`: `page.screenshot` timed out after 30 seconds.
- `onboarding resolves the microphone step before continuing (explicit skip)`: `page.screenshot` timed out after 30 seconds.
- `onboarding notices an ended microphone and allows retry`: the 30-second test deadline expired.

All three reproduce against a freshly built archive of unchanged base commit `c08e9a9`, kept inside `.cache/base`, with `SOTTO_E2E_MAIN_ENTRY` selecting its main bundle and the same Quickshell environment. That base bundle has SHA-256 `88ec5de7539f7f07bd2379ca588195be15471d71853e5f57a3f8c58037361d73`, matching the base verification note. The unchanged spec's SHA-256 is `ee0850ddb73acd9f6ce101dd0a51b6b4538ca3870dc251bb96f808dda110f8c8`. Both runs failed all three cases. This branch changes none of that spec's assertions, capture code or deadlines.

During development, focused checks caught Linux unregistering the saved unused shortcut, an empty parameterized argument fixture, and an overstrong replaced-endpoint cleanup assertion (Node's own server close unlinks its bound path). These were corrected; the listener still refuses non-socket endpoints and another active socket before binding. Typecheck also caught the wrong E2E configuration property name. The first new Playwright run hit the native resize helper's 20-pixel discrepancy; the final renderer viewport checks pass. Probe retries corrected harness startup waits for the inspector context and socket, and preserved the session's PulseAudio endpoint for real capture. None required a product workaround or a changed test deadline.

## Native check, verbatim

```text
Launched built checkout PID 2727360; inspector 9341; isolated XDG_CONFIG_HOME and XDG_RUNTIME_DIR.
Inspector PID matches the launched app: 2727360
{"ready":true,"platform":"linux","wayland":"/run/user/1000/wayland-1","session":"wayland","keyPresent":false}
Socket permissions: folder 700; socket 600
unpaired stop -> idle
start -> listening (real microphone)
{"linuxGlobalShortcutRegistered":false,"linuxEscapeRegistered":false}
second start -> listening; same listening transition: true
stop -> error (TRANSCRIPTION_UNCONFIGURED)
toggle -> listening
toggle -> error (TRANSCRIPTION_UNCONFIGURED)
cancel -> cancelled
Command-to-listening latency (ms): {"socket":{"runs":10,"medianMs":89.048,"worstMs":92.236},"secondInstance":{"runs":10,"medianMs":262.451,"worstMs":276.975}}
No OpenRouter key was provided. Real capture and command state transitions were reached; successful transcription and clipboard delivery were not reached.
Live Hyprland bindings were not changed. Physical key-down/key-up was not exercised while the screen was locked.
Operational events: []
Normal quit removed the dictation socket: true
Stopped by PID: 2727360, 2727364, 2727365, 2727367, 2727397, 2727399, 2727420, 2727430, 2727451, 2727459

```

The screen stayed locked. This establishes command-to-controller delivery, real capture, state transitions, socket permissions, skipped Linux global grabs and normal-quit cleanup. It does not establish successful real transcription or clipboard delivery without an OpenRouter key, physical key-down/key-up, screenshots, an installed Linux desktop package, or execution on Windows/macOS. The ASAR check establishes the documented packaged client layout with the real bundled Electron, rather than a released installer. Packaging/installing the launcher belongs to #841; Hyprland paste to #838; the Omarchy widget to #850; local Voxtype transcription to #845. The copied probe and its scratch scripts are intentionally uncommitted, as requested.
