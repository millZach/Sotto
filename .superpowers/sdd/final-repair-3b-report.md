# Final repair 3b evidence

## Result

Both verified defects are repaired on `fix/window-controls-pill-drag` without changing the supported `820x560` minimum, restoring native chrome, or adding a second custom titlebar.

Code commit: `1255623` (`fix: use current widget footprint for edge snapping`)

## Changes

- `src/main/windows/widgetPlacementMath.ts`
  - `snapToEdge()` now accepts the current native bounds and calculates all four edge distances from that footprint.
  - The existing deterministic tie priority remains `bottom`, `top`, `left`, `right`.
  - The return value remains edge-only: `{ edge }`.
- `src/main/windows/windowManager.ts`
  - Native drag/external-move snapping supplies actual bounds.
  - Legacy point migration supplies the current presentation footprint instead of a hard-coded active footprint.
- `src/renderer/src/styles/global.css`
  - The onboarding shell can shrink within the 52px-titlebar frame and scroll vertically.
- Regression coverage was added in:
  - `tests/unit/main/widgetPlacementMath.test.ts`
  - `tests/unit/main/windowManager.test.ts`
  - `tests/e2e/app.spec.ts`

## RED evidence

### Presentation footprint snapping

Command: `npm test -- tests/unit/main/widgetPlacementMath.test.ts`, run with the new tests against the pre-fix `widgetPlacementMath.ts` implementation.

Result: exit 1; 1 file failed; 2 failed and 6 passed.

- `uses the current idle-hovered footprint when choosing the nearest edge`
  - Expected `{ edge: 'left' }`.
  - Received `{ edge: 'bottom' }`.
- `uses active vertical geometry without reintroducing an along-edge offset`
  - Expected `{ edge: 'bottom' }`.
  - Received `{ edge: 'right' }`.

### Legacy migration must not assume active size

Command: `npm test -- tests/unit/main/windowManager.test.ts -t "uses the current idle-resting footprint when migrating a legacy point"`

Result: exit 1; 1 failed and 91 skipped.

- Expected left-edge bounds `{ x: 16, y: 338, width: 54, height: 124 }` and edge-only persistence.
- Received bottom-edge bounds `{ x: 438, y: 730, width: 124, height: 54 }`, proving the hard-coded active footprint selected the wrong edge.

### Minimum-size onboarding layout

Command: `npm run test:e2e -- tests/e2e/app.spec.ts -g "supported 820x560 minimum"`, run with the new Electron regression against the pre-fix CSS.

Result: exit 1; 1 Electron test failed.

- The real main `BrowserWindow` was resized to `820x560` and reported minimum size `[820, 560]`.
- The reachability assertion expected `true` and received `false`: Continue was neither initially inside the viewport nor reachable through onboarding-shell scrolling.

## GREEN evidence

### Focused regressions

- `npm test -- tests/unit/main/widgetPlacementMath.test.ts`
  - 1 file passed; 8 tests passed.
- `npm test -- tests/unit/main/windowManager.test.ts -t "uses the current idle-resting footprint when migrating a legacy point"`
  - 1 file passed; 1 test passed and 91 skipped.
- `npm run test:e2e -- tests/e2e/app.spec.ts -g "supported 820x560 minimum"`
  - Build completed; 1 Electron test passed.
  - Continue was visible or scroll-reachable and clicking it displayed `Check your microphone`.

### Final required verification

- `npm test -- tests/unit/main/widgetPlacementMath.test.ts tests/unit/main/windowManager.test.ts tests/unit/renderer/app.test.tsx tests/unit/renderer/onboarding.test.tsx tests/unit/renderer/appTitlebar.test.tsx tests/unit/renderer/appShell.test.tsx`
  - 6 files passed; 148 tests passed.
- `npm run test:e2e -- tests/e2e/app.spec.ts -g "frameless|supported 820x560 minimum"`
  - Build completed; 2 Electron tests passed.
  - The real main window remained frameless and had exactly one `.app-titlebar` before and after onboarding.
  - The minimum-size Continue control remained reachable and clickable.
- `npm run typecheck`
  - Exit 0 (`tsc --noEmit` for node and web projects).
- `npm run lint`
  - Exit 0 (`eslint .`).
- `git diff --check`
  - Exit 0; only Git's existing LF-to-CRLF working-copy warning was printed.

## Notes

- No branch or worktree was created, switched, reset, renamed, or force-updated.
- No commit was amended and nothing was pushed.
- The focused Electron build emitted the existing Lucide `"use client"` bundling warnings and Playwright's `NO_COLOR`/`FORCE_COLOR` warning; tests and build still exited successfully.
