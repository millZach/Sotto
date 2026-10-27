# Watcher's picture reads what the window holds

## Status

Superseded October 27, 2026 by [ADR-0152](0152-watchers-room-is-its-conversation.md): Visualize, Watcher's picture, the merge turns read and the `mergeTurn` mark are removed. What follows records the decision as it was.

Accepted October 22, 2026, for #1339. Zach picked the picture itself (A of `prototype/watcher-picture`, the constellation, as a third tab of Watcher's room, live first). The data choices below were made in building it, with Watcher's confirmation that the picture adds no per-update work while the perf batch (#1326-#1336) is in flight. History and replay are #1340, which will need a record of its own.

## Context

**Watcher's picture** draws the threads Watcher watches, the messages moving between them and Watcher, and the **merge turns**. Most of what it needs the window already has: Watcher's room state (the watched threads, Sotto's receipts for every start, send, stop and settle with their delivery and outcome, the news ring, each thread's pull request evidence) and the threads' own facts (titles, projects, computers, pull requests, waiting requests), with All threads' own groups and words.

Two things it did not have:

- **The merge queue's order.** read_state works out the merge queue at each read (#1274), ordered by when Sotto first saw each pull request's checks pass on its current head. That time lives in main's evidence store, in memory, and is not in the room state.
- **Which send gave a thread its merge turn.** READY TO MERGE, GO MERGE and MERGED were words in messages only. A send's record keeps references, never words, so nothing said a send was a GO MERGE.

The room state is pushed to the window on every coordinator change, and the perf work in flight is cutting what each push builds and copies. A thread's record is saved to `agents.json`, and a build that cannot read the Watcher record loses the whole file (`watcherRecords.ts`).

## Decision

**1. The picture reads, it is not pushed.** It draws from the room state and the thread facts the window already holds, sampled at most four times a second while the tab shows, and nothing at all while it does not. Nothing is added to the room state or its publish.

**2. The merge turns are a read of their own.** `sotto:watcher:read-merge-turns` answers with read_state's merge queue and the merge turns Watcher gave. The queue is computed the same way read_state computes it, for the threads the room last built as watched, kept by reference from that build (since #1450 the room is built when the window's update goes, not on every publish), so a read neither walks Watcher's history nor builds or copies the room. Each merge turn keeps its thread from the moment its send was admitted, so the read scans no operations either; the window drops one whose send failed from its own receipts. The picture asks when it opens, when a send or a pull request's facts change, and every thirty seconds while it shows, never more than once every three seconds through one limiter. So the picture's READY TO MERGE order is the one Watcher itself reads. A send waits to move until a read asked after it was seen has answered, at most four seconds, so a GO MERGE moves as one.

**3. Watcher marks a merge turn on its send.** `send_to_thread` takes an optional `mergeTurn: { pullRequest }`. Main takes it off before the send is admitted, so the send's digest, its retry, what reaches the thread and what a paired host is sent are all as they would be without it. Once the send is admitted, main remembers the operation, its thread and the pull request's number, the newest 50, in memory only. A merge turn whose send failed is not shown as given.

**4. Nothing new is saved.** The marker is not a field of the operation record, so `agents.json` keeps its shape and an older build still reads it. A restart forgets the merge turns given; the picture shows those pull requests as READY TO MERGE until Watcher gives their turn again or they merge. #1340's history will keep them, in a record of its own.

**5. MERGED comes from GitHub.** A pull request is MERGED when the thread's own link or GitHub's evidence says so, never from a message; GitHub's merged or closed wins over a link that has not caught up. Every pull request a thread has counts in the merge turns, not only the one on its line.

## Consequences

- The picture costs nothing while another tab shows, and while it shows its work is bounded by the watched threads and the newest 300 receipts.
- Watcher has to mark its GO MERGE sends for the picture to show them; the tool's description asks it to. An unmarked one moves as a check-in, and its pull request stays READY TO MERGE in the picture.
- A paired host's own Watcher, and an older desktop, never see the marker.
- The e2e Watcher stand-in answers the read from its seed and can publish a script of later states, and e2e runs can set a thread's linked pull requests (`pull-requests`), so the picture is checked in the built app.
