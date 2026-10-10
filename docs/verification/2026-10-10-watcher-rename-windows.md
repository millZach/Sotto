# Watcher naming on Windows

October 10, 2026. Branch: `command-center`, based on `fd774f849`. This is a naming change before the first preview writes these records to a real profile. The approved owl choices are recorded in ADR-0070 and the plan; this change adds no renderer layout or behavior.

## Checks

The gates ran in order and returned zero: `npm run typecheck`, `npm run lint`, `npm test -- --maxWorkers=2`, `npm run notices:verify`, and `npm run build`. The full suite passed 722 files and 8,980 tests, with 56 files and 278 tests skipped, in 1,044.43 seconds. No isolated reruns were needed. Notices verification checked 182 components. Before the full suite, free physical memory was 10,561,596 KB.

A separate check launched the freshly built Electron app with the repository's synthetic provider scenario and an owned disposable profile. It drove Welcome, all nine first-run steps, the Threads tour, Threads and Settings > Agents. It saved `watcherInFlightLimit: 3` through the preload/IPC bridge and read the resulting settings file. After closing the app, its `agents.json` contained `watcher` and no working-name record. A second launch restored the setting and opened Agents settings. Both owned Electron processes exited and the profile was removed. No real profile, account or provider turn was used.

[Agents settings at 1280x800](../../artifacts/watcher-rename/agents-settings-1280x800.png) shows the existing surface after first-run setup. It was visually inspected; it is not a capture of the future Watcher room. Native provider live checks, packaged installers and macOS were not rerun for this rename.

The schema, setting default/parser and IPC patch allow-list use `watcher`, `watcher-history` and `watcherInFlightLimit`. Participation's `startedBy` and read fields use Watcher names too. The older-store migration still supplies an empty Watcher record and `project` kinds only where absent. No compatibility migration or alias for the working names was added. The live suite uses `SOTTO_WATCHER_LIVE` and `SOTTO_WATCHER_PROVIDER`.

The changed source and test files have the same parsed structure apart from identifiers and text. UTF-8 without BOM and each file's original line-ending style were checked. Dated verification/performance bodies retain their wording, with a name note above them and the renamed ADR citation repointed. Local document links still resolve. The old-name scan finds only retained dated evidence, links to retained note/plan filenames, the documented branch, and the glossary's Avoid entry. `sotto_threads` and its tool names are unchanged.

## Renamed files

All 29 moves used `git mv`:

- `docs/adr/0070-watcher-coordinates-threads-with-its-providers-own-tools.md`
- `docs/research/2026-10-08-watcher-coordinator-agents.md`
- `docs/research/2026-10-08-watcher-parallel-workbenches.md`
- `docs/research/2026-10-08-watcher-vendor-agent-managers.md`
- `docs/research/2026-10-08-watcher-voice-mobile-delegation.md`
- `docs/research/2026-10-08-watcher.md`
- `src/main/agents/watcherCodexSandbox.ts`
- `src/main/agents/watcherLaunchProfiles.ts`
- `src/main/agents/watcherProfile.ts`
- `src/main/agents/watcherPrompt.ts`
- `src/main/agents/watcherProviderTools.ts`
- `src/main/agents/watcherRecords.ts`
- `src/shared/watcher.ts`
- `src/shared/watcherOverview.ts`
- `tests/fixtures/watcher.ts`
- `tests/fixtures/watcherGrokSearchProof.ts`
- `tests/fixtures/watcherLiveInterrupt.ts`
- `tests/fixtures/watcherLiveRecovery.ts`
- `tests/fixtures/watcherNativeReadProof.ts`
- `tests/integration/watcherGrokSearchProof.test.ts`
- `tests/integration/watcherLaunchProfiles.test.ts`
- `tests/integration/watcherLiveRecovery.test.ts`
- `tests/integration/watcherNativeReadProof.test.ts`
- `tests/integration/watcherOrdinaryThreads.test.ts`
- `tests/integration/watcherOwnTools.test.ts`
- `tests/integration/watcherOwnToolsLive.test.ts`
- `tests/unit/main/watcherRecords.test.ts`
- `tests/unit/shared/watcher.test.ts`
- `tests/unit/shared/watcherOverview.test.ts`
