# Terminal basics (#881)

Branch: `feat/terminal-search-links-zoom`, based on `e7e853235dceabc5356c94c23d1f844d81f8081c` from `origin/main`.

After the PR opened, main's test splits and then fixture refactor landed. The first conflicts were avoided by relocating feature additions. The second refactor was integrated from `cc732e398c95989497c0cb54787009ca467bf4b5` on this feature branch so the shared terminal fixture could gain image paste. The PR remains open; the integrated revision receives the required gates again.

The issue and the supplied `terminal-agent-state-prototype.html` settle the look: a compact Find field, match count, previous, next and Close, inside the terminal at the top right. The reference's search bar is identical in every variant. Its markup was inspected; the prototype stays outside this branch. The background source is `2026-10-09-herdr-terminals.md` in the same supplied thread checkout.

## Deliverables and acceptance

- One shared xterm implementation for Terminal mode, each pane's Terminal drawer and Tools: output search and highlights, safe modifier-click URLs and OSC 8 links, saved terminal text size, Unicode 11 widths, and image paste.
- Keep the approved appearance, theme tokens, accessible names, keyboard navigation and Escape-to-terminal focus. Check light, dark, reduced motion and all three required window sizes.
- Compare each chord against the current global dictation hotkey and the existing renderer handlers. Account for Electron's native View-menu zoom before the renderer; leave Edit-menu copy and paste working.
- Exact renderer addon devDependencies compatible with xterm 6.0.0. Keep production dependencies at zod and node-pty; ship addon notices.
- Update user-facing documentation and the drawer's older claim that every other key goes to the shell.
- Prove the three real-PTY paths, retain cited screenshots, run the four CI gates and the five affected Playwright specs, then review standards and issue coverage separately.
- Commit review fixes on this branch. After every required gate passes, push and open a pull request closing #881. Never merge.

## Implementation choices

One setting, `terminalFontSize`, applies to every terminal. It defaults to the existing 13 pixels and is bounded at 8–32 pixels. App's existing settings queue serializes saves; pending zoom presses are not undone by older acknowledgements. A font change fits and resizes the real PTY, including views already created. No terminal output is persisted with the preference.

The search bar follows the existing xterm view's lifetime, retaining its query when a pane is hidden. Empty or closed search clears both decorations and the search selection. Theme changes rebuild the addon's cached decorations. Links use the existing main external-link bridge, with HTTP/HTTPS validation in the renderer and the existing main validation. Images reuse Terminal mode's PNG staging helper in the working folder's ignored `.sotto/clipboard` directory.

## State

The builder and design passes are committed. The finishing pass tracks the supplied reviews:

- [x] Install this worktree's dependencies with `npm ci`.
- [x] Keep image conversion, staging and insertion ordered with keys and later pastes, in renderer and main. Targeted tests: 4 files, 69 tests passed.
- [x] Quote image paths as literal shell arguments, including expansion characters and apostrophes; round-trip a sensitive folder name through real PowerShell.
- [x] Let app and pane shortcuts propagate from every search control.
- [x] Add keyboard activation for URLs and named OSC 8 links through the validated bridge; discard overwritten destinations.
- [x] Reserve space for search, grow the shortest drawer temporarily, and use the top layer for link choices. Compared three temporary prototypes outside this branch; chose reserved space and a compact picker as a reversible assumption after the clarification prompt.
- [x] Remeasure after font loading, preserve navigation across ConPTY repaint and soft-wrap reflow, and explain size failures and discarded input. Both finishing review axes' actionable findings are fixed.
- [x] Run the final gates, real-PTY journeys and visual inspection, then record the current evidence. Full suite: 631 files and 9,280 tests passed; 51 files and 222 tests skipped. Five affected Playwright specs: 8 tests passed.
- [x] Prepare the verified branch and PR body for the authorized push and pull request. Publishing follows the evidence commit; never merge.
