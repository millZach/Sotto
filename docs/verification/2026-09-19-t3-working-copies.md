# Thread working copies

Issue #146. Tested on Windows in an isolated checkout of `feat/t3-thread-working-copies`, initially based on `ac7d9b75b4cbe7aeba52113e8f8bba19a092321a`. Main advanced during the work; `71d0cd73` (PR #145) was merged without conflicts before final verification. The installed Sotto profile and the user's project checkout were not migrated or changed. Test providers and temporary Git repositories exercise the desktop app; no live-provider result is claimed.

## Behavior

New threads use the project folder unless a global default, project default or explicit choice says otherwise. New worktree remains unallocated until first send, with a selected local base or an explicit origin fetch. An existing registered checkout can be reused. The writing model can replace an exclusively owned temporary branch name, subject to the existing title and history settings; a later branch chosen by the agent wins.

Existing sessions keep their folders and identifiers. The mismatch notice applies to shared project checkouts, waits for a draft and remembers dismissal for that thread and branch pair during the renderer session. Restore remains explicit and confirms dirty switches. Missing Sotto-owned worktrees recover on their recorded branch, with folder-identity checks retained.

Before first send, an unallocated independent thread previews the source project's files and skills. Terminal, browser and Git tools cannot treat that preview as an allocated workspace. A selected existing worktree binds on first send; its files and skills are checked then. This deliberate preview limitation does not move or start a provider session early.

## Evidence

Captures are under `artifacts/issue-146/`. Three representative images are committed; remaining generated evidence is ignored. The New thread matrix covers 1600x1000, 1280x800 and 820x560, light and dark themes, and normal and reduced motion. Screenshots use Windows device scaling; names describe the Electron viewport in CSS pixels.

- `shared-default-dialog.png`: Project folder selected by default, with shared files/branch explained.
- `new-worktree-<size>-<theme>-<motion>.png`: conditional base, origin and existing-worktree controls.
- `new-worktree-820x560-bottom.png`: scrolling and keyboard focus reach model, permission and Create thread controls at minimum size.
- `working-copy-editor-820x560.png`: the header editor stays within its pane, with both choices and Apply visible. Applying restores focus to the selected choice; Escape returns focus to the header control.
- `shared-branch-notice.png` and `dirty-branch-confirmation.png`: explicit restore with the draft retained.

The parent agent inspected representative light/dark, reduced-motion and minimum-size captures. The first small-window editor capture exposed clipping behind the sidebar; the final capture was inspected after clamping the editor to its pane. The Electron test now asserts its bounds.

## Validation

Typecheck, lint and third-party notices passed on the integrated code; 174 notice components verified. `npm test -- --maxWorkers=2` passed: 3,828 tests passed, 28 skipped (294 files passed, 14 skipped). These results include main's merged provider fixes. Local full-run evidence: `artifacts/issue-146/verified-suite.log`.

`npm run build` succeeded. The complete relevant Electron run passed all six tests in `thread-worktrees.spec.ts`, `files-panel-split.spec.ts` and `daily-workspace.spec.ts`. Those cover shared unfinished files, lazy allocation, base selection, reuse, first-send retry, branch notices, dirty restore, file isolation, and a real commit/push to an owned local remote. Latest generated evidence is saved with `final-integrated-` names.

`npm run design:verify` passed all ten tests and verified 144 deterministic capture tuples. Twenty-five baseline images changed: eleven intentional settings/working-copy/narrow-pane updates, six stale Help images showing the earlier version number, and eight stale thread images showing the earlier model-picker appearance. Representative before/after crops were inspected; unchanged-pixel PNG encoding churn was discarded.

The test fixtures were updated where defaults changed, and performance fixtures now read the migrated SQLite history through a consistent read-only-source backup instead of assuming inline JSON messages. Two pane-layout assertions now allow the read-only branch inspection triggered by drafting in a legacy thread. No failing assertion was weakened to suppress prompt dispatch, data loss or a runtime error.

## Independent review

The two-axis review used independent subagents against `ac7d9b75b4cbe7aeba52113e8f8bba19a092321a` and issue #146. The custom reviewer model/type specified by the skill was not available in this session; the available collaboration agents performed the reviews.

### Standards

One finding: exact folder comparison did not protect generated branch naming when another thread used a subdirectory of the same checkout or legacy directory metadata. The fix compares canonical Git checkout identity before requesting a name and before renaming. Independent re-review reported no unresolved standards findings.

### Spec

Two findings: the same ownership gap, and legacy threads without working-copy metadata were missing branch refresh/display and the shared-checkout notice. The fix discovers checkout metadata without changing provider binding or working directory, retaining worktree-backed notice exclusion. Independent re-review reported no unresolved spec findings.

The review fixes are in `166a85c1`. Four backend regressions cover legacy/shared directory representations and both legacy working-copy modes; renderer tests cover returning from a terminal, popup bounds and focus. The final full gate result is recorded above.

## Pre-existing draft-recovery failure

The broader `daily-workspace.spec.ts` journey named `mixed pane drafts, queued work, settlement and preferences recover without automatic replay` intermittently shows an empty Codex composer even while main still reports the exact newer draft. The test retains its assertion; nothing was skipped or weakened to hide this failure.

It reproduces against unchanged production code at the initial main commit in a separate checkout: the same strengthened test failed twice and passed once with `--repeat-each=3`. The original main test also passed once, confirming the timing sensitivity. Local evidence: `artifacts/issue-146/main-baseline-draft-race.log`. This branch does not change draft reconciliation.

After integrating main's provider snapshot fixes from PR #145, all six relevant Electron tests passed, including this journey. That passing run is recorded as such; it does not establish that an intermittent race is permanently fixed. The earlier failure and its main-baseline reproduction remain disclosed for follow-up.

## Limits

No installer, release or macOS runtime was tested. Fixture verification covers Codex, Claude Code and Grok working-directory behavior; it does not call paid live providers. AppData organization and old temporary-file cleanup are outside #146. Sharing a checkout intentionally shares files and HEAD; separate Sotto thread IDs do not isolate concurrent edits.
