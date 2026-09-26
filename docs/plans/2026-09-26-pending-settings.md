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
- The chip's accessible description says both ends: "Switching to Full access. Ask for approval stays in force until
  Claude Code confirms." The caption is a status region, so it is announced when it appears.
- A refusal leads with what did not happen: "Claude Code did not switch to Full access." Then:
  - When main's answer is the plain refusal (`PROVIDER_REJECTED_ACTION`, now a shared constant): the provider answered
    and did not take it, and nothing is left to reconcile, so "The thread stays on Ask for approval; nothing else
    changed."
  - Any other answer is main's or the provider's own sentence, and it follows the lead as it is. It may say that
    something else did change: #317's lost answer stops the session and names the background work that stopped with
    it. So nothing is claimed beside it, and never "nothing else changed".
  - No answer at all (the connection failed): "Sotto could not confirm Full access with Claude Code. The chip shows
    what the thread last reported; check the connection before trying again."
  - Model and effort refusals use the same sentences with the model's name or "Max effort".
- "Saving..." is gone, and no chip is disabled by a save in flight.

## How it was built

`src/renderer/src/agents/threadSettings.ts` holds, per thread and per setting, the press (desired) against what the
window last drew from main's published state (confirmed). A press shows at once and is sent; a press made while that
setting's save is in flight waits, and only the last one is sent when the save answers. A refusal lets go of the press,
so the chip shows the value in force, and keeps main's sentence for the alert. A confirmed press is held until the
window draws the value main answered with, not only until the reply lands, because a reply can arrive before the
broadcast that carries it (#306); a four-second hold lets go if something newer moved the setting first. The store is
keyed by thread rather than by the composer, so a press belongs to the thread it was made on, and a pane that remounts
still shows it. The effort chip's own save loop moved into the store.

Nothing in the window gates a send: main's thread lane (#311) runs a thread's settings and its prompts in the order
they arrive, so a prompt sent while a press is pending runs on the pressed settings. `tests/unit/renderer/agentCommandLanes.test.tsx`
proves it through the chip over a real coordinator.

The chips are fixed only by what a provider refuses: a turn under way, an unanswered request, an archived thread, a
provider that is gone. They no longer read the coordinator's busy mark, which covers the very save a press starts. The
pane's own error line leaves a settings refusal to the alert under the chips.
