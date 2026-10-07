# The read before a Codex send - September 26, 2026

Issue #324. Before `turn/start`, a Codex send called `refreshThread`, which read the whole transcript with
`thread/read` and `includeTurns: true`, applied every turn, saved the thread record, and tried again up to three times
if the thread moved while it read. The read is there so that a reply written against an old last message is refused
when someone has since typed into the same session from another Codex process. It grew with the thread, so it was
measured first, and the decision followed from what the installed Codex offered.

The decision: every read made immediately before a send now asks for the newest turn alone, with
`thread/turns/list`, and reads the whole transcript only when that turn is not the finished one Sotto already holds
(the newest-turn check, ADR-0005). What it rests on is under "Against Codex CLI 0.157.1" below. The references in the
issue still pointed at the right code: `codex.ts:384` is the personal-chat send's read and `codex.ts:446` is
`refreshThread` itself; the project send's read was further down, in `executeNative`. A send from the Threads page
also made a whole read of its own in the coordinator before dispatching, so that read asks for the check too.

## Against the fake app-server

`tests/perf/codexSendRead.perf.test.ts` seeds a thread in `tests/fixtures/fakeCodexAppServer.mjs` with 50, 500 and
2,000 finished turns, opens it the way the Threads page does, and sends five prompts, each after the last one's turn
has finished and with `expectedLastUserMessageId` set to the thread's last user message. A seeded turn is a
200-character prompt, a reasoning summary, a command with 2 KB of output and a 1,200-character reply, all filler,
which makes a whole read about 4.4 KB a turn. It times the send, `refreshThread` inside it, and within that the round
trips and the applying and saving done inside them; it counts the requests each send made and weighs the replies the
fake sent. Each figure is the median of the five sends in a run, and each range is across three runs.

### What a user sees: a send from the Threads page

The benchmark's second half sends the way the Threads page does: a `manual-send` command to the coordinator, timed
until the command returns. The coordinator sits over the adapter behind the Sotto thread host, which maps Sotto thread
IDs to the adapter's own. The workspace and provider hosts the app also puts between them are left out; they hand
the read's purpose on unchanged, which `tests/unit/main/threadReadPurpose.test.ts` checks. "Before" is this branch
with the check switched off, which is the code on `origin/main` (`e093bd6c`) for every read it makes; "after" is
this change. The table was first taken with the check switched off by hand. The benchmark now does the same with
`SOTTO_PERF_WITHOUT_TURNS_LIST=1`, which has the fake refuse `thread/turns/list` the way a Codex without it does.

| Turns | Send, before | Send, after | Reads inside it, before | Reads inside it, after |
| ---: | ---: | ---: | ---: | ---: |
| 50 | 73-110 ms | 42-109 ms | 48-59 ms | 13-24 ms |
| 500 | 834-983 ms | 106-239 ms | 773-902 ms | 39-76 ms |
| 2,000 | 6,472-6,631 ms | 255-503 ms | 6,283-6,314 ms | 95-168 ms |

Before, every send read the whole transcript twice before `turn/start`: once in the coordinator and once in the
adapter. After, neither did; each asked for the newest turn. Neither version read it again after `turn/start`,
because Codex's own echo of the message settled the send before the coordinator's reconciliation read was needed.

One run of each mode after review, with the committed switch and on a busier machine, gave the same shape. Sends
from the Threads page took 97, 1,447 and 8,404 ms at 50, 500 and 2,000 turns with the check off, each making two
whole reads before `turn/start`, and 66, 136 and 335 ms with it on, making none. The adapter's own sends took 67,
1,449 and 3,758 ms against 36, 80 and 228 ms.

### The adapter's own read

The first half calls the adapter's `execute` directly, which is the read inside the adapter alone and the path a
personal-chat send shares. "Before" here is `codex.ts` as of `origin/main` (`e093bd6c`) under the same benchmark.

| Turns | Send, before | Send, after | Read inside it, before | Read inside it, after |
| ---: | ---: | ---: | ---: | ---: |
| 50 | 51-81 ms | 25-32 ms | 32-51 ms | 8-9 ms |
| 500 | 478-728 ms | 65-108 ms | 429-669 ms | 18-31 ms |
| 2,000 | 2,920-5,481 ms | 235-280 ms | 2,723-5,286 ms | 60-99 ms |

| Turns | Whole reads per send, before / after | Reply size, before | Reply size, after |
| ---: | ---: | ---: | ---: |
| 50 | 1 / 0 | 220,566 bytes | at most 4,440 bytes |
| 500 | 1 / 0 | 2,187,966 bytes | at most 4,440 bytes |
| 2,000 | 1 / 0 | 8,745,966 bytes | at most 4,440 bytes |

Where the old read's time went: applying the reply was 15-20 ms of it at 50 turns, 392-601 ms at 500 and
2,540-4,989 ms at 2,000. From 500 turns up, 90-95% of the read was Sotto's own work rather than Codex sending the
transcript, and it grew faster than the thread did. Saving the thread record inside the read was 3-38 ms at every
size. After the change every send in every run was answered by the check alone: one `thread/turns/list` of one turn,
no `thread/read`. The largest such reply is the first send's, whose newest turn is a seeded one; after that the newest
turn is the benchmark's own short one, 442 bytes, whose user message is 170 bytes. That user message is all the
`expectedLastUserMessageId` check compares, and the old read carried the whole thread to get it.

What remains of the read at 2,000 turns, 60-99 ms, is mostly the fake: it copies the whole thread to answer any
history request, and its save of the thread on `turn/start` is inside the send figure too. Saving the thread record,
which holds an identity for every turn, was 19-38 ms of it.

After review the check saves the thread record only when applying the newest turn changed it, which a turn Sotto
already holds usually does not. One run afterwards, with the fake's history naming items as the stream does, made
no save inside any check. The adapter's read took 4.7, 11 and 45 ms at 50, 500 and 2,000 turns and its whole send
23, 68 and 204 ms; sends from the Threads page took 57, 119 and 347 ms, with no whole read before or after
`turn/start`.

## Against Codex CLI 0.157.1

The fake cannot say what the real app-server does, so the check was built only after the installed client showed
four things. Claim 1 comes from the generated schema alone. `tests/integration/codexNewestTurnLive.test.ts`
(`SOTTO_CODEX_TURNS_LIVE=1`) repeats claims 2 to 4, apart from the `thread/items/list` aside in claim 2. It
initializes the way Sotto's adapter does, asking for the experimental API, so it cannot show claim 1 itself. It starts
the installed app-server in a throwaway `CODEX_HOME`, so it reads none of the user's Codex threads and needs no
sign-in, starts a legacy thread, makes its session file exist with one injected message pair, and writes filler turns
into that file the way Codex writes a turn. No model turn is run.

1. `thread/turns/list` is in the generated schema without `--experimental`, newest first by default, with `limit`
   and `itemsView`.
2. It works on a legacy thread, which is what Sotto creates. (`thread/items/list` does not: "not supported yet".)
3. Its one newest turn has the same turn ID, item IDs and status as the last turn of `thread/read`, and each request
   hands back the same newest turn on every read.
4. On a thread this app-server has resumed, both see a turn written to the session file from outside, which is how a
   second Codex process adds one. The thread's `updatedAt` did not move when that turn was written, so a timestamp
   could not have stood in for either request.

Each request's round trip at the check's own client, median of five, ranges across five runs:

| Turns | Session file | `thread/read`, includeTurns | Reply | `thread/turns/list`, limit 1 | Reply |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 50 | 0.3 MB | 5.5-7.5 ms | 108,703 bytes | 4.8-6.8 ms | 2,377 bytes |
| 500 | 2.8 MB | 30-69 ms | 1,080,304 bytes | 25-54 ms | 2,380 bytes |
| 2,000 | 11.1 MB | 117-150 ms | 4,321,804 bytes | 94-119 ms | 2,380 bytes |

The two take nearly the same time, so Codex appears to read the whole legacy session file for either request and
the check saves it little. What the check saves is the transcript on the pipe, 4.3 MB at 2,000 turns of this shape,
and Sotto parsing and applying all of it, which the fake shows is where the seconds were.

The same client answers a request it does not have, and a params value it does not know, in one shape: an invalid
request naming an unknown variant (``unknown variant `thread/bogus/list` ``, ``unknown variant `bogus` ``). Either would
be refused the same way on every send, since the check always sends the same values, so either stops Sotto asking for
the check on that connection. The live suite checks that wording, so a Codex that changes it shows there.

## What the check keeps

The check decides whether a whole read is needed, never whether the send may go. When it finds nothing changed, the
send makes the same `expectedLastUserMessageId`, running and request checks as before; anything else reads the whole
transcript as before. A reply counts only when it says it carries the full items: Sotto's turn schema would take a
missing `itemsView` as full, and the check does not. ADR-0005's follow-up keeps the full list of what reads whole, and `confirmNewestTurn` in
`codex.ts` is that list in code. The session log is polled before the check and again before `turn/start`, as it was.

The adapter contract's takeover and stale-input cases pass unchanged. `tests/integration/codexNewestTurn.test.ts`
adds the check's own cases on the fake: sends after a finished turn, from the adapter, a personal chat and the
Threads page, use the check alone, including when Codex names history items differently from its stream. A turn
another process added or is still running, and a message in the newest turn Sotto cannot match, are read in full and
the stale reply refused before `turn/start`. Input typed into the session log is refused on the check alone. A turn
another process took back is read in full and the send goes, as it did before. A turn that does not match leaves the
thread as it was when the whole read after it fails. A reply without `itemsView` is read in full. Any refusal, and a
check that gets no reply in time, is read in full, and the send goes when that read allows it. A Codex without
`thread/turns/list`, or without a value the check sends, is not asked again on that connection.
`tests/unit/main/threadReadPurpose.test.ts` shows that the workspace, provider and Sotto thread hosts hand the read's
purpose on, that the coordinator marks its reads before a manual send, a draft send and a supervision follow-up, and
that its assign, select and retry reads stay whole.

## What these numbers are not

- A send from the Threads page is the figure a user waits on. The adapter figures are one part of it, and they are
  also what a personal-chat send waits on. The coordinator's reconciliation read after Codex accepts a send is still
  whole; it did not run in the benchmark because Codex's echo settled every send first, and it is left as it was.
- The fake's times are Sotto's adapter and a small Node script, not a real client; the real client's times are its
  round trips alone, without Sotto applying the reply. The turn shapes in both are filler chosen to look like a
  coding turn, not measured from real threads.
- Opening a thread still reads it whole and was not changed: 9.2-11.8 s at 2,000 turns before and 12.6-17.1 s after
  on the fake in the first measurement, the same code on a busier machine, and 6.1-16.3 s across the Threads-page
  runs. That applying cost grows faster than the thread does. `applyTurn` sorts the whole message window once for
  every turn it applies, which is a likely cause; it was not measured separately and is left for its own issue,
  [#352](https://github.com/millZach/Sotto/issues/352). That issue has since measured it: the sort was about a fifth
  of the cost and the thread activity most of the rest (`2026-09-27-codex-open-apply.md`).
- Taken on the Windows development machine (Intel Core Ultra 9 275HX, Node v24.14.1) while other agents' test
  suites were running on it, which is why some ranges are wide. Read them as sizes, not budgets. Nothing asserts a
  time.

## Re-run

The first line gives the "after" figures, the second the "before" ones: the same benchmark with the fake refusing
`thread/turns/list` as a Codex without it does, so every read before a send is whole.

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/codexSendRead.perf.test.ts --maxWorkers=1 --disable-console-intercept
SOTTO_PERF_BENCH=1 SOTTO_PERF_WITHOUT_TURNS_LIST=1 npx vitest run tests/perf/codexSendRead.perf.test.ts --maxWorkers=1 --disable-console-intercept
SOTTO_CODEX_TURNS_LIVE=1 npx vitest run tests/integration/codexNewestTurnLive.test.ts --maxWorkers=1 --disable-console-intercept
```

Since #765 the coordinator's check stands for the adapter's own while the thread has not moved, so a send from the
Threads page makes one newest-turn check, and the reconciliation read after Codex accepts a send asks the workspace for
the echo it holds before reading whole (`2026-10-05-one-read-per-send.md`).
