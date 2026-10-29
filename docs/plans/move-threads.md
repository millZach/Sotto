# Moving threads to another machine (#1178)

A **move** is "continue on another machine" (ADR-0089, ADR-0105 decision 7): a new thread with its own Sotto thread ID on the target machine, in the same project (matched by its **project origin**), on the same provider, model and effort where the target has them, whose first prompt is the source's fixed handover plus a facts block Sotto writes. Nothing is a moved session.

Part of the Owl feature Work across machines (`cross-machine-work`, ADR-0072). Stable shows and starts none of it.

## Decided

Zach, October 21, 2026 (issue #1178):

- Uncommitted work refuses the move. Test runs snapshot it; moves do not.
- Not moved: a thread with a turn running, a question or permission card, background work or an unresolved send; a delegating thread with children working; any delegated thread; Watcher. Each says why in plain words.
- The original is settled once the new thread is confirmed and its first turn has ended. Its worktree is kept, and no automatic cleanup runs on it while #1297 is open.
- A move that would start narrower than the thread runs now (its permission, or no GitHub sign-in for its babysitting) says so and waits for a press.
- If Watcher watched the original, it watches the new one; if not, not.

Zach, October 29, 2026, on the question card, from the walkthrough (tag `prototype/move-threads`):

- **B, confirm once, then read the report.** **Move threads**, next to Stop all in Watcher's room, picks a machine and opens one sheet ("Move 3 threads to forge?") listing what moves now, what asks first and what stays and why. Each move is then reported on its own card in Watcher's conversation; one that would start narrower waits for a press on its card.
- **Sotto runs the moves, not a Watcher turn.** The cards are Sotto's own entry in Watcher's conversation, as other news is, and Watcher is told what moved.
- **A thread's More menu gets "Continue on another machine…".**
- **A moved thread starts working at once** from its handover; it does not wait for a first message.
- **Move threads is hidden** while no other machine is connected.

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

Decisions made while building, for Zach to confirm:

- A thread whose model the target lacks moves to its provider's first ready model there, and its effort only where that model offers it. The preview does not ask first for that.
- A move that would start narrower and is not pressed for is answered "asks" and nothing is recorded for it; the card's press in part 2 asks for a fresh preview of that one thread.
- The first turn counts whether it completed, was stopped or failed; the record keeps which, for part 2's card.
- Anything in a thread's queue, Sotto's own news included, holds it here, so nothing queued goes to a source after it moved.
- The automatic cleanup sweep skips a moved source's worktree. Clear settled threads after does not yet: it runs after 30 days at the earliest.

Left for later parts: the GitHub sign-in half of asking first (a host does not yet say whether it has one), starting babysitting on the target, an exact read of a move and Keep it here (part 4, `ThreadMoveService.stalled()` names what waits), the other directions (part 3), the window (part 2), and the moved thread's first message shown as Sotto's on the desktop, which the continued thread's display does only for This computer's threads.
