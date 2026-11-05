# A to-do list holds what only the user's hands can do

## Status

Reversed November 4, 2026, by Zach, on a question card ("Remove it completely"). The list is gone from Sotto: its store, `add_to_do` and the `sotto_to_do` tool server, the corner scroll and its badge, the `to-do-list` Owl entry, Watcher's to-do lines and its settle check, and the host protocol's `to-dos` and `to-do-request`. Watcher's and the sidebar's Needs you are as they were before it. The decision below is kept as a record of what was tried.

A computer that ran it keeps its `to-dos.json`: nothing reads it now, and nothing deletes it. The iPhone part never merged; it stands on the branch `feat/to-do-iphone` (#2162), and the prototype stays at the tag `prototype/to-do-scroll`. The desktop's verification note and captures went with the feature, and stay in the history at `f7ac01978`.

Accepted November 3, 2026, by Zach's picks on question cards, from the prototype kept at the tag `prototype/to-do-scroll` (variant A).

It is an Owl feature (`to-do-list`, ADR-0072). Stable keeps today's Needs you lines in Watcher's replies until Zach sends it.

Amends [ADR-0073](0073-watcher-coordinates-threads-with-its-providers-own-tools.md) on what Watcher writes in its replies, and [ADR-0108](0108-a-prototype-waiting-for-review-needs-you.md) on Watcher's needs-you line. While the feature is on, it reverses #1718's rule that Watcher repeats every ask until it is answered.

## Context

Zach asked for it: "the only things that would go in there are things that aren't like permissions or question cards, cause those already automatically like pop up, so then you don't have to repeat the needs you."

Question and permission cards come to him by themselves. What does not is the work only his hands can do: a hand test, something to send, a walkthrough to run, a soundtrack to listen to. Those sat in worker replies and Watcher's Needs you lines, which every reply repeated until they were answered, so the lines were long and said mostly what the cards already said.

Sotto has no list shared across computers. Forge and the laptop each keep their own state, and clients join the threads of every computer they reach.

## Decision

**1. A to-do is something only the user can do.** It is not a question, a permission or a decision. A worker that needs a decision still asks on a card. The word is **to-do** (`CONTEXT.md`). The Needs you card in the Threads sidebar and the Needs you section on the iPhone stay as they are, and hold what they hold today.

**2. Three can add one.** A thread, with `add_to_do` on a new scoped tool server, `sotto_to_do`, on every provider that takes Sotto's tools. Watcher, with the same tool. The user, in the box at the bottom of the list. A thread speaks only for itself, because the caller is known by its token, and one thread may add ten in ten minutes, so it cannot flood the list. Adding words a thread already has open changes nothing, so a retry is safe. A computer holds at most a hundred.

**3. What one holds.** A title; a line on why it is there; a link to its thread when a thread added it; one web address to open, with the words its button says; up to twenty steps; and whether the thread waits on it. A file in the thread's folder is not a link yet.

**4. How it looks.** Variant A, the corner scroll. On the desktop, a list icon stands in the window's top right corner on every page, left of the window's controls where a computer draws them, and takes the room the freeze pill takes. On the Duo, a tile of its own on the rail below Back or New thread, so it stands on every page, which the tabs do not. On every other iPhone, which has no rail, it stands at the top right of the bar. A press unrolls the list downward from there, with a roll at its bottom edge that travels with it and thins as it goes. The list is only as long as what it holds, up to the window. Its steps fold open. A press outside, Escape, **Roll up** or the icon rolls it back up. Reduced motion fades it in place.

**5. The badge.** An orange count of what is new since anyone last opened the list. Once opened, a quiet grey count of what is left, the way the Agents badge goes quiet. Nothing left, no badge. Seen is one fact on the computer that holds the item, so opening it on the phone quiets the desktop too.

**6. Checking one off.** It is gone: there is no Done list, which Zach chose over keeping one. **Undo** stands for five seconds, and the client holds that wait, so nothing happens on the computer that holds the item until it ends. Rolling up does not cancel it. A client that goes away in those seconds leaves the item unchecked, which loses nothing. Once the last item is gone the list rolls itself up.

A thread that said it waits is told, and only then: a wake-up in Sotto's voice, which the transcript shows, naming the to-do. Other items just go, so a soundtrack starts no turn. A settled thread takes no wake-up. **It didn't work** stands on an item whose thread waits, sends the user's words at once, labelled as theirs, and takes the item off.

**7. This approves nothing (ADR-0004).** A check-off is a fact about what the user did. It answers no request and grants nothing, the wake-up says so, and a to-do whose words ask for a permission or a decision gets none by being checked. The words a thread gives are shown as that thread's, never as Sotto's or the user's.

**8. Where the list lives.** Each computer keeps its own items, in `to-dos.json` beside its threads. A client joins them, as it does threads: the desktop through its host connections, the phone through its connection to each computer. A press goes back to the computer that holds the item. While that computer is away its items are not shown, and they come back with it. A host offers `to-dos`, to desktops and phones, only where its Owl answer turns the feature on. The user's own item goes to the computer they are on, or on the phone to the first one connected.

Nothing new is contacted. The words are the user's and their threads', so they are saved only while Keep local history is on, as Watcher's kept lines are, and they reach no log and no product event.

**9. What Watcher writes changes.** While the feature is on, its replies carry no Needs you lines: cards pop up by themselves. It still calls `read_state`, which works out `waitingOnUser` as before and now also lists the open to-dos, so it knows what waits on the user and does not add one twice. A worker's reply that asks the user to do something by hand becomes a to-do, not a line it repeats. A worker's ask for a decision with no card still goes back to the thread to ask on a card, and Watcher says it once. News tells Watcher when a watched thread adds a to-do, which it mentions once in passing, and when the user checks off a watched thread's or Watcher's own. The user's own and an unwatched thread's make no news, since each would cost Watcher a turn and neither is its work; `read_state` still lists them. A thread with an open to-do it waits on is not finished, so it does not settle.

**10. A prototype waiting for review is a to-do of its own kind.** Sotto makes it from the **Prototype ready** mark (ADR-0108); it is not saved as an item. Its link opens the page, and opening it clears the mark, which takes the to-do off, as checking it does. Replying in the thread clears it too, as it does today. The thread pane's own Prototype ready line stays.

## Consequences

- Stable changes nothing: no icon, no tool, no store, and Watcher's prompt is as it was.
- The window's corner holds one more control on Windows and Linux. A pane's header gives up 34 pixels at every size, which matters most at the 820x560 minimum.
- A computer that is off hides its to-dos. Zach chose that over one list on the computer that runs Watcher, which would hide them all when that computer is off.
- With Keep local history off, a restart loses the list, as it does Watcher's kept lines, and a to-do's wake-up that has not gone yet goes with it, so the user's words never reach the disk. That wake-up always waits apart from any other, so nothing else is lost with it.
- News that cannot be kept leaves the item on the list, and the press says so. A thread that is settled, closed or gone is waiting on nothing, so its item just goes.
- A check-off made on a phone while it has no connection to that computer does not happen; the item stays, and the press says so.
- Android is left for later. Zach asked for iOS.
