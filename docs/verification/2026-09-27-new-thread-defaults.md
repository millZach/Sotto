# New threads keep their starting defaults

October 9, 2026: Voice control and thread management described below are historical under [ADR-0068](../adr/0068-remove-voice-control-and-thread-management.md); the original plan or evidence is retained.

Zach reported that New thread opened settled work, ignored the saved default model, and showed a blank field over the default effort slider in Settings.

The empty-thread reuse check read provider settlement but missed workspace settlement on the thread and its project. It also accepted threads with older model and effort choices. It now uses the shared lifecycle helpers and the same starting-option resolution as creation. An empty thread is reusable only when its known starting choices still match. The managed creation form also now reads the new-thread model setting instead of the coordinator's model.

Settings' general text-input rules matched range inputs. Their background, border and padding covered the effort track and thumb. Both rules now exclude range inputs, preserving the existing slider and its keyboard behavior.

## Reproduction

- `npx vitest run tests/unit/renderer/unusedNewThread.test.tsx --maxWorkers=2` failed on workspace-settled reuse and stale default model/effort before the fix.
- `npx vitest run tests/unit/renderer/newThreadProjectCreation.test.tsx --maxWorkers=2` failed on managed creation using the coordinator model before the fix.
- `npx playwright test tests/e2e/new-thread-defaults.spec.ts` reproduced the covered slider: opaque background, border, 7 px padding and 38 px height. After repair it has a transparent background, no border or padding, and the normal 30 px minimum input target.

## Verification

Windows Electron, isolated fixture profiles; no live provider turns or personal data. The end-to-end journey checks default effort saving with keyboard, track clicks and dragging, persistence after reload, application to a new thread, changed model defaults, repeated New thread reuse, settled projects, individually settled empty threads, and persistence of the resulting sidebar after reload.

The Settings slider was captured at 1600×1000, 1280×800 and 820×560, in light and dark mode, with viewport/overflow assertions. Reduced motion checks that no endless animation runs. Escape returns focus to the effort chip. Existing effort-picker specs cover the composer's drag preview, arrival, colorways and keyboard behavior; the settled-folder spec checks older threads stay settled when new work reopens their project.

Representative captures:

- [Dark, 1600×1000](../../artifacts/new-thread-defaults/settings-dark-1600.png)
- [Light, 820×560](../../artifacts/new-thread-defaults/settings-light-820.png)
- [Reduced motion](../../artifacts/new-thread-defaults/settings-reduced-motion.png)

The throwaway control comparison is preserved on local branch `prototype/new-thread-default-effort`, commit `665fb1057f4824c3f6a287baf3f11d8cb722940f`, at `artifacts/new-thread-defaults/effort-prototype.html`. The repair retains the established slider; no alternative layout was selected.

## Review

Standards: existing theme tokens and lifecycle helpers retained; no permission grants, network hosts, production dependencies, provider identifiers, or persisted schemas added. Prototype remains outside the implementation branch. Documentation describes reuse without promising that settled work is restored.

Spec: new work is unsettled; reused empty work must match the current default model and known effort; managed creation uses the same model setting; Settings effort remains visible and editable. Existing settled threads are preserved.

Independent review of PR #433 found two additional reuse cases: pending or unconfirmed model/effort changes could land after reuse, and a missing catalog could leave a saved effort unresolved. Five regression cases failed before the follow-up fix; the four focused files then passed all 41 tests. Reuse now declines both cases. The guide's older unconditional reuse sentence was corrected too. The repeated CSS exclusion across the two existing Settings scopes was retained rather than introducing a broader text-field refactor.

Grok's spec recheck found the corresponding unresolved permission-default case. Two regression cases reproduced reuse of a more permissive empty thread when the model was missing or offered no permission choices. Reuse now declines an unresolved saved permission default too. A neighboring test confirms that a matching provider profile still permits reuse. All 44 tests in the four focused files passed after this fix.

After rebasing onto main and applying the review fixes, typecheck, lint and build passed again. The three related Electron specs ran together with all six tests passing. The retained screenshots were refreshed to match the current app, including the Phones navigation entry already on main.

Passed: `npm run typecheck`, `npm run lint`, `npm run notices:verify` (174 components), and `npm run build`. The four focused unit files passed (35 tests); after adding the managed regression, the two affected files passed (24 tests). The two new Electron journeys passed three consecutive runs (six tests), and the Settings journey passed again with track-click coverage. All three existing effort-picker tests and the settled-folder test passed.

The final `npm test -- --maxWorkers=2` run finished with 5,740 passed, 128 skipped and one failed test (437 passed files, 35 skipped, one failed). The failure was `tests/integration/hostLock.test.ts:112`, "gives the folder to exactly one of three hosts started together over a crashed lock": no contender acquired the lock where one was expected. `npx vitest run tests/integration/hostLock.test.ts --maxWorkers=2` then passed all 16 tests in isolation. Both that test and `src/host/lock.ts` are unchanged from HEAD. The failure is intermittent and unresolved; the full gate is not green.

The same host-lock file was also run on main at `53bb7910859ac6989f8fc71fd58204e44aaabeef`, where all 16 tests passed. The failure was not reproduced on that baseline; unchanged files and a passing isolated rerun do not prove its cause. PR CI records the full gate for the published revision.

macOS and live provider behavior were not exercised locally; this change is in renderer selection and styling. The implementation has not been installed or released.
