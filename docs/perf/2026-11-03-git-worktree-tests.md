# Git/worktree test profiling and Windows helper deadlines - November 3, 2026

No production Git change is justified by this profile. The worktree checks repeat observations across safety boundaries; the repository fixture verifies independent copies and deliberately exercises push, pull and fetch. This change retains those checks and all assertions, and tightens only the Windows helper test deadlines.

## Windows CI evidence

Downloaded completed run logs with `gh api repos/millZach/Sotto/actions/runs/<run>/logs`, then read the verbose result for `tests/integration/keyListenerWin32.test.ts`, excluding its skipped live-input case and the similarly named unit file. The sample covers the two reported main runs, five later completed main runs and twelve recent completed pull-request runs from the CI run listing. One of those runs emitted no result for this test, leaving 18 measured outcomes.

These are **whole-test durations**, including PowerShell startup, `Add-Type`, hook installation, protocol assertions and stdin-close shutdown. They upper-bound startup; they do not isolate compilation. macOS cannot execute this Windows helper. No compile cache or prewarm is supported by this evidence: the normal test starts the helper once, and the logs do not identify compilation as the dominant cost.

| Run | Outcome | Whole test |
| --- | --- | ---: |
| [41524081805](https://github.com/millZach/Sotto/actions/runs/41524081805) | Passed | 8.010 s |
| [41549893982](https://github.com/millZach/Sotto/actions/runs/41549893982) | Killed by former 10 s startup deadline | 10.020 s |
| [41576739541](https://github.com/millZach/Sotto/actions/runs/41576739541) | Passed | 4.774 s |
| [41576765981](https://github.com/millZach/Sotto/actions/runs/41576765981) | Passed | 4.842 s |
| [41579537326](https://github.com/millZach/Sotto/actions/runs/41579537326) | Passed | 5.799 s |
| [41580202137](https://github.com/millZach/Sotto/actions/runs/41580202137) | Passed | 4.751 s |
| [41587518387](https://github.com/millZach/Sotto/actions/runs/41587518387) | Passed | 10.720 s |
| [41587823018](https://github.com/millZach/Sotto/actions/runs/41587823018) | Passed | 5.274 s |
| [41598283736](https://github.com/millZach/Sotto/actions/runs/41598283736) | Passed | 10.264 s |
| [41598548026](https://github.com/millZach/Sotto/actions/runs/41598548026) | Passed | 4.679 s |
| [41598918188](https://github.com/millZach/Sotto/actions/runs/41598918188) | Passed | 6.490 s |
| [41598742378](https://github.com/millZach/Sotto/actions/runs/41598742378) | Passed | 22.537 s |
| [41598718448](https://github.com/millZach/Sotto/actions/runs/41598718448) | Passed | 11.548 s |
| [41598548298](https://github.com/millZach/Sotto/actions/runs/41598548298) | Passed | 5.330 s |
| [41598358372](https://github.com/millZach/Sotto/actions/runs/41598358372) | Passed | 4.827 s |
| [41598723533](https://github.com/millZach/Sotto/actions/runs/41598723533) | Passed | 5.115 s |
| [41598644162](https://github.com/millZach/Sotto/actions/runs/41598644162) | Passed | 4.652 s |
| [41599544683](https://github.com/millZach/Sotto/actions/runs/41599544683) | Passed | 5.137 s |

Across the 17 passes: minimum 4.652 s, median 5.274 s, nearest-rank p95 and maximum 22.537 s. This small, mixed main/PR sample is not a guarantee about the tail. The 10.020 s failure is censored: its startup never completed, so it is not a successful 10 s measurement. PR #2079 also recorded six other failures at the old 10 s startup limit; those likewise do not measure successful startup.

Startup now gets **45 s** (formerly 60 s), about twice the slowest sampled whole test, leaving 22.463 s beyond that upper bound. The normal test gets **55 s** (formerly 90 s): startup plus the existing 5 s shutdown deadline and 5 s scheduling/assertion margin. The optional live-input test keeps its existing 30 s outer margin, because its second PowerShell invocation was not measured; its outer deadline becomes 75 s. A lower deadline shortens detection of a broken helper, not successful test execution.

## Local Git profile

Measurements and verification below use Node 24.22.1, matching CI, on Apple M4 Pro (14 available CPUs), macOS arm64, Apple Git 2.54.0. Initial Node 25 probes failed in the pre-existing `tests/setup.ts` web-storage cleanup and are excluded.

Each file runs alone, twice, with `--maxWorkers=1 --reporter=json --outputFile=<temporary file>`. Temporary instrumentation wraps `spawn` and `execFileSync` after the existing Git guard, retaining their implementations, options and outputs. `AsyncLocalStorage` assigns each subprocess to its outer `ThreadWorktrees.allocate`, `ensure`, `inspect`, `reclaimFacts`, `reclaim`, or `GitStatusReader.read` / `readRemote` operation. Elapsed time runs through subprocess close. Operations outside those methods are fixture/assertion work. Counts include top-level Git launches, not Git internal children. The instrumentation is removed before final verification; it adds no production logging.

### Results

| File | Passing tests per run | Wall time, runs 1 / 2 | Sum of assertion durations, runs 1 / 2 | Observed Git launches per run |
| --- | ---: | ---: | ---: | ---: |
| `threadWorktreeSubmodules.test.ts` | 11 | 155.763 / 165.831 s | 149.645 / 159.107 s | 868 / 868 |
| `gitRepository.test.ts` | 3 | 32.858 / 9.713 s | 5.176 / 5.555 s | 50 / 50 |
| `gitStatus.test.ts` | 30 | 26.995 / 26.921 s | 23.580 / 23.651 s | 586 / 586 |

A third worktree run was interrupted and excluded when this Mac's one-minute load average reached 84.60 (14 available CPUs; five-minute load 70.26, fifteen-minute load 49.82). In that unfinished run a fixture `submodule add` took 10.554 s and a fixture commit took 5.304 s. The completed first run's slowest launch was fixture `submodule deinit` at 6.959 s. These measurements include instrumentation and machine contention; they are observations, not an isolated Git benchmark.

These are baseline repetitions, not a before/after optimization claim. No production Git code changed, so there is no optimized after measurement. The deadline-only patch does not execute in these Git files. Local instrumented file totals are not comparable to a single Windows CI test's duration.

### Subprocess counts and retained work

The two completed worktree traces have identical counts:

| Outer operation | Calls per file | Git launches per file | Git launches per call |
| --- | ---: | ---: | ---: |
| `ThreadWorktrees.allocate` | 11 | 22 | 2 |
| `ThreadWorktrees.ensure` | 11 | 88 | 8 |
| `ThreadWorktrees.reclaimFacts` | 11 | 118 | 9–15 |
| `ThreadWorktrees.reclaim` | 28 | 454 | 9–34 |
| Fixture/assertion work outside those methods | — | 186 | — |

The `reclaim` count includes three scripted ref-mutation launches from its concurrency assertion. Nested method calls belong to the outer operation, so they are not counted twice.

The two status traces also have identical counts:

| Outer operation | Calls per file | Git launches per file | Git launches per call |
| --- | ---: | ---: | ---: |
| `GitStatusReader.read` | 62 | 304 | 0–10 |
| `GitStatusReader.readRemote` | 14 | 24 | 0–3 |
| Fixture/assertion work outside those methods | — | 258 | — |

Six `read` calls and four `readRemote` calls launch no Git subprocess. Every read that reaches `git status` launches it once, never twice within that call. These counts cover the file's exercised cases, not every status-reader entry point. The repository-fixture file launches 50 Git subprocesses on each run.

- Allocation launches two distinct queries: repository root and base commit. A fresh worktree's eight launches include checking its registry identity before and after creation and reading its resulting branch/status.
- Removal's repeated observations cross safety boundaries. `reclaimFactsWithin` runs before the registry lane and again inside it; the final status/index queries detect changes during the recursive walk. The existing “rechecks unpublished submodule history inside the registry lane” assertion deliberately mutates refs between observations. Caching the first walk or deleting these queries would weaken that protection (ADR-0041).
- The submodule suite launches no top-level `fetch`. Its submodule add/update commands can launch Git's own children, which these counts exclude. This does not implicate redundant production fetches in the reported failure.
- The repository fixture already combines copy identity and tree verification in one `rev-parse --absolute-git-dir HEAD^{tree}` launch per valid copy. Seed setup needs four launches (`init`, `add`, `commit`, tree query); adding a remote and second clone needs five more after copy validation. The harness also confirms once that the temporary folder is outside a repository. The first test deliberately exercises two pushes, a pull, a fetch and four `fsck` assertions across independent copies. Those are the behavior under test, not duplicate status work.
- `GitStatusReader` already shares pending reads, caches reads requested after the same round, shares/throttles fetches by common repository directory, and invalidates answers after Git actions. Its existing tests exercise those boundaries. A local status read does not fetch. Retaining remote and ref queries preserves detection of changes made outside Sotto (ADR-0027).

No provably redundant invocation or scan emerged from these paths. Nothing was removed or cached. This follows the requested fallback rather than changing behavior based on a noisy timing comparison.

### Relation to the Windows flakes

In [41524081805](https://github.com/millZach/Sotto/actions/runs/41524081805), the deinitialized-tag case took 30.466 s and reported that Git timed out and its checkout processes could not be stopped. The repository-copy case took 16.414 s and hit its 15 s test deadline. In [41549893982](https://github.com/millZach/Sotto/actions/runs/41549893982), those cases passed in 4.870 s and 2.998 s respectively. The logs contain no per-command trace identifying the stalled invocation. Runner contention is a plausible inference from that variation, not an established cause; the Mac profile cannot reproduce or explain Windows process-tree shutdown.

## Reproduction and verification

Run files separately with CI's Node version, after `npm ci --ignore-scripts`:

```sh
fnm exec --using 24.22.1 node node_modules/vitest/vitest.mjs run tests/integration/threadWorktreeSubmodules.test.ts --maxWorkers=1 --reporter=json --outputFile=/tmp/worktrees.json
fnm exec --using 24.22.1 node node_modules/vitest/vitest.mjs run tests/unit/fixtures/gitRepository.test.ts --maxWorkers=1 --reporter=json --outputFile=/tmp/repositories.json
fnm exec --using 24.22.1 node node_modules/vitest/vitest.mjs run tests/unit/main/gitStatus.test.ts --maxWorkers=1 --reporter=json --outputFile=/tmp/status.json
```

For invocation profiling, temporarily wrap the existing `ThreadWorktrees` and `GitStatusReader` prototype methods listed above, assigning an async context ID per outer operation. Wrap `node:child_process.spawn` (through close) and `execFileSync` (through return), record Git argv, context ID and elapsed milliseconds, and republish builtin exports with `syncBuiltinESMExports`. Load the wrapper after `installGitGuard()` in the test setup. Record calls outside an operation separately. Remove this temporary instrumentation afterwards; the committed test assertions remain unchanged.

- The three Git files above passed twice each: 88 test passes in total, with all existing assertions intact.
- `tests/unit/main/keyListenerWin32.test.ts`: 10 passed on each of two runs (0.691 / 0.741 s wall time), without instrumentation.
- `tests/integration/keyListenerWin32.test.ts`: two skipped on each of two runs (0.819 / 0.828 s wall time), as expected on macOS; this does not validate the Windows startup deadline locally.
- `fnm exec --using 24.22.1 npm run typecheck`: passed (17.211 s).
- `fnm exec --using 24.22.1 npm run lint`: passed (35.636 s).
- The evidence table matches all 18 extracted CI test results. No full suite, Playwright, design capture, build or app launch was run. Windows execution of the changed deadline remains for GitHub CI.
