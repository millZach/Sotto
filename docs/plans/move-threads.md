# Moving threads to another machine (#1178)

A **move** is "continue on another machine" (ADR-0089, ADR-0105 decision 7): a new thread with its own Sotto thread ID on the target machine, in the same project (matched by its **project origin**), on the same provider, model and effort where the target has them, whose first prompt is the source's fixed handover plus a facts block Sotto writes. Nothing is a moved session.

Part of the Owl feature Work across machines (`cross-machine-work`, ADR-0072). Stable shows and starts none of it.

## Decided

Zach, October 21, 2026 (issue #1178):

- Uncommitted work refuses the move. Test runs snapshot it; moves do not.
- Not moved: a thread with a turn running, a question or permission card, background work or an unresolved send; a delegating thread with children working; any delegated thread; Watcher. Each says why in plain words.
- The original is settled once the new thread is confirmed and its first turn has ended. Its worktree is kept, and no automatic cleanup runs on it while #1297 is open. (#1297 closed on October 22, 2026.)
- A move that would start narrower than the thread runs now (its permission, or no GitHub sign-in for its babysitting) says so and waits for a press.
- If Watcher watched the original, it watches the new one; if not, not.

Zach, October 29, 2026, on the question card, from the walkthrough (tag `prototype/move-threads`):

- **B, confirm once, then read the report.** **Move threads**, next to Stop all in Watcher's room, picks a machine and opens one sheet ("Move 3 threads to forge?") listing what moves now, what asks first and what stays and why. Each move is then reported on its own card in Watcher's conversation; one that would start narrower waits for a press on its card.
- **Sotto runs the moves, not a Watcher turn.** The cards are Sotto's own entry in Watcher's conversation, as other news is, and Watcher is told what moved.
- **A thread's More menu gets "Continue on another machine…".**
- **A moved thread starts working at once** from its handover; it does not wait for a first message.
- **Move threads is hidden** while no other machine is connected.

Zach, October 29, 2026, on the question card for part 2:

- **Continue on another machine…** picks a machine, then opens the same sheet for that one thread; its move is reported on its card in Watcher's conversation like every other.
- **A model the target lacks:** the thread moves to that provider's first ready model there, and the sheet and the card name the model it runs on and the one the machine doesn't have.
- **Anything queued** (the user's or Sotto's own news) keeps the thread here, as part 1 built it.

## Build order

1. **Core, This computer to a paired host.** The move record (`moves.json`, states fenced, branch sent, thread started, first turn ended, source settled, or given back, written before anything is sent, every step idempotent by the move's ID); the fence (the source refuses sends while it moves); eligibility with its plain words; the branch over the host socket (`DesktopBranchMoves`); the handover and facts block built here; an optional host-v1 feature that makes the new thread from the incoming ref and sends its first prompt, idempotent by move ID; confirmation, settling the source, and re-pointing Watcher's watch. Driven over IPC as a prepare/move pair modelled on Stop all. No UI yet.
2. **The UI (B).** Move threads and its sheet, the cards in Watcher's conversation, the narrower card's press, and the More menu entry.
3. **The other directions.** A host's thread to This computer, and between two hosts through the desktop; asking Watcher in words.
4. **Lost contact.** Reconciling with the target after a restart or a dropped connection, and **Keep it here** (ADR-0105 decision 7).

Then #1309, suggesting a move to a machine with room, on top of this flow.

## Part 1, as built (October 29, 2026)

- `src/shared/threadMoves.ts`: the IPC and host-v1 schemas, the words, eligibility (`threadMoveRefusal`), the permission a move starts on (`movePermission`) and the facts block (`moveFacts`, `movePrompt`).
- `src/main/agents/threadMoves.ts`: `ThreadMoveService`, the move record in `moves.json` and its steps, prepare and move, recovery at start, and `moveTargetsOf`, which reaches machines through Watcher's view of them and its placement.
- `src/main/agents/threadMovesHost.ts`: the host's `thread-move`, with its own `thread-moves.json`.
- The fence is the coordinator's (`fenceForMove`, `liftMoveFence` in `control.ts`); a move settles the source with `commandFromMove`. Watcher carries a standing watch with `moveWatch`.
- The bridge is `window.sotto.threadMoves`, offered where the machines line is (Watcher and Work across machines on), and registered only where main built the service.

Decisions made while building (the first and fourth confirmed by Zach on October 29, with the model named first):

- A thread whose model the target lacks moves to its provider's first ready model there, and its effort only where that model offers it. The preview does not ask first for that.
- A move that would start narrower and is not pressed for is answered "asks" and nothing is recorded for it; the card's press in part 2 asks for a fresh preview of that one thread.
- Only a first turn that completed settles the source. One that failed or was stopped leaves the source here, unsettled and taking sends, linked to the new thread left there (state `stayed`), since #1178 says a thread that fails to transfer stays where it is.
- Anything in a thread's queue, Sotto's own news included, holds it here, so nothing queued goes to a source after it moved.
- The automatic cleanup sweep skips a moved source's worktree. Clear settled threads after may clear a moved source, which is allowed since #1297 closed on October 22, 2026; it runs after 30 days at the earliest.

After Sol's standards and spec reviews (October 29), these rules changed:

- A new move is in no index and steps nowhere until its first write has succeeded; one whose write fails answers "stays", with its fence lifted and nothing sent.
- A record that does not read is never taken for an empty one. On This computer no move starts, the file is left as it is, and every source it still names as moving stays fenced ("…Sotto cannot read its record of the move, so it takes no sends here. Nothing was lost. Restart Sotto to try again."). On a host, every `thread-move` is refused as `unreadable`, which the desktop does not take as proof that no thread was made, so it keeps the move fenced and asks again.
- A run that does not move threads, stable or Owl with Work across machines or Watcher off, still reads `moves.json`, fences the source of every move not finished ("…this Sotto doesn't move threads… Open Sotto Owl to finish the move.") and keeps its worktree. It writes nothing and shows nothing.
- The host reads the desktop's answers grant again as the thread is made and as its first prompt goes (ADR-0004), so a grant taken away while the start waits refuses it (`failed`, nothing made) or leaves the prompt unsent.
- The watch goes before the source settles. One that will not go is tried five times; then the move waits, fenced and unsettled with its watch where it was, among `stalled()` for part 4.
- The host never drops a move's record; past 10,000 it refuses new moves (`full`).
- The worktrees a move keeps are a set of their own in `moves.json`, never trimmed with the history, and let go of when the thread is deleted.
- An update reads only the moves waiting on a first turn, each in a snapshot it has not read, by one index per snapshot, so the work grows with the threads there and not with moves times threads.
- The first turn counts as over only once the new thread is quiet there: no turn running, no card, no background work or monitor, and no thread it delegated to still working. This holds for a source that settles and one that stays.
- A provider's own profile is compared too: Devin's Bypass permissions moving to a thread that starts on Ask first asks first.

After Sol's second pass (October 29):

- A confirmed source is reserved before anything awaits, so a second confirmation of the same thread reads it as moving and is refused; nothing makes two moves of one thread.
- The fence lives in the coordinator's own record (`moveFences` in `agents.json`), saved before the move's record, so a source stays fenced across a restart whatever `moves.json` says, even one that does not parse. Only a `moves.json` that reads whole and shows no move under way lifts a fence the coordinator kept; `moves.json` only steps moves.
- The first turn is not over while a thread the new one delegated to on another machine, This computer or a third, is still open in delegation's record.
- Watcher's watch moves in one record write, the new thread's added and the source's ended, and asking again once it has moved answers done.
- A link back that cannot be saved fails its step, which is tried again: on the host no first prompt goes until `continuedFrom` is saved, and on This computer no move finishes until `continuedIn` is.

After Sol's third pass (October 29), only what could lose or duplicate work (Watcher's call, for Zach):

- A prompt or an answer admitted before its thread was fenced is refused again at dispatch, before any outbox entry, so it never reaches the provider once the move began.
- A fence the coordinator still keeps in `agents.json` holds the thread back from a second move ("An earlier move of this thread is still open…"), though `moves.json` names no move for it.
- One preview that names a thread twice, by its own ID and as This computer's key for it, plans it once; the second stays ("This thread is already named in this preview.").

The other four findings of that pass went to #1797: the target's limit restart after a move ends as stayed, the cleanup sweep and auto-settle racing a move's hold, kept worktrees when `moves.json` does not parse, and a grant taken away between the preview and the start.

Left for later parts: the GitHub sign-in half of asking first (a host does not yet say whether it has one), starting babysitting on the target, an exact read of a move and Keep it here (part 4, `ThreadMoveService.stalled()` names what waits), the other directions (part 3), the window (part 2), and the moved thread's first message shown as Sotto's on the desktop, which the continued thread's display does only for This computer's threads.

## Part 2, as built (October 29, 2026)

- `src/renderer/src/watcher/MoveThreads.tsx`: **Move threads** beside Stop all, the sheet (`MoveThreadsSheetHost`, mounted once in the main window), the machines it offers, read once through the hosts bridge however many panes ask, and each move's card in Watcher's conversation (`WatcherMoveCards`). `ThreadPane.tsx` adds **Continue on another machine…** to the More menu, beside Continue on another provider.
- The sheet offers This computer's open threads, settled, archived and Watcher's own left out, up to the hundred a preview takes. With one machine connected it asks that one at once; with more, it lists them, one not connected disabled with why. It sends what moves and what asks, never pressing for the narrower ones: those wait on their cards.
- Main holds the cards (`ThreadMoveService.view`), pushed on every change: a move's from its record, and this run's own for a thread that asks first, one kept here from that press, and one the confirmation could not move. Those three are not saved. A press to move one plans that thread again and moves it in the card's place; one that can no longer move says why on its card.
- The cards go after the turn they were confirmed in, as takeover lines do (`placeAfterTurns`), each machine's under one line of Sotto's ("You asked to move 3 threads to forge."). A move from before the current Watcher's first message is the last Watcher's and is not shown.
- Watcher hears of each move as it ends as `thread-moved` news (`WatcherWakeUp.threadMoved`), under the request that watched the thread, found on the new thread once the watch has moved, or under none.
- The preview and the cards name the model there (`movedModel`), and the permission a narrower move would start on (`startsOn`), for **Move it on …**.

Left for later parts, as before: a move whose machine stopped answering says so on its card and that nothing was lost, with no **Keep it here** yet (part 4); the other directions (part 3).
