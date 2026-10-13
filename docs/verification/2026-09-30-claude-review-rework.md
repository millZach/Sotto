# Claude review rework

PR #623, review follow-up on Windows. All six review findings were confirmed and addressed.

- Changed personal context stays pending while background work runs. A send reaches the same process with its previous context; the first send after the work ends restarts with the latest context.
- Configuration cleanup retries temporary Windows locks and logs only `claude-mcp-config-cleanup-failed` if removal still fails. Cleanup cannot replace a launch error or fail reconnect. Connect removes leftover configuration files before starting a client.
- Overlapping transcript callers share a queued read. A caller sees text appended during the previous read and finishes without waiting for later poll arrivals.
- A failed answer remains available. The existing **Check again** action reopens a Claude request for a new explicit answer, through both personal chats and project threads. Checking sends nothing. Earlier uncertain decisions remain evidence; a restored request cannot replay an old answer without checking it first.

The answer-recovery flow was prototyped with the existing controls. The throwaway HTML is retained on the local `prototype/claude-answer-retry` branch at `3b07bf5c414a317f41c9ad1fb1043feb844da11b`; it is outside this PR's production tree. The chosen flow follows the review's explicit-retry option and adds no new control or layout.

## Checks

- Regression tests were observed failing for sends with changed context, transcript appends during a joined read, uncertain-answer retries, continuous poll arrivals, leftover files, failed reconnect cleanup, and a cleanup failure replacing a configuration-write error.
- The five focused files covering Claude safety, restored-request replay protection, personal-chat rendering, request drafts and request-draft delivery passed: 99 tests. The application-level cases exercise both the personal chat service and the coordinator; the renderer case checks that **Check again** sends no answer before enabling a new choice.
- The first complete suite found a restored-request replay regression: 6,403 passed, 153 skipped, one failed. It was fixed without changing that replay-protection test. Final gate results are recorded in the PR.
- Local rework gates before the base sync passed: `npm run typecheck`, `npm run lint`, `npm test -- --maxWorkers=2` (6,408 passed, 153 skipped), and `npm run notices:verify` (174 components).
- `npm run build` and `npx playwright test tests/e2e/thread-activity.spec.ts tests/e2e/phase-three-personal-requests.spec.ts` passed: five cases. The complete-app personal request case also passed in a separate capture run.
- Independent Standards and Spec reviews used gpt-6.1-sol at high reasoning. The first Spec review caught application-level retry blockers; those were fixed and both final reviews reported no material findings. The CLI's Windows read-only sandbox initially failed before file access; reviewers were retried with working process access and explicit read-only instructions.
- After Windows CI passed on the rework, `origin/main` at `475e6da2` was merged without conflicts. Its four-file delta concerns socket frames and Devin RPC behavior. Typecheck, lint and notices passed again; the affected socket/Devin files and Claude regressions passed together (160 tests, eight skipped). The app rebuilt and all 16 `tests/e2e/app.spec.ts` cases passed. The PR records Windows CI for the synchronized revision.
- A final recovery assertion reproduced a stale personal-chat uncertainty notice after a confirmed retry. The service now clears that specific notice on confirmation. The three focused safety/service/renderer files passed (81 tests), typecheck/lint/notices passed again, and the rebuilt complete-app personal request case passed. The earlier uncertain decision remains recorded.
- `main` then moved to `64e6fa65`, causing a README conflict that prevented GitHub from starting CI for the latest push. The merge keeps both the incoming project-defaults paragraph and the corrected Claude context/retry paragraphs. Typecheck, lint and notices passed on the combined branch; seven affected files passed (343 tests). After rebuilding, `app.spec.ts`, `new-thread-settings.spec.ts` and `phase-three-personal-requests.spec.ts` passed all 20 cases.

## Rendered check

[The complete app retains the selected answer after a refusal](../../artifacts/thread-activity/personal-requests-retained-choice.png). The synthetic personal chat's question form, selected choice, separate composer and sidebar are readable in the running Electron app. The screenshot establishes the retained choice; the test separately asserts the refusal notice and successful explicit retry.

Activity captures were inspected in light and dark at the minimum width, including reduced motion. Their transcript is readable, but the isolated activity fixture lacks the full sidebar styling and does not establish whole-window design quality. Existing activity captures were restored; no baseline was regenerated.

## Limits

These are scripted-provider checks on Windows. Live Claude background-task ordering and macOS file modes were not checked in this follow-up. The existing permission policy and provider boundaries remain in force; no answer is sent by checking or refreshing.


## Second review

The second review found four remaining defects; all were confirmed in the code.

- A stdin deadline now keeps the original write pending. Check again cannot enable another choice until that write fails outright or the client is gone. A late success removes the pending request and confirms the original personal decision or project question receipt. A native callback error or destroyed pipe ends that in-flight write and permits an explicit retry.
- A queued transcript read runs after the preceding read rejects. Its caller receives its own outcome.
- Committed memory deletions notify the personal service of every purged supersession-chain ID. A client using one of those IDs restarts on the next send, stopping background work. Ordinary retrieval changes continue to wait for background work. The adapter remembers the running context's IDs separately from the latest retrieved set, so a retrieval miss cannot hide a later deletion.
- The guide points to Sotto's Check again, activity and Stop, and explains pending writes and late confirmation. The overview, glossary and personal-chat ADR describe the memory deletion exception.

The delayed-stdin regression failed on the previous PR head: two answers reached the fake CLI instead of one. The queued-read regression also failed there, forwarding the first read's error rather than running its own pass. Additional checks cover late personal decision confirmation, an exact project question receipt, a callback failing after the deadline, destroyed stdin, committed deletion and rollback, subscription disposal, and restarting background work after deletion despite an earlier retrieval miss.

The existing recovery flow was checked in a throwaway state prototype on the local `prototype/claude-delayed-answer` branch at `3942a95b`. Its guided cases cover late success, outright failure and Stop; its rendered layout was inspected. The review itself supplies the required behavior. No production UI layout or design baseline changed.

Second-review checks:

- `npm run typecheck`, `npm run lint` and `npm run notices:verify` passed; notices verified 174 components.
- The final focused Claude safety, request-draft delivery and personal recovery run passed 81 tests. Three late project confirmation cases check the uncertainty banner after no intervening action, a draft save and a newer error.
- `npm run build` and `npx playwright test tests/e2e/thread-activity.spec.ts tests/e2e/phase-three-personal-requests.spec.ts` passed all five cases. The complete-app request journey covers exact approval, a structured answer, an outright refusal and retained input. The activity cases cover failed-turn feedback, keyboard expansion, minimum-width transcript readability, light/dark themes and reduced motion.
- [The complete-app capture](../../artifacts/thread-activity/personal-requests-second-review.png) was inspected. It uses the common request form with a scripted Codex provider and establishes retained input after an outright refusal. The delayed Claude write and its receipts are verified by the adapter/service/coordinator regression tests, not by this image. The isolated activity fixture still lacks full sidebar styling, as recorded above; these captures do not establish whole-window minimum-size design quality. Generated activity captures were restored and no design baseline was regenerated.
- Independent Standards and Spec reviews used gpt-6.1-sol at high reasoning. The Windows read-only sandbox again failed before file access, so both axes were retried with working process access and explicit read-only instructions. Standards found no documented violations; its suggestions to consolidate write state and error-setting were applied. Spec found a stale project uncertainty banner after late confirmation; that regression was observed failing, fixed and extended to preserve newer errors. The final Spec review found no remaining findings. The shared error-setting cleanup then passed the focused 81-test run and typecheck/lint.
- The first full run overlapped review corrections and was cancelled after it picked up mismatched source/test revisions. The fresh `npm test -- --maxWorkers=2` run passed 6,438 tests with 153 skipped (483 files passed, 39 skipped). Windows CI on the final synchronized pushed head is recorded in the PR.

After Windows CI passed on `f6d0fd6d`, `origin/main` at `d343d76a` was merged. The only conflict was the client-update ADR reference beside the new personal-memory deletion hook; both were preserved. The combined branch passed typecheck, lint and notices again. The changed main-branch unit/integration files and five Claude delivery/memory regression files passed together with two workers: 352 tests passed, one live-provider test skipped (22 files passed, one skipped). The app rebuilt, and the personal requests, thread activity and Git action Playwright journeys passed all six cases. The retained-input capture and the incoming Git commit dialog at minimum size were inspected; generated activity captures were restored. The final synchronized Windows CI result is recorded in the PR. Incoming iOS changes are outside the local Windows verification.

### CI causes and the next base sync

Windows CI on `d0741aa5` failed two fixture tests (6,493 passed, two failed, 150 skipped). Stopping the Claude fixture's timer left an active read in flight, so the queue test's callers could join that read rather than start the passes its barriers expected. Starting a read before installing its spy reproduced the same count failure. The three queue tests now drain any active read before installing their barriers; their exact counts, continued-arrival checks and caller-outcome assertions are unchanged.

The host-update restart failure reproduced five times across 90 repeated scenarios. A trace captured the fake host acquiring its lock and opening its listener, then failing its descriptor rename with Windows `EPERM`; the open listener kept the child alive until the launcher timed out and rolled back. The standalone fixture now retries only atomic replacement on temporary `EPERM` or `EBUSY`, preserving the destination, with bounded backoff. The two injected rename cases fail on the original fixture and pass with retry after correcting their preload argument to a Windows file URL. The corrected three-version update passed 30 repeated runs. Temporary diagnostics and repeated test definitions were removed. Production restart behavior and existing assertions and deadlines remain unchanged.

The five Claude delivery/memory files passed 106 tests; the three launch/update/SSH files passed 72 with three platform cases skipped. Typecheck, lint and notices passed again. Independent Standards and Spec reviews of these two fixes found no findings. The fresh `npm test -- --maxWorkers=2` run passed 6,494 tests with 153 skipped (487 files passed, 39 skipped).

Main then moved to `df0a0468`. Its coordinator now records answer attribution before delivery is confirmed. The merged late-callback path initially recorded it twice; all three existing late project-answer cases reproduced that failure. The callback now settles the receipt and its exact uncertainty error without a second attribution record. The Stop-handler conflict preserves main's validation and management restoration along with the shared visible-error setter. Independent Standards and Spec integration reviews found no material findings and no weakened verification.

The combined branch passed typecheck, lint and notices; the changed main-branch files plus Claude and host-update regressions passed 547 tests with one platform case skipped (22 files passed). The app rebuilt and all 24 Electron cases across `app.spec.ts`, `command-receipt.spec.ts`, `queued-steering.spec.ts`, `phase-three-personal-requests.spec.ts` and `thread-activity.spec.ts` passed. The complete-app retained-input capture and queued-steering light/dark minimum-size captures were inspected. Generated activity captures were restored. Final pushed Windows CI is recorded in the PR; the live-provider and local macOS limitations above still apply.

Windows CI run `36794039476` passed on `850b7658`: 6,538 tests passed, 150 skipped, and 174 notice components verified. Linux passed too; iOS was skipped by the changed-area gate. The closing fetch found `origin/main` at `f7339847`, a three-file thread-history redaction change, which merged without conflicts. Its ADR and redaction were inspected; the reviewed Claude behavior is unchanged. Typecheck, lint and notices passed again, as did 71 thread-store and Claude receipt/safety tests. The rebuilt personal request and activity journeys passed all five cases. Generated captures were restored. The PR records Windows CI for this last synchronized push.

Windows CI run `36795839402` passed on `f79dcc80`: 6,540 tests passed, 150 skipped, and 174 notice components verified. Linux passed; iOS was skipped. The closing fetch then found `origin/main` at `b6d4f35e`. Its host/socket and iPhone changes merged cleanly, including the fake-host boot-lease check beside the descriptor retry. The coordinator's socket receipt reports this command's delivery outcome; a removed request does not turn an uncertain answer into confirmed delivery. The native Claude callback hold and single attribution remain intact.

This base snapshot passed typecheck, lint and notices, followed by 283 affected host/socket/phone and Claude tests with three platform cases skipped (nine files passed, two workers). After rebuilding, the host identity, Hosts, Phones, personal request and activity journeys passed all eight Electron cases. The complete-app retained-input capture and minimum-size light host/phone captures were inspected. Generated activity captures were restored; no baseline was regenerated. The PR records Windows CI for the synchronized pushed revision. The incoming native iPhone changes were not compiled locally on Windows.


## Third review

The two remaining P2 findings were confirmed and fixed in new commits. Native CLI takeover is tracked separately from changed retrieved memories. The takeover forces the next send to resume the updated native history even while background work runs; ordinary retrieval changes still wait, and committed memory deletion still forces a restart. The existing takeover regression now leaves background work running before typing in the native CLI and checks that the next send resumes.

Answer uncertainty is recorded before observing its completion. The public command catch recognizes that already-recorded error and cannot restore it after delivery or overwrite a newer error. Both early cases use an already-resolved completion; both late cases resolve after awaiting the public command. The tests assert the actual completion/return order, receipt settlement, an empty uncertain outbox, and the final visible error.

A context restart uses the existing stopped-work notice, names what stopped, and explains that the provider session resumes with updated context before the pending message is sent. The shared wording applies to project threads and personal chats. The guide, coordinator documentation and ADR-0023 clarify the takeover boundary and the deletion exception.

Fetched and merged `origin/main` through `0a1da256` in `e8a56387`. The guide conflict preserves both the Claude uncertain-answer recovery paragraph and the incoming pane-zoom shortcut paragraph. Incoming protocol, storage, settings and renderer changes were retained.

Verification:

- The takeover and already-completed-answer regressions failed before their fixes: no native resume, and a delivered receipt with a stale uncertainty error, respectively.
- The four-file focused run passed 98 tests. After the final notice wording and explicit order assertions, the Claude safety, settings and request-draft files passed all 76 tests.
- Final `npm run typecheck`, `npm run lint`, and `npm run notices:verify` passed; 174 components verified. `npm test -- --maxWorkers=2` passed 6,662 tests with 153 skipped (497 files passed, 39 skipped), on the fixed final source.
- Rebuilt from the final source and ran `npx playwright test tests/e2e/thread-activity.spec.ts tests/e2e/phase-three-personal-requests.spec.ts`: five passed. The complete-app common request form retains a refused answer; the activity cases cover failed-turn feedback, keyboard expansion, light/dark themes, the minimum width and reduced motion. Native Claude ordering and takeover are established by adapter/coordinator regressions, not these scripted Codex captures.
- Inspected the complete-app question/retained-choice captures and the minimum-width light activity transcript. The isolated activity fixture still lacks complete sidebar styling and establishes transcript readability only. Generated captures were restored, and no design baseline changed.
- The throwaway state prototype is retained locally on `prototype/claude-third-review` at `b89cfaf3`, beside the adapter on that branch. Its guided cases cover early/late delivery, a newer error and deletion stopping work. Its rendered notice was inspected. The requested behavior is fixed by the review brief; no production layout changed.
- Independent Standards and Spec reviews used gpt-6.1-sol at high reasoning. Standards prompted the takeover documentation and full provider session wording; Spec prompted explicit ordering assertions in the newer-error tests. Final reviews found no remaining material findings. The initial read-only reviewer processes failed to access files because of Windows sandbox ACL setup; their successful replacements remained read-only by instruction.
- An earlier full run overlapped the notice wording edits and failed the deletion notice assertion with mismatched source/test versions. It was stopped and discarded. The final full run began after the source was fixed and stayed unchanged throughout that run.

Live laptop-wake and Claude background-task ordering, and macOS file modes, remain unverified locally. Restarting context does not erase earlier native conversation history. The PR remains open for review and is not merged.


### Later main sync

Main advanced while the full gate was running. Merged `origin/main` through `081d9afa` in `982ad492`, cleanly preserving the Claude fixes. Main's retired account dependency exposed two obsolete membership mocks in the PR-only Claude safety fixtures; typecheck caught both, and `afa4bec5` removes them. The error-completion ordering and answer attribution remain intact.

The combined revision passed 168 affected tests across ten files: Claude safety/settings, request-draft delivery, personal recovery, provider inherited pipes/final output, socket host, composer recovery, credential storage and the retired-account guard. The rebuild and seven Electron cases passed across the previous request/activity specs plus composer recovery and refused Codex approval. Inspected the complete-app minimum-size light composer recovery and refusal captures. The incoming captures remained unchanged; generated activity captures were restored.

Separate Standards and Spec integration reviews found no material findings. Typecheck passed after the fixture alignment; the final gate counts and pushed-head Windows check are reported in the PR.


On the synchronized source, `npm run typecheck`, `npm run lint`, and `npm run notices:verify` passed (174 components). `npm test -- --maxWorkers=2` passed 6,662 tests with 153 skipped (499 files passed, 39 skipped). The first Windows run on `af9d6276` failed only the two obsolete fixture properties, matching the reproduced local typecheck errors; the next push contains their fix. The fresh Windows result is linked from the PR.

### Final socket follow-up and main sync

Main advanced through `51d367db` while verification ran. Merged it in `da48fe76`; the README conflict keeps both Claude recovery paragraphs and incoming microphone cancellation guidance. The integrated source passed 387 affected tests across 13 files covering Claude recovery, turn diagnostics, checkpoints, shared themes and microphone controls.

The additional socket finding was confirmed by the independent Spec review and the subsequent PR follow-up. The authenticated-socket regression publishes request removal, then returns an uncertain provider result with an already-resolved true completion. It failed with the stale uncertainty error before `3986cc57`; it now returns a delivered receipt without that error. Existing disappearance-only cases still return false delivery receipts.

A further Spec review found completion during final command diagnostics could leave the socket response's cached failure unchanged. `09a23403` retains the original uncertainty object until the response is returned and checks its delivery state again. An independent persistence failure discards that uncertainty reference and keeps its own failure. The new authenticated-socket case resolves completion during turn recording, after the catch has already observed uncertainty; it failed with a false delivery receipt before the fix and passes afterward.

The final affected run passed 204 tests in five files: Claude safety/settings, request-draft delivery, authenticated socket and coordinator recovery. Typecheck, lint and notices passed (174 components). The final rebuild and all eight Electron cases passed in the request/activity, composer recovery, refused approval and checkpoint specs. Inspected complete-app retained-answer and checkpoint captures at minimum light and full-size dark; generated activity/checkpoint captures were restored. No design baseline changed.

Both independent final Standards and Spec reviews found no material actionable findings. The full local suite was restarted on the fixed source after the socket findings, and its final count and fresh pushed-head Windows result are recorded in the PR. Earlier incomplete full runs stopped to fix those findings are not counted as passes. Replies on both actionable PR comments name their fixing commits. The PR remains open and unmerged.

That final local full run completed with 6,733 passed, two failed and 154 skipped (500 files passed, one failed, 39 skipped). Both failures are in the unchanged `codexSessionProcesses.test.ts`: reply observation won the race against the following turn-completed event before immediate status assertions at lines 68 and 132. This file exercises the Codex adapter directly and has no diff against main. Its isolated rerun passed all five cases in 3.45 seconds with no source or test edits. As the original brief directs for unrelated shared-machine failures, the PR reports this isolated rerun explicitly; this local full run is not labeled a clean pass. The separate Windows full gate remains the final CI requirement.

The Windows run on `2f00da76` passed typecheck, lint and 6,757 tests, but failed one unchanged SSH-launcher test at its 15-second test deadline. The exact readiness/forwarding case and all 40 neighboring SSH tests passed in the isolated rerun (48.71 seconds for the file); no assertions, deadlines or launcher code changed. The timeout's precise CI cause is not established. This failed full run is not counted as green; the next pushed revision must pass a fresh Windows gate.

Merged `origin/main` through `906776d0` cleanly in `d9a52cc3`, including phone cleanup and iOS tests, before the next CI attempt. The affected phone-access, phone-settings and authenticated-socket run passed all 102 tests across four files. Typecheck, lint and notices passed (174 components). Rebuilt the app; the phone-settings Electron journey passed through setup failures, pairing, explicit answer authority and shutdown. Inspected its minimum-size light ready state and full-size dark paired-phone state. Its captures stay in ignored test output; no committed capture changed. The Claude coordinator and adapter fixes are unchanged by this main sync. Final integration review results and pushed-head CI are recorded in the PR.
