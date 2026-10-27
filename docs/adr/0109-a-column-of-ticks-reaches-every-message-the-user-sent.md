# A column of ticks reaches every message the user sent

## Status

Accepted October 22, 2026. Zach asked for it through Watcher after using the Codex desktop app's version, and picked from `prototype/message-scrubber`: tick column A (evenly spaced, as Codex does it) set further out into the left margin and rising on a normal curve under the pointer, card B (square, with a clear border), the lane beside the column for Watcher's owls, and an Owl feature (`message-scrubber`).

Amended October 24, 2026, at the user's ask ("right now the lane is a long rectangular black box"): decision 7's lane is no longer kept clear of the scene, and a tick reached by the pointer or the keyboard keeps 3:1 (below).

## Context

A long thread is hard to move around in. The transcript draws its last 80 messages and keeps the rest behind Show earlier messages, and the thread store can hold more than the window has loaded (`earlierAvailable`). Messages off screen are laid out at an estimated height until the reader nears them (`content-visibility: auto`), so a position worked out from the page alone is wrong for anything not yet drawn.

What the user sent is the natural index: each message they sent starts a turn, and they remember what they asked better than what came back.

The transcript's left margin is empty on the Threads page. On Watcher's Conversation and Watched tabs the night scene's owl family (#1343) lives in both side margins.

## Decision

**1. One tick for each message the user sent.** A wake-up is Sotto's and a brief another thread delegated is that thread's (ADR-0061, ADR-0081), so neither has a tick. The ticks come from the thread's messages in the window, drawn or not; a message still only in the thread store has none until Show earlier messages loads it.

**2. It shows on long conversations only.** Three or more messages sent, and a conversation at least two screens tall or with messages above the first one drawn. Until the pointer or the keyboard reaches it the column is faint.

**3. Evenly spaced, centred, in the margin.** The ticks sit in one column centred on the transcript's height, 9 pixels apart, packed closer for a long thread so the column always fits within the transcript's middle half (four fifths until October 27, 2026). A press goes to the tick whose card the pointer was showing, even where packed ticks overlap. They live in a lane beside the column's left edge, up to 44 pixels wide, with an 18-pixel gap to the text; in a narrower margin the lane is the margin and the ticks are shorter, and a margin under 14 pixels shows no scrubber. The pointer anywhere in the lane reaches the nearest tick within 14 pixels. The ticks near it rise on a normal curve (sigma 16 pixels): the tick under the pointer is longest and brightest. The messages on screen are a step brighter and a little longer.

**4. The card is the message and what came back.** Who sent it, when, and "Message n of N", then the message's opening, then the start of the turn's last reply. A reply that ends on a question shows the question; the newest message's open question shows its first three choices and counts the rest, unless a wake-up or a brief came after it, whose question it then is. Everything comes from what the window already holds, and nothing is fetched or sent to fill a card. The card describes the tick it belongs to, so a screen reader hears the reply as well as the message, and it closes on Escape wherever focus is.

**5. A press lands, drawn or not.** A tick for a message above the first one drawn widens the window to it first, then the message is put at the top of the transcript and marked for a moment, the way Show where it asked marks a reply. It is put back for a few frames while the messages around it are laid out for real. The reader stops following the end.

**6. The keyboard is designed, not inherited.** The column is one Tab stop, before the transcript, landing on the last message on screen. Up and Down move between ticks and show each card, Page Up and Page Down move five, Home and End go to the ends, Enter or Space goes there and puts focus on the message, and Escape closes the card, then returns to the transcript. No chord is claimed.

**7. Watcher's owls keep the lane clear.** The scrubber shows in Watcher's Conversation tab, through the same transcript. While it shows, Watcher's night scene reads its lane (`measureRoom` finds `.message-scrubber`) and lays the left margin's tree, Watcher's owl, its owls and its rail out from the lane's outer edge, and perches no owl in it, so the owls and the ticks never meet. An owl flying between the trees crosses the lane behind the ticks, at the column's share and under its ink ceiling, as it crosses the conversation (amended October 25, 2026, ADR-0126). The sky and the hills run on under the lane at the column's share, as under the conversation, so the ticks float over the scene with no box round them (amended October 24, 2026; until then the scene kept the lane empty like the room's words, which left a dark strip down the margin). In Watcher the ticks take the secondary tier where they would be muted, as the conversation's names and times do (ADR-0126, pick D2), so the column's ink ceiling keeps them clear of the glyphs. Everywhere, a tick reached by the pointer or the keyboard is drawn at 80% or more of its colour, so the far ones too keep 3:1 against what lies beside them; at rest the lane stays faint. When the left margin is then too narrow for the tree, the rail of eyes shows on the right only. Watcher's owl does not fly to the composer's left branch meanwhile, whose perch would put its head in the lane.

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

## October 26, 2026 amendment: ticks that rest in the scene's ink

Drake found the column looked a bit off next to the chat: square bars of one width in the muted text colour, packed close, read as a dashed ruler of words rather than as chrome, and the column started and stopped hard. From three variants in `prototype/message-scrubber-blend` (a tag; `docs/prototypes/message-scrubber-blend/review.html` there shows them), Drake picked C on October 26, 2026. This amends decision 3 and the faint lane in decision 2; how the scrubber works does not change.

- **At rest a tick is the night scene's ink.** The same 10-pixel bar, with rounded ends, in the text colour thinned as the scene's stars are, so it reads as part of the sky. The lane rests at 35% instead of 55%.
- **The column's ends fade.** The three ticks at each end of the column fade out at rest, unless their message is on screen. The fade counts ticks rather than masking the lane, whose edges lie well past a centred column.
- **Reached, nothing changes.** Once the pointer or the keyboard reaches the lane, every tick takes the muted tier again, which Watcher draws in the secondary tier, at 80% or more, so the far ones keep 3:1 (decision 7). The messages on screen and the tick under the pointer keep their brighter tiers.

## October 27, 2026 amendment: half the length, and a column that follows the scroll

Drake found the column far too long: on a long Watcher conversation it ran most of the transcript's height, a grey ladder down the margin. He asked for about half the length, and for the column to answer the scroll in a way that barely shows. This amends decision 3.

- **Half the height.** The column takes at most the transcript's middle half, still centred. The ticks stay 9 pixels apart until that fills, so a short conversation keeps its air; past about one tick for every 9 pixels of half the transcript's height (45 on an 800-pixel transcript) they pack closer, twice as close as before for the same conversation.
- **Every message is still reached.** Nothing about reaching changes: the pointer reaches the nearest tick within 14 pixels and the keyboard steps through each one. The pointer can pick out each tick while they are at least a pixel apart, which on an 800-pixel transcript is up to about 400 messages sent (about 640 before); past that it picks among them roughly, as the first consequence already says, and Up, Down, Page Up and Page Down still land on every one. The swell keeps its 16-pixel sigma, so on a packed column more ticks either side of the pointer rise with it. Whether the scrubber shows is unchanged: that reads the conversation's height, not the column's.
- **The messages on screen lead the column, quietly.** Their ticks are a step brighter, as before, and now 3 pixels longer at rest. As the transcript scrolls, that emphasis passes from tick to tick over 200 ms with an ease-out, in width, opacity and colour only: the column never moves, nothing scales or bounces, and nothing changes while the reader is not scrolling. Once the pointer or the keyboard reaches the lane, the swell keeps its quicker timing so it keeps up with the pointer. With reduced motion on, the emphasis is the same and arrives at once. No fade-in on the first scroll: the column already rests faint, so a fade added movement without adding meaning.

