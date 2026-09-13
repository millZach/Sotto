# Phase 2 implementation and verification

Status: implementation in progress. Integration branch `work/threads-phase-2`, based on merged Phase 1 `17c47b5`. GitHub confirms that #47, #48, #51, #53, #55, #58 and #63 have no open blockers. All seven lanes started in parallel in isolated worktrees. Codex handles backend/native reasoning; Opus 5 handles UI under the user's authorized Fable fallback. Parent integration and independent review remain required.

## Deliverables and acceptance

| Ticket | Acceptance | Current state |
| --- | --- | --- |
| #47 Diagrams | Valid sequence/flow/state diagrams, readable incomplete/invalid source, useful failure, source copy, keyboard-accessible focused zoom, no arbitrary script/resource execution, light/dark review | Builder running |
| #48 Codex activity | Stable ordered/deduplicated activity beside messages, real available tool/results/errors/status/subagent events, elapsed time, reload/reconnect restoration, native fixture and installed-client verification | Backend builder running; UI to consume published contract |
| #51 Queue and steering | Durable per-thread ordered editable/removable queue; dispatch once on completion; interrupted acknowledgements never replay silently; genuine supported native steering; concurrent threads/permission waits/handoff verified | Backend builder running; composer UI to consume published contract |
| #53 Split workspace | Drag or keyboard-open two independent cross-project panes, even initial split, resize/focus/close, preserved drafts/scroll/options/activity, close only affects view, narrow focused mode | UI builder running |
| #55 Files panel | Reusable shared surface follows focused thread or pins, visible workspace/path, bounded safe main-only tree and text/Markdown/image previews, actual cwd/worktree, recoverable unavailable files, retained panel state | Backend builder running; tools UI to consume published contract |
| #58 Worktrees | Independent Git working copies by default for new Git tasks, deliberate shared copy and non-Git support, actual native cwd, original project memory scope, safe setup/retry/status/reveal, no destructive cleanup | Backend builder running; creation UI to consume published contract |
| #63 Codex skills | Native enabled user-invocable account/cwd catalog, searchable `/` and `$` picker, reviewed insertion, native invocation/refresh/failure, native commands distinguished, keyboard/manual syntax retained | Backend builder running; picker UI to consume published contract |

## Shared acceptance checks

- [ ] Integrate all seven slices without replacing the Phase 1 draft ownership/durability, delivery uncertainty, provider identity, management authority or project-memory scope behavior.
- [ ] Verify selected skills survive queued submission and worktree-bound catalog refresh.
- [ ] Verify split focus, tools pinning, independent send/queue/scroll, and actual worktree paths together.
- [ ] Verify activity and diagrams coexist with streaming, stable message identity and transcript reading anchors.
- [ ] Typecheck, ESLint, production build, dependency notices, appropriate unit/integration suite and actual Windows Electron journeys.
- [ ] Independent reasoning/security review and visual critic; resolve material findings, then parent inspect integrated app.
- [ ] Update the deterministic design matrix for affected views; preserve existing gates and compare repeated captures.
- [ ] Report exact native fixture versus installed-client/live verification, source commits and remaining limitations.

## Design acceptance

Target remains Windows Electron desktop: normal desktop, shipped 820px minimum, keyboard/pointer, dark/light and existing accents, reduced motion and relevant scaling. Sotto's Phase 1 rendered baseline supplies branding, typography and composition; the pinned T3 source supplies comparable behavior. No phone redesign is requested.

- [ ] Conversation and current work dominate; diagrams expand for inspection, activity stays compact until requested, and tools remain beside their bound thread context.
- [ ] Retain Sotto type, theme tokens, readable native controls, visible keyboard focus and contrast. Recompose narrow layouts rather than shrinking controls.
- [ ] Use one label per action and one location per status fact. Inventory affected first-screen text purposes, identifying essential content, controls and recovery feedback explicitly.
- [ ] Motion explains split/drop/focus, inspection or activity state, with coherent reduced-motion behavior and no clipping at interaction extremes.
- [ ] Inspect normal/narrow actual renders, keyboard journeys and relevant empty/loading/error/streaming/recovery states in light and dark. Record evidence and correct the largest visible mismatch before completion.

## Coordination and delivery

Per-lane contracts and progress live in the ignored `.worktrees/phase2-orchestration` directory during implementation. Integration will retain the durable verification report and relevant screenshots. Original root checkout artifacts remain preserved. No Phase 2 source push, merge, issue closure or installer publication has occurred.
