# Linux compositor dictation — issue 837

Checked on forge on October 8, 2026: Omarchy, Hyprland on Wayland, Electron 43.1.0, Node 24.21.0 and Sotto 0.1.33. The first review was stacked on `feat/linux-platform-profile` at `c08e9a9aa4189c43d9928a9db21a6763eb1db66d` (PR #848). The first review build’s main entry has SHA-256 `de43c69a2bc424cc5311099f15f74589c1f239775895fbd7aea117d8fbab2e32`.

## Choice and scope

The Unix socket is the selected transport. The command is `sotto dictation start|stop|toggle|cancel` in the packaged launcher layout, or `/absolute/checkout/apps/omarchy/sotto dictation start|stop|toggle|cancel` after building a checkout. Its tiny client runs with bundled Electron in Node mode, so packaged users need no separate Node. Main validates the absolute runtime folder and its ancestors before creating anything, requires current-UID ownership and mode 0700, and opens a private `dictation-<pid>-<random>.sock` inside its own 0700 folder. The socket is 0600. It publishes `$XDG_RUNTIME_DIR/sotto/dictation.sock` as an exclusive relative symlink. It accepts four fixed commands with an optional bounded event stamp, bounds input and clients, refuses linked folders and unrelated endpoints, leaves an active listener alone, recovers dead instances and closes on quit without unlinking a replacement public endpoint. No text, audio or key crosses this command channel. No dependency or contacted host was added.

The existing preload command subscription routes to the dictation controller. That controller already ignores an unpaired stop and a repeated start, and remembers stop during microphone startup; push-to-talk adds no alternative recording lifecycle. Windows and macOS keep global toggle and Escape registration. Linux registers neither, keeps the saved hotkey for settings reset/rollback, and explains compositor bindings in Settings. Onboarding and Dictate name F9 and Super+Ctrl+X and still say to paste copied text. Escape inside Sotto and a compositor `cancel` command follow the existing cancellation rules.

The Omarchy snippet unbinds F9 and Super+Ctrl+X before binding Sotto. [Hyprland's unbind documentation](https://wiki.hypr.land/configuring/core/binds/#unbind) says it removes all prior occurrences; this includes Voxtype's F9 release binding. A Lua mock loaded forge's actual Voxtype defaults, then the snippet, and checked that all three became Sotto's start, release-stop and toggle. Voxtype stays installed. No live Hyprland file or binding changed. ADR-0062 on `origin/feat/linux-desktop-adr`, the map #833 and the owner's decision #836 govern this work. No window controls or chrome changed.

## Threat model

Processes running as the same user are trusted. They can already drive Sotto, read its settings and control Hyprland through its own socket in `$XDG_RUNTIME_DIR/hypr/`. The dictation socket defends against other users and unsafe or misconfigured runtime folders. It does not defend against the user's own processes racing renames inside their private 0700 runtime folder. Path checks and identity rechecks apply within this boundary; descriptor-relative operations are not part of this change.

Re-review finding 2 is declined by the lead. An abstract Unix socket has no filesystem permissions, and Node cannot read peer credentials without a native module. It would therefore be less safe than the current 0600 socket in a 0700 folder. libuv's close-time unlink of the private listening pathname remains a known same-user race. Public-link check/unlink operations also assume the trusted same-user namespace. The replacement check proves that a public replacement completed before disposal survives, not protection against a rename during teardown.

## Review fixes

Repeated these checks after fixing the four should-fix findings on reviewed head `67d94043`:

1. `dictationRuntime.ts` uses `lstat` on every traversed path component, including ones before `..`, and requires a real runtime directory owned by the current UID with mode 0700. Both listener and client call it. Before recovery mutations and publication, the listener rechecks directory device, inode, owner and mode. Tests cover a foreign UID (simulated without root), 0755, 0770 and 01700 permissions, the runtime link itself, linked ancestors, and runtime or Sotto folders replaced during the asynchronous probe while retaining the same endpoint inode. These checks follow the [XDG runtime-directory requirements](https://specifications.freedesktop.org/basedir/latest/). The built app stayed ready with an invalid 0755 runtime, created no dictation folder, emitted only `[Sotto] native-dictation-command-start-failed`, and the client exited 1 with fixed guidance.
2. The listener binds its per-instance socket instead of the public endpoint that libuv would automatically unlink. Symlink publication is atomic and fails if another endpoint already exists. Normal quit removes the public link only while its identity and target remain this instance's. The restored test uses a separate Node process, checks the replacement inode and receives its reply after disposing Sotto. Tests also cover concurrent starts, live-instance refusal, dead private sockets and links, a missing private target, old direct sockets, and unrelated links. The real-app replacement check preserved another process's socket through normal quit and received `replacement` afterward.
3. The README and snippet comment now use `require("hypr.sotto-bindings")` for `~/.config/hypr/sotto-bindings.lua` and require defaults-first ordering. Read the installed `/usr/share/omarchy/default/hypr/bootstrap.lua` and `/usr/share/omarchy/config/hypr/hyprland.lua`: the first supplies `~/.config/?.lua` and reloads the `hypr` prefix; the second loads `default.hypr.omarchy` before `hypr.bindings`. A sandboxed Lua check ran those files with compositor calls mocked, resolved a copied snippet through the same module-path pattern, and checked exactly three Sotto bindings with Voxtype present and absent, including F9 release-stop. No live configuration was edited or reloaded.
4. `.gitattributes` now contains `apps/omarchy/sotto text eol=lf`. `git -c core.autocrlf=true cat-file --filters HEAD:apps/omarchy/sotto` retained all 23 LF lines, zero carriage returns and `#!/bin/sh\n`. `git ls-files -s apps/omarchy/sotto` still reports mode `100755`.

There is no asar-entry allow-list in `scripts/asar-entries.mjs` or `scripts/verify-packaged-resources.mjs`. The first normalizes, lists and reads entries. The second checks required files and a separate production-module allow-list, which the client does not change. `out/**/*` already includes the client and its shared chunk on Windows and macOS, and provenance verification inventories every `out/` file. The fresh build emitted `out/main/dictationClient.js` and `out/main/chunks/dictationRuntime-DCGnCP3_.js`; a real ASAR and bundled-Electron launcher check delivered all four commands, refused malformed input with exit 2, and refused unsafe runtime permissions and a closed listener with exit 1. No packaging-script change was needed. Native Windows/macOS packaging was not run on forge.

### Final re-review fixes

The second review started from `dd7b8840`. Runtime ancestors must now be owned by root or the current UID, and group- or other-writable ancestors must have the sticky bit. Unit tests simulate foreign-owned parents (including writable and sticky ones), refuse non-sticky writable parents owned by root or the current UID, and accept root-owned 0755 `/run/user/<uid>` ancestry and trusted sticky shared parents. This follows the requested StrictModes-style rule without adding descriptor-relative operations.

The server and client share `dictationEndpoint.ts`. Before connecting, the client requires a real current-UID-owned 0700 `sotto` folder, an owned direct socket or a link to a bare private socket basename, and a current-UID-owned socket target. Missing targets are allowed only during server recovery. Client tests exercise folder links, unsafe folder modes and ownership, foreign-owned direct sockets, public links and private targets, absolute and `../` targets, unrelated names, non-socket targets and missing targets. Successful link and direct-socket cases still send the command and accept its reply.

Startup also scans names matching `dictation-<pid>-<eight hex digits>.sock`. It removes only owned sockets that refuse a connection, rechecks directory and socket identity before removal, and checks that the socket is not the published target. Integration tests leave an unpublished private socket behind with an abruptly exited process, then prove the next start removes it and serves commands. Another case preserves a live unpublished listener, a regular file, a link and an unrelated dead socket. The first focused run found an unhandled connection reset in that new test listener; adding its socket error handler fixed the fixture. The repeated focused run passed all 47 tests with no unhandled errors. Final review also made the new UID and path fixtures portable to Windows, where `process.getuid` is absent, and required the private socket pattern to match the entire basename, including refusing a trailing newline. The final focused run passed 48 tests across three files. The full gate was restarted after these test fixes so its result covers the final files.

The diff was reviewed once against `AGENTS.md` and once against the final requested findings. Shared filesystem helpers do no filesystem work at import time. No runtime dependency, host, log content, permission policy, renderer surface, Windows/macOS shortcut behaviour or live Hyprland configuration changed. No unresolved finding remains within the agreed threat model; finding 2 is declined above. Native Windows/macOS execution remains outside this forge check.

## Latency

Commands were run from an already-running, built checkout with a real microphone. The probe copied the Hyprland session environment from Quickshell, used inspector port 9341, and isolated configuration and runtime files inside this worktree's ignored `.cache/`. An absolute Wayland display and the session's PulseAudio socket preserved access to the real compositor and microphone despite the isolated runtime directory.

Each sample begins immediately before spawning the command and ends at the main process receiving the first accepted `listening` publication from the recorder. Both clocks use `process.hrtime.bigint()`. This includes process startup, command delivery and real microphone startup, rather than just socket acknowledgement. Ten runs per transport were interleaved; each session was cancelled between runs. The socket runs used the actual launcher. The second-instance trial launched a second Electron with checkout and argv, and used a temporary inspector-installed argv router to forward the same command over the same renderer channel, without raising the window. That router is measurement scaffolding only and is absent from the product and commit.

| Transport | Runs | Median | Worst |
| --- | --- | --- | --- |
| Unix socket, bundled Electron in Node mode | 10 | 94.267 ms | 106.588 ms |
| Electron single-instance lock and argv | 10 | 284.114 ms | 291.174 ms |

The socket's median was 3.01 times faster. Its worst sample was also lower than every single-instance sample.

Raw samples, in milliseconds:

```json
{
  "socket": [
    95.031,
    88.594,
    95.52,
    106.588,
    97.349,
    93.613,
    93.006,
    90.079,
    93.146,
    94.92
  ],
  "secondInstance": [
    291.174,
    281.501,
    284.612,
    282.5,
    283.615,
    277.058,
    286.651,
    282.216,
    286.063,
    290.996
  ]
}
```

## First review gates

All Node commands used `mise exec node@24.21.0 --`. No two test suites in this worktree ran together.

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed, three TypeScript projects |
| `npm run lint` | Passed, no errors |
| `npm test -- --maxWorkers=2` | 8,978 passed in 611 files; 182 skipped in 50 files; zero failed; 498.82 seconds |
| `npm run notices:verify` | 174 components verified |
| `luac -p apps/omarchy/bindings.lua` | Passed |
| `npm run build` | Passed |
| Dictation socket integration cases | 21 passed within the full gate, including the 14 added review cases |
| Linux command and platform Playwright journeys | Two passed, one worker; 10.0 seconds |
| Packaged-layout ASAR client check | Four verbs delivered; invalid command exited 2; unsafe runtime and closed listener exited 1 with guidance |

The full suite's canvas and optional OpenSlide warnings also appear in the base branch's verification note; neither failed a test. The Playwright journey drives first-run setup and keyboard completion, sends actual launcher commands to the running main process, checks all four controller routes, and verifies copied fixture text without a paste attempt. It checks welcome and final onboarding copy, Settings and Dictate in light/dark with reduced motion, at 1600×1000, 1280×800 and 820×560. Viewports are set in the renderer because Hyprland owns the native tiled bounds. It uses no screenshots.

During the original implementation check, three existing cases in `tests/e2e/onboarding-microphone-step.spec.ts` failed on the locked desktop. These unchanged screenshot/microphone cases were not rerun for the review fixes; their retained branch/base evidence follows:

- `onboarding resolves the microphone step before continuing (successful test)`: `page.screenshot` timed out after 30 seconds.
- `onboarding resolves the microphone step before continuing (explicit skip)`: `page.screenshot` timed out after 30 seconds.
- `onboarding notices an ended microphone and allows retry`: the 30-second test deadline expired.

All three reproduce against a freshly built archive of unchanged base commit `c08e9a9`, kept inside `.cache/base`, with `SOTTO_E2E_MAIN_ENTRY` selecting its main bundle and the same Quickshell environment. That base bundle has SHA-256 `88ec5de7539f7f07bd2379ca588195be15471d71853e5f57a3f8c58037361d73`, matching the base verification note. The unchanged spec's SHA-256 is `ee0850ddb73acd9f6ce101dd0a51b6b4538ca3870dc251bb96f808dda110f8c8`. Both runs failed all three cases. This branch changes none of that spec's assertions, capture code or deadlines.

The original implementation dropped the replacement assertion after observing libuv unlinking the bound path on close. That was a defect, and the review fixes restore it against the separate public endpoint. The unsafe-runtime probe initially inspected operational events before native startup finished; its final run waits for the stable failure event before asserting the app remains ready. Test deadlines were not changed.

## First review native check, verbatim

```text
Launched built checkout PID 2827078; inspector 9341; isolated XDG_CONFIG_HOME and XDG_RUNTIME_DIR.
Inspector PID matches the launched app: 2827078
{"ready":true,"platform":"linux","wayland":"/run/user/1000/wayland-1","session":"wayland","keyPresent":false}
Socket permissions: runtime 700; folder 700; private socket 600; stable endpoint is a symlink: true
unpaired stop -> idle
start -> listening (real microphone)
{"linuxGlobalShortcutRegistered":false,"linuxEscapeRegistered":false}
second start -> listening; same listening transition: true
stop -> error (TRANSCRIPTION_UNCONFIGURED)
toggle -> listening
toggle -> error (TRANSCRIPTION_UNCONFIGURED)
cancel -> cancelled
Command-to-listening latency (ms): {"socket":{"runs":10,"medianMs":94.267,"worstMs":106.588},"secondInstance":{"runs":10,"medianMs":284.114,"worstMs":291.174}}
No OpenRouter key was provided. Real capture and command state transitions were reached; successful transcription and clipboard delivery were not reached.
Live Hyprland bindings were not changed. Physical key-down/key-up was not exercised while the screen was locked.
Operational events: []
Normal quit removed the private listening socket: true
Normal quit removed the stable endpoint: true
Stopped by PID: 2827078, 2827082, 2827083, 2827085, 2827115, 2827118, 2827137, 2827147, 2827171, 2827191

Launched built checkout PID 2828329; inspector 9341; isolated XDG_CONFIG_HOME and XDG_RUNTIME_DIR.
Inspector PID matches the launched app: 2828329
{"ready":true,"platform":"linux","wayland":"/run/user/1000/wayland-1","session":"wayland","keyPresent":false}
Socket permissions: runtime 700; folder 700; private socket 600; stable endpoint is a symlink: true
Public endpoint replaced by socket PID 2828458; inode 1687016
Normal quit removed the private listening socket: true
Normal quit preserved replacement socket: true
Replacement socket replied after Sotto quit: replacement
Stopped by PID: 2828329, 2828333, 2828334, 2828336, 2828367, 2828370, 2828388, 2828396, 2828421, 2828431, 2828442, 2828458

Launched built checkout PID 2828998; inspector 9341; isolated XDG_CONFIG_HOME and XDG_RUNTIME_DIR.
Inspector PID matches the launched app: 2828998
{"ready":true,"platform":"linux","wayland":"/run/user/1000/wayland-1","session":"wayland","keyPresent":false}
Unsafe runtime permissions: 755
Unsafe runtime created no dictation folder: true
Unsafe runtime client: exit 1; Dictation needs a private desktop runtime folder owned by you, with no folder links. Open Sotto in a desktop session that provides one, then try again.
Operational events: ["[Sotto] native-dictation-command-start-failed"]
Normal quit after refused listener: true
Stopped by PID: 2828998, 2829002, 2829003, 2829005, 2829036, 2829039, 2829059, 2829065, 2829096, 2829106, 2829107
```

The screen stayed locked. This establishes command-to-controller delivery, real capture, state transitions, socket permissions, skipped Linux global grabs, normal-quit cleanup, replacement survival and unsafe-runtime refusal while the app stays open. It does not establish successful real transcription or clipboard delivery without an OpenRouter key, physical key-down/key-up, screenshots, an installed Linux desktop package, or execution on Windows/macOS. The ASAR check establishes the documented packaged client layout with the real bundled Electron, rather than a released installer. Packaging/installing the launcher belongs to #841; Hyprland paste to #838; the Omarchy widget to #850; local Voxtype transcription to #845. The copied probe and its scratch scripts are intentionally uncommitted, as requested.

## Final review gates and native checks

All Node commands used `mise exec node@24.21.0 --`. Test suites ran one at a time. The final build's `out/main/index.js` SHA-256 is `c03193b78e6652560cab5fbab4a39f064345eef1060d35e8bff76cd1d9e542cd`.

| Check | Final result |
| --- | --- |
| `npm run typecheck` | Passed, three TypeScript projects |
| `npm run lint` | Passed, zero errors |
| `npm test -- --maxWorkers=2` | 9,005 passed in 613 files; 182 skipped in 50 files; zero failed; 488.71 seconds |
| `npm run notices:verify` | 174 components verified |
| `luac -p apps/omarchy/bindings.lua` | Passed, exit 0 |
| `npm run build` | Passed |
| Focused runtime, client and socket tests | 48 passed across three files: eight ancestry, 17 client and 23 socket integration cases |
| Linux command and platform Playwright journeys | Two passed, one worker; 5.7 seconds |

The final full suite emitted the existing canvas and optional OpenSlide warnings and had no failure. Playwright emitted the existing `NO_COLOR`/`FORCE_COLOR` warning and had no failure. The first hostile-link probe attempt hit `readlink`'s `EINVAL` because it reused the previous replacement check's leftover direct socket before the app finished recovery. That was a probe setup error. The probe now clears its own isolated runtime before launch; the repeated hostile-link run below passed. All nine PIDs from the failed attempt were also stopped. No product fix or test deadline change was needed for that setup error.

The normal native run used the actual launcher and real microphone. The replacement run again checked survival after normal quit. The hostile run pointed the public link at an absolute path to a separate listener, verified client exit 1 and zero connections there, left the hostile link intact, restored the original owned link, and reached listening and cancellation again. The inspector used port 9341, with fresh configuration under this worktree's `.cache/` and the Quickshell session environment. All 44 recorded native PIDs, including the failed probe attempt, were checked afterward: zero remained alive. No live Hyprland configuration or binding changed.

Final native output, verbatim:

```text
Launched built checkout PID 3025011; inspector 9341; isolated XDG_CONFIG_HOME and XDG_RUNTIME_DIR.
Inspector PID matches the launched app: 3025011
{"ready":true,"platform":"linux","wayland":"/run/user/1000/wayland-1","session":"wayland","keyPresent":false}
Socket permissions: runtime 700; folder 700; private socket 600; stable endpoint is a symlink: true
unpaired stop -> idle
start -> listening (real microphone)
{"linuxGlobalShortcutRegistered":false,"linuxEscapeRegistered":false}
second start -> listening; same listening transition: true
stop -> error (TRANSCRIPTION_UNCONFIGURED)
toggle -> listening
toggle -> error (TRANSCRIPTION_UNCONFIGURED)
cancel -> cancelled
No OpenRouter key was provided. Real capture and command state transitions were reached; successful transcription and clipboard delivery were not reached.
Live Hyprland bindings were not changed. Physical key-down/key-up was not exercised while the screen was locked.
Operational events: []
Normal quit removed the private listening socket: true
Normal quit removed the stable endpoint: true
Stopped by PID: 3025011, 3025016, 3025017, 3025019, 3025054, 3025056, 3025084, 3025100, 3025131, 3025149, 3025150

Launched built checkout PID 3026275; inspector 9341; isolated XDG_CONFIG_HOME and XDG_RUNTIME_DIR.
Inspector PID matches the launched app: 3026275
{"ready":true,"platform":"linux","wayland":"/run/user/1000/wayland-1","session":"wayland","keyPresent":false}
Socket permissions: runtime 700; folder 700; private socket 600; stable endpoint is a symlink: true
Public endpoint replaced by socket PID 3026477; inode 1716657
Normal quit removed the private listening socket: true
Normal quit preserved replacement socket: true
Replacement socket replied after Sotto quit: replacement
Stopped by PID: 3026275, 3026280, 3026281, 3026289, 3026332, 3026334, 3026366, 3026383, 3026419, 3026446, 3026447, 3026477

Launched built checkout PID 3028893; inspector 9341; isolated XDG_CONFIG_HOME and XDG_RUNTIME_DIR.
Inspector PID matches the launched app: 3028893
{"ready":true,"platform":"linux","wayland":"/run/user/1000/wayland-1","session":"wayland","keyPresent":false}
Socket permissions: runtime 700; folder 700; private socket 600; stable endpoint is a symlink: true
Hostile public link points to absolute socket: /home/zach/Projects/Sotto/.worktrees/dictation-command/.cache/z/dictation-123-1a2b3c4d.sock
Hostile endpoint client: exit 1; Sotto’s dictation socket is unavailable. Open Sotto in this desktop session, then try again.
Hostile listener received connections: 0
Hostile public link was left intact: true
Restored owned endpoint: start -> listening; cancel -> cancelled
Normal quit removed the private listening socket: true
Normal quit removed the stable endpoint: true
Stopped by PID: 3028893, 3028897, 3028898, 3028900, 3028932, 3028934, 3028951, 3028959, 3028983, 3028993, 3028994, 3029022
```

Real capture, all four command routes, normal cleanup, replacement preservation and hostile-link refusal are VERIFIED on the built forge checkout. Successful real transcription and clipboard delivery remain unavailable without an OpenRouter key. The screen stayed locked, so physical key-down/key-up and screenshots were not checked. Native Windows/macOS execution and a released Linux installer were not checked in this final round. The latency table and ASAR results above belong to the first review run; they were not remeasured here. Probe scripts and output stay uncommitted in `.cache/`, as requested.


## Bug-bot review fixes on PR 858

Checked the five findings against `3f6b0a62`, which already includes main, on the same forge Wayland session. This build is Sotto 0.1.34 with Node 24.21.0. Each finding has its own review-fix commit:

| Finding | Outcome | Commit |
| --- | --- | --- |
| `ptt-start-stop-reorder` | Fixed. The binding evaluates `date +%s%N` through an explicit `sh -c` before the launcher boots. The client carries epoch nanoseconds without rounding. Main remembers the newest accepted stamped stop or cancel, including an unpaired one, and suppresses an older or equal start. Renderer delivery is serialized through window recreation. Unstamped commands retain their behavior. | `47769312` |
| `client-fails-after-delivery` | Fixed. Main sends `accepted` and stops its idle timer after parsing a valid request. The client stops its own timer on that reply and waits for the final delivery result. A built client against a real socket with 1.5-second dispatch exits 0. Fragmented acceptance is also covered. | `6226b714` |
| `linux-widget-advertises-dead-shortcut` | Fixed on Linux: idle says “F9 to talk”; the listening announcement says “Release F9 or press Super+Ctrl+X to finish”. Tests preserve the Windows and macOS accelerator text. **Declined by the lead agent:** the X11 part is outside the supported desktop; Omarchy is Wayland-only, under ADR-0062 on #843. This is not an owner decision. | `9dc97c92` |
| `socket-path-length-tests` | Fixed. Socket integration runtimes use `mkdtempSync(join(tmpdir(), 'sotto-'))`, independent of checkout depth. Ownership, private permissions and cleanup still apply. | `c0fcd92e` |
| `test-rmsync-symlink-node24` | Fixed. The fixture removes the folder link with `unlinkSync`, leaving its target alone and avoiding Node 24 directory-removal differences. All checks here used the required Node 24.21.0; older Node releases were not run. | `aea398e4` |

Stamps must be no more than **5 seconds old** or **250 ms ahead** of main's clock when accepted. These inclusive bounds allow startup and small clock skew while preventing an old or far-future release from suppressing later holds. Invalid stamps do not advance the remembered release. Input is capped at 40 bytes for the optional stamp, with the existing 32-client cap and one-second pre-acceptance idle timeout. The same-user threat model, socket permissions, contacted hosts and production dependencies are unchanged.

The focused transport tests passed 76 cases; widget tests passed 88. They cover reversed stop/start and cancel/start, equal-stamp replay, normal and subsequent holds, a release received during pending delivery, a later-arriving older release, both time bounds, precision through the client, unstamped commands and slow delivery. A Lua-only mock loaded `/usr/share/omarchy/default/hypr/helpers.lua` and the snippet: three stamped shell commands, paired F9 release, and two prior chords unbound. The mock never calls the live compositor.

Final local gates, with every Node command under `mise exec node@24.21.0 --` and one test suite at a time:

| Check | Output/result |
| --- | --- |
| `npm run typecheck` | Exit 0, all three TypeScript projects; repeated after Playwright changes |
| `npm run lint` | Exit 0; repeated after Playwright changes |
| `npm test -- --maxWorkers=2` | Exit 0: 617 files passed, 50 skipped; 9,096 tests passed, 182 skipped; zero failures; 490.01 seconds |
| `npm run notices:verify` | `Verified 174 third-party notice components.` |
| `luac -p apps/omarchy/bindings.lua` | Exit 0, no output |
| `npm run build` | Exit 0; main, preload and renderer built |
| Playwright `linux-dictation-command.spec.ts` and `linux-platform-profile.spec.ts`, one worker | `2 passed (6.0s)`; includes stamped inversion, idle/listening widget copy, light/dark/reduced-motion layout checks at 1600×1000, 1280×800 and 820×560, and Linux copy-only output |

The full suite emitted the existing canvas and optional OpenSlide warnings. Playwright emitted the existing `NO_COLOR`/`FORCE_COLOR` warning. Neither suite failed. `app.spec.ts` was not run; `artifacts/review-quit-drain/before-quit.png` was not changed.

The two-axis diff review found the requested fixes implemented within the existing Linux command surface: no new host, dependency, permission authority, IPC channel, stylesheet or window chrome. Windows/macOS behavior stays on the existing branches. The X11 extension is the sole declined part, by the lead agent for the supported-desktop reason above. No unresolved in-scope finding remained.

The native probe launched the built checkout with Quickshell's session environment, an isolated configuration/runtime under this worktree, the real microphone and inspector port 9341. It observed accepted recording publications and actual socket arrival order. Each of the 20 rapid pairs kept a 0–15 ms key-event stamp gap; wrappers spawned at that gap and delayed one client boot by 200 ms to script a seeded random delivery order. Every pair settled with no active recording. The reordered unpaired release sent no renderer start at all. The normal stamped hold reached real listening and then stopped.

Two probe setup attempts failed before sending any commands: an early inspector evaluation returned “Promise was collected”, then the observer's injected newline needed escaping. The readiness wait and escaping were fixed in the uncommitted probe, and all 15 recorded PIDs from those attempts were stopped. The first successful run and the final run below each passed all 20 pairs. The final run checked idle widget text after an actual cancellation, once the widget had received its idle snapshot. All recorded native and Playwright processes were checked and stopped; none remained alive. No product change or repeated full suite was needed for these probe adjustments. Scripts and raw logs remain in this worktree's ignored `.cache/`.

Final native evidence, verbatim:

```text
Launched built checkout PID 3377704; inspector 9341; isolated XDG_CONFIG_HOME and XDG_RUNTIME_DIR.
Build main SHA-256: a44f06c35afaec703b9b9b6556015cccd36049b50ee6e543c69b864f11cc53f3
Inspector PID matches the launched app: 3377704
{"ready":true,"version":"0.1.34","platform":"linux","wayland":"/run/user/1000/wayland-1","session":"wayland","keyPresent":false}
Socket permissions: runtime 700; folder 700; private socket 600; stable endpoint is a symlink: true
unpaired stop -> idle
stamped stop, then start stamped 15 ms earlier -> idle; renderer start deliveries: 0; listening transitions: 0
start -> listening (real microphone)
Linux widget listening hint: Listening. Release F9 or press Super+Ctrl+X to finish
stop -> error (TRANSCRIPTION_UNCONFIGURED)
toggle -> listening
toggle -> error (TRANSCRIPTION_UNCONFIGURED)
cancel -> cancelled
Linux widget idle hint: F9 to talk
normal stamped hold -> listening, then error (TRANSCRIPTION_UNCONFIGURED); recording: false
20 rapid stamped pairs; event gaps (ms): 0, 15, 4, 3, 2, 15, 1, 12, 14, 1, 9, 7, 7, 11, 3, 4, 8, 14, 15, 8
Random delivery order (seed 858): start first 9; stop first 11; pairs ending with recording 0/20
Final recording: false; final status: error
No OpenRouter key was provided. Real capture and command state transitions were reached; successful transcription and clipboard delivery were not reached.
Live Hyprland bindings were not changed. Physical key-down/key-up was not exercised while the screen was locked.
Operational events: []
Client processes exited: 51/51
Stopped app and command helper processes by PID: 3377704, 3377708, 3377709, 3377711, 3377749, 3377751, 3377784, 3377794, 3377816, 3377826, 3377827, 3378030, 3378059, 3378083, 3378107, 3378142, 3378173, 3378201, 3378229, 3378256, 3378280, 3378322, 3378350, 3378378, 3378417, 3378445, 3378476, 3378503, 3378545, 3378572, 3378596
Recorded processes still alive: 0
```

VERIFIED: real microphone capture, all four commands, normal stamped holding, reordered release suppression, randomized rapid pairs, and the corrected Linux widget text on the built forge checkout. Successful real transcription and clipboard delivery could not be reached without an OpenRouter key. Physical key events were not exercised while the screen was locked; no live Hyprland file or binding changed. Native Windows/macOS execution and a released Linux installer were not checked in this round. PR 858 remains open and its review threads remain unresolved.
