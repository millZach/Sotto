# Claude frame parser - September 25, 2026

Issue #314. `ClaudeProtocol` reads Claude's stdout as newline-framed JSON. It used to append each chunk to one string, count the bytes of the whole string, and search it from the start for a newline. A large frame split across many chunks, such as a native user replay carrying a base64 image, made every chunk revisit everything before it, so the cost grew with the square of the frame. Claude's send path waits on that replay for its acknowledgement.

The framer now keeps the unfinished line as a list of fragments with a running byte count. Each chunk is counted once and searched once, from where the last line ended, and the fragments are joined once per complete line. The frame limit, the abort on an oversized frame or malformed line, control-response matching and the `stopping` flag are unchanged.

## What was timed

`tests/perf/claudeFramer.perf.test.ts` builds one native user replay frame holding a base64 image of 1, 10 or 20 MiB, cuts it into 64 KiB strings (the size a pipe read delivers), and hands them to the stdout listener one after another. It times the framer alone: byte counting, newline search, joining and the one `JSON.parse`. Each figure is the median of 5 runs. "Before" is `claudeProtocol.ts` as of `242af9b1`, the commit this change started from, under the same benchmark, run three times; "after" is this change, run three times. The ranges are across those runs.

| Image | Line | Chunks | Before | After |
| --- | ---: | ---: | ---: | ---: |
| 1 MiB | 1.3 MiB | 22 | 17.5-25.3 ms | 2.2-2.4 ms |
| 10 MiB | 13.3 MiB | 214 | 1,383-1,711 ms | 24.8-27.2 ms |
| 20 MiB | 26.7 MiB | 427 | 5,352-6,651 ms | 51.8-55.1 ms |

`JSON.parse` of the same lines on its own takes 1.1, 12.6 and 25.7 ms. After the change, roughly half of what is left is the parse, which any framer pays, and the framing itself is about 12 ms for the 10 MiB image. Astra's reproduction measured about 660 ms before and 15 ms for a fragment-based framer at that size. Its before figure is lower than ours, most likely because of the machine and the chunk size, which the issue does not record; the shape is the same.

## What these numbers are not

They are synthetic framing cost, not app latency. They leave out the pipe, UTF-8 decoding, the Claude process and everything the adapter does with the frame, and they say nothing about a send that carries no image. They were taken on the development machine (Windows 11, Intel Core Ultra 9 275HX, Node v24.14.1) while other agents' test suites were running on it, so read them as sizes rather than budgets. There is no stopwatch assertion; the benchmark only checks that one frame came out.

A side effect: `tests/unit/main/claudeProtocol.test.ts` feeds frames of about 28 MiB through the limit checks. Before the bytes-not-characters case was added, its tests took 6.6 s on the old framer and 0.2 s on the new one.

## Re-run

```sh
npx vitest run tests/perf/claudeFramer.perf.test.ts --reporter=verbose --silent=false
```

For the before figures, put the old framer in place (`git show 242af9b1:src/main/agents/claudeProtocol.ts`), run the same command, and restore the file.
