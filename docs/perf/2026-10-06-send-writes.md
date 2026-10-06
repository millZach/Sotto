# Writes before a send and between provider events - October 6, 2026

Issue #767, part of #762. Between Send and the provider hearing the prompt, Sotto rewrote whole JSON stores one
after another, each with an fsync, and kept rewriting them between the provider's events as the reply started.
This note counts those writes before and after, and times what they cost on the development machine.

## What was measured, and how

`tests/perf/sendWrites.perf.test.ts` makes six manual sends to one new thread the way the Threads page does: the
window's own draft store, with its 250 ms save debounce, hands each revision to the coordinator, which sends it
through the real Claude or Codex adapter to the fake client in `tests/fixtures/`. Each send's clock runs from the
press to Sotto writing the prompt to the client's pipe (the `user` frame for Claude Code, `turn/start` for Codex).
`tests/fixtures/durableWrites.ts` counts every fsync the process makes through `node:fs/promises` in that time, by
file, and the bytes each made durable; a store's temporary sibling counts as the store. Before the sends, the
provider's thread store is grown with other synthetic threads until, laid out indented as the old code wrote it, it
is the size it had on the development machine: 388 KB for `claude-threads.json`, 1.3 MB for `codex-threads.json`.
Each press waits until no fsync has started for 100 ms, so the last reply's trailing writes are not counted. "Before" is the source at `e8a82a03`
(`origin/main` when the work started), bundled from Git; "after" is this change. Each run is a fresh process on a
fresh profile, four runs of each, alternating. The first send of a run also starts the thread's session; the other
five, 20 per mode, are the common case and are what the tables give.

`tests/perf/usageStreamWrites.perf.test.ts` streams one Claude reply into the usage ledger: `message_start`, 150
output counts 20 ms apart, then the turn's result, against a synthetic ledger of 40 threads and 24,000 requests
(3.8 MB compact, 6.5 MB as the old code wrote it, near the 6.2 MB the development machine's ledger had reached). It
counts the ledger's fsyncs and bytes, and the process's CPU time, until the ledger is drained.

## Before the provider hears the prompt

Durable writes per send, median of 20 sends on a running session:

| | Before | After |
| --- | --- | --- |
| Claude Code | `agents.json` x3, `claude-threads.json` x1 (408 KB) | `agents.json` x1, `claude-origins.jsonl` x1 (327 bytes) |
| Codex | `agents.json` x3, `codex-threads.json` x1 (1.34 MB) | `agents.json` x1, `codex-threads.json` x1 (0.86 MB) |

| | Before | After |
| --- | ---: | ---: |
| Claude Code, press to prompt written | 29.8 ms (17.6-140) | 10.8 ms (7.5-19.3) |
| Codex, press to `turn/start` | 49.8 ms (34.3-207) | 39.6 ms (18.1-59.2) |
| Claude Code, first send of a run | 25.4 ms | 11.2 ms |
| Codex, first send of a run | 85.1 ms | 66.2 ms |

These are the figures after review, with the stores seeded at their indented size. Another agent's test suite
was running on the same machine. The first Claude run met it and gave 35.9 ms against 32.9 ms, with the after
range reaching 101 ms; the Claude row is a second run of the same benchmark. The counts and bytes were the same in
both runs.

The three `agents.json` writes in the benchmark were the coordinator's admission write, a save of the thread
snapshot it read just before the send, and the outbox entry. Each was about 4 KB here. The snapshot's save now rides
on the outbox write, and admission writes only for a prompt that waits behind other work on its thread (ADR-0056).

Two more writes of `agents.json` were the window's, and the benchmark does not show them. The window saved the
revision it was sending when Enter came within 250 ms of the last keystroke; the benchmark presses after the typed
draft is saved, so that save had nothing to do. And it saved the emptied composer 250 ms after the press, which
landed after these sends because the fake clients answer in milliseconds; at the development machine's median of
2.8 s from Send to the provider hearing the prompt (#762) it landed in the middle of the send. Neither is made in
front of a send now. `tests/unit/renderer/threadDraftStore.test.ts` covers both; nothing here times them.

The Codex first send also writes `codex-threads.json` three times before and after: starting the thread's session
records it. The pinned count covers sends to a running session only.

What is left is what the guarantees need. The one `agents.json` write is the outbox entry, so a prompt is never
sent twice after a crash, and it now carries the draft and its delivery record that admission used to write
separately. The origin is the adapter's record of sending, so the provider's echo is matched and no prompt the
provider took is left looking unsent; Claude Code now records it as one synced line instead of rewriting every
thread's record, and Codex still writes it into its thread store, now without indentation (0.86 MB instead of
1.34 MB for the same records).

## While the reply streams

Codex no longer holds a frame behind the save of the frame before. `tests/integration/sendWrites.test.ts` holds a
save of `codex-threads.json` open and shows the reply's words reach the thread while it is held; with the adapter
from `e8a82a03` the same test times out after 15 s, because the frame announcing the reply waited on that save
before the frame carrying the words was read. A second test holds every save from the moment `turn/start` is
written and sees the turn complete while the send still waits for its own save; before the review fix the
acknowledgement's save held the frames behind it, and that test times out too. The saves still happen, behind the
frames: one in flight at a time, and every frame that asks for one while it runs shares the next. Resuming a
session, reading a thread and recording a compaction still wait for their saves; they are not on the path from
Send to the reply's first words on a running session.

The usage ledger, for one streamed reply, median of four runs:

| | Before | After |
| --- | ---: | ---: |
| Ledger writes | 48 | 5 |
| Bytes written | 312 MB | 19 MB |
| CPU time | 3,070 ms | 187 ms |
| Time to deliver the 150 frames (3.0 s of gaps) | 4,088 ms | 3,131 ms |

Before, a write started as soon as the last one finished, each one a structured clone of the whole ledger and an
indented copy of it. After, the ledger is written at most once a second while a reply streams, and at once when the
turn ends; it is serialized as the write starts, without a clone. The last row is most likely the event loop: before,
it spent most of the reply serializing a 6.5 MB ledger, so the frames' timers fired late.

The coordinator still compares its saved state on every snapshot, so a snapshot that changed nothing saved writes
nothing. That comparison is now one serialization of the state rather than a structured clone, a serialization and a
SHA-256 of every draft; a draft's signature is worked out once per draft, and a write that follows hands the store
the same text. It still runs once per snapshot a provider event produces; nothing here measured it. Snapshots accepted in one run share one
comparison, and the one a send reads just before its outbox write is carried by that write.

## What these numbers are not

- The fake clients answer in milliseconds and the stores are synthetic, so the times are Sotto's own work on a fast
  disk, not what a user waits for. The counts are the point: each removed write is an fsync and, for the stores, a
  rewrite of the whole file, whose cost grows with the file and with how busy the disk is. The ranges' long tails
  are single sends that met another process's disk work; the development machine had other agents' suites running.
- The time from Send to the provider hearing the prompt that #762 measured (median 2.8 s for Claude) is mostly
  other work: checkpoints (#764), the reads around a send (#765) and Git (#766). This note does not claim that
  figure moved by the milliseconds above alone.
- `agents.json` here holds one thread. On a machine with many deliveries, follow-ups and assignments it is larger,
  and each write removed costs more.
- Taken on the Windows development machine (Intel Core Ultra 9 275HX, Node v24.14.1). Read them as sizes, not
  budgets. The pinned counts in `tests/integration/sendWrites.test.ts` are what the default run asserts; nothing
  asserts a time.

## Re-run

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/sendWrites.perf.test.ts --maxWorkers=1 --disable-console-intercept
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/usageStreamWrites.perf.test.ts --maxWorkers=1 --disable-console-intercept
npx vitest run tests/integration/sendWrites.test.ts
```
