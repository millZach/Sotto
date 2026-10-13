# Freezing while provider threads stream

September 19, 2026. Investigated on Zach's installed Windows Sotto 0.1.7, built from
`20bbda244f3239e453782d385b4ffb0ca8904548`. The source fix is on
`fix/codex-stream-freeze`. The installed process was not replaced or restarted.

## Acceptance and state

- [x] Observe the reported freeze while the existing threads continue running.
- [x] Trace the expensive work and reproduce it with synthetic provider output.
- [x] Keep the main event loop responsive during a three-thread output burst.
- [x] Preserve every output delta and final reply, with immediate turn and permission feedback.
- [x] Build and inspect the message-box journey in an isolated Electron profile.
- [x] Reproduce and fix the same snapshot bottleneck in Claude and Grok.
- [x] Finish the expanded full unit/integration gate and record its result below.
- [ ] Verify the installed fix against the original live threads after a future update. The owner explicitly deferred restarting or installing a preview.

## Live evidence

Windows reported the installed main process as not responding during the initial inspection.
The computer-use helper failed to connect, including after a retry and kernel reset. The app
already exposed its Node inspector on loopback; profiling used that inspector and Electron's
renderer debugger. No provider was interrupted and no messages or permission answers were sent.

The owner reported multiple full freezes during the visible typing capture. The renderer
capture counted 200 keydown events and 200 input events without storing their text. It found
no JavaScript long tasks; most reported input-to-paint durations were 32–56 ms. A concurrent
45-second main-process CPU profile instead spent approximately 25.3 seconds in state cloning,
3.6 seconds merging activity, and only 11 seconds idle. An earlier quiet interval was mostly
idle, so an idle-only profile would have missed this problem.

A follow-up stack profile traced the clones to:

1. `CodexAppServerHost.frame → emit → current`.
2. `SottoThreadHost` forwarding that snapshot to `ConfiguredProviderHost.accept`.
3. `WorkspaceHost.accept` merging activity and `workspaceSnapshot` copying it again.

The live workspace initially held roughly 7 MB of organization and tool activity, despite its
message arrays being empty after the SQLite migration. Three active threads increase both the
arrival rate and the amount copied. The workspace's existing 16 ms publish window was too late:
the adapter and provider aggregation had already copied the state for each incoming frame.
Draft saving was not the dominant work in the captured freeze.

## Reproduction and fix

`tests/integration/codexStreamingResponsiveness.test.ts` starts the real Codex adapter against
a synthetic stdio server, through Sotto thread identity mapping, provider aggregation and the
workspace. Three running threads each hold twelve 8,000-character command outputs. The server
then emits 600 interleaved output updates. A 5 ms heartbeat measures event-loop starvation.

```powershell
$env:SOTTO_PERF_ASSERT = '1'
npx vitest run tests/integration/codexStreamingResponsiveness.test.ts --disable-console-intercept
```

| Provider | Snapshots before / after | Longest heartbeat gap before / after |
| --- | ---: | ---: |
| Codex | 600 / 1 | 383 / 13 ms |
| Claude | 603 / 1 | 456 / 45 ms |
| Grok | 600 / 1 | 904 / 43 ms |

The original test failed its snapshot-count assertion. After the fix, the count and the opt-in
250 ms responsiveness budget pass. The test also checks the exact output in all three threads
and completes three streamed replies, checking that their chunks reach the event store intact.

The corresponding Claude and Grok regression in `nativeStreamingResponsiveness.test.ts`
uses each real stdio adapter, Sotto identities, provider aggregation and the workspace. It seeds
twelve 8,000-character command inputs per thread and sends 200 reply chunks per thread. Both
providers failed the snapshot-count assertion before the fix. The fixed tests preserve every
reply chunk, expose a permission without answering it, and allow the other two threads to finish
while that permission remains pending. These are separate three-thread runs per provider, not
a simultaneous mixed-provider live measurement. The table reports synthetic measurements;
runtime scheduling affects exact durations.

All three adapters now share `ProviderSnapshotPublisher`, grouping display updates for 16 ms
**before** building a snapshot. Commands,
permission requests, turn boundaries, errors and resolved requests still publish immediately.
They flush a pending display update; disconnect cancels it. Message events retain their original
order and are not coalesced or dropped. No thread identities, authority checks, privacy settings,
provider routing or renderer appearance changed.

## Verification

- Type checking, lint, notices verification and the production build passed.
- The expanded full `npm test -- --maxWorkers=2` run passed: 3,760 tests passed and 31 skipped,
  across 287 passing files and 17 skipped files, in 415 seconds. This includes the Codex,
  Claude and Grok adapter contracts, request handling, reconnect behavior and the new streaming
  regressions. Live provider tests remain gated; these checks use synthetic native processes.
- An earlier full run found a stale Grok activity-count assertion: a tool plus Sotto's turn
  record counted as two activities. The assertion now uses the test file's existing `tools()`
  filter, matching its purpose of checking tool restoration. The focused run including that
  case, native streaming and Codex host behavior passed 50 tests.
- All three streaming regressions and the shared publisher's three unit tests passed with
  `SOTTO_PERF_ASSERT=1` (six tests). The publisher tests check that sustained updates cannot
  postpone publication indefinitely, urgent updates flush synchronously, and a reset cancels
  old work without blocking a replacement connection.
- The built-app journey for typing and queuing a follow-up while another draft exists passed.
  Inspected [its screenshot](../../artifacts/codex-stream-freeze/typing-and-queue.png): the
  queued prompt, running-thread feedback and editable composer remain visible.
- The broader eight-case Playwright run passed two cases, failed three, and skipped three
  after the serial activity suite's first failure. Failures: activity text expects 16 px but
  renders at 15 px; a skill-bearing draft is empty after reload; an immediate message-count
  assertion sees zero after sending. These fixture paths do not instantiate the Codex adapter
  (`E2EAgentHost` replaces it, and the activity fixture mocks the connection). They are separate
  gaps; this change does not claim those suites are green.
- The legacy real-data `statePipeline.perf.test.ts` benchmark cannot finish after message
  migration: it reads empty `workspace.json` message arrays and dereferences the last message.
  Its partial measurements are not the regression evidence. The full CI-style test run points
  `SOTTO_PERF_DATA` to an absent temporary path, matching CI's lack of private workspace data;
  the new synthetic responsiveness tests still run.
- The earlier Windows preview at `release/freeze-fix-preview/win-unpacked/Sotto.exe` contains
  only the initial Codex fix. It is superseded by this expanded source change and must not be
  used to validate Claude or Grok. Nothing was installed, published or restarted. The owner
  plans to take the change in a future version.

## Pull request verification

Before delivery, integrated `main` at `ac7d9b75` (the screenshot-handling update). Only the two
artifact ignore lists conflicted; both entries were retained. Type checking, lint and notices
passed again. The three streaming regressions, publisher unit tests and Codex/Claude image
tests passed together (15 tests) with the stopwatch budgets enabled. The full integrated
revision is also checked by the PR's Windows CI gate before merge.

Repeated both Playwright specs on the fix and in a separately installed, detached worktree at
clean `main` commit `ac7d9b75`. Both runs produced three passing cases, two failures and three
cases not run. The same font-size assertion and skill-bearing draft reload failed on both.
The earlier immediate-message-count failure did not recur. These two remaining failures are
verified pre-existing; they are not covered by a green end-to-end claim.

The independent standards review found no violations or actionable smells. The independent
spec review found no missing requirements, scope creep or incorrect implementation. Both
reviews checked the shared publisher, all provider adapters and the regression coverage.

## Remaining limits

The live profile identifies the copying bottleneck and the regression verifies the fix through
the real provider pipeline. It does not prove that every possible cause of an unresponsive
window is removed. Live confirmation requires running the fixed build; the three active native
threads were kept on their existing installed build throughout this investigation.
