# Test suite cleanup (#123)

Issue #123 asked for renames, four file splits, shared fixture setup, explained skips and e2e runs that leave committed evidence alone. A fresh audit of all of `tests/` on October 8, at main `c53d2908c`, found that the suite had grown well past the issue's description. These are the findings and how the work is cut.

## Baseline

`npm test -- --maxWorkers=2` on the Windows development laptop:

- 2,705 s wall time
- 657 files, 9,099 cases: 8,905 passed, 185 skipped, 9 failed

The nine failures are Git-heavy cases that ran out their deadline under load; #860 tracks them. CI's Windows gate was green on the same commit, and the whole gate took 21 minutes there.

The issue was filed against roughly 290 files and 3,650 cases. Its three "Also seen" items have since been fixed: the `design-capture` `ReferenceError`, the 16 px prompt expectation, and `personalChats.test.ts`, which no longer exists.

## What the audit found

- **Names.** Sixteen e2e specs and four integration files or fixtures are named after a build phase. Two fixture strings still say "Talk to Text Application"; `migrateLegacyUserData.test.ts` keeps its `TalkType` literal on purpose, because it tests that migration.
- **Size.** Twenty files are over about 800 lines, not four:
  - integration: `ipc`, `socketHost`, `desktopHosts`, `answerCheckValidation`, `adapterContract.ts`
  - unit/main: `windowManager`, `workspace`, `agentControlRecovery`, `requestDrafts`, `threadWorktrees`, `socketHostService`
  - renderer: `settingsView`, `widgetApp`, `dictationController`, `hostsSettings`, `app`, `threadsView`, `audioRecorder`, `threadOptions`
  - e2e: `design-capture`
- **Placement.**
  - Four files in `tests/unit/main/` test `src/host/`.
  - About fifteen unit files start real Git repositories, child processes or listeners, which `AGENTS.md` puts under `tests/integration/`.
  - Four support modules sit among the renderer tests.
  - Three files sit loose in `tests/unit/`.
  - `ipc.test.ts` held unit tests for the permission policy, startup, tray, bootstrap and native runtime; those cases now live in `tests/unit/main/app/permissionPolicy.test.ts`, `tests/unit/main/startupServiceIdempotence.test.ts`, `tests/unit/main/tray/trayController.test.ts`, `tests/unit/main/app/bootstrap.test.ts`, `tests/unit/main/app/nativeRuntime.test.ts`.
- **Duplicated setup.** The biggest copies:
  - coordinator construction: about 30 files
  - `AgentState` builders: about 20, plus nine partial casts
  - deferred promises: about 25
  - fake credential encryption
  - real Git repository seeds
  - IPC registries
  - the preload Electron mock
  - host, tools and cloud iPhone bridges
  - e2e window, profile and capture helpers
- **Skips.** There is no abandoned `it.skip` or `todo` anywhere. Every gate waits on a platform, a capability, a live provider or a benchmark switch. A few hide their reason, and `adapterContract.ts` starts a fixture before it knows it will skip; its host-service cases now live in `tests/integration/hostServiceContract.ts`.
- **Evidence writes.** About 90 e2e specs write into `artifacts/`. Only six route through `tests/fixtures/evidence.ts`, and that helper defaults to the committed folder. Four native integration probes also write committed evidence directly.

The audit also found problems outside #123's rule that cases and assertions stay as they are. These are filed separately: #860 to #865.

## How the work is cut

Four pull requests on `chore/test-suite-cleanup`. Each says "Part of #123" and passes CI's gates on its own; the fourth closes the issue. None of them changes what a case asserts, shortens a deadline, or thins voice, wake, speech or memory coverage (ADR-0012, ADR-0013). `SOTTO_*_LIVE` gates and `SOTTO_PERF_ASSERT` budgets stay as they are.

### 1. Moves, renames and where e2e evidence goes

- Rename the phase-named specs, integration tests and fixtures by behaviour. Update every citation: `docs/verification/`, `docs/ci.md`, `package.json` scripts, other tests and comments.
- Remove the orphaned `tests/fixtures/phaseTwoReview/` harness, which nothing outside itself uses.
- Move whole files to the area they test:
  - `src/host` tests go to `tests/unit/host/`.
  - Whole-file process and Git suites go to `tests/integration/`.
  - The loose unit files go to `shared/`, `release/` and `scripts/`.
  - The renderer support modules go to `tests/fixtures/renderer/`.
  - Fixture-helper tests go to `tests/unit/fixtures/`.
- Replace the two "Talk to Text Application" fixture strings and the phase wording in comments.
- E2e evidence goes to an ignored run folder by default. Committed evidence is refreshed only on request. Route every spec and native probe through `tests/fixtures/evidence.ts`.
- `hostBuildScripts.test.ts` scratch output moves to the system temp folder.

### 2. Split the oversized files

Split each of the twenty files by surface, so a reader can find the case that covers a change:

- Move whole describe blocks or contiguous case groups. Keep every case, parameter row and deadline.
- Extract the shared harness a split needs, such as the window manager harness or the `agentControlRecovery` fixture, into `tests/fixtures/`, rather than copying it into each new file.
- Move the partial process and Git cases out of mixed unit files into integration.
- The IPC unit describes move into mirrored paths: `tests/unit/main/app/permissionPolicy.test.ts`, `tests/unit/main/startupServiceIdempotence.test.ts`, `tests/unit/main/tray/trayController.test.ts`, `tests/unit/main/app/bootstrap.test.ts`, `tests/unit/main/app/nativeRuntime.test.ts`.
- The `design-capture` split keeps full-matrix validation in one place.
- `package.json`'s `test:recovery`, `test:host` and `test:socket` lists name every new file their old file's cases moved into.

### 3. Share fixture setup

Add shared modules under `tests/fixtures/` and replace the copies:

- `deferred`
- `agentState`, generalising the existing `threadsStateFixture`
- an agent control fixture extending `manualSendCoordinator`
- test credentials
- an owned Git repository
- an IPC registry
- the preload Electron mock
- host, tools and cloud iPhone bridge builders
- e2e window, profile and capture helpers

Each case still gets fresh state; no mutable coordinator, repository or app is shared between cases. Measure whether a Git seed made once and copied into each case saves time, and keep it only if it does.

### 4. Skips, environments and the record

- Every skip shows its reason.
- `tests/integration/adapterContract.ts` and `tests/integration/hostServiceContract.ts` decide a capability skip before starting the fixture.
- Pure tests that inherit jsdom get the node environment header.
- The eight e2e specs that leave their profile behind remove it after the whole journey.
- The rich-message launch helper cleans up when the launch fails.
- `docs/ci.md` records the new baseline next to the old one.
- The PR reports wall time before and after, and closes #123.

## Not in this work

#860 to #865, #351, #803 and #798 each own their fixes. A case they cover moves with its file here, unchanged.
