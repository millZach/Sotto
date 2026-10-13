# Watcher phone wire, October 11, 2026

Windows x64, `feat/watcher-phone`, based on ticket 5's `feat/watcher-hosts`. The implementation and decoder commits are `3cb736fdd`, `9f86f3b48`, `5d0c8bce0`, `b6ddf5238`, `da592927c` and `43cfc4fbf`. No source under `src/renderer/` changed. Nothing was pushed, merged, rebased, stashed, published or installed beyond the expressly requested `npm ci`. The lead owns integration, PR review and CI.

Native Swift compilation/XCTest, Android compilation/tests and physical-phone behavior are **not verified**. Windows has no `swift`, `java` or `gradle` command, no JAVA_HOME, and no Java or Android Studio JBR in their usual installed folders. The Gradle wrapper exists, but without a JDK it was not run and nothing was installed. Ticket 8b owns the native UI; this ticket supplies its wire and decoder foundation.

## Contract and policy

`3cb736fdd` froze the initial optional host-v1 features and types before implementation. The run folder's `phone-contract.md` records request/result shapes and refusals; `src/shared/watcherPhone.ts` and `docs/host-protocol.md` are the source contract. `watcher-phone` and `watcher-phone-stop-all` are served only by the Owl desktop's paired-phone listener. Headless/administrative listeners and stable desktops offer neither. Only opted-in clients receive optional `shell.watcher`; existing shell pushes update it, so old phones receive no unknown operation or push form. Current/retired Watcher rows, events, drafts and private project choices are excluded from ordinary phone navigation, using retained text-free identities even when stable hides its threads. Records are preserved.

The page includes the current Watcher, recent conversation, reply-grouped receipt rows, watched workers' owning targets and provider names, capacity, working state and owning request cards. Missing retained reply history yields an unattached receipt rather than a user-message anchor. Each reply has one row per thread, showing that thread's latest action. No control digest, local tool token or undisplayed tool-call identity crosses the projection. Optional draftDeliveries and ordinary command receipts reconcile lost acknowledgements without replay. Phone Send uses an exact draft revision, authenticated origin and current target; it cannot answer a pending Watcher card. Busy sends refuse and retain their draft.

Local master/worker answers are the user's explicit existing answer command, with Can answer checked again after native preparation. Answering does not take over; direct phone Send to a worker does. Remote cards retain their owning host/thread IDs. They require the phone's existing connection and Can answer on that owning host; the desktop does not lend its own remote-answer grant to the phone. This conservative boundary follows the brief's existing policy on that computer; no relay policy was inferred from the unanswered optional clarification.

Stop all is user-only, with a sixty-second preview bound to the paired client's ID, exact eligible targets and ownership. Another client's, consumed, changed or expired preview refuses before stopping; each target is checked again at dispatch. It excludes the master, user-started and taken-over workers, and keeps individual partial/uncertain outcomes visible.

ADR-0073, plan sections 7 and 12, CONTEXT and host protocol record Zach's October 11 reversal and all seven prototype picks, including user-only 4B answers, existing alerts without Watcher-finished alerts or push, the 6B edit-permission consequence and keyboard dictation.

## Verification

Eight raw-socket phone cases pass against the production socket server, real workspace/coordinator and controlled native-provider fixtures. They cover old/new opt-in, desktop/stable/administrative feature absence, forged/wrong-host/retired origins, exact-draft deduplication and receipt recovery, the no-Can-answer computer default including Allow edits, pending-card send refusal, grouped replies and remote card ownership, allowed/refused/stale worker answers, policy revocation while preparation waits, direct phone takeover and exact Stop all confirmation. The earlier focused gate/HostService run passed 29 tests in three files, exit 0 in 6.18 seconds. The final focused phone, socket-feature and privacy run passed 30 tests in three files, exit 0 in 11.87 seconds. The first grouped-reply fixture exposed the missing master observation; explicit read/opt-in now loads and keeps its real conversation current.

Six new XCTest cases cover the page, providers, grouped receipts, explicit origin, exact native worker choice, refusal/send/Stop decoders and tolerant optional shell decoding. Android tests cover optional kind/participation fields and unchanged old hello behavior. These cases were written but not natively executed here.

I walked the supplied prototype with its own script, using this worktree's Playwright dependency and keeping new outputs under the ignored evidence folder. All eight flows passed. I inspected the 4B answer and Stop all captures. Those are checks of the selected reference, not proof of a native phone UI. The controlled raw TCP/WebSocket tests are this ticket's executable surface; no live provider, packaged desktop, Tailscale TLS path, simulator or physical phone was exercised.

## Ordered gates

The initial full suite was deliberately stopped on its verified owned process tree to close the old-phone private-project picker gap. Its typecheck/lint had passed, but its partial suite is not a pass. Recorded process trees were stopped and their remaining child PIDs checked; a reused Windows service PID was left alone. No owned child remained. The next run exposed a real regression in the existing future-host compatibility fixture: private project filtering inspected host.threads on an administrative listener whose host was deliberately an unreadable future shape. That partial run was stopped, and da592927c limits the projection to phone listeners. The original file and all seven phone cases then passed together: 18 tests in two files, exit 0 in 13.37 seconds. A further projection review and failing focused assertion confirmed that native routing guidance was visible in the phone conversation. That partial suite was stopped before changing source. Commit 43cfc4fbf strips only the exact main-issued footer on known user messages, preserves the native transcript and assistant words, and prevents a receipt with missing reply history from attaching to a later user instruction's reply. The final ordered sequence runs all corrections; none of the three stopped suites is counted as a pass. The final sequence below runs on the corrected source with UTF-8, BOM-free logs in ignored `artifacts/watcher-phone-wire/`. Final full-suite free memory: 6,990,812 KB. Earlier runs had 10,560,044 KB, 8,193,672 KB and 9,903,672 KB.

The first complete corrected-source suite had one failure in sendWrites.test.ts: the Claude measurement observed two agents.json fsyncs instead of one. It passed 778 files and 9,677 tests, skipped 59 files and 284 tests, and failed one case in 1,400.13 seconds. All Watcher phone cases passed. The five-case isolated rerun passed in 5.59 seconds. Source inspection confirms this fixture uses an ordinary manual-send coordinator, constructs no phone service and never enters the newly added atomic phone send or card-answer paths. The extra write's cause under load remains unconfirmed; no production behavior, assertion or deadline was changed to hide it. Logs are retained under load-failed-*. The final complete ordered sequence passed on the same implementation source, 43cfc4fbf, without another send-write failure:

| Command | Observed result |
| --- | --- |
| npm run typecheck | Exit 0; all four projects |
| npm run lint | Exit 0 |
| npm test -- --maxWorkers=2 | Exit 0; 779 files and 9,678 tests passed; 59 files and 284 tests skipped; 1,442.80 seconds |
| npm run notices:verify | Exit 0; 189 components |
| npm run build | Exit 0; main, host, preload and renderer |
| npm run test:socket | Exit 0; 23 files and 474 tests passed; 10 tests skipped; 188.38 seconds |
| npm run build:host | Exit 0; plain Node host, 206 modules; 2.05 seconds |

The main bundle timestamp was 20:16:07 local and the final host bundle was rebuilt at 20:19:44. No design baseline changed. The build is local output, not a package, installation or deployment. The lead owns the two-axis PR review and native CI after pushing. Ticket 8b still owns the native tab, alerts, provider logos, owning-host answer routing and device/simulator proof; Android UI is later. Busy Watcher sends refuse and retain their draft; this contract adds no phone queue operation.

A final process inventory found no worktree-owned test, provider, Electron or SSH process remaining. Codex's own tool-runtime kernels were left alone. No persistent server was started and no installed app was changed.

## October 12, 2026: ticket 8a review corrections

Native validation remains unverified: Swift cannot be compiled on this Windows laptop; no Swift executable is available. Android has no Java or Gradle executable, JAVA_HOME is unset, and the usual JDK/JBR directories are absent. No native test result is claimed and no additional software was installed. Ticket 8b still owns the iPhone UI and device proof.

Merged 3b3a9ac3f with a merge commit, 2b0c5355d. Four content conflicts were resolved and named in its body: .gitignore retains both evidence rule sets; ADR-0073 retains the phone decisions plus restart, held-news and GitHub fact fixes; host-protocol.md retains the phone wire and owning-host sourced facts/progress; watcher.ts retains phoneSnapshot alongside owningSnapshot and its host-qualified lookup. The automatic merges retain the private phone paths alongside ticket 5 identities and #949 host defaults. No watcher-hosts files were changed. The two pending ticket 5 review fixes remain for the lead to integrate later as directed.

Finding 1 is fixed by a provider-change check at phone admission and dispatch, retained in the writer guard. A real held provider change reproduced an accepted socket send before the fix. The regression now refuses at admission and independently checks an already tagged phone command at dispatch, with no native send.

Finding 2 is fixed by a client-bound pending/completed Stop all receipt. Optional receipt.watcherStop retains the exact outcome and partial results without a stale page snapshot. The regression reproduced unknown while pending, then verified recovery after discarding the acknowledgement and reconnecting, no repeated stop, another pairing seeing unknown, and changed confirmations refusing. The receipt uses the existing bounded five-minute settled in-memory replay window; it does not survive a listener restart. The dated phone-contract.md and host-protocol.md update describes this optional shape. Feature names and operation/request/reply shapes stay unchanged. SottoCore decodes the optional outcome; Android continues ignoring it safely, with an unrun decoder case added.

Finding 3 is fixed by deriving watched marks from participating workers in active requests owned by the current host-qualified Watcher. Its regression failed after a real Stop all before the fix. It now checks the page and ordinary worker row, stopped/closed requests, and another host with the same master thread ID while preserving historical participation.

Finding 4 was already fixed in the requested ticket 5 merge: Stop all forwards its guard into executeRemote, which checks it before and after persistence. Two new regressions revoke a real phone pairing while queued and dispatching remote stop persistence is held. Both pass and send no stop to the owning host; disabling the forwarded guard makes both fail with an owning-host control call. No duplicate production correction was added.

Findings 5 and 6 share a commit: one private Swift status validator serves all typed Watcher results and the new receipt; one strict phone origin schema serves the send wire and persisted request. XCTest covers unknown/missing/invalid statuses and refusals across all five decoder forms. The shared schema case covers invalid hosts, client ID bounds, kinds and extra authority fields. The focused phone/shared suite passed 37 cases in two files; the two remote guard cases passed separately.

The first ordered run stopped at typecheck because the new synthetic ClientIdentity lacked user. Commit 5061d1b94 fixes the test fixture; the complete sequence was restarted. Commit fb01454a4 corrects a PowerShell apostrophe substitution in wording. No source assertion or deadline was weakened. UTF-8/no-BOM and consistent line endings were checked for the 14 implementation/test/contract files before this verification update, and the final text files were checked again. Production dependencies remain exactly zod, node-pty and sherpa-onnx-node. No manual renderer edit, push, rebase, stash, branch switch, new worktree, publishing or additional software installation occurred.



The complete required sequence passed on implementation commit 5061d1b94. The full-suite memory check recorded 5,725,616 KB, above the 3 GB threshold. Other suites were allowed to finish before this full suite began. The waiting launcher was stopped only after test/notices passed to remove its overly broad queue for the remaining smaller gates; their order and real output were preserved. No failing full-suite/socket case needed a flaky rerun.

| Command | Observed result | Seconds |
| --- | --- | --- |
| `npm run typecheck` | Exit 0; All four TypeScript projects | 72.24 |
| `npm run lint` | Exit 0; ESLint | 33.06 |
| `npm test -- --maxWorkers=2` | Exit 0; 787 files / 9,985 tests passed; 61 files / 300 tests skipped | 1526.84 |
| `npm run notices:verify` | Exit 0; 189 notice components | 0.49 |
| `npm run build` | Exit 0; Main, host, preload and renderer | 51.16 |
| `npm run test:socket` | Exit 0; 23 files / 480 tests passed; 10 tests skipped | 271.31 |
| `npm run build:host` | Exit 0; Plain Node host | 3.94 |
| `npx playwright test tests/e2e/watcher-gate.spec.ts tests/e2e/watcher.spec.ts` | Exit 0; 17 built-app journeys passed | 101.42 |

Real output is retained in ignored artifacts/watcher-phone-wire/review-*.log and normalized review-gates.json (the original PowerShell array nesting is retained in review-gates-raw.json). The initial typecheck failure and each failing/passing regression are retained separately.

The Playwright journeys ran the current built Electron app and covered Owl/stable gating, saved records, ordinary worker actions, the private room with its host off, dynamic in-flight limits, first send, Overview focus/Escape, the beside pane, badges, keyboard order, both themes and appearances at three sizes, reduced motion, long/disconnected/empty cases, and main's own Watcher over the fake Codex app server. Three inspected desktop captures are retained: artifacts/watcher-phone-wire/review-owl-dark-minimum.png, review-owl-light-worker-card.png and review-stable-dark-minimum.png. The Owl room and worker permission pane remain usable at minimum size; stable shows ordinary threads and no Watcher. These are desktop smoke checks, not iPhone or live-provider proof. No design baseline was regenerated.

New commits, in order:

- 2b0c5355d Merge ticket 5 into the Watcher phone branch
- f7215eac1 Fence phone instructions during Watcher provider changes
- 13ed63b4d Retain Stop all outcomes for phone receipt recovery
- 3d74a392c Clear watched badges when Watcher requests stop
- b80ce9892 Prove revoked phones cannot stop remote workers
- d7fdd234b Share Watcher result status and phone origin validation
- fb01454a4 Correct the provider-change refusal and receipt note encoding
- 5061d1b94 Complete the synthetic phone identity in the dispatch regression

No requested host/wire review fix remains unfinished. Native compilation/tests, actual phones and live providers remain unverified as described above. The branch is local and unpushed; the lead owns integration and the pull request.

## October 13, 2026: ticket 8a Bugbot corrections

Base: 5353df2a8 on feat/watcher-phone, with the lead's main/ticket 5 merge and test ceiling correction. PR #986 is owned by the lead. No push, merge, rebase, stash, branch switch, new worktree, extra software installation or nested review occurred. No apps/ios file, desktop renderer file or watcher-iphone worktree was touched.

Both reports were reproduced over the real socket integration fixture before changing production code: one phone's unchanged Stop all preview refused after another phone opened seventeen previews, and the exact answer retry after reconnect refused despite its receipt reporting completed and answerDelivered true. bugbot-red.log records both failing cases.

920dcc904 Keep live Stop all previews when another client opens more fixes the mismatched 16/64 caps with one shared 64-preview limit. Both stores refuse a new preview at capacity instead of evicting a live one. Expiration and consumption release space. The existing IN_FLIGHT_LIMIT refusal says too many previews are open; no live preview is dropped for space, so none can be misreported as changed or expired. The regression verifies seventeen previews by a second phone, full-capacity refusal in both layers, the first phone's confirmed stop and recovered capacity after expiry. It passed in 5.50 seconds of test execution.

cf4678f7e Replay Watcher phone answers before checking fresh cards moves the existing target/card/Can answer admission behind receipt lookup. The receipt digest binds the operation, owning target and exact answer. Replay reads the completed outcome with fresh state without a new answer or a new grant; an unrelated fresh-shell error cannot replace that outcome. New requests retain target, card, policy and writer checks. The regression verifies discarded acknowledgement, reconnect, removed card, revoked Can answer, changed target/answer conflicts, client isolation and a denied fresh card. The native adapter receives exactly one answer. It passed in 2.31 seconds of test execution.

The combined phone, client-isolation and answer-recovery run passed 39 cases in three files (22.02 seconds, exit 0). No production debug logging was added. The implementation remains behind the existing Owl gate, and production dependencies remain exactly zod, node-pty and sherpa-onnx-node. The six changed text files were checked for UTF-8 without a BOM and consistent line endings.

No refusal code, feature name, operation or wire shape changed. phone-contract.md and docs/host-protocol.md have dated behavior notes for capacity and answer replay; unconfirmed mutations are still never retried automatically. Reading a prior answer outcome grants no new authority and answers no new card.


The required ordered run passed typecheck and lint. The full suite has not started: it has waited more than an hour while new full runs continually start on the shared laptop. The machines skill says "Run one heavy job at a time per machine." The existing resource watcher continues waiting for active full suites and will check FreePhysicalMemory with the required command before starting; under 3 GB it waits. Two leftover Vitest processes have no Node workers and negligible CPU over more than ten minutes, so the queue excludes them only while they remain idle. Only this branch's waiting launcher was restarted to make that distinction; typecheck/lint results were retained. No other process was stopped. At the last observation, active full-suite PIDs 74660, 31176 and 49436 still held the queue. This is pending validation, not a completed gate run.

| Command | Observed result | Seconds |
| --- | --- | --- |
| `npm run typecheck` | Exit 0; all four TypeScript projects | 105.10 |
| `npm run lint` | Exit 0; ESLint | 29.69 |
| `npm test -- --maxWorkers=2` | Pending; queued in this order | - |
| `npm run notices:verify` | Pending; queued in this order | - |
| `npm run build` | Pending; queued in this order | - |
| `npm run test:socket` | Pending; queued in this order | - |
| `npm run build:host` | Pending; queued in this order | - |
| `npx playwright test tests/e2e/watcher-gate.spec.ts tests/e2e/watcher.spec.ts` | Pending; queued in this order | - |

Real output is retained in ignored artifacts/watcher-phone-wire/bugbot-red.log, bugbot-preview-green.log, bugbot-answer-green.log, bugbot-focused.log, bugbot-typecheck.log and bugbot-lint.log. bugbot-gates.json records completed commands only. The active resource watcher is bugbot-resume-gates.ps1, PID 38444, exec session 63853; it will record the remaining results in bugbot-*.log and bugbot-gates.json. No complete-run, built-app or new screenshot claim is made. The final verification table and desktop inspection must be completed after those gates finish; no gate is waived.

Swift and Android are unverified locally. This Windows laptop has no Swift compiler, Java/Gradle executable or JAVA_HOME; no additional software was installed. Actual phones and live providers are also unverified. No native file changed in these Bugbot fixes. Both requested code corrections are implemented and committed; the six remaining gates and final desktop proof remain unfinished. These commits are local and unpushed; the lead owns PR #986 and integration.
