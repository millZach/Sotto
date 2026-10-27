# The composer's controls are text buttons

## Status

Accepted October 23, 2026. Zach picked direction A, the quiet line, from `docs/prototypes/quiet-composer-prototype.html`, the mock-up made from his feedback on the composer after #1368: "look at how many pills we have there... same issue in Watcher... so they aren't just pills or what we changed too slapped everywhere". The research behind the three directions is `docs/research/2026-10-23-composer-controls.md`.

Amends ADR-0110 (containers are filled cards, and no control is a pill) for the composer only: its rule that composer chips are filled with 5px corners no longer holds inside a composer. Everywhere else, Settings and the continue strip included, an option chip stays a filled soft square. Amends ADR-0027 (the branch toolbar) on how its row looks and where its parts sit, not on what they do.

## Context

ADR-0110 made every control a soft square, but a busy thread's composer still showed about eight boxed controls: the model, effort and permission chips, Steer now, the branch toolbar's Run on, Workspace and branch, and on each queued message its own boxed Steer now beside its icons. Watcher's composer had the same: New Watcher, the model and the permissions. The boxes, not their corners, were what made the area loud.

## Decision

**1. In a composer, the option chips are text buttons.** A text button is its value and a small chevron, with no edge and no fill at rest; it keeps the 28px height so the hit area does not shrink, takes the hover wash (`--tt-hover`) while pointed at or open, and the focus ring from the keyboard. The model reads in the secondary text beside its provider's mark; reasoning, permissions and Watch are in the muted text. The effort word keeps its colourway at the model's top level, and the composer its outline (ADR-0019). A pending setting keeps its dashed edge in the activity colour while it is pending, since that edge is a status, not a box. The composer's host line (Runs on, for a thread outside a Git repository) loses its edge too.

**2. A narrow composer shows permissions as its shield.** Where the thread pane is 720 pixels or narrower, the 820x560 window included, the permissions button shows a shield instead of its words. The words stay in the button, hidden from the eye only, so assistive technology still reads the value; the button's name is unchanged, and its tooltip now says the value after it ("Thread permissions: Full access") at every width, so pointing at the shield reads it.

**3. Steer now in the composer is a text button in the accent**, semibold, beside Stop. No chord steers: Enter and Ctrl+Enter both queue while a turn runs (`composerKeys.ts`), so the button shows no shortcut, and none was added.

**4. The branch toolbar is one muted line of text buttons.** Run on, Workspace, the pull request badge and the branch picker follow each other under the card with their icons, a faint dot between them, 26px tall, no boxes. The badge and the picker no longer sit at the right; they follow the workspace on the same line, as the prototype shows, and wrap as one when the line has no room. Their menus, chords and names are as before.

**5. Queued messages have no card.** The queue hangs off a 2px rule in the accent at 60% above the composer, under a muted line that names the count and, while a turn runs and something waits, when it sends ("Queued 2 · sends when Claude Code finishes"). Each row is its words on one line, ending in an ellipsis, then Steer now as an accent text button with a small arrow, then move, edit and remove as 28px ghost icons. The wake-up row follows the same pattern.

**6. Watcher's composer follows.** New Watcher is a text button in the secondary text with its icon, and a faint dot parts it from the model. Unavailable, it keeps its muted words, dims its icon and underlines its words with dots instead of drawing a dashed edge.

What stays boxed: content the user put in the composer (a skill in the text, a review comment, a screenshot), the send and Stop discs, and anything outside a composer.

## Consequences

- The window's contrast checks now include muted, secondary and accent text on the card and the room under the hover wash, and the effort word on the composer's card.
- The design capture baselines change wherever a composer, its queue or its branch line shows, and are regenerated on the machines that hold them.
- The option chips' accessible names stay "Thread model", "Thread reasoning" and "Thread permissions". Each is a combobox, so assistive technology reads its value from its content after its name; the alert under the chips still finds a chip by that name.

## October 26 amendment: the queue is a tray with no edge

On October 25 the queue stopped hanging off the accent rule and became a tray tucked under the composer card: rounded top corners, inset from the card's sides, on a surface between the card and the pane, with a hairline round its top and sides. On October 26 Zach took the hairline off: the composer has no border or outline, and the tray follows it in every state, hover, focus, open and folded, light and dark. It stands apart from the pane through its surface alone. Its buttons keep their keyboard focus rings.

This replaces "hangs off a 2px rule in the accent at 60% above the composer" in decision 5. The rest of decision 5 holds: the muted line that names the count and when it sends, and each row's words, Steer now and ghost icons.
