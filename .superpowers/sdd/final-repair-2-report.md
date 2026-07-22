# Final Repair Report 2: Hidden Widget Interaction Reset

## Status

DONE

- Branch: `fix/window-controls-pill-drag`
- Base commit: `0393c9b96c77990e8d7d57360ab8f1d271777a1a`
- Repair commit: `0240038ffb154984e196ed756019f258f82619ee`
- Repair commit subject: `fix: reset hidden widget interactions`
- Amend performed: no
- Push performed: no
- Tracked working tree after the repair commit: clean

## Findings repaired

1. **Hidden widgets accepted late drag-start IPC**
   - `WindowManager.reportWidgetDrag()` now rejects every drag phase while the widget is not visible and clears any stale ownership.
   - A late hidden `start` or `move` can no longer move the native window or leave `widgetDrag` populated.
   - The next `showWidget()` transition calls `showInactive()` and restarts the existing 100 ms cursor-monitor lifecycle.

2. **Idle hover expansion survived native visibility loss**
   - A hidden visibility event already increments the monotonic renderer cancellation version; `WidgetApp` now uses that same signal to clear hover containment, cancel any pending 220 ms collapse timer, and reset `expanded`.
   - The renderer emits `idle-resting` for the reveal and accepts a later genuine hover normally.
   - Repeated hidden and visible notifications remain idempotent.

## Files changed

Production:

- `D:/Talk to Text Application/src/main/windows/windowManager.ts`
- `D:/Talk to Text Application/src/renderer/src/widget/WidgetApp.tsx`

Tests:

- `D:/Talk to Text Application/tests/unit/main/windowManager.test.ts`
- `D:/Talk to Text Application/tests/unit/renderer/widgetApp.test.tsx`

Report:

- `D:/Talk to Text Application/.superpowers/sdd/final-repair-2-report.md`

## Test-driven development evidence

Production code was not changed until each focused regression was added and observed failing for the reviewed symptom.

### Hidden late-drag RED

```text
npm test -- tests/unit/main/windowManager.test.ts -t "rejects late drag reports while hidden"
```

Exit `1`: 1 failed, 81 skipped.

The second reveal was suppressed:

```text
expected showInactive to be called 2 times, but got 1
```

### Hidden late-drag GREEN

```text
npm test -- tests/unit/main/windowManager.test.ts -t "rejects late drag reports while hidden"
```

Exit `0`: 1 passed, 81 skipped.

The regression proves that after hide plus late `start`/`move` reports:

- the second reveal calls `showInactive()`;
- one monitor timer is active;
- a later ownership-free `move` cannot call `setPosition()`; and
- the next 100 ms tick follows the cursor to the other monitor.

The complete coordinator suite then passed:

```text
npm test -- tests/unit/main/windowManager.test.ts
```

Exit `0`: 1 file passed, 82 tests passed.

Existing drag-coordinator fixtures that had initiated gestures on never-shown windows were updated to establish a visible hovered widget first. This aligns those tests with the repaired invariant that a non-visible widget cannot own a drag.

### Visibility-reset RED

```text
npm test -- tests/unit/renderer/widgetApp.test.tsx -t "resets idle hover state across native hide and reveal"
```

Exit `1`: 1 failed, 54 skipped.

The hidden/revealed sliver incorrectly retained:

```text
data-expanded="true"
```

### Visibility-reset GREEN

```text
npm test -- tests/unit/renderer/widgetApp.test.tsx -t "resets idle hover state across native hide and reveal"
```

Exit `0`: 1 passed, 54 skipped.

The regression expands the idle pill, schedules settled hover-out, delivers repeated `false` and `true` visibility events, and proves:

- `data-expanded` clears;
- the pending hover timer is removed;
- `idle-resting` is sent; and
- a later real hover expands and sends `idle-hovered` again.

The complete renderer suite then passed:

```text
npm test -- tests/unit/renderer/widgetApp.test.tsx
```

Exit `0`: 1 file passed, 55 tests passed.

## Final verification commands and results

### All affected interaction suites

```text
npm test -- tests/unit/main/windowManager.test.ts tests/unit/renderer/widgetApp.test.tsx tests/unit/renderer/widgetDragGesture.test.tsx tests/integration/ipc.test.ts tests/integration/nativeRendererRecovery.test.ts
```

Exit `0`: 5 files passed, 265 tests passed.

### Typecheck

```text
npm run typecheck
```

Exit `0`: both Node and web TypeScript projects completed without diagnostics.

### Lint

```text
npm run lint
```

Exit `0`: ESLint completed without errors or warnings.

### Full unit and integration suite

```text
npm test
```

Exit `0`: 62 files passed, 1 file skipped; 995 tests passed, 4 tests skipped.

### Complete Electron suite

```text
npm run test:e2e
```

Exit `0`: the production build completed and 30 Electron tests passed; 6 authoritative design-capture tests remained intentionally skipped by their existing gate.

### Diff checks

```text
git diff --check
git status --short
```

Before the repair commit, `git diff --check` exited `0` and status listed exactly the two production files and two regression-test files. After commit `0240038ffb154984e196ed756019f258f82619ee`, tracked status was clean before this report was created.

## Self-review

- Re-read the approved design, implementation plan, prior repair report, and relevant source and tests before editing.
- Verified both supplied findings against commit `0393c9b96c77990e8d7d57360ab8f1d271777a1a`.
- Preserved the approved 100 ms monitor interval and 220 ms hover-settle hysteresis.
- Confirmed the main-process guard covers stale hidden `start`, `move`, and `end` phases and clears ownership without native movement or snapping.
- Confirmed visible drag replacement, resting-to-hovered promotion, drag-end snapping, and monitor resumption behavior remain covered.
- Confirmed renderer reset reuses the existing monotonic hidden-event cancellation signal and adds no IPC channel, bridge capability, or payload change.
- Confirmed repeated hidden events can batch safely because the reset is idempotent; repeated visible events do not mutate interaction state.
- Confirmed pending hover-collapse work is cancelled on hide, so it cannot affect the next reveal or later hover.
- Confirmed all drag tests that require ownership now establish widget visibility instead of depending on an invalid hidden-window setup.
- Confirmed no placement geometry, DPI handling, title-bar behavior, dictation controls, persistence schema, runtime dependency, or visual baseline changed.
- No branch or worktree was created or switched, and no amend, force update, or push was performed.

## Concerns

No unresolved repair concern.

The Electron build continues to print the pre-existing Vite warnings that Lucide `"use client"` directives are ignored, plus Playwright's existing `NO_COLOR`/`FORCE_COLOR` warning. Six authoritative design-capture tests remain intentionally skipped; all 30 active Electron tests passed.

---

## Whole-branch follow-up repair: reveal ordering and drag recovery

### Status

DONE

- Date: 2026-07-21
- Branch: `fix/window-controls-pill-drag`
- Base commit: `8cfd92a89a41266abb41dcab9caf329d5656ee52`
- Repair commit: `bf2c390cb5fdf9dc150df51fcda71f1f87f1ed3a`
- Repair commit subject: `fix: harden widget reveal and drag recovery`
- Amend performed: no
- Push performed: no
- Tracked working tree after the repair commit: clean

### Findings repaired

1. **An in-flight reveal could resurrect the widget after a later hide**
   - `showWidget()` now captures a monotonically increasing visibility generation before awaiting widget creation.
   - `hideWidget()` invalidates every earlier reveal request even when the widget was not yet marked visible.
   - A stale continuation returns before placement, visibility publication, `showInactive()`, or monitor startup, while a later explicit reveal remains the newest request.

2. **A successful drag move followed by readback failure was never retried**
   - After `setPosition()` returns, `widgetLastAppliedBounds` is invalidated before the native bounds readback.
   - A successful readback replaces the invalidated cache with the actual rectangle as before.
   - If readback throws, drag ownership clears and the next 100 ms monitor check cannot mistake the pre-drag rectangle for current native bounds; it reapplies the snapped target.

### Files changed

Production:

- `D:/Talk to Text Application/src/main/windows/windowManager.ts`

Tests:

- `D:/Talk to Text Application/tests/unit/main/windowManager.test.ts`

Report:

- `D:/Talk to Text Application/.superpowers/sdd/final-repair-2-report.md`

### Test-driven development evidence

Production code for each finding was unchanged until its focused regression was added and observed failing for the reviewed symptom.

#### Stale reveal RED

```text
npm test -- tests/unit/main/windowManager.test.ts -t "does not reveal after hide wins an in-flight widget load"
```

Exit `1`: 1 failed, 82 skipped.

The deferred renderer load resolved after `hideWidget()`, and the stale continuation still published visible state:

```text
expected "vi.fn()" to not be called with arguments:
[ 'talktype:widget:visibility', true ]
Number of calls: 1
```

#### Stale reveal GREEN

```text
npm test -- tests/unit/main/windowManager.test.ts -t "does not reveal after hide wins an in-flight widget load"
```

Exit `0`: 1 passed, 82 skipped.

The regression proves the winning hide remains native and logical state: `hide()` is called once, no visible publication occurs, `showInactive()` is not called, no monitor timer starts, and a repeated hide does not publish a spurious hidden transition.

The cursor-monitor lifecycle group then passed:

```text
npm test -- tests/unit/main/windowManager.test.ts -t "WindowManager cursor monitor following"
```

Exit `0`: 12 passed, 71 skipped.

#### Drag readback RED

```text
npm test -- tests/unit/main/windowManager.test.ts -t "reapplies snapped bounds after a drag move readback failure"
```

Exit `1`: 1 failed, 83 skipped.

`setPosition()` moved the fake native widget from `x = 376` to `x = 476`, the following `getBounds()` threw, and the next same-monitor check issued no recovery operation:

```text
expected "vi.fn()" to be called with arguments:
[ { x: 376, y: 708, width: 248, height: 76 }, false ]
Number of calls: 0
```

#### Drag readback GREEN

```text
npm test -- tests/unit/main/windowManager.test.ts -t "reapplies snapped bounds after a drag move readback failure"
```

Exit `0`: 1 passed, 83 skipped.

The regression proves that ownership clears after the failed readback and the next monitor tick calls `setBounds()` with the centered snapped rectangle, restoring the fake native widget to `x = 376`.

The complete coordinator suite then passed:

```text
npm test -- tests/unit/main/windowManager.test.ts
```

Exit `0`: 1 file passed, 84 tests passed.

### Final verification commands and results

#### Focused coordinator and renderer-recovery coverage

```text
npm test -- tests/unit/main/windowManager.test.ts tests/integration/nativeRendererRecovery.test.ts
```

Exit `0`: 2 files passed, 90 tests passed.

#### Typecheck

```text
npm run typecheck
```

Exit `0`: both Node and web TypeScript projects completed without diagnostics.

#### Lint

```text
npm run lint
```

Exit `0`: ESLint completed without errors or warnings.

#### Diff and branch checks

```text
git diff --check
git status --short --branch
git rev-parse HEAD
```

Before commit, `git diff --check` exited `0`; status showed only `src/main/windows/windowManager.ts` and `tests/unit/main/windowManager.test.ts` modified on `fix/window-controls-pill-drag`, with base `8cfd92a89a41266abb41dcab9caf329d5656ee52`. After repair commit `bf2c390cb5fdf9dc150df51fcda71f1f87f1ed3a`, the tracked working tree was clean before this report append.

### Self-review

- Re-read the approved design, implementation plan, prior repair report, current coordinator source, and relevant tests before editing.
- Verified both supplied findings against base commit `8cfd92a89a41266abb41dcab9caf329d5656ee52` and observed each new regression fail for the expected reviewed symptom.
- Confirmed every `showWidget()` call receives a distinct generation, so repeated or concurrent reveals leave only the latest request eligible to transition visibility; any later hide invalidates all earlier requests.
- Kept the existing stopped-manager assertion after the await, so disposal and quit races continue rejecting instead of being silently treated as visibility cancellation.
- Invalidated the bounds cache only after `setPosition()` returns, preserving the existing cursor-lookup and failed-`setPosition()` paths while repairing the verified partial-success path.
- Confirmed the 100 ms monitor interval, edge-centered placement geometry, presentation footprints, persistence, renderer bridge, and native constructor options are unchanged.
- Added no runtime dependency, IPC channel, payload field, visual baseline, or renderer behavior.
- Focused review of the final source/test diff found no remaining verified Critical or Important issue.
- No branch or worktree was created or switched, and no amend, force update, or push was performed.

### Concerns

No unresolved follow-up repair concern.
