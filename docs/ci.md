# Continuous integration

`.github/workflows/ci.yml` runs the same gates a developer runs by hand, on a `windows-latest` runner, for every push to `main` and every pull request against `main`. It never builds desktop installers, never publishes, and uses no secrets. A separate Linux job builds and verifies the plain Node host archive.

## What the job runs

| Step | Command | Why it exists |
| --- | --- | --- |
| Install dependencies | `npm ci` | Exact `package-lock.json` install, including the native modules (node-pty, sharp, sherpa-onnx). The npm cache is keyed on the lockfile by `actions/setup-node`. |
| Prepare runtime assets | `npm run runtime:prepare` | Copies the hash-locked ONNX WASM files out of `node_modules/onnxruntime-web` into `resources/runtime`, which the checkout does not carry. No network access, about a second. |
| Typecheck | `npm run typecheck` | `tsc --noEmit` over the node and web projects. |
| Lint | `npm run lint` | `eslint .`. |
| Unit and integration tests | `npm test -- --maxWorkers=2` | `vitest run` — the whole suite except the Playwright end-to-end specs, which the vitest config excludes. The worker cap keeps the jsdom and child-process heavy files inside a small runner's memory; unpinned parallelism has produced "Worker exited unexpectedly" crashes on a loaded machine. Main-process and integration files run under node rather than jsdom, declared by a `@vitest-environment node` header on each file; a file in those folders that needs a DOM says `jsdom` instead. |
| Third-party notices | `npm run notices:verify` | Checks `THIRD_PARTY_NOTICES.md` against the installed dependency tree. |

Each gate is its own named step, so a red check names the gate that failed.

The job cancels a superseded run on the same ref (`concurrency` with `cancel-in-progress`), has a 30-minute safety timeout, and requests only `contents: read`.

## What CI deliberately does not run

- **Playwright end-to-end tests** (`npm run test:e2e`) and the widget design captures — they need a real Electron window and committed reference images captured on a developer machine.
- **Live provider suites.** Every one of them is gated behind an explicit `SOTTO_*` environment variable (`SOTTO_CLAUDE_LIVE`, `SOTTO_GROK_LIVE`, `SOTTO_NATIVE_THREADS_LIVE`, `SOTTO_SIDE_WRITING_LIVE`, and friends). CI sets none of them and holds no credentials, so they stay skipped.
- **Perf benchmarks.** The `tests/perf/*` files that read a real workspace skip themselves when neither `SOTTO_PERF_DATA` nor a `%APPDATA%\sotto` data folder exists. A GitHub runner has neither, so they report as skipped rather than failing. `markdownRender.perf.test.tsx` needs no data and does run: it renders the same reply incrementally and whole, logs both timings, and always checks that incremental parsing processes less than a third of the characters. Its elapsed-time comparison is opt-in like the other stopwatch budgets below.
- **Wall-clock budgets.** See below.
- **Desktop packaging and all publishing.** Desktop releases are still cut by hand on the Windows PC and the Apple silicon Mac. The Linux host archive is built and verified in its separate job, then published manually.

## Devin native verification

`tests/integration/devinAdapter.test.ts` runs the complete shared adapter contract and boundary cases against a scripted ACP subprocess in CI. It does not establish live CLI compatibility.

The opt-in `tests/integration/devinLive.test.ts` uses the installed, natively signed-in Devin CLI 3000.10.31 and account-advertised `swe-1-6-fast`. It creates a disposable Git project and incurs native account usage. It checks denial, exact-target one-time approval, a structured question, same-session restart, and cancellation. Two additional Windows-only cases kill a uniquely identified test ACP owner while permission is pending and verify safe model-change refusal or same-session recovery, according to whether the native model had been saved by a clean shutdown. It never reads credentials or logs protocol bodies. Run on native Windows and Apple silicon macOS before claiming both platforms verified. The initial PR is verified on Windows only; Zach deferred Mac verification because no Mac is available:

```powershell
$env:SOTTO_DEVIN_LIVE = '1'
npx vitest run tests/integration/devinLive.test.ts --maxWorkers=1
```

```sh
SOTTO_DEVIN_LIVE=1 npx vitest run tests/integration/devinLive.test.ts --maxWorkers=1
```

Use `npm run build` followed by `npx playwright test tests/e2e/devin-provider.spec.ts` for the Electron provider/permission journey, keyboard path, independent-provider behavior, coordinator separation, and light/dark/minimum-size captures. The verification note records actual platforms and results; a fixture pass is not a native-platform pass.

## Gated assertions

A shared runner interleaves two vitest workers with everything else on the host, so an absolute
stopwatch there measures the machine rather than the code — one of these budgets was seen take 337 ms
on the runner against a 100 ms budget that costs 3 ms on a developer machine. Every such budget is
therefore opt-in through `SOTTO_PERF_ASSERT=1` (`tests/fixtures/perfBudget.ts`). Only the stopwatch is
gated: the behaviour around each one — the queue row is on screen, the send is acknowledged as
`submitting`, the queued delivery is published before the provider answers — is asserted on every run,
including CI.

The same rule applies to relative timings measured in consecutive runs. A competing worker can
pause one run more than the other. PR #149 exposed this in the unchanged Markdown renderer:
incremental rendering's median chunk took 13.65 ms against 27.66 ms for whole-message rendering,
but its total took 1,726.7 ms against 1,313.8 ms. The parsed-character comparison still passed
(28,973 against 113,960). Only that elapsed-time assertion is gated; the work bound and the
renderer tests for memoization and identical final markup run in CI.

| Budget | Test | What it measures |
| --- | --- | --- |
| 100 ms | `tests/unit/renderer/threadQueueSkills.test.tsx` — *queues with Enter while a turn runs…* | Enter to the queue row being on screen. |
| 100 ms | `tests/integration/personalChats.test.ts` — *durably acknowledges send before native completion…* | `send()` returning while the provider is held for 350 ms. |
| 100 ms | `tests/unit/main/threadDrafts.test.ts` — *publishes local queued feedback before provider latency…* | The first published `queued` delivery after a send. |
| 250 ms | `tests/integration/codexStreamingResponsiveness.test.ts`, `tests/integration/nativeStreamingResponsiveness.test.ts` | The longest main-process heartbeat gap while three threads stream 600 output updates, tested for Codex, Claude and Grok. Snapshot coalescing and lossless output are checked regardless of the budget switch. |
| Less than half of structuredClone | `tests/unit/main/cloneHostSnapshot.test.ts` | Median internal snapshot copy with 24 MiB of retained output; container isolation and the incremental-storage work bound are always checked. |
| Less than whole-message rendering | `tests/perf/markdownRender.perf.test.tsx` | Total elapsed time for rendering a reply in 40 incremental chunks against re-parsing each whole prefix. |

Run them by hand on an idle machine:

```powershell
$env:SOTTO_PERF_ASSERT = '1'
npx vitest run tests/unit/renderer/threadQueueSkills.test.tsx tests/integration/personalChats.test.ts tests/unit/main/threadDrafts.test.ts tests/integration/codexStreamingResponsiveness.test.ts tests/integration/nativeStreamingResponsiveness.test.ts --maxWorkers=2
npx vitest run tests/perf/markdownRender.perf.test.tsx --maxWorkers=1
```

```sh
SOTTO_PERF_ASSERT=1 npx vitest run tests/unit/renderer/threadQueueSkills.test.tsx tests/integration/personalChats.test.ts tests/unit/main/threadDrafts.test.ts tests/integration/codexStreamingResponsiveness.test.ts tests/integration/nativeStreamingResponsiveness.test.ts --maxWorkers=2
SOTTO_PERF_ASSERT=1 npx vitest run tests/perf/markdownRender.perf.test.tsx --maxWorkers=1
```

One test is skipped by platform rather than gated: *preserves an occupied broken-symlink backup
candidate and retries with a new id* in `tests/unit/main/atomicJsonStore.test.ts` reports as skipped on
Windows, including on the runner, and says so in its skip reason. Creating a symbolic link there needs
a privilege an ordinary account does not hold, and where it is held — an elevated runner — Windows
copies through the dangling link instead of refusing, so the retry the test is about cannot happen. The
same guarantee is asserted on Windows by the neighbouring occupied-plain-file and timestamp-only cases.

Three tests carry a raised timeout rather than a budget, because they do a lot of real work and wait for
nothing: the 2 MB rollout read in `tests/unit/main/codexTargetLog.test.ts` and the streamed-Markdown
comparison in `tests/unit/renderer/streamingMarkdown.test.tsx`, and the 1005-file directory enumeration
in `tests/unit/main/files.test.ts` each allow 60 s.

`vitest.config.ts` gives a test 15 s and an `expect.poll` 5 s, rather than vitest's 5 s and 1 s. Waiting
is not the assertion: a runner takes several times longer over a provider round trip or a child process
start than a developer machine, and a deadline that expires there describes the machine. Something that
is genuinely wrong still fails, a few seconds later.

The same rule applies to the fake-provider fixtures' acknowledgement deadline (`requestTimeoutMs` in
`tests/fixtures/claudeFixture.ts`, `codexFixture.ts` and `fakeGrokThreadFixture.ts`). That one deadline
covers every native round trip, including the first one after the fake CLI is spawned, so it also has
to absorb a Node process start: about 80 ms on a developer machine, up to 220 ms on an idle two-core
box, and 400–1200 ms when the runner's second worker is busy; creating a Claude thread starts two
children in a row. The fixtures default to 2000 ms and no test passes less. A test that needs a *lost*
acknowledgement scripts one — `driver.delayNextAck()` delays the fake's reply to one second past the
deadline, and explicit `script({ delay })` calls use 3000 ms — rather than shortening the deadline,
because a short deadline turns the fixture's own start-up into "Codex did not acknowledge the operation
in time" / "Claude did not acknowledge the request" on a loaded runner. That was the cause of the red
*Gates (Windows)* runs on PRs #100 and #103: `claudeFixture` defaulted to 150 ms and several Codex and
Grok tests passed 150–500 ms.

To reproduce runner load locally, pin the run to two cores and give it a competitor on the same cores:

```powershell
$busy = Start-Process node -ArgumentList '-e', 'for(;;){}' -PassThru -WindowStyle Hidden
$busy.ProcessorAffinity = 3
cmd /c 'start "" /affinity 3 /b /wait cmd /c "npx vitest run --maxWorkers=2 tests/integration/adapterContract.test.ts"'
Stop-Process -Id $busy.Id
```

Before the deadline change, that loop failed seven or eight of the adapter tests on every run. Three
busy loops instead of one is beyond what the runner does, and the suite is not expected to pass there.

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

## Agents roster regression

`tests/unit/main/subagentStore.test.ts` compares the same 600 updates with small and large archives: three threads, 5,000 saved assignments and 20 live agents. Indexed read/write counts must match, no archive pages are read during updates, page reads remain bounded, and every result survives. `tests/unit/main/subagentWorkspace.test.ts` covers retention beyond the ordinary activity cap, restart evidence, coalesced changes, privacy and provider disconnection. Renderer tests in `tests/unit/renderer/subagents.test.tsx` cover stable row references, bounded live caches, hidden/disconnected clocks and paging races. Provider projector retention tests in `tests/unit/main/subagentRetention.test.ts` also verify 5,000 assignments without retaining archived prompt/result payloads in identity maps. These structural assertions run in the normal CI suite.

Run `npm run build && npx playwright test tests/e2e/subagents.spec.ts` for the real Electron roster journey, history, state changes and light/dark captures at the three desktop sizes. As with other UI journeys, it stays local. Run the existing opt-in queue-feedback and streaming heartbeat gates while verifying performance; their 100 ms and 250 ms limits are unchanged.

For the local HEAD/current startup, update and memory comparison, run `node tests/perf/subagents-bench.mjs` with `SOTTO_PERF_ASSERT=1`. See [the performance note](perf/issue-124-agents.md) for its workload, baseline revision, measurements and limits.

## Headless host foundations

`npm run test:host` runs the Node-only host lifecycle and credential checks, shared adapter contracts and HostService journeys with fake providers. The normal unit/integration gate includes these tests. The process test builds a temporary plain-Node entry and checks its import graph for Electron; it does not use the shipped Electron executable. On Windows its SIGTERM handler is exercised through an owned IPC signal fixture because Windows process termination cannot deliver a graceful POSIX SIGTERM. The separate Linux host job delivers a real SIGTERM to both the lifecycle fixture and the extracted archive smoke test.

`tests/e2e/host-identity.spec.ts` launches the real desktop with a legacy workspace, verifies durable host identity and raw persisted Sotto IDs, then checks host-scoped panes and a saved draft after restart. Run it with the daily-workspace and coordinator journeys when changing the host/client boundary.

## Linux host archive and socket contract

The **Host archive and socket contract (Linux)** job runs on `ubuntu-latest` with Node 24, read-only repository access and no provider credentials. It installs the locked dependencies without downloading Electron, then runs:

| Command | Evidence |
| --- | --- |
| `npm run test:socket` | The shared HostService contract through `SocketHostService` against a built Node child and all four scripted providers; pairing, the remote command allow-list, receipts and reconnect boundaries; headless startup and native SIGTERM; the SSH launcher over a fake ssh that asks its questions through the real askpass helper; the launch script, including the Node probe's POSIX shell, which only this job runs; that the host listener answers on loopback and on no other interface; and hello, a command and a pushed event over Node's own global WebSocket, so the socket is proven against a client whose framing Sotto did not write. |
| `npm run package:host` | A standalone Node build, reviewed external dependency closure, notices, runtime manifest, provenance and SHA256; extraction into a fresh directory, listener health and persisted identity after native SIGTERM. |
| `SOTTO_REAL_SSHD=1 npx vitest run tests/integration/realSshd.test.ts` | The SSH transport against a real OpenSSH server. The step before it installs openssh-server if the image lacks it. The test generates a host key and a passphrase-protected client key, starts its own sshd on a loopback port as the runner account, and drives `DesktopHosts` and the real launcher through the runner's ssh at `<user>@localhost`, against the host archive the previous step built, extracted into a fresh directory. Connect asks for the host key and the passphrase once each through the askpass helper, starts the host and pairs itself; the host's thread list and a command cross the forward; killing the forward reconnects after the first 3-second backoff step, to the same host and pairing; Disconnect leaves the host running; Stop host stops it; Forget revokes the pairing on the host and stops it, and a further connect does not pair again. |
| `npm run notices:verify` | The host's external and bundled dependency inventories are covered by the maintained notices. |

The job retains `Sotto-host-*-linux-x64.tar.gz` and its checksum sidecar as a workflow artifact for 14 days. It does not publish them. The archive contains zod and no native modules; a new dependency or native binary fails the packaging check until its runtime/release path is reviewed. The desktop's Windows node-pty installation is never copied into a Linux archive.

Run `npm run package:host` locally for the same extraction and startup check. The filename records the actual platform. `npm run host:verify -- <extracted-directory>` verifies an existing extracted archive against its manifest and provenance; `node scripts/smoke-host-archive.mjs <extracted-directory>` additionally starts and stops it. On Windows only, smoke shutdown exercises the signal handler through IPC, since Windows cannot deliver a graceful POSIX SIGTERM. The Linux CI run and a real Forge SSH connection remain separate evidence from a local Windows pass.

The real OpenSSH journey is skipped unless `SOTTO_REAL_SSHD=1` is set, so the Windows gates and a plain `npm test` report it as skipped. To run it on a Linux or macOS machine with openssh-server and Node 24, use `SOTTO_REAL_SSHD=1 npx vitest run tests/integration/realSshd.test.ts --maxWorkers=1`. Without `SOTTO_REAL_SSHD_INSTALL` it builds and stages the host itself; `SOTTO_SSHD` names an sshd other than `/usr/sbin/sshd`. It uses its own keys, client configuration and known_hosts file and never touches the account's `~/.ssh`. It proves the transport on this machine's OpenSSH; Windows' own ssh.exe and a real remote host are still proved by hand.

## Browser provider and desktop verification

`tests/integration/browserProviders.test.ts` verifies thread-bound MCP injection and reconnection with scripted native clients. `browserAgentServer.test.ts` checks local transport admission and rejection; browser host and dispatcher tests check page grants, exact actions and observation redaction. These run in the normal two-worker suite.

The opt-in native discovery test starts the installed Codex, Claude Code and Grok clients and waits for their MCP tool catalog request. It sends no model turn and does not prove model-driven browser interaction:

```powershell
$env:SOTTO_BROWSER_LIVE = '1'
npx vitest run tests/integration/browserProvidersLive.test.ts --maxWorkers=1
```

Build and run `npx playwright test tests/e2e/agent-browser.spec.ts tests/e2e/tools-sidecar.spec.ts tests/e2e/phase-three-tools-bridge.spec.ts` to exercise the real Electron browser, permission continuation, feedback drafts and the Tools pane. The agent test uses a local page and test-only provider entry point; it needs no provider account. Screenshots and a geometry report are written to ignored `artifacts/agent-browser/`. Native-provider compatibility and actual desktop results are recorded separately in `docs/verification/`.
