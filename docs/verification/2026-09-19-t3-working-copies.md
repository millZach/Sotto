# Thread working copies

Issue #146. Tested on Windows in an isolated checkout of `feat/t3-thread-working-copies`, based on `ac7d9b75b4cbe7aeba52113e8f8bba19a092321a`. The installed Sotto profile and the user's project checkout were not migrated or changed. Test providers and temporary Git repositories exercise the desktop app; no live-provider result is claimed.

## Behavior

New threads use the project folder unless a global default, project default or explicit choice says otherwise. New worktree remains unallocated until first send, with a selected local base or an explicit origin fetch. An existing registered checkout can be reused. The writing model can replace an exclusively owned temporary branch name, subject to the existing title and history settings; a later branch chosen by the agent wins.

Existing sessions keep their folders and identifiers. The mismatch notice applies to shared project checkouts, waits for a draft and remembers dismissal for that thread and branch pair during the renderer session. Restore remains explicit and confirms dirty switches. Missing Sotto-owned worktrees recover on their recorded branch, with folder-identity checks retained.

Before first send, an unallocated independent thread previews the source project's files and skills. Terminal, browser and Git tools cannot treat that preview as an allocated workspace. A selected existing worktree binds on first send; its files and skills are checked then. This deliberate preview limitation does not move or start a provider session early.

## Evidence

Local captures are under `artifacts/issue-146/` (ignored generated evidence). The New thread matrix covers 1600x1000, 1280x800 and 820x560, light and dark themes, and normal and reduced motion. Screenshots use Windows device scaling; names describe the Electron viewport in CSS pixels.

- `shared-default-dialog.png`: Project folder selected by default, with shared files/branch explained.
- `new-worktree-<size>-<theme>-<motion>.png`: conditional base, origin and existing-worktree controls.
- `new-worktree-820x560-bottom.png`: scrolling and keyboard focus reach model, permission and Create thread controls at minimum size.
- `working-copy-editor-820x560.png`: the header editor stays within its pane, with both choices and Apply visible. Applying restores focus to the selected choice; Escape returns focus to the header control.
- `shared-branch-notice.png` and `dirty-branch-confirmation.png`: explicit restore with the draft retained.

The parent agent inspected representative light/dark, reduced-motion and minimum-size captures. The first small-window editor capture exposed clipping behind the sidebar; the final capture was inspected after clamping the editor to its pane. The Electron test now asserts its bounds.

## Validation in progress

Focused host, settings, IPC, renderer and real-Git adapter tests have passed. The first complete run exposed outdated defaults in two tests, an exact preload-surface expectation, and performance fixtures still reading transcripts from JSON after the SQLite migration. The preview-access regression was also being implemented while that run started. Those failures are being resolved before the final gate run; this note does not count that run as passing.

Final gate counts, Electron results, design-baseline changes and independent standards/spec review results will replace this section before PR creation.

## Independent review

The two-axis review used independent subagents against `ac7d9b75b4cbe7aeba52113e8f8bba19a092321a` and issue #146. The custom reviewer model/type specified by the skill was not available in this session; the available collaboration agents performed the reviews.

### Standards

One finding: exact folder comparison did not protect generated branch naming when another thread used a subdirectory of the same checkout or legacy directory metadata. The fix compares canonical Git checkout identity before requesting a name and before renaming. Independent re-review reported no unresolved standards findings.

### Spec

Two findings: the same ownership gap, and legacy threads without working-copy metadata were missing branch refresh/display and the shared-checkout notice. The fix discovers checkout metadata without changing provider binding or working directory, retaining worktree-backed notice exclusion. Independent re-review reported no unresolved spec findings.

The review fixes are in `166a85c1`. Four backend regressions cover legacy/shared directory representations and both legacy working-copy modes; renderer tests cover returning from a terminal, popup bounds and focus. The final full gate result is recorded above.

## Pre-existing draft-recovery failure

The broader `daily-workspace.spec.ts` journey named `mixed pane drafts, queued work, settlement and preferences recover without automatic replay` intermittently shows an empty Codex composer even while main still reports the exact newer draft. The test retains its assertion; nothing was skipped or weakened to hide this failure.

It reproduces against unchanged production code at the pinned main commit in a separate checkout: the same strengthened test failed twice and passed once with `--repeat-each=3`. The original main test also passed once, confirming the timing sensitivity. Local evidence: `artifacts/issue-146/main-baseline-draft-race.log`. This branch does not change draft reconciliation. The five scoped working-copy/Files/commit-and-push journeys passed separately. This failure is reported explicitly in the PR rather than counting the whole daily-workspace spec as green.

## Limits

No installer, release or macOS runtime was tested. Fixture verification covers Codex, Claude Code and Grok working-directory behavior; it does not call paid live providers. AppData organization and old temporary-file cleanup are outside #146. Sharing a checkout intentionally shares files and HEAD; separate Sotto thread IDs do not isolate concurrent edits.
