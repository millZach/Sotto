# Main freezing while threads stream - October 15, 2026

The owner's Sotto lags badly while typing with threads streaming. A live profile of the running app, with 232
threads in the sidebar and a few of them streaming, found main's JavaScript thread busy about 82% of the time
over 5.5 minutes, with 1,032 stretches of 100 ms or more without going idle (the longest 1.5 s). The cause is
whole-state deep copies on every streamed update: Watcher's observe pass, a host-update busy check, and the
coordinator's shell copy, each paid again and again as the sidebar grows. Fixes are tracked elsewhere; this note
is the benchmark that reproduces the symptom in the built app, so a fix can be measured before and after.

## What it measures

`tests/e2e/main-freeze.spec.ts` launches the built app, creates about 230 threads beyond the fixture's own two
so the sidebar holds about 232, and opens one of them (`Docs`) in a single pane. For three cases - nothing
streaming, one thread streaming, and three threads streaming, each at about 20 chunks a second for about 15
seconds - it measures two things at once:

- Main's event-loop delay during the case, with `perf_hooks.monitorEventLoopDelay` (max, mean and p99 in
  milliseconds) and a 50 ms drift sampler's count of gaps of 100 ms or more.
- Keystroke-to-screen latency in the `Docs` composer: a synthetic 41-character string typed one key at a time,
  with p50, p95 and max milliseconds from each keydown to the next animation frame after the composer's text
  updates.

It prints one `main freeze: {...}` line per case and asserts only that each case collected samples, never a time
budget; a stopwatch budget would be `SOTTO_PERF_ASSERT=1`'s, which this benchmark does not use.

## Reproduce

On an idle machine, after a build:

```powershell
$env:SOTTO_PERF_BENCH = '1'; npm run build; npx playwright test tests/e2e/main-freeze.spec.ts
```

```sh
SOTTO_PERF_BENCH=1 npm run build && npx playwright test tests/e2e/main-freeze.spec.ts
```

## Results

Recorded per change, alongside the commit or branch measured. None yet; this note adds the benchmark.
