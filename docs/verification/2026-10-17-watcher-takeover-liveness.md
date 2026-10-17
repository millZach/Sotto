# Watcher takeover and quiet diagnosis, October 17, 2026

Installed-app fix: **not verified**. This lane has no authority to change live Sotto control, send to the protected feature coordinator, merge or deploy. The reproductions run real admission and adapter code against a scripted provider, and the real quiet scheduler against an injected clock. They use no Claude account or model turns. Completed checks and remaining limits are recorded below.

## Scope and existing work

Base `f000d7612fb270317ee32102037695edbf1765fa`, the existing `origin/main` at inventory. Only this diagnostic checkout was advanced from `16c5a757`; other worktrees were untouched. #1145 concerns the permission ceiling; #1146 PR evidence oscillation; #1147 read size; #1148 fresh requests after takeover. The saved `fix/watcher-pr-evidence` checkout has uncommitted changes for evidence and reads. They are neither replaced nor included here.

Read-only package inspection identifies the running executable as `C:\Program Files\Sotto\Sotto.exe`, package **0.1.38-owl.20261017.1**, provenance source **d7c0c26afeba549f601fecbf3cc08bfe04a8be87**. `watcher.ts`, `watcherWakeUp.ts` and `codex.ts` are identical between that source commit and the reproduction base (`git diff --stat d7c0c26 f000d7612 -- <those files>` has no output). This ties the failing source paths to the installed version, without installing the patch.

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

The full `npm test -- --maxWorkers=2` suite, build/Electron journey, packaged-app journey, macOS/Linux and a real paired host have not been run. No live Watcher or protected coordinator state was changed.

A future prevention is to share the definition of known active work between quiet detection, outcome/news and tool state, while preserving the distinction between unknown and zero. The current patch changes only the two reproduced behaviors; it does not replace takeover guards, synthesize user answers, or alter PR evidence work.
