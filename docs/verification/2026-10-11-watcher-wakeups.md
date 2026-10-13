# Watcher event wakes and evidence, October 11, 2026

Windows x64, `feat/watcher-wakeups`, based on ticket 3 at `ed2f9e6eb`. The implementation revision is `1c0487469`. Native-provider wakes, packaged builds, macOS, Linux and phones are not verified by this ticket. The checks below cover the fake-provider coordinator path and the locally built Windows app.

`npm ci` ran first and succeeded with this worktree's own dependencies. No push, merge, rebase, stash, branch switch, new worktree, publication, additional installation or renderer edit ran. The lead owns the subsequent push, merge from main after PR #930 lands, pull request and two-axis review.

## Contract and behavior

`d60ab32bf` committed the compatible shared contract before implementation. The external `.zstack/watcher/contract.md` records the addition at its top. Channels, method requests and result envelopes stay unchanged. Optional room `news`, watched-thread `evidence` and `observation` fields carry text-free event identities and sourced facts. Evidence includes bounded source/time/head/check/PR/checkpoint/Git facts and explicit unavailable reasons. Optional control-record `wakeEventIds` keeps the newest thousand queued-event digests for restart deduplication. No field assumes a desktop-only consumer.

`db32d105b` adds event subscriptions and cancellable deadlines. Watcher batches for two seconds after the latest pending change, capped at five seconds after the first. Actual connected message/activity/background progress resets a twenty-minute quiet deadline; unchanged shells do not. Quiet is emitted once per episode. Pending requests, disconnection, unsupported observation, stopped participation and settled threads do not imply quiet. Reconnection begins a fresh observation interval. Watcher owns no poll timer and makes no additional GitHub read.

News uses the existing follow-up queue, outbox and provider writer. A busy master has one folding wake-up after its user's queued messages. Answered cards, outdated turn/evidence revisions, stopped requests, retired masters and changed participation are pruned before claim and checked again at the final native writer. Restored news waits for reconciliation. Wake-ups name the existing request and grant or answer nothing. Participating-worker residency is separate from the user's reading and Finished marks. Stable constructs none of the Watcher observers and preserves dormant records.

PR observations reuse existing babysitting and Git surfaces. A changed head replaces prior-head check evidence; failed/rate-limited reads are unavailable. Zero or refused checks remain unknown. Historical review pages alone do not establish current approval. Git totals are working-copy facts without a turn attribution. Successful checkpoint captures publish changed-file counts; shared-checkout overlap and unavailable captures publish their reason without counts. Captures retain their actual checkpoint identity and do not infer a native turn from the current thread. Added/removed checkpoint line counts remain omitted because this capture boundary does not prove an attributable text diff. Git/GitHub evidence older than five minutes is stale when read, without a freshness timer.

`7e82c6ff3` reserves the bounded Watcher portion before fitting combined babysitting details within the existing provider message limit. Babysitting-only wording remains identical. Watcher news is capped at fifty targets and 16 KiB, with an omitted count and roster reference; worker words, raw errors, tool arguments, protocol bodies, tokens and permission answers do not enter it. Evidence and recent news are bounded in memory. With history off, queue words stay in memory and only text-free queued-event digests persist.

`3bb2ba31b` keeps checkpoint setup available when the local host is off. The inactive runtime's refusal proxy treated the new observation predicate as an unsupported operation and made Sotto quit before opening a window. Its read-only predicate now returns false, without constructing Watcher or starting observers. The original app journey passes after the fix.

`1c0487469` removes guessed native-turn attribution from checkpoint observations. A refused capture before the next turn starts was labelled with the thread's previous turn. The regression reproduced that exact wrong identity before the fix. The observer now forwards the source's checkpoint identity unchanged; its optional source-provided turn field remains compatible.

## Gates

The final gates ran in the required order against `1c0487469`, with real output. The subsequent evidence commit changes only this note.

| Command | Result |
| --- | --- |
| `npm run typecheck` | Exit 0; all four TypeScript projects |
| `npm run lint` | Exit 0 |
| `npm test -- --maxWorkers=2` | Exit 0; 773 files passed, 58 skipped; 9,536 tests passed, 280 skipped; 1,042.45 seconds |
| `npm run notices:verify` | Exit 0; 189 third-party notice components |
| `npm run build` | Exit 0; main, host, preload and renderer |
| `npx playwright test tests/e2e/watcher-gate.spec.ts` | Exit 0; three journeys passed in 9.9 seconds |

An earlier full run at `7e82c6ff3` passed 773 files and 9,534 tests, with 58 files and 280 tests skipped, in 1,059.08 seconds. Free physical memory was 12,588,924 KB before that run and 13,499,896 KB before its app checks. The app check then exposed the local-host-off startup defect; the isolated journey reproduced it. A temporary probe in the built bundle confirmed the checkpoint call stack, and was removed. The new checkpoint/inactive-host regression first failed at that same boundary, then all nine tests over both files passed in 1.57 seconds with the fix. A rebuilt app passed all three gate journeys in 10.9 seconds before the final gate rerun.

Free physical memory was 13,641,496 KB before the partial full-suite run at `3bb2ba31b`, above the required 3 GB threshold. That run was stopped on its verified owned process tree when the guessed checkpoint-turn attribution was found. It is not counted as a pass. The focused post-attribution-fix run passed four files and 56 tests in 19.93 seconds.

Free physical memory was 13,573,576 KB before the final full suite at `1c0487469` and 11,851,088 KB before the final app check, above the required threshold. No final full-suite or flaky-test retry was needed. The suite emitted SQLite experimental, jsdom canvas and fixture line-ending warnings; build emitted dependency directive warnings.

An earlier partial suite was deliberately stopped on its verified owned process tree after the combined-message bound gap was found. It is not counted as a pass. The focused run after that fix passed four files and 67 tests in 22.70 seconds.

## Regression and privacy evidence

`watcherWakeUp.test.ts` uses a controlled clock and cancellable scheduler to check trailing batching and the five-second cap, newest-truth folding, failure over finish, answered-card withdrawal, one quiet event per episode, real-progress resets, reconnect timing, deadline cancellation, stopped/retired/taken-over/settled/answered stale validation, durable deduplication and bounded UTF-8 wording. The combined-message regression preserves both sources and compares babysitting-only output with the original wording.

`watcherEvidence.test.ts` checks source attribution, current-head replacement, failed and stale reads, unknown checks, separation from worker claims, working-copy totals without turn attribution, unavailable shared checkpoints, stable native failure categories and bounded fact fingerprints. Checkpoint tests check the existing capture boundary and refusal path; their observation payloads retain no paths or file contents.

The fake-provider integration covers finish, question and failure independently through the real coordinator queue and follow-up pump. Each holds the master busy, observes the queued news, releases its turn and verifies the provider receives that news. Zero answer commands are sent. Native failure evidence carries `provider-turn-failed`, separate from the synthetic worker error. History-off JSON inspection finds neither distinctive worker question/error strings nor wake-up prose. A separate busy-master case preserves the user's queued message before news and withdraws an answered card. The held-checkpoint-preparation case removes a card after claim and verifies the final writer does not send its stale news.

The checkpoint integration regression uses the real inactive runtime rather than a stub with missing methods. It initializes the same checkpoint wiring used at app start and verifies that Watcher stays absent, its observation predicate is false, and no local thread is created.

The before-turn attribution regression faults the real capture boundary while the thread still names its previously completed native turn. It verifies that the unavailable observation names its actual checkpoint, with no guessed turn or invented file count.

The unchanged babysitting integration is included in the final full-suite pass. The built Windows app checks both version-derived release tracks, bridge availability, all five local-host-off refusals, unchanged limit, ordinary Send/reply, saved-kind preservation and stable layout recovery. Dark/light, reduced motion and bounds were checked at 1600x1000, 1280x800 and 820x560. Visually inspected the latest minimum-size Owl dark and stable light captures; the existing sidebar, transcript and composer fit. The main bundle was written at 13:41:39 local time, and these captures at 13:42:10 and 13:42:05 respectively. They came from the latest worktree build on `1c0487469`, with disposable synthetic profiles, and are gitignored run evidence.

## Decisions and remaining scope

CONTEXT.md, ADR-0073, the plan, README.md, guide and agent-control documentation record the settled event/evidence behavior. No production dependency or release setting changed. All 32 changed files have no UTF-8 BOM; existing file line endings were retained. No new design baseline or renderer surface was created. No diagnostic tag remains in source, tests or the built bundle. The room, receipts, beside pane, remote owning-host delivery and phone UI remain their later tickets. The lead's two-axis pull-request review has not run in this worktree. Ticket 4's implementation and verification are complete locally.

## Ticket 3 follow-up merge, October 11, 2026

The later follow-up explicitly authorized fetching and merging ticket 3. `de9fdd84e` is a two-parent merge of this branch at `1a00332ce` and `origin/feat/watcher-thread-tools` at `4f88ffa72`. It includes ticket 3's two review rounds and its main merge. No push, rebase, stash, branch switch, new worktree, publication, dependency installation or nested review ran for this follow-up.

There were exactly two conflicts. In `src/main/agents/watcher.ts`, retain both the `WatcherObservation` type import and `WATCHER_PARTICIPATION_HISTORY_MAX`; keep the reviewed tool/refund/paging logic alongside event observers and evidence. In `tests/integration/watcherTools.test.ts`, retain both appended test groups and restore their closing boundary. The merge commit body names both resolutions.

| Ticket 3 commit | Preserved behavior and regression |
| --- | --- |
| `0df0ddaa5` | Definite preparation/native/thrown failures refund one pre-writer prompt; accepted or unresolved writes and cancellation codes do not gain another refund. |
| `8fc4a341f` | Roster rows return the latest hundred participation entries; the durable 101-request history remains intact. Ticket 4 evidence and observation fields remain alongside the bound. |
| `3311c2800` | A matching retry returns its recorded receipt after closure, without dispatch or request revival; conflicting and new keys still refuse. |
| `dc9131341` | Working-copy and base-ref choices expire with their sixty-second or evicted page snapshots; paginated choices retain identity without another native read. |
| `45af8cd5b` | Direct and queued image commands retain main's minted request, host and project context at the provider boundary. |
| `bb2e38376` | Oversized initial reads retain the newest reply and update the first position; forward reads retain an ordered prefix and continuation. Sourced evidence remains in the bounded response. |
| `a7995c513` | The advertised restart cursor starts fresh thread, project and working-copy pages without changing selection. |
| `e500ee5f6` | Durable failed queue state resolves recovered uncertainty when no native intent remains outstanding, with one refund; incidental errors preserve unresolved uncertainty. |
| `7e1c730be` | Stop all signs eligible target/request/Watcher ownership, tolerates normal follow-ups, and refuses changed targets or takeover before stopping. |
| `5341c515a` | Send, Queue and Steer to a relinquished participant refuse REQUEST_NOT_ACTIVE before capacity or prompt admission; the dispatch fence preserves that refusal. |
| `d8fd86863` | Closed-service preview, confirmation and final interrupt guards refuse NOT_CURRENT_WATCHER without record, queue or provider effects. Closing also cancels ticket 4 deadlines. |
| `5d908f973` | Other special jobs remain readable and protected; mutation and master-read refusals preserve selection and user reading marks. |

The non-source follow-ups also survive: `f5c18f188` keeps the selected, tracked capture links, `a1eec5639` and `4f88ffa72` retain both review verification notes, and `527d6f027` brings the reviewed main merge. No incoming renderer change was edited during resolution.

The source diff against ticket 3 retains its fixed logic unchanged and adds ticket 4 observers, sourced projections and news. The test diff against ticket 3 retains all of its regressions and adds the ticket 4 wake cases. Delivery-news revisions include delivery state, refusal code and creation uncertainty, so recovered receipts invalidate older news. Wake handling reads the existing receipt and never refunds, renews or widens a budget. Relinquished, stopped or closed-service participation invalidates queued news; permission and question news still answers nothing. Failure evidence continues to attribute confirmed native turn failure separately from worker text and delivery refusals.

Focused verification passed seven files and 88 tests in 31.47 seconds: watcherTools, watcherNativeFences, watcherRecovery, watcherWakeUp, watcherEvidence, unchanged babysitProviders and e2eEvidenceDocs. No BOM was introduced in either conflict file; both retain CRLF endings.

### Follow-up gates and window-size correction

The first five gates ran in the requested order against merge `de9fdd84e`. The sixth initially passed the local-host-off journey and failed the stable and Owl capture journeys because the native window clamped a requested 820 by 560 content area to 820 by 562. This was a reproduced test-window minimum issue, not a flaky-test timeout.

At the laptop's 150% display scaling, the app-only probe read native minimum `[820, 560]`, content height 562, and the same 562 height after requesting 558. Changing only the disposable window minimum to `[800, 540]` produced content height 560, with native outer height 561. The probe went red before the change and green after it. `a75903d37` applies that existing capture-test convention to the Watcher size loop. Exact content dimensions and layout bounds remain asserted; no production window, renderer, wake or evidence code changes. The original three journeys then passed. The temporary probe and its tagged diagnostics were removed.

| Command | Real result |
| --- | --- |
| `npm run typecheck` | Exit 0; all four projects; repeated successfully after the test-only correction |
| `npm run lint` | Exit 0; repeated successfully after the test-only correction |
| `npm test -- --maxWorkers=2` | Exit 0; 777 files passed, 58 skipped; 9,658 tests passed, 283 skipped; 1,151.52 seconds |
| `npm run notices:verify` | Exit 0; 189 third-party notice components |
| `npm run build` | Exit 0; main, host, preload and renderer |
| `npx playwright test tests/e2e/watcher-gate.spec.ts` | Exit 0 after the separately committed sizing correction; three journeys passed in 9.6 seconds |

Free physical memory was 12,027,240 KB before the full suite and 9,995,972 KB before the app checks, above 3 GB. The full suite passed on its first run with no isolated flaky-test retry. It emitted SQLite experimental, jsdom canvas and fixture line-ending warnings; the build emitted dependency directive warnings. The E2E correction only changes a capture helper argument in a spec excluded from Vitest, so the already-passing full suite and unchanged production build were not repeated.

The final built-app journeys verify stable and Owl ordinary Send/reply, saved special-kind preservation, bridge gating, stable layout recovery and all five local-host-off room refusals. Dark/light, reduced motion and layout bounds pass at 1600 by 1000, 1280 by 800 and the exact 820 by 560 content size. Visually inspected the final [Owl dark](../../artifacts/watcher-gate/wakeups-owl-dark-820x560.png) and [stable light](../../artifacts/watcher-gate/wakeups-stable-light-820x560.png) captures: sidebar, transcript and composer fit. The two selected synthetic captures are committed in the existing evidence folder and are not ignored. At 150% scaling their PNG dimensions are 1230 by 840 physical pixels. Main bundle timestamp: 16:18:23 local; selected captures: 16:21:52 and 16:21:48. These captures supersede the original ignored run images recorded above.

There is no additional room contract or shared-field change. Production dependencies remain exactly zod, node-pty and sherpa-onnx-node. The authorized incoming main merge carries version 0.1.37; no additional installation was needed. No new domain decision was made, so CONTEXT.md, ADR-0073 and the plan need no follow-up amendment. No implementation or required check remains unfinished locally. Native-provider wakes, packaging, macOS, Linux and phone checks remain outside this verification; remote delivery and the lead's review remain assigned to the lead.

## Main integration after ticket 3 merged, October 11, 2026

Merge `95c25066b` has parents `2b3a1a4e2` and fetched `origin/main` at `6adc78c40`. Main includes ticket 3's merge `988b637d2` (#930), #941, and the later #942 worktree recovery merge. Both actual conflicts are named in the merge body.

- `src/main/agents/control.ts`: compose stale Watcher-news validation with the stopped-participation queue guard in the private final-writer callback. Keep main's normal follow-up readiness fence and native operation guard; user prompts and news keep their existing origins.
- `tests/e2e/watcher-gate.spec.ts`: retain the exact content-size helper call with the explicit test minimum, its existing comment, and main's added live in-flight-limit journey. Neither viewport nor bounds assertions were relaxed.

The merged Watcher service differs from main only by ticket 4's observers and sourced projections. Ticket 3's reviewed admission/refund/receipt/paging/ownership/closure logic survives. The third-round fixes are present unchanged:

| Incoming change | Preserved check |
| --- | --- |
| `a43f27382` | Stopped participation holds saved queues even when native completion precedes interrupt. The private callback rechecks after native preparation. Existing delayed persistence/cleanup, explicit user review, ordinary queue and saved-prompt native-fence regressions pass. |
| `cb0e025a8` | Working-copy choices require paths; base choices require branches. Both roles are checked before admission and after the native read. Wrong-role choices change no durable record or provider command; a valid branch still reaches creation. |
| `1c181ba7b` | Expired Stop all previews are pruned on preparation/confirmation, and only the newest sixteen are retained. Expired/evicted IDs refuse without interrupts; newest scope remains usable once. |
| `f782a665c` | setLimit goes through settingsCoordinator.updateSettings. The new built-app journey checks both the running Watcher limit and saved setting. |
| #941 | Fixture event/ownership/setup repairs and Gates (Windows)'s forty-minute limit remain intact. |
| #942 | Half-removed worktree recovery and its verification remain intact through the incoming main merge. |

Two added merge regressions prove the stopped-worker rule at the news/evidence seams. The fake-provider path retains a checkpoint's sourced identity and file count, removes stopped participation from news and observation residency, and holds babysitting news without sending it. Only explicit user review resumes the queue; its Watcher prompt count stays one and no answer command is sent. The real Codex adapter with the fake provider child holds a wake-up in native preparation, accepts Watcher's Stop on the already-completed turn, then verifies there is no matching turn/start or request/answer and the unsent news remains for review.

The focused run passed five files and 92 tests in 46.08 seconds: watcherTools, watcherNativeFences, watcherWakeUp, watcherEvidence and unchanged babysitProviders. No BOM was introduced; both conflicts and the modified test files retain CRLF. No production dependency or package-lock change was needed, no new Watcher poll/timer or contract field was added, and no renderer file was manually edited.

### Ordered gates on the main merge

All six requested gates ran in order against implementation `95c25066b`, with real output. No gate failure, isolated flaky-test retry or additional implementation fix was needed. The later evidence commit changes only this note and selected captures.

| Command | Real result |
| --- | --- |
| `npm run typecheck` | Exit 0; all four TypeScript projects |
| `npm run lint` | Exit 0 |
| `npm test -- --maxWorkers=2` | Exit 0; 777 files passed, 58 skipped; 9,718 tests passed, 283 skipped; 1,363.31 seconds |
| `npm run notices:verify` | Exit 0; 189 third-party notice components |
| `npm run build` | Exit 0; main, host, preload and renderer |
| `npx playwright test tests/e2e/watcher-gate.spec.ts` | Exit 0; four journeys passed in 19.1 seconds |

Free physical memory was 10,377,340 KB before the full suite and 4,327,632 KB before the built-app journeys, above 3 GB. The full suite emitted SQLite experimental, jsdom canvas and fixture line-ending warnings; build emitted dependency directive warnings. The entire suite passed on the first attempt, including the unchanged babysitting integration and all incoming fixture regressions. Gates (Windows)'s forty-minute limit remains present.

The app journeys check stable/Owl ordinary Send/reply, saved special-kind preservation, bridge gating, stable layout recovery, all five local-host-off room refusals, and the changed limit applying to both the running Watcher and saved settings. Dark/light, reduced motion and bounds pass at 1600 by 1000, 1280 by 800 and exactly 820 by 560 CSS pixels. Visually inspected the new [Owl dark](../../artifacts/watcher-gate/wakeups-main-owl-dark-820x560.png) and [stable light](../../artifacts/watcher-gate/wakeups-main-stable-light-820x560.png) selected captures; sidebar, transcript and composer fit. They are committed in the existing evidence folder and are not ignored. At 150% display scaling, their PNG dimensions are 1230 by 840 device pixels. Main bundle timestamp: 19:41:31 local; captures: 19:42:26 and 19:42:19.

No additional room contract or shared field changed. No new domain decision was made, so CONTEXT.md, ADR-0073 and the plan need no follow-up amendment. Production dependencies remain exactly zod, node-pty and sherpa-onnx-node. This follow-up ran no push, rebase, stash, branch switch, new task worktree, nested review, publication or installation; the initial npm ci remains the worktree's own dependency install. No implementation or required check remains unfinished locally. Packaged builds, paid native-provider turns, macOS, Linux and phones were not exercised; remote delivery and the lead's review remain assigned to the lead.


## Two-axis review fixes, October 11, 2026

All eight findings were verified and fixed. The behavioral probes failed before their fixes; the callback-type and glossary probes also went red before the corresponding changes. No finding was dismissed as not a bug.

| Finding | Commit | Cause and regression proof |
| --- | --- | --- |
| 1. Plan progress and quiet | `cac21363c` | Include plan-step status and text length in the private progress fingerprint. Completing a step at minute nineteen withdraws the old twenty-minute deadline and schedules quiet from that real progress. The old code sent one premature quiet notice; the corrected test and privacy assertion pass. |
| 2. Comments-only reads | `9d708b818` | Pass the reader's existing checks-selection flag into the observation projection. Reuse known checks only for an unrequested read of the same URL and head; requested-but-refused, unavailable, mismatched-head and different-URL reads remain unknown. The real reader probe previously changed passing checks to unknown. Its query selection, read count and babysitting news remain unchanged. |
| 3. Returning evidence states | `ad126f7eb` | Keep the latest fingerprint and occurrence for each request, target and generation. A failed/passed/failed sequence gets three distinct events; identical reads do not. Persist opaque digest components within the existing ID bound, accept legacy IDs for their first reconciled occurrence, canonicalize fact ordering, and reject old queued occurrences even when their state returns. Cycle, restart, ordering and legacy regressions pass. |
| 4. Failed saves | `840402b86`, `4d9f51b29` | Retain undelivered news on the existing batching deadline. Save event IDs separately so a metadata failure does not queue saved news twice. Retain the whole pending batch behind the delivery limit: the supplemental sixty-target probes previously lost ten omitted events, and stopping twenty participants left thirty rather than forty current events. Retries now retain counts and newly fitting events while withdrawing stopped, answered or superseded news. |
| 5. Structured checkpoint cause | `d5c924c9f` | Persist optional `unavailableReason` beside the human explanation and assign it at the capture or attribution failure. A capture error mentioning overlap now remains capture-unavailable; genuine shared-checkout overlap remains correctly attributed. Legacy records and journal/file round trips pass without interpreting prose. |
| 6. Stored-news callback types | `c566b5181` | Remove subtype generics and downcasts from queue, withdrawal and pruning callbacks. Every callback accepts `WakeUpNews`, including mixed saved sources. The old API failed the type-equality check and accepted all three unsafe narrow callbacks, producing three unused expected-error directives. The corrected compiler checks reject those callbacks, and the mixed-source store regression passes. |
| 7. Shared check classifier | `9d708b818` | Both GitHub babysitting observations and workspace PR observations use `summarizePullRequestChecks`. The related reader and evidence regressions preserve failed, pending, passed and unknown behavior. |
| 8. Glossary | `0ba4a7cf4` | Broaden Wake-up, Turn and Coordinator from babysitting alone to both Sotto news sources. All three glossary checks failed against the old entries and pass after the update. |

The focused runs passed fourteen quiet/wake tests after finding 1; fifty reader/evidence/babysitting tests after findings 2 and 7; eighty-one wake/tool tests after finding 3; eighty-six after the first save-retry fix; sixty checkpoint/store/integration tests after finding 5; and eighty-seven queue, callback, wake and glossary tests after findings 6 and 8. The final bounded-retry fix passes eighty-eight wake/tool tests in 32.22 seconds. These runs use fake clocks, native fake-provider children or synthetic local fixtures; no paid provider turn was required.

### Gate failures and their corrections

`11b3a8c92` fixes the first lint run's three fixture errors: two unused mock parameters and a path guard that threw inside finally. Explicit mock callable types and checking the temporary path before try/finally preserve the tests' behavior. Focused lint and twenty-five tests passed before restarting the ordered gates.

The first full run on that head failed with 777 files passed, two failed and 58 skipped; 9,735 tests passed, two failed and 283 skipped; duration 1,754.87 seconds. Socket child Codex failed during create-thread setup with the fixed Git refusal, before any native takeover action. Devin's worktree-reuse test exceeded fifteen seconds. Both files passed separately without changes: `socketHostContract` passed 45 tests in 94.55 seconds, and `threadWorktreesNative` passed 16 in 41.02 seconds. The underlying Git refusal was not reproduced or established, so no speculative Git change is claimed; neither failure recurred in the next two complete runs.

The second full run failed only the repository-wide encoding scan's fifteen-second deadline: 778 files passed, one failed and 58 skipped; 9,736 tests passed, one failed and 283 skipped; duration 1,497.09 seconds. The scan already opens each tracked file for only three bytes. `4ece14575` gives that whole-repository check a scoped sixty-second deadline; its BOM assertion and file coverage remain unchanged. It passed alone in 142 milliseconds of test time and in the final full suite. No global deadline or performance assertion was changed.

### Final ordered gates

All six commands ran in order on implementation `4ece14575`, after every code and regression fix. The later evidence commit changes only this note and two selected captures.

| Command | Real result |
| --- | --- |
| `npm run typecheck` | Exit 0; all four TypeScript projects |
| `npm run lint` | Exit 0 |
| `npm test -- --maxWorkers=2` | Exit 0; 779 files passed, 58 skipped; 9,739 tests passed, 283 skipped; 1,162.68 seconds |
| `npm run notices:verify` | Exit 0; 189 third-party notice components |
| `npm run build` | Exit 0; main, host, preload and renderer |
| `npx playwright test tests/e2e/watcher-gate.spec.ts` | Exit 0; all four journeys passed in 14.8 seconds |

The prescribed memory command returned 6,498,960 KB before the first full run, 8,998,512 KB before the second and 10,709,852 KB before the final run. Each exceeded 3 GB. Free memory before the built-app checks was 12,790,696 KB. The final full run needed no isolated retry. SQLite experimental, jsdom canvas, fixture line-ending and dependency-directive warnings remain non-failing output.

The built-app journeys check stable/Owl ordinary Send/reply, saved special-kind preservation, bridge gating, stable layout recovery, all five local-host-off room refusals, and the running Watcher and saved settings accepting a changed limit together. Dark/light, reduced motion and bounds pass at 1600 by 1000, 1280 by 800 and exactly 820 by 560 CSS pixels.

Visually inspected this run's [Owl dark](../../artifacts/watcher-gate/wakeups-review-owl-dark-820x560.png) and [stable light](../../artifacts/watcher-gate/wakeups-review-stable-light-820x560.png) minimum-size captures. The sidebar, transcript and composer fit, and stable hides the saved Watcher rows while Owl exposes them. Both selected files match the inspected run images byte-for-byte and are not ignored. At this laptop's 150% display scaling they are 1230 by 840 device pixels. The main bundle was written at 22:19:20 local; the run captures at 22:19:57 and 22:19:52.

No additional room-contract field or channel changed. The structured cause is private checkpoint storage; event IDs remain opaque strings within the existing bound and older IDs remain readable. CONTEXT.md is corrected for finding 8; these fixes settle no new domain decision, so ADR-0073 and the plan need no new amendment. Production dependencies remain exactly zod, node-pty and sherpa-onnx-node. No renderer file was edited, and existing file endings and UTF-8 without a BOM were retained.

News still grants and answers nothing, and never resumes a worker Watcher stopped. Queue retries use the owned batching deadline and fetch no provider, Git or GitHub state; no Watcher poll timer was introduced. Ordinary threads and babysitting remain unchanged in their integration and gate proofs. There is no unfinished local implementation or required check. Packaged builds, paid native-provider turns, macOS, Linux and phones were not exercised. The lead owns remote delivery and the pull request; this work ran no push, rebase, stash, branch switch, new task worktree, nested review, publication or installation.


## Pull request 957: Greptile follow-up, October 12, 2026

The lead's main merge 8e3c57b3c was already present at entry, and the branch was clean. The prior bug-bot round is retained in 772d41e00 (Git clocks and ahead/behind), f01f3ad85 (held news and capped persistence retries), 6fb9a43ce (host-qualified quiet) and 7bc2aec09 (fake Codex request/script handoff). Zach reported that the lead ran that round's gates green with 9,775 tests, pushed it and merged main. That is the lead's report, not a claim of local output for the interrupted prior run.

All three new findings were reproduced and fixed.

| Finding | Commit | Cause and red/green proof |
| --- | --- | --- |
| 1. Restart withdraws waiting checkpoint news | bb66ccf83 | The old cold store made the restored event not due at the first prune, and checkpoint initialization emitted zero saved facts. Reconcile waiting queue references before observation, keeping unobserved facts unknown; restore queued identities even if their separate metadata save failed. Checkpoint initialization republishes each thread's newest retained ready/unavailable capture once through the gated observer. Same-fact hydration preserves the old occurrence, while observed changes and ownership fences supersede it. |
| 2. Readers overwrite GitHub facts | f72cc7abe | The old checks-only read removed approval/auto-merge and returned changed; carrying unrequested checks forward refreshed their old timestamp. Keep PR state, checks, current review and auto-merge as separate facts for the same canonical URL/head, each with its own time/freshness. Update only observed fields, retain explicit false values, clear earlier-head facts and reject late old-head/old-field answers. Alternating unchanged readers produce one wake-up. |
| 3. Held news loses its error | 6244c540d | Both paused and failed probes lost their error after partial pruning. Keep it while those statuses remain, and clear it when the item is queued again. The news body can change without making the held queue ready. |

c99c547dd fixes the related recovery unlink edge: the new probe initially left an explicitly removed association due while recovery was incomplete. An association removed from an observed roster is a real change, even when its checks were unknown. That now invalidates the older aggregate without treating unobserved source facts as changes.

The shared schema addition is only optional WatcherEvidence.githubAutoMergeEnabled, committed with finding 2 before the later fixes and described at the top of the external room contract. Each separate GitHub fact uses the existing observedAt, freshness and availability fields. Channels, envelopes, saved control formats and phone scope are unchanged. ADR-0073 records both source timing and restart reconciliation; no new glossary term or plan amendment is needed.

The reader/wake/tool/unchanged-babysitting focused run passed four files and 120 tests in 44.20 seconds. The initial recovery/checkpoint/integration run passed three files and 87 tests in 35.79 seconds. The real coordinator waiting-queue recovery/replay case passed separately in 5.84 seconds, after correcting its matcher to the actual news wording; no deadline was changed. The paused/failed callback, follow-up and workspace queue run passed three files and 54 tests in 9.54 seconds. The final wake/evidence run passed 50 tests in 1.45 seconds, including explicit unlink and missing metadata.

The first typecheck exposed TS2379 in a new changed-head fixture that explicitly set absent optional fields to undefined. 4055484d9 omits those fields as the interface requires; production types and behavior are unchanged. The ordered gates restarted after that fix.

d44265406 fixes the fifty-PR evidence boundary. The direct probe reported all fifty unchanged reads as changed, and the regression failed. Keep a private bounded cache of 300 facts (enough for fifty linked PRs with independent facts), return at most 100, and move facts only on actual changes. The regression preserves identity and ordering on unchanged reads, keeps the projection bound and surfaces a real changed check. The focused evidence/wake/babysitting run passed 57 tests in 9.16 seconds.

The first full run was intentionally stopped with exit 1 after this capacity probe; it has no completed suite result. The final ordered gates restart on the corrected source.

3b8caa954 fixes recovery at that boundary. Full-projection and new-link probes went red. Compare source changes with the full bounded cache, so projection omissions do not become removals. Retained captures are first offered to a private restorer; only a capture referenced by the queued occurrence seeds its comparison before publishing the newest capture. Disabling that priming kept old news due after a newer saved capture; the enabled regression passes. The recovery/checkpoint/tool run passed 161 tests in 55.65 seconds. No shared field or poll was added.

Typecheck then caught nullable canonical PR keys in the new association set. 9ae88b46c filters unsupported keys and handles null during retained association comparison, without widening the type.

### Final ordered gates

All six gates ran in the requested order on implementation `9ae88b46c`. No code changed during or after this final run. The evidence commit adds only this note and the two selected captures.

| Command | Real result |
| --- | --- |
| `npm run typecheck` | Exit 0; all four TypeScript projects |
| `npm run lint` | Exit 0 |
| `npm test -- --maxWorkers=2` | Exit 0; 780 files passed, 58 skipped; 9,792 tests passed, 282 skipped; 1,312.01 seconds |
| `npm run notices:verify` | Exit 0; 189 third-party notice components |
| `npm run build` | Exit 0; main, host, preload and renderer |
| `npx playwright test tests/e2e/watcher-gate.spec.ts` | Exit 0; four journeys passed; the recorded repeat took 14.9 seconds |

The prescribed free-memory check returned 3,414,432 KB before the final full suite, above 3 GB. Free memory before the built-app checks was 7,322,788 KB. No final suite failure or isolated flaky-test retry occurred. The first app run's saved result was passed with no failed tests; its stdout was lost during context compaction, so the same four journeys were repeated to retain the exact output. SQLite experimental, jsdom canvas, fixture line-ending, dependency directive and color-environment warnings were non-failing.

The built Windows app verifies stable/Owl ordinary Send/reply, saved special-kind preservation, bridge gating, stable layout recovery, all five local-host-off room refusals, and immediate in-flight-limit coordination with saved settings. Light/dark, reduced motion and layout bounds pass at 1600 by 1000, 1280 by 800 and exactly 820 by 560 CSS pixels. No paid provider or user profile was used.

Visually inspected the fresh [Owl dark](../../artifacts/watcher-gate/wakeups-greptile-owl-dark-820x560.png) and [stable light](../../artifacts/watcher-gate/wakeups-greptile-stable-light-820x560.png) captures. Sidebar, transcript and composer fit; stable hides the preserved Watcher rows, while Owl exposes them. Each selected PNG matches the inspected run image byte-for-byte, is not ignored, and is 1230 by 840 device pixels at this laptop's 150% display scaling. Main bundle timestamp: 13:43:52 local, October 12; captures: 13:48:20 (Owl) and 13:48:14 (stable).

Failed GitHub reads overlay unavailability on retained facts without inventing new observation times. Recovery tests cover missing metadata, same-fact replay, newer saved checkpoints, explicit PR unlink/link changes, full evidence projections, and stopped/retired ownership fences. Follow-up tests cover partial pruning of paused and failed news and explicit return to queued. Existing babysitting integration and fake-provider finish/question/failure proofs passed in the full suite.

News still answers or grants nothing, and never restarts a worker Watcher stopped. Stable constructs none of these observers and preserves saved records. No Watcher poll timer, production dependency, renderer edit, phone restriction or new network host was added. Private cache bounds and recovery wiring do not widen the room envelope. Files retain their original line endings and UTF-8 without a BOM.

All three findings are fixed locally. Packaged/installed builds, paid native-provider turns, macOS, Linux and phones were not exercised and are outside this follow-up. This run performed no push, rebase, stash, branch switch, worktree creation, publication, installation or nested review. The lead owns remote delivery and pull request #957. There is no unfinished implementation or required gate.
