# Opening a long Codex thread - September 27, 2026

Issue #352. Opening a Codex thread Sotto holds no history for reads it whole with `thread/read` and
`includeTurns: true` and applies every turn. #324 found that at 2,000 turns an open took 6-17 s on the fake
app-server while the real Codex CLI 0.157.1 sent the same transcript in 117-150 ms, so nearly all of the wait was
Sotto's own work, and it grew faster than the thread did (`2026-09-26-codex-send-read.md`). The likely cause it
named was `applyTurn` in `src/main/agents/codex.ts` calling `orderMessages`, which sorts the whole message window,
once for every turn. The issue asked for the open to be split into phases first.

The decision: the numbers put about a fifth of the cost on that sort and most of the rest on the thread activity,
so both changed; identity reconciliation and the rest stayed as they were. A whole read now orders the message
window once rather than once a turn, and the Codex activity projection places each record instead of rebuilding
its list.
At 2,000 turns an open went from 6.6-8.7 s to 1.0-1.5 s, and the read now costs about the same per turn at every
size.

## How it was measured

`tests/perf/codexOpenApply.perf.test.ts` seeds a thread with 50, 500 and 2,000 finished turns in
`tests/fixtures/fakeCodexAppServer.mjs`, with the seeding `codexSendRead.perf.test.ts` uses, now shared from
`tests/fixtures/codexSeededThread.ts`. A turn is a 200-character prompt, a reasoning summary, a command with 2 KB of
output and a 1,200-character reply, all filler, which makes a whole read about 4.4 KB a turn. Each run opens the
thread five times, each on a fresh connection, so the adapter holds nothing for it and the open reads it whole.
Each figure is the median of the five opens in a run, and each range is across three runs. The phases:

- **Open**: from the thread entering the watched set to the adapter's open settling.
- **Read**: the `thread/read` request, from going out to its callback finishing. The rows below it are inside it.
- **Sending**: from the request going out to the adapter starting to parse the reply. Against the fake this is
  the fake building its reply and the pipe carrying it, not Codex.
- **Parsing**: `JSON.parse` of the reply line, then the frame and thread schemas, up to applying the thread.
- **Reconciling**: `reconcileTurn`, which settles each turn's message identities. The identity lookups made for
  each message as it is applied count under applying items and the rest.
- **Applying items**: `applyItem` for every item, which records the messages in the thread's log (**recording**)
  and projects commands and reasoning into the thread's activity.
- **Thread activity**: the Codex activity projection's `item`, `anchor` and `turn` calls. The first two run inside
  applying items and `turn` in the rest, so this column overlaps both.
- **Ordering**: every `orderMessages` call inside the read, and how many there were.
- **Rest**: `applyThread` and the read's settling, less reconciling, applying items and ordering.
- **Saving**: the adapter's state saved after applying (`persist`), outside the rest.

"Before" is `codex.ts` and `codexActivity.ts` as of `origin/main` (`020df63a`) under the same benchmark; "after" is
this change.

## Before and after

| Turns | Open, before | Open, after | Read, before | Read, after | Read per turn, before | Read per turn, after |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 50 | 46-49 ms | 39-57 ms | 36-38 ms | 29-37 ms | 0.73-0.76 ms | 0.57-0.74 ms |
| 500 | 774-1,408 ms | 296-488 ms | 732-1,374 ms | 259-397 ms | 1.5-2.7 ms | 0.52-0.79 ms |
| 2,000 | 6,631-8,741 ms | 1,023-1,530 ms | 6,552-8,521 ms | 946-1,330 ms | 3.3-4.3 ms | 0.47-0.66 ms |

Inside the read at 2,000 turns:

| Phase | Before | After |
| --- | ---: | ---: |
| Sending (the fake) | 81-90 ms | 75-85 ms |
| Parsing | 26-32 ms | 24-29 ms |
| of which `JSON.parse` | 5.3-6.1 ms | 5.0-5.7 ms |
| Reconciling identities | 282-412 ms | 114-181 ms |
| Applying items | 4,192-5,611 ms | 544-783 ms |
| of which recording | 126-186 ms | 104-157 ms |
| Thread activity | 4,076-5,406 ms | 401-556 ms |
| Ordering | 1,459-1,861 ms | 1.9-2.4 ms |
| Orderings per read | 2,002 | 2 |
| Rest | 384-477 ms | 151-222 ms |
| Saving | 18-29 ms | 22-24 ms |

At 500 turns applying items went from 554-1,020 ms to 130-221 ms, the thread activity from 535-938 ms to
75-115 ms and ordering from 50-89 ms to under 1 ms. At 50 turns every phase was already a few milliseconds.

Before the change, sending and parsing were under 2% of the read at 2,000 turns. The rest was applying: the
thread activity about 60%, ordering about 22%, identities, recording and the rest the remainder.

Reconciling also fell between the two sets of runs, though its code did not change, so the "before" runs met a
busier machine. After review, two more pairs were run back to back, each "before" run straight followed by an
"after" run:

| Pair | Open at 2,000 turns, before | Open, after | Reconciling, before | Reconciling, after | Open at 500, before | Open, after |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 6,248 ms | 1,456 ms | 226 ms | 211 ms | 1,621 ms | 197 ms |
| 2 | 10,002 ms | 1,597 ms | 453 ms | 223 ms | 974 ms | 379 ms |

In the first pair reconciling barely moved, which is what unchanged code should do. The open still fell four- to
six-fold at 2,000 turns, so the load explains the noise in the smaller phases, not the result. The rest fell
partly with the load and partly because it holds the thread activity's `turn` calls.

## What changed

- **Ordering once per read.** `applyThread` applies every turn without ordering and then orders once, after it has
  put the turn identities in Codex's order, where it already did. Nothing done while applying a turn reads the
  message window's order: the anchors and the thread activity use the last message recorded, and the log's
  lookups go by ID. A live turn, a turn the newest-turn check applies and a turn a send reads back still order
  the message window as before. The two orderings a read now makes are that one and the settling one after it.
- **Hashing a turn's activity ID once.** `anchor`, which runs for every user message applied, searched the
  thread activity for the turn's record with the SHA-256 of its ID computed inside the search, so once for every
  record it passed: up to 2,000 hashes for each message. It now computes the ID once. This was most of the
  thread activity's cost.
- **Placing an activity record.** Every activity record put on a thread rebuilt the whole list: a map of every
  record, its highest sequence, a sort and a slice, up to 2,000 records each time and several times a turn. The
  projection now remembers the list it last installed on the thread. While the thread still holds that list, it
  is already the merge's output, in sequence order with one record per ID, so a known record is replaced in
  place by the same merge rule and a new one is appended with the next sequence, dropping the oldest and marking
  the new first record truncated past the 2,000-record bound, as the merge does. A list anything else installed,
  such as a snapshot's frozen copy or a rewind's filter, takes the full merge as before.

## What a read shows

- **Message order and identities.** The message window's final order is the same: a rank that is unique for every
  message in Codex's turn identities, and a stable sort that keeps the rest in the order they were recorded.
  Identities are reconciled by the same code in the same order. Every adapter contract case and every Codex history,
  identity, rollback and newest-turn test passes unchanged.
- **Takeover detection.** The Codex session log's entries are the one place where the old per-turn ordering could
  differ. Ordering also drops an entry that exactly one of Sotto's message identities has since claimed, with the
  same role and text. Ordered after every turn, an entry could be dropped partway through a read on a claim that a
  later turn in the same read then made ambiguous, or withdrew by reconciling the claiming message to other text.
  Ordered once, the entry is judged on what the whole read shows, and an entry no longer claimed by exactly one
  message stays visible as input from outside Sotto. An entry is dropped only when the last ordering drops it, and
  the old way made that same last ordering, so the change can only keep an entry the old way hid, never hide one it
  kept. That is the conservative direction. No test reached that case before or after.
- **Activity.** `tests/unit/main/codexActivity.test.ts` drives the same 680 turns of started, streamed, completed
  and replayed items, anchors and turns through two projections, one of them forced onto the full merge after
  every call, and checks that both threads' activity is equal after every turn, past the 2,000-record bound. The
  other now and then holds a frozen snapshot copy, as it does after an emit, so it moves between both paths.

## What remains

After the change the read costs about the same per turn at every size, so opening grows with the thread. What is
left at 2,000 turns is spread thin. One inspector profile of an open there put the largest parts at: the thread
activity's searches of up to 2,000 records for each item, about 0.4 s; identity reconciliation's check that a new
message ID is not used anywhere in the thread, about 0.25 s, which does grow with the square of the thread but is
small at these sizes; a zod schema built afresh for every message's content, about 0.2 s; and the message log's
search of the message window for each message recorded, about 0.1 s. None is worth an issue of its own at these
sizes; the identity check is the one that would show first on a much longer thread.

## What these numbers are not

- The fake's times are Sotto's adapter over a small Node script, not a real client. The turn shapes are filler
  chosen to look like a coding turn, not measured from real threads.
- An open from the Threads page also goes through the Sotto thread host; the workspace and provider hosts hand
  the read on unchanged. The phases here are the adapter's own.
- Taken on the Windows development machine (Intel Core Ultra 9 275HX, Node v24.14.1) while other agents' test
  suites were running on it and its memory was near full, which is why some ranges are wide. Read them as sizes,
  not budgets. Nothing asserts a time.

## Re-run

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/codexOpenApply.perf.test.ts --maxWorkers=1 --disable-console-intercept
```


September 29: the adapter method is now named `reconcileMessages`, because it also repairs corroborated saved duplicates. The benchmark follows that name; the measurements above describe the earlier implementation.
