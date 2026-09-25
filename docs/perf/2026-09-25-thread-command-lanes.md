# Thread commands in the window's lanes

Issue #311. Main runs a thread's own commands in that thread's lane, and Stop in no lane at all. The window undid that. It sent most commands through one promise chain, so a command waited for the reply to the one before it, whichever thread that was. A permission change on Workshop waited for Docs' answer to come back before main heard of it.

The window now reads the same list main does, `THREAD_SCOPED_COMMAND_TYPES` in `src/shared/threadLanes.ts`. Those commands, and Stop, go to main at once. Assignment moves, a new thread, settling or restoring a project and the single composer draft still wait in the window's chain, because main keeps them global too.

## How it was measured

`tests/perf/threadCommandLanes.perf.test.tsx` mounts the window's connection over a real coordinator and the fixture provider, in one process. Each run raises a fresh question on Docs, answers it, and at once changes Workshop's permission mode. It times, with `performance.now()`, when the Workshop change reaches the bridge and when its reply is back in the window. The fixture provider takes 0 ms or 250 ms to acknowledge the answer; 250 ms stands in for a real adapter's round trip. Each figure is the median of eight runs. No prompt, answer or thread text is read or reported, only durations.

```sh
SOTTO_PERF_LANES=1 npx vitest run tests/perf/threadCommandLanes.perf.test.tsx --disable-console-intercept
```

It is skipped in the default run. With `SOTTO_PERF_ASSERT=1` as well it fails when the change takes more than half the acknowledgement to reach main.

"Before" is `AgentContext.tsx` from `origin/main` at `242af9b1`, put back in this checkout for the run. "After" is this branch. Three runs of each, on the Windows development machine.

## Results

Median milliseconds from the two calls to each event:

| Answer acknowledgement | | Settings reach main | Settings reply | Answer reply |
| --- | --- | ---: | ---: | ---: |
| 250 ms | before | 269–272 | 280–285 | 269–272 |
| 250 ms | after | 0.1 | 20–31 | 274–304 |
| 0 ms | before | 9–12 | 20–26 | 9–12 |
| 0 ms | after | 0.1 | 34–115 | 31–107 |

With a provider that takes its time, the settings change no longer waits for the other thread. It reaches main at once and its reply is back in about 25 ms, against about 280 ms before. The answer itself takes as long as its provider does, as before.

With an instant provider there is nothing to wait for, and running the two commands side by side costs a little. Both now finish at about 30 ms, where before the answer finished at 10 ms and the settings at 22 ms. Main writes its state file one write at a time, and in this harness the window renders on the same thread as main, so the two commands share both. One run of the three reached about 110 ms; the others stayed near 33 ms.

## What these numbers are not

They are synthetic. There is no IPC hop, no Electron and no real provider, and main and the window share one Node thread and one disk. They show the wait the window's own chain added and that it is gone. They are not app latency, and the 0 ms row says more about this harness's shared thread than about the app.

## What did not change

Main still orders each thread's commands, checks authority and holds provider locks. A settings change followed at once by a send on the same thread reaches main in that order, and the thread's lane runs them in that order (`tests/unit/renderer/agentCommandLanes.test.tsx`, `tests/unit/main/agentCommandLanes.test.ts`). Before this change the send could reach main first, because the settings change waited in the chain and the send did not.

A command's reply still paints only if no state arrived from main while it was out (#306). Sending at once does not widen that window: the reply is dropped or kept by the same check, taken when the command is sent. A test holds one thread's reply open while another thread changes and checks the older reply never paints over the newer state.
