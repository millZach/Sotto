# Phase 5 Git / pull-request verification

Ticket #61; desktop target already agreed: 1280x860, 1600x1000, minimum 820x560; dark/light/system, keyboard and reduced motion.

Acceptance checklist:
- [x] Review branch/worktree, actual push remote, base, editable title/body before any explicit action.
- [x] Existing PR lookup and create reconciliation prevent duplicates; truthful checks/reviews and actionable refresh errors.
- [x] PR/check links use existing per-thread browser preference.
- [x] Controlled bare-remote push and faithful GitHub CLI fixtures, with no real remote publishing.
- [x] Typecheck, focused command/renderer checks and rendered Electron journey.

Tastify: scoped addition to existing tools-panel identity. Inspected phase-four-git/git-actions-1280-dark.png and pinned T3 GitHubCli.ts list/get/create flow. Carry compact working-copy context, familiar native controls, title/body review and explicit action. A pull-request surface lets the reader review the destination and publish their chosen branch; its proof is the actual branch appearing in the owned remote only after Push.

Concepts considered: PR as another tiny Git drawer; PR as dedicated review pane; PR as modal. Selected dedicated review pane within Changes: enough room to review at minimum desktop size, with persistent Back/Refresh and one scrolling form. Existing Sotto typography/colors remain; labels/controls >=14px, status meaningful, remote URLs wrap. No decorative artwork (working tool), transition is quiet pane replacement with immediate working status; no motion needed beyond existing focus feedback, reduced-motion unchanged. Five core form labels: Remote, Base branch, PR title, PR body, publish action. Branch/URL and errors/checks are required state/operating information. Render review will check copy repetition, keyboard reachability, overflow and theme contrast.

Test seams: existing approved Git tool command interface with owned repositories and faithful command fixtures, plus renderer/Electron user interactions. No private methods tested.

## Completed verification

- Focused `npx vitest run tests/unit/main/gitPullRequests.test.ts tests/unit/renderer/tools/gitPullRequest.test.tsx`: 6 passed. Existing Git command ownership seam now covers explicit owned bare-remote push, rejection after branch switch, split fetch/push remote destinations, matching existing PR identity, create response loss reconciliation, changed check/review state, merged PR visibility, authentication refusal, credential redaction. Renderer checks edited title/body/base delivery, absence of write on view, owning-thread link routing, and late-response isolation when switching workspaces.
- Observed red-to-green cycles: missing publication service; absent PR creation/status mapping; merged-PR disappearance; URL credential exposure; split remote fetch/push mismatch. Tests that only add final renderer journey coverage were run after implementation.
- `npm run typecheck`: passed after integration syntax fixes; production build passed. Root owns the one final full suite and independent code review.
- `node scripts/inspect-phase5-git.mjs`: passed in a disposable Electron profile and owned repository. Verified the bare remote had no branch after viewing, pressed Enter on Push branch, and read back identical commit `fb951941c5e62fc5a01ff04b94140320570faa39` in the owned remote. No real GitHub write was issued.
- Owned profile: `C:/Users/zache/AppData/Local/Temp/sotto-e2e-phase5-pr-dOlgBi`; remote: `owned-remote.git` beneath that profile. Fixture PR creation submits reviewed fields through the renderer/preload IPC seam; production backend create/reconciliation is separately verified with faithful gh JSON/command fixtures. Root also confirmed the installed gh supports the selected read-only JSON fields.
- Captures: `artifacts/phase-five-git/` includes 1280x860, 1600x1000 and 820x560 in dark/light/system, owned push, PR status and authentication failure. Every dimension/theme was exercised with reduced motion and checked for horizontal overflow. Keyboard moved from body to Push to Create and Enter submitted the intended action.

## Rendered review and Tastify acceptance

Inspected final 820 light review, 820 system PR status/auth error, 1280 dark review, and 1600 dark review at normal zoom. Sotto's existing surfaces, accent focus ring and typography remain. The editable form dominates; no new cards, artwork or decorative copy. The 1600 view exposes all review fields; the minimum desktop view scrolls the form while Back/Refresh and publication actions remain available. The toolbar was compressed to one row after the first review. The PR status capture shows the title link, explicit branch direction, aggregate review and named check results; corrupt punctuation in the initial capture was fixed with JSX entities and recaptured.

First-screen core form labels: Remote, Base branch, PR title, PR body, Push branch/Create pull request (two explicit operations), plus Back and Refresh. This exceeds the five-element default because these are necessary operation labels, not added marketing copy. Branch/commit, destination URL, result/error and checks are required safety/operation state. No headline or companion paragraph duplicates them. At minimum height the title/body are reachable by scrolling and keyboard; controls remain >=14px, secondary URL/commit 12px. Motion is intentionally a direct state replacement; reduced motion is coherent. Following final screenshot inspection a disabled-button opacity rule was added so unavailable Create reads visually disabled; the final integrated build/capture should include this final CSS detail.

## Limits

Final integrated rerun passed after the destination and disabled-state fixes. Its owned local push was `cc82c72aadbf2307eb3519436c75babd19da40d8`, under disposable profile `sotto-e2e-phase5-pr-srAMBO`; real GitHub writes remained zero. The expanded capture adds all six built-in palettes in both appearances at normal/minimum sizes. Root inspected the minimum palette contact sheets plus final PR status/authentication views: the reviewed target, fields, focus and persistent actions remain legible. This final run supersedes the earlier smoke commit/profile above.

Pull requests use the selected GitHub remote as the repository/base target; choose another configured remote to change it. This slice does not add a cross-repository fork/base picker, force push, merge, or alternate hosting providers. Local and other Git remotes still support explicit push. No real GitHub PR was created, no project remote was pushed, and no production credential was required. Actual PR creation/review network behavior is represented by faithful CLI fixtures; a real owned bare-remote push supplied the authorized end-to-end mutation. Provider/native compaction/voice and final full-suite results are recorded by their owning agents.
