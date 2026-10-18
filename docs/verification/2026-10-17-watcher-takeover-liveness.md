# Watcher takeover and quiet diagnosis, October 17, 2026

Installed-app fix: **not verified**. This lane has no authority to change live Sotto control, send to the protected feature coordinator, merge or deploy. The reproductions run real admission and adapter code against a scripted provider, and the real quiet scheduler against an injected clock. They use no Claude account or model turns. Completed checks and remaining limits are recorded below.

## Scope and existing work

Base `f000d7612fb270317ee32102037695edbf1765fa`, the existing `origin/main` at inventory. Only this diagnostic checkout was advanced from `16c5a757`; other worktrees were untouched. #1145 concerns the permission ceiling; #1146 PR evidence oscillation; #1147 read size; #1148 fresh requests after takeover. The saved `fix/watcher-pr-evidence` checkout has uncommitted changes for evidence and reads. They are neither replaced nor included here.

Read-only package inspection before the later Sotto restarts identified the running executable as `C:\Program Files\Sotto\Sotto.exe`, package **0.1.38-owl.20261017.1**, provenance source **d7c0c26afeba549f601fecbf3cc08bfe04a8be87**. `watcher.ts`, `watcherWakeUp.ts` and `codex.ts` are identical between that source commit and the reproduction base (`git diff --stat d7c0c26 f000d7612 -- <those files>` has no output). This ties the failing source paths to the installed version, without installing the patch.

## Reproduction

Run through the shared `Invoke-HeavyJob.ps1` helper, with Node as the executable:

```text
node node_modules/vitest/vitest.mjs run tests/integration/watcherTakeoverDiagnosis.test.ts tests/unit/main/watcherLivenessDiagnosis.test.ts --maxWorkers=2
```

First run, before either production change: exit 1; 14 tests, 9 failed and 5 passed; 15.03 seconds. The quiet fixture took 40 ms and advances twenty minutes without sleeping. Four integration scenarios reached the exact refusal below; one native-takeover scenario failed its fixture setup, which is not evidence of the product defect.

```text
manual-send / queue-followup / steer / user-reconfigure:
expected fresh request B status: ok
received status: refused, code: THREAD_TAKEN_OVER, retryable: false
message: You took over this thread. Watcher stopped sending to it.

idle completed parent, confirmed Codex roster working: 4:
expected one quiet event after twenty minutes; received []
```

The takeover fixture starts a real `AgentControl`/`WatcherService` runtime with a fake Codex app-server, sends Watcher work, performs a real user command, finishes the user turn, and submits fresh request B. It first proves that the resumed standing-watch route accepts a send and that old request A stays fenced. The only differing input at the failure is the ordinary request scope. This reproduces #1148 without live state mutations.

The quiet fixture reaches `WatcherWakeUp.observe`, its actual scheduled deadline, due checks and delivery callback. Its minimum failing shape is connected/observable, watched, idle/completed, no pending request, no provider background tasks or monitoring, and retained sub-agent summary `working: 4`. The same fixture with Claude background tasks wakes. Adding provider monitoring makes the Codex case wake too. Roster completion while a monitor remains exposed a second defect: a count change failed to reset the quiet deadline.

## Recovered records and limitations

Read-only extraction of `agents.json`, native origins and the thread event store was restricted to coordinator `282f01f1-5535-46bc-a38b-582c816a8fac` on host `5b0445e9-b649-4480-86fb-ce0a61de1c30`. The local `.zstack/watcher-diagnosis/collect-evidence.cjs` writes only identities, lifecycle fields, counts and times. Prompt bodies, tool arguments, credentials and complete native traces are not committed.

- Four earlier ordinary requests retain `taken-over`, generation 1, reason `user-reconfigure`, time **19:03:13.779 UTC**. Their last-user identity is the Watcher-originated 18:34 send, not a newer native user instruction. The precise reconfiguration command is not retained in this record; the reason covers several user controls.
- Operation `fdff6e1b…` at 19:06 is accepted under bounded standing scope `a8d8b549…`, linked to watch `ab04dd3b…`. The 19:57 operation `e00b16d0…` is accepted under scope `5473c800…`, linked to new watch `d5b723f9…`. The remapping of a watch ID to an operation's request ID is the intended standing-scope mechanism.
- All six native user-message origins on this coordinator map to recorded Watcher operations. This does **not** support the hypothesis that Watcher's own send was mistaken for a native takeover. The supplied 19:24, 19:52 and 20:01 refusal observations are consistent with the reproduced stale ordinary-request fence; refused admissions are not retained as operations, so their exact calls cannot be independently reconstructed from that store.
- Native turn `01a14b42…` began at **19:06:30.389**, completed at **19:16:51.297**, and the next turn began at **19:57:33.590**. The reported 44-minute interval from the earlier send included ten minutes of foreground work. Child completion events persisted at 19:16:52, 19:17:32 and 19:45:06. No parent reply is therefore different from no descendant activity. The interval between the latter two exceeds the quiet deadline, but the full historical connection/observer/queue state was not retained; this is not a replay proving the precise missed delivery time.
- The scheduling question was a native `request_user_input_async` call at 19:07:35.450, returning `{"accepted":true}` at 19:07:35.515. That does not prove a synchronous pending request card. The supplied `waitsOn: []` and the continued foreground turn argue against an unanswered blocking native question as the sole cause. This lane answered no card.
- A persisted PR babysitting record exists, but it is not `AgentThread.monitoring`. That field is provider task monitoring; the Codex adapter does not populate it for the PR babysitter. Thus persistent CI babysitting cannot by itself explain a quiet-eligibility result. An actual provider monitor keeps work unsettled and the monitoring fixture remains eligible for quiet.

## Cause and attribution

`WatcherService.mutate` searched **all** saved requests for a taken-over participation when admitting an ordinary request. A fresh user instruction inherited an old fence, while a standing scope used its separate path. For sends, including queued sends and steering, the patch scopes this relaxation to a strictly later request and target under a current standing watch on the same local host, with reliable latest-takeover evidence. Stop and settle keep their prior fence. Repeated takeover must be recorded even if no participating request remains. Review demonstrated that timestamp comparison could also admit an old request after clock rollback, so the patch retains the last ordinary request present at takeover or explicit rewatch, and requires a later insertion in the retained request list. Missing anchors refuse conservatively. Old requests and their operations stay fenced. Paired-host and request-only fences remain unchanged. Legacy watches without ordering evidence retain the standing route, or need an explicit renewed watch for the ordinary route. Main binds the identity and text-free digest of an already-fenced user draft to its exact native message before dispatch, so its delayed echo does not fence a newer request again. A packet arriving without a draft identity cannot establish that proof: if the user gives Watcher a new request before that queued packet echoes, the echo conservatively fences that request. A fresh request after the user turn completes works. Stable-to-Owl and edited queued packets without matching proof still take over. This is a partial, bounded fix for #1148; it must not close the issue as fully resolved.

Validation also reproduced a separate accepted-steer admission race. The fixture holds real preparation until a newer Watcher request exists, then holds snapshot publication while actual conversation events continue. It proves that the direct steer delivery is accepted, pending work is empty, the native head still names the old machine message, and a later user message is visible. The fresh request incorrectly received `status: ok` for a queued send instead of `THREAD_TAKEN_OVER` (one failing test, 19 skipped; 2.00-second test, 7.20-second invocation). This is new reproduction evidence, not proof that the race caused the historical session. The guard now recognizes newer human work when the same ordered message window contains both the stale machine head and a later non-machine user message. Explicit human or unknown heads remain protected; native identity and request ordering do not change. If the stale machine head has already left the window, prior behavior remains; prolonged metadata lag with head eviction is unverified. The regression checks fresh and standing scopes for now/queue/steer and recovery after the real user turn completes.

`WatcherWakeUp.active` counted foreground work, provider background tasks and monitoring, but omitted confirmed working sub-agents in the retained roster. Finish/outcome news already included that roster. Its progress fingerprint also omitted roster counts. The patch includes confirmed working agents in eligibility and the retained summary in the existing fingerprint. Unknown agents still prevent work-settled without proving active work. No polling is added.

| Coordinator input to Sotto | Baseline quiet behavior | Attribution |
| --- | --- | --- |
| Idle parent, Claude-style confirmed background tasks | One event after twenty minutes | Existing app path works |
| Idle parent, Codex-style retained working roster only | No event | App normalization/eligibility mismatch |
| Idle parent, Codex roster plus provider monitor | One event | Monitor already makes it active |
| Roster count changes while monitor stays | Deadline not reset | App progress fingerprint mismatch |
| Unknown roster after restart, no other work | No quiet; not settled | Intentional uncertainty |

| Watcher model/provider comparison | Evidence |
| --- | --- |
| Current Watcher's decisions | The supplied record says it received notices and elected to wait for work-settled instead of inspecting liveness. That is a process contribution independent of admission failure. |
| Opus versus Astra/Sol | No controlled same-instruction, same-observation comparison was run. Anecdote does not establish model superiority. |
| Adapter comparison | Deterministic normalized fixtures differ in work representation, without invoking either model. This establishes an app defect, not a model defect. |

`read_operation.state.stopped` means idle with no pending requests; it does not certify an explicit user stop. Its `backgroundWorkCount` counts provider background work and monitoring, while outcome/news count retained sub-agents too. A zero there and outcome `background` are therefore possible today. This patch leaves that API shape unchanged. Work-settled returns the reply to the original turn, not a newly generated status report; old wording about active agents is historical worker prose.

Codex transcript messages can retain the turn-start timestamp (`turnCreatedAt`, `applyItem`, `addMessage`); the event store confirms the repeated 19:06:30 stamps while append/activity timestamps advance. Quiet fingerprints message identities/lengths and activity lifecycle, rather than computing silence from those message creation dates. No causal timestamp failure was reproduced.

## Verification status

Post-fix liveness verification: `node node_modules/vitest/vitest.mjs run tests/unit/main/watcherLivenessDiagnosis.test.ts tests/unit/main/watcherWakeUp.test.ts tests/unit/main/watcherOutcomes.test.ts --maxWorkers=2` through the shared helper passed **117 tests in 1.50 seconds**, exit 0. This includes the existing wake-up/outcome suites and ten new fake-clock cases. The corrected native takeover fixture was rerun before a production takeover change: it reached the same fresh-request refusal after the standing send succeeded (1.88-second test, 5.54-second invocation).

Independent native GPT-6.1-Sol reviews of standards and the requested behavior found no unresolved actionable findings in the final conservative scope. Review led to retained request ordering, exact dispatch proof for user echoes, preserving stop/settle fences, and a monotonic human-turn guard for delayed publication. Both reviewers reread that final guard delta without new findings. The reviewers did not run tests. The first post-fix eight-file run below passed all 245 adjacent tests and 17 of 19 new takeover cases (262 passed, 2 failed; 171.57 seconds). The two failures were fixture setup: the packet and composer cases left Watcher selected, and the real command correctly refused a different draft owner or unavailable selected thread. Selecting the worker before those cases corrects that setup without changing production code. The next run passed those two cases but exposed a timing-dependent steer assertion (18 passed, 1 failed). Waiting for the exact published user head fixes that observed-state assertion. Investigating the interval, rather than merely changing the assertion, produced the separate accepted-steer race above. Static checks were skipped after both failed runs, as intended. The final command was:

```text
node node_modules/vitest/vitest.mjs run tests/integration/watcherTakeoverDiagnosis.test.ts tests/integration/watcherTools.test.ts tests/integration/watcherStandingWatch.test.ts tests/integration/watcherNativeFences.test.ts tests/integration/watcherGate.test.ts tests/unit/shared/watcher.test.ts tests/integration/watcherPairedHosts.test.ts tests/unit/main/watcherPairedReconciliation.test.ts --maxWorkers=2
```

Final verification on the saved patch passed **265 tests across eight files in 175.90 seconds**, including all twenty new takeover cases and the accepted-steer RED-to-GREEN regression. Both fresh and standing scopes refuse all three delivery modes during the publication gap and resume after the real user turn completes. In that same shared lease, `npm run typecheck` (all four configurations), `npm run lint` and `npm run notices:verify` (189 components) passed; the wrapper exited 0. Together with the unchanged liveness suites, **382 focused tests across eleven files passed**.

At that checkpoint the full suite and build/Electron journey had not completed; subsequent results are below. Packaged-app, macOS/Linux and real paired-host journeys remain unverified. No live Watcher or protected coordinator state was changed.

A future prevention is to share the definition of known active work between quiet detection, outcome/news and tool state, while preserving the distinction between unknown and zero. The current patch changes only the two reproduced behaviors; it does not replace takeover guards, synthesize user answers, or alter PR evidence work.

## Performance and rewatch follow-up

Zach required performance regression checks before PR readiness. The first saved patch did not meet that requirement. Two real observation-path fixtures exposed costs that the existing streaming fixture, without retained operations, did not cover:

- With the latest native user already known to be Watcher's message, scanning 20 versus 20,000 older messages increased property reads from 23 to 20,003 for one watch, and from 138 to 120,018 for six. The RED run had two failures and one passing later-human safety case (357 ms test time). Checking the latest user against the known head first removes that scan on the common streaming path. The default-suite guard permits at most twelve message-property reads per watch in that workload and preserves the later-human case.
- Unchanged observations copied and parsed the retained Watcher record once per watch and participant. The real `AgentControl` fixture measured four copies/three mutations for one watch and fourteen copies/thirteen mutations for six (two RED failures, 389 ms). Skipping unchanged head/pause assignments first reduced the steady pass to two record copies and one mutation. The subsequent read-only pruning fix below reduces that to one copy. Changed native heads, human takeover and pause release remain asserted. No takeover evidence is discarded to obtain that reduction.

A repeated nine-arm comparison before the second fix confirmed a material regression: six watches, twenty older messages and 200 retained takeovers took median 12.0014 ms on the parent versus 24.7989 ms with the new metadata. Without that metadata the current code took 10.9453 ms. Three fresh processes per arm, alternating order, verified the exact loaded source hashes and all workload shapes. This result prompted the copy fix; it is not a performance pass. Subsequent measurements and the completed paired-host investigation are in [the performance note](../perf/2026-10-17-watcher-observation.md).

The comparison also found an obsolete benchmark assertion: hidden wake-ups are withdrawn whole when any event becomes stale (ADR-0073), rather than partly trimmed. The benchmark now verifies eight queue items before each measured prune and an empty queue afterward, matching the existing unit contract. Product pruning behavior is unchanged.

Safety review reproduced an unparticipated worker losing its request frontier after unwatch, an unrelated takeover pruning its marker, and rewatch. Immediate sends while unwatched were correctly refused; only rewatch admitted the old request incorrectly. The RED integration case reached actual admission and returned `ok` instead of `THREAD_TAKEN_OVER` (2.066-second test). Rewatch now also uses an existing local withdrawal fence as a reason to establish a fresh frontier. Remote-origin fences remain excluded. The new regression subsequently passed, and verifies that a later request can still send.

The first follow-up seven-file run passed forty of forty-one tests, including every performance guard and the rewatch case. Its failure was a fixture waiting for a transient idle gap between an original turn and a queued user turn. Queued handoffs now await the fake provider's completion acknowledgment and the exact next native turn/user head. Actual terminal completion checks still require idle. The rerun passed all **41 tests across seven files in 49.22 seconds**, followed by all four typecheck configurations and lint (wrapper exit 0). Independent native Sol standards and spec reviews found no new actionable findings. Later results are below; interrupted full-suite attempts are not counted as passes.

A further matched measurement exposed unused private evidence copied into every room update. The actual `state()` fixture copied 200 private proof objects (69,380 bytes) while proving that none was needed in the public result. A second guard also caught a read-only prune cloning the full record. The combined RED run had four failures in two files (435 ms tests, 3.23-second invocation). Room state now clones the record without its private takeover field; remote-guard pruning reads the immutable view. Authority retains every proof and returned public data remains detached. The next run passed **43 tests in eight files, 44.47 seconds**, then all four typecheck configurations and lint. Independent review found no aliasing or safety issue.

The final nine-arm comparison on these production changes passed all source-hash/workload checks. Working six-watch observation with twenty older messages and 200 retained records improved from parent median 9.3209 ms to 2.3282 ms including new metadata. Room reads in the same case improved from 9.0345 to 7.3753 ms. Owl streaming fell by two record copies per update, so its budget is reduced by two. The broad paired-prune run retained a roughly +11% candidate median signal and variability; sample ranges are not confidence intervals. The final unprofiled B/C/C/B x3 repeat (`prune-ablation/20261017T233214Z`) had lower candidate wall and CPU block medians in all three blocks, with identical work counts and verified hashes/frozen inputs. An independent native Sol reviewer accepted the bounded conclusion: the controlled repeat did not reproduce the earlier slowdown. No consistent code-dependent prune slowdown was established; its earlier cause remains unproven. The scoped performance investigation is closed. The complete measurements and limits remain in [the performance note](../perf/2026-10-17-watcher-observation.md) and its JSON; this does not certify every workload or replace full repository gates.

## Isolated built-app proof

`npm run notices:verify` passed for 189 components and `npm run build` passed. The four selected real-main Playwright journeys initially returned three passes and one failure (35.8 seconds). The new recovery journey passed in 8.9 seconds: UI starts Watcher, real MCP tools start/watch a worker, a direct user turn fences the old request, a fresh Watcher request resumes it, and a renderer reload preserves the watched state and conversation. Root inspected `artifacts/e2e-runs/watcher-recovery/during-user-turn.png` and `recovered-after-reload.png`: the first shows the standing pause during the user's turn, the second the completed continuation with the normal watched label. No visible overflow was found. This is an isolated built Electron app with scripted providers; it is neither an installed-app rollout nor an app-restart test.

Existing first-start and permissions/watch journeys also passed. The existing Codex-to-Claude handover journey failed before handover because it never chose its initial provider: when neither fake model matches a named role default, the provider fallback chooses Claude. That selection code matches the reproduction base. The test now explicitly chooses Codex through the picker and asserts main's selected provider before its original checks. The focused rerun passed (8.9-second test, 10.2-second invocation, exit 0). All four selected main-process journeys now pass. No product selection behavior was changed.


## Final handoff verification reconciled

The final saved-source focused run passed **395 tests across 17 files in 171 seconds**, with maxWorkers=2. All four typecheck configurations and lint passed after phase instrumentation. Notices passed for 189 components, build passed, and all four rebuilt Electron scripted-provider journeys passed together in **28.2 seconds**. These supersede the earlier checkpoints above; interrupted full-suite shards remain uncounted.

The measured `src/main/agents/watcher.ts` SHA-256 is `620b17ec3aaf7b0f8257c0c2244cd7e15c20b462489ea17c93cf11490bc9b216`, verified again before rebase. Any post-rebase source difference must be reported separately from that measurement. Full post-rebase gates completed successfully in the merge-ready continuation, as recorded below. Installed/live Sotto, macOS/Linux and live paired-host proof remain unverified. Renderer reload is not an application restart. Historical refusal causality remains partly inferred; #1148 remains partial, and the Opus comparison remains anecdotal.


## Full post-rebase repository gates

The merge-ready continuation committed the handed-off follow-up work, fetched origin and ran `git rebase origin/main`. The fetched base remained `f000d7612fb270317ee32102037695edbf1765fa`; rebase reported already up to date, without conflicts. The post-rebase source commit is `7b914f215753af568ff5c88117f2d8e860856975`. `watcher.ts` still has the measured SHA-256 above: no source changes followed measurement, rebase or these gates. No benchmarks were rerun and no new tests were written in this continuation; the newly committed test files were already in the handed-off working tree.

All gates ran sequentially under one `Invoke-HeavyJob.ps1` lease, 2026-10-18 00:09:51?00:47:06 UTC (October 17 locally), using node.exe and npm-cli.js. The helper released with exit 0. Timings below are external command durations, not benchmark evidence.

| Gate | Result | External duration |
| --- | --- | ---: |
| `assets:verify` | Claude SDK 0.3.270 history helper and 7 terminal assets | 0.413 s |
| `typecheck` | All four configurations | 69.042 s |
| `lint` | Clean | 27.390 s |
| `notices:verify` | 189 components | 0.395 s |
| `npm test -- --maxWorkers=2` | 12,259 passed; 349 skipped; 946 files passed, 79 skipped (1025 total files) | 2071.349 s |
| `build` | Electron main, host, preload and renderer built | 34.844 s |
| `four Watcher Playwright journeys` | 4 passed; 29.5 s Playwright duration | 30.958 s |

Vitest reported 2070.07 seconds internally; there were no failed files, failed tests or unhandled errors, and no isolated rerun or gate fix. The four exact Playwright selections came from `.zstack/watcher-diagnosis/app-validation.ps1`: `watcher-recovery.spec.ts` and `watcher.spec.ts`, grep `fresh Watcher request|against main`, one worker. Recovery passed in 7.0 seconds; first start 4.9; permissions/watch 5.7; provider handover 8.8. These run the freshly rebuilt main process with scripted providers and isolated owned profiles.

The refreshed `artifacts/e2e-runs/watcher-recovery/during-user-turn.png` and `recovered-after-reload.png` were opened and inspected after the final run. The first shows the standing watch waiting for the human turn; the second shows completed fresh continuation and retained conversation after renderer reload. No visible clipping or overflow was found. Only those two cited images are retained. No design baselines changed.

Verdict: the scoped Windows isolated built-app journeys are VERIFIED. Installed/live Sotto, full application restart, macOS/Linux and live paired-host proof remain NOT VERIFIED. No merge, release, deployment, live control change or other lane was included. Prior native Sol standards/spec reviews remain applicable because rebase and final verification introduced no source delta; the final light standards/spec and evidence review found no additional actionable finding. #1148 remains partial and is related rather than closed.
