# Claude's transcript poll - October 30, 2026

Part of #992. Measured with `tests/perf/claudeTranscriptPoll.perf.test.ts`. It connects the Claude adapter over the fake
CLI with 132 and with 264 saved threads, each with a transcript of 40 entries, and one thread on screen. The 132 are the
owner's count in #992. Over three seconds with nothing happening, it counts the transcripts each tick reads, the time
inside those reads and the process's CPU per tick, at a 100 ms tick so the window holds about thirty. Then it opens five
untouched threads, and five whose transcripts gained twenty entries typed in Claude Code outside Sotto before the window.
It times each open end to end, the transcript read inside it and the bytes that read took.

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

- The timer reads the transcripts of the threads the coordinator observes and of the threads that are working
  (`pollActiveSessionLogs`). It reads a thread that leaves both once more, so its turn's last lines land.
- Every other thread's transcript is read from its cursor when the thread is opened or sent to (`sync`), and at connect,
  which still reads every saved thread once. That keeps each cursor current, so an open reads only what was written since.

## Before and after

Three runs each on forge, the same benchmark before and after. Ranges are the three runs.

| | Before | After |
| --- | ---: | ---: |
| Transcripts read per tick, 132 saved | 130.6-132 | 1 |
| Transcripts read per tick, 264 saved | 259.1-263.2 | 1 |
| Time in those reads per tick, 132 saved | 2.93-3.19 ms | 0.15-0.18 ms |
| Time in those reads per tick, 264 saved | 5.45-5.94 ms | 0.16-0.21 ms |
| CPU per tick, 132 saved | 3.43-3.84 ms | 0.19-0.20 ms |
| CPU per tick, 264 saved | 7.11-7.55 ms | 0.24-0.29 ms |
| Opening an untouched thread, median of five | 29.1-31.6 ms | 29.1-32.3 ms |
| of it, reading its transcript | 0.12-0.20 ms, 0 bytes | 0.14-0.21 ms, 0 bytes |
| Opening a thread with outside work, median of five | 28.8-31.1 ms | 29.8-33.7 ms |
| of it, reading its transcript | 0.12-0.17 ms, 0 bytes | 0.52-0.75 ms, 11,620 bytes |

The idle poll no longer grows with the threads saved. Opening an untouched thread reads nothing, as before. A thread
with work done outside Sotto now reads that work when it opens rather than in the poll before: half a millisecond more
for twenty entries, within the open's run-to-run spread. The open is mostly the fake CLI starting. The idle CPU includes
the test runner's own small share.

## The guard

`tests/integration/claudeTranscriptCatchUp.test.ts`, "reads each tick only the threads looked at or working, once more
after, and the rest when opened from their cursor", in the default suite. Six saved threads, one on screen:

- each tick reads that one;
- a thread that starts working is read while it works and on the tick after;
- a thread with work typed outside Sotto is read by no tick, and when opened it reads the one entry added since its
  cursor, not its transcript from the first byte, and shows it.

With the timer reading every transcript, as before, its first tick reads all six and it fails.

## What it leaves

- Connect still reads every saved thread's transcript once, from its cursor.
- A whole read of the adapter, which a send's read after the prompt asks for, still reads every transcript.
- A subagent's model, read from its own transcript, now waits for its thread's transcript to be read.
- Codex still tails every saved rollout from its first byte at each connect: #992's first item, next.
