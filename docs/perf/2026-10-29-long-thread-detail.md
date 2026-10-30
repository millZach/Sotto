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
  the held list.

What the window is sent is the same, byte for byte: 60 detail updates, 13,195 bytes.

| One thread streaming, 60 chunks | Before | After |
| --- | ---: | ---: |
| `broadcastDetail`, profiled | 141.2 ms | 23.6 ms |
| per chunk | 2.35 ms | 0.39 ms |
| Signatures worked out | 1,208,000 | 4,000 |
| Benchmark process CPU, whole scenario | 533 ms | 324 ms |

## The guard

`tests/perf/longThreadDetailWork.perf.test.ts` counts the signatures the detail stream works out per streamed chunk. It
runs with 200 and with 2,000 records on each of three observed threads, after their records were replaced by equal
copies. It fails if a chunk works one out for a record that did not change, or if the record added halfway does not
reach the window. On `main` before the change, each chunk worked out 2,000 or more.

Stable runs the same certified path, since `streaming-publish-cost` went to stable. The owner-scale fixture's stable
track still runs with it off, so it measures an older path; that is a follow-up for the fixture.
