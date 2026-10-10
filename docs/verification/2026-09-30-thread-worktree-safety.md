# Thread worktree removal, restore and setup recovery

October 9, 2026: Voice control and thread management described below are historical under [ADR-0067](../adr/0067-remove-voice-control-and-thread-management.md); the original plan or evidence is retained.

Package pkg-03: #485 (S-003), #506 (S-026), #507 (S-027). Windows verification uses real Git, synthetic projects, a fixture provider and the built Electron app. No personal profile or live provider was used. Actual macOS execution remains unverified.

## Accepted removal question

The owner chose variant B, **List and tick**, in the removal-question prototype. The implemented layout keeps that decision. The implemented question was visually compared with B.

The Electron journeys check:

- A clean question says the branch stays and sending restores the folder. Escape keeps it.
- Ignored items appear as relative paths; installed dependencies do not. Each ignored folder has one size/file-count row. The single-item label uses **Delete this 1 ignored item with the folder**.
- The callout says **These files are ignored by Git and are deleted with the folder:**. The button says **Remove with these files** and requires the separate tick.
- Adding another ignored path, or adding a file inside an already listed folder, refuses removal. The pane and Settle questions show main's folder-change message and ask for Remove worktree again to see the new list.
- Nested work is flagged with a plain count of uncommitted changes, without raw Git status. Repositories also show commits not on any remote. The tick names repositories or worktrees and uses the plural for several. The checked tick uses the danger theme role. Escape preserves the nested files; later acknowledged removal deletes them with the folder.
- Dirty removal keeps the branch; the next send restores the committed checkout. Settle asks the same question, and Keep folder preserves it.

Checked at 1600x1000, 1280x800 and 820x560, light and dark, with reduced motion on and off. Heading, tick and actions remain visible at the minimum. Recaptured and visually inspected:

- `artifacts/reclaim-worktrees/ignored-items-1600x1000-dark-no-preference.png`
- `artifacts/reclaim-worktrees/ignored-items-1280x800-light-no-preference.png`
- `artifacts/reclaim-worktrees/ignored-items-820x560-dark-reduce.png`
- `artifacts/reclaim-worktrees/ignored-items-820x560-light-reduce.png`
- `artifacts/reclaim-worktrees/nested-items-1600x1000-light.png`
- `artifacts/reclaim-worktrees/nested-items-820x560-dark.png`

These six captures are deliberate evidence for the changed question. Incidental captures were restored; design baselines were not regenerated.

## Main and transport regressions

Removal compares the confirmed ignored folder rows and nested-change counts with disk. Added or removed files inside an acknowledged ignored folder refuse removal. Existing cache files may be rewritten; byte sizes are not compared. New ignored or untracked paths injected during the final filesystem walk are refused by the Git re-list immediately before removal. Ignored and untracked nested repositories/worktrees require the tick. Synthesized nested rows count ignored contents too. Acknowledged nested worktrees are deleted, then their own repositories clear only those registrations; their branches and unrelated missing registrations remain. Locked nested worktrees refuse before deletion. A bare repository inside dependency content also requires acknowledgement. Outside links still block removal.

Clean initialized submodules, including recursive submodules, are classified against their containing index and can be reclaimed automatically. A dirty submodule hidden by user Git settings still produces a truthful warning and can be removed only with explicit acknowledgement. The clean-settle refusal tells the user to choose Remove worktree, without referring to an unopened question.

Coordinator and authenticated socket tests prove that the preview is returned only to the requesting command: it is not saved, broadcast or cached, and another paired client never receives it. Router tests cover older hosts returning no preview or refusing the command with a plain update message.

Restoring a missing checkout removes only that checkout’s registration; other missing worktrees keep theirs. Setup retains its five-minute add deadline and ordinary commands keep thirty seconds. The writing-grandchild regression fails with single-process termination and passes with whole-tree termination. Cleanup waits for exit and successful tree termination; a failed taskkill returns a refusal and keeps the folder.

Existing recovery regressions cover complete/partial initialization, missing and unfinished indexes, local edits, a 28,000-entry branch tree and committed internal links. The Windows internal-link test uses Git’s file representation with `core.symlinks=false`; its POSIX branch uses real symlinks.

## Review and gates

Separate read-only `gpt-6.1-sol` reviews at high reasoning checked Standards and Spec. They found remote preview reply loss/cache propagation, final-list timing, recursive submodules, stop-failure handling and inconsistent submodule visibility. All findings were fixed and rechecked. The parent inspected the integrated diff and rendered captures.

Full-suite worktree fixes: `cc52060b`.

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test -- --maxWorkers=2`: 6,416 passed, 153 skipped; 483 files passed, 39 skipped. No failures.
- `npm run notices:verify`: passed, 174 components.
- `npm run build` and `npx playwright test tests/e2e/thread-worktrees.spec.ts --workers=1`: all five passed.
- Final focused worktree/timeout regressions: all 50 passed.

`origin/main` at `ff2c8c9e` was merged without conflicts before these final checks.

The earlier full run overlapped review edits and failed four new cases: prompt refusal after failed taskkill, setup/restore registry coordination, clean recursive submodule removal and a bare repository inside dependency content. Those cases passed on corrected, committed source before the fresh final full run. The initial run also reported an after-test cleanup error for the taskkill fixture. No deadline was shortened and no assertion was skipped to pass the gates.

Subsequent `origin/main` changes were merged without conflicts: socket frames (`475e6da2`), retained-history deletion (`cb38c1bd`) and project working-copy defaults (`64e6fa65`). Affected regression runs passed 77 socket/preview tests, 214 history/IPC/removal tests and 153 settings/worktree tests. Built Electron runs passed all 22 app/thread journeys after the history merge, and all seven new-thread-settings/thread journeys after the defaults merge. Typecheck, lint and notices passed again on the latest merged source. The removal question is unchanged; incidental recaptures were restored to the six verified variant B captures.

## Second-review evidence

All five second-review items are implemented in new commits after `70e483f3`. Confirmed rows carry file counts through both questions and remote commands; comparison happens inside the registry lane and excludes bytes. Nested repository history counts all local refs not reachable from remote refs, including alternate branches, tags and bare repositories with unborn HEAD. Tick suffixes cover singular, plural and mixed nested kinds. This note no longer refers to a local prototype path.

The Electron unseen-file regression exposed generic failure text hiding main's refusal; both questions now show the specific message. Visual inspection exposed the longer history warning squeezing the nested path; nested columns now wrap within bounded widths. The minimum-window regression checks the path remains readable. All six cited captures were recaptured and inspected; incidental captures were restored and design baselines were not regenerated.

Final `npm run build` and `npx playwright test tests/e2e/thread-worktrees.spec.ts --workers=1` passed all five journeys. Typecheck, lint and notices verification passed; notices still cover 174 components. Renderer removal regressions passed all 14 cases. Separate read-only Standards and Spec reviews found no unresolved findings after the history, lock, error-message and layout fixes.

An earlier overlapping full-suite attempt hit the existing recursive-submodule test deadline. All three initialized-submodule cases passed when run alone; no deadline or assertion changed. The final `npm test -- --maxWorkers=2` run on `ca896ae3` passed 6,452 tests with 153 skipped; 483 files passed and 39 were skipped. No failures.

Main advanced to `dee39cf3` during verification and GitHub reported a merge conflict, preventing the new CI run. It was merged in `c8e487c5`; the only conflict was README copy, resolved by retaining both the staging explanation and removal warnings. All 329 affected tests across 16 worktree, timeout, renderer, host transport, IPC, Git and SSH files passed. Typecheck, lint and notices passed again. Both reviewers found no merge regression. These main changes leave the accepted removal question and its six retained captures unchanged.

After merging main's Windows terminal quoting fix at `cfc4f62d`, the full local suite on `19a4675a` passed 6,502 tests with 153 skipped; 485 files passed and 39 were skipped. No failures. Typecheck, lint and notices passed again.

Main then advanced to `d343d76a`, bringing wake preparation recovery, unique ADR numbers and CI path filters. The four conflicts retained the confirmation signatures, refusal handling, glossary text and timeout amendment while adopting the new worktree citation, ADR-0041. Its renamed record keeps the file-count refusal, history warning and nested registration protections. Both reviewers found no integration findings. All 84 tests in seven affected files passed, including the wake and ADR checks. Typecheck, lint and notices passed again, and the rebuilt Electron app passed all five worktree journeys. The nested question was inspected again in light and dark, including the minimum window; incidental recaptures were restored.

Windows CI on `880d44ae` passed 6,508 tests with 150 skipped, but one existing SSH password-reuse case hit its 10-second fixture sign-in budget at 10,859 ms. The worktree cases passed. Twenty isolated repetitions passed locally. A temporary clock-controlled 11-second route hold reproduced the same connection-timeout failure in 1.18 seconds; a 15-second fixture budget let the same three-process password flow complete in 1.57 seconds. Ordinary SSH success fixtures now use the whole 15-second test budget. Production deadlines and the whole-test deadline are unchanged, and deadline assertions retain explicit budgets, including 10 seconds for the helper-start case. All 45 SSH/askpass tests passed afterward. The spontaneous CI delay itself was not reproduced locally; the budget explanation is supported by the controlled reproduction. The throwaway reproduction was removed.

Main's coordinator and key-recovery fixes through `1f9a5597` merged at `79a0a686`. The one adjacent-test conflict retained both the client-only preview test and all new Stop recovery cases. Both reviewers found no integration findings. Typecheck, lint and notices passed, and the full local suite passed 6,544 tests with 153 skipped; 487 files passed and 39 were skipped. No failures. Main's later encoding and discovery guards through `df0a0468` merged cleanly; both reviewers confirmed that they still discover every worktree and SSH test and do not change removal behavior.


## Third-review submodule history

The open review comment on `threadWorktrees.ts:496` reproduced unseen loss of a clean submodule's local-only branch or tag. Four new real-Git regressions failed before the fix: branch, tag, no remote and a refs-only change inside the registry lane. Every initialized submodule now has all local refs counted against remote refs and is classified as a repository even with a `.git` file. A nonzero count makes a flagged row and blocks rules. Manual removal requires the row in the confirmed set, checked again inside the lane. Folder comparisons still use file counts only.

All seven submodule regressions passed, including the existing clean, recursive and hidden-dirty cases. Refused removal leaves the private commit readable and the module Git directory present. Deliberately acknowledged manual removal deletes that listed history with the folder, as variant B permits; it does not promise to retain a submodule's private branch.

`npm run build` and `npx playwright test tests/e2e/thread-worktrees.spec.ts --workers=1` passed all six journeys. The new Electron case keeps local-only branch and tag commits away from HEAD in a clean submodule and parent checkout. Both pane and Settle questions list **2 commits not on any remote** and disable removal until the tick. Escape leaves both commits recoverable; acknowledged removal deletes the module metadata and keeps the parent's branch. After tightening the clean-parent assertion and refreshing its previously observed status, the new journey passed again.

Light and dark were checked at 1600x1000, 1280x800 and 820x560 with reduced motion. The submodule path, tick and button stay visible; these two retained captures were visually inspected:

- `artifacts/reclaim-worktrees/submodule-history-820x560-dark.png`
- `artifacts/reclaim-worktrees/submodule-history-1600x1000-light.png`

Incidental recaptures were restored and design baselines were not regenerated. Main through `a43ce556` merged cleanly before verification. Typecheck, lint and notices verification passed; the first full run overlapped the follow-up below and passed 6,659 tests with 153 skipped across 493 passing files and 39 skipped files.


The independent Spec review found that deinitialization leaves the module Git directory behind even though its checkout has no `.git` marker. Private branch and tag regressions reproduced the missing row before the follow-up. Sotto now inspects retained module metadata recursively with an explicit Git directory, lists its unpublished history, and requires the same confirmed counts. A recorded module uses its checkout path; orphaned or recursive metadata without a current recorded path uses its relative `.git/modules/` path. Initialized metadata is not counted twice. The named-module regression uses a module name different from its checkout path. All nine focused submodule cases passed.

The expanded Electron case checks deinitialization in the pane and Settle questions too. It initially caught a confirmation-record key-order mismatch after command validation; retained rows now use the same field order as existing repository rows. The rebuilt journey passed in 22.2 seconds after that fix. No deadline or assertion was weakened. The coordinator guide's obsolete cache-file sentence was corrected to the binding file-count rule. The reviewers' shared confirmation-type refactor suggestion remains outside this safety batch.


The fresh full run on `59a8fce6` passed 6,660 tests with 153 skipped and one failure: a branch-naming case now in `tests/integration/workspaceBranchNaming.test.ts` waited only one second for its branch-name writer to start. The original combined workspace file passed all 41 tests in isolation. Comparing with current main showed that an earlier integration had replaced main's explicit fixture start signals in two naming cases with polls. Those two signals were restored exactly from main, retaining all assertions and the normal whole-test deadline. No production naming behavior changed.

The next full run hit the default 15-second ceiling in five new multi-step real-Git submodule scenarios while four worktrees ran full suites on the shared machine. Running those same five scenarios with a 60-second ceiling passed all five in 51.2 seconds of test execution. Those scenarios now have a 60-second failure ceiling for fixture creation and repeated removal checks; assertions and production deadlines are unchanged. The superseded full run was stopped before restarting on current main.

Main through `081d9afa` merged in `112a86f0`. The one socket command conflict keeps the protocol-v1 compatibility parser and the client-only preview return before publishing; both independent reviewers found no new Standards or Spec findings. Typecheck, lint, notices (174 components) and the build passed. The combined Electron run passed all 17 app cases and five worktree cases, including submodule history, but branch restoration was still showing Switching when its five-second dialog assertion expired. That unchanged case passed in the isolated worktree rerun; the final rerun result is recorded below.

The full isolated worktree spec passed all six journeys on the merged build in 2.2 minutes, including branch restoration and the submodule history journey. The minimum dark and full-size light submodule captures were inspected again. Incidental recaptures were restored and the retained evidence was preserved; no design baseline was regenerated.

The final exact `npm test -- --maxWorkers=2` gate on `112a86f0` passed 6,676 tests with 153 skipped; 499 files passed and 39 were skipped. No failures. Together with the passing typecheck, lint and notices gates, this completes the local checks on the merged source. The final Standards and Spec integration rechecks found no remaining blocking findings.

Windows and Linux CI passed on `af27c791`. The required final reread of every PR comment and review then found a new actionable recursive-deinitialization comment, `4151574088`. Two new real-Git regressions reproduced the exact missing-checkout error for published and private child history. Retained history inspection now overrides the recursive child's stale `core.worktree` with an existing metadata directory; the command reads only refs and commits. The published case then exposed Git refusing ordinary removal while recursive metadata remains. Retained metadata therefore participates in the final submodule scan and selects force removal only after that scan. Unpublished history still blocks rules and requires the confirmed row.

Both recursive-deinitialization regressions passed in 25.65 seconds after the repair. The private case lists `.git/modules/module/modules/child/`, requires its confirmed counts, and leaves the private commit readable after refusal; deliberately acknowledged removal deletes the listed metadata. Published history produces no warning row and permits automatic cleanup. Main through `51d367db` merged cleanly in `cbf70409` before these checks.

The rebuilt Electron submodule journey passed in 24.4 seconds with the recursive child. Pane and Settle questions list its retained private commit, keep removal disabled until the tick, and preserve the commit on Escape. At the minimum window the recursive path, both history rows, checkbox and action remain visible. `artifacts/reclaim-worktrees/submodule-recursive-history-820x560-dark.png` was visually inspected; earlier captures were preserved and design baselines were not regenerated. Typecheck, lint and notices passed again, and both independent reviewers found no new Standards or Spec findings in the recursive repair and main integration.

The complete rebuilt `app.spec.ts` and `thread-worktrees.spec.ts` run on `61aee837` passed all 23 journeys in 3.1 minutes. The original branch-restoration assertion passed with its unchanged deadline. Incidental recaptures were restored to the three inspected submodule captures and existing evidence.

The fresh exact `npm test -- --maxWorkers=2` gate on `61aee837` passed 6,749 tests with 154 skipped; 501 files passed and 39 were skipped. No failures. Typecheck, lint and notices verification also passed, with 174 notice components. This full run includes all eleven submodule cases and the incoming main changes through `51d367db`.

Windows and Linux CI passed on `5869eea9`; Windows reported 6,772 tests passed with 151 skipped, across 501 passing files and 39 skipped files. The post-green fetch found main's phone-access cleanup through `906776d0`, merged cleanly in `a8d40098`. All 146 affected phone, socket, remote-command, router and workspace tests passed across seven files. Typecheck, lint, notices and the rebuild passed again. All seven phone and worktree Electron journeys passed in 2.1 minutes, including recursive retained history. Both reviewers found no integration findings. Incidental recaptures were restored; the three inspected submodule captures remain unchanged.
