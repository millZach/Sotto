# Layout and Usage: Zach's B picks

November 7, 2026. Zach picked B for the three items of the follow-up mock-ups' `layout.html` (kept outside the repository in `sotto-council/prototypes/followups/`). The images here were taken with `tests/e2e/review-evidence-capture.spec.ts` (states `split-panes`, `pr-ready` and `usage`) on a build of this branch, in dark and light at 1600, 1280 and 820; this note keeps a few. The "before" images are the mock-up's own crops of the earlier captures.

## 1. Split panes

- Before: [before-split-panes-dark.png](../../artifacts/layout-usage-picks/before-split-panes-dark.png). Both panes carried the full row of buttons, and the other pane's sidebar row was outlined.
- After: [split-panes-dark-1600.png](../../artifacts/layout-usage-picks/split-panes-dark-1600.png), [split-panes-light-1600.png](../../artifacts/layout-usage-picks/split-panes-light-1600.png). The focused pane, Repository review, shows its row. The left pane shows only its close. In the sidebar, Trace a permission request has no outline and shows the two-pane mark where its time was.
- `tests/e2e/pane-header.spec.ts` checks that the unfocused pane's Watch has no opacity at rest, that its close is shown, and that pointing at its header or Tab into it shows the row. The places and order of the buttons are checked as before.
- At 820 the panes are tabs, so one header shows and nothing changes there.

## 2. Usage

- Before: [before-usage-dark.png](../../artifacts/layout-usage-picks/before-usage-dark.png). The sixteen empty days before October 24 were drawn day by day, and the controls were boxed.
- After: [usage-dark-1600.png](../../artifacts/layout-usage-picks/usage-dark-1600.png), [usage-light-1600.png](../../artifacts/layout-usage-picks/usage-light-1600.png), [usage-sizes-dark-820.png](../../artifacts/layout-usage-picks/usage-sizes-dark-820.png). The empty start is one stretch, "No prompts for 16 days". Show, Bars | Lines and the four filters are text with no fill, in the same places, and the chosen ones read darker and bolder.
- The harness's own checks found nothing that overflows or clips, and no text under 4.5:1, at any of the three sizes in either mode.

## 3. Linked pull requests

- Before: [before-pr-ready-dark.png](../../artifacts/layout-usage-picks/before-pr-ready-dark.png). Linked pull requests showed only its count.
- After, with only its own pull request linked: [pr-ready-dark-1600.png](../../artifacts/layout-usage-picks/pr-ready-dark-1600.png). The closed head says its count alone, since the one linked is #1612, which the surface already shows as its heading (Zach's choice of November 7).
- After, with an earlier merged pull request also linked (state `pr-linked`): [pr-linked-dark-1600.png](../../artifacts/layout-usage-picks/pr-linked-dark-1600.png), [pr-linked-light-1600.png](../../artifacts/layout-usage-picks/pr-linked-light-1600.png). The closed head shows #1598, its title and Merged, and leaves #1612 out. At 820 the panel has no room, so no fold previews anything. Open pull requests previews nothing.
