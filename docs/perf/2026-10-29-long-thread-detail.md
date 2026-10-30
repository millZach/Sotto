# A streamed word on a long thread - October 29, 2026

Measured with the data-transfer benchmark (`tests/perf/dataTransfer.perf.test.ts`, `docs/perf/2026-10-29-data-transfer.md`):
the owner-scale pipeline on Owl, three observed threads of 2,000 activity records and 550 messages, one of them streaming
twenty chunks a second.

## What it cost

With 2,000 records, the coordinator's detail stream cost main 2.35 ms per streamed chunk (`broadcastDetail`, profiled),
against 0.15 ms with short threads. The cost was signatures: once a thread's records came back under new identities with
the same content, as a read of the thread store gives them back, two things stopped meeting them by identity.

- `detailRevision` found them equal by signature and returned the held revision, but kept the old records as its base,
  so every later publish compared every record by signature again. That was every long thread on screen, idle ones
  included: 1,208,000 signatures over 60 chunks for three threads.
- The window's held detail kept the records it was first sent. Each diff then met the live records by signature only,
  and walked every record into maps and sets even when the list was the very one it held.

## The change

- A base proven equal by signature takes the new records, so the next publish meets them by identity.
- After a delta, the held detail takes the pane's own certified records. They are frozen and never edited, so this is
  safe, and they are what the next publish hands over. Messages are still copied, because the adapters append to a
  message in place.
- A diff whose activity list is the very list the detail holds walks no record, and a delta with no record in it keeps
  the held list when that list is frozen.
- When a record does change, as a tool's output grows, the diff skips the opening run of records the two lists hold as
  the very same objects, and a delta of a few records is applied by finding each from the end. Neither reads every record
  of the thread into maps any more.

What the window is sent is the same, byte for byte: 60 detail updates of 13,195 bytes while words stream, and 750,380
bytes while a command's output streams.

| 60 chunks, profiled `broadcastDetail` | Before | After |
| --- | ---: | ---: |
| Words streaming | 149.2 ms (2.49 ms a chunk) | 20.3 ms (0.34 ms a chunk) |
| Command output streaming into one record | 62.4 ms | 24.0 ms |
| of it, the diff | 26.4 ms | 1.8 ms |
| Signatures worked out while words stream | 1,208,000 | 4,000 |

## The guards

`tests/perf/longThreadDetailWork.perf.test.ts` counts the signatures the detail stream works out per streamed chunk. It
runs with 200 and with 2,000 records on each of three observed threads, after their records were replaced by equal
copies. It fails if a chunk works one out for a record that did not change, or if the record added halfway does not
reach the window. On `main` before the change, each chunk worked out 2,000 or more. `agentThreadDetailDelta.test.ts`
counts the records a diff and its apply read for a change to the last record: the same few with 200 records as with
2,000, against 1,596 and 15,996 before.

## What it leaves

The messages a detail holds are still versioned and compared in full on each chunk. That is the loaded window, ten turns
unless the user reads further back (`FIRST_WINDOW_TURNS`), so it grows with how far back the pane is read, not with the
thread's history.

Stable runs the same certified path, since `streaming-publish-cost` went to stable. The owner-scale fixture's stable
track still runs with it off, so it measures an older path; that is a follow-up for the fixture.
