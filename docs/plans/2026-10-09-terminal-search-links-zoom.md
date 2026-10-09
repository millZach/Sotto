# Terminal basics (#881)

Branch: `feat/terminal-search-links-zoom`, based on `e7e853235dceabc5356c94c23d1f844d81f8081c` from `origin/main`.

The issue and the supplied `terminal-agent-state-prototype.html` settle the look: a compact Find field, match count, previous, next and Close, inside the terminal at the top right. The reference's search bar is identical in every variant. Its markup was inspected; the prototype stays outside this branch. The background source is `2026-10-09-herdr-terminals.md` in the same supplied thread checkout.

## Deliverables and acceptance

- One shared xterm implementation for Terminal mode, each pane's Terminal drawer and Tools: output search and highlights, safe modifier-click URLs and OSC 8 links, saved terminal text size, Unicode 11 widths, and image paste.
- Keep the approved appearance, theme tokens, accessible names, keyboard navigation and Escape-to-terminal focus. Check light, dark, reduced motion and all three required window sizes.
- Compare each chord against the current global dictation hotkey and the existing renderer handlers. Account for Electron's native View-menu zoom before the renderer; leave Edit-menu copy and paste working.
- Exact renderer addon devDependencies compatible with xterm 6.0.0. Keep production dependencies at zod and node-pty; ship addon notices.
- Update user-facing documentation and the drawer's older claim that every other key goes to the shell.
- Prove the three real-PTY paths, retain cited screenshots, run the four CI gates and the five affected Playwright specs, then review standards and issue coverage separately.
- Commit locally on this branch. No push or pull request.

## Implementation choices

One setting, `terminalFontSize`, applies to every terminal. It defaults to the existing 13 pixels and is bounded at 8–32 pixels. App's existing settings queue serializes saves; pending zoom presses are not undone by older acknowledgements. A font change fits and resizes the real PTY, including views already created. No terminal output is persisted with the preference.

The search bar follows the existing xterm view's lifetime, retaining its query when a pane is hidden. Empty or closed search clears both decorations and the search selection. Theme changes rebuild the addon's cached decorations. Links use the existing main external-link bridge, with HTTP/HTTPS validation in the renderer and the existing main validation. Images reuse Terminal mode's PNG staging helper in the working folder's ignored `.sotto/clipboard` directory.

## State

The acceptance criteria are complete: implementation, user documentation, the two independent reviews and all six fixes, the full two-worker suite, the five real-PTY Playwright specs and visual inspection of the 18 light/dark captures. Final counts and platform limits are recorded in `docs/verification/2026-10-09-terminal-search-links-zoom.md`. Delivery is a local commit on this branch; pushing and opening a pull request remain with the lead.
