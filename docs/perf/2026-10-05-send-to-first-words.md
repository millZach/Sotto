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
| `admissionMs` | The coordinator's own work before its host: the draft's admission write, the wait for the thread's lane, the outbox write. |
| `readBeforeSendMs` | The coordinator's read of the thread immediately before the send. |
| `preparationMs` | The workspace: the folder check, the branch record and the checkpoint, and on a first send starting the provider session. |
| `adapterMs` | The adapter's own work before it writes the prompt to its client, including its own reads and saves. |
| `acknowledgementMs` | From the prompt written to the client confirming it: Claude Code echoing it, Codex answering `turn/start`. |
| `firstOutputMs` | From the acknowledgement to the reply's first text, thinking or tool activity reaching the coordinator. |

The first four add up to the time to the provider hearing the prompt; all six to the first words. `delegationMs` and
`totalMs` mean what they meant: the host's `execute` call, and Send to the command finishing. Each layer marks its own
step on a stopwatch the coordinator lends by the send's command ID (`src/main/agents/sendStages.ts`), so a command
stays plain data. Claude and Codex mark the prompt written and its acknowledgement; Grok and Devin do not yet, and
their records leave those two null. A record whose provider acknowledged the prompt is written when the first
output arrives, when the reply ends without one, or after two minutes, whichever is first; the command does not
wait for it. `tests/unit/main/agentTurns.test.ts` pins the record's whole set of timing fields, so a field that
could carry text cannot be added unnoticed, and checks the line holds neither the prompt nor the reply.
`tests/e2e/send-stage-timings.spec.ts` sends from the built app's window over the fake clients and finds all six
durations in the profile's `turns.jsonl`.

## How

`tests/perf/sendToFirstWords.perf.test.ts` builds the provider stack with `createAgentRuntime`, as the app does,
with Git status read as the app reads it (30-second fetch interval, window in front) and `connectCheckpoints` wired
in as `src/main/index.ts` wires it. The provider is the real Claude or Codex adapter over the fake client in
`tests/fixtures/`, scripted to answer every prompt at once (`script.json` `reply`; the fake Claude CLI learned it in
this change). It creates a project on a real Git working copy, a thread on the shared checkout, and sends
`manual-send` through the host service the window's IPC uses. The first send starts the provider session and is
reported apart; seven more follow, each after the last reply finished. Two working copies, each committed: 50 files
of filler, 1 MiB; and 3,843 files, 278 MiB, the shape of this repository, past the checkpoint's 64 MiB limit.

For each send it reads the turn record, times the command, and times from Send to the first state the window is
sent with the reply in it ("in the window" below). It counts the adapter's `refreshThread` calls (every read of
the provider's thread, whoever asks), Git processes started (`spawn` and `execFile` of `git`), and atomic store
writes, by file; each up to the moment the prompt is written and over the whole send. It also times the checkpoint
hook inside the workspace's preparation. Each figure is the median of seven sends; each range is across three runs
on the development machine (Windows 11), shared with another build.

## Before (main, `e8a82a03`)

Median per send, range across three runs.

| | Claude, 1 MiB | Codex, 1 MiB | Claude, 278 MiB | Codex, 278 MiB |
| --- | ---: | ---: | ---: | ---: |
| To the provider hearing the prompt | 509-626 ms | 547-580 ms | 2,556-3,560 ms | 2,214-2,989 ms |
| To the first words (record) | 520-636 ms | 570-607 ms | 2,568-3,572 ms | 2,238-3,017 ms |
| To the first words in the window | 529-642 ms | 570-607 ms | 2,574-3,580 ms | 2,240-3,015 ms |
| Admission | 8-13 ms | 7-10 ms | 10-11 ms | 6-7 ms |
| Read before the send | 2-5 ms | 10-12 ms | 1-2 ms | 4-6 ms |
| Workspace preparation | 498-596 ms | 496-547 ms | 2,505-3,543 ms | 2,194-2,972 ms |
| of which the checkpoint | 357-433 ms | 316-372 ms | 2,036-3,291 ms | 1,875-2,611 ms |
| Adapter before the write | 4-5 ms | 7-8 ms | 5-6 ms | 8-9 ms |
| Acknowledgement | 2 ms | 20-27 ms | 2-3 ms | 18-21 ms |
| First output | 8-13 ms | 2-3 ms | 9-13 ms | 2-7 ms |

| Per send | Claude | Codex |
| --- | ---: | ---: |
| Thread reads, before the prompt is written / whole send | 4 / 5 | 3 / 3 (4 in one large run) |
| Git processes, before / whole | 14 / 15-17 | 14 / 15-16 |
| Atomic store writes, before / whole | 5-7 / 7-9 | 6-8 / 16-17 |

A typical Claude send wrote `agents.json` three times, `claude-threads.json` once and `checkpoints.json` once or twice
before the prompt went out, then `agents.json`, `claude-threads.json` and `workspace.json` (twice) after it. A Codex
send wrote `agents.json` three times, `codex-threads.json` twice, `checkpoints.json` once or twice and sometimes
`workspace.json` once before, then `agents.json` twice more, `workspace.json` once and `codex-threads.json` seven more
times while its reply streamed. The first send, which starts the provider session,
took 773-889 ms to the provider hearing it on the small working copy and 2,850-4,115 ms on the large one.

What it says: nearly all of Sotto's time before the provider hears the prompt is the workspace's preparation, and
most of that is the checkpoint, which on the large working copy reads files until it passes the 64 MiB limit and
then fails, on every send (#764). Fourteen Git processes start before every prompt is written (#766). Claude reads
the thread four times before the write and Codex three: the coordinator's read before the send, the checkpoint's
read, and the adapter's own (two in Claude's send) (#765). The large working copy reproduces #762's measured median
of 2.8 s before Claude hears the prompt.

## What the numbers are not

- Not a model's time. The fake clients answer at once, so the acknowledgement and the first output here are Sotto's
  handling plus a Node process reading and writing a line. With Claude Code the echo comes at the API's
  `message_start`, about 1-2 s after it hears the prompt, and the first output is the model's first block; 100 of
  114 Claude replies in #762 opened with thinking, which this version drops until #768.
- Not paint. "In the window" is the first state handed to the window's listeners with the reply in it; the
  renderer's own work after that is #771's to measure. The record's first output is when the coordinator saw it.
- Not a quiet machine. Another build ran alongside, which is why the large working copy's ranges are wide. Compare a
  change against a run on the same machine at the same time.
- Not every provider. Grok and Devin are not in the benchmark, and their records time only admission, the read and
  the workspace until their adapters mark the write and the acknowledgement.
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
removes them afterwards; one run takes about 90 seconds. `SOTTO_PERF_LARGE_FILES` and `SOTTO_PERF_LARGE_MIB` change
the large working copy, and `SOTTO_PERF_SENDS` the number of timed sends after the first. The proof in the running
app is `npm run build`, then `npx playwright test tests/e2e/send-stage-timings.spec.ts`.
