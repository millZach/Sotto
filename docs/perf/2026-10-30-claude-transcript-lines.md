# A long line in a Claude transcript - October 30, 2026

Issue #992's third item. Sotto reads each Claude thread's transcript (`ClaudeSessionLog`): when a thread connects, while
its own CLI streams, and on its poll. The reader joined every 64 KiB read into one string and searched the whole of it
for a line's end again after each read, so a line cost the square of its length. A tool's result carrying a screenshot
is a line of 1 to 4 MB, and the longest lines in forge's real transcripts are about 1.4 MB.

It now keeps the bytes of the line still being written as the reads brought them, looks for a line's end in each read's
own bytes only, and decodes a line once, when it is whole, as `codexSessionLog.ts` reads rollouts. A line's end byte is
never inside a character, so a whole line is whole characters. The cursor, the lines it passes over for being too long,
and the error for a line that grows past a frame are as before.

## Measured

`tests/perf/claudeTranscriptRead.perf.test.ts`, a fresh reader over one line, median of three, forge:

| Line | Before | After |
| ---: | ---: | ---: |
| 1.4 MB | 11.9 ms | 2.5 ms |
| 4 MB | 66.2 ms | 7.2 ms |
| 14 MB | 759.4 ms | 25.4 ms |

Ten times the length now costs ten times the time; before, it cost sixty-four. With `SOTTO_PERF_ASSERT=1` the benchmark
fails past thirty, which it did before the change. `claudeSessionLog.test.ts` holds what the reader reads: a line written
across many reads with characters cut at their edges, the cursor on each line's end, and a line too long to take passed
over with the next one read. Each case passes on both readers.

```sh
SOTTO_PERF_BENCH=1 SOTTO_PERF_ASSERT=1 npx vitest run tests/perf/claudeTranscriptRead.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

## Left

The poll that reads every saved Claude transcript every second, and the reads of threads nobody has open, are #992's
other items, next in the plan.
