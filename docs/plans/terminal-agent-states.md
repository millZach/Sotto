# Terminal agent states (#883)

The owner chose variant B of `docs/prototypes/terminal-agent-state-prototype.html` on October 9, 2026. Keep that historical prototype unchanged. ADR-0066 governs behaviour, including its correction to the prototype: every pane on screen counts as viewed, focused or not.

## Acceptance checks

- Main owns run-scoped state, hook identity, live-screen evidence and the ephemeral unread mark.
- Needs you across projects, Working, other terminals by project, then Closed. Just finished uses the thread dot and bold title. Only Needs you adds a thin pane-header edge.
- A visible split pane earns no unread completion; hidden, zoomed-out, minimised and tray panes do not count. Viewing clears an existing mark. Plain shells keep their output-based labels.
- Hooks use private run-only configuration, authenticated bounded loopback frames and the packaged helper. Native terminal answers remain native.
- Unit derivation/order tests, real fake-CLI hook integration, and an Electron journey through every state.
- Inspect light/dark and reduced motion at 1600x1000, 1280x800 and 820x560. Keep screenshots and a verification note.
- Update README, guide and glossary. Run the four CI gates and affected Playwright specs. Review standards and spec separately, then commit locally. Do not push or open a PR.

## Current state

Dependencies installed with `npm ci`. Source and tests are frozen at `6ad14d666`; terminal implementation is unchanged from `a4d837045`. Main, hook and renderer focused tests passed, including 84 state regressions. PowerShell notify quoting, stale Grok ready-screen completion and narrow-sidebar label clipping were fixed and checked in the running app. All five affected Playwright specs passed six cases before the final state refinements; seven retained screenshots were inspected. Design captures were regenerated deliberately; incidental differences outside Terminal mode were restored after inspection.

All actionable Standards and Spec findings have fixes and regressions. Completion reconciles either hook/output order and remembers viewed readiness. Current turn binding survives delayed submitted hooks, cancellation cannot be revived by late tool callbacks, and a successful Stop without a turn ID retires its known turn. Both review axes agreed that viewing known ongoing continuation does not consume its later hidden finish; the ADR and paired regressions distinguish that from viewing after successful Stop.

Final typecheck, lint and notices pass (174 components). The one full run returned 9,360 passed, 222 skipped and one failed title-fixture test, across 627 passed, 51 skipped and one failed file. Its fixture published Idle before Running, allowing a legitimate title request before the assertion. The unchanged title file passed in isolation here and 21 times on `origin/main` at `cc732e398`; a controlled refresh between its two frames reproduced the exact premature call on main, including as a single isolated case. Commit `6ad14d666` publishes reply and Running in one frame; its isolated case and all 18 title tests pass. The temporary baseline worktree was removed.

The fresh build and all five affected Playwright specs pass six cases in 1.1 minutes. All seven final screenshots were inspected, the six geometry/contrast combinations pass, and the design manifest verifies 152 tuples after restoring neighbouring captures. Gate totals, the original full-suite failure, its controlled main reproduction and fix, review dispositions, compatibility and limits are recorded in `docs/verification/2026-10-09-terminal-agent-states.md`.

An extra full run is awaiting the owner's answer because the instructions limit it to one run. It is the sole remaining gate: no fresh full-suite pass is claimed after the fixture correction. The evidence and corrected coordinator guide are retained locally. No push or PR is authorised.
