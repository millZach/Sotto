# Watcher review fixes, October 10, 2026

Windows x64, `command-center`, starting at `b9b33f54e`. The final code tested and built is `36b0af5a1`; the subsequent evidence commit changes only this note and two selected captures. The lead reviews the fixes. No push, merge, rebase, stash, branch switch, new worktree, publication, installation or nested Codex review ran.

## Findings and regression checks

| Finding | Fix commit | Evidence |
| --- | --- | --- |
| Hidden history exhausts the event-page limit | `21621adab` | `watcherGate.test.ts` reproduces an empty catch-up page behind 257 current and 257 earlier Watcher events. It passes after SQLite excludes hidden thread IDs before LIMIT. Both gate states, successive socket-sized pages, targeted reads, zero limits and unchanged saved events are covered. |
| Remembered-grant refusal shuts down a valid session | `288b1404a` | New workspace/router/provider cases in `watcherOwnTools.test.ts` failed on scoped-tool revocation for Codex and Grok. They now retain the card, accept Allow once and send another turn. Forbidden settings also leave the session intact; corrupt launch identity still revokes it. Claude exposes only Allow once and Deny (`claudeRequests.ts`) and has no remembered-grant path. |
| Grok refuses native skills | `4ea0b7402` | The selected-skill case failed on Grok's obsolete refusal. Catalog discovery and selected-skill sends now pass for Codex, Claude and Grok, with invalid-profile refusal retained. Codex and Claude had no equivalent skill prohibition. |
| Two renamed ADR links | `670bb522a` | Both `adrLinks.test.ts` cases failed on the old filename and pass with the actual ADR-0073 target. |
| Duplicated hidden-thread projection | `36b0af5a1` | Both callers use `AgentState`. They now use the shared pure projection. `watcherVisibility.test.ts` covers both special kinds, all eight collections, selection and draft clearing, enabled behavior and preservation of the source state. Existing router and renderer journeys also pass. |
| Duplicated Owl test setup | `36b0af5a1` | Both specs use `tests/e2e/support/releaseTrack.ts`. `e2eReleaseTrack.test.ts` checks inherited overrides, restoration on failure and success, real temporary manifests and cleanup. The stable case now clears an inherited Owl entry instead of silently using it. |

The pagination audit found no other Watcher filter after a page limit. Thread lists use complete snapshots; history windows address one thread and check its visibility before reading. Host and phone catch-up share the socket event page and workspace event source. The socket's separate message-alias filter already advances the cursor across excluded rows. The later Owl phone-specific projection remains outside this foundation, as the host-protocol document states.

## Gates

The final commands ran in the requested order, with real output:

| Command | Result |
| --- | --- |
| `npm run typecheck` | Exit 0; all four TypeScript projects |
| `npm run lint` | Exit 0 |
| `npm test -- --maxWorkers=2` | Exit 0; 751 files passed, 56 skipped; 9,272 tests passed, 278 skipped; 1,149.18 seconds |
| `npm run notices:verify` | Exit 0; 185 third-party notice components |
| `npm run build` | Exit 0; main, host, preload and renderer |
| `npx playwright test tests/e2e/watcher-gate.spec.ts tests/e2e/sotto-owl-branding.spec.ts` | Exit 0; all eight journeys passed in 23.9 seconds |

No full-suite or Playwright retry was needed. Initial typecheck caught a missing retained path import and the UUID-default parameter's narrow inferred type in a fixture; initial lint caught an unused import and a throw directly in finally. These were fixed in the shared-fixture commit before the final ordered run. The full suite emitted SQLite experimental and jsdom canvas warnings; build emitted dependency directive warnings. None failed a gate.

Free physical memory, checked with the requested PowerShell command, was 12,403,184 KB before the full suite and 10,599,200 KB before Playwright, both above 3 GB. The worktree's Electron binary and path file were absent. To avoid its automatic downloader, the test, build and Playwright command environments used `ELECTRON_OVERRIDE_DIST_PATH=D:/Talk to Text Application/node_modules/electron/dist`. That existing binary's file version and package version are both 43.1.0, matching this checkout. The worktree's binary and path file remained absent afterward.

## Built app

The real built Windows app used isolated owned profiles. Stable and Owl ordinary Send/reply journeys passed, Watcher visibility followed the running version, and stable's saved Watcher kinds survived a return to Owl without restoring dropped panes. Bounds checks covered dark and light with reduced motion at 1600x1000, 1280x800 and 820x560. Branding checks covered Threads, Settings, Help, reduced motion and first-run setup.

Opened and inspected: stable and Owl dark/light at 820x560, both dark 1600x1000 views, Owl Settings light at 820x560, the reduced-motion header and Owl first-run setup at 1280x800. The selected minimum-size views retain ordinary controls and expected sidebar scrolling; stable omits Watcher and Owl lists its saved conversations. Retained captures: [stable](../../artifacts/watcher-gate/review-stable-dark-820x560.png) and [Owl](../../artifacts/watcher-gate/review-owl-dark-820x560.png). Other run captures remain disposable under `artifacts/e2e-runs/`; historical captures and design baselines were not replaced.

Provider regressions use scripted native clients, with no paid turn. Packaged builds, live providers, macOS and Linux were not exercised by this review-fix run.
