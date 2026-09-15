# Issue 74 short workspace regressions

Scope: the existing Windows desktop Threads workspace at 1280x560, 820x560 and regular desktop sizes. Preserve the selected Sidecar composition, fonts, colors, draft contents, attachments and thread ownership. No new design direction or animation is needed for this scoped fix.

Acceptance checks:

- At the minimum window and in a short split, the image draft, actions and usage footer fit inside the pane without pane overflow, while the transcript retains at least 90px. Keep prompt type 16 px, action labels 14 px and action height 34 px; recover space through layout rather than text reduction.
- Keyboard traversal into usage details retains focus. Focus on Write here must hold that button through pane selection; Enter must reach the managed composer without a frame on document.body. Held/refused Manage retains the original draft and sends nothing.
- Files follow the focused thread or the explicitly pinned owner, including separate Git worktrees. Sidecar stays docked and switches the remaining pane area to tabs when space requires; the compact sidebar hides and returns. Escape/Enter closing retains focus across the pane relayout.
- Inspect final rendered short-window, focused/pinned Files and light/dark captures. Essential existing labels are composer text, its provider/options, attach/remove controls, send/clear actions, queue state, usage state and thread controls; they convey separate actions/state and remain necessary. Introduce no decorative copy, size reduction or new animation.

Baseline reproduction: `npx playwright test tests/e2e/composer-short-window.spec.ts tests/e2e/files-panel-split.spec.ts --workers=1 --output=test-results/issue74-composer-files` failed all three scenarios. The short managed split had 21 px pane overflow (card bottom 497, footer top 516, transcript 96). Shift+Tab targeted the newly added usage estimate summary, while the old test expected Write here. Files expected the superseded 380 px panel and pre-Sidecar overlay behavior.

## Investigation

Ranked causes, checked against the reproduction:

1. The usage footer, added after this test was written, takes height the composer previously used. Confirmed: in the short managed split the pane scrolled 21 px, with the card ending at 497 and the footer starting at 516.
2. Queue sizing prevents the pane from shrinking. Refuted: the queue strip kept its single-line height; the overflow tracked the footer and header rows.
3. The footer changed keyboard order. Confirmed, but as a stale expectation, not a defect: usage details now follow the composer, so Shift+Tab from the divider correctly reaches their summary first, and focus stays there without falling to `document.body`.

The Files scenarios asserted the pre-Sidecar 380 px panel, overlay mode at the minimum window, and the retired sidebar thread label. The shipped Sidecar keeps the panel docked, hides the thread sidebar at the minimum window, and switches the remaining panes to tabs when the dock leaves too little width. These were stale expectations too.

## Changes

Production changes are CSS only, in `src/renderer/src/agents/splitWorkspace.css`:

- In a short, narrow split pane (container at most 600 × 600), header actions use 4 px inline padding, so Tools stays on the action row.
- Below 600 px window height, the pane tab strip loses 2 px of top padding, and tabs keep a 34 px minimum height.
- In panes at most 450 px tall, compose, header and usage padding tighten (compose 2 px top, 4 px bottom; header 4 px; usage 0).

The prompt stays 16 px, action labels 14 px, and actions 34 px tall. The test asserts all three rather than relying on captures.

Test updates keep each requirement and change only retired assumptions:

- `composer-short-window.spec.ts` now also requires the usage row above the application footer, at most 1 px of pane scroll, a 16 px prompt, and 34 px / 14 px actions. The keyboard journey covers usage details first. It then focuses Write here directly, which must keep focus through pane activation with zero frames on `document.body`.
- `files-panel-split.spec.ts` and `files-panel.spec.ts` expect, at the minimum window, the docked Sidecar, a hidden sidebar and tabbed panes. They also expect the pinned-owner label and the current Browser, Terminal, Files, Changes tab order. Escape inside the panel keeps it open with focus on the Files tab; Enter on Close returns focus to the owning thread. Captures now go to `test-results/issue74-ui-captures/` instead of overwriting committed artifacts from earlier phases.

## Results

After the final CSS change, `npx playwright test tests/e2e/composer-short-window.spec.ts --workers=1` passed 2 of 2, and the Files journeys passed in the same session. The combined regression run is recorded in [issue-74-workspace.md](issue-74-workspace.md).

Rendered captures, inspected on Windows:

- `composer/820x560-docs-managed.png`: the queue strip, a two-line draft with its image, the model and effort controls, Clear, Send it and the usage row all sit above the application footer, and the transcript still scrolls above them.
- `composer/1280x560-workshop-manual.png`: both panes of the short split stay readable side by side, with every header action on one row and unchanged type sizes.
- `files/docked-pinned-820-light.png`: at the minimum width the pinned panel docks beside a usable conversation, the sidebar is hidden, and the panel header names the pinned owner.

No copy, color, font size or animation changed. macOS is not verified.
