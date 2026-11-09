# Deferred code-health CI repair receipt

PR: [#2367](https://github.com/millZach/Sotto/pull/2367).
Classification follows [Reading a failure](../ci.md#reading-a-failure).

## Failed run

- PR head: `c5d9c4091ed3d813294656db377ff3861d8ab2ab`.
- Tested merge: `e6bf132d24b4c180ee230a24085368c3e274055e`.
- Base: `ba255fa89be411d0cd3c1159c85b83516cf5fab5`.
- [Run 42713377706, attempt 1](https://github.com/millZach/Sotto/actions/runs/42713377706/attempts/1) completed with failure.
- Windows Server 2025, image `windows-2025-vs2026`, image version `20261103.298.1`, Node `24.22.1`.
- Each Windows shard ran `npm test -- --maxWorkers=2 --shard=N/6 --reporter=verbose`.
- Logs were read from the individual job endpoints, including while the run was still active.

| Shard | Job | Failed / passed / skipped assertions |
| --- | --- | --- |
| 1 | [129488698207](https://github.com/millZach/Sotto/actions/runs/42713377706/job/129488698207) | 1 / 3403 / 79 |
| 2 | [129488698267](https://github.com/millZach/Sotto/actions/runs/42713377706/job/129488698267) | 4 / 3529 / 59 |
| 3 | [129488697926](https://github.com/millZach/Sotto/actions/runs/42713377706/job/129488697926) | 1 / 3306 / 110 |
| 4 | [129488697803](https://github.com/millZach/Sotto/actions/runs/42713377706/job/129488697803) | 2 / 3289 / 45 |
| 5 | [129488698077](https://github.com/millZach/Sotto/actions/runs/42713377706/job/129488698077) | 0 / 3155 / 70 |
| 6 | [129488698242](https://github.com/millZach/Sotto/actions/runs/42713377706/job/129488698242) | 1 / 3432 / 70 |

Checks and desktop (Windows), Desktop result, Package result and Linux result passed. Gates (Windows) failed because of the five failing test shards. No failed job was rerun.

## Assertion receipts

### 1. Stop pauses a later wake-up

- Failure: `tests/unit/main/delegationNewsHidden.test.ts:139`, **goes past a machine Stop's fence, pausing the user's held prompts first so they wait for the user's Resume**.
- Diagnostic: the user's synthetic prompt was paused as expected, but the later `wake-up` was also `paused` instead of `queued`.
- Classification: **own-diff**. The PR's new `runFollowup` lifecycle helper deferred `work` through `Promise.resolve().then(work)`. `FollowupStore` registers mutations synchronously in its serialized queue. That extra microtask let later news enter the queue before the earlier Stop pause, so the pause covered the new wake-up too.
- Proof: [failed job](https://github.com/millZach/Sotto/actions/runs/42713377706/job/129488698207); [corrective diff 154df7718](https://github.com/millZach/Sotto/commit/154df7718ea4869e9f5416235c9c0a0f5acded4a). The exact assertion reproduced locally before the change.
- Action: invoke `work()` immediately while retaining the lifecycle helper's existing `await`, lock and finalization. The original assertion and deadlines are unchanged.
- Result: all **14** tests in the unit file passed locally after the repair. Independent source review found no actionable defect. Windows confirmation awaits the corrective run.

### 2. Completed turn event is absent

- Failure: `tests/integration/productEventsThreads.test.ts:40`, **product events on the update path > sends one turn.completed that passes its schema, however many updates the turn had**.
- Diagnostic: expected one event; received zero.
- Classification: **own-diff**. The PR replaced elapsed-time waits with a fixture drain that flushed the adapter and immediately drained attribution work. Workspace still coalesces publication for 16 ms, so the coordinator had not received the turn state when the drain returned.
- Proof: [failed job](https://github.com/millZach/Sotto/actions/runs/42713377706/job/129488698267); [corrective diff 1d04cada6](https://github.com/millZach/Sotto/commit/1d04cada61755ff7bc227d68c8dc63591bd9e66b).
- Action / result: the fixture subscribes before flushing, awaits Workspace publication, then drains attribution. All 15 callers await it. The assertion remains unchanged. Source review and Node-test typecheck passed; the integration test was not run locally. Windows confirmation awaits the corrective run.

### 3. Stopped and failed turn events are absent

- Failure: `tests/integration/productEventsThreads.test.ts:56`, **product events on the update path > says a stopped turn stopped and a failed one failed**.
- Diagnostic: expected `['stopped', 'failed']`; received `[]`.
- Classification: **own-diff**, for the Workspace-publication ordering in receipt 2. Running and terminal states could collapse before the coordinator observed either transition.
- Proof: [failed job](https://github.com/millZach/Sotto/actions/runs/42713377706/job/129488698267); [corrective diff 1d04cada6](https://github.com/millZach/Sotto/commit/1d04cada61755ff7bc227d68c8dc63591bd9e66b).
- Action / result: await publication and attribution after each transition. The assertion remains unchanged; the same validation and pending Windows check as receipt 2 apply.

### 4. First thread-start event is absent

- Failure: `tests/integration/productEventsThreads.test.ts:75`, **product events on the update path > sends thread.started once when a thread made through the coordinator begins its first turn, and not before**.
- Diagnostic: expected one event; received zero.
- Classification: **own-diff**, for the Workspace-publication ordering in receipt 2.
- Proof: [failed job](https://github.com/millZach/Sotto/actions/runs/42713377706/job/129488698267); [corrective diff 1d04cada6](https://github.com/millZach/Sotto/commit/1d04cada61755ff7bc227d68c8dc63591bd9e66b).
- Action / result: await the actual first-turn publication before inspecting its event. The assertion remains unchanged; the same validation and pending Windows check as receipt 2 apply.

### 5. Thread-start attribution reads a missing event

- Failure: `tests/integration/productEventsThreads.test.ts:90`, **product events on the update path > says who started a thread, and says the feature is in use**.
- Diagnostic: `TypeError: Cannot read properties of undefined (reading 'properties')` at `sent[0]`.
- Classification: **own-diff**, for the Workspace-publication ordering in receipt 2. No start event existed when the fixture read its attribution.
- Proof: [failed job](https://github.com/millZach/Sotto/actions/runs/42713377706/job/129488698267); [corrective diff 1d04cada6](https://github.com/millZach/Sotto/commit/1d04cada61755ff7bc227d68c8dc63591bd9e66b).
- Action / result: await publication and drain attribution before reading or clearing recorded events. The assertion remains unchanged; the same validation and pending Windows check as receipt 2 apply.

### 6. Omitted swarm results lose their working status

- Failure: `tests/unit/main/delegationEnds.test.ts:594`, **delivers 52 angle results with an explicit count of any omitted results**.
- Diagnostic: expected saved `told` to be `working` for the omitted entries; received `unknown`.
- Classification: **own-diff**. The PR now requires positive delivery evidence. The swarm fixture simulated a successful send but returned only a host snapshot. Its missing receipt therefore became unconfirmed delivery. Completion updated the first 50 entries, leaving the two omitted entries `unknown`.
- Proof: [failed job](https://github.com/millZach/Sotto/actions/runs/42713377706/job/129488697926); [corrective diff b5141ed70](https://github.com/millZach/Sotto/commit/b5141ed70bfd4b719db927a6c6e5f8dc4820c53a). The exact assertion reproduced locally before the change.
- Action: return a matching thread-and-draft `deliveredDrafts` receipt from the fixture's successful send branch. Production uncertainty handling and the assertion are unchanged.
- Result: all **44** tests in the unit file passed locally after the repair. Windows confirmation awaits the corrective run.

### 7. Personal dictionary includes a startup render

- Failure: `tests/unit/renderer/features/settings/settingsDictionary.test.tsx:235`, **Settings draft editing work > does no extra render or request while editing 'Personal dictionary'**.
- Diagnostic: expected five renders for five edits; received six.
- Classification: **own-diff**. PR commit `d6244a246` moved microphone state out of `SettingsView`. The parent no longer rerendered during microphone enumeration, leaving an initial same-value draft update to settle with the first measured edit. The test's empty asynchronous `act` did not perform the parent render it had implicitly relied on.
- Proof: [failed job](https://github.com/millZach/Sotto/actions/runs/42713377706/job/129488697803); [corrective diff bc96ce3db](https://github.com/millZach/Sotto/commit/bc96ce3dbb42a56cb182aa6276d023577a15e8b8). The worker reproduced six renders before the repair and five after it.
- Action: rerender the same mounted tree inside the setup `act` before capturing the render count. No production change, budget change, delay or assertion change.
- Result: all **18** tests in the unit file passed locally after the repair. Windows confirmation awaits the corrective run.

### 8. Paste delay includes a startup render

- Failure: `tests/unit/renderer/features/settings/settingsDictionary.test.tsx:235`, **Settings draft editing work > does no extra render or request while editing 'Paste delay'**.
- Diagnostic: expected three renders for three edits; received four.
- Classification: **own-diff**, for the setup dependency on the removed parent microphone refresh described in receipt 7.
- Proof: [failed job](https://github.com/millZach/Sotto/actions/runs/42713377706/job/129488697803); [corrective diff bc96ce3db](https://github.com/millZach/Sotto/commit/bc96ce3dbb42a56cb182aa6276d023577a15e8b8). The worker reproduced four renders before the repair and three after it.
- Action / result: settle the same mounted tree before measuring edits. All render-count, blur, save and acknowledgement assertions remain intact. The same 18-test pass and pending Windows confirmation as receipt 7 apply.

### 9. Adapter source check uses the old path

- Failure: `tests/unit/main/requestInput.test.ts:146`, **the words an adapter writes > need no language, since the headless host sets none**.
- Diagnostic: `ENOENT` opening `src/main/agents/claudeRequests.ts`.
- Classification: **own-diff**. The PR moved Claude and Codex request modules into provider folders but left this source-text test's two path strings unchanged.
- Proof: [failed job](https://github.com/millZach/Sotto/actions/runs/42713377706/job/129488698242); [corrective diff 4dc4cb3f7](https://github.com/millZach/Sotto/commit/4dc4cb3f74133a72e015aac13d92f948764206af). The exact test reproduced the missing-file error locally before the change.
- Action: update both paths. The test still verifies that every listed adapter source has no Lingui import.
- Result: all **20** tests in the unit file passed locally after the repair. Windows confirmation awaits the corrective run.

## Cross-shard audit before the push

- Reviewed all eight `runFollowup` branches for synchronous queue admission. Existing Watcher pause/native-fence and wake-up queue tests already wait for the state they inspect.
- Found one additional early observation in `restartResume.test.ts`: a host read did not prove queued follow-up work had finalized. [5e2969d95](https://github.com/millZach/Sotto/commit/5e2969d95a9fab4b81d2b5a09ffa531be9e513a9) waits for `followupsSettled()` before inspecting held prompts. Its targeted case passed locally (one passed, 40 unselected). Assertions and deadlines are unchanged.
- Checked the product-event drain's consumers: only the controlled product-event tests call it, and all 15 calls await it. Ordinary fixture users retain their default behavior.
- Checked the other host-only delegation stand-in identified by the audit. Its assertions concern placement/admission rather than successful delivery; no additional receipt change was justified there.
- Scanned source, tests and scripts for the 30 old full module paths. None remain. All Claude/Codex request-module references now use the provider folders.
- The settings render-budget cases share one setup; both now settle the mounted tree before measuring. Their original per-keystroke, blur and acknowledgement budgets remain in place.
- Collected the other shards' completed logs before pushing. Shard 5 passed. Checks and desktop (Windows) also passed; no additional failing assertion appeared there.

## Validation limits

The permitted local unit checks use `NODE_OPTIONS=--no-experimental-webstorage` with the installed Node `25.8.2`; this differs from CI's Node `24.22.1`. These local passes support the repair, not a flake classification or a claim that Windows CI passed.

Four complete unit files passed locally: `delegationNewsHidden` (14), `delegationEnds` (44), `requestInput` (20), and `settingsDictionary` (18). The additional targeted `restartResume` case passed (one selected, 40 unselected): **97 passing cases in total**. Production and Node-test TypeScript checks, scoped ESLint and whitespace checks passed during the repair.

All **nine** failed assertions are classified **own-diff** and repaired. None is classified as a flake or pre-existing; no separate repair owner or rerun is needed. No full local suite, integration test, e2e test, app launch or CI rerun was used. The remaining blocker is the new GitHub run on the corrective head; its required checks must pass before merge.

## Teams review follow-up on `53080393d`

[Bug Bot review 5834102091](https://github.com/millZach/Sotto/pull/2367#pullrequestreview-5834102091) identified two regressions. Both were confirmed in the source and reproduced by new cases in `tests/unit/main/teamsPersistence.test.ts` before changing production code:

- [T1](https://github.com/millZach/Sotto/pull/2367#discussion_r4519033359): the code maker installed its link and credentials, but a failed final record write escaped as `TeamSaveError`. The listener therefore refused the handshake and the peer revoked its token. The fix catches only `TeamSaveError` in `answerRedeem`, answers `linked`, and retains the existing unsaved warning. The regression checks the answer, retained peer token and link, and a successful authenticated check using the returned token. A separate control confirms that credential-write failures still reject and install no link.
- [T2](https://github.com/millZach/Sotto/pull/2367#discussion_r4519033371): a rejected revoke skipped listener cleanup after a refused outbound link. Cleanup now runs in `finally`, still using the existing condition that no link or live code needs the listener. The regression checks refusal, no link, no live code, Tailscale Serve removal and listener closure before teardown.

The first run had **2 failures and 8 passes**: T1 threw `TeamSaveError`; T2 left `listening: true`. After the fixes, the same file passed **10/10** with:

```sh
NODE_OPTIONS=--no-experimental-webstorage node node_modules/vitest/vitest.mjs run tests/unit/main/teamsPersistence.test.ts --reporter=verbose
```

Production and Node-test typechecks, scoped ESLint for the two changed TypeScript files, and `git diff --check` passed. No full suite, integration test, app launch or CI rerun was performed locally. The new head requires GitHub CI and a new merge instruction.
