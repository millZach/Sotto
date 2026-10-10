# Sotto and its Omarchy shell plugin together

October 9, 2026. [#850](https://github.com/millZach/Sotto/issues/850), including both version-1 contract addenda. Sandbox hardening for PR #889 on `feat/linux-omarchy-shell-plugin`, based on `b47d2e27`. The proof records HEAD `c4e1f4ad` with the final allow-list changes in the working tree; Sotto's app source is unchanged. Merge commit `39d97202` brought in main, including PR #877's real Sotto plumbing, and `e7fbd222` brought in the repeatable integration proof. This rerun replaces all eight curated captures and the complete state/process evidence.

**Sandbox.** The PR #889 hardening rerun shares setup and pre-start validation with the stand-in proof. HOME is generated from installed regular files; live config is never copied, and links are refused before copying or mutation. Rewriting or validating `shell.json` must succeed with `version: 1` and every excluded plugin in `disabledPlugins` before Quickshell starts. A manifest-derived allow-list retains only Sotto, the bar and an empty indicator marker; 35 installed plugins are excluded. All copied settings, including absolute output paths such as `syncDir`, are removed. TMPDIR, TMP and TEMP name a mode-0700 folder inside the private root. The fake-HOME linked-config, malformed JSON, unsupported version, failed-write and allow-list fixtures all pass.

**VERIFIED on forge:** the built, unpackaged Sotto 0.1.34, Electron 43.1.0, and the installed `sotto.dictation` plugin running together in the real Omarchy 4.0.4 shell, under Hyprland 0.56.2 and Quickshell 0.3.1. All eight requested steps passed. There are 26 actual state-file observations and 24 nested-output captures. All 24 raw frames were inspected in labelled contact sheets, and each of the eight curated images below was opened at its original resolution. Text and buttons fit; the centred top and upright left pills, loss notice, fixed output selection and returning Electron widget match the requested behaviour. Only the eight cited images and `proof.txt` are retained.

The microphone, transcription service and output effects use Sotto's existing development-only e2e boundary. Main's `transcription-turned-away-once` scenario refuses the first request with the existing rate-limit error and accepts the next. Sotto's controller, kept recording, shell-state publisher, socket, checkout launcher, placement store, plugin folder watch, Quickshell service, bar and pill are real. No state file is seeded or edited by the proof. Dictation starts, stops, retries, discards, cancels and placement changes come exclusively from pointer presses and dragging in the plugin. App quit and SIGKILL are lifecycle operations from the harness; its Electron connection otherwise only observes windows and the scripted output.

This establishes the two sides' integration. It does not establish a physical microphone, a paid transcription provider, actual Wayland clipboard delivery or automatic paste, a packaged release, physical displays or a physical mouse. Those effects are scripted here, as in the plumbing proof. The earlier plugin note retains its light, small-display and motion checks; this integration run uses Tokyo Night with nested animations disabled and adds no design baseline.

## Results

The state file is `$XDG_RUNTIME_DIR/sotto/dictation-state.json`. The harness checks every observation against exactly `version`, `pid`, `pidStart`, `dictation`, `state`, `since`, `updatedAt`, `detail`, `kept` and `edge`. It checks folder mode 0700 and file mode 0600, compares `pid` to the actual Electron main PID and `pidStart` to `/proc/<pid>/stat` field 22 after the last `)`, and refuses the fixture transcript in any state. Every new dictation has a new opaque identifier; Retry and an edge-only change keep that identifier. Idle carries null. The complete JSON observations and process evidence are in [proof.txt](../../artifacts/omarchy-shell-integration/proof.txt); the line numbers below identify each result's actual state.

| Step | Result | Capture | State-file observation in proof.txt |
| --- | --- | --- | --- |
| a | Installed with `--command` naming this checkout's actual `apps/omarchy/sotto`. Electron reports its widget hidden; Hyprland has no mapped Sotto Widget. The glyph rests and there is no pill. | [a-idle.png](../../artifacts/omarchy-shell-integration/a-idle.png) | Line 26: `idle`, `dictation:null`, `edge:"top"`, PID 2620659, start 179152225. |
| b | A glyph click runs real `toggle`. The pill has Stop and Cancel on focused output 1, 284×44 at 658,31, centred under the bar. The Electron widget remains unmapped. | [b-listening.png](../../artifacts/omarchy-shell-integration/b-listening.png) | Line 29: `listening`, a new non-null dictation, PID 2620659. |
| c | Stop produces `copied`, with actual detail `Copied — paste with Super+V`. The scripted clipboard equals the fixture and no paste was attempted; the text is omitted from the evidence. The shell pill expires after its copied hold while the published copied result remains. | [c-copied-expired.png](../../artifacts/omarchy-shell-integration/c-copied-expired.png), before and after expiry | Lines 34 and 37: `copied`, `kept:false`, same dictation as b. |
| d | Stop fails with `The transcription service is busy. Recording kept.` The pill shows it word for word with Try again and Discard. One Try again succeeds, preserving the dictation identifier. After relaunching the same one-refusal fixture, another Stop fails and Discard clears the kept recording and pill. | [d-retry-discard.png](../../artifacts/omarchy-shell-integration/d-retry-discard.png), failure, retry success, second failure, discarded | Lines 47, 51, 61 and 65: `failed/true`, `copied/false`, `failed/true`, then `idle/false` with null dictation. |
| e | Dragging previews the left edge, then snaps upright at 5,371, 44×284. Real `place left` changes both the state and placement record v3. After quit and relaunch in the same profile, the next glyph click opens at that same edge. Upright Cancel also returns to idle. | [e-drag-restart.png](../../artifacts/omarchy-shell-integration/e-drag-restart.png), drag, snap, restarted pill | Line 72: `listening`, `edge:"left"`, identifier unchanged by place. Line 81: `listening`, `edge:"left"`, new main PID 2621356 and a new dictation. |
| f | A new dictation starts, then real main PID 2621356 is killed with SIGKILL. The stale file remains. The plugin replaces recording controls with `Sotto quit. This dictation was lost. Open Sotto to dictate again.` and Dismiss, on the original output. | [f-sotto-quit.png](../../artifacts/omarchy-shell-integration/f-sotto-quit.png) | Line 90: stale `listening`, PID 2621356, `pidStart:179154205`; line 91 records the kill. This JSON is evidence of the dead process, not an ongoing recording. |
| g | The pointer focuses output 2 and clicks its glyph. Only that output gets the pill. Moving the pointer back to output 1 changes Hyprland focus, while the same pill stays on output 2. | [g-two-outputs.png](../../artifacts/omarchy-shell-integration/g-two-outputs.png), output 1 then 2 in each row; before then after the move | Lines 97 and 100: unchanged `listening` and dictation, PID 2621575. Layer observations establish which output owns the pill. |
| h | The real uninstall script takes the glyph off the bar and removes the plugin folder. Sotto's Electron widget becomes visible and mapped during the existing dictation; neither output retains the shell pill. | [h-widget-returned.png](../../artifacts/omarchy-shell-integration/h-widget-returned.png) | Line 106: unchanged `listening`, PID 2621575, `edge:"left"`. |

The Electron fallback's position and border in h belong to the nested compositor: an Electron window cannot place itself on Wayland. This proof checks its return and mapping, not a new fallback placement design. The hardening rerun excludes Omarchy's background plugin because its selectors can launch theme commands. Captures now have a plain desktop; h waits for the actual Electron widget mapping and the shell pill's removal.

## Reproduce

Run from this checkout, without root:

```sh
mise exec node@24.21.0 -- npm ci
mise exec node@24.21.0 -- node node_modules/electron/install.js
mise exec node@24.21.0 -- npm run runtime:prepare
mise exec node@24.21.0 -- npm run build
mise exec node@24.21.0 -- node --input-type=module -e "import { readFileSync } from 'node:fs'; import { verifyExternalDependencyInventories } from './scripts/release-external-dependencies.mjs'; verifyExternalDependencyInventories({ main: JSON.parse(readFileSync('out/main/external-dependencies.json','utf8')), preload: JSON.parse(readFileSync('out/preload/external-dependencies.json','utf8')) }, ['node-pty','zod','electron']); console.log('allowlist check: PASS')"
mise exec node@24.21.0 -- node scripts/verify-omarchy-shell-sandbox.mjs
mise exec node@24.21.0 -- node scripts/verify-omarchy-shell-integration.mjs
```

The [script](../../scripts/verify-omarchy-shell-integration.mjs) reuses `owned-proof-processes.mjs` and the compiled `omarchy-nested-pointer.c` helper. It requires the existing Omarchy installation, Hyprland/hyprctl, Quickshell, grim, ImageMagick, a C compiler with Wayland client headers, D-Bus and user systemd. It refuses evidence destinations containing links. It generates the eight curated captures on every successful run, alongside ignored raw frames, and copies evidence only after process cleanup. `--curate` regenerates the curated images without launching anything while a fresh run's raw frames are still present. After inspection, remove `artifacts/omarchy-shell-integration/raw/` to retain only cited evidence.

## Isolation and cleanup

All app, shell and input scenes run together in session Hyprland B, with one HOME and one private runtime under a mode-0700 `/tmp/ssi-*` root outside the checkout. Sotto's existing e2e boundary uses its profile as the command runtime, so this same private runtime is also its test profile. Its other XDG folders and temporary files live under the private root too. Sotto starts minimised; Electron stays running while its main window is hidden, as it does for dictation from another app.

Sizing Hyprland A is only a host for B's two Wayland outputs. The locked live compositor chooses A's size; A floats B's outputs at exact 1600×1000 and 1280×800 sizes. No sizing, focus or input request reaches the live compositor. Both owned compositor identities are discovered by their actual PIDs, and the pointer refuses the live signature and Wayland socket taken from the live Quickshell process. Every long-lived process and its descendants stay in this run's systemd slice. Scope creation uses the user manager's runtime; the command switches to the private runtime after entering the scope. Nested shell IPC uses only that private runtime and its own D-Bus session.

**Earlier sandbox defect, corrected before this rerun:** `bbe2b1ae`, Keep nested shell proofs away from live clipboard watchers. Omarchy's unrelated clipboard service starts with a global `pkill` matching clipboard watchers. The first integrated shell attempt loaded it, restarted the live shell's watchers and advanced the empty live `clipboard-images` folder's timestamp. No key or pointer input was sent to the live session, and live configuration files were not changed. The plugin branch carries the correction as `3fb8671e`. The current allow-list excludes clipboard and every other unrelated service in both proofs. Both final runs checked all three live configuration/state trees unchanged, including contents, file and directory identities, sizes and modification times.

Before this rerun, `dccd581f` also disabled the battery service, matching the stand-in verifier: that service can change the machine's power profile on a power-source change. It records the live shell's long-running processes by PID and start time and requires all six identities to remain alive and unchanged at cleanup. Clipboard was disabled before every nested shell launch. No new production plumbing or plugin defect was found. Main already carries the scripted retry fixture through PR #877. The Omarchy README now describes the installed plugin alongside the package and names when the Electron widget steps aside. No runtime dependency, provider contact, setting, permission, glossary term or ADR changed. The standards review checked privacy, Linux confinement, ownership and cleanup; the ticket review checked each owner decision and both addenda against the actual journey.

During hardening, a preliminary stand-in run exposed a recentered glyph hit box; the harness now asks the nested shell for its actual idle geometry. Another run failed the strengthened live-tree check during the live Agents service's ordinary 15-minute usage refresh. Those files were left untouched, and the checks were kept intact. Both final runs passed between live refreshes, with Agents disabled in each sandbox.

The rerun stopped sizing compositor PID 2619362, session compositor PID 2619377, nested shell PID 2619635 and journey PID 2620644, along with all descendants, then removed only the owned compositor folders. [proof.txt](../../artifacts/omarchy-shell-integration/proof.txt) ends with:

```text
Recorded PIDs still running: []
Proof cgroup processes after cleanup: []
Owned processes still running: []
Prior Hyprland instances preserved: ["efb50993780079460b0cbed1363e2166a2de1d9f_1789793874_889692923"]
Live /home/zach/.config/omarchy unchanged
Live /home/zach/.config/hypr unchanged
Live /home/zach/.local/state/omarchy unchanged
Live shell long-running process identities unchanged: 6
Temporary root removed: /tmp/ssi-VhlOVj
```

## Installed shell audit

Read-only search of `/usr/share/omarchy/shell` covered process commands, FileView writes, absolute paths, `/tmp`, `/run`, `pkill`, `killall`, `systemctl --user` and `hyprctl`, then followed the relevant installed command helpers. Updates starts `omarchy-update-available`, whose `checkupdates` uses `${TMPDIR:-/tmp}/checkup-db-${UID}` and removes its lock on exit. Agents can write a usage snapshot to absolute `syncDir`. Clipboard starts a global watcher `pkill`; battery/power and night light can change system settings. Reminder indicators call a helper that reads or stops user-systemd timers, with runtime files falling back to `/tmp`. Disk-speedtest accepts an output folder and kills worker children. Menu and image-picker write caller-supplied selection/done paths; background selectors invoke theme commands and a bare `hyprctl reload`. The clock can launch a system timezone menu. Workspaces, keyboard-layout and monitor controls also have bare `hyprctl` actions; network, audio, Dropbox and Tailscale can act globally. Every such plugin is excluded, and the empty indicator marker loads none of its built-in children. No `killall` was found in the shell tree. Core `Commons/Style.qml` still reads two `hyprctl getoption` values; both calls inherit the proved nested signature and runtime, so they address only the owned compositor. The bar's transparency helper stays off. No installed files were changed.

## Gates

| Gate | Result |
| --- | --- |
| `npm run typecheck` | PASS, all three TypeScript projects |
| `npm run lint` | PASS, zero errors or warnings |
| `npm test -- --maxWorkers=2` | PASS, 734 files and 9,506 tests; 51 files and 182 tests skipped (785 files, 9,688 tests total); 512.44 s |
| `npm run notices:verify` | PASS, 174 components |
| `npm run build` | PASS |
| Built main/preload dependency allowlist | `allowlist check: PASS` |
| Integrated built-app journey | PASS, eight steps, 26 state observations, 24 raw frames |
| Stand-in plugin journey | PASS, 101 checks, 98 raw frames |
| Dry sandbox fixtures | PASS, five groups; links, malformed JSON, unsupported version, failed rewrite, exclusions and private temporary storage |

The gates ran sequentially under `mise exec node@24.21.0`, with the complete suite capped at two workers. All four gates passed on their first run. The suite emitted jsdom canvas notices and an optional system libvips OpenSlide-loader warning; neither caused a failed test. No test deadlines, worker limits or skip conditions changed. The final gate-results edit is documentation only.

The standards review checked the final diff for privacy, Linux confinement, regular-file writes, nested input and owned cleanup. The request review checked all three sandbox findings in both entry points and the shared helper against the fixtures and final proof evidence. No findings remain. App source, dependencies, permissions and provider contacts did not change.
