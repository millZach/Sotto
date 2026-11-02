# A running command's output sent to the window as what it grew by - October 30, 2026

Measured with the data-transfer benchmark (`tests/perf/dataTransfer.perf.test.ts`, `docs/perf/2026-10-29-data-transfer.md`),
its main-process block on Owl: the owner-scale pipeline `src/main/index.ts` wires, with one thread open in the window.

```sh
SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/dataTransfer.perf.test.ts -t "measures what main moves" --maxWorkers=1 --disable-console-intercept
```

It prints `DATA-TRANSFER`. The scenario is `command output streaming`: a command in the open thread prints a 24 KB build
log, 400 characters at a time, 60 chunks over four seconds. Its `channels` hold the bytes and messages of each window
channel, `window detail` among them, and its `clone` the `structuredClone` calls main made.

## What it cost

A detail delta carried a changed activity record whole. Each chunk of output changed the command's record, so each
chunk sent the window the whole log so far: the 24 KB log crossed as 750 KB.

## The change

When a record's output or text only grew at its end, and every other field holds what it held, the delta carries what
it grew by (`AgentActivityAppend`, ADR-0025, October 30 amendment). Only the window's own detail stream is sent appends.
Every other listener, the desktop's socket server among them, is sent the record whole as before.

## Before and after

Three runs each on forge, `main` (`5079b8da5`) and the change taking turns, run after run. Every run sent the same bytes.

| `command output streaming` | Before | After |
| --- | ---: | ---: |
| Window detail, bytes | 750,380 | 36,480 |
| Window detail, messages | 60 | 60 |
| Window detail, largest message | 24,307 bytes | 608 bytes |
| Window detail, encode time of all 60 | 0.57-0.66 ms | 0.67-0.69 ms |
| `structuredClone` calls | 68 | 8 |
| Main's CPU for the scenario | 245.6-260.7 ms | 257.2-264.7 ms |

The window now receives about what the command printed: 24,000 characters of output in 36,480 bytes, the rest each
delta's revisions and IDs. Main's CPU is not lower. The copy the diff no longer makes is traded for reading whether the
output grew and comparing the record's other fields, and the difference is inside the spread forge gives this scenario:
six more runs not taken in turn read 252.6-272.9 ms before and 256.4-289.1 ms after, with other work on forge. The
encode time is fixed cost per message at this size.

The benchmark's pipeline has no socket server listening. With one, as when a phone is paired, main copies the grown
record once per update for it, as the diff did before for everyone, and that listener's bytes are unchanged.

The window's state broadcasts in this scenario, 759,999 bytes, are unchanged here. They are the thread rows and the
shell's other parts, which #1940 takes on.

## The guards

- `tests/unit/shared/agentThreadDetailDelta.test.ts`, "a record whose output or text only grew":
  - output, text or both that grew at their end are sent as what they grew by, and a record whose status changed with
    its output, or whose output was rewritten, cut or started, is sent whole, as is one where another field changed to a
    value of the same length, which the signature does not tell apart;
  - an append applied gives the record the whole one would have, by both paths through the apply, and an append for a
    record the detail does not hold cannot be applied;
  - appends that wait together join, an append joins the whole record waiting ahead of it, and a random run of appends,
    removals and whole records folds into one delta that applies to the same history;
  - a reader other than the window is sent each append as the record whole, found by reading the same few records with
    200 records as with 2,000.
- `tests/unit/main/agentShellDetail.test.ts`, "sends the window the output a running command grew by, and every other
  listener the record whole": both listeners end holding the same detail, the one main reads.
- "reads the same few records with 200 records as with 2,000" now expects the append.
- The pipeline fixtures the benchmarks and budgets use subscribe to detail as `src/main/index.ts` does, appends and all.
