# A column of ticks reaches every message the user sent

## Status

Accepted October 22, 2026. Zach asked for it through Watcher after using the Codex desktop app's version, and picked from `prototype/message-scrubber`: tick column A (evenly spaced, as Codex does it) set further out into the left margin and rising on a normal curve under the pointer, card B (square, with a clear border), the lane beside the column for Watcher's owls, and an Owl feature (`message-scrubber`).

## Context

A long thread is hard to move around in. The transcript draws its last 80 messages and keeps the rest behind Show earlier messages, and the thread store can hold more than the window has loaded (`earlierAvailable`). Messages off screen are laid out at an estimated height until the reader nears them (`content-visibility: auto`), so a position worked out from the page alone is wrong for anything not yet drawn.

What the user sent is the natural index: each message they sent starts a turn, and they remember what they asked better than what came back.

The transcript's left margin is empty on the Threads page. On Watcher's Conversation and Watched tabs the night scene's owl family (#1343) lives in both side margins.

## Decision

**1. One tick for each message the user sent.** A wake-up is Sotto's and a brief another thread delegated is that thread's (ADR-0061, ADR-0081), so neither has a tick. The ticks come from the thread's messages in the window, drawn or not; a message still only in the thread store has none until Show earlier messages loads it.

**2. It shows on long conversations only.** Three or more messages sent, and a conversation at least two screens tall or with messages above the first one drawn. Until the pointer or the keyboard reaches it the column is faint.

**3. Evenly spaced, centred, in the margin.** The ticks sit in one column centred on the transcript's height, 9 pixels apart, packed closer for a long thread down to 2. They live in a lane beside the column's left edge, up to 44 pixels wide, with an 18-pixel gap to the text; in a narrower margin the lane is the margin and the ticks are shorter, and a margin under 14 pixels shows no scrubber. The pointer anywhere in the lane reaches the nearest tick within 14 pixels. The ticks near it rise on a normal curve (sigma 16 pixels): the tick under the pointer is longest and brightest. The messages on screen are a step brighter.

**4. The card is the message and what came back.** Who sent it, when, and "Message n of N", then the message's opening, then the start of the turn's last reply. A reply that ends on a question shows the question; the newest message's open question shows its first three choices and counts the rest. Everything comes from what the window already holds, and nothing is fetched or sent to fill a card. The card repeats what the tick's accessible name says, so it is hidden from assistive technology.

**5. A press lands, drawn or not.** A tick for a message above the first one drawn widens the window to it first, then the message is put at the top of the transcript and marked for a moment, the way Show where it asked marks a reply. It is put back for a few frames while the messages around it are laid out for real. The reader stops following the end.

**6. The keyboard is designed, not inherited.** The column is one Tab stop, before the transcript, landing on the last message on screen. Up and Down move between ticks and show each card, Page Up and Page Down move five, Home and End go to the ends, Enter or Space goes there and puts focus on the message, and Escape closes the card, then returns to the transcript. No chord is claimed.

**7. Watcher's owls keep the lane clear.** The scrubber shows in Watcher's Conversation tab, through the same transcript. Watcher's night scene keeps the lane (`SCRUBBER_LANE_PX`) beside the column free, so the owls and the ticks never meet, and when the left margin is too narrow for its tree, its rail of eyes shows on the right only.

**8. Not on the iPhone, for now.** Nothing changes in host protocol version 1.

## Consequences

- With hundreds of messages sent the ticks are 2 pixels apart and the pointer picks among them only roughly; the keyboard still reaches each one.
- A turn whose question was answered on its card shows the reply that followed, not the question, because an answered request leaves no record in the thread's history.
- The night scene in #1343 has to read the lane when it lands; until it does, the two can overlap in the left margin.
