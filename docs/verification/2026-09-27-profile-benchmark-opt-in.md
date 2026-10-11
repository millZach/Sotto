# Explicit data selection for profile benchmarks

Issue #410. The three data-backed performance tests now require both `SOTTO_PERF_BENCH=1` and an explicit, nonempty `SOTTO_PERF_DATA` directory. The shared fixture returns before any filesystem probe when either is missing. It never derives a directory from APPDATA.

## Evidence

- On the original files at `d6db0dac`, set APPDATA to an owned synthetic directory containing `sotto/workspace.json` with an invalid JSON marker, with both performance variables absent. All three benchmarks failed while parsing that marker. This reproduces the implicit read without opening a personal profile.
- After the fix, the identical synthetic scenario skips all three benchmarks. Nine fixture tests also pass: missing/blank data selection, absent or nonliteral benchmark switches, explicit selection, and a missing selected workspace. A filesystem mock asserts that denied cases make no access calls and that allowed cases probe only the selected path.
- An explicit opt-in run passes all three original benchmarks. Its workspace comes from `designThreadsFixture()` with synthetic message text repeated twenty times to supply retained-history weight. The initial tiny design fixture passed both render benchmarks but did not satisfy the existing state-pipeline assertion that a shell is smaller than retained history; no benchmark assertion was changed. This is a compatibility check, not a performance comparison on an idle machine.
- `npm run typecheck`, `npm run lint`, and `npm run notices:verify` pass (174 notice components).
- Independent native Astra Standards and Spec reviews found no issues. A pre-existing BOM in the touched Threads benchmark was removed during review.
- The protected full two-worker suite passed 5,837 tests with 140 skipped and one failure: the unchanged Grok idle-session contract expected one resumed session start but observed zero at `adapterContract.ts:367` (the case is now in `tests/integration/adapterContract.ts:288`). This is under separate fixture diagnosis; it is not claimed to be a green run or a reproduced baseline failure.
- After integrating main `dcd5db86`, typecheck, lint and notices passed again. The guard and incoming history retry tests passed 17 cases; all three data-backed benchmarks stayed skipped. The full run used a verified-absent owned `SOTTO_PERF_DATA` path with the benchmark switch unset.

All reproduction inputs and logs are in ignored `artifacts/review-410/`. The benchmarks retain their existing temporary-copy cleanup. Production source, desktop rendering, and structural performance tests are unchanged.
