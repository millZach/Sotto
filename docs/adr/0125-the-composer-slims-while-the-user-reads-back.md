# The composer slims while the user reads back

## Status

Accepted October 23, 2026, as an Owl feature (`composer-shrink`). The user picked B, "slim line only", of `docs/prototypes/composer-shrink-prototype.html`, and that a draft keeps the composer full; for Watcher's room, the same slim line (`docs/prototypes/watcher-floating-composer-prototype.html`). Builds on the floating composer (#1391) and [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md) (Owl features). **Number provisional until merge** (docs/agents/domain.md).

## Context

The thread composer floats over the transcript's foot, so the thread runs on under it. A full composer is a card about 130 pixels tall with its options row and the line under it. While the user reads back through a long thread, that card covers the words they are reading for no reason: nothing is being written. T3 Code shrinks its composer to a slim line in the same situation.

## Decision

**1. A floating composer with nothing in it slims while the user reads back.** When the transcript is read more than 160 pixels above its end, the composer has no focus, and there is no draft (no text and no attachments), the card becomes the **slim composer**: one line of message box with its disc beside it, the send, queue or stop disc whichever the composer offers. The options row (attach, model, effort, permissions), the branch toolbar and the line under the card step away. Only a floating composer slims: not while a question waits, which stacks the composer, and not under a new thread's greeting.

**2. It comes back full** when the user scrolls back within 160 pixels of the end, clicks it, Tabs into it, types (a printable key pressed in the transcript goes to the composer), or a draft appears by paste, drop or dictation. A draft keeps it full while reading back. A press on the slim disc acts where it stands and does not bring the composer back, so the disc does not move from under the pointer.

**3. The transcript does not move.** The composer keeps the full card's room while slim, so the transcript's size and its padding stay as they were: its last line still comes clear at the end, and slimming never moves the reader back across the 160-pixel line. **Jump to latest** sits just above whichever height shows.

**4. Motion.** The card moves between the two heights over 200 milliseconds; with reduced motion it changes at once. Nothing is announced; the textbox and the disc keep their names.

**5. Cost.** The transcript tells the pane only when the reader crosses the line, never on each scroll, so a scroll does no React work of its own.

**6. Stable shows nothing of it.** The renderer asks `useOwlFeature('composer-shrink')` before slimming and before a key in the transcript goes to the composer; in Watcher's pane it asks for Watcher too. With the feature off the composer keeps its full size and a key pressed in the transcript stays there. Main has no part.

## Consequences

- `CONTEXT.md` names the **slim composer**. The design captures do not change: they show composers at the end of their transcripts.
- Watcher's night scene lays itself out by the full card's place while the composer is slim, so the scene does not move as it changes ([ADR-0126](0126-watchers-conversation-runs-over-a-still-night-scene.md)).
- Sending the feature to stable flips its entry's `sentToStable`.
