# A transcript cursor, usable only beside the history it accounts for

Accepted September 19, 2026, to stop reconnect cost growing with a thread's history. Amended the same day by ADR-0016: the event store, not `WorkspaceHost`'s cache, is now the history of record, and an adapter that appends events is handed what the store holds through a history source instead of `restoreThreadHistory`. The cursor rule below stands: a cursor is trusted only beside the history it accounts for.

## Context

Claude Code keeps its own transcript per session, one JSON entry per line, and Sotto reads it to see what the user typed directly in Claude and to project the thread's messages and activity. `ClaudeSessionLog` reads incrementally within a run: 64 KiB at a time from a byte offset, keeping a partial-line remainder. The offset was not saved, so every connect started at byte zero. A thread with a long transcript paid for its whole history again on every start, and the file is the one thing in a thread that only grows. PR #107 made a catch-up publish once instead of once per entry; the reading itself was still linear in the history.

Saving the offset alone is not sound. The adapter's message list is built by replaying the transcript, and it is the only copy the adapter has: skipping to the end would leave a reconnected thread with no messages until the next entry arrived. The messages do survive a restart, but in `WorkspaceHost`'s cache, which is also the copy the user's Keep local history setting governs.

## Decision

A thread's read offset is stored in `claude-threads.json` beside the alias, with the identity of the file it was read from (size, and the inode or, where a filesystem reports none, the creation time) and what the reader had already matched there: the origins it consumed and the last digest it saw. The offset is the byte after the last complete line, so a resumed read never splits an entry, and it is written on a slow shared cadence and flushed on disconnect, never per line.

The cursor is trusted only when the messages it accounts for are handed back. `AgentHost` gains `restoreThreadHistory`, which `WorkspaceHost` calls during `initialize` with the messages it still holds, before anything connects. An adapter given a thread's messages may resume its cursor; a thread it was not given, or whose stored session no longer matches, is read from byte zero as before. So the one privacy gate still decides: with Keep local history off there is no cache to hand back, and the transcript is read whole.

Takeover detection is unchanged. It runs on what is appended, with the consumed origins and last digest restored so a repeated prompt cannot be mistaken for an old dispatch.

## Considered options

- **Store the offset alone.** Cheapest, and wrong: a reconnected thread would show only what arrived after the restart, and the shared adapter contract's "resumes the same thread and messages after restart" would have to be weakened.
- **Store the projected messages in `claude-threads.json`.** A second copy of transcript text, outside the setting that governs the first one. Sotto does not keep private transcript backups.
- **Hand the cached history back and let the adapter decide.** Chosen. The cursor and the messages it stands for travel together, and neither is usable without the other.

## Consequences

Reconnect cost follows what was appended, not what was said. `WorkspaceHost` holds the history of record between runs, so a lost or cleared workspace cache costs a full re-read rather than a gap. Other adapters may implement `restoreThreadHistory` when they want the same, and ignoring it keeps today's behaviour.

Amended September 20, 2026 for confirmed monitoring: the cursor must also be accompanied by the retained activity it accounts for. Claude restores the bounded activity projection before consuming the transcript tail, including historical task-lifecycle exclusions. This is history evidence only: no live monitor is restored, and provider lifecycle events remain the sole source of a live watch.
