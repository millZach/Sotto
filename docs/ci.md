# Continuous integration

`.github/workflows/ci.yml` runs the same gates a developer runs by hand, on a `windows-latest` runner, for every push to `main`, every pull request against `main` and once a week on `main`. Linux also runs the typecheck and the unit and integration suite on `ubuntu-latest`. It never builds desktop installers, never publishes, and uses no secrets; the release workflows started by hand, described at the end, build the Mac and Linux installers and still publish nothing. A second Windows job builds and verifies the unpacked Windows app, a trial Windows job drives the built desktop app, a separate Linux job builds and verifies the plain Node host archive, and a macOS job tests and compiles the native iOS client.

## Terminal interaction verification

After a build, run `npx playwright test tests/e2e/terminal-search-links-zoom.spec.ts tests/e2e/terminal-display.spec.ts tests/e2e/pane-terminal.spec.ts tests/e2e/terminal-loading.spec.ts tests/e2e/terminal-closed-output.spec.ts`. The interaction spec drives real Windows ConPTYs in the pane drawer and Tools. It checks output search, safe modifier-click links through a stubbed external opener, font size and PTY resize, and native clipboard image paste, on the DOM renderer. The display spec separately checks WebGL colours and contiguous glyphs.

The interaction spec writes light and dark search and link-choice captures at 1600x1000, 1280x800 and 820x560 with reduced motion on through the shared evidence helper. Ordinary runs use ignored `artifacts/e2e-runs/terminal-search-links-zoom/`; set `SOTTO_E2E_EVIDENCE=publish` to refresh the cited images under `artifacts/terminal-search-links-zoom/` on purpose. Selected captures cited in the verification note are committed explicitly. It needs no provider account or network page and runs serially under the existing one-worker Playwright configuration. The Windows desktop trial also runs this interaction spec, including shifted Equals and native Plus input in both terminals; the other terminal specs remain local desktop verification.

## When each job runs

Gates (Windows) runs for every push to `main` and every pull request. Main's ruleset requires it, Package result and Desktop result on a pull request's newest commit, but not that the pull request be up to date with `main`: a green pull request reruns only when it overlaps what has landed since (the rule is in `AGENTS.md` under Branches and pull requests), and the run on every push to `main` catches two pull requests that break each other without overlapping. Nobody bypasses the ruleset, admins included, so every change reaches `main` through a pull request, release commits too ([the release procedure](release/releasing.md)). Gates (Windows) is a short Linux job that reports on three others:

- **Typecheck and lint (Windows)** runs `assets:verify`, the typecheck, lint and `notices:verify` on every run.
- **Tests (Windows, 1/6 to 6/6)** split the suite across six runners with `--shard`, two workers each. As one step the suite took 24 to 27 minutes and ran near its limit (#895); split six ways, every file still runs on Windows and the run takes minutes. Each shard prints completed tests with verbose reporting, so a stalled file's log shows which tests finished before cancellation.
- When every file a pull request changes is a document (`docs/`, `artifacts/`, `design/`, `handoff/`, a Markdown file at the root, or `.gitignore`), Changed areas skips the shards. Typecheck and lint (Windows) then also runs `tests/unit/release` and `tests/unit/scripts`, the tests that read the repository's own documents: ADR links and numbers, artifact ignores, evidence notes, notices and file encoding. A push to `main` always runs every shard, so a document test outside those folders still gets caught there.

**Tests (Linux, 1/6 to 6/6)** run whenever Changed areas sets `tests=full`, the same decision as the Windows shards, and on every push to `main`. Renderer and preload changes run them even when the host archive job is skipped. Six shards with two workers each leave margin around the Windows suite's 24–27-minute unsharded workload; the first shard also runs the typecheck on Linux. Documents-only pull requests skip these shards and keep the existing Windows document tests.

**Linux result** always runs after Changed areas and the Linux shards. It fails unless Changed areas succeeded and all Linux shards passed, including the typecheck, or Changed areas chose documents only and the shards were skipped. A failed, cancelled or unexpectedly skipped matrix fails the summary. This check is informational; adding it to the ruleset is the owner's decision.

Gates (Windows) fails unless Changed areas finished, the checks passed and every shard passed, or the shards were skipped for a documents-only change. The ruleset requires this job by name; a skipped job would count as passing, which is why it always runs. A shard cancelled at its limit is rerun, never bypassed. A push to `main` also runs the other slower jobs every time, except Native iOS client (macOS), which runs only when the push changed what it reads (below). On a pull request, a short Linux job, Changed areas, reads the files the pull request changes and decides whether those jobs are needed:

- **Host archive and socket contract (Linux)** runs unless every changed file is in the renderer (`src/renderer/`, `src/preload/`), the iOS client, `docs/`, `artifacts/`, `design/`, `handoff/`, the e2e, renderer-unit or perf tests, or a Markdown file at the root other than `THIRD_PARTY_NOTICES.md`. A path that list does not name runs the job, so a new area is covered until someone decides otherwise.
- **Package (Windows)** runs unless every changed file is a document (`docs/`, `artifacts/`, `design/`, `handoff/`, a Markdown file at the root), a test under `tests/`, or the native iPhone or Android client. It runs `npm ci`, `npm run assets:verify` and `npm run package:dir`: the build, the build provenance, `electron-builder --dir --win --x64` and `scripts/verify-packaged-resources.mjs` on `release/win-unpacked`. That is the release's packaging step without the installer. It exists so a change to `electron-builder.yml`, the packaging scripts, the packaged resources or anything the build bundles fails on the pull request rather than on the Windows PC at release time. Linux work on the desktop app (#833) made it necessary (#844).

  Changed areas also runs it when a document the package carries changes: the root `README.md`, `LICENSE.md` and `THIRD_PARTY_NOTICES.md`. The file list is read with rename detection off, so a file moved into a skipped area still counts its old path.

  Before packaging, the job verifies the installed Claude SDK history helper and terminal assets. Voice workers and their WebAssembly ONNX Runtime are retired (ADR-0068); the packaged-resource check refuses them. Since ADR-0071 the check requires exactly `zod`, `node-pty`, `sherpa-onnx-node` and this platform's `sherpa-onnx-*` package among the production modules, and loads `sherpa-onnx-node`, the speech model's native module with its own ONNX Runtime, from the packaged app, the way it spawns a terminal for `node-pty`. The installer carries no model, so the check proves the module loads, not that it transcribes.

  **Package result** is a short Linux job that always runs after it. It fails if Changed areas did not finish, or if Package (Windows) was needed and did not pass. A skipped job counts as passing for a required check, so a ruleset that requires packaging names Package result, not Package (Windows).
- **Desktop check (Windows)** runs when Package (Windows) is needed, or when `tests/e2e/` or `tests/fixtures/` changes, and on every push to `main`. On `windows-latest` with Node 24.22.1 it runs `npm ci`, `npm run assets:verify` and `npm run test:desktop-smoke`. It uses the same long temporary path as the other Windows jobs. The 30-minute timeout leaves room for a cold install, build and serial Electron journeys. It retains screenshots and proof files on both success and failure from `artifacts/review-393/desktop-run/` and Playwright diagnostics from `test-results/` as `windows-desktop-journeys-<attempt>` for 14 days. It also runs `tests/e2e/terminal-search-links-zoom.spec.ts` for terminal search, safe links and zoom. It uses no secrets and publishes nothing. Package result continues to check packaging alone.

  **Desktop result** is a short Linux job that always runs after Changed areas and Desktop check (Windows). It fails if Changed areas did not finish successfully, or if Desktop check (Windows) was needed and did not pass, including a skipped or cancelled desktop run. A successful Changed areas decision that the desktop check is not needed lets it pass. Main's ruleset requires **Desktop result**, because a skipped Desktop check (Windows) counts as passing on its own.
- **Native iOS client (macOS)** runs only when `apps/ios/`, `src/shared/hostProtocol.ts` (which the client's wire types mirror) or this workflow changed. Its Swift tests and simulator build read nothing outside `apps/ios/`. A push to `main` uses the same three paths, read from the commit of the last push run on `main` that finished green to the commit pushed: two pull requests that change none of them cannot break the iOS client together, so the push does not spend over an hour of a macOS runner (the job's limit is 110 minutes) rebuilding what did not change. A run the next merge cancelled, or one that failed, proved nothing, so its commits stay in the range until a run passes; a burst of merges therefore still runs the iOS job once one of them changed the client. Changed areas finds that run through the Actions API, which is why it alone reads `actions`, and fetches its commit without file contents, since only the changed names are read. When the run or its commit cannot be found, the job runs.
- **Core ML speech helper (macOS)** runs only when `native/coreml-asr/`, `scripts/build-coreml-asr.mjs` or this workflow changed. It builds the Swift helper the Mac app uses to run FluidAudio's Core ML speech models (ADR-0094) and checks that it answers `--version` with its protocol. It is not a required check; the Mac app's packaged-resources check runs the helper again at release.

A job that is not needed reports as skipped, not failed. A change that should have run a skipped job still gets it on the push to `main` after merging, and the iOS job gets it in the weekly run at the latest.

**The weekly run** starts every Monday at 10:00 UTC on `main` and runs every job, whatever changed. It finds a runner image, Xcode or toolchain update that breaks a job no change touched, and it runs the iOS job that pushes now skip. It has a concurrency group of its own, so it neither cancels a push's run on `main` nor is cancelled by one. Its checks land on the commit `main` points to, and `release:check` reads the newest result of Gates (Windows) and Package result on that commit, so a weekly run that fails either holds a stable release from that commit until it is fixed. A weekly failure of the iOS job alone does not: that job is not a required check.

## What the job runs

| Step | Command | Why it exists |
| --- | --- | --- |
| Install dependencies | `npm ci` | Exact `package-lock.json` install, including the native modules (node-pty and sharp). The npm cache is keyed on the lockfile by `actions/setup-node`. |
| Verify release assets | `npm run assets:verify` | Checks the installed Claude SDK history helper and terminal files used by desktop packaging. No network access. |
| Typecheck | `npm run typecheck` | `tsc --noEmit` over the node, web and test projects. Runs in the Windows checks job and once in Linux shard 1 when the full suite is needed. |
| Lint | `npm run lint` | `eslint .`. |
| Unit and integration tests | `npm test -- --maxWorkers=2 --shard=N/6` on six Windows and six Linux runners | `vitest run` — test files under `tests/` only, excluding `tests/e2e/`. Ignored cache and backup suites outside `tests/` are never collected. The worker cap keeps the jsdom and child-process heavy files inside a small runner's memory; unpinned parallelism has produced "Worker exited unexpectedly" crashes on a loaded machine. Main-process and integration files run under node rather than jsdom, declared by a `@vitest-environment node` header on each file; a file in those folders that needs a DOM says `jsdom` instead. |
| Third-party notices | `npm run notices:verify` | Checks `THIRD_PARTY_NOTICES.md` against the installed dependency tree. |

The renderer activity tests keep handles to their mounted prompt editors, finish Tiptap’s deferred destruction during cleanup and assert that each editor is destroyed before jsdom removes `document`. This prevents a late dependency callback from making an otherwise passing full suite fail; no test deadline or sleep is changed.

`tests/unit/release/trackedFileEncoding.test.ts` checks every Git-tracked file for a UTF-8 byte order mark in the normal test gate. Files stay UTF-8 without a BOM.

Each gate is its own named step, so a red check names the gate that failed. Locally, `npm test -- --maxWorkers=2` still runs the whole suite in one go; while iterating, `npx vitest related <changed files> --run` runs only the tests that import them.

The real OpenSSH journey stays in **Host archive and socket contract (Linux)**, which installs OpenSSH and exercises the extracted host archive. That step sets `SOTTO_REAL_SSHD_REQUIRED=1` as well as `SOTTO_REAL_SSHD=1`; losing the opt-in fails the journey rather than silently skipping it. Supplying `SOTTO_REAL_SSHD_INSTALL` without the opt-in also fails. Ordinary Linux shards collect this file but skip its opt-in journey, just as a local full-suite run does. The throwaway host shadows Tailscale with a failing CLI and asserts that it stays on SSH, so an installed Tailscale cannot move the test away from its forward or change the machine’s Serve settings. Live-provider and performance opt-ins are unchanged.

`tsconfig.node.json` checks main, host, preload and shared code with Node types and no DOM, so a browser-only global there fails the typecheck. `tsconfig.tests.node.json` checks every `tests/**/*.ts` file, with that code and the DOM, which Playwright's page callbacks and imported renderer modules need.

`tsconfig.tests.json` checks every `tests/**/*.tsx` file, including renderer tests,
benchmarks and fixture views, with the web project's JSX and DOM assumptions plus
Node, Vitest and Testing Library types. Vitest executes these files but does not
replace this semantic check. The node and web projects keep their existing source
boundaries. Test fixtures must satisfy the current bridge and component contracts;
an ignored query option or an incomplete mock is an error in the normal typecheck
gate, even if the test happens to run.

`tests/integration/nativeTargetRefresh.test.ts` holds one unrelated thread's actual native history refresh open while another thread receives its prompt acknowledgement and exact persisted receipt. The barrier stays held through both assertions for Codex, Claude and Grok; the normal test deadline bounds failures, with no wall-clock performance budget. A diagnostic that makes the target wait for the held refresh must fail the acknowledgement assertion before cleanup releases the history read.

The job cancels a superseded run on the same ref (`concurrency` with `cancel-in-progress`), has a 40-minute safety timeout, and requests only `contents: read`.

## What CI deliberately does not run

- **The full Playwright suite** (`npm run test:e2e`) and the widget design captures. Only the selected desktop smoke journeys run in the Desktop check (Windows) job; the complete suite and its design captures remain local.
- **Live provider suites.** Every one of them is gated behind an explicit `SOTTO_*` environment variable (`SOTTO_CLAUDE_LIVE`, `SOTTO_GROK_LIVE`, `SOTTO_NATIVE_THREADS_LIVE`, `SOTTO_SIDE_WRITING_LIVE`, and friends). CI sets none of them and holds no credentials, so they stay skipped.
- **Perf benchmarks.** The three data-backed files (`statePipeline.perf.test.ts`, `threadsRender.perf.test.tsx`, and `longTranscript.perf.test.tsx`) require both `SOTTO_PERF_BENCH=1` and an explicit nonempty `SOTTO_PERF_DATA` directory containing `workspace.json`. Without both settings they skip before probing any data directory. There is no personal-profile fallback. Use a synthetic or deliberately selected copy; the benchmarks make temporary working copies and remove them after the run. CI sets neither variable. The benchmarks that build their own workload and only report timings, `claudeFramer.perf.test.ts`, `checkpointSend.perf.test.ts`, `claudeSettings.perf.test.ts`, `codexOpenApply.perf.test.ts`, `codexSendRead.perf.test.ts`, `commandReceipt.perf.test.ts`, `commandReply.perf.test.ts`, `earlyStart.perf.test.ts`, `devinSendPath.perf.test.ts`, `firstWordsBridge.perf.test.ts`, `grokChunkAppend.perf.test.ts`, `previewSend.perf.test.ts`, `screenshotResize.perf.test.ts`, `screenshotTotal.perf.test.tsx`, `sendReads.perf.test.ts`, `sendToFirstWords.perf.test.ts`, `sendWrites.perf.test.ts`, `snapshotCloning.perf.test.ts`, `threadCommandLanes.perf.test.tsx`, `threadSettings.perf.test.ts`, `usageStreamWrites.perf.test.ts` and the timed half of `attachmentHandles.perf.test.ts`, skip themselves unless `SOTTO_PERF_BENCH=1` is set (`tests/fixtures/perfBench.ts`, which also holds the median they report). They tell a run nothing and cost it seconds, so CI never sets the switch. `screenshotResize.perf.test.ts` launches the built app, so run `npm run build` before it. The same switch runs one Playwright spec, `tests/e2e/native-process-memory.spec.ts`, which launches the built app with the real Claude and Codex adapters over the fake CLIs, holds 1, 4 and 8 long threads, and prints the working sets of main, the renderer and the provider processes, with main's and the renderer's heaps and private bytes, with one pane showing and with none (`docs/perf/2026-09-27-native-process-memory.md`). The desktop trial does not select this spec, and run by hand without the switch it reports as skipped: `npm run build`, then `$env:SOTTO_PERF_BENCH = '1'; npx playwright test tests/e2e/native-process-memory.spec.ts` in PowerShell or `SOTTO_PERF_BENCH=1 npx playwright test tests/e2e/native-process-memory.spec.ts` in sh. It also runs `tests/e2e/main-freeze.spec.ts`, which launches the built app on Owl with the owner's history (about 250 threads with provider sessions, a current Watcher with the owner's record and standing watches, the owner's answer retirements and a connected remote host), streams to none, one and three threads, and prints main's event-loop delay and its stalls of 100 ms or more, with keystroke-to-screen latency in the composer (`docs/perf/2026-10-15-main-freeze.md`); with `SOTTO_PERF_ASSERT=1` as well it fails past its limits, which only the nightly Main freeze workflow sets (below). `codexSendRead.perf.test.ts` also takes `SOTTO_PERF_WITHOUT_TURNS_LIST=1`, which has the fake refuse `thread/turns/list` so that a send reads the way it did before the newest-turn check. `devinSendPath.perf.test.ts` also takes `SOTTO_DEVIN_PIECES=1`, which times the two integration lists and an ACP process start against the installed Devin CLI without sending any prompt (`docs/perf/2026-10-06-devin-send-path.md`). `sendToFirstWords.perf.test.ts` sends through the host service, the coordinator, the workspace with checkpoints wired in and the real Claude and Codex adapters over the fake CLIs, in a small Git working copy and one past the checkpoint limit that it writes to the temporary folder first (about 280 MiB, plus Git's copy); `SOTTO_PERF_LARGE_FILES`, `SOTTO_PERF_LARGE_MIB` and `SOTTO_PERF_SENDS` change its size and length (`docs/perf/2026-10-05-send-to-first-words.md`). Unlike the others it takes about two minutes a run. `checkpointSend.perf.test.ts` compares the send's checkpoint step with the commit #764 started from, and takes three more switches: `SOTTO_PERF_CHECKPOINT_ONLY` runs only the working copies whose names contain it, `SOTTO_PERF_CHECKPOINT_REPO` points its "this repository" copy at another checkout, and `SOTTO_PERF_CHECKPOINT_BASE` names another commit to compare with (`docs/perf/2026-10-05-checkpoint-send.md`). The structural checks need no benchmark data and assert something other than time, so they do run: `markdownRender.perf.test.tsx` renders the same reply incrementally and whole, logs both timings, and always checks that incremental parsing processes less than a third of the characters; `detailCacheRecency.perf.test.tsx` scripts a session over the window's connection and always checks that coming back to the thread the user works in never fetches its detail again; and the byte half of `attachmentHandles.perf.test.ts` stages an 8 MiB screenshot and always checks that a draft save, its answer, the shell, `agents.json` and the preview file each stay under 64 KB with it in the draft. `activitySummaries.perf.test.ts` always checks the summary frame's byte bound; only its timing case is gated. `shellDetailCommits.perf.test.tsx` always checks commits per streamed chunk in both shell/detail arrival orders. `streamingCopyBudget.perf.test.ts` always counts what one streaming update copies on Owl and on stable, with 20 and with 200 threads, and checks that the count does not grow with the threads and stays within its budget (`docs/perf/2026-10-15-copy-budget.md`). `ownerScaleWorkBudget.perf.test.ts` always builds main as `src/main/index.ts` wires it, on Owl and on stable with Muse and OpenCode held, at the owner's scale, with a quarter of their history and with a quarter of their threads; streams on one and three threads, saves an answer draft, types in a composer, opens a thread and sends; and checks that the work each update and each action does (every copy and its size, whole-state copies, publications the provider switch had to copy, router and coordinator shell builds, thread visits, Watcher record copies and comparisons, threads Watcher's wake-up pass works through without watching them, the answer-draft store's look-ups, `JSON.stringify` calls, reads of a provider out of public IDs and schema failures) stays flat with the history, grows no faster than the threads, and stays within its budget (`docs/perf/2026-10-20-main-lag.md`, under The gate). Its timers run on Vitest's fake clock and it waits for file work to finish rather than for time to pass, so its counts are the same on every run; `SOTTO_WORK_SITES=1` names where the serializations and thread visits that grew are made. `tests/unit/main/copySites.test.ts` always checks every copy call site in main and the headless host against `tests/fixtures/copySites.json`. The sentinel cases in `codexOpenApply.perf.test.ts` and `snapshotCloning.perf.test.ts` always check that the adapter and activity members their opt-in benchmarks wrap still exist. The markdown file's elapsed-time comparison is opt-in like the other stopwatch budgets below.

  Run a timing benchmark by hand on an idle machine. Each prints its medians to the console; the matching note in `docs/perf/` says what they mean:

  ```powershell
  $env:SOTTO_PERF_BENCH = '1'
  npx vitest run tests/perf/claudeFramer.perf.test.ts --maxWorkers=1 --disable-console-intercept
  ```

  ```sh
  SOTTO_PERF_BENCH=1 npx vitest run tests/perf/claudeFramer.perf.test.ts --maxWorkers=1 --disable-console-intercept
  ```
- **iPhone CPU.** Eleven journeys in `FocusJourneyTests` record the app's CPU time. Five hold Threads or a thread still for three seconds: with its looping lights and wash running, with them stopped (`--ui-still`), and in the thread with the reply keyboard open. Two type a sentence into a reply box. Four sit on Threads or in the working thread for three seconds while it streams (`--ui-streaming`: a word every 50 milliseconds, with the thread list sent again unchanged each time). The typing and streaming journeys each run once as the app is and once with `--ui-publish-everything`, which publishes every change on the whole model as the app did before its stores. All three switches are Debug-only. The journeys skip unless the test runner sees `SOTTO_IOS_PERF=1`; run them on a Mac with `TEST_RUNNER_SOTTO_IOS_PERF=1 sh apps/ios/Scripts/verify-ui.sh`, which xcodebuild passes to the runner. They assert nothing; [the idle note](perf/2026-10-06-iphone-idle-cpu.md) and [the publishing note](perf/2026-10-06-iphone-publishing.md) say what the numbers mean.
- **Wall-clock budgets.** See below.
- **Desktop installers and all publishing.** Desktop releases are cut by hand on the Windows PC and forge; the Apple silicon Mac's disk images are built by the dispatched `owl-mac.yml` and `stable-mac.yml` workflows below, and an Owl's Linux tarball and pacman package by the dispatched `owl-linux.yml`. Package (Windows) builds and verifies the unpacked Windows app, but not the NSIS installer or the macOS disk image. The Linux host archive is built and verified in its separate job, then published manually.

The historical `tests/review/composer-polish` capture harness was removed (#605).
It had no npm runner and used fixed sleeps. Its retained captures and verdicts
remain recorded in `docs/verification/phase-2-implementation.md`. Some composer
regressions run through `tests/e2e/composer-short-window.spec.ts` in the normal
Playwright tree. Current tests do not cover the deleted harness's skill picker
over a split pane at 1600x900, 1280x800 and 1280x560, the queue composer at the
760x560 stress size or at 1280x800 with 125% and 150% zoom, or a failed working
folder keeping its draft. Every separate
Playwright config under `tests/` must have an npm runner;
`tests/unit/release/testDiscovery.test.ts` checks that boundary.

## E2e evidence

E2e specs and the four opt-in native evidence probes use `tests/fixtures/evidence.ts`.
Ordinary runs write to ignored `artifacts/e2e-runs/<name>/`. The name is the default
directory's path relative to `artifacts/`, including any subdirectories; a default
directory outside `artifacts/` is rejected. For example, appearance captures go to
`artifacts/e2e-runs/verification/phase-1-appearance/`, and the two Electron review
folders stay separate as `review-381/electron/` and `review-389/electron/`.
Both Git and ESLint ignore `artifacts/e2e-runs/`. It sits outside Playwright's
`test-results/` output, so starting another Playwright command keeps earlier evidence.

`SOTTO_E2E_ARTIFACT_ROOT` takes precedence and puts that same relative path
under the chosen root, including when publication is requested. Without that override,
`SOTTO_E2E_EVIDENCE=publish` writes to the historical `artifacts/` folder instead.
Set it only to refresh committed evidence on purpose, then inspect the working
tree and keep only the captures the verification note cites. Existing artifact
folder names stay as they are so those citations keep working.

For example, publish theme-library evidence after building the app:

```sh
SOTTO_E2E_EVIDENCE=publish SOTTO_THEMES_E2E=1 npx playwright test tests/e2e/theme-library-evidence.spec.ts
```

```powershell
$env:SOTTO_E2E_EVIDENCE = 'publish'
$env:SOTTO_THEMES_E2E = '1'
try { npx playwright test tests/e2e/theme-library-evidence.spec.ts }
finally { Remove-Item Env:SOTTO_E2E_EVIDENCE, Env:SOTTO_THEMES_E2E }
```

The five design-capture surface specs under `tests/e2e/` are
`design-capture-pages.spec.ts`, `design-capture-threads.spec.ts`,
`design-capture-appearance.spec.ts`, `design-capture-voice-widget.spec.ts` and
`design-capture-scaling.spec.ts`. They share their explicit baseline-update flag
through `tests/e2e/support/designCapture.ts`; `tests/e2e/support/designCaptureManifest.mjs`
validates the complete matrix once all five finish. `visual-previews.spec.ts` also
keeps its own explicit baseline-update flag. Evidence publication does not update
those baselines.

`scripts/capture-design.mjs` starts the app with its version pinned to 0.1.36, the
version the Help and Settings baselines show, so a release that bumps
`package.json` changes no capture. Change the pinned version only together with
regenerated baselines.

## Opt-in appearance and theme captures

`npm run test:e2e` builds and runs the ordinary Electron suite with one worker.
Five specs save appearance, theme or terminal drawer captures only when their
evidence variable is set. The four theme specs skip entirely without it; the
terminal drawer spec still runs its checks in the ordinary suite and only skips
the captures. These captures are developer evidence, not part of the ordinary suite or CI.
Build first with `npm run build`, then enable the spec you want to capture:

```sh
SOTTO_THEMES_E2E=1 npx playwright test tests/e2e/theme-library-evidence.spec.ts
SOTTO_APPEARANCE_EVIDENCE=1 npx playwright test tests/e2e/appearance-evidence.spec.ts
SOTTO_THEME_EVIDENCE=1 npx playwright test tests/e2e/theme-palettes-evidence.spec.ts
SOTTO_THEME_BRANDING_EVIDENCE=1 npx playwright test tests/e2e/theme-branding-evidence.spec.ts
SOTTO_PANE_TERMINAL_EVIDENCE=1 npx playwright test tests/e2e/pane-terminal.spec.ts
```

In PowerShell, set the matching variable before the command and remove it after:

```powershell
$env:SOTTO_THEMES_E2E = '1'
try { npx playwright test tests/e2e/theme-library-evidence.spec.ts }
finally { Remove-Item Env:SOTTO_THEMES_E2E }
```

| Spec | Publication folder (`SOTTO_E2E_EVIDENCE=publish`) |
| --- | --- |
| `theme-library-evidence.spec.ts` | `artifacts/phase-three-themes/` |
| `appearance-evidence.spec.ts` | `artifacts/verification/phase-1-appearance/` |
| `theme-palettes-evidence.spec.ts` | `artifacts/verification/sotto-palettes/` |
| `theme-branding-evidence.spec.ts` | `artifacts/phase-three-theme-branding/` |
| `pane-terminal.spec.ts` | `artifacts/pane-terminal/` |

The appearance spec's optional whole-screen capture additionally needs
`SOTTO_APPEARANCE_SCREEN_CAPTURE=1` and an otherwise clear desktop. Leave it unset
for app-window captures. Run Electron captures serially on an interactive desktop;
inspect their images before claiming visual verification. These commands write
disposable evidence by default. Publication needs the separate setting above;
keep only intended captures when publishing. They do not regenerate the design
comparison baselines.

## Devin native verification

The scripted adapter tests exercise each advertised permission mode in its own fixture. Combining all six sends in one test accumulated six provider processes against one test deadline and intermittently timed out on Windows, including on `main`. Each case still checks the complete advertised mode list, its selected mode and the accepted send; the separate simultaneous-thread test covers concurrency. The normal deadlines remain unchanged.

`tests/integration/devinAdapter.test.ts` runs the complete shared adapter contract and boundary cases against a scripted ACP subprocess in CI, and `tests/integration/devinSendPath.test.ts` pins what a send starts before its prompt and which streamed work shows Devin took it (#770). They do not establish live CLI compatibility.

The opt-in `tests/integration/devinLive.test.ts` uses the installed, natively signed-in Devin CLI (3000.11.92 or newer) and account-advertised `swe-1-6-fast`. It creates a disposable Git project and incurs native account usage. It checks denial, exact-target one-time approval, a structured question, same-session restart, and cancellation. Between turns it also starts a second ACP process with no prompt and checks Devin refuses it the session the thread holds, which is what lets a send skip reading history first, and sends one prompt whose one-word reply must reach the thread as it streams. Each send logs how long it took to be accepted, by stage, and nothing else. Two additional Windows-only cases kill a uniquely identified test ACP owner while permission is pending and verify safe model-change refusal or same-session recovery, according to whether the native model had been saved by a clean shutdown. It never reads credentials or logs protocol bodies. Run on native Windows and Apple silicon macOS before claiming both platforms verified. The initial PR is verified on Windows only; Zach deferred Mac verification because no Mac is available:

```powershell
$env:SOTTO_DEVIN_LIVE = '1'
npx vitest run tests/integration/devinLive.test.ts --maxWorkers=1
```

```sh
SOTTO_DEVIN_LIVE=1 npx vitest run tests/integration/devinLive.test.ts --maxWorkers=1
```

The same file has the check that Devin threads get Sotto's tools (#1040). It spends two turns on the account's first ready model. The first, in the session the thread was made in, calls Sotto's `visualize`, which must run with no request because the owned profile (version 3) lets Sotto's own servers through, and `ping` on a decoy server named `sotto-visual`, which Devin must still ask about; the test denies it, as the user would. The second calls `visualize` again after Sotto restarts with a new visual server and loads the session. `SOTTO_DEVIN_EXECUTABLE` points it at a Devin CLI unpacked from its zip instead of the installed one. It passed once on October 16, 2026, against 3000.11.92 (ADR-0017). To run only that check:

```powershell
$env:SOTTO_DEVIN_LIVE = '1'
npx vitest run tests/integration/devinLive.test.ts -t "tools in a new session and in a loaded one" --maxWorkers=1
```

Use `npm run build` followed by `npx playwright test tests/e2e/devin-provider.spec.ts` for the Electron provider/permission journey, keyboard path, independent-provider behavior, coordinator separation, and light/dark/minimum-size captures. The verification note records actual platforms and results; a fixture pass is not a native-platform pass.

## Claude settings live check

`tests/integration/codexThreadForkLive.test.ts` is gated by `SOTTO_CODEX_LIVE=1`. With the installed, signed-in Codex it runs one model turn in a temporary project that asks Codex to start one small agent and wait for it, then continues that agent as its own thread and forks the thread at its reply through Sotto's adapter (#1028, ADR-0090), which asks the model nothing more. Each fork is durable and is written beside the user's other Codex rollouts. Codex opens its usual Responses websocket when a fork starts, as opening any thread does, and the check expects it. It has not been run yet:

```powershell
$env:SOTTO_CODEX_LIVE = '1'
npx vitest run tests/integration/codexThreadForkLive.test.ts --maxWorkers=1
```

`tests/integration/claudeSettingsLive.test.ts` is gated by `SOTTO_CLAUDE_LIVE=1`. It starts one thread's CLI in a temporary synthetic project with the installed, signed-in Claude Code and changes that thread's effort, model and permission mode over the control channel, then reads back what the CLI reports. It sends no prompt and runs no model turn. It prints the CLI version, the IDs of the models it moved between, whether each value matched and the timings, never a prompt, a reply or a key. It was last run on Claude Code 2.1.283 (`docs/verification/2026-09-25-claude-settings-live.md`):

```powershell
$env:SOTTO_CLAUDE_LIVE = '1'
npx vitest run tests/integration/claudeSettingsLive.test.ts --maxWorkers=1 --disable-console-intercept
```

```sh
SOTTO_CLAUDE_LIVE=1 npx vitest run tests/integration/claudeSettingsLive.test.ts --maxWorkers=1 --disable-console-intercept
```

## Claude early start live check

`tests/integration/claudeEarlyStartLive.test.ts` is gated by `SOTTO_CLAUDE_LIVE=1`. With the installed, signed-in Claude Code and a temporary synthetic project, it starts spares for new threads (ADR-0057), creates threads with and without one, and starts four watched threads' CLIs at connect one after another and four at a time. It sends no prompt and runs no model turn, and fails if Claude Code wrote a session file for any of them. It prints the CLI version and timings, never a prompt, a reply or a path. It was last run on Claude Code 2.1.289 (`docs/perf/2026-10-06-early-start.md`):

```powershell
$env:SOTTO_CLAUDE_LIVE = '1'
npx vitest run tests/integration/claudeEarlyStartLive.test.ts --maxWorkers=1 --disable-console-intercept
```

```sh
SOTTO_CLAUDE_LIVE=1 npx vitest run tests/integration/claudeEarlyStartLive.test.ts --maxWorkers=1 --disable-console-intercept
```

## Claude background report live check

`tests/integration/claudeBackgroundReportLive.test.ts` is gated by `SOTTO_CLAUDE_LIVE=1`. It runs two model turns with the installed, signed-in Claude Code in a temporary synthetic project. One thread leaves a background agent running; the other leaves a background command running, with bypassing allowed. In each, the check holds the row state the sidebar would show until Claude has reported back. It fails when the row reads Done for 500 ms or more before the report settles, or when a prompt sent during the report is not refused. It prints the CLI version, the row states and their timings, never a prompt or a reply. It was last run on Claude Code 2.1.283 (`docs/verification/2026-09-27-claude-report-turn-live.md`):

```powershell
$env:SOTTO_CLAUDE_LIVE = '1'
npx vitest run tests/integration/claudeBackgroundReportLive.test.ts --maxWorkers=1 --disable-console-intercept
```

```sh
SOTTO_CLAUDE_LIVE=1 npx vitest run tests/integration/claudeBackgroundReportLive.test.ts --maxWorkers=1 --disable-console-intercept
```

## Codex newest-turn live check

`tests/integration/codexNewestTurnLive.test.ts` is gated by `SOTTO_CODEX_TURNS_LIVE=1`. It starts the installed Codex app-server in a throwaway `CODEX_HOME`, so it needs no sign-in and never reads the user's own Codex threads, and it runs no model turn. On a legacy thread whose session file it fills with filler turns, it checks that `thread/turns/list` hands back the same newest turn `thread/read` does and that both see a turn written to the file from outside, which is what the newest-turn check before a Codex send rests on (ADR-0005). It checks that Codex still words a request it does not have, and a value in one it does not know, the way the adapter reads a refusal, so a new Codex that words them differently shows up here. It then prints each request's round trip and reply size at 50, 500 and 2,000 turns. It was last run on Codex CLI 0.157.1 (`docs/perf/2026-09-26-codex-send-read.md`):

```powershell
$env:SOTTO_CODEX_TURNS_LIVE = '1'
npx vitest run tests/integration/codexNewestTurnLive.test.ts --maxWorkers=1 --disable-console-intercept
```

```sh
SOTTO_CODEX_TURNS_LIVE=1 npx vitest run tests/integration/codexNewestTurnLive.test.ts --maxWorkers=1 --disable-console-intercept
```

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
| 100 ms | `tests/unit/main/threadDrafts.test.ts` — *publishes local queued feedback before provider latency…* | The first published `queued` delivery after a send. |
| 250 ms | `tests/integration/codexStreamingResponsiveness.test.ts`, `tests/integration/nativeStreamingResponsiveness.test.ts` | The longest main-process heartbeat gap while three threads stream 600 output updates, tested for Codex, Claude and Grok. Snapshot coalescing and lossless output are checked regardless of the budget switch. |
| Less than half of structuredClone | `tests/unit/main/cloneHostSnapshot.test.ts` | Median internal snapshot copy with 24 MiB of retained output; container isolation and the incremental-storage work bound are always checked. |
| Less than whole-message rendering | `tests/perf/markdownRender.perf.test.tsx` | Total elapsed time for rendering a reply in 40 incremental chunks against re-parsing each whole prefix. |
| Half the answer's 250 ms acknowledgement | `tests/perf/threadCommandLanes.perf.test.tsx` | Median time for one thread's settings change to reach main while another thread's answer waits on its provider. It is a timing benchmark, so it also needs `SOTTO_PERF_BENCH=1`. |
| 400 ms All time, 150 ms for 30 days, 100 ms for a 5-hour window | `tests/perf/usageStoreQuery.perf.test.ts` | Median Usage store query over 400,000 bursty token rows and 6,000 prompts, each read after a write so none comes from the query cache. Its seed takes about 30 seconds, so it skips unless `SOTTO_PERF_ASSERT=1` or `SOTTO_PERF_BENCH=1` is set; with `SOTTO_PERF_BENCH=1` it also reports, without a budget, the worst case of one row per 15-minute bucket. |

Run them by hand on an idle machine:

```powershell
$env:SOTTO_PERF_ASSERT = '1'
npx vitest run tests/unit/renderer/threadQueueSkills.test.tsx tests/unit/main/threadDrafts.test.ts tests/integration/codexStreamingResponsiveness.test.ts tests/integration/nativeStreamingResponsiveness.test.ts --maxWorkers=2
npx vitest run tests/perf/markdownRender.perf.test.tsx --maxWorkers=1
npx vitest run tests/perf/usageStoreQuery.perf.test.ts --maxWorkers=1
$env:SOTTO_PERF_BENCH = '1'
npx vitest run tests/perf/threadCommandLanes.perf.test.tsx --maxWorkers=1
```

```sh
SOTTO_PERF_ASSERT=1 npx vitest run tests/unit/renderer/threadQueueSkills.test.tsx tests/unit/main/threadDrafts.test.ts tests/integration/codexStreamingResponsiveness.test.ts tests/integration/nativeStreamingResponsiveness.test.ts --maxWorkers=2
SOTTO_PERF_ASSERT=1 npx vitest run tests/perf/markdownRender.perf.test.tsx --maxWorkers=1
SOTTO_PERF_ASSERT=1 SOTTO_PERF_BENCH=1 npx vitest run tests/perf/threadCommandLanes.perf.test.tsx --maxWorkers=1
SOTTO_PERF_ASSERT=1 npx vitest run tests/perf/usageStoreQuery.perf.test.ts --maxWorkers=1
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

The SSH readiness, password and host-update journeys use a 150 s test deadline.
Their real child processes retain their own operation budgets; in particular, an update
starts a host, fetches and unpacks its archive, then stops and starts it again. The default
15 s test deadline must not end that journey during a valid 30 s host start. This is a
failure bound, not a latency assertion; production timeouts and the global test deadline
are unchanged. See [the SSH test evidence](verification/ssh-readiness-test-budget.md).

The terminal clipboard's two pure quoting cases stay in unit tests. Its real Windows
PowerShell or POSIX shell round trip lives in integration tests, with a 60 s child-process
deadline and a 75 s enclosing deadline. It closes unused stdin, connects cancellation to
the child and drains that owned child on completion. A failure reports only fixed phase
facts; no command arguments or output are logged. The exact-string assertion and the
global deadline are unchanged. See [the shell fixture evidence](verification/terminal-clipboard-shell-budget.md).

`vitest.config.ts` gives a test 15 s and an `expect.poll` 5 s, rather than vitest's 5 s and 1 s, and
`tests/setup.ts` gives Testing Library's `findBy` and `waitFor`, and vitest's own `vi.waitFor` and
`vi.waitUntil`, the same 5 s rather than their 1 s. No vitest setting raises `vi.waitFor` or `vi.waitUntil`,
so the setup file wraps them: a call that names no timeout gets 5 s, and a call that passes its own timeout
or interval keeps it. `tests/unit/fixtures/suiteWaitDeadline.test.ts` and its `.node` twin check that the
wrapper holds in jsdom and node files. Waiting is not the assertion: a runner takes several times longer
over a provider round trip or a child process start than a developer machine, and a deadline that expires
there describes the machine. Something that is genuinely wrong still fails, a few seconds later.

A Grok contract failure that looked like a deadline was not one. The Grok fixture polled history every 20 ms,
the same period as the lazy-session contract's reaper sweep, and Windows runs both on the same 15.6 ms timer
tick. When the two started in step, every sweep found a history read under way, which defers a stop (#440), so
an idle session was never stopped and `untilStopped` ran out after 12 s. With a fast sweep and no interval of
its own, the fixture now polls at five sweeps' length, which leaves most sweeps between reads.

Nor was a thread-title failure. "Leaves an older thread alone" reopened over a fake provider that forgets its
sessions, so the thread looked empty and Sotto correctly gave it a first-message title; the assertion passed
only when it ran before that title landed. The reopened provider now holds the exchange, as a real one does,
and the test waits for offered names to land before it checks.

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

Devin is the exception to the 2000 ms default. Native ACP sends no acknowledgement, so a send waits until
its own stream or a replay of the session shows the prompt taken, and the replay is read in a process of
its own after the integration checks start two more. On a loaded Linux runner that took longer than five
seconds, and sends came back uncertain (#1073, #1110). `devinFixture` therefore defaults to the adapter's
own 15 s. A Devin prompt is uncertain only when that deadline passes with nothing showing it taken, so
`driver.delayNextAck()` hides the prompt from the replay and lowers that fixture's deadline to 2000 ms for
what follows. A short deadline is safe there, because a slow runner can only delay the evidence it waits for.

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
3. Reproduce locally with the exact command from the table. The gates are the same ones in the guide's test matrix (`docs/guide.md`, under Development), so a clean local run means a clean CI run, with one common difference worth checking first when CI fails and your machine passes: stale `node_modules` (run `npm ci`, not `npm install`).
4. Push a fix to the same branch. The previous run is cancelled automatically and a new one starts.

## Expected duration

An earlier measurement on a warm developer machine was install 18 s, runtime preparation 1 s, typecheck 22 s, lint 31 s, vitest with two workers 234 s and notices 2 s — about five minutes. That predates the suite's growth and is no longer a gate-time estimate.

That measurement predates the suite's growth. On October 9, 2026, on the Windows development laptop with nothing else running, `npm test -- --maxWorkers=2` took 1,328 s for 9,099 cases at `c53d2908c`, before the #123 cleanup, and 1,248 s for 9,617 cases after it: about 11% less time per case. Gates (Windows) on GitHub took 24 to 28 minutes for the pull requests of that week, so the job then ran close to its former 30-minute timeout.

On October 11, 2026, the original test tree at `e1785ce2f` took **1,120.39 s** on the Windows laptop with two workers: 9,570 passed and 282 skipped (9,852 cases). The source files and HEAD stayed fixed throughout that measurement. Setup cost 90.82 s across the files, imports 177.34 s and environments 112.37 s. The slowest files repeatedly start real Devin sessions, socket hosts, launch-script/systemctl children and Git processes; those interactions remain covered.

The suite now loads React cleanup and DOM matchers only for a DOM environment. Node files keep the filesystem and platform setup without importing the renderer helpers. Git actions copy an unchanged initial repository through the existing independent seed fixture; each case still has its own remote and second clone. SSH launcher cases compile each identical Windows askpass helper once per file and copy the executable into each broker's private folder, while running the real helper and authenticated socket for every connection. Compiler failure coverage stays uncached. These changes remove repeated work without omitting assertions, providers or cases.

The five CI-flake files passed five complete runs on two logical CPUs, each with a CPU load bounded to 55 seconds: 150 tests per run. Slash-command stream ordering is isolated from transcript recovery, and interrupted thinking waits for the separate native result through a scripted gate. Restart cases close the old workspace before opening another. The checkpoint concurrency barrier stays held through the Git refusal and reports a pre-validation error directly; a failure emits only its fixed phase and elapsed milliseconds. The original checkpoint timeout did not recur in 60 amplified executions, so its CI cause remains unproven. The normal 15 s test and 5 s poll deadlines are unchanged.

The job limit is still needed: run 38175246742 attempt 2 spent 1,574.59 s in the suite alone, and run 38111370270 attempt 1 was cancelled after 30 minutes 6 seconds. The **40-minute job limit** leaves room for cold dependencies and load variation while the individual test deadlines continue to catch a hang. The worker cap stays two, and only Gates (Windows)'s limit changed. Local savings are not a new Windows-runner timing claim; the lead's pushed run must establish that.

## Owl Usage dashboard verification

After `npm run build`, run `npx playwright test tests/e2e/usage-dashboard.spec.ts tests/e2e/native-usage-persistence.spec.ts tests/e2e/host-update.spec.ts`. The Usage journeys drive production Electron main, preload, the coordinator and the native Claude adapter with a scripted external client in an isolated profile. They check accepted prompts, input/output/cache figures, model attribution, keyboard and date filters, the minimum-size annual chart, revision-guarded clear, history-off retention, replay, restart and stable database preservation. They send no live model prompt and expose no product test bridge.

Ordinary Usage runs save ignored evidence under `artifacts/e2e-runs/usage-dashboard/`. Set `SOTTO_E2E_EVIDENCE=publish` to refresh the five selected captures and numeric `verified.json` under `artifacts/usage-dashboard/` deliberately. The JSON records requested and actual content sizes, the Windows display's two-pixel rounding tolerance, visible-text contrast and the scripted numeric source. Inspect the screenshots before retaining them. This is local verification, not an additional CI gate or live-provider claim.

## Native usage archive writes

Native usage archive write bounds run in `tests/unit/main/nativeUsagePersistence.test.ts`, beside the accounting cases in `nativeUsage.test.ts`. They check unchanged replay, coalescing, latest-total drain and observable persistence failures without stopwatch assertions. The isolated before/after benchmark in `tests/perf/nativeUsageWrites.perf.test.ts` requires `SOTTO_PERF_BENCH=1`; run it alone with one worker. See [the workload and verification state](perf/2026-09-27-native-usage-writes.md); since #767 the ledger is also written at most once a second while a reply streams ([the note](perf/2026-10-06-send-writes.md)).

## Writes before a send

`tests/integration/sendWrites.test.ts` runs in the normal suite and pins the durable writes between Send and the provider hearing the prompt, counted by fsync through `tests/fixtures/durableWrites.ts`: for Claude Code one write of `agents.json` and one synced line of `claude-origins.jsonl`, and for Codex on a running session one write each of `agents.json` and `codex-threads.json`. A new write in front of the prompt fails it with the file's name. Two more tests there hold every save of `codex-threads.json` open and check that a reply's frames, those behind the `turn/start` acknowledgement included, are still applied. The timings before and after, `sendWrites.perf.test.ts` and `usageStreamWrites.perf.test.ts`, need `SOTTO_PERF_BENCH=1` (`docs/perf/2026-10-06-send-writes.md`).

## Agents roster regression

`tests/unit/main/subagentStore.test.ts` compares the same 600 updates with small and large archives: three threads, 5,000 saved assignments and 20 live agents. Indexed read/write counts must match, no archive pages are read during updates, page reads remain bounded, and every result survives. `tests/unit/main/subagentWorkspace.test.ts` covers retention beyond the ordinary activity cap, restart evidence, coalesced changes, privacy and provider disconnection. Renderer tests in `tests/unit/renderer/subagents.test.tsx` cover stable row references, bounded live caches, hidden/disconnected clocks and paging races. Provider projector retention tests in `tests/unit/main/subagentRetention.test.ts` also verify 5,000 assignments without retaining archived prompt/result payloads in identity maps. These structural assertions run in the normal CI suite.

Run `npm run build && npx playwright test tests/e2e/subagents.spec.ts` for the real Electron roster journey, history, state changes and light/dark captures at the three desktop sizes. As with other UI journeys, it stays local. Run the existing opt-in queue-feedback and streaming heartbeat gates while verifying performance; their 100 ms and 250 ms limits are unchanged.

For the local HEAD/current startup, update and memory comparison, run `node tests/perf/subagents-bench.mjs` with `SOTTO_PERF_ASSERT=1`. See [the performance note](perf/issue-124-agents.md) for its workload, baseline revision, measurements and limits.

## Headless host foundations

`npm run test:host` runs the Node-only host lifecycle and credential checks, shared adapter contracts and HostService journeys with fake providers. The normal unit/integration gate includes these tests. The process test builds a temporary plain-Node entry and checks its import graph for Electron; it does not use the shipped Electron executable. On Windows its SIGTERM handler is exercised through an owned IPC signal fixture because Windows process termination cannot deliver a graceful POSIX SIGTERM. The separate Linux host job delivers a real SIGTERM to both the lifecycle fixture and the extracted archive smoke test.

`tests/e2e/host-identity.spec.ts` launches the real desktop with a legacy workspace, verifies durable host identity and raw persisted Sotto IDs, then checks host-scoped panes and a saved draft after restart. Run it with the daily-workspace and coordinator journeys when changing the host/client boundary.

## Linux host archive and socket contract

The **Host archive and socket contract (Linux)** job runs on `ubuntu-latest` with Node 24.22.1, read-only repository access and no provider credentials. It installs the locked dependencies without downloading Electron, then runs:

| Command | Evidence |
| --- | --- |
| `npm run test:socket` | The shared HostService contract through `SocketHostService` against a built Node child and all four scripted providers; pairing, the remote command allow-list, resolved thread permission defaults and client-policy revocation during dispatch, receipts and reconnect boundaries; protocol v1's detail deltas, and the version and features a client reads before it opens a session; headless startup and native SIGTERM; the SSH launcher over a fake ssh that asks its questions through the real askpass helper; the launch script, including the Node probe's POSIX shell, which only this job runs, and start at boot over fake `systemctl` and `loginctl`, where only this job runs the unit's `boot-start.sh` under `/bin/sh`, versions side by side included; that the host listener answers on loopback and on no other interface; hello, a command and a pushed event over Node's own global WebSocket, so the socket is proven against a client whose framing Sotto did not write; and the CLI lookup (ADR-0036), whose login-shell read, symbolic-link cases and mise journey (a host started with forge's PATH, `/usr/local/bin:/usr/bin:/bin` less any folder that holds Node, and a login shell that adds mise's shims and `~/.local/bin`, passes over a shim and a `mise x` wrapper that would run mise, finds a scripted Claude Code under mise's `installs/<tool>/latest`, runs it on mise's Node from the PATH it gives it, connects it on its own and creates a project) skip on Windows and run only here. |
| `npm run package:host` | A standalone Node build, reviewed external dependency closure, notices, runtime manifest, provenance and SHA256; extraction into a fresh directory, listener health and persisted identity after native SIGTERM. The smoke's data folder starts with every provider turned off (ADR-0036), so it starts no client installed on the machine running it. |
| `SOTTO_REAL_SSHD=1 npx vitest run tests/integration/realSshd.test.ts` | The SSH transport against a real OpenSSH server. The step before it installs openssh-server if the image lacks it. The test generates a host key and a passphrase-protected client key, starts its own sshd on a loopback port as the runner account, and drives `DesktopHosts` and the real launcher through the runner's ssh at `<user>@localhost`, against the host archive the previous step built, extracted into a fresh directory. Connect asks for the host key and the passphrase once each through the askpass helper, starts the host and pairs itself; the host's thread list and a command cross the forward; killing the forward reconnects after the first 3-second backoff step, to the same host and pairing; Disconnect leaves the host running; Stop host stops it; Forget revokes the pairing on the host and stops it, and nothing pairs again, even after the first backoff step has passed, nor does a further connect. With `SOTTO_REAL_SSHD_REQUIRED=1` in this dedicated step, or with `SOTTO_REAL_SSHD_INSTALL` set, the file fails instead of skipping when `SOTTO_REAL_SSHD=1` is missing, so a renamed variable cannot pass the step. |
| `npm run notices:verify` | The host's external and bundled dependency inventories are covered by the maintained notices. |

The job retains `Sotto-host-*-linux-x64.tar.gz` and its checksum sidecar as a workflow artifact for 14 days. It does not publish them. The archive contains zod and no native modules; a new dependency or native binary fails the packaging check until its runtime/release path is reviewed. The desktop's Windows node-pty installation is never copied into a Linux archive.

Run `npm run package:host` locally for the same extraction and startup check. The filename records the actual platform. `npm run host:verify -- <extracted-directory>` verifies an existing extracted archive against its manifest and provenance; `node scripts/smoke-host-archive.mjs <extracted-directory>` additionally starts and stops it. On Windows only, smoke shutdown exercises the signal handler through IPC, since Windows cannot deliver a graceful POSIX SIGTERM. The Linux CI run and a real Forge SSH connection remain separate evidence from a local Windows pass.

The host build and package scripts anchor their source and output paths to the
checkout that contains the script. Calling `node <checkout>/scripts/build-host.mjs`
or `node <checkout>/scripts/package-host.mjs` from another folder still writes to
that checkout's `out/host` and `release`. Packaging passes tar a relative archive
filename from `release`, so GNU tar cannot mistake a Windows drive letter for a
remote host. `tests/integration/hostBuildScripts.test.ts` runs both scripts from an
owned scratch folder and checks the archive round trip with local archive names.

The real OpenSSH journey is skipped unless `SOTTO_REAL_SSHD=1` is set, so the Windows gates and a plain `npm test` report it as skipped. To run it on a Linux or macOS machine with openssh-server and Node 24.22.1 or a later Node 24, use `SOTTO_REAL_SSHD=1 npx vitest run tests/integration/realSshd.test.ts --maxWorkers=1`. Without `SOTTO_REAL_SSHD_INSTALL` it builds and stages the host itself; `SOTTO_SSHD` names an sshd other than `/usr/sbin/sshd`. It uses its own keys, client configuration and known_hosts file and never touches the account's `~/.ssh`. It proves the transport on this machine's OpenSSH; Windows' own ssh.exe and a real remote host are still proved by hand.

## Browser provider and desktop verification

`tests/integration/browserProviders.test.ts` verifies thread-bound MCP injection and reconnection with scripted native clients. `browserAgentServer.test.ts` checks local transport admission and rejection; browser host and dispatcher tests check page grants, exact actions and observation redaction. These run in the normal two-worker suite.

The opt-in native discovery test starts the installed Codex, Claude Code and Grok clients and waits for their MCP tool catalog request. It sends no model turn and does not prove model-driven browser interaction:

```powershell
$env:SOTTO_BROWSER_LIVE = '1'
npx vitest run tests/integration/browserProvidersLive.test.ts --maxWorkers=1
```

The same file's turn cases send one paid model turn per client and mode, asking the agent to use a synthetic `browser_status` tool, and report whether the client asked its own permission before reaching it. Every native request is denied. They report only a request's kind, tool name and choice kinds, never a prompt, argument or reply. Three test-only switches exist to diagnose a client: `SOTTO_BROWSER_TURN_PROMPT` replaces the prompt, `SOTTO_GROK_ARGS` (a JSON array) launches Grok with other arguments, and `SOTTO_BROWSER_NO_ADMISSION=1` hides the tool names from the adapter, so only the client's own rules can let a call through.

```powershell
$env:SOTTO_BROWSER_TURN_LIVE = '1'
npx vitest run tests/integration/browserProvidersLive.test.ts --maxWorkers=1
```

`tests/integration/codexComputerUseLive.test.ts` sends one paid Codex turn per case, asking only for the list of open apps with Computer Use, and reports the requests that arrive and which known outcome each Computer Use call ended in, never its text. `SOTTO_CODEX_COMPUTER_USE_PROMPT` replaces the prompt and `SOTTO_CODEX_EXECUTABLE` runs another Codex build. Its Full access case needs the Codex desktop app open. Results so far are in `docs/verification/2026-09-25-browser-prompts-and-computer-use.md`.

```powershell
$env:SOTTO_CODEX_COMPUTER_USE_LIVE = '1'
npx vitest run tests/integration/codexComputerUseLive.test.ts --maxWorkers=1
```

Build and run `npx playwright test tests/e2e/agent-browser.spec.ts tests/e2e/tools-sidecar.spec.ts tests/e2e/native-tool-ownership.spec.ts` to exercise the real Electron browser, permission continuation, feedback drafts and the Tools pane. The agent test uses a local page and test-only provider entry point; it needs no provider account. Screenshots and a geometry report are written to ignored `artifacts/e2e-runs/agent-browser/` by default. Native-provider compatibility and actual desktop results are recorded separately in `docs/verification/`.

## Manual Windows desktop check

After `npm ci`, run `npm run test:desktop-smoke` from the release checkout on an interactive Windows desktop. This is an explicit prerequisite in the [release procedure](release/releasing.md), and can also be run manually while developing. CI also runs this command in Desktop check (Windows), reported through the required Desktop result.

The command runs `test:recovery`, which checks focused real application boundaries, builds once and drives receipt, queued-steering and completed-dictation recovery. It then uses that same build for both daily-workspace cases and the Settings index journey. The daily check drives actual keyboard input through a Windows shell, verifies the changed file, reads its diff, commits and pushes only to an owned temporary bare repository; its GitHub client is scripted. The restart case checks drafts and queues, while Settings checks real saves, failure feedback, keyboard navigation, themes and persistence.

Electron journeys run serially with one worker. Do not run another Electron journey on the same desktop concurrently. The wrapper refuses other platforms, clears live-provider and timing-benchmark flags and any alternate Electron entry point, and supplies a verified absent owned performance-data path. Fixtures create and remove only their owned temporary profiles. `SOTTO_E2E_ARTIFACT_ROOT` routes the selected journeys' screenshots and proof files into ignored `artifacts/review-393/desktop-run/`, each in its own named subdirectory using its path relative to `artifacts/`; the runner does not modify or restore committed captures. The wrapper's selected specs use single-segment names, so their layout stays the same. Standalone spec runs use ignored `artifacts/e2e-runs/` by default; `SOTTO_E2E_EVIDENCE=publish` deliberately refreshes their historical evidence folders. Inspect the emitted screenshots after a UI change and keep only selected evidence. A failed stage stops the command and blocks the release check; investigate its assertion before rerunning. Record the source commit, actual test counts and platform in the release evidence. A local Windows pass does not establish macOS execution.

## Recovery through application boundaries

`npm run test:recovery` is the compact recovery check (#395). It runs fifteen focused test files with two Vitest workers, builds the app, then runs the dictation recovery, command receipt and queued steering journeys in one Electron worker. Run it from an installed checkout on the desktop being verified, with no other Electron journey running. Every case uses isolated temporary storage and scripted effects; it needs no provider account or paid turn and does not regenerate design baselines.

| Boundary | Assertions |
| --- | --- |
| Coordinator → workspace → provider | Held and uncertain sends remain stoppable; the original durable intent is neither replaced nor replayed; rejected Stop releases its lane. |
| Fresh coordinator and workspace over the same disk | An uncertain send survives reopening; unrelated identical words do not reconcile it; only the exact late provider receipt settles it, without another send. |
| Workspace → event store | Failed writes retain events and activity, retry in order, survive reopening, respect history off, and drain before shutdown. |
| Renderer → controller → output | Actual completed text survives navigation and later dictation after clipboard failure; Copy retries neither transcribe nor paste; ordinary paste refusal keeps its existing fallback. |
| Real Electron renderer and preload | Receipt feedback, queued steering and selectable dictation recovery use the built app and test-only provider or clipboard effects. |

This command complements the full suite. Its fake provider boundary proves Sotto's recovery contract, not a paid provider's availability. The broader repeatable desktop workflow is tracked separately in #393.

## Grok request-log observations

`tests/integration/grokFixtureReadErrors.test.ts` requires the fake Grok request and violation observers to distinguish absent initial logs from unreadable logs. A known start remains a known start after a temporary fault is removed; EACCES and EBUSY surface as read errors, while malformed JSON remains a parse error. An unreadable violation log cannot silently pass its protocol check. The fixture does not turn these failures into missing provider work or evidence (#420).

## Stale host-lock test processes

`hostLock.test.ts` waits for its synthetic holder process to exit, then fixes only that PID's zero-signal liveness probe to `ESRCH` for the test. Windows may reuse a PID during repeated acquisition rounds; a newly live PID would correctly make every contender refuse the supposedly crashed lease. Other PID/signal probes still use the real process API. Filesystem contention, exact single-owner and winner-lock checks, cleanup, live-owner refusals and the separate `ESRCH`/`EPERM` policy tests remain real and unchanged (#406). No production lock rule or deadline is relaxed.

## Fake Claude event timestamps

`tests/integration/claudeFixtureTimestamp.test.ts` runs the scripted Claude child and compares live messages with its saved transcript. Completion, persisted raw frames, bursts and user echoes must carry the same event timestamp on both paths; explicit timestamps remain unchanged. The regression fails deterministically on the earlier fixture because its live replies omit timestamps. The former `personalChatProviders.test.ts` also checked full history equality across restart; it was retired with standalone Chats. The fixture supplies consistent events rather than relaxing the timestamp assertion.
## Workflow assignment detail readiness

The workflow journey in `tests/unit/renderer/subagents.test.tsx` holds the first assignment response until it has checked the pending view. The summary and fallback both show the workflow description during that interval; only the full task response removes the fallback. The test scopes pending assertions to each location, releases the response explicitly, and checks the loaded detail before requiring a unique description. It also retains the existing Escape and return-focus journey. Back-button focus is not proof that asynchronous assignment detail has loaded (#402).
## iPhone app to TestFlight

`.github/workflows/ios-testflight.yml` is the one workflow that publishes, and one of two that sign (ADR-0032); the other is Sotto Owl for Mac, below. It runs only when a tag named `ios-testflight-*` is pushed, or by hand, never for a pull request. On `macos-26` with Xcode 26.6 it runs the SottoCore tests, then `apps/ios/Scripts/testflight.sh` archives the app unsigned, then exports it signed with the team's cloud-managed distribution certificate and uploads it to App Store Connect. Its four secrets (`APP_STORE_CONNECT_KEY`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APPLE_TEAM_ID`) belong to the `testflight` environment, which only this job names and which accepts only `ios-testflight-*` tags; the key file exists only for the job. Setup is in `apps/ios/README.md`. It is not a gate: a failed upload blocks nothing.

## Main freeze nightly

`.github/workflows/main-freeze.yml` (**Main freeze**) runs every night at 07:00 UTC on `main`, and when started by hand from the Actions tab. On `windows-latest` with Node 24.22.1 and the long temporary path, it runs `npm ci`, `npm run build` and `npx playwright test tests/e2e/main-freeze.spec.ts` with `SOTTO_PERF_BENCH=1` and `SOTTO_PERF_ASSERT=1`, the switch every stopwatch budget takes. The spec builds the owner's history in the app (`tests/fixtures/ownerScale.ts`): about 250 threads on this computer with provider sessions, a Watcher record with a current Watcher, 5 standing watches on the threads that stream, 160 requests and 150 operations, so Watcher's wake-up pass runs through the timed cases, 256 answer retirements and a paired headless host with 40 threads. It fails when main's longest stall or its count of stalls of 100 ms or more passes `FREEZE_LIMITS` in the spec, while nothing, one or three threads stream, and when the window drew fewer than 5 frames a second in a case, which means it was not on screen and its keystroke times would measure Chromium's throttling. Run by hand without `SOTTO_PERF_ASSERT=1`, such a case prints `"valid": false` and why instead of failing. It keeps `test-results/` for 14 days. It is a timing backstop on real Electron, never a pull request's gate: pull requests meet the counting gate, `ownerScaleWorkBudget.perf.test.ts`, in the default suite. A red nightly run is fixed like a red gate on `main`: count the work per update with the gate, then profile main. The limits only tighten. On a Windows development machine the workflow stays unverified until GitHub runs it.

## Sotto Owl for Mac

`.github/workflows/owl-mac.yml` builds the Apple silicon half of a Sotto Owl. The release lead starts it by hand with the Windows Owl's version and full source commit; it never runs for a push or a pull request. It checks both inputs before anything reads them, fetches the history of the branch it was started from, refuses a source commit outside that history, checks out that commit on `macos-26` with Node 24.22.1, runs `npm ci`, downloads Electron with `node node_modules/electron/install.js` (Electron 43 has no install script, and the Mac build copies Electron's licence files from `node_modules/electron/dist`) and runs `npm run package:owl -- --version <version> --source <commit>`, which refuses a checkout that is not clean and at that commit or a version that is not this manifest's next Owl. It then attests the disk image and zip with `actions/attest-build-provenance` and keeps every file the packaging receipt `release/owl-mac-package.json` lists, with the receipt, as the artifact `sotto-owl-mac-<version>` for 14 days. It publishes nothing: `npm run release:owl -- --mac-artifacts <folder>` verifies the downloaded files against the Windows Owl and prints the commands that attach them (the procedure is in [the release guide](release/releasing.md)). It is not a gate, and on a Windows development machine it stays unverified until GitHub runs it.

The job signs, notarizes and staples the app (ADR-0093, Stage 2). Its five secrets (`MAC_DEVELOPER_ID_P12`, `MAC_DEVELOPER_ID_P12_PASSWORD`, `APPLE_NOTARY_KEY_P8`, `APPLE_NOTARY_KEY_ID`, `APPLE_NOTARY_ISSUER_ID`) belong to the `owl-mac` environment, which only this job names and which allows only `main`. GitHub admits a run to the environment by the branch it was started from, not the commit it builds, so the source-history check is what keeps the certificate off unmerged code. Setup is in [`macos-owl-signing.md`](release/macos-owl-signing.md). Its first step fails, naming what is missing, when a secret is absent. After `npm ci` and the Electron download, it imports the certificate into a temporary keychain under the runner's temporary folder and writes the App Store Connect key beside it; a step that always runs deletes both once packaging ends. Secrets reach scripts only through a step's environment. `package:owl` then checks `codesign --verify --deep --strict`, the Developer ID authority and hardened runtime, `spctl` accepting the app as a Notarized Developer ID, and the stapled ticket, and the receipt records them. `tests/unit/release/owlMacWorkflow.test.mjs` holds the workflow to that order and to its five secrets. `release:owl` also checks that `owl-mac.yml` names the zip and disk image by their own bytes, not only by the receipt.

`.github/workflows/stable-mac.yml` builds the Apple silicon half of a stable release (ADR-0096). The release lead starts it by hand with the stable version and the full main commit the Windows release ships; it never runs for a push or a pull request. It checks both inputs, checks out that commit with full history on `macos-26` with Node 24.22.1, confirms HEAD is that commit, runs `npm ci`, downloads Electron and runs `npm run package:mac -- --version <version>`, the hand path's command: `release:check` refuses a dirty checkout, a commit outside `origin/main`, missing or failed Gates (Windows) and Package result checks, and a version no newer than the newest published stable. Only that step gets the job's read-only token, as `SOTTO_RELEASE_CHECK_TOKEN`, to lift the public rate limit on those reads; the job reads `checks` for that and no secrets. It checks the receipt `release/mac-desktop-package.json` and `release/stable-promotion.json` describe the requested build, and keeps the disk image and blockmap with the receipt, the release check, the Owl feature answers and screenshot and `SHA256SUMS-mac.txt` as the artifact `sotto-stable-mac-<version>` for 14 days. A second job, the only one with write scopes, downloads that artifact and attests the disk image and blockmap with `actions/attest-build-provenance`. It publishes nothing; the procedure is in [the release guide](release/releasing.md). It is not a gate, and it stays unverified until GitHub first runs it.

## Sotto Owl for Linux

`.github/workflows/owl-linux.yml` builds the Linux half of a Sotto Owl (ADR-0099). The release lead starts it by hand with the Windows Owl's version and full source commit; it never runs for a push or a pull request. It reads no secrets and names no environment. Its first job, on `ubuntu-24.04`, checks both inputs, fetches the history of the branch it was started from, refuses a source commit outside that history before anything from the checkout runs, checks out that commit with Node 24.22.1, runs `npm ci`, downloads Electron, installs Xvfb and the libraries Electron loads, and lets unprivileged programs make user namespaces on the runner, so the app's launch checks run with Chromium's own sandbox, as on Arch, rather than with `--no-sandbox`. It then runs `xvfb-run -a npm run package:owl -- --version <version> --source <commit>`, which refuses a checkout that is not clean and at that commit or a version that is not this manifest's next Owl, builds and checks the x64 tarball, and writes `release/owl-linux-package.json`.

The second job runs in a pinned `archlinux:base-devel` container, brought up to date first. It repeats the input and source-history checks, runs `npm ci --ignore-scripts` for the asar reader the checks use, installs the recipe's dependencies, and runs `scripts/package-owl-linux-pacman.mjs` as an ordinary user, because `makepkg` refuses root. That runs pacman's `vercmp` on every ordering the Owl's package version needs, builds `sotto-bin` from the checked tarball and runs stable's package checks without the Hyprland launch, and keeps the tarball, package, `PKGBUILD`, `.SRCINFO` and both receipts as the artifact `sotto-owl-linux-<version>` for 14 days. A third job, the only one with write scopes and the only one that runs nothing from the checkout, attests the tarball and the package with `actions/attest-build-provenance`. It publishes nothing: `npm run release:owl -- --linux-artifacts <folder>` verifies the downloaded files against the Windows Owl and prints the commands that attach them. `tests/unit/release/owlLinuxWorkflow.test.mjs` holds the workflow to that shape. It is not a gate, and it stays unverified until GitHub first runs it.

## Native iOS gate

**Native iOS client (macOS)** runs `sh apps/ios/Scripts/verify.sh` on `macos-26`, selecting `/Applications/Xcode_26.6.app/Contents/Developer` explicitly: the same Xcode as the TestFlight workflow, because App Store Connect refuses a build made with an SDK older than iOS 26, and a gate on an older Xcode would pass code the upload cannot build. [The runner inventory](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md) lists that toolchain and its iOS 26 SDKs, which satisfy the package's Swift 5.9 tools and app's iOS 17 minimum. The job prints its actual Xcode/Swift versions, runs the native SottoCore and app-model package tests, builds the unsigned iOS simulator app, and runs `sh apps/ios/Scripts/verify-ui.sh` with the shared Xcode scheme. It needs no signing secrets, never uploads to TestFlight, and does not run npm or Electron.

Changed areas decides when it runs: changes under `apps/ios`, to the host protocol or to this workflow, on a pull request or a push to `main`, and every weekly run. On macOS the package also compiles the actual `AppModel.swift` against scripted storage and transport: failed thread reads preserve the computer connection, and observation does not download a conversation twice. A separate package target compiles the actual `HostConnection.swift` against scripted HTTP responses, covering ready health validation and connection error messages. Core tests cover incremental updates and settlement. `SOTTO_PERF_ASSERT=1 swift test --package-path apps/ios --filter ThreadPerformanceTests` enables the optional list responsiveness budget; ordinary CI does not assert elapsed time. The package tests and build establish native behavior under scripted transport and compilation. The Focus journeys below separately exercise simulator interaction; neither establishes hands-on VoiceOver, real-device networking, signing or Forge availability. Design inspection requires reading the retained screenshots. On a Windows-only development machine this job's result remains unverified until GitHub actually runs it; adding the job is not a green CI result. It is not a required check until it has been green once.

## Current-session reaper observations

The Claude fixture's stopped check reads its current child ownership marker and probes that PID. Grok records residency after an accepted load or close; a historical or rejected close is not evidence that its current session stopped. `sessionFixtureObservation.test.ts` covers a real resumed Claude child and a Grok close/reload, including a rejected close. The host contracts keep their existing deadlines and assert actual session ownership rather than elapsed time.

The adapter and HostService contracts receive static skip reasons from each fixture. Known fixture features are checked before any fixture is constructed or connected, including session drivers, live settings, event publication, background work, confirmation loss and client updates. The adapter's thread-settings result cases still wait for the connected provider's configuration capability and advertised model modes to decide whether an alternative setting exists.

## Grok idle history maintenance

`grokIdleMaintenance.test.ts` holds real fake-provider history reads against a controlled clock. Repeated empty polls must not renew idle age, and the first sweep after a read settles must use the existing age. Separate cases check actual durable-only provider events and foreground refreshes. `sessionReaper.test.ts` protects reads without blocking another eligible session and rechecks activity, watched state and working state after settlement. These are structural checks with no new deadlines or stopwatch assertions (#440).


### Focus simulator journeys

`apps/ios/Tests/SottoUITests/FocusJourneyTests.swift` launches the real SwiftUI app with a Debug-only in-memory host fixture. It checks the default Threads tab, foreground and background work, a recent thread marked as finished and not opened, search including settled threads, search's keyboard closing on a tap outside it and on scrolling, collapsed/expanded Settled, conversation and question navigation, and persisted appearance and text size. For the Glow look (ADR-0051) it also checks that the thread page opens at the end of the conversation and stays there while the reply keyboard opens and after a question is answered, never jumping to the top when the keyboard closes; that a review reply reads as Markdown blocks with no asterisks or table pipes left over, a narrow table as a grid and a wide one as a card per row; the branch, changes and pull request chips; that New thread's fields open from the edge of their box and New worktree can be chosen; and the theme, light, density and text size settings, with every alert off until turned on. Each run of the agent's steps folds into one line that opens in place and folds again, and with `--ui-long-thread` and `--ui-slow-detail` a long thread whose messages arrive a moment after it opens shows its end with no scroll. With `--ui-reconnecting` the laptop loses its connection a moment after a thread opens, and the thread stays on screen under Reconnecting to Laptop rather than going back to Reading this thread. With `--ui-watcher` the laptop runs Watcher (ADR-0073, amended October 11, 2026): the journeys check that the Watcher tab sits between Threads and Computers and that VoiceOver reads its working dot and its badge, open it, send Watcher a message and see its answer arrive, open a thread from a row of what Watcher did and find the provider's logo, the owl and the takeover line there, answer a worker's own card inside Watcher's page (`--ui-watcher-can-answer`), read that page on a phone without Can answer with Watcher's own request waiting (`--ui-watcher-asks`), and see Stop all ask first, stop nothing when cancelled and stop only the threads Watcher started when confirmed. They also change Watcher's permissions from the chip over its box, with Can answer and without it, open the files of a reply in which Watcher changed files itself, with its reason and without one (`--ui-watcher-no-reason`), and watch a thread from its page, take it back with Undo, stop watching it on Watched and watch it again from Watch a thread. Without `--ui-watcher` there is no Watcher tab. Each of those journeys keeps a `watcher-*` screenshot in dark and in light. The fixture returns before Keychain reads or any connection and refuses pairing, rename, removal, and transport actions; with `--ui-question-while-reading` the laptop lets the phone answer, and an answer only takes its request out of the in-memory thread. Release builds contain no fixture entry point.

Run `sh apps/ios/Scripts/verify-ui.sh` on a Mac with Xcode selected. The script creates disposable iPhone SE (3rd generation) and iPhone 16 Pro Max simulators using the latest installed iOS runtime, then deletes only those simulators. Before the journeys on each phone it installs the app `verify.sh` built and launches it once with the fixture, because a freshly booted simulator's first launch twice outlasted XCTest's launch deadline and failed whichever journey ran first; it says so if that warm-up fails. The large phone also has the simulator's Reduce Motion preference enabled and accessibility-large text. Kept XCTest screenshot attachments cover dark, light, another theme, larger text, compact density, the keyboard, a request, the thread page at its end, at its top and with the reply keyboard open, the question sheet and the page after an answer, New thread's menus, Settings, Computers, and recovery feedback; the Glow journeys' images are named `threads-glow-*`, `thread-glow-*`, `question-glow-*`, `settings-glow-*`, `new-thread-glow-*` and `computers-glow*`, and the Watcher journeys' `watcher-*`. CI retains both result bundles and exported attachments as `ios-focus-journeys` for 14 days, including failures. The job has a 140-minute safety timeout. It was raised from 45 to 75 when the Glow look took the journeys from seven to twelve, to 110 when they took 67 minutes on a push to `main` and [run 38318858359](https://github.com/millZach/Sotto/actions/runs/38318858359) reached 75 while still passing them, and to 140 when twenty-five journeys took 106 minutes on a push to `main` ([run 38512275242](https://github.com/millZach/Sotto/actions/runs/38512275242)) and Watcher's permissions, own changes and watching took them to twenty-eight. Eleven CPU journeys skip unless asked for. [Run 36782409656](https://github.com/millZach/Sotto/actions/runs/36782409656) passed the native package tests and all four journeys on each phone, then exceeded the former 35-minute limit while completing the job. The larger window covers simulator startup, real interaction and evidence retention; test assertions and their deadlines are unchanged. These checks exercise native layout and navigation against fixture data; they do not establish live-host or physical-device compatibility. Inspect the exported images before calling the design verified.


## Native test launch

The Sotto scheme runs its Test action without attaching LLDB. Two consecutive macOS CI attempts stalled at `XCUIApplication.launch()` on the large simulator while Xcode reported `DebuggerVersionStore.StoreError` and no debugger version; subsequent tests in the same app could run. The process launcher removes that debugger dependency from unattended tests. The normal Run action retains LLDB for interactive debugging. No UI tests, assertions, device sizes, accessibility settings or timeouts are skipped or shortened. The macOS gate remains the end-to-end check of this launch configuration.

The existing socket gate also runs `watcherPhone.test.ts`: opt-in v1 phone projections, stable/desktop listener feature absence, explicit phone-origin admission, exact user card answers, takeover and Stop all confirmation. Swift Watcher wire cases belong to the Native iOS gate; Android core decoding remains outside npm.
