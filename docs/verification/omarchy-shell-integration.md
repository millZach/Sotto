# Sotto and its Omarchy shell plugin together

October 11, 2026. [#850](https://github.com/millZach/Sotto/issues/850). Rerun on `fix/omarchy-owl-glyph` at `5ad3d0fc`, after the plugin's glyph became Sotto's owl (ADR-0064); the [plugin note](omarchy-shell-plugin.md#the-owl-close-up) has the owl close up. App source is unchanged. This rerun replaces the eight curated captures and the complete state/process evidence; the run before it, on `fix/omarchy-integration-proof-copy` from `2bcc127a`, showed the bar and wave. Both private buses, the nested shell's and the Electron journey's, now activate nothing, so no desktop portal starts on either. The first attempt of this rerun passed all eight steps and then failed its last check: the live `~/.local/state/omarchy/notifications` folder had changed. The live shell had moved a notification from "Forge computer-use", another agent working in the live session, into its history when its four seconds were up. Nothing of the proof's could reach the live bus, since every process it starts gets a bus address that leads nowhere. The second attempt, reported here, passed with all three live trees unchanged. The proof's kept-failure expectation now matches `keptFailureDetail.TRANSCRIPTION_FAILED` in `src/main/hotkeys/dictationStateFile.ts`.

**Sandbox.** The PR #889 hardening rerun shares setup and pre-start validation with the stand-in proof. HOME is generated from installed regular files; live config is never copied, and links are refused before copying or mutation. Rewriting or validating `shell.json` must succeed with `version: 1` and every excluded plugin in `disabledPlugins` before Quickshell starts. A manifest-derived allow-list retains only Sotto, the bar and an empty indicator marker; 35 installed plugins are excluded. All copied settings, including absolute output paths such as `syncDir`, are removed. TMPDIR, TMP and TEMP name a mode-0700 folder inside the private root. The fake-HOME linked-config, malformed JSON, unsupported version, failed-write and allow-list fixtures all pass.

**VERIFIED on forge:** the built, unpackaged Sotto 0.1.37, Electron 43.1.0, and the installed `sotto.dictation` plugin running together in the real Omarchy 4.0.4 shell, under Hyprland 0.56.2 and Quickshell 0.3.1. All eight requested steps passed. There are 26 actual state-file observations and 24 nested-output captures. Each of the eight curated images below was opened and inspected. Text and buttons fit; the centred top and upright left pills, loss notice, fixed output selection and returning Electron widget match the requested behaviour. Only the eight cited images and `proof.txt` are retained.

The microphone, local transcription and output effects use Sotto's existing development-only e2e boundary. Main's `transcription-turned-away-once` scenario fails the first transcription with `TranscriptionError('failed')` and accepts the next. Sotto's controller, kept recording, shell-state publisher, socket, checkout launcher, placement store, plugin folder watch, Quickshell service, bar and pill are real. No state file is seeded or edited by the proof. Dictation starts, stops, retries, discards, cancels and placement changes come exclusively from pointer presses and dragging in the plugin. App quit and SIGKILL are lifecycle operations from the harness; its Electron connection otherwise only observes windows and the scripted output.

This establishes the two sides' integration. It does not establish a physical microphone, real Parakeet decoding, actual Wayland clipboard delivery or automatic paste, a packaged release, physical displays or a physical mouse. Those effects are scripted here, as in the plumbing proof. The earlier plugin note retains its light, small-display and motion checks; this integration run uses Tokyo Night with nested animations disabled and adds no design baseline.

## Results

The state file is `$XDG_RUNTIME_DIR/sotto/dictation-state.json`. The harness checks every observation against exactly `version`, `pid`, `pidStart`, `dictation`, `state`, `since`, `updatedAt`, `detail`, `kept` and `edge`. It checks folder mode 0700 and file mode 0600, compares `pid` to the actual Electron main PID and `pidStart` to `/proc/<pid>/stat` field 22 after the last `)`, and refuses the fixture transcript in any state. Every new dictation has a new opaque identifier; Retry and an edge-only change keep that identifier. Idle carries null. The complete JSON observations and process evidence are in [proof.txt](../../artifacts/omarchy-shell-integration/proof.txt); the line numbers below identify each result's actual state.

| Step | Result | Capture | State-file observation in proof.txt |
| --- | --- | --- | --- |
| a | Installed with `--command` naming this checkout's actual `apps/omarchy/sotto`. Electron reports its widget hidden; Hyprland has no mapped Sotto Widget. The owl rests in the bar and there is no pill. | [a-idle.png](../../artifacts/omarchy-shell-integration/a-idle.png) | Line 26: `idle`, `dictation:null`, `edge:"top"`, PID 2660668, start 198007385. |
| b | A glyph click runs real `toggle`. The owl and timer turn the urgent colour, and the pill, led by the owl, has Stop and Cancel on focused output 1, 284×44 at 658,31, centred under the bar. The Electron widget remains unmapped. | [b-listening.png](../../artifacts/omarchy-shell-integration/b-listening.png) | Line 29: `listening`, a new non-null dictation, PID 2660668. |
| c | Stop produces `copied`, with actual detail `Copied — paste with Super+V`. The scripted clipboard equals the fixture and no paste was attempted; the text is omitted from the evidence. The shell pill expires after its copied hold while the published copied result remains. | [c-copied-expired.png](../../artifacts/omarchy-shell-integration/c-copied-expired.png), before and after expiry | Lines 34 and 37: `copied`, `kept:false`, same dictation as b. |
| d | Stop fails with `Could not transcribe. Recording kept.` The pill shows it word for word with Try again and Discard. One Try again succeeds, preserving the dictation identifier. After relaunching the same one-refusal fixture, another Stop fails and Discard clears the kept recording and pill. | [d-retry-discard.png](../../artifacts/omarchy-shell-integration/d-retry-discard.png), failure, retry success, second failure, discarded | Lines 47, 51, 61 and 65: `failed/true`, `copied/false`, `failed/true`, then `idle/false` with null dictation. |
| e | Dragging previews the left edge, then snaps upright at 5,371, 44×284. Real `place left` changes both the state and placement record v3. After quit and relaunch in the same profile, the next glyph click opens at that same edge. Upright Cancel also returns to idle. | [e-drag-restart.png](../../artifacts/omarchy-shell-integration/e-drag-restart.png), drag, snap, restarted pill | Line 72: `listening`, `edge:"left"`, identifier unchanged by place. Line 81: `listening`, `edge:"left"`, new main PID 2662122 and a new dictation. |
| f | A new dictation starts, then real main PID 2662122 is killed with SIGKILL. The stale file remains. The plugin replaces recording controls with `Sotto quit. This dictation was lost. Open Sotto to dictate again.` and Dismiss, on the original output. | [f-sotto-quit.png](../../artifacts/omarchy-shell-integration/f-sotto-quit.png) | Line 90: stale `listening`, PID 2662122, `pidStart:198009376`; line 91 records the kill. This JSON is evidence of the dead process, not an ongoing recording. |
| g | The pointer focuses output 2 and clicks its glyph. Only that output gets the pill. Moving the pointer back to output 1 changes Hyprland focus, while the same pill stays on output 2. | [g-two-outputs.png](../../artifacts/omarchy-shell-integration/g-two-outputs.png), output 1 then 2 in each row; before then after the move | Lines 97 and 100: unchanged `listening` and dictation, PID 2662633. Layer observations establish which output owns the pill. |
| h | The real uninstall script takes the glyph off the bar and removes the plugin folder. Sotto's Electron widget becomes visible and mapped during the existing dictation; neither output retains the shell pill. | [h-widget-returned.png](../../artifacts/omarchy-shell-integration/h-widget-returned.png) | Line 106: unchanged `listening`, PID 2662633, `edge:"left"`. |

The Electron fallback's position and border in h belong to the nested compositor: an Electron window cannot place itself on Wayland. This proof checks its return and mapping, not a new fallback placement design. The hardening rerun excludes Omarchy's background plugin because its selectors can launch theme commands. Captures now have a plain desktop; h waits for the actual Electron widget mapping and the shell pill's removal.

## Reproduce

Run from this checkout, without root:

```sh
mise exec node@24.21.0 -- npm ci
mise exec node@24.21.0 -- node node_modules/electron/install.js
mise exec node@24.21.0 -- npm run build
mise exec node@24.21.0 -- node --input-type=module -e "import { readFileSync } from 'node:fs'; import { verifyExternalDependencyInventories } from './scripts/release-external-dependencies.mjs'; verifyExternalDependencyInventories({ main: JSON.parse(readFileSync('out/main/external-dependencies.json','utf8')), preload: JSON.parse(readFileSync('out/preload/external-dependencies.json','utf8')) }, ['node-pty','zod','sherpa-onnx-node','electron']); console.log('allowlist check: PASS')"
mise exec node@24.21.0 -- node scripts/verify-omarchy-shell-sandbox.mjs
mise exec node@24.21.0 -- node scripts/verify-omarchy-shell-integration.mjs
```

The [script](../../scripts/verify-omarchy-shell-integration.mjs) reuses `owned-proof-processes.mjs` and the compiled `omarchy-nested-pointer.c` helper. It requires the existing Omarchy installation, Hyprland/hyprctl, Quickshell, grim, ImageMagick, a C compiler with Wayland client headers, D-Bus and user systemd. It refuses evidence destinations containing links. It generates the eight curated captures on every successful run, alongside ignored raw frames, and copies evidence only after process cleanup. `--curate` regenerates the curated images without launching anything while a fresh run's raw frames are still present. After inspection, remove `artifacts/omarchy-shell-integration/raw/` to retain only cited evidence.

## Isolation and cleanup

All app, shell and input scenes run together in session Hyprland B, with one HOME and one private runtime under a mode-0700 `/tmp/ssi-*` root outside the checkout. Sotto's existing e2e boundary uses its profile as the command runtime, so this same private runtime is also its test profile. Its other XDG folders and temporary files live under the private root too. Sotto starts minimised; Electron stays running while its main window is hidden, as it does for dictation from another app.

Sizing Hyprland A is only a host for B's two Wayland outputs. The locked live compositor chooses A's size; A floats B's outputs at exact 1600×1000 and 1280×800 sizes. No sizing, focus or input request reaches the live compositor. Both owned compositor identities are discovered by their actual PIDs, and the pointer refuses the live signature and Wayland socket taken from the live Quickshell process. Every long-lived process and its descendants stay in this run's systemd slice. Scope creation uses the user manager's runtime; the command switches to the private runtime after entering the scope. Nested shell IPC uses only that private runtime and its own D-Bus session. The Electron journey now also starts through `dbus-run-session`: it cannot use the live session bus or its desktop portal. Both private buses use the sandbox's session config with no service folders, so nothing on them can be activated, a desktop portal included. Every capture comes from `grim` on an owned nested output; the proof uses no desktopCapturer or file picker.

**Earlier sandbox defect, corrected before this rerun:** `bbe2b1ae`, Keep nested shell proofs away from live clipboard watchers. Omarchy's unrelated clipboard service starts with a global `pkill` matching clipboard watchers. The first integrated shell attempt loaded it, restarted the live shell's watchers and advanced the empty live `clipboard-images` folder's timestamp. No key or pointer input was sent to the live session, and live configuration files were not changed. The plugin branch carries the correction as `3fb8671e`. The current allow-list excludes clipboard and every other unrelated service in both proofs. Both final runs checked all three live configuration/state trees unchanged, including contents, file and directory identities, sizes and modification times.

Before this rerun, `dccd581f` also disabled the battery service, matching the stand-in verifier: that service can change the machine's power profile on a power-source change. It records the live shell's long-running processes by PID and start time and requires all six identities to remain alive and unchanged at cleanup. Clipboard was disabled before every nested shell launch. No new production plumbing or plugin defect was found. Main already carries the scripted retry fixture through PR #877. The Omarchy README now describes the installed plugin alongside the package and names when the Electron widget steps aside. No runtime dependency, provider contact, setting, permission, glossary term or ADR changed. The standards review checked privacy, Linux confinement, ownership and cleanup; the ticket review checked each owner decision and both addenda against the actual journey.

During hardening, a preliminary stand-in run exposed a recentered glyph hit box; the harness now asks the nested shell for its actual idle geometry. Another run failed the strengthened live-tree check during the live Agents service's ordinary 15-minute usage refresh. Those files were left untouched, and the checks were kept intact. Both final runs passed between live refreshes, with Agents disabled in each sandbox.

The owl rerun stopped sizing compositor PID 2659343, session compositor PID 2659365, nested shell launcher PID 2659649 and journey launcher PID 2660637, then the owned proof slice. Every recorded PID and cgroup was empty. Both owned Hyprland folders and `/tmp/ssi-Y5sjrR` were removed; the prior live instance was preserved. All three live trees and all six recorded shell process identities were unchanged. The private D-Bus sessions and their descendants were included in the proof slice's cleanup.

## Gates and review

The four local gates ran sequentially under `mise exec node@24.21.0`, with the complete suite capped at two workers:

| Gate | Result |
| --- | --- |
| Typecheck | PASS |
| Lint | PASS |
| Unit/integration | 769 files passed, 1 failed, 54 skipped (824 total); 9,563 tests passed, 11 failed, 192 skipped (9,766 total); 524.59 s |
| Notices | PASS, 189 components |
| Build | PASS |
| Full integration proof | PASS, 8 steps, 26 state observations, 24 raw frames; clean exit and cleanup |

All failures are in `tests/unit/main/owlUpdates.test.ts`. After stashing the proof-only changes, an untouched detached checkout of base/main `2bcc127a` reproduced the same 11 failures in that file (1 pass). The Windows NSIS fixture only accepts `latest.yml`/`owl.yml`; on Linux electron-updater requests `latest-linux.yml`. No fixture, test deadline or skip was changed. The failing cases are:

- Stable stays on latest.yml despite newer Owl and superseded stable releases.
- Only a newer Owl is offered past stable and superseded tags.
- No same-version offer or downgrade for `0.1.37-owl.20261011.2`, `0.1.37-owl.20261011.1`, `0.1.37-owl.20261010.99` and `0.1.36-owl.20261012.1` (four cases).
- Move to the next patch on Owl.
- Reject stable manifests with fallback off and on (two cases).
- Reject a manifest naming a different Owl tag.
- Refuse an overwrite of the selected Atom tag through the manifest tag field.

The current four-name built dependency allowlist is required before every push. The integrated script itself drives real Electron through Playwright and is the changed surface's end-to-end proof; app source is unchanged. No design baseline was regenerated.

The standards review checked privacy, Linux confinement, private D-Bus, owned input and cleanup. The request review checked the local failure sentence and all eight integration steps. No findings remain. No app source, runtime dependency, permission or provider contact changes.

## Windows CI repair

The first [Gates run](https://github.com/millZach/Sotto/actions/runs/38171077685) had 9,489 passes, 276 skips and one failure: `watcherLaunchProfiles.test.ts`, “uses only the durable current identity, corroborated by host, kind, project and provider”, at the final changed-host check. Its fixture saved a same-size identity in place; Windows can preserve every field in the cache's stat signature for such a fast write. Production publishes through AtomicJsonStore's fresh-file/rename path, which changes the file identity.

The fixture now uses that production publication path. A temporary deterministic reproduction held timestamp metadata unchanged: the in-place writer reproduced the same wrong admission, and the atomic writer passed with the changed-host refusal intact. All 12 permanent profile tests passed in the isolated two-worker rerun; typecheck and lint passed again. No production cache, identity check, assertion, deadline or skip changed. The latest Windows CI run is required before handoff.
