# Claude's transcript poll - October 30, 2026

Part of #992. Measured with `tests/perf/claudeTranscriptPoll.perf.test.ts`. It connects the Claude adapter over the fake
CLI with 132 and with 264 saved threads, each with a transcript of 40 entries, and one thread on screen. The 132 are the
owner's count in #992. Over three seconds with nothing happening, it counts the transcripts each tick reads, the time
inside those reads and the process's CPU per tick, at a 100 ms tick so the window holds about thirty. Then it opens five
untouched threads, and five whose transcripts gained twenty entries typed in Claude Code outside Sotto before the window,
as a pane opens one: the window observes it. It times each from then until the thread shows all its transcript holds,
and counts the bytes its transcript read took.

```sh
SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/claudeTranscriptPoll.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

## What it cost

Each second the adapter opened, read and closed every saved thread's transcript, used or not. The cost grew with every
thread ever saved, for as long as Sotto ran: 3.4 to 3.8 ms of CPU a second at 132 threads on forge, 7.1 to 7.6 ms at
264, and 18.8 ms at 132 on the Windows laptop in #992.

## The change

Zach's call, October 29: check every second only threads open in a pane, working, or watched by Watcher. Every other
thread, settled or not, catches up when it is opened or sent to, with no slower sweep. A thread he comes back to must not
open slower.

- The timer reads the transcripts of the threads the coordinator observes, of the threads that are working, and of the
  threads whose CLI did anything since the last tick, so a turn begun and ended between two ticks is read too
  (`pollActiveSessionLogs`). It reads a thread that leaves those once more, so its turn's last lines land, and tries a
  read that failed again on the next tick.
- Every other thread's transcript is read from its cursor as soon as the thread comes into view (`observeThreads`) or is
  sent to (`sync`), and at connect, which still reads every saved thread once. That keeps each cursor current, so an open
  reads only what was written since.
- A transcript nothing was written to since its last read is not opened: one stat says so.

## Before and after

Three runs each on forge, the same benchmark before and after. Ranges are the three runs; an open is the median of five.

| | Before | After |
| --- | ---: | ---: |
| Transcripts read per tick, 132 saved | 128.4-132 | 1 |
| Transcripts read per tick, 264 saved | 257-262.6 | 1 |
| Time in those reads per tick, 132 saved | 3.00-3.72 ms | 0.11-0.14 ms |
| Time in those reads per tick, 264 saved | 5.51-5.97 ms | 0.09-0.13 ms |
| CPU per tick, 132 saved | 3.49-3.95 ms | 0.15-0.16 ms |
| CPU per tick, 264 saved | 7.25-7.56 ms | 0.19-0.21 ms |
| An untouched thread opened, until it shows everything | 0.03-0.06 ms, 0 bytes read | 0.03-0.08 ms, 0 bytes read |
| A thread with outside work opened, until it shows everything | 0.03-0.08 ms, 0 bytes read | 2.19-3.65 ms, 11,620 bytes read |

The idle poll no longer grows with the threads saved. An untouched thread opens showing everything at once, as before.
A thread with work done outside Sotto read that work in the poll before; it now reads it the moment it comes into view,
and shows it 2 to 4 ms later, inside one frame. Before the review's fix, that waited for the poll's next tick, up to a
second. With only the threads in use read, the one stat in place of opening a quiet transcript took the time in the
reads per tick from 0.15-0.21 ms to the range above. The idle CPU includes the test runner's own small share.

## The guard

`tests/integration/claudeTranscriptCatchUp.test.ts`, "reads each tick only the threads looked at or working, once more
after, and the rest when opened from their cursor", in the default suite. Six saved threads, one on screen:

- each tick of the poll's own timer reads that one;
- a thread that starts working is read while it works and on the tick after, and a read of it that fails is tried
  again on the next tick;
- a thread sent a turn that begins and ends between two ticks is read on the next tick;
- a thread with work typed outside Sotto is read by no tick, and when a pane opens it, it reads at once the one entry
  added since its cursor, not its transcript from the first byte, and shows it.

Each of these fails without its part of the change: with the timer reading every transcript, as before, its first tick
reads all six. `claudeSessionLog.test.ts` counts the opens of a transcript nothing was written to: none, and one once it
grows.

## What it leaves

- Connect still reads every saved thread's transcript once, from its cursor.
- A whole read of the adapter, which a send's read after the prompt asks for, still reads every transcript.
- A subagent's model, read from its own transcript, now waits for its thread's transcript to be read.
- Codex still tails every saved rollout from its first byte at each connect: #992's first item, next.
