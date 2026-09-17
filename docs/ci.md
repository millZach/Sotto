# Continuous integration

`.github/workflows/ci.yml` runs the same gates a developer runs by hand, on a `windows-latest` runner, for every push to `main` and every pull request against `main`. It never builds installers, never publishes, and uses no secrets.

## What the job runs

| Step | Command | Why it exists |
| --- | --- | --- |
| Install dependencies | `npm ci` | Exact `package-lock.json` install, including the native modules (node-pty, sharp, sherpa-onnx). The npm cache is keyed on the lockfile by `actions/setup-node`. |
| Prepare runtime assets | `npm run runtime:prepare` | Copies the hash-locked ONNX WASM files out of `node_modules/onnxruntime-web` into `resources/runtime`, which the checkout does not carry. No network access, about a second. |
| Typecheck | `npm run typecheck` | `tsc --noEmit` over the node and web projects. |
| Lint | `npm run lint` | `eslint .`. |
| Unit and integration tests | `npm test -- --maxWorkers=2` | `vitest run` — the whole suite except the Playwright end-to-end specs, which the vitest config excludes. The worker cap keeps the jsdom and child-process heavy files inside a small runner's memory; unpinned parallelism has produced "Worker exited unexpectedly" crashes on a loaded machine. |
| Third-party notices | `npm run notices:verify` | Checks `THIRD_PARTY_NOTICES.md` against the installed dependency tree. |

Each gate is its own named step, so a red check names the gate that failed.

The job cancels a superseded run on the same ref (`concurrency` with `cancel-in-progress`), has a 30-minute safety timeout, and requests only `contents: read`.

## What CI deliberately does not run

- **Playwright end-to-end tests** (`npm run test:e2e`) and the widget design captures — they need a real Electron window and committed reference images captured on a developer machine.
- **Live provider suites.** Every one of them is gated behind an explicit `SOTTO_*` environment variable (`SOTTO_CLAUDE_LIVE`, `SOTTO_GROK_LIVE`, `SOTTO_NATIVE_THREADS_LIVE`, and friends). CI sets none of them and holds no credentials, so they stay skipped.
- **Perf benchmarks.** `tests/perf/*` skip themselves when neither `SOTTO_PERF_DATA` nor a `%APPDATA%\sotto` data folder exists. A GitHub runner has neither, so they report as skipped rather than failing.
- **Wall-clock budgets.** See below.
- **Packaging and publishing.** Releases are still cut by hand on the Windows PC and the Apple silicon Mac.

## Gated assertions

A shared runner interleaves two vitest workers with everything else on the host, so an absolute
stopwatch there measures the machine rather than the code — one of these budgets was seen take 337 ms
on the runner against a 100 ms budget that costs 3 ms on a developer machine. Every such budget is
therefore opt-in through `SOTTO_PERF_ASSERT=1` (`tests/fixtures/perfBudget.ts`). Only the stopwatch is
gated: the behaviour around each one — the queue row is on screen, the send is acknowledged as
`submitting`, the queued delivery is published before the provider answers — is asserted on every run,
including CI.

| Budget | Test | What it measures |
| --- | --- | --- |
| 100 ms | `tests/unit/renderer/threadQueueSkills.test.tsx` — *queues with Enter while a turn runs…* | Enter to the queue row being on screen. |
| 100 ms | `tests/integration/personalChats.test.ts` — *durably acknowledges send before native completion…* | `send()` returning while the provider is held for 350 ms. |
| 100 ms | `tests/unit/main/threadDrafts.test.ts` — *publishes local queued feedback before provider latency…* | The first published `queued` delivery after a send. |

Run them by hand on an idle machine:

```powershell
$env:SOTTO_PERF_ASSERT = '1'
npx vitest run tests/unit/renderer/threadQueueSkills.test.tsx tests/integration/personalChats.test.ts tests/unit/main/threadDrafts.test.ts
```

```sh
SOTTO_PERF_ASSERT=1 npx vitest run tests/unit/renderer/threadQueueSkills.test.tsx tests/integration/personalChats.test.ts tests/unit/main/threadDrafts.test.ts
```

One test is skipped by platform rather than gated: *preserves an occupied broken-symlink backup
candidate and retries with a new id* in `tests/unit/main/atomicJsonStore.test.ts` reports as skipped on
Windows, including on the runner, and says so in its skip reason. Creating a symbolic link there needs
a privilege an ordinary account does not hold, and where it is held — an elevated runner — Windows
copies through the dangling link instead of refusing, so the retry the test is about cannot happen. The
same guarantee is asserted on Windows by the neighbouring occupied-plain-file and timestamp-only cases.

Two tests carry a raised timeout rather than a budget, because they do a lot of real work and wait for
nothing: the 2 MB rollout read in `tests/unit/main/codexTargetLog.test.ts` and the streamed-Markdown
comparison in `tests/unit/renderer/streamingMarkdown.test.tsx` each allow 60 s.

`vitest.config.ts` gives a test 15 s and an `expect.poll` 5 s, rather than vitest's 5 s and 1 s. Waiting
is not the assertion: a runner takes several times longer over a provider round trip or a child process
start than a developer machine, and a deadline that expires there describes the machine. Something that
is genuinely wrong still fails, a few seconds later.

`tests/setup.ts` holds the two things every test run needs on Windows: web storage is emptied after each
test, so no test paints the cached agent shell a previous test left behind, and a recursive `fs.rm`
retries by default, so tidying a fixture's temporary folder does not fail with ENOTEMPTY while Windows
is still releasing a just-exited child's handles.

## Reading a failure

1. Open the pull request, find the failed **Gates (Windows)** check, and click **Details**.
2. The failed step is the collapsed red one. Expand it; the command's own output is the whole story:
   - *Typecheck* — `tsc` prints `file(line,col): error TS….`
   - *Lint* — eslint prints file, line and rule name.
   - *Unit and integration tests* — vitest prints the failing test file and name, then the diff. The summary line at the end counts passed/failed/skipped; skipped perf and live tests are expected.
   - *Third-party notices* — the verifier names the component that drifted; regenerate or update `THIRD_PARTY_NOTICES.md` to match the lockfile.
3. Reproduce locally with the exact command from the table. The gates are the same ones in the README test matrix, so a clean local run means a clean CI run, with two exceptions worth checking first when CI fails and your machine passes: stale `node_modules` (run `npm ci`, not `npm install`) and a missing `resources/runtime` (run `npm run runtime:prepare`).
4. Push a fix to the same branch. The previous run is cancelled automatically and a new one starts.

## Expected duration

Measured on a warm developer machine: install 18 s, runtime preparation 1 s, typecheck 22 s, lint 31 s, vitest with two workers 234 s, notices 2 s — about five minutes of gate time. A cold runner adds the dependency install and the Electron binary download, so a full run is expected to land inside the 15-minute budget, with the 30-minute job timeout as a backstop.
