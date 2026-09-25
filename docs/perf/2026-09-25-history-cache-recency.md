# Which history the window gives up - September 25, 2026

Issue #312. The window holds up to 16 thread histories and gives up the least recently used one when a seventeenth arrives. Recency used to move on every shell: `assemble()` stamped every held thread each time it spliced a shell, in the order the shell listed them, and a shell arrives as often as a provider streams. Every pushed history stamped its thread too. So "least recently used" meant "listed first in the last shell", and the thread the user had just left could be the one given up.

Now recency moves only when the user looks. Selecting a thread, declaring it viewed, and the active thread asking for its history each move it up. A shell moves nothing. A history main pushes unasked, for work in flight, starts as recent as its arrival and is not moved again by its own chunks. A resync is the window catching up and moves nothing. Viewed threads and the active thread are still never given up, and the limit is still 16.

## What was measured

`tests/perf/detailCacheRecency.perf.test.tsx` scripts one session through `useAgentConnection` over a fake bridge. The window first views 16 threads in turn. Then, eight times: the user comes back to the thread they work in, opens a thread the window does not hold, and 20 shells arrive while fourteen other threads stream, with main pushing two of their histories every fifth shell. The count is how often coming back to the working thread had to fetch its history again.

| Counted | Before | After |
| --- | ---: | ---: |
| Returns to the working thread that refetched its history | 8 of 8 | 0 of 8 |
| History requests over the session | 32 | 24 |
| Histories held at the end | 16 | 16 |
| Median time for one shell to reach the window (three runs) | 0.35-0.39 ms | 0.41-0.76 ms |

Before is `origin/main`'s `AgentContext.tsx` with the same benchmark; after is this change. The request count is 16 to warm the cache, 8 for the new threads, and before, 8 more to fetch the working thread again. The shell timing is a jsdom stopwatch on a machine running five other test suites at the time. The change takes one `Map.set` per held thread off every shell, which is too small to see there, and the spread is noise. It is not app latency.

The same run puts the 16 synthetic histories at about 449 KB by the new approximate count, and 238 KB as JSON. Each has 30 filler messages of about 400 characters. The figures describe the benchmark, not anyone's real histories.

## Numbers for a byte budget

The development console already printed what one state update cost, at most once a second. Beside it the window now prints how many histories it holds, roughly how large they are, and how often a selection or a view found its history already held. A line reads like this, with made-up figures:

```
sotto: history cache 12 held, about 840 KB, 31 hits, 9 misses
```

The size counts two bytes a string character, eight a number and four a boolean, with no object headers or shared strings, so it is for comparing one session with another, not for reading as the heap. Each message and activity record is measured once and remembered while it lives, so after a streamed chunk only the record it grew is measured again. The active thread asking for its history on every shell counts as neither a hit nor a miss. Development builds only; the production bundle drops the whole effect. None of it changes the limit. That is for a later issue to set from these numbers.

## Re-run

```sh
npx vitest run tests/perf/detailCacheRecency.perf.test.tsx --reporter=verbose
```

The test prints one `history cache recency:` line and fails if coming back to the working thread ever refetches. For the before figure, check out `origin/main`'s `src/renderer/src/agents/AgentContext.tsx` over this one and run it again; the test fails and still prints the line. The behaviour itself is pinned in `tests/unit/renderer/agentShellAssembly.test.tsx` under "which history the window gives up".
