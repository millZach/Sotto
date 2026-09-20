# Adopt T3's thread working copies

Issue: #146. Branch: `feat/t3-thread-working-copies`. Review base: `ac7d9b75b4cbe7aeba52113e8f8bba19a092321a` (`origin/main` when work began). Work is isolated from the open freeze-fix PR.

## Deliverables and state

- [x] Host: shared default, deferred independent checkout, base/origin choice, existing-worktree reuse, pre-send selection changes, safe recovery.
- [x] Renderer: existing New thread and working-copy controls carry choices; shared-only notice and session dismissal; actual branch label.
- [x] Settings and IPC: global/project defaults, authenticated main-window working-copy query, validation and persistence.
- [x] Branch naming: short temporary branch, existing writing model, privacy gates, guarded best-effort rename.
- [x] Compatibility: preserve existing sessions, folders, drafts, history, branch and uncommitted work.
- [x] Documentation: amend ADR-0014, context, README, agent-control, verification evidence.
- [x] Verification: targeted test-first checks, repeated typechecks, full suite, CI gates, relevant Electron journeys and visual checks.
- [x] Delivery preparation: standards/spec subagent reviews against the pinned base and #146, findings fixed and committed; branch ready to push and open the PR.

## Interface acceptance

Target: existing Windows desktop Electron interface, Apple silicon behavior retained. This is a scoped extension of New thread, the header working-copy popover, and Settings; no restyle or new page. The reference is T3's distinction between current checkout and explicitly selected worktree, preserving Sotto's Figtree, quiet themed surfaces and existing controls.

Concept: choose where a thread works, then send; the proof is a default thread reading the project's unfinished edits without creating a checkout. Existing fieldset controls keep the choice near the project; conditional base/origin/reuse fields reveal only what that choice needs. Global defaults live in Settings and project overrides in the existing creation flow.

- [x] Composition: project, working-copy choice, model and submit remain in reading/focus order; no redundant control groups.
- [x] Type/color: retain existing component typography and theme-role tokens; inspect contrast and legibility at normal zoom in light/dark.
- [x] Copy: labels state choices and actions, shared-folder consequence appears once, errors retain draft and provide recovery.
- [x] Motion: no new animation is necessary for form choices; preserve existing feedback and reduced-motion behavior.
- [x] Keyboard: choose every mode/base, save project preference, configure empty thread, dismiss/restore notice; Escape closes popovers/dialogs and focus returns correctly.
- [x] Render at 1600x1000, 1280x800 and 820x560; no clipped fields or actions, including expanded choices and error/dirty-confirmation states.

New-surface concepts and a signature animation are inapplicable: this change adds controls to already established forms and a header popover. The existing dialog flow is retained rather than reopening the broader Git design in #127. Essential form labels, instructions, and state feedback are reviewed for repetition; the surrounding application is not subject to a landing-page five-element limit.

## Test seams

Use the existing ThreadWorktrees real-Git fixtures, WorkspaceHost provider fixtures, renderer working-copy/notice tests, settings IPC tests and Electron worktree journeys. The `/tdd` skill was searched for in the supplied skill roots and Fleet skill tree but is not installed; implement's test-first instruction is followed directly at these seams.

## Constraints and unresolved gaps

No files in the user's real profile were migrated or removed. No new runtime dependency or credential was added. The research note is included as historical evidence, with the adopted decision in ADR-0014.

Main advanced to `71d0cd73` during implementation and was merged before final verification. All gates passed: 3,828 tests passed, 28 skipped; six Electron journeys passed; ten design tests verified 144 capture tuples. Both independent reviews are clear after fixes. See `docs/verification/2026-09-19-t3-working-copies.md` for evidence, the earlier intermittent draft-recovery failure reproduced on the initial main baseline, and runtime limits. No remaining implementation gap is known within #146.
