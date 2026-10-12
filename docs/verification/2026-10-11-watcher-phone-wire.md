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
