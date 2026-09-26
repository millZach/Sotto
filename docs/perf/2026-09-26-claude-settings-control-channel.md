# Claude settings over the control channel - September 26, 2026

Issue #317. A chip press on a Claude thread used to stop its CLI, wait for it to close, save, and start it again with `--resume` and the initialize handshake. It now sends the running CLI `set_model`, `apply_flag_settings` with `effortLevel`, or `set_permission_mode`, and saves once the CLI answers. A thread with no CLI running, a request the CLI refuses, and entering or leaving full access still start the CLI again.

What was measured is chip press to adapter accepted: from `configure-thread` reaching the adapter to its result. That leaves out the coordinator's own reads and writes around it, which are #318's, and the window.

## Against the scripted CLI

`tests/perf/claudeSettings.perf.test.ts` presses the effort chip nine times on each of two threads, alternating between two levels, against `tests/fixtures/fakeClaudeThread.mjs`. It counts the CLI starts and settings requests each press cost, from the fake's own record of what it received, and times each press. "Not running" is a saved thread whose CLI has not started, as after the session reaper stopped it; each press lands on a different such thread. "Running" is one thread whose CLI is up and idle. "Before" is `claude.ts` and `claudeProtocol.ts` as of `origin/main` (`c4b8af02`) under the same benchmark; "after" is this change. Each was run three times; the medians are across the nine presses of a run, and the ranges across the three runs.

| Session | Before | After | CLI starts per press, before / after | Settings requests per press, before / after |
| --- | ---: | ---: | ---: | ---: |
| Not running | 83.3-86.5 ms | 82.9-85.0 ms | 1 / 1 | 0 / 0 |
| Running | 77.8-88.6 ms | 3.5-4.6 ms | 1 / 0 | 0 / 1 |

With background work running, the old code refused every press and the new one applies it: the adapter contract and `tests/integration/claudeSettings.test.ts` assert that it applies, starts nothing and leaves the work running. There is no time to compare there.

The scripted CLI is a small Node script that exits as soon as its input closes and answers initialize at once, so its restart costs about 80 ms. That is the floor of a restart, not what a real one costs, which is why the live figures below matter more.

## Against Claude Code 2.1.283

The opt-in live check (`tests/integration/claudeSettingsLive.test.ts`, `SOTTO_CLAUDE_LIVE=1`) ran the new path against the installed CLI four times, with no model turn; `docs/verification/2026-09-26-claude-settings-live.md` has the runs. For the old path on a running session it stops the thread's CLI through the adapter and then presses, which starts it again: the same stop, save and start the old `configure-thread` did.

| Press, running session | Before (stop and start again) | After (control channel) |
| --- | ---: | ---: |
| Effort | 1,301-1,593 ms | 52-142 ms |
| Permission mode | 1,301-1,593 ms | 4-33 ms |
| Model, to a different model | 1,301-1,593 ms | 668-823 ms |
| Model, to another name for the same model | 1,301-1,593 ms | 80-97 ms |

A press on a thread whose CLI is not running took 771-1,053 ms with this change. The old code did the same save and single start there, so it was not run again; the scripted CLI above shows the two paths costing the same. The before column is one number per run for every press, because the old path did the same thing whatever changed.

## What these numbers are not

They are the adapter's share of a press, not what the user sees. The coordinator still reads the thread before and after dispatch and writes its outbox twice; #318 removes most of that, and the chip already shows the chosen level while the save runs. The live runs are single presses, not medians, taken on the development machine (Windows 11, Intel Core Ultra 9 275HX, Node v24.14.1) while other agents' test suites were running on it, so read them as sizes rather than budgets. The live model change spends most of its time in the CLI: Sotto's own part of a press is the few milliseconds the permission-mode press shows. Nothing here asserts a time; the benchmark runs only under `SOTTO_PERF_BENCH=1`, and the counts it prints are asserted by the adapter contract in the default run.

## Re-run

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/claudeSettings.perf.test.ts --maxWorkers=1 --disable-console-intercept
SOTTO_CLAUDE_LIVE=1 npx vitest run tests/integration/claudeSettingsLive.test.ts --maxWorkers=1 --disable-console-intercept
```
