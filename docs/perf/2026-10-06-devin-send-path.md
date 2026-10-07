# A send to Devin before Devin hears it - October 6, 2026

Issue #770, part of #762. On the development machine a send to Devin took about 6.4 s before Devin heard the prompt
(four sends, from #762's delivery records), and the reply appeared all at once at the end. This measures where that
went, what changed, and what a send costs now. ADR-0017's October 6 amendment records the decision.

The issue's line references were close to the code on `origin/main` (`afb131b9`) but had drifted a little: a read
is `readHistory` and `read` at `devin.ts:512-547`, `start()` is at `:231-269` and `revalidate` at `:270-285`, the
send at `:805-865` with its acceptance loop at `:855-864`, the hidden reply in `publishActive` at `:593-601`, the
poll at `:494-508`, and the policy checks at `devinPolicy.ts:88-104` and `:201-222`. The behaviour they describe
was as the issue says.

## Where a send's time went

Every Devin history read started an observer: a second `devin acp` process that ran the profile's presence checks,
`plugins list` and then `mcp list`, started, answered `initialize` and `_cognition.ai/config/read`, loaded and
replayed the whole session, ran both lists and the config read again, and was then refused the session (-32015)
because the thread's own connection held it. A send from the Threads page made three of those before
`session/prompt` (the coordinator's read before the send, the checkpoint's read, and the adapter's own read) and
ran the integration lists twice more besides: 19 processes. After the prompt it read the replay every 100 ms until
the dispatch identity appeared, kept the streamed reply hidden until then, and read again every 1.5 s while the
turn ran.

Now a send to a thread whose session Sotto holds reads no replay unless an earlier dispatch is still unconfirmed,
and neither does any other read of it but the poll. The profile and integrations are checked once, with the lists and
the config read side by side, and the send is accepted from the thread's own stream, which shows the reply as it
arrives.

## Against the fake ACP peer

`tests/perf/devinSendPath.perf.test.ts` sends five times to a warm thread in `tests/fixtures/fakeDevinAgent.mjs` the
way a send from the Threads page goes: the coordinator's read with `beforeSend`, the checkpoint's whole read, the
send, then the coordinator's reconciliation read. The fake streams the first words of a reply as soon as it has the
prompt. Each figure is the median of the five sends in a run, and each range is across three runs. "Before" is
`devin.ts` and `devinPolicy.ts` from `origin/main` (`afb131b9`) under the same benchmark.

| | Before | After |
| --- | ---: | ---: |
| Send to `session/prompt` | 1,635-1,792 ms | 134-152 ms |
| Send to accepted | 2,068-2,219 ms | 135-155 ms |
| Processes started before `session/prompt` | 19 | 2 |
| Observer reads per send, through the reconciliation read | 5 | 1 |
| Observer reads in 4 s of a running, streaming turn, at the production poll pace, from acceptance | 1-2 | 0 |

The two processes left are `plugins list` and `mcp list`, run together. The one observer read left is the
coordinator's reconciliation read after acceptance, which confirms the dispatch against the replay; it comes after
the prompt and the first words. `tests/integration/devinSendPath.test.ts` pins the count of 2 and shows reply text
reaching the message log with no observer read at all.

The running-turn row is counted from once the send was accepted, over three runs each, its "before" against
`devin.ts` and `devinPolicy.ts` from `origin/main` at `7d071b62`. An earlier version of this
note gave 2-3 for "before", counted from before the send, which took in the old send's own acceptance read. The 0
also rests on the poll's fifteen seconds starting when a thread is opened or created, since that has just read it;
before, the first poll after opening read it again at once.

## Against Devin CLI 3000.10.31

The same pieces timed against the installed CLI on Windows, without sending any prompt, median of five, two runs:

| Piece | Time |
| --- | ---: |
| `plugins list` then `mcp list` | 437-514 ms |
| `plugins list` and `mcp list` side by side | 250-252 ms |
| An ACP process started, initialized, asked for its config and closed | 245-249 ms |

An observer read was therefore at least about 1.2 s before it replayed anything: the two lists, the process, and
the two lists again, with the session's replay on top, which grows with the thread. Three of them and two more
pairs of lists come to the 4-5 s the fake's shape predicts, which is most of the 6.4 s #762 measured. A send now
spends about one side-by-side pair of lists, 250 ms, with the config read and the dispatch record's save beside and
after it.

The live suite (`docs/verification/2026-10-06-devin-send-path.md`) timed each send from Send to accepted, which now
includes Devin's own time to its first streamed work: 642 to 2,438 ms across five sends in the final run (774 ms
at the median), and 700 to 1,035 ms in the run before it.

## What these numbers are not

- The fake's times are Sotto's adapter and a small Node script, and its processes start much faster than Devin's.
  The counts are exact; the times are sizes. The real CLI figures are the pieces alone, not a send.
- No live "before" was taken. The 6.4 s is #762's measurement from delivery records, and the live "after" includes
  the model, so the two are not the same interval. Send to `session/prompt` against the real CLI was not measured
  directly.
- The checkpoint's read before a send is #764's. It starts no observer now because the thread's session is held
  and its dispatches confirmed, not because the checkpoint changed. The coordinator's reconciliation read after
  acceptance is #765's and was left as it is.
- Opening a session is unchanged: it still checks before the process starts and again after the load, and replays
  the whole session. A first send to a thread nobody has open pays for that.
- Taken on the Windows development machine with Node v24.14.1 while another builder's suite was running on it.
  Nothing asserts a time.

## Re-run

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/devinSendPath.perf.test.ts --maxWorkers=1 --disable-console-intercept
SOTTO_PERF_BENCH=1 SOTTO_DEVIN_PIECES=1 npx vitest run tests/perf/devinSendPath.perf.test.ts --maxWorkers=1 --disable-console-intercept
SOTTO_DEVIN_LIVE=1 npx vitest run tests/integration/devinLive.test.ts --maxWorkers=1 --disable-console-intercept
```

For "before", put `src/main/agents/devin.ts` and `src/main/agents/devinPolicy.ts` from `afb131b9` in place and run
the first line; the benchmark's options that the old adapter does not know are ignored.
