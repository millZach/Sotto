# Send to first words - October 5, 2026

Issue #763, part of #762. Nothing measured a send from Send to the first words on screen, so #762's figures were
pieced together after the fact from `agents.json`, `claude-threads.json` and Claude Code's own session logs. Two
things now measure it: every send's turn record times each send stage (`CONTEXT.md`, Send stage), and
`tests/perf/sendToFirstWords.perf.test.ts` drives sends through the whole stack and reports them. These are the
"before" figures: `main` at `e8a82a03` with only the measuring added, before any of #762's other children.

## What is measured

A send's turn record in `turns.jsonl` gains six durations in whole milliseconds, and nothing else:

| Field | The step |
| --- | --- |
| `admissionMs` | The coordinator's own work before its host: the draft's admission write, the wait for the thread's lane, the outbox write, and for a spoken send working out what was said. |
| `readBeforeSendMs` | The coordinator's read of the thread immediately before the send. |
| `preparationMs` | The workspace: the folder check, the branch record and the checkpoint, and on a first send starting the provider session. |
| `adapterMs` | The adapter's own work before it writes the prompt to its client, including its own reads and saves. |
| `acknowledgementMs` | From the prompt written to the client confirming it: Claude Code echoing it, Codex answering `turn/start`, Grok echoing it. |
| `firstOutputMs` | From the acknowledgement to the reply's first text, thinking or tool activity reaching the coordinator. |

The first four add up to the time to the provider hearing the prompt; all six to the first words. `delegationMs` and
`totalMs` mean what they meant: the host's `execute` call, and the turn starting in its lane to the command
finishing. `totalMs` starts after the wait for the thread's lane, which admission includes, so the six stages can add
up to more than it. A turn that sends nothing has none of the six. Each layer marks its own step on a stopwatch the
coordinator lends by the send's command ID (`src/main/agents/sendStages.ts`), so a command stays plain data. Claude,
Codex and Grok mark the prompt written and its acknowledgement; Devin does not yet, and its records leave those two
null. A record whose provider acknowledged the prompt is held in memory and written when the first output arrives,
when the reply ends without one, when the thread is sent to again, when Sotto stops, or after two minutes, whichever
is first; the command does not wait for it. `tests/unit/main/agentTurns.test.ts` pins the record's whole set of
timing fields, so a field that could carry text cannot be added unnoticed, and checks the line holds neither the
prompt nor the reply. The adapter contract (`tests/integration/adapterContract.ts`) holds each adapter's marks in the
CI gate. `tests/e2e/send-stage-timings.spec.ts` sends from the built app's window over the fake clients and finds all
six durations in the profile's `turns.jsonl`.

## How

`tests/perf/sendToFirstWords.perf.test.ts` builds the provider stack with `createAgentRuntime`, as the app does,
with Git status read as the app reads it (30-second fetch interval, window in front) and `connectCheckpoints` wired
in as `src/main/index.ts` wires it. The provider is the real Claude or Codex adapter over the fake client in
`tests/fixtures/`, scripted to answer every prompt at once (`script.json` `reply`; the fake Claude CLI learned it in
this change). It creates a project on a real Git working copy, a thread on the shared checkout, and sends
`manual-send` through the host service the window's IPC uses. The first send starts the provider session and is
reported apart; seven more follow. Each starts once the one before it has finished: its reply and its end shown to
the window, its record written, and the checkpoint that completes its turn saved. Without that last wait the next
send's checkpoint queued behind the previous turn's, and its Git processes and writes were counted in the wrong send.
Two working copies, each committed: 50 files of filler, 1 MiB; and 3,843 files, 278 MiB, the shape of this
repository, past the checkpoint's 64 MiB limit.

For each send it reads the turn record, times the command, and times from Send to the first state the coordinator
publishes with a new reply message in it ("in the coordinator's state" below). It counts the adapter's
`refreshThread` calls (every read of the provider's thread, whoever asks), Git processes started (`spawn` and `execFile` of `git`), and atomic store
writes, by file; each up to the moment the prompt is written and over the whole send, including the checkpoint that
completes it. Each timing is the median of seven sends; each range is across three runs on the development machine
(Windows 11), shared with another build. Each count is reported with its median and its least and most across the
seven sends, since some race the reply.

## Before (main, `e8a82a03`)

Median per send, range across three runs on October 6.

| | Claude, 1 MiB | Codex, 1 MiB | Claude, 278 MiB | Codex, 278 MiB |
| --- | ---: | ---: | ---: | ---: |
| To the provider hearing the prompt | 493-557 ms | 508-629 ms | 4,249-5,462 ms | 4,339-5,359 ms |
| To the first words (record) | 507-572 ms | 550-667 ms | 4,267-5,480 ms | 4,409-5,402 ms |
| To the first words in the coordinator's state | 511-574 ms | 540-660 ms | 4,268-5,481 ms | 4,400-5,391 ms |
| Admission | 12-13 ms | 11-14 ms | 14-17 ms | 8-12 ms |
| Read before the send | 2-3 ms | 7 ms | 2-3 ms | 12-21 ms |
| Workspace preparation | 471-534 ms | 476-594 ms | 4,217-5,429 ms | 4,297-5,313 ms |
| of which the checkpoint | 346-379 ms | 344-440 ms | 3,944-5,115 ms | 3,894-4,960 ms |
| Adapter before the write | 6-7 ms | 10-12 ms | 7-8 ms | 15 ms |
| Acknowledgement | 2-3 ms | 33-38 ms | 3-4 ms | 39-45 ms |
| First output | 11-15 ms | 0 ms | 12-15 ms | 0 ms |

Per send, across all three runs: the median, then the least and most where they differ.

| Per send | Claude, 1 MiB | Codex, 1 MiB | Claude, 278 MiB | Codex, 278 MiB |
| --- | ---: | ---: | ---: | ---: |
| Thread reads before the prompt is written | 4 | 3 | 4 | 3 |
| Thread reads, whole send | 5 | 3 | 5 | 3 |
| Git processes before the prompt is written | 10 | 10 (10-18) | 14 (10-18) | 14 (8-18) |
| Git processes, whole send | 15 (15-26) | 15-18 (15-26) | 15 (11-19) | 15 (10-19) |
| Atomic store writes before the prompt is written | 5 (5-6) | 6 | 6 (5-7) | 7 (7-8) |
| Atomic store writes, whole send | 8-9 (8-10) | 17 | 8 (7-9) | 16 (16-18) |

A typical Claude send wrote `agents.json` three times, `claude-threads.json` once or twice and `checkpoints.json`
once before the prompt went out, then `agents.json`, `claude-threads.json`, `workspace.json` (twice or three times)
and, on the small working copy, `checkpoints.json` once more for the completed turn. A Codex send wrote `agents.json`
three times, `codex-threads.json` twice, `checkpoints.json` once and on the large working copy `workspace.json` once
before, then `agents.json` twice more, `workspace.json` once or twice, `codex-threads.json` seven more times while its
reply streamed, and on the small working copy `checkpoints.json` once more. The first send, which starts the provider
session, took 888-983 ms (Claude) and 913-1,398 ms (Codex) to the provider hearing it on the small working copy, and
4,202-5,732 ms on the large one.

What it says: nearly all of Sotto's time before the provider hears the prompt is the workspace's preparation, and
most of that is the checkpoint, which on the large working copy reads files until it passes the 64 MiB limit and
then fails, on every send (#764). Ten Git processes start before every prompt is written on the small working copy,
and about fourteen on the large one (#766). Claude reads the thread four times before the write and Codex three: the
coordinator's read before the send, the checkpoint's read, and the adapter's own (two in Claude's send) (#765). The
large working copy reproduces #762's measured median of 2.8 s before Claude hears the prompt, and on these runs
exceeds it.

The first runs, on October 5, sent back to back without waiting for the completing checkpoint. They counted 14 Git
processes before the write on the small working copy, four of them the previous turn's capture, and once in three
runs a fourth Codex read over the whole send: the coordinator's read after acceptance, which happens only when the
prompt's echo has not already settled the outbox. Waiting for the last turn's end, every Codex send in these runs
read three times. The large working copy's checkpoint took 2.0-3.3 s on October 5 and 3.9-5.1 s on October 6. Its
capture fails and leaves nothing to wait for, so the wait does not explain the difference; the machine's load does.

## What the numbers are not

- Not a model's time. The fake clients answer at once, so the acknowledgement and the first output here are Sotto's
  handling plus a Node process reading and writing a line. With Claude Code the echo comes at the API's
  `message_start`, about 1-2 s after it hears the prompt, and the first output is the model's first block; 100 of
  114 Claude replies in #762 opened with thinking, which this version drops until #768.
- Not paint, and not the window. "In the coordinator's state" is the first state the coordinator publishes with a
  new reply message in it, before main's IPC coalescing (up to 50 ms) and the renderer; both are #771's to measure.
- Not a first output for Codex. Its acknowledgement is marked once `turn/start`'s reply has been applied, and the
  fake's first delta reaches the coordinator before that, so the step would be negative and reads 0 ms. Read Codex's
  first words as arriving with its acknowledgement. The record's first output is when the coordinator saw it.
- Not a quiet machine. Another build ran alongside, which is why the large working copy's ranges are wide and why
  they moved between days. Compare a change against a run on the same machine at the same time.
- Not every provider. Grok and Devin are not in the benchmark. Grok's records time every step; Devin's time
  admission, the read and the workspace until its adapter marks the write and the acknowledgement.
- The fake Claude CLI is a Node script; Claude Code takes about 0.85 s to start and answer `initialize`, which only
  the first send pays.

## Re-run

```sh
# sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/sendToFirstWords.perf.test.ts --maxWorkers=1 --disable-console-intercept
# PowerShell
$env:SOTTO_PERF_BENCH = '1'; npx vitest run tests/perf/sendToFirstWords.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

It writes the working copies to the temporary folder first (about 280 MiB for the large one, plus Git's copy) and
removes them afterwards, even when it fails part-way; one run takes about two minutes. `SOTTO_PERF_LARGE_FILES` and
`SOTTO_PERF_LARGE_MIB` change the large working copy, and `SOTTO_PERF_SENDS` the number of timed sends after the
first. The proof in the running app is `npm run build`, then `npx playwright test tests/e2e/send-stage-timings.spec.ts`.
