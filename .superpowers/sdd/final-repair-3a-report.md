# Final repair 3a

## Scope

- Ignore renderer presentation reports while the widget is hidden, so `hideWidget()` owns the next reveal's `idle-resting` reset.
- Reconcile presentation footprints while drag ownership remains active, preserving the expanded idle drag footprint, pausing cursor-monitor relocation, and rebasing the cumulative drag origin after native resize rounding.

## TDD evidence

- The initial regressions were added and run against pre-fix production code before the repair (session task #80): the late hidden hover restored the hovered footprint on reveal, and drag-time presentation changes performed no native resize.
- Additional vertical-edge RED command:
  - `npm test -- --run tests/unit/main/windowManager.test.ts -t "expands a vertical idle drag|shrinks a vertical active drag"`
  - Result: exit 1; 1 failed, 1 passed, 89 skipped. The resting report during drag caused a second resize; assertion expected one `88x124` idle-drag resize but received two calls.
- Focused GREEN command:
  - `npm test -- --run tests/unit/main/windowManager.test.ts -t "keeps a reveal idle-resting|expands a vertical idle drag|shrinks a vertical active drag"`
  - Result: exit 0; 3 passed, 88 skipped.

## Repair evidence

- Hidden presentation reports no longer mutate `widgetPresentation`; `hideWidget()` always resets it to `idle-resting`.
- A reveal after show, hover, hide, and late hover applies `{ width: 124, height: 54 }`, calls `showInactive` a second time, and has one 100 ms monitor timer.
- During a left-edge drag, `idle-hovered -> active` requests `88x248`; native origin rounding is read back and applied to the saved drag origin before the next cumulative cursor delta.
- During a left-edge drag, `active -> idle-hovered/resting` removes the `88x248` blocker but keeps the effective expanded idle footprint at `88x124` until drag end.
- Drag ownership remains active throughout presentation reconciliation, so the existing monitor interval stays allocated but cursor/display relocation work remains paused.

## Verification

- `npm test -- --run tests/unit/main/windowManager.test.ts tests/integration/nativeRendererRecovery.test.ts`
  - Result: exit 0; 2 files passed, 97 tests passed.
- `npm run typecheck`
  - Result: exit 0.
- `npm run lint`
  - Result: exit 0.
- `git diff --check`
  - Result: exit 0; only pre-existing line-ending conversion warnings for `src/main/windows/widgetPlacementMath.ts` and `tests/unit/main/widgetPlacementMath.test.ts`.

## Files

- `src/main/windows/windowManager.ts`
- `tests/unit/main/windowManager.test.ts`
- `.superpowers/sdd/final-repair-3a-report.md`

## Concerns

- Other pre-existing worktree changes are outside this repair and are intentionally left uncommitted.
