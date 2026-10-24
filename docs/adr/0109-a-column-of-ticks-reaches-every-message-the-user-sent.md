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

**3. Evenly spaced, centred, in the margin.** The ticks sit in one column centred on the transcript's height, 9 pixels apart, packed closer for a long thread so the column always fits within the transcript's middle four fifths. A press goes to the tick whose card the pointer was showing, even where packed ticks overlap. They live in a lane beside the column's left edge, up to 44 pixels wide, with an 18-pixel gap to the text; in a narrower margin the lane is the margin and the ticks are shorter, and a margin under 14 pixels shows no scrubber. The pointer anywhere in the lane reaches the nearest tick within 14 pixels. The ticks near it rise on a normal curve (sigma 16 pixels): the tick under the pointer is longest and brightest. The messages on screen are a step brighter.

**4. The card is the message and what came back.** Who sent it, when, and "Message n of N", then the message's opening, then the start of the turn's last reply. A reply that ends on a question shows the question; the newest message's open question shows its first three choices and counts the rest, unless a wake-up or a brief came after it, whose question it then is. Everything comes from what the window already holds, and nothing is fetched or sent to fill a card. The card describes the tick it belongs to, so a screen reader hears the reply as well as the message, and it closes on Escape wherever focus is.

**5. A press lands, drawn or not.** A tick for a message above the first one drawn widens the window to it first, then the message is put at the top of the transcript and marked for a moment, the way Show where it asked marks a reply. It is put back for a few frames while the messages around it are laid out for real. The reader stops following the end.

**6. The keyboard is designed, not inherited.** The column is one Tab stop, before the transcript, landing on the last message on screen. Up and Down move between ticks and show each card, Page Up and Page Down move five, Home and End go to the ends, Enter or Space goes there and puts focus on the message, and Escape closes the card, then returns to the transcript. No chord is claimed.

**7. Watcher's owls keep the lane clear.** The scrubber shows in Watcher's Conversation tab, through the same transcript. While it shows, Watcher's night scene reads its lane (`measureRoom` finds `.message-scrubber`), keeps it clear like the room's words, and lays the left margin's tree, Watcher's owl, its owls and its rail out from the lane's outer edge, so the owls and the ticks never meet. When the left margin is then too narrow for the tree, the rail of eyes shows on the right only. Watcher's owl does not fly to the composer's left branch meanwhile, whose perch would put its head in the lane.

**8. Not on the iPhone, for now.** Nothing changes in host protocol version 1.

## Consequences

- With hundreds of messages sent the ticks are a pixel or two apart and the pointer picks among them only roughly; the keyboard still reaches each one.
- A turn whose question was answered on its card shows the reply that followed, not the question, because an answered request leaves no record in the thread's history.
- While a long conversation shows the scrubber, Watcher's tree stands up to 44 pixels further from the column, and its left margin holds a few fewer owls.

## October 24, 2026 amendment: every message sent, not only the window's

Zach found the scrubber cut off on long threads: a pane opens on the newest ten turns of the thread's store, so a long thread showed ticks for those alone, gained twenty more each time Show earlier messages was pressed, and dropped out of the page while a thread's messages loaded again. A scrubber that cannot reach the start of the conversation does not do what decision 1 says it is for. This amends decisions 1, 4 and 5 and the second consequence below them.

- **1. The ticks come from the whole thread.** Above the first message the window holds, main reads every message the user sent from the thread's store (`threadPrompts`, on the thread's own host), oldest first, a page of the newest 5,000 the user's role sent at a time, wake-ups counted, each naming the message the next page is read before; the window reads page after page back to the first. Each carries the first 400 characters of what was sent, how many files were attached, and the turn's last reply with words as its first and last 300 characters. Wake-ups are left out there, as the window leaves them unmarked, and a brief another thread delegated is left out by the window as before. It is read when the pane opens on a thread with earlier messages, and again only when the window starts somewhere the last read does not reach, or the thread's history has lost messages, as a reset does; a window widened by Show earlier messages needs no read, and its own ticks take over the messages it loaded. A window that slides down a turn as a new one arrives, or narrows as the pane comes back to the thread, needs none either: the turns it lets go keep the ticks they had in it. It is never published with the thread, so what each update carries does not grow with the history.
- **The scrubber stays while messages load.** While a thread's messages load again, and while the store is read again for a window that moved, the ticks it had stand, so the column neither empties nor jumps. A read that fails is tried again three times, four seconds apart. A host that cannot say, an older remote host among them, leaves the ticks the window holds.
- **4. A card above the window shows what the store carries.** The start of the message and of the reply, or the question the reply closes on, read from the start and end the store sent. Nothing more is fetched when a card opens.
- **5. A press on a message only the store holds loads the window back to it.** `load-earlier-messages` takes `throughMessageId`, which widens the thread's window to start at that message, and the press lands once it has, as a press above the drawn page does: from that message to the newest is drawn, the way Show earlier messages draws it. Until it arrives the reader stays where they are, and a scroll, a wheel or a press in the transcript or over the column, Jump to latest, or a send meanwhile cancels the landing. On a thread of 1,000 turns the first message lands in about a second on the development machine.
- **Remote hosts** list `thread-prompts` and answer the read of the same name (`docs/host-protocol.md`). A desktop sends `throughMessageId` only for a tick such a host gave it. Nothing changes for the iPhone, which still has no scrubber.
- **A consequence.** A press far back on a remote thread loads everything from there to the newest message in one detail, as many presses of Show earlier messages would. A thread whose words from there exceed a host's 16 MiB frame (600 turns of 30 KB replies, say) is refused as too large, as it would be the long way round, and the press does not land.
