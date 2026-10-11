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
