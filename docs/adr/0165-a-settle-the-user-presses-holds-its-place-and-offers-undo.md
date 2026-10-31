# A Settle the user presses holds its row's place and offers Undo

## Status

Accepted October 30, 2026, by Zach's pick B of `docs/prototypes/ui-hillclimb-desktop/settle-undo-prototype.html` on the tag `prototype/ui-hillclimb-desktop` ("Hold the gap, Undo in a toast"). Issue #1826, from finding 8 of `docs/research/2026-10-29-ui-hillclimb-desktop.md`. **Number provisional until merge** (docs/agents/domain.md).

It changes how an existing action answers and goes straight to stable; it is not an Owl feature (ADR-0072). The iPhone's half is #1859.

Keeps [ADR-0041](0041-a-worktree-has-an-end.md)'s worktree question after Settle, [ADR-0081](0081-a-thread-may-delegate-work-to-threads-it-starts.md)'s delegated threads that settle and restore with the thread that delegated, [ADR-0163](0163-a-pane-header-is-the-git-action-watch-one-menu-and-close.md)'s ··· menu and [ADR-0164](0164-the-thread-list-is-one-tab-stop-and-f6-goes-round-the-regions.md)'s thread list, focus handoff included. Amends ADR-0164 in one place: while the settle toast stands, the next Tab from the thread list reaches its Undo before the sidebar's foot. Amends [ADR-0133](0133-thread-shortcuts-are-editable-on-a-keyboard-page.md): Settings › Keyboard lists Ctrl+Z under **Fixed & elsewhere** and refuses it to every thread shortcut.

## Context

Settle acts at once because it can be taken back, and it should not ask. But nothing offered the taking back: the user had to open Settled and find Restore. Worse, the row below slid up into the settled row's place, so the next thread's Settle landed exactly under a still pointer, and a second click or a double-click settled a second thread. Two rules meet there: never use a warning when you mean undo, and nothing moves under the pointer that the user did not move.

The mock-up offered A, the settled row held as one line, "Settled" with Undo in place; B, an empty gap held while the pointer stays, with Undo in a toast at the sidebar's foot; and C, the row flying to the Settled shelf, which carries Undo. Zach picked B: the row disappears but its gap stays until the pointer leaves the list, so nothing moves under a still pointer; a toast at the sidebar's foot says "Settled <title>" with Undo for six seconds; Ctrl+Z undoes, and Ctrl+Shift+E gets the same toast. The brief left three things to decide here: when Undo is honest, whether Watcher's settles get a toast, and the keyboard's way to Undo.

## Decision

**1. The held gap.** A Settle pressed with the pointer over the thread list (a row's hover Settle, or its menu's Settle chosen with the pointer) leaves the row's place empty, as tall as the row was, while the pointer stays over the list. The gap closes once the pointer leaves the list; should that leave go unheard, the sidebar looks every three seconds and closes it once the pointer is elsewhere. It folds away in 160 ms, and under reduced motion it goes at once. It holds no control and no name, so a click on it does nothing and a screen reader passes it by. While it is held, a folder the settle emptied, or one it would have moved down the list by taking its latest thread, stands where it stood, and its count says only its open threads. A gap goes at once when its thread comes back (Undo, or Restore on the shelf). Only a thread settled by itself is held: settling a whole project holds nothing.
- **It is the pointer's protection alone.** A Settle from the keyboard (the row menu chosen with Enter, or the Settle shortcut) holds nothing, and the focus moves to the row now in its place as ADR-0164 says. The pane's ··· menu is not over the list, so its Settle holds nothing either.
- **In the renderer only.** The sidebar puts the settled row back among the open folders by its activity, which settling does not change, so it lands in its own place, and draws it as the gap. Main does nothing new, and nothing on its update path grows.

**2. The settle toast.** Every Settle the user presses (a row's hover Settle, its menu's, the pane header's ··· menu's and the Settle shortcut, Ctrl+Shift+E) shows a toast at the Threads sidebar's foot: "Settled <title>" with **Undo**. It stands in the column's own flow just above the room switch, so it covers no row; on the collapsed rail it stands beside the rail's foot; in Watcher's room, which has no sidebar, a Settle pressed in the pane beside Watcher shows it in the window's corner, where the window's other toasts stand. It is the window's toast component (`ToastRegion`), a polite `status`, and it never takes the focus. It stands for six seconds, holds still while the pointer or the focus is on it, and goes as soon as its thread is restored some other way; a later Settle replaces it. Undo is Restore, the same press the Settled shelf and its shortcut make, so the thread comes back where it stood and the delegated threads settled with it come back with it. A refused Undo says so in main's words, with Dismiss, and an Undo that got no answer says Sotto could not confirm it, and goes once the thread is seen back; neither takes the place of a later Settle's Undo. No other action gets a toast for this: it is earned by carrying Undo.

**3. Undo only while the Settle can be taken back whole.** When the settle also removed the thread's worktree folder, by **Remove worktree** in ADR-0041's question or by the on-settle cleanup rule taking a clean folder, the toast says "Settled <title> and removed its worktree. The branch is kept." and offers no Undo. While the rule's removal runs, which can take a minute on Windows, it says "Settled <title>. Removing its worktree…" and its time stands still. Restore and the next send would put a folder back on the branch, but not what was in it: installed dependencies, ignored files the user ticked, uncommitted changes the user agreed to lose. The toast waits for the question's answer before it shows, so it never offers an Undo it then takes back. Should the rule's removal be refused, the folder stayed, and the toast offers Undo with its six seconds from then.

**4. Watcher's settles show no toast and hold no gap.** Only the Settles the user pressed do. Watcher's own (`settle_thread`, with or without Settle without asking, #1817), Auto-settle merged threads and a phone's Settle do not: Watcher says what it settled in its conversation, and a toast for work the user did not do would announce itself unasked. Every Settle the user presses on the desktop goes through one hook, `useSettleThread`, which is where the toast is offered, so nothing else can reach it.

**5. Undo from the keyboard.** Ctrl+Z (Cmd+Z on a Mac) presses Undo while the toast offers it, from anywhere in the window except where those keys already mean something: a text field, which keeps them for its own typing, a terminal, and an open dialog. It stands down when one of dictation's shortcuts is Ctrl+Z (`fixedKeyFree`), as every fixed key does, and for a thread shortcut the user saved on Ctrl+Z before this; Settings › Keyboard lists it as **Undo a settle** under **Fixed & elsewhere** and now refuses it to every thread shortcut. Undo itself is in the Tab order, the stop after the thread list, and its tooltip and `aria-keyshortcuts` name the keys. Undo pressed from the toast leaves the focus on the restored row. Restore's own shortcut (Ctrl+Alt+R) still restores the thread on screen, from the composer too, as before.

## Consequences

- A double-click on a row's Settle settles one thread; the second click lands on the gap (`tests/e2e/settle-undo.spec.ts`, `docs/verification/settle-undo.md`).
- Every user Settle on the desktop can be taken back from where the user's eyes and hands already are, without opening the Settled shelf.
- The Windows design captures do not change: none of them settles a thread, and the empty toast region takes no room.
- Watcher's room shows the toast in the window's corner, beside the window's own corner toasts; should a theme or update notice stand there at the same moment, one covers the other until it goes.
- The toast's look is the window's toast (`.tt-toast`) with a new shared `.tt-toast__action` button for its one action, drawn as Watch's Undo is; `.tt-toast__dismiss` is its Dismiss. The gap and the toast's place are in `settleUndo.css`, on `themeTokens.test.ts`'s owned list.
- On a Mac the Edit menu holds Undo on Cmd+Z. Whether the window still hears Cmd+Z outside a text field is not yet checked on a Mac; Undo's Tab stop is the keyboard's way there either way.
- The iPhone's Settle with Undo is #1859's, not this decision's.

## Alternatives

- **A, Undo in the row's place.** Undo right under the pointer, but a one-line "Settled" row standing in the list reads as a thread, and the second click would undo rather than do nothing.
- **C, fly to the Settled shelf.** Shows where the thread went, but the rows above the pointer still have to close up, and the shelf line gets a second job.
- **The window's corner toast.** The toast region's usual place, at the window's bottom right, far from the list the press came from.
- **Ctrl+Z for any earlier settle,** as the mock-up kept a stack. Rejected: an undo with nothing on screen to say what it takes back.
- **A gap for every Settle,** the keyboard's too. Rejected: it would leave the focus beside an empty place, against ADR-0164's handoff, for no pointer to protect.
- **The toast over the list,** as the mock-up drew it. Rejected for the column's flow, which covers no row.
