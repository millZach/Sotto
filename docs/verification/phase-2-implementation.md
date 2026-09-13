# Phase 2 implementation and verification

All seven implementations and independent reviews are complete through `e6cdcda` on `work/threads-phase-2`, based on Phase 1 `17c47b5`. The complete Electron regression and final capture comparison pass. This record does not claim an installer or public release.

Tickets ran in isolated parallel worktrees. GPT-6-Astra handled backend/native reasoning; Claude Opus 5 handled UI using the user's authorized Fable fallback. Shared contracts were integrated before combined testing. The inspected T3 reference is pinned at `d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3`.

## Delivered behavior

| Ticket | Delivered and checked |
| --- | --- |
| #47 Diagrams | Flow, sequence, state, class and ER rendering; source/failure fallback; copy, focused viewer and keyboard zoom; parsed resource/complexity admission and sanitized SVG measurement. ER alias and sequence-block accounting regressions are fixed. |
| #48 Codex activity | Ordered tool/activity rows anchored to transcript messages, errors, elapsed time and child-agent details. Native reconnect preserves canonical message IDs, command origins and activity anchors, including lagging/partial history. |
| #51 Queue and steering | Durable editable/reorderable per-thread follow-ups; native same-turn steering; one-time dispatch after authoritative completion; immutable submitted revisions and uncertain holds. Manual/managed handoffs retain exact drafts, images and skills, and wait for confirmed persistence. |
| #53 Split workspace | Two independently usable panes, drag and keyboard opening, resize/focus/close, retained narrow views and view-only observation. Exact drafts and focus remain scoped to the intended thread. |
| #55 Files panel | One shared panel follows focus or pins to a thread. Bounded filesystem and text/Markdown/image previews use that thread's actual working copy. Full path, pinned ownership and focus restoration are verified. |
| #58 Worktrees | Independent Git checkout by default, explicit shared/non-Git choices, project subfolder preservation, setup/retry/status/reveal. Failed setup blocks submission and preserves the draft. Actual native execution used the independent cwd. |
| #63 Codex skills | Native catalog scoped to the actual working directory, searchable reviewed insertion, structured invocation and catalog refresh/failure states. Selected skills survive queueing and are validated against current catalog/connection generations. |

## Final verification

- **Repository suite at `e6cdcda`: 2,835 passed, 11 skipped across 187 files** (181 passed, six skipped), 136.04 seconds. Both TypeScript checks, full ESLint and production build pass.
- **Complete Windows Electron regression at `e6cdcda`: 116 passed, 21 skipped in 7.7 minutes.** The opt-in design/native tests were run separately as recorded below.
- **144-capture matrix:** final update (10 journeys, 2.4 minutes) and non-update comparison (10 journeys, 2.2 minutes) pass. Both manifest verifications confirm all 144 exact deterministic design-review tuples.
- **Runtime and notices:** four runtime assets and 167 third-party notice components verify. Dependencies are pinned, including Mermaid 11.17.2.
- **Installed Codex acceptance:** the fresh acceptance run used two accepted turns and one steer. It verified structured skills, execution and a unique proof file in an independent working copy, automatic queued dispatch after completion, and full app restart with stable ordered IDs/origins/activity anchors and no replay. Later read-only recovery after `20c42cb` passed (5.2 seconds) without another turn or steer. See [native smoke record](2026-09-12-phase2-native-smoke.md).
- **Local feedback:** the combined workspace check measured next-frame feedback p95 at 21.8 ms and typing p95 at 7.3 ms, below the 100 ms target.

## Independent review and regression fixes

Backend review reproduced and then cleared admission/steering/catalog races, late autosaves overwriting newer managed drafts, legacy reconnect briefly revoking management, and lagging history removing or truncating a completed answer. The last bounded recheck at `20c42cb` passed 35 tests, including six retained independent regressions, plus an authoritative terminal-history correction check. No material backend finding remains.

The final independent UI review accepted `1e9b7fe` (the review worktree merge of integration `0ccc4be`, builder `276f50c`). All seven review tests passed on a fresh build, and their actual verdicts were checked: queue 14/14, handoff 24/24 and picker 9/9. The admitted-send, failed-worktree, exact keyboard and image-layout reproductions also pass. Findings fixed include:

- Queue/composer overflow, hidden queue edits and arrivals, duplicated pause feedback, picker layout and focus restoration.
- Exact draft/image preservation through management, refusal, held saves, another active pane and restart.
- A real Shift+Tab into Write here removing the focused button. The capture-phase fix is covered by actual keyboard input; programmatic focus alone did not reproduce the defect.
- A single attached image pushing manual or managed actions below the footer at 820x560 and in short splits. Compact previews and short-window header/footer layout keep the controls visible.
- Refused keyboard management leaving focus on the page body. Focus now moves into the appropriate prompt before disabling the activated control.

The last three cases have strict regressions in the regular `tests/e2e/composer-short-window.spec.ts`. Those tests fail on the old source and pass with the fixes. The final builder also passed 213 focused tests, 16 ordinary Electron journeys and six review journeys. Parent inspection covered the final single/split image layout, queue editor, managed handoff, failed worktree and actual-height picker captures.

An observed answer-fixture restart race was fixed in `e6cdcda`: the fixture now waits for its outstanding command promises before restarting or cleaning up. Existing restored-value assertions remain intact; production behavior was not changed by that test correction.

Independent Files review cleared the path, pinning and focus findings. At 1280px, opening Files uses thread tabs; closing restores the previous split and ratio. Both views remain available.

## Evidence and limits

- Final builder captures: `artifacts/phase-two-composer-fixed/` and `artifacts/phase-two-composer-final-gaps/`. Native evidence: `artifacts/phase-two-native/`. The independent review's own tests and captures are retained in `.worktrees/phase2-visual-review`; full reports/logs are in `.worktrees/phase2-orchestration`.
- Main-app journeys use the real Windows Electron shell. Codex-only picker/steer fixtures reserve the actual 60px header and 44px footer and are clearly labelled; they are not the real AppShell. Actual native invocation is separate evidence.
- Checked 1280/1600 widths, 820 minimum, 820x560 short windows, and the existing 760x850 recovery stress case; keyboard/pointer, light/dark and existing accents, reduced motion and Electron zoom 125/150% on a 1.5-DPR display. OS scaling was not changed; no macOS acceptance is claimed.
- At short heights the queue defaults to a collapsed summary; its expanded list and uncertain-item actions can require scrolling. A transient picker covers the queue head. Short image layouts retain roughly 98-109px of transcript. Setup status repeats in the chip and notice; independent review classified this as a minor preference.
- Diagram validation includes the existing dedicated Electron safety tests and ordinary source/parser checks. Extra exploratory dynamic review was stopped by an automated content safety filter and is not claimed complete. The known resource, ER-alias and sequence accounting findings are fixed; this is bounded admission, not a universal rendering-time guarantee.
- Initial native diagnostic failures are retained in the smoke record. Across diagnostic and acceptance runs, verification submitted four turns and two steers in two owned synthetic sessions; subsequent recovery was read-only.

## Delivery checklist

- [x] Integrate all seven tickets and preserve provider authority, thread identity, scoped memory and uncertain-delivery reconciliation.
- [x] Resolve and independently recheck all material backend and visual findings; inspect final renders.
- [x] Verify installed-native queue, skill, steering, worktree execution and stable reconnect behavior.
- [x] Pass repository tests, build, typecheck, lint, runtime and notice verification.
- [x] Pass final complete Electron regression and 144-capture update/comparison.
- [x] Prepare final evidence for authorized push and merge. Remote delivery is recorded in the pull request history.

No installer or public release is included. Existing #24 remains the separate native-provider release gate. Once Phase 2 is merged, all ten Phase 3 tickets have their Phase 1/2 prerequisites satisfied.
