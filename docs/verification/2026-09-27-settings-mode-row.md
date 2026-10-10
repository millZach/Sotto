# Fit the Settings room switch (#388)

October 9, 2026: Voice control and thread management described below are historical under [ADR-0068](../adr/0068-remove-voice-control-and-thread-management.md); the original plan or evidence is retained.

Zach selected prototype A: keep the horizontal row and existing sidebar width, fitting both the two-room beta default and three-room voice-enabled state. The primary source is `prototype/code-base-review-workflows` at `58917d59`, with the choice and both-state clarification recorded on issue #388. Production uses equal adaptive columns and removes only button side padding in the Settings sidebar. The 12.5px label size, names, theme roles and keyboard handlers are unchanged.

The real Electron regression failed on the unchanged layout at 820 by 560: sidebar right 178px, row right 199.385px. After the two scoped CSS rules, `npx playwright test tests/e2e/settings-mode-row.spec.ts --workers=1` passed both gate states in 9.7 seconds. It checks every footer control stays within the sidebar and viewport, each label fits its button at the original font size, widths are equal, and keyboard End/ArrowRight activate the expected room. Destination selection is asserted after navigation remounts the page; the first test draft incorrectly expected the old element's focus to survive that existing remount.

Both gate states were checked in light/dark with reduced motion at 1600 by 1000, 1280 by 800 and 820 by 560. The final build includes the Phones Settings category. The geometry reports remain in ignored `artifacts/review-388/geometry-*.json`. All three sidebar/theme neighboring suites passed 52 tests. The captures below were visually inspected; labels fit without clipping at the minimum and retain the existing hierarchy at typical size. No unrelated design baselines changed.

![Three rooms at minimum width in light appearance](../../artifacts/review-388/settings-three-820-light.png)

![Two rooms at minimum width in dark appearance](../../artifacts/review-388/settings-two-820-dark.png)

![Three rooms at typical width](../../artifacts/review-388/settings-three-1280-dark.png)

Typecheck, lint, notices and build passed. Independent native Astra Standards and Spec reviews at `f5b4eba2` and root visual/code review reported zero findings. Later main integration at `53bb7910` preserves the same CSS and desktop assertions. The full two-worker suite remains pending. No paid providers, production profile or physical microphone were used; macOS was not exercised.

## Full gate and current integration

The frozen local full suite at `b882bf03` completed with 5,860 passed, 140 skipped and four failed tests (445 files passed, 39 skipped and two failed files; 1,113.75 seconds). It is not a passing gate. `codexRollback.test.ts` lost its child before acknowledgement. `socketHostContract.test.ts` reported Codex `spawn UNKNOWN`, a Claude child exiting before readiness followed by cleanup timeout, and a failed Devin version probe. These occurred during independently observed machine resource failures; that correlation does not by itself establish every failure's cause. The exact log remains in the owned verification artifacts. A separate bounded neighbor check is assigned; no assertion or deadline was weakened.

Current main integration `d67e326c` includes the dictionary and semantic renderer-test gates. It changes none of this issue's CSS or native geometry assertions. Current static checks and the isolated hosted full gate remain pending; the change is not ready to merge.
