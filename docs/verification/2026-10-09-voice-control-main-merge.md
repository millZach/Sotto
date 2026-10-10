# Bring voice-control removal up to date with main

Test citations use the current split files. Recorded counts and outcomes are from the original runs.

October 9, 2026. Local merge of `origin/main` at `9d6eff099a46a9d1dbd1a8570e90f385719b50cb` into `feat/remove-voice-control`, whose previous tip was `006442f7b0e14f7a6cfd244faccbda89c785f770`. No push or release.

## Acceptance checks

- Main's owl mark, Linux dictation and desktop profile, Claude Code naming, explicit babysitting, nine-step first-run setup and four-stop Threads tour survive.
- Dictation is the only listener. Reply speech, wake code, Agents room, orb, Manage, assignments, attention and supervision remain removed.
- Production dependencies are exactly `node-pty` and `zod`; main's package versions and app version 0.1.34 remain.
- Removal is [ADR-0066](../adr/0066-remove-voice-control-and-thread-management.md): main already occupied 0062 (Linux), 0063 (setup) and 0064 (owl).

## Main additions that met the removal

Main's `speech.ts` Linux-unavailable branch and its new `agentSpeech.test.ts` are deleted with the speech engine. Provider naming and normalization survive in `threadFacts.ts` and the transcript rather than the removed `AgentRoom`. Linux keeps `dictationClient`, clipboard handling, the tray and the widget's F9 hint; it gains no wake worker or reply voice.

First-run setup remains all nine steps; main introduced no voice or Agents-room step to delete. The coding-agent step discovers native clients, and setup ends on Threads with all four tour stops. The OpenRouter key description loses Kokoro. Main's test helpers are retained; obsolete fixture voice/assignment fields and the new babysitting test's `speak` config patch are removed. The branding test follows the owl in the Threads sidebar and the idle dictation sliver.

Linux packaging's new CI job survives. It verifies the remaining packaged assets with `assets:verify` instead of rebuilding the removed ONNX runtimes. The Linux ADR records that amendment; the setup ADR records the removal boundary.

## Verification

The final run completed in the required order, with exit code 0 for every command:

| Command | Real output / result |
| --- | --- |
| `npm run typecheck` | tsc --noEmit: passed |
| `npm run lint` | eslint .: passed |
| `npm test -- --maxWorkers=2` | Test Files 604 passed \| 51 skipped (655); Tests 8620 passed \| 222 skipped (8842); Duration 905.14s |
| `npm run notices:verify` | Verified 155 third-party notice components. |
| `npm run build` | ✓ built in 10.25s |
| Requested ten-spec Playwright run |   19 passed (1.2m) |
| Additional setup/onboarding, branding and babysitting Playwright run |   27 passed (2.1m) |
| `node scripts/verify-design-captures.mjs` | Verified 144 exact deterministic design-review tuples. |

The additional run sets `SOTTO_THEME_BRANDING_EVIDENCE=1`, so both branding cases run rather than skip. Exact commands and retained results are in [gates.json](../../artifacts/voice-control-removal/merged-setup/gates.json). The final unit suite took 905.14 seconds. No final gate failed.

Setup commits `f6f68784b`, `956125abf`, `986848546`, `75a8807f6` and the capture fixes touched these e2e specs: `agentControl`, `agentSetup`, `agents`, `app`, `crossing`, `design-capture`, `onboarding-microphone-step` and `widget-topmost`. All are included in the required run, the additional setup run or design capture. The additional run also checks main's babysitting and the gated live theme-branding journey.

`node tools/verify-removal-setup.mjs` printed:

```text
Passed setup and all tour stops: 1600x1000-light
Passed setup and all tour stops: 1280x800-dark
Passed setup and all tour stops: 820x560-dark
```

That retained lever runs the built Electron app, checks nine setup steps, four tour stops, keyboard focus, viewport bounds and page errors, with reduced motion. Inspected captures:

- [Coding-agent step at 820x560, dark](../../artifacts/voice-control-removal/merged-setup/agents-820x560-dark.png).
- [Threads tour at 1280x800, dark](../../artifacts/voice-control-removal/merged-setup/tour-1280x800-dark.png).
- [Threads tour at 1600x1000, light](../../artifacts/voice-control-removal/merged-setup/tour-1600x1000-light.png).

## Conflict resolutions

All 74 original conflicts are listed once. Baseline names below are under `artifacts/design/app-review/baseline/`.

| File | Resolution |
| --- | --- |
| `CONTEXT.md` | Keep main's first-run setup, owl, Linux and other glossary additions; describe only Memory and setup under the strip and retain the removal boundary. |
| `agents-attention.png` | Keep deleted; retired voice/Agents surface. |
| `agents-listening.png` | Keep deleted; retired voice/Agents surface. |
| `agents-room-light.png` | Keep deleted; retired voice/Agents surface. |
| `agents-room.png` | Keep deleted; retired voice/Agents surface. |
| `agents-session.png` | Keep deleted; retired voice/Agents surface. |
| `agents-wake.png` | Keep deleted; retired voice/Agents surface. |
| `appearance-system-dark.png` | Replace retired orb preview with main owl mark. Keep recapture. |
| `appearance-system-light.png` | Replace retired orb preview with main owl mark. Keep recapture. |
| `dictate-listening-light.png` | Remove Agents from the Dictate/Threads switch and focus order. Keep recapture. |
| `dictate-listening.png` | Remove Agents from the Dictate/Threads switch and focus order. Keep recapture. |
| `dictate-pasted-light.png` | Remove Agents from the Dictate/Threads switch and focus order. Keep recapture. |
| `dictate-pasted.png` | Remove Agents from the Dictate/Threads switch and focus order. Keep recapture. |
| `dictate-ready-light.png` | Remove Agents from the Dictate/Threads switch and focus order. Keep recapture. |
| `dictate-ready.png` | Remove Agents from the Dictate/Threads switch and focus order. Keep recapture. |
| `focus-navigation-light.png` | Remove Agents from the Dictate/Threads switch and focus order. Keep recapture. |
| `focus-navigation.png` | Remove Agents from the Dictate/Threads switch and focus order. Keep recapture. |
| `focus-switch-tab-light.png` | Remove Agents from the Dictate/Threads switch and focus order. Keep recapture. |
| `focus-switch-tab.png` | Remove Agents from the Dictate/Threads switch and focus order. Keep recapture. |
| `help-light.png` | Keep main's bytes; no removal pixel difference. |
| `help.png` | Keep main's bytes; no removal pixel difference. |
| `onboarding-step-3-openrouter-light.png` | Keep deleted; main moved the OpenRouter step from 3 to 4. |
| `onboarding-step-3-openrouter.png` | Keep deleted; main moved the OpenRouter step from 3 to 4. |
| `scale-100-help.png` | Keep main's bytes; no removal pixel difference. |
| `scale-100-onboarding.png` | Remove Kokoro from OpenRouter key wording. Keep recapture. |
| `scale-125-dictate-light.png` | Keep main's bytes; no removal pixel difference. |
| `scale-125-dictate.png` | Keep main's bytes; no removal pixel difference. |
| `scale-125-help.png` | Keep main's bytes; no removal pixel difference. |
| `scale-150-help.png` | Keep main's bytes; no removal pixel difference. |
| `scale-200-help.png` | Keep main's bytes; no removal pixel difference. |
| `scale-200-onboarding.png` | Remove Kokoro from OpenRouter key wording. Keep recapture. |
| `settings-agents.png` | Remove reasoning account and automatic follow-up limit. Keep recapture. |
| `settings-appearance-light.png` | Replace retired orb preview with main owl mark. Keep recapture. |
| `settings-appearance.png` | Replace retired orb preview with main owl mark. Keep recapture. |
| `settings-key-verified.png` | Remove Kokoro from OpenRouter key wording. Keep recapture. |
| `threads-new-thread-chooser-dark.png` | Streaming WAV stall fixture is failed, not stopped by Sotto; retain failed status dot and label. Keep recapture. |
| `threads-new-thread-chooser-light.png` | Streaming WAV stall fixture is failed, not stopped by Sotto; retain failed status dot and label. Keep recapture. |
| `threads-open-running-light.png` | Streaming WAV stall fixture is failed, not stopped by Sotto; retain failed status dot and label. Keep recapture. |
| `threads-open-running.png` | Streaming WAV stall fixture is failed, not stopped by Sotto; retain failed status dot and label. Keep recapture. |
| `threads-populated-light.png` | Streaming WAV stall fixture is failed, not stopped by Sotto; retain failed status dot and label. Keep recapture. |
| `threads-populated.png` | Streaming WAV stall fixture is failed, not stopped by Sotto; retain failed status dot and label. Keep recapture. |
| `threads-search-light.png` | Streaming WAV stall fixture is failed, not stopped by Sotto; retain failed status dot and label. Keep recapture. |
| `threads-search.png` | Streaming WAV stall fixture is failed, not stopped by Sotto; retain failed status dot and label. Keep recapture. |
| `threads-split-focus-820-dark.png` | Streaming WAV stall fixture is failed, not stopped by Sotto; retain failed status dot and label. Keep recapture. |
| `threads-split-focus-820-light.png` | Streaming WAV stall fixture is failed, not stopped by Sotto; retain failed status dot and label. Keep recapture. |
| `threads-split-workspace-dark.png` | Streaming WAV stall fixture is failed, not stopped by Sotto; retain failed status dot and label. Keep recapture. |
| `threads-split-workspace-light.png` | Streaming WAV stall fixture is failed, not stopped by Sotto; retain failed status dot and label. Keep recapture. |
| `threads-stopped-light.png` | Streaming WAV stall fixture is failed, not stopped by Sotto; retain failed status dot and label. Keep recapture. |
| `threads-stopped.png` | Streaming WAV stall fixture is failed, not stopped by Sotto; retain failed status dot and label. Keep recapture. |
| `width-760-agents-dark.png` | Keep deleted; retired voice/Agents surface. |
| `width-760-agents-light.png` | Keep deleted; retired voice/Agents surface. |
| `width-760-dictate-dark.png` | Remove Agents from the Dictate/Threads switch and focus order. Keep recapture. |
| `width-760-dictate-light.png` | Remove Agents from the Dictate/Threads switch and focus order. Keep recapture. |
| `width-760-settings-dark.png` | Remove Agents from the Dictate/Threads switch and focus order. Keep recapture. |
| `width-760-settings-light.png` | Remove Agents from the Dictate/Threads switch and focus order. Keep recapture. |
| `artifacts/design/app-review/manifest.json` | Regenerate for the merged capture matrix, then recompute hashes and geometry after restoring non-removal images. |
| `docs/guide.md` | Keep new setup and Linux instructions and retry recovery text; widget activity belongs only to dictation; remove the new hosted-reply-voice claim. |
| `electron.vite.config.ts` | Keep Linux's dictationClient entry; keep wakeWorker removed. |
| `package-lock.json` | Start from main's lock and run npm uninstall followed by npm ci for the two retired voice packages. |
| `package.json` | Keep main's 0.1.34 version and dependency versions; remove voice scripts and both voice dependencies; use surviving assets verification for packaging. |
| `src/main/agents/speech.ts` | Keep deleted; main's Linux unavailable-speech branch retires with system replies. |
| `src/main/index.ts` | Keep main's Linux, clipboard, tray and babysitting test hooks; retain removal's startup, protocol, IPC and widget broadcast changes. |
| `src/renderer/src/App.tsx` | Keep main's Threads tour state and completion flow; remove agentSheet, Agents room and old greeting commentary. |
| `src/renderer/src/agents/AgentRoom.tsx` | Keep deleted; provider normalization and babysitting speaker naming survive in threadFacts and ThreadTranscript. |
| `src/renderer/src/agents/ThreadPane.tsx` | Keep main's ornamentPose and explicit babysitting pose; keep managed drafts and controls removed. |
| `src/renderer/src/agents/threadFacts.ts` | Keep main's providerIdOfLabel import and label normalization; remove assignment and management facts. |
| `src/renderer/src/widget/WidgetApp.tsx` | Keep Linux's F9 to talk hint on the dictation sliver; keep all agent actions and state removed. |
| `src/shared/agents.ts` | Keep main's providerIdOfLabel function and Claude Code name; remove orb and speech schemas. |
| `tests/e2e/agentControl.spec.ts` | Use main's nine-step setup helper; open Threads directly and keep the removal's manual-thread journeys. |
| `tests/e2e/agentSetup.spec.ts` | Keep main's profile past setup so it starts disconnected; test the connection error and retry on Threads. |
| `tests/e2e/agents.spec.ts` | Keep removal's new-thread-default and project settings journey; obsolete reasoning and voice journeys stay removed. |
| `tests/e2e/crossing.spec.ts` | Use main's setup helper and instant New thread behavior; retain manual composer journey and remove Agents-room paths. |
| `tests/e2e/support/voiceJourney.ts` | Keep deleted; the nine-step dictation setup helper survives in sottoLaunch. |
| `tests/unit/renderer/agentView.test.tsx` | Keep deleted; main's new Agents-room provider-badge test retires with that surface. |

## Design audit

`npm run design:capture` passed all nine capture groups. Compared every one of main's 152 baseline images using `pixelDifference` and `isNegligibleDifference` from the capture spec itself, with the channel floor of 6. Of them, 97 were byte-identical, eight are deleted, 39 have intended material removal differences, and eight recaptures were restored to main. Recomputed final manifest hashes and geometry; it contains 144 exact tuples.

All 125% and 150% images match main's bytes, including the two changed setup recaptures. A transient Codex-connected notice in `threads-tour-projects.png` and five negligible raster recaptures were restored. Help already matches main's 0.1.34 image, so no removal-specific Help image was added.

Every committed baseline difference from main:

| Image | Why it changes |
| --- | --- |
| `appearance-system-dark.png` | Replace retired orb preview with main owl mark. |
| `appearance-system-light.png` | Replace retired orb preview with main owl mark. |
| `dictate-listening-light.png` | Remove Agents from the Dictate/Threads switch and focus order. |
| `dictate-listening.png` | Remove Agents from the Dictate/Threads switch and focus order. |
| `dictate-pasted-light.png` | Remove Agents from the Dictate/Threads switch and focus order. |
| `dictate-pasted.png` | Remove Agents from the Dictate/Threads switch and focus order. |
| `dictate-ready-light.png` | Remove Agents from the Dictate/Threads switch and focus order. |
| `dictate-ready.png` | Remove Agents from the Dictate/Threads switch and focus order. |
| `focus-navigation-light.png` | Remove Agents from the Dictate/Threads switch and focus order. |
| `focus-navigation.png` | Remove Agents from the Dictate/Threads switch and focus order. |
| `focus-switch-tab-light.png` | Remove Agents from the Dictate/Threads switch and focus order. |
| `focus-switch-tab.png` | Remove Agents from the Dictate/Threads switch and focus order. |
| `onboarding-step-4-openrouter-light.png` | Remove Kokoro from OpenRouter key wording. |
| `onboarding-step-4-openrouter.png` | Remove Kokoro from OpenRouter key wording. |
| `scale-100-onboarding.png` | Remove Kokoro from OpenRouter key wording. |
| `scale-200-onboarding.png` | Remove Kokoro from OpenRouter key wording. |
| `settings-agents.png` | Remove reasoning account and automatic follow-up limit. |
| `settings-appearance-light.png` | Replace retired orb preview with main owl mark. |
| `settings-appearance.png` | Replace retired orb preview with main owl mark. |
| `settings-key-verified.png` | Remove Kokoro from OpenRouter key wording. |
| `settings-transcription.png` | Remove Kokoro from OpenRouter key wording. |
| `threads-new-thread-chooser-dark.png` | Streaming WAV stall fixture is failed, not stopped by Sotto; retain failed status dot and label. |
| `threads-new-thread-chooser-light.png` | Streaming WAV stall fixture is failed, not stopped by Sotto; retain failed status dot and label. |
| `threads-open-running-light.png` | Streaming WAV stall fixture is failed, not stopped by Sotto; retain failed status dot and label. |
| `threads-open-running.png` | Streaming WAV stall fixture is failed, not stopped by Sotto; retain failed status dot and label. |
| `threads-populated-light.png` | Streaming WAV stall fixture is failed, not stopped by Sotto; retain failed status dot and label. |
| `threads-populated.png` | Streaming WAV stall fixture is failed, not stopped by Sotto; retain failed status dot and label. |
| `threads-search-light.png` | Streaming WAV stall fixture is failed, not stopped by Sotto; retain failed status dot and label. |
| `threads-search.png` | Streaming WAV stall fixture is failed, not stopped by Sotto; retain failed status dot and label. |
| `threads-split-focus-820-dark.png` | Streaming WAV stall fixture is failed, not stopped by Sotto; retain failed status dot and label. |
| `threads-split-focus-820-light.png` | Streaming WAV stall fixture is failed, not stopped by Sotto; retain failed status dot and label. |
| `threads-split-workspace-dark.png` | Streaming WAV stall fixture is failed, not stopped by Sotto; retain failed status dot and label. |
| `threads-split-workspace-light.png` | Streaming WAV stall fixture is failed, not stopped by Sotto; retain failed status dot and label. |
| `threads-stopped-light.png` | Streaming WAV stall fixture is failed, not stopped by Sotto; retain failed status dot and label. |
| `threads-stopped.png` | Streaming WAV stall fixture is failed, not stopped by Sotto; retain failed status dot and label. |
| `width-760-dictate-dark.png` | Remove Agents from the Dictate/Threads switch and focus order. |
| `width-760-dictate-light.png` | Remove Agents from the Dictate/Threads switch and focus order. |
| `width-760-settings-dark.png` | Remove Agents from the Dictate/Threads switch and focus order. |
| `width-760-settings-light.png` | Remove Agents from the Dictate/Threads switch and focus order. |

The [complete pixel audit](../../artifacts/voice-control-removal/merged-setup/pixel-audit.json) includes actual/main geometry, both pixel metrics and each restoration. The six deleted voice images and two Agents-width images remain absent. Main's old step-3 OpenRouter captures were already removed on main; its step-4 captures are used.

## ADR reference audit

Renamed the removal record to `0066-remove-voice-control-and-thread-management.md` and updated removal references across 135 files: AGENTS, CONTEXT, ADR amendment lines, current docs, dated plans, performance notes and verification history. The [reference-file inventory](../../artifacts/voice-control-removal/merged-setup/adr-references.json) lists every file. A tracked-text scan found no old removal filename. Seven surviving ADR-0062 references all mean Linux and were preserved; main's owl references remain ADR-0064. There were no surviving code or test references to renumber. The future command-center plan's unassigned proposed record is described by name rather than colliding with accepted ADR-0063.

## Review and limits

Independent standards and spec reviews used `gpt-6.1-sol` at `max` reasoning through Codex. Both found no blocking issue. Standards noted the existing low-priority `ConfiguredAgentReasoner` account-discovery name; the original removal evidence already leaves that rename for the separate command-center work.

The earlier branding run had one stale removal assertion looking for an app mark from the retired room; it was corrected to the Threads sidebar owl and idle sliver, and both branding cases passed on rerun. No failure was declared pre-existing, so no detached proof checkout of main was needed. Initial typecheck/lint failures were merge-resolution omissions and were fixed before gate verification.

The packaged installer, live accounts, a real legacy remote host, macOS, Omarchy and native phone clients were not run here. This merge does not establish new runtime evidence for them. No decision from Zach is needed.
