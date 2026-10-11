# Project working-copy defaults (#497)

Test citations use the current split files. Recorded counts and outcomes are from the original runs.

Verified on Windows in the built Electron app with synthetic providers.

`npx vitest run tests/unit/main/settingsRepository.test.ts tests/unit/renderer/features/settings/settingsNavigation.test.tsx tests/unit/renderer/features/settings/settingsMicrophone.test.tsx tests/unit/renderer/features/settings/settingsCaptureOutput.test.tsx tests/unit/renderer/features/settings/settingsGit.test.tsx tests/unit/renderer/features/settings/settingsAppearance.test.tsx tests/unit/renderer/features/settings/settingsTranscriptionKey.test.tsx tests/unit/renderer/features/settings/settingsUpdatesPrivacy.test.tsx tests/unit/renderer/features/settings/projectThreadDefaults.test.tsx tests/unit/renderer/features/settings/settingsDictionary.test.tsx tests/unit/renderer/newThreadProjectCreation.test.tsx --maxWorkers=2`: 114 passed. The Settings-to-creation regression is now in `tests/unit/renderer/features/settings/projectThreadDefaults.test.tsx`. Before the fix, that regression sent `workingCopy: 'shared'` after choosing New worktree. It now sends `independent` with Start from origin. Restoring inheritance sends `shared` again. Remote projects retain their host-qualified keys. Migration persists local overrides, preserves existing bare-ID choices and remote entries, and does not create an empty settings file.

`npm run build` and `npx playwright test tests/e2e/new-thread-settings.spec.ts --workers=1`: 2 passed. The first journey chooses New worktree in Application settings and opens a thread whose actual working-copy mode is independent. The second saves the former host-keyed local entry, restarts the app, checks the migrated setting and displayed choice, then opens an independent thread from the project pen.

The Settings journey checks dark and light at 1600×1000, 1280×800 and 820×560, with no horizontal overflow and the choice in view. Escape returns focus to Project defaults with reduced motion enabled. Inspected the minimum-size dark and light captures: the labels and controls remain readable, and the row shows New worktree. There is no layout or copy change and no design baseline regeneration.

After merging the current main branch, typecheck, lint, third-party notices verification and build passed again. Both Electron journeys passed again (2 tests); their minimum-size dark and light captures were inspected and restored as incidental output. This fix changes no layout or copy. Separate standards and spec reviews found no substantive findings.

Native provider worktree allocation on first send and macOS were not exercised by these synthetic Windows journeys.

After integrating main at `cdb06205` (bounded quit cleanup), typecheck and build passed again. `quitDrain.test.ts` and `settingsRepository.test.ts` passed (22 tests). The selected quit, tray and relaunch Electron journeys passed (3 tests), and both project-default journeys passed again (2 tests). Generated captures were restored.

Gates (Windows) passed on `46dfd33f`. The first run after the main merge passed 6,392 tests and skipped 150, but failed `devinAdapter.test.ts` while checking its synthetic native integrations before the disconnected-provider scenario. The adapter, integration checks and fixtures are unchanged from main. The entire file then passed locally (54 passed, 8 skipped). The underlying subprocess failure is intentionally redacted; its cause was not reproduced locally. No approval check, assertion or deadline was changed.
