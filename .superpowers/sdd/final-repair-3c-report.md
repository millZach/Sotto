# Final repair 3c evidence

## Scope and deduplication

- The first three findings shared one root cause: presentation authority was not reconciled with the current visibility generation. They were repaired as one lifecycle change.
- The fourth finding was repaired independently by retaining and polling a pending drag-time presentation resize.

## TDD evidence

Focused RED command, run before production edits:

`npm test -- --run tests/unit/main/windowManager.test.ts -t "rejects a hover report|preserves an active presentation|uses an active presentation|retries a failed"`

Result: exit 1; 1 file failed; 5 tests failed and 91 were skipped.

Verified failures:

- A delayed hover report after the next reveal expanded the native window from `124x54` to `248x76`.
- Concealment discarded an active `248x88` footprint and reveal restored `124x54`.
- An active publication during the reveal gap was ignored, leaving `124x54` bounds.
- Failed drag-time expansion and shrink each made only one native resize attempt; the monitor did not retry while drag ownership remained active.

Focused GREEN command:

`npm test -- --run tests/unit/main/windowManager.test.ts -t "rejects a hover report|accepts a current hover|preserves an active presentation|uses an active presentation|retries a failed"`

Result: exit 0; 1 file passed; 6 tests passed and 91 were skipped.

## Repair

- `showWidget()` now marks the in-flight reveal generation, allowing a legitimate presentation publication during its asynchronous creation gap to become the bounds source for that reveal.
- `hideWidget()` resets only transient `idle-hovered` state; authoritative `active` state survives concealment and is restored without waiting for an unchanged renderer effect.
- Every post-concealment reveal carries a generation-bound hover resynchronization requirement. A delayed `idle-hovered` report is accepted only when the current native cursor position confirms that the widget is presently hovered; stale reports cannot relatch an off-cursor expanded footprint, while a real hover still expands normally.
- Drag-time resize failures set a pending flag. The existing 100 ms monitor retries only the presentation resize while drag ownership is active, without cursor-monitor relocation. Successful native size application clears the pending flag and preserves mixed-DPI origin rebasing.
- Pending reveal and drag state is cleared on hide, drag termination/failure, disposal, close, and renderer loss.

## Verification

- `npm test -- --run tests/unit/main/windowManager.test.ts tests/integration/nativeRendererRecovery.test.ts`
  - Exit 0; 2 files passed; 103 tests passed.
- `npm run typecheck`
  - Exit 0.
- `npm run lint`
  - Exit 0.
- `git diff --check`
  - Exit 0.

## Files

- `src/main/windows/windowManager.ts`
- `tests/unit/main/windowManager.test.ts`
- `.superpowers/sdd/final-repair-3c-report.md`

## Constraints observed

- Work remained on `fix/window-controls-pill-drag`.
- No branch or worktree was created, switched, reset, renamed, or force-updated.
- Existing commits were preserved; no commit was amended and nothing was pushed.
