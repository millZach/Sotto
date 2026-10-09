# Terminal search, links and text size (#881)

Verified on Windows in the built Electron app, using real ConPTY sessions in Terminal mode, a thread pane's Terminal drawer and Tools. The supplied `terminal-agent-state-prototype.html` was inspected before implementation; its search bar is identical in all variants and remains outside this branch.

## Running-app journeys

- Search three matches in real output. Check incremental highlights, repeated Ctrl+F selecting the query without advancing, Enter, Shift+Enter, previous/next wrap, no matches, empty query and Escape from the Close button. Closing search removes decorations and returns focus to the terminal without sending search text to the PTY. Search 1,001 matches in Terminal mode and check the explicit `1000+` count.
- Hide and reopen the drawer with Ctrl+J while its search field has focus. The shell and query survive.
- Click a plain HTTPS URL and an OSC 8 HTTPS label with Ctrl held. Ordinary clicks do not open links; an OSC 8 `file:` link is refused. The test records main's `shell.openExternal` calls rather than opening a browser or making an external request.
- Increase, decrease and reset terminal text size. The visible font, saved setting and real PTY column count change together; Electron's page zoom stays at 1. Rapid increases survive a renderer reload, and the saved setting survives a complete app restart.
- Paste a native clipboard PNG on every surface. Check that pasting in Find creates no file, then paste into xterm and check the saved PNG signature, the ignored `.sotto/clipboard` folder and the quoted path received by the PTY. Unit tests also cover invalid images, stale/exited sessions and the wrong owner.
- Check Unicode 11 cell widths for CJK, emoji and a combining accent with the real addon. CJK and emoji are also rendered in each running-app journey.
- Exercise search with WebGL in Terminal mode, then force context loss and finish the same journey with the DOM fallback. Drawer and Tools journeys use the DOM renderer, including link hit testing.
- After a text-size change, check that each search highlight sits on its match's text in the DOM renderer at every capture size. The first captures failed this: xterm's DOM renderer measured its letter spacing before the new size was laid out, so after Ctrl+0 the text drifted up to a cell per word off its cells and the active match's fill covered the letter beside it. The view now has the DOM renderer measure again on the next frame after a size change or a remount; WebGL was not affected. The captures below were retaken with the fix.

All captures below use reduced motion. Each search bar and its controls were checked to remain inside the terminal and viewport; the images were visually inspected for layout and clipping in both appearances.

## Captures

The generated folder is ignored by lint and Git; only these 18 cited PNGs are retained in the commit. Paths are relative to `artifacts/terminal-search-links-zoom/`.

| Surface | Size | Dark | Light |
| --- | --- | --- | --- |
| Terminal mode | 1600×1000 | `workspace-search-1600x1000-dark.png` | `workspace-search-1600x1000-light.png` |
| Terminal mode | 1280×800 | `workspace-search-1280x800-dark.png` | `workspace-search-1280x800-light.png` |
| Terminal mode | 820×560 | `workspace-search-820x560-dark.png` | `workspace-search-820x560-light.png` |
| Terminal drawer | 1600×1000 | `drawer-search-1600x1000-dark.png` | `drawer-search-1600x1000-light.png` |
| Terminal drawer | 1280×800 | `drawer-search-1280x800-dark.png` | `drawer-search-1280x800-light.png` |
| Terminal drawer | 820×560 | `drawer-search-820x560-dark.png` | `drawer-search-820x560-light.png` |
| Tools | 1600×1000 | `tools-search-1600x1000-dark.png` | `tools-search-1600x1000-light.png` |
| Tools | 1280×800 | `tools-search-1280x800-dark.png` | `tools-search-1280x800-light.png` |
| Tools | 820×560 | `tools-search-820x560-dark.png` | `tools-search-820x560-light.png` |

## Shortcut audit

Searched renderer `keydown` listeners and their helpers before claiming `mod+f`, `mod+=`, `mod+-` and `mod+0`. Compared them with History's `mod+k`, the drawer's `mod+j`, Changes' `mod+d`/`mod+shift+d`, New thread's `mod+shift+n`, toolbar `mod+shift+g`/`mod+shift+x`/`mod+shift+l`, pane zoom's Ctrl+Shift+M, F6 navigation, terminal Ctrl+Tab/Shift+Tab, copy/paste and dialog Enter/Escape.

The default dictation chord is CmdOrCtrl+Shift+Space on Windows/Linux and Control+Shift+Space on macOS. Every terminal shortcut checks the current saved dictation chord through the existing `chordClaimed` helper; a user-configured collision leaves that chord to dictation. Keypad `numsub` and `num0` accelerators are normalized for their actual keypad events, preserving the corresponding top-row terminal shortcut. Unit cases cover Windows, macOS and Linux modifiers and all four collisions. Only a focused terminal view claims the new chords.

Electron's native View-menu zoom overlaps `mod+=`, `mod+-` and `mod+0`. The main window now yields precisely those menu shortcuts while a terminal or its search controls have focus, using `before-input-event` and `setIgnoreMenuShortcuts`. Edit-menu copy/paste and other native shortcuts remain active. The running-app check confirms terminal zoom does not zoom the page.

## Gates and review

| Gate | Result |
| --- | --- |
| `npm run typecheck` | Pass, exit 0; all three TypeScript projects checked |
| `npm run lint` | Pass, exit 0; no lint errors |
| `npm test -- --maxWorkers=2` | Pass, exit 0; 628 files passed, 51 skipped; 9,257 tests passed, 222 skipped (679 files and 9,479 tests total); 1,371.21 seconds |
| `npm run notices:verify` | Pass, exit 0; 177 components verified |
| `npm run build && npx playwright test` with the five specs below | Pass, exit 0; build succeeded; 8 tests passed, 0 failed, 0 skipped, using one worker (1.6 minutes) |

Playwright specs: `tests/e2e/terminal-search-links-zoom.spec.ts`, `tests/e2e/terminal-display.spec.ts`, `tests/e2e/pane-terminal.spec.ts`, `tests/e2e/terminal-loading.spec.ts`, and `tests/e2e/terminal-closed-output.spec.ts`.

`npm ci` ran first in this worktree; no dependency links were used. Addons are exact devDependencies: search 0.16.0, web-links 0.12.0 and unicode11 0.9.0 against xterm 6.0.0. Production dependencies remain exactly zod and node-pty. The full unit/integration suite ran once near the end, after both reviews and their fixes.

Two independent read-only reviewers ran with Sol (`gpt-6.1-sol`) at max reasoning against the staged implementation and the pinned base `e7e853235dceabc5356c94c23d1f844d81f8081c`. The reports were kept separate; all six findings were confirmed and fixed before the final gates.

### Standards

- P2: Find blocked the drawer's documented Ctrl+J/Cmd+J chord. Recognized drawer chords now propagate; the drawer PTY journey hides and reopens it from Find.
- P2: Editing only the Text theme role left the active-match border stale because xterm's own theme had not changed. Search now compares decoration colours separately, and the unit check covers an isolated Text-role edit and unchanged-colour filtering.
- P3: The main-process menu-shortcut test inherited jsdom. It now declares the required Node environment.

### Spec

- P2: Image paste in Find could stage a PNG and type its path into the shell. Image handling now accepts only xterm targets; each PTY journey checks Find before pasting into the shell.
- P2: Keypad subtraction/reset could claim a configured dictation accelerator. The actual keypad event now normalizes `numsub`/`num0`; unit cases cover both keypad conflicts and top-row availability on all three platforms.
- P2: The addon's 1,000-match highlight limit was presented as an exact total. The limit is explicit and the count shows `1000+` whenever it is reached; unit cases and the 1,001-match PTY scenario cover it.

The real-PTY specs are Windows acceptance checks. macOS and Omarchy were not run in this lane; platform modifier behavior is covered by unit tests. The app was built and launched locally, without packaging an installer, pushing a branch or opening a pull request. Existing terminal capture baselines were restored after their tests; no design baseline was intentionally changed.
