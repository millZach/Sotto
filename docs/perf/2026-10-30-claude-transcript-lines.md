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
fails past thirty, which it did before the change.

`claudeSessionLog.test.ts` holds it in the default suite. It counts the bytes searched for line ends while one 4 MB line
is read: under twice the line now, and the square of it before, so the case fails on the old reader. It also holds what
the reader reads: a line written across many reads with characters cut at their edges, the cursor on each line's end, a
line too long to take passed over with the next one read, and a character cut at the frame limit counted only once it is
whole, as the old reader's decoder counted it.

One thing is corrected rather than kept. The old reader counted a line's bytes from its decoded text, so a byte that is not
UTF-8 counted as the replacement character's three. A cursor saved after such a line pointed past its end, and a read
resumed there began inside the next line. The cursor is now the file's own bytes, as ADR-0016's cursor means; Claude
Code writes JSON in UTF-8, so a transcript should hold no such byte.

```sh
SOTTO_PERF_BENCH=1 SOTTO_PERF_ASSERT=1 npx vitest run tests/perf/claudeTranscriptRead.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

## Left

The poll that reads every saved Claude transcript every second, and the reads of threads nobody has open, are #992's
other items, next in the plan.
