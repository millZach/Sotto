# What product events cost

ADR-0179 says sending must never slow Sotto. This is the sender on its own, before any call site on a thread's turn. Forge, Node under Vitest, three runs at a load average near 5, `tests/perf/productEvents.perf.test.ts`:

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/productEvents.perf.test.ts --maxWorkers=1 --disable-console-intercept --silent=false
```

| What | Result |
|---|---|
| `record` with no endpoint, as every build runs today | under 0.01 microseconds per event |
| `record` switched off | under 0.01 microseconds per event |
| `record` switched on, the largest event | 3.5 to 4.9 microseconds per event |
| Longest event loop delay with nothing to send | 1.3 to 1.9 ms |
| Longest event loop delay sending one batch of 20 | none registered: over before the monitor's 1 ms sample |
| Longest event loop delay sending 1,000 events, 50 batches back to back | 1.5 to 1.9 ms, no more than with nothing to send |
| An hour offline at one timer every 30 seconds, with 1,000 events waiting | 29 failed tries, about 1.7 ms of work in all |

The event loop figures use a local HTTP server in the same process, and a `fetch` made first, because main has fetched long before its first batch. A process's first `fetch` alone adds about 10 ms while its HTTP client loads.

An idle Sotto arms no timer for this at all. The sender sends one batch of at most 20 events every 30 seconds, so the 1,000-event row is a harder case than the sender produces.
