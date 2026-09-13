# Phase 3 review UI fixes

Two Spec review P2 findings (`../phase3-orchestration/spec-review-result.md`, findings 2 and 3), fixed in the existing
design. Target: the desktop app window (pointer and keyboard), reviewed at 1280px and 820px wide as the brief requires.
Phone layouts are out of scope for a desktop Electron app.

## Findings

1. **Compact view loses the arrangement switch.** `ThreadPanes.tsx` rendered the grid/row switch only while panes were
   placed. Four panes fit a grid at 1200×700; choosing Single row needs 1627px, so the view went compact and the only
   switch disappeared. Returning to the grid meant widening the window or closing panes.
2. **Structured forms hide the native explanation.** `AgentRequestCard.tsx` rendered only the question count and the
   fields for a structured request. Codex MCP elicitation keeps its request-level `message` in `request.text`, separate
   from field descriptions, and no transcript repeats it, so the form's purpose was lost along with its tool context.

## Tastify acceptance checks

Scoped edit: the established pane chrome and request card identity are kept; no new direction, so the reference is the
existing app (the permission card's head, tag and context blocks; the placed-pane controls).

- **Concept.** Compact view: the shown pane keeps the same arrangement toggle it had while placed, beside Close, so the
  grid is one click away. Form: the card opens with the provider's own reason for asking, then its fields.
  Verify: the compact capture shows the toggle beside Close; the form capture shows the explanation above the first field.
- **Composition.** The toggle sits in the existing `thread-pane__controls` cluster at 32×34px; it must not overlap the
  pane title, crumb, header actions or the tab strip, and the composer must be untouched. The explanation uses
  `agent-request__text`, placed between the head and the first field; tool context uses the permission card's tag and
  `agent-request__command`/`__cwd`/`__details` blocks. Verify by bounding-box checks and by reading the captures at 1280 and 820.
- **Type and color.** No new sizes or colors: explanation 16px `--tt-text-2` as the plain question text; tag 12px
  pill; controls 16px icons. Verify in CSS diff (no new font sizes) and captures in light and dark.
- **Copy.** One label per control: the toggle keeps its accessible name "Single row" with a pressed state and its
  title. No new visible copy on the pane. The card adds no Sotto-written line: the explanation is exact provider text,
  shown once, and hidden when it only repeats the question prompts or choices. Verify with tests for exact text,
  duplicate suppression, and by reading every line of the captures.
- **Motion.** None added. Inapplicable: both fixes restore content and a control; no transition is introduced.
- **Rendered review.** Full app at 1280 and 820: grid → row → compact → grid, light and dark; threaded and personal
  structured forms at 820 in light and dark, including a short window where Send stays reachable. Every capture is
  opened and read before this document records a result.

## Changes

- `src/renderer/src/agents/ThreadPanes.tsx`: the arrangement switch (accessible name "Single row", pressed for a row)
  is rendered on the focused pane while panes are placed, as before. It is also rendered on the shown pane when the
  window alone makes the view compact (`narrow`). A zoom-only single view does not get it, because it already has
  "Show all panes". The status announcement says "Panes arranged in …" when the chosen arrangement fits and "Panes will
  be arranged in … when there is room" when it does not. `data-count` now counts only the controls actually rendered, so
  the header padding follows the visible buttons. No CSS change was needed.
- `src/renderer/src/agents/requests/AgentRequestCard.tsx`: the structured form's head carries the `context.toolName`
  tag, as the permission card's head does. A new `FormContext` goes between the head and the first field. It shows the
  explanation (`agent-request__text`), `context.command`, `context.cwd` and `context.details` (skipped when it serialized
  to `{}`), all using the existing permission and plain-question classes. `requestExplanation(request)` returns
  `request.text` exactly, or null when the text only restates the questions. The test: remove every prompt, header and
  choice label (whitespace-collapsed, longest first); if only whitespace, `N.` numbering and `( ) / ; ,` remain, it is a
  restatement. No change to answer state, store calls, props, `requestAnswers.ts` or `requests.css`.

## Red/green

- `tests/unit/renderer/splitWorkspace.test.tsx` › "keeps the arrangement switch when a single row goes compact…"
  (1200×700 pane area, four panes). With `ThreadPanes.tsx` swapped back to `HEAD`, it fails with
  `Unable to find an accessible element with the role "button" and name "Single row"`. With the fix it passes. It also
  checks:
  - hidden panes have no switch;
  - the compact controls are exactly [Single row, Close];
  - keyboard focus stays on the switch;
  - the grid's row divider value (45) comes back;
  - drafts are kept and no thread command is sent.
- `tests/unit/renderer/requests/agentRequestCard.test.tsx` › "native request explanation and tool context" (3 tests).
  Before the card change, the first test failed because the explanation paragraph was missing
  (`Cannot read properties of null`), and the other two failed because `requestExplanation` did not exist. The payloads
  come from the real provider mappers (`pendingRequest` for Codex elicitation and `item/tool/requestUserInput`,
  `claudePending`, `grokPending`), so the duplicate rule is held to each provider's actual `text`. The tests assert:
  - the native message is absent from every field description and from `context`;
  - it appears once, exactly (with its line breaks), before the first fieldset;
  - the tool tag shows, and `{}` details are hidden;
  - choices, Optional markers and the single send are unchanged;
  - text that Claude, Codex user-input and Grok build from their prompts gets no second copy, and neither does a Codex
    message equal to a field description;
  - a message that quotes a prompt and adds to it is kept;
  - command, folder and details are shown.

## Verification

- Unit, run 1: `splitWorkspace.test.tsx` (25), `agentRequestCard.test.tsx` (23) and `threadRequestSurroundings.test.tsx`
  pass, 54/54. Run 2: `personalChatsView.test.tsx`, `threadRequestSurroundings.test.tsx` and `threadsView.test.tsx`
  pass, 46/46.
- `tsc --noEmit -p tsconfig.node.json` and `-p tsconfig.web.json` pass. ESLint on the five touched source and test files is clean.
- Own build in this worktree (`electron-vite build`, runtime `.wasm` copied from main). The new Electron spec
  `tests/e2e/phase-three-review-ui-fixes.spec.ts` passes 2/2. The existing neighbours `pane-layouts`, `split-workspace`,
  `phase-three-requests` and `phase-three-personal-requests` pass 5/5.
- Screenshots those neighbour specs rewrote were restored or deleted and are not part of this change. Two of them now
  differ, as expected, and both were inspected: `phase-three-layout/five-row-compact-1600` shows the switch beside Close,
  and the `phase3-requests-workshop-form` fixture's separate `text` ("Settings page questions") now shows as its explanation.
- Not run: full unit or E2E suites, native providers, macOS.

## Tastify results

Captures are in `artifacts/phase-three-review-ui-fixes/`. Every listed file was opened and read at displayed size, after
the final run that produced it.

- **Concept.** `panes-row-compact-1280-{dark,light}`: four tabs across the top. The shown pane's header ends with Manage,
  Settle, Stop agent and Tools, then the grid switch (pressed) and Close. `form-threaded-codex-820-*`: "3 questions ·
  mcpServer/elicitation/request", the two-line native message, then "Channel — Where should the notes go?". Pass.
- **Composition.**
  - The Electron checks measure the shown pane's controls against the title text, crumb, every header action, the tab
    strip and the composer. They run at 1280 (grid, compact row, returned grid) and 820 (compact grid, compact row).
    Nothing overlaps beyond a 4px graze, and every control is 32×34.
  - At 1280 compact the switch sits on the actions row, about 30px right of Tools. At 820 it sits on the title row, with
    the actions wrapping below (`panes-*-compact-820-*`).
  - Observation, recorded but not changed: in the placed grid at 1280 (behaviour this change does not touch), the focused
    pane's four-control hit box meets the header's last action (Tools) by about 2×3px. The icons do not touch in
    `panes-grid-1280-*`.
  - The form reads head → explanation → fields → footer. At 820×560, keyboard focus on Send brings it fully into view
    above the composer, in both the threaded and the personal chat (asserted with `elementFromPoint`; the threaded state
    is captured in `form-threaded-codex-send-820-*`).

  Pass.
- **Type and color.** No new sizes, colors or CSS. The explanation uses the plain question's 16px `--tt-text-2`. That is
  one step quieter than the 16px `--tt-text` field prompts, so the fields stay the focus. The tag is the existing 12px
  pill. Both themes read cleanly in every capture. Pass.
- **Copy.** Pane: no new visible text. The switch keeps one accessible name and its title, and the status line is state
  feedback. Form: the only added lines are provider text (the explanation) and the tool name. In
  `form-threaded-codex-820-*`, "publishing target" appears once and no field repeats the message. In
  `form-threaded-claude-820-*`, there is no explanation because Claude's `text` is its prompts, and "Which layout should
  the settings page use?" appears once. Pass.
- **Motion.** Inapplicable: nothing animates in either change.
- **Rendered review.** Full app with the design-threads fixture:
  1. At 1280: grid → Single row (compact) → Enter back to the grid.
  2. At 820: both arrangements are compact. Space toggles the switch, and the announcement says the change will apply
     when there is room.
  3. Back at 1280: the grid and its 45% row split return.

  Captures, each in dark and light (18 files): `panes-grid-1280`, `panes-row-compact-1280`, `panes-grid-returned-1280`,
  `panes-grid-compact-820`, `panes-row-compact-820`, and the forms `form-threaded-codex-820`,
  `form-threaded-codex-send-820`, `form-threaded-claude-820`, `form-personal-codex-820`. In the personal chat, the answer
  was then sent once and accepted.

## Limits

- At 820 the pane area cannot hold a 2-by-2 grid either (a grid needs 809×609). So at 820, "grid → row → compact → grid"
  only changes the retained arrangement; the grid itself returns after widening, which the journey checks.
- Request payloads are real mapper output from synthetic native frames, not from a live Codex MCP server.
- The personal chat's Send reachability is asserted but not captured.
