# Final Repair 4: Visibility-Generation Protocol

## Commit

- Implementation commit: `e925fde` (`fix: bind widget IPC to visibility generations`)
- Base commit: `e89cc38a46ceefb89f696ee83c8afddfd4a602ef`
- Branch: `fix/window-controls-pill-drag`

## Protocol semantics

- The main process owns a monotonically increasing, non-negative safe-integer widget visibility generation.
- A real show transition and a hide transition, including cancellation of an in-flight reveal, advance the generation. Repeated show calls while already visible and repeated hide calls while already hidden do not create false transitions.
- `WIDGET_VISIBILITY` now carries the strict object `{ visible, generation }`.
- The renderer stores the latest received generation and republishes its current presentation whenever that generation changes, even if the presentation value is unchanged.
- `WIDGET_PRESENTATION` now carries the strict object `{ presentation, generation }`. Main accepts only reports whose generation equals its current generation.
- A current hidden-generation presentation report updates the remembered presentation without resizing the hidden native window. A show first applies that remembered presentation, then accepts and reconciles the renderer's show-generation republish.
- Drag start, move, and end reports carry the gesture's captured visibility generation. Main rejects a stale generation before touching drag ownership, native bounds, monitor state, or cleanup state.
- The renderer still coalesces drag moves with `requestAnimationFrame`, while the main process still computes movement from Electron-DIP cursor and native-window origins.
- Idle hover and expanded state reset on concealment. Active presentation remains remembered across temporary concealment. Presentation changes continue to reconcile the footprint during an active drag. Cursor-monitor relocation pauses only while valid drag ownership exists, and terminal cleanup remains idempotent.
- Preload and main IPC boundaries use shared strict schemas. Missing, negative, fractional, and extra-field generations are rejected, while trusted widget-sender authorization remains unchanged.

## RED evidence

Command:

```text
npm test -- --run tests/unit/main/windowManager.test.ts tests/unit/renderer/widgetApp.test.tsx tests/integration/ipc.test.ts
```

Observed before production edits:

- 3 test files failed.
- 8 regressions failed for the expected missing protocol behavior:
  - delayed old-generation active presentation after hide/show;
  - current hidden-generation idle presentation before reveal;
  - current show-generation active resynchronization;
  - delayed old-generation drag start/move/end;
  - unchanged presentation republish on generation change;
  - one-generation binding for all renderer drag phases;
  - strict preload visibility/presentation/drag validation;
  - strict main IPC presentation/drag validation.
- The remaining 259 focused tests passed.

## GREEN evidence

Affected tests:

```text
npm test -- --run tests/unit/main/windowManager.test.ts tests/unit/renderer/widgetApp.test.tsx tests/unit/renderer/widgetDragGesture.test.tsx tests/integration/ipc.test.ts tests/integration/nativeRendererRecovery.test.ts
```

Result: 5 files passed, 289 tests passed, 0 failed.

Type checking:

```text
npm run typecheck
```

Result: passed (`tsc --noEmit` for both node and web configurations).

Lint:

```text
npm run lint
```

Result: passed (`eslint .`).

Patch validation:

```text
git diff --check
```

Result: passed. Git emitted only the repository's existing LF-to-CRLF working-copy warnings for the drag gesture source and test.

## Files

Production:

- `src/shared/contracts.ts`
- `src/preload/index.ts`
- `src/main/ipc/registerIpc.ts`
- `src/main/windows/windowManager.ts`
- `src/renderer/src/widget/WidgetApp.tsx`
- `src/renderer/src/widget/useWidgetDragGesture.ts`

Tests:

- `tests/unit/main/windowManager.test.ts`
- `tests/unit/renderer/widgetApp.test.tsx`
- `tests/unit/renderer/widgetDragGesture.test.tsx`
- `tests/integration/ipc.test.ts`
- `tests/integration/nativeRendererRecovery.test.ts`

## Follow-up: per-gesture drag ownership

### Protocol repair

- Every renderer drag phase now carries a renderer-generated non-negative safe-integer `gestureId` in addition to the visibility `generation`.
- The renderer uses one `gestureId` for start, coalesced moves, terminal flushes, and end, then allocates a different ID for the next gesture.
- Main retains the visibility generation as the outer epoch and requires both generation and gesture ID to match active ownership before applying a move or accepting an end.
- A repeated start in the same visibility generation can replace ownership, while a delayed end from the earlier gesture can no longer clear or snap the replacement gesture.
- Strict preload and main IPC validation now rejects missing, negative, fractional, and extra-field gesture identifiers.

### RED evidence

Focused main-process regression:

```text
npm test -- --run tests/unit/main/windowManager.test.ts -t "ignores a delayed end from an earlier gesture in the current visibility generation"
```

Observed before production edits: 1 failed, 101 skipped. The replacement gesture's move made 0 `setPosition` calls after the delayed earlier end cleared ownership.

Focused renderer and IPC regressions:

```text
npm test -- --run tests/unit/renderer/widgetDragGesture.test.tsx tests/integration/ipc.test.ts -t "renderer-generated gesture ID|strictly validates generation-bound|creates a frozen least-privilege widget surface"
```

Observed before production edits: 3 failed, 123 skipped. Renderer phases had no gesture ID, and strict preload validation rejected the new valid gesture-ID payloads.

### GREEN evidence

Directly covering tests:

```text
npm test -- --run tests/unit/main/windowManager.test.ts tests/unit/renderer/widgetApp.test.tsx tests/unit/renderer/widgetDragGesture.test.tsx tests/integration/ipc.test.ts tests/integration/nativeRendererRecovery.test.ts
```

Result: 5 files passed, 291 tests passed, 0 failed.

Type checking:

```text
npm run typecheck
```

Result: passed (`tsc --noEmit` for both node and web configurations).

Lint:

```text
npm run lint
```

Result: passed (`eslint .`).

Patch validation:

```text
git diff --check
```

Result: passed. Git emitted only the repository's existing LF-to-CRLF working-copy warnings for the drag gesture source and test.
