# iPhone Glow look verification

October 5, 2026, on `feat/iphone-glow-look` (PR #725), merged with `main` at 1594b4a5. Zach chose Glow from five
whole-app studies and thread version B from three, and approved `glow-refined.html` on `prototype/iphone-glow-redesign`.
The decision is ADR-0051. This machine cannot build iOS, so everything below comes from the macOS CI job: the SottoCore
and app-model tests, an unsigned simulator build, and the UI journeys on an iPhone SE (375 points wide) and an iPhone 16
Pro Max with Reduce Motion on and accessibility-large text, launched with the Debug-only `--ui-fixture` host.

## What the journeys did

All twelve journeys passed on both phones in run 37346410807, with the package suite at 246 tests, one skipped and none
failing; the Windows gates passed 7,373 tests. The captures below are from run 37339374448, the one before it, whose
only failure was the large phone's keyboard check reading its elements before they were found; the check now waits
for them, and the screens are unchanged.

1. **Threads** opens with the wash, the heading, **+**, the computer menu, the counts and search scrolling as one page
   (`se-threads-dark.png`, `se-threads-light.png`). The counts and the Needs you heading agree: one thread needs you,
   with two requests in it. Choosing Tropic repaints the wash, the **+** and the tab bar (`se-threads-tropic.png`). A tap
   outside search closes its keyboard, and so does a drag that scrolls the page.
2. **A thread** opens at its end: the last message, the steps between messages under their guide, the running step
   ticking above the reply box (`se-thread-bottom.png`). Its title, computer and project and the branch, +212 −48 and
   draft #721 chips sit above the first message and scroll away (`se-thread-top-keyboard.png`). The review message
   reads as a heading, separate list items, a numbered list and a code block with Copy, and `Ctrl+`` as a key; no
   element's text contains `**`.
3. **With the reply keyboard open**, the conversation's end stays above the reply box and the top stays one line
   (`se-thread-keyboard.png`).
4. **Answering a question** from the thread's sheet (`se-question-sheet.png`) leaves the conversation at its end, with
   "Answer sent." above the reply box (`se-question-answered.png`). This is the case Zach reported jumping to the top.
5. **New thread**: a tap six points inside the right edge of the Model box opens its menu
   (`se-new-thread-model-menu.png`), and Working copy offers Project folder and New worktree.
6. **Settings** shows Appearance and the six themes (`se-settings-top.png`), text size, density and the four alert
   switches, each off, with Play a sound waiting until an alert is on (`se-settings-notifications.png`). Compact density
   with a larger text step in Tropic light keeps the thread readable (`se-thread-tropic-light-compact-larger.png`).
7. **At accessibility-large text** on the Pro Max, Threads and the thread page keep their hierarchy without clipping
   (`promax-a11y-threads-dark.png`, `promax-a11y-thread-bottom.png`).

The captures cited are in `artifacts/iphone-glow-look/`.

## What this does not show

- **No journey answers on a Threads card.** That a card says Answered only for an answer whose own receipt confirmed it,
  and No longer waiting otherwise, is covered by the app-model tests, not a journey.
- **Alerts were not shown.** Turning a switch on raises iOS's permission prompt, which the journeys avoid; what counts as
  news is covered by `ThreadAlertsTests` and the model's `AlertModelTests` with a fake notification centre.
- **Closing the reply keyboard** by dragging it away is iOS's own interactive dismissal and is not driven by a journey.
- **A real iPhone and real computers.** The fixture stands in for the computers; delivery, live Git status and alerts
  on Zach's phone come through TestFlight after merge and are reported separately.
