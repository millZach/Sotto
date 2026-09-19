# Adopt T3's thread working copies

Issue: #146. Branch: `feat/t3-thread-working-copies`. Review base: `ac7d9b75b4cbe7aeba52113e8f8bba19a092321a` (`origin/main` when work began). Work is isolated from the open freeze-fix PR.

## Deliverables and state

- [ ] Host: shared default, deferred independent checkout, base/origin choice, existing-worktree reuse, pre-send selection changes, safe recovery.
- [ ] Renderer: existing New thread and working-copy controls carry choices; shared-only notice and session dismissal; actual branch label.
- [ ] Settings and IPC: global/project defaults, authenticated main-window working-copy query, validation and persistence.
- [ ] Branch naming: short temporary branch, existing writing model, privacy gates, guarded best-effort rename.
- [ ] Compatibility: preserve existing sessions, folders, drafts, history, branch and uncommitted work.
- [ ] Documentation: amend ADR-0014, context, README, agent-control, verification evidence.
- [ ] Verification: targeted test-first checks, repeated typechecks, one final full suite, CI gates, relevant Electron journeys and visual checks.
- [ ] Delivery: standards/spec subagent reviews against the pinned base and #146, fix findings, commit, push, PR.

## Interface acceptance

Target: existing Windows desktop Electron interface, Apple silicon behavior retained. This is a scoped extension of New thread, the header working-copy popover, and Settings; no restyle or new page. The reference is T3's distinction between current checkout and explicitly selected worktree, preserving Sotto's Figtree, quiet themed surfaces and existing controls.

Concept: choose where a thread works, then send; the proof is a default thread reading the project's unfinished edits without creating a checkout. Existing fieldset controls keep the choice near the project; conditional base/origin/reuse fields reveal only what that choice needs. Global defaults live in Settings and project overrides in the existing creation flow.

- [ ] Composition: project, working-copy choice, model and submit remain in reading/focus order; no redundant control groups.
- [ ] Type/color: retain existing component typography and theme-role tokens; inspect contrast and legibility at normal zoom in light/dark.
- [ ] Copy: labels state choices and actions, shared-folder consequence appears once, errors retain draft and provide recovery.
- [ ] Motion: no new animation is necessary for form choices; preserve existing feedback and reduced-motion behavior.
- [ ] Keyboard: choose every mode/base, save project preference, configure empty thread, dismiss/restore notice; Escape closes popovers/dialogs and focus returns correctly.
- [ ] Render at 1600x1000, 1280x800 and 820x560; no clipped fields or actions, including expanded choices and error/dirty-confirmation states.

New-surface concepts and a signature animation are inapplicable: this change adds controls to already established forms and a header popover. The existing dialog flow is retained rather than reopening the broader Git design in #127. Essential form labels, instructions, and state feedback are reviewed for repetition; the surrounding application is not subject to a landing-page five-element limit.

## Test seams

Use the existing ThreadWorktrees real-Git fixtures, WorkspaceHost provider fixtures, renderer working-copy/notice tests, settings IPC tests and Electron worktree journeys. The `/tdd` skill was searched for in the supplied skill roots and Fleet skill tree but is not installed; implement's test-first instruction is followed directly at these seams.

## Constraints and unresolved gaps

No files in the user's real profile are migrated or removed during development. No new host, runtime dependency, or credential. The current research note remains in the original checkout and will be included with this implementation. Full verification and review results will be recorded before PR creation.
