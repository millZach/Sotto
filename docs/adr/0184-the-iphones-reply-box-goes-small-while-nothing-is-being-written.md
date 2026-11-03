# The iPhone's reply box goes small while nothing is being written

## Status

Accepted November 2, 2026, going straight to stable. The user asked for it from Codex's iPhone app ("the composer shrinks like the picture than expands to normal size when you click in it to type something") and picked from `docs/prototypes/iphone-small-reply-box-prototype.html`: iPhone and Duo only; light A at the top effort; Watcher's box by the same rule; a tap on the conversation puts an empty box's keyboard away. Builds on the iPhone's reply box (#1994, #1946). **Number provisional until merge** (docs/agents/domain.md).

## Context

A full reply box is a card about 88 points tall, and on a phone it covers what the user is reading for no reason while they aren't writing. The desktop's **slim composer** (ADR-0125) steps down in the same spirit, but only while the user reads back. On a phone the box costs more, and Codex keeps it small whenever a thread has anything in it.

## Decision

**1. Small unless the user is writing.** In a thread that has content or is running, and in Watcher's conversation, the reply box is the **small reply box**: one row of the +, the prompt, the mic, and Send or Stop. It stays small at any scroll position, not only while reading back. The prompt keeps its words ("Reply to this thread", "Reply while it works"). The model pill steps away, so changing the model starts with a press on the box.

**2. What keeps it full.** The caret in the box; words, photos or files in it; the mic listening; a reply's photos being made ready; a settings line over the box (a permission change still waiting, a refused one, or Watcher's next-turn choice). A new empty thread stays full: it has nothing to read. The accessibility text sizes stay full, since one row can't hold the prompt at those sizes.

**3. How it comes back.** A press anywhere on the box beside its buttons puts the caret in it, and it returns to full with the keyboard. The mic brings it back too, since its words land there. The + opens its menu where it stands and the box stays small until something is attached. Stop acts where it stands.

**4. How it goes small.** When the keyboard goes away with nothing in the box. A tap on the conversation now puts an empty box's keyboard away, and a tap on a link or a button still does that thing instead. With something in the box a tap leaves the keyboard up, as before.

**5. Nothing else moves.** The two sizes are the same views, with nothing laid out again: the card keeps its full room, the words are offset into the row, and the top edge comes down. So the dock's height stays what it was, and with it the conversation's inset and scroll position, the page's following and whatever stands over the box. At the very end of a thread that leaves about 38 points of open room above the small box. The foot of the box and the row's buttons stay where they stood, so a press never lands on something that moved (the user's rule on the desktop, October 24, 2026: "no movement other than the shrink of the composer").

**6. Motion.** 0.2 seconds, as ADR-0125, on the box's own animation rather than the keyboard's: tied to the change in size, the words and the top edge jumped on the way up and kept the keyboard's curve on the way down (recordings, November 2, 2026). The pill leaves before the words reach it and comes back after they have gone. With Reduce Motion it changes at once.

**7. The light.** No edge in any state, as the box has always had. At the top effort the same light goes round the small box: line and glow, one lap every nine seconds (ADR-0019). It follows the top edge as it moves.

**8. Cost.** Which size the box shows is decided inside the dock, from what the dock already watches. The conversation passes one yes or no, whether the thread can go small, and the dock is drawn again only when that changes. Moving the box draws no part of the conversation: `apps/ios/Scripts/bench-summary.py` holds that to a budget of zero.

**9. iPhone and Duo only.** The desktop keeps its slim composer.

## Consequences

- `CONTEXT.md` names the **small reply box**, separately from the desktop's **slim composer**, since their triggers differ.
- The settings pill's press is one press further away on a thread with content.
- The journeys that read the pill over and over pass `--ui-reply-box-stays-full`, so they stay about the pill. Three journeys read the small box itself.
- A long prompt in a narrow row truncates. If a translation is long enough to wrap at full width on a narrow phone, coming back full grows the dock by that line, as a second typed line does.
