# Workspace menu and project header

Zach chose prototype A on September 28: a compact menu above Workspace, search at the top, Current checkout and New worktree always visible, and five recent worktrees. The host badge becomes an icon in a narrow sidebar. The three prototype variants and the verdict are preserved on the local branch `prototype/workspace-picker-20260928`, commit `3005823360b987388725785f278a42532cd7aef0`; prototype code is not part of the implementation.

## Acceptance checks

- [x] Long project names cannot put the host badge under New thread or the project archive action. Actions reserve their own space. The local host label stays whole at wide sidebar sizes; below 340px it becomes an icon with the host still named in the tooltip and project button's accessible name.
- [x] Current checkout and New worktree stay at the top. The first view shows at most five worktrees, ordered by their threads' latest activity or message, with repeated folders counted once.
- [x] Search covers all available worktrees of the same project, by branch or folder. Empty results retain both starting choices. Long branch names ellipsize and the folder is in the tooltip.
- [x] The menu stays inside the pane and window, including a lower row in a three-pane grid. Search results scroll while the starting choices remain visible.
- [x] Keyboard opening focuses search; arrows reach the choices, Enter selects, Escape returns focus, and completing the workspace command restores focus if the user has not moved elsewhere.
- [x] A new worktree, an older existing worktree found through search, and switching back to the current checkout succeed through the real Electron command bridge.

## Cause and regression

The old workspace menu rendered every available worktree into an upward-opening list with no height bound. Its first entries could therefore sit above the window. The original regression command, `npx vitest run tests/unit/renderer/branchToolbar.test.tsx --maxWorkers=2 -t 'orders worktrees|shows five recent'`, failed twice before the fix: all 12 fixture worktrees appeared instead of five, and their order followed the input snapshot instead of recent use.

The project actions used absolute positioning over the end of the project toggle. They hid the older count/indicator content, but not the later host badge. Reserving action space removes the overlap instead of hiding the host.

## Verification

Windows Electron, 1600x1000, 1280x800 and 820x560 CSS pixels; light and dark, normal and reduced motion. The display scale is 150%, so PNG pixel dimensions are larger than CSS dimensions. Inspected the actual captures, including the host label at both sidebar width limits.

- `npm run build`, `npm run typecheck`, `npm run lint`, and `npm run notices:verify`: passed.
- Focused toolbar, host visibility and theme tests: 77 passed on the final implementation.
- `tests/e2e/workspace-picker.spec.ts`: passed, including all 12 size/appearance/motion combinations, narrow/wide project headers, keyboard focus, branch and path search, empty results, and the three workspace choices.
- Existing `tests/e2e/thread-sidebar-resize.spec.ts` and `tests/e2e/thread-worktrees.spec.ts`: all seven tests passed. Their regenerated unrelated tracked screenshots were restored.
- `npm test -- --maxWorkers=2` on the main-based PR checkout: 6,091 passed, 140 skipped, three failed. `devinAdapter.test.ts` failed dispatch-identity reconciliation (uncertain instead of accepted) and final-loaded-model replay (disconnected). `gitPullRequests.test.ts` failed fixture setup because Git could not spawn `git rev-list`. None of those files changed in this PR; the local full gate is not claimed green. The serial result is saved in `.cache/tests-final.log`.
- Targeted rerun, `npx vitest run tests/integration/devinAdapter.test.ts tests/unit/main/gitPullRequests.test.ts --maxWorkers=2`: 78 passed, six skipped. All three failures passed without code changes. GitHub's full Windows gate remains required before merge.
- Earlier overlapping build/test attempts exhausted Windows virtual memory. The successful final build used process-local `GOMAXPROCS=2`, `GOMEMLIMIT=256MiB`, and `NODE_OPTIONS=--max-old-space-size=1536`; the full suite then ran serially with the same settings. No user apps were closed and no system settings changed.

The Electron fixture has 12 real Git worktrees and a saved unstarted draft. Its host badge markup is supplied in the renderer to exercise the multi-host layout without making an SSH connection; the actual HostBadge component and host visibility are covered by `hostVisibility.test.tsx`. This is Windows verification; macOS and a live remote-host connection were not exercised.

Selected evidence committed for this verification; intermediate generated captures remain ignored:

- [Wide project header](../../artifacts/workspace-picker/project-header-wide.png)
- [Narrow project header](../../artifacts/workspace-picker/project-header-narrow.png)
- [Workspace menu at 1280, dark](../../artifacts/workspace-picker/workspace-1280-dark.png)
- [Workspace menu at 820, dark](../../artifacts/workspace-picker/workspace-820-dark.png)
- [Workspace menu at 820, light](../../artifacts/workspace-picker/workspace-820-light.png)
- [Workspace search in a lower split pane](../../artifacts/workspace-picker/workspace-lower-pane.png)

## Pre-PR review

The fixed point is `ef5ee7274e0793c2b2d27f306a2c994d2155217b` on main. Independent in-session GPT-6-astra reviewers checked Standards and Spec. The external GPT/Grok commands requested by the code-review skill were rejected by automatic approval review because they would send the private diff and instructions to separate review services; no external review was run.

Standards: no actionable findings. Spec: one finding, that a lower grid pane could clip the menu because vertical capacity was measured against the window alone and `closest()` chose the composer before the pane. The lower-pane Electron regression reproduced this. Placement now measures the actual pane, intersects it with the viewport, caps the popup at 380px, and observes both the pane and composer for size changes. The regression checks the menu rectangle against the lower pane and both starting choices before clicking New worktree; it passes after the fix.

The initial standards pass checked theme roles, keyboard dismissal and focus, host identity, project scope, absence of renderer networking and new dependencies, and the required size/mode captures. The spec pass checked the two screenshot symptoms, the approved A layout, both persistent choices, five recent unique worktrees, and search beyond the initial five. No implementation gap remained in those checks. No installer or release was produced.
