# A prompt sent at once is saved by its outbox write

October 9, 2026 amendment: [ADR-0067](0067-remove-voice-control-and-thread-management.md) records the removal. Assignment growth described below is historical; assignments are removed from live coordinator state. Drafts, deliveries, user follow-up queues and the compact outbox write remain.

## Status

Accepted October 6, 2026, issue #767, part of #762. The issue asked to merge the coordinator's admission write into the outbox write or prove admission needs its own, and to stop the window saving a draft in the middle of a send. This records what was decided and what it costs. The adapter half of the same issue, the origin journal and the Codex frame saves, is the October 6 amendment to [ADR-0005](0005-codex-app-server-adapter.md).

## Context

Between Send and the provider hearing the prompt, `agents.json` was written three or four times, each an fsync of the whole file. On a press within the 250 ms save debounce the window first saved the revision it was sending (`save-thread-draft`). Main then wrote the same revision as it admitted the send, before the thread's lane, so a prompt that waits behind other work is never only in memory. A snapshot of the thread read just before the send was saved next, and then the outbox entry, which is what keeps a prompt from being sent twice after a crash. The window's save of the emptied composer followed 250 ms after the press, which on a real send landed in the middle of it.

## Decision

**A send, steer or queue is saved by main, not the window.** Its command carries the revision, and main puts it in the thread's draft as it admits the command. The window saves nothing in front of it: the pending debounce is dropped, so no older revision lands after it, and the emptied composer is saved once nothing the thread submitted is unresolved. An answer still saves its revision from the window first, because main keeps no draft for an answer.

**Admission writes only for a prompt that has to wait.** A prompt whose thread lane is busy is written to `agents.json` as main takes it, however long the wait. A prompt that goes at once is first written by its outbox entry: the same state, one write fewer. A snapshot accepted on the way is saved by the same write. A failure of either write refuses the send with the same words, and the prompt comes back to the composer.

**The large stores are compact.** `agents.json` is written without indentation, as the provider thread stores and the usage ledger are. In the benchmark it is about 4 KB, but it grows with deliveries, follow-ups and assignments, and it is rewritten on every send. The cost is that a person reading the file needs a JSON formatter.

## Consequences

- One write of `agents.json` before the provider hears a prompt, where there were three or four (`docs/perf/2026-10-06-send-writes.md`).
- **What a crash can now lose.** Before, a prompt was on disk at the press. Now a prompt that goes at once is in main's memory from the press until its outbox write, which comes after the coordinator reads the thread before sending. That read is usually tens of milliseconds and can be seconds on a long Codex thread whose newest turn does not match. If Sotto stops in that time, the prompt is lost unless the debounce had saved it while it was typed: text typed and left for 250 ms is saved, while a paste or a dictation sent at once is not. The window going away alone loses nothing, because main has the prompt. Nothing is ever sent twice: the outbox write still comes before the provider hears anything.
- A send that fails before its outbox write keeps its draft in main's memory, and the save at the end of the lane writes it.

## Considered

- **Keep the admission write for every send.** It closes the window above, for one more fsync of `agents.json` on every send. The issue's measure was the writes a user waits on, and a crash in the tens of milliseconds between Send and the outbox write is rare beside the cost paid on every send.
- **Keep the window's save on the press.** Main already writes the same revision; the window's copy only added a write and a round trip.
