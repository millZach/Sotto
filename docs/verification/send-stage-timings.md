# A send's turn record times each send stage - 2026-10-05

Issue #763. A send's turn record in `turns.jsonl` now times each send stage from Send to the reply's first output
(`CONTEXT.md`, Send stage). Nothing on screen changes, so this note has no screenshots. The figures and the benchmark
are in [the performance note](../perf/2026-10-05-send-to-first-words.md).

## In the running app

`npm run build`, then `npx playwright test tests/e2e/send-stage-timings.spec.ts`: 2 passed. The spec launches the
built app with the real Claude and Codex adapters over the fake clients in `tests/fixtures/`, each answering every
prompt at once. From the window it creates a project on a Git working copy and a thread on the shared checkout, and
sends twice: once to start the provider session, once to the running session. It then reads `turns.jsonl` from the
profile. Each send's record held all six durations as whole milliseconds, an outcome of `completed`, and neither the
prompt, the reply nor the project's title. One run:

| | Admission | Read | Preparation | Adapter | Acknowledgement | First output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Claude, first send | 12 ms | 0 ms | 881 ms | 3 ms | 4 ms | 16 ms |
| Claude, second send | 15 ms | 1 ms | 458 ms | 6 ms | 3 ms | 13 ms |
| Codex, first send | 11 ms | 0 ms | 851 ms | 19 ms | 36 ms | 0 ms |
| Codex, second send | 13 ms | 15 ms | 481 ms | 7 ms | 34 ms | 0 ms |

The first send's read is 0 ms because a thread that has never been sent to has no provider thread to read yet;
the coordinator's read returns the workspace's own record.

The send path's own journeys still pass after the review's changes: `npm run test:recovery` (its seven files, then
the dictation recovery, command receipt and queued steering specs, which send from the composer and queue follow-ups)
and `tests/e2e/thread-composer-recovery.spec.ts`.

## Automated checks

- `tests/unit/main/agentTurns.test.ts`, "send stages": a typed send through the coordinator writes the six
  durations, its record waits for the first words while the command does not, and its finish time and `totalMs`
  stay at the command finishing when the first words come a minute later. The record's whole set of timing fields is
  pinned and holds no prompt, reply or path, and a turn that sends nothing has no send stages. A host that confirms
  nothing writes the record at once, a saved draft sent with Send times its admission and read, and a turn that ends
  having shown nothing, or a coordinator that closes first, writes the record without a first output.
- `tests/unit/main/sendStages.test.ts`: the arithmetic of each step, waiting and its two-minute limit, the stopwatch
  lent by command ID and a mark that never throws, the workspace marking a send prepared before the provider stack
  sees it, what counts as a reply's first output, and watching each thread for it.
- `tests/integration/adapterContract.ts`: the Claude, Codex and Grok adapters, over their fake clients, mark the
  prompt written and its acknowledgement on the stopwatch lent for the send. Devin and the fake provider skip it.
