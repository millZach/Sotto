# Show a thread setting the moment it is pressed

Issue #319. Branch: `perf/319-pending-settings`. Mock-up: `docs/prototypes/permission-pending-prototype.html` on the
`prototype/permission-pending` branch.

## What was asked

The model and permissions chips showed the provider's confirmed value and went dead, with "Saving...", until the
provider answered, so every millisecond of the settings path was visible in them. The effort chip already showed
the level pressed. #319 asks for all three to show a press at once, to coalesce presses made while one is saving,
and to put the chip back when the provider refuses. Permissions need more than that: until the provider confirms,
the mode already in force still decides what it does on its next tool call, so a pending permission has to read
differently from an effective one. That look was not settled, so it went to a mock-up first.

## What was chosen

The mock-up offered three variants beside "Now", which showed today's behaviour for comparison:

- **A, Caption.** The chip shows the new choice at once, with a dashed outline in the activity colour and a small
  pulsing dot. A line beside the chips says what is still in force.
- **B, Both.** The chip carries the change itself, the old value struck through, until the provider confirms.
- **C, Notice.** The chip shows the new choice with a clock mark, and a status notice above the composer says what is
  in force and what is coming.

In every variant a refusal puts the chip back and an alert under the chips says so, with **Try again**. Zach chose
**A** (issue #319, comment of September 26, 2026). Model and effort show the pressed value with no pending mark: they
change what the next turn is, not what the provider may do without asking.

## Three outcomes after a press

- **Confirmed.** The chip reads normally once the window draws the provider's answer.
- **Refused.** The provider answered and did not take it, or main refused it before the provider heard anything. The
  chip goes back to the value in force, and a line under the composer's row says so, with Try again.
- **Unconfirmed.** The provider never gave a result: a lost answer (#317) or a result it did not report. Main keeps the
  change for the thread's next start, holds it in its outbox and takes no other action on the thread until it knows.
  So the chip keeps showing the choice with the same pending mark, the chips are fixed, and a line under the row says
  what happened and what comes next, with nothing to press. It clears when the thread shows the choice, which the next
  start carries, or when main lets the change go without it, and the chip then shows what the thread reports. This
  stays inside variant A: the dashed edge and dot already mean "not confirmed yet", and the line under the row is the
  refusal's place. Main now publishes the changes it keeps this way (`AgentState.unconfirmedSettings`), so the chips
  read it from state rather than from the wording of an error.

## Wording

- The caption names the mode in force, as the provider doing it, because that is what the next tool call runs
  under: "Claude Code still asks for approval until it confirms.", "... still makes edits without asking ...",
  "... still decides what to ask you about ...", "... still runs anything without asking ...". A thread with no mode
  chosen reads "Codex keeps its own default until it confirms." A provider with modes of its own names the mode:
  "Devin stays on Ask first until it confirms." The provider is named as Sotto names it everywhere else
  (`PROVIDER_LABELS`: Claude Code, Codex, Grok Build, Devin), or by the model's provider where a thread has none.
- "Makes edits without asking" is Allow edits on every provider: Claude's accept-edits mode and Codex's workspace
  write with approval on request both edit without asking and still ask before commands. "Decides what to ask you
  about" is Auto: Claude's auto mode and Codex's automatic reviewer both decide per call, so the caption says the
  deciding is theirs rather than promising either answer.
- The chip is described by the caption itself, so a screen reader hears the words on screen, once: the caption is a
  status region announced when it appears, and focus is already on the chip by then. In the unconfirmed state the chip
  is described by the line under the row instead.
- A refusal leads with what did not happen: "Claude Code did not switch to Full access." Then:
  - When main's answer is the plain refusal (`PROVIDER_REJECTED_ACTION`, a shared constant): the provider answered
    and did not take it, and nothing is left to reconcile, so "The thread stays on Ask for approval; nothing else
    changed."
  - Any other reason, main's or the provider's, follows the lead as it is, with nothing claimed beside it.
  - No answer came back to the window: "Sotto did not get Claude Code's answer about Full access, so the chip shows
    what the thread last reported. Try again to send it once more." The words ask for the press the button makes.
- An unconfirmed change leads with "Claude Code has not confirmed Auto." Then the provider's own account where it
  gives one, such as #317's lost answer: "Claude Code did not confirm the settings change, so Sotto stopped this
  thread's session, and "npm test" stopped with it. The session starts again with the new settings the next time you
  use the thread." Where main has only its general sentence (`PROVIDER_RESULT_UNCONFIRMED`,
  `THREAD_SETTINGS_UNRECONCILED`), it says instead: "The thread starts on Auto the next time it is used, and Sotto
  checks it then." Never "did not switch", and no Try again, since main refuses anything else on the thread until it
  knows.
- Model and effort use the same sentences with the model's name or "Max effort".
- "Saving..." is gone, and no chip is disabled by its own save.

## How it was built

`src/renderer/src/agents/pendingSettings.ts` holds, per thread and per setting, the press (desired) against what the
window last drew from main's published state (confirmed). A press shows at once and is sent; a press made while that
setting's save is in flight waits, and only the last one is sent when the save answers. The mark stays while a save is
in flight even when the press is back on the value in force, because that save may still land first. A refusal lets go
of the press and is kept per setting, so a press on another chip leaves it; a new press of that setting, or the thread
showing the value after all, clears it. A confirmed press is held until the window draws the value main answered with,
not only until the reply lands, because a reply can arrive before the broadcast that carries it (#306); a four-second
hold lets go if something newer moved the setting first. The store is keyed by thread rather than by the composer, so
a press belongs to the thread it was made on and a pane that remounts still shows it; it lets go of threads the state
no longer has. The effort chip's own save loop moved into the store.

Nothing in the window gates a send: main's thread lane (#311) runs a thread's settings and its prompts in the order
they arrive, so a prompt sent while a press is pending runs on the pressed settings.
`tests/unit/renderer/agentCommandLanes.test.tsx` proves it through the chip over a real coordinator.

The chips are fixed by what a provider refuses: a turn under way, an unanswered request, an archived thread, a
provider that is gone, a prompt still on its way to the provider (a delivery queued, submitting or unconfirmed), and a
settings change main keeps unconfirmed. They no longer read the coordinator's busy mark, which covers the very save a
press starts.

The lines under the chips go in a row of their own that the composer places under its whole footer row, so the attach
button, the chips and the send button stay exactly where they sit without them. The pane's own error line leaves a
settings refusal or an unconfirmed change to that row.
