# Held action verification

September 21, 2026. The hourglass pose for ADR-0021, on `sotto/2532e8a8` from `main` at a2475d68.

## What was built

A thread whose live turn has been held on one running action for twenty seconds or more shows the
creature above its composer holding an hourglass, with the command and how long it has run. The rule is
`heldAction` and `heldLongEnough` in `threadActivityView.ts`: the live turn's newest running record, of
kind `command`, `tool` or `subagent`, carrying a `startedAt` at least `HELD_AFTER_MS` (20,000ms) old.
Reasoning and planning are excluded as the model working rather than waiting. No assistant text is read,
no provider lifecycle event is required, and nothing is persisted or restored.

Because the rule reads the `activities` every adapter writes, the pose is provider neutral: Codex, Grok
Build and Devin threads get it, which the Claude-only monitoring walk cannot offer. A confirmed monitoring
task outranks it, through one `ornamentAllowed` flag in `ThreadPane` that also carries every existing
suppression: pending request or question, coordinator block, error, closed thread, disconnect, turn ended.

`useHeldAction` crosses the threshold on a single `setTimeout` for the time remaining, not a poll, and
re-renders once. The elapsed figure then counts up inside its own element, so a waiting thread never
re-renders its transcript to show a clock, and the clock is `aria-hidden` so a live region does not
announce a number every second. A fixed clock (the `design-threads` capture) answers from that clock and
schedules nothing, which is why `now` now reaches `ThreadPane` from `ThreadsView`.

Both poses share `usePixelLoop`, which keeps the existing 30fps throttle, the single held pose under system
or app reduced motion, and the stopped loop while the window is hidden. The monitoring creature's own paths,
walk cycle and behaviour are unchanged.

## Design source

Zach reviewed `docs/prototypes/waiting-creature-prototype.html` — the shipped walk beside three waiting
poses (sit-down, foot-tap, hourglass), each against seven thread states — and chose the hourglass. He then
scoped it to long-running work rather than a pending request, and agreed the twenty-second threshold. The
prototype is throwaway, and is kept beside the effort ones as the primary source for the pick.

The first implementation of the sprite was wrong and was caught by looking at it: the glass overlapped the
body, and a 28%-opacity vessel in the activity colour over a solid body in the same colour was invisible.
The glass now sits clear of the body (which reaches x=28) on an outstretched arm, and its caps and tapering
walls are drawn last in the text colour, so the outline holds the shape against body or surface alike —
the same trick the loupe's ring uses. Magnified frames were inspected before and after.

## Validation

- `npm run typecheck`, `npm run lint`, `npm run notices:verify` (174 components): passed.
- `tests/unit/renderer/heldOrnament.test.tsx`, 5 tests: the threshold crossing on the hook's own timer
  with no new host state, the already-past case, a new action restarting the wait, ineligibility and the
  held clock scheduling nothing, and the timer being cleared when the action ends.
- `tests/unit/renderer/threadActivityView.test.ts`, 19 tests: the kind filter, the missing start, the
  finished action, the idle thread, following the newest running record, and the label's fallbacks.
- `tests/e2e/thread-held.spec.ts`, 2 scenarios: the lifecycle (nothing under the threshold, nothing for
  reasoning however long, the crossing on its own timer, the draft surviving, the creature instance
  surviving the clock's updates, monitoring outranking it, and question, permission, turn end and
  disconnect each clearing it) and the appearance (dark and light, 1600x1000, 1280x800 and the 820x560
  minimum, a long command ellipsizing, text at 4.5:1 or better, and both reduced-motion settings holding
  one pose). Captures in `artifacts/held-action/`.
- `tests/e2e/thread-monitoring.spec.ts`, 3 scenarios: passed unchanged, so the walk did not regress.

The hook's timer path was proved in the unit test before the end-to-end one passed. The first end-to-end
run failed there, and the cause was the test rather than the feature: `mergeAgentActivities` keeps the
first `startedAt` it saw for a record ID, so reusing one ID measured every wait from the first injection.
Each injection is now its own record, which is also what a real new command is.
