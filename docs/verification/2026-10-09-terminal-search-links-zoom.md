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

The generated folder is ignored by lint and Git; only the 36 cited search and link-choice PNGs are retained in the commit. Paths are relative to `artifacts/terminal-search-links-zoom/`.

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

| Link choices | Size | Dark | Light |
| --- | --- | --- | --- |
| Terminal mode | 1600×1000 | `workspace-links-1600x1000-dark.png` | `workspace-links-1600x1000-light.png` |
| Terminal mode | 1280×800 | `workspace-links-1280x800-dark.png` | `workspace-links-1280x800-light.png` |
| Terminal mode | 820×560 | `workspace-links-820x560-dark.png` | `workspace-links-820x560-light.png` |
| Terminal drawer | 1600×1000 | `drawer-links-1600x1000-dark.png` | `drawer-links-1600x1000-light.png` |
| Terminal drawer | 1280×800 | `drawer-links-1280x800-dark.png` | `drawer-links-1280x800-light.png` |
| Terminal drawer | 820×560 | `drawer-links-820x560-dark.png` | `drawer-links-820x560-light.png` |
| Tools | 1600×1000 | `tools-links-1600x1000-dark.png` | `tools-links-1600x1000-light.png` |
| Tools | 1280×800 | `tools-links-1280x800-dark.png` | `tools-links-1280x800-light.png` |
| Tools | 820×560 | `tools-links-820x560-dark.png` | `tools-links-820x560-light.png` |

## Shortcut audit

Searched renderer `keydown` listeners and their helpers before claiming `mod+f`, `mod+=`, `mod+-` and `mod+0`. Compared them with History's `mod+k`, the drawer's `mod+j`, Changes' `mod+d`/`mod+shift+d`, New thread's `mod+shift+n`, toolbar `mod+shift+g`/`mod+shift+x`/`mod+shift+l`, pane zoom's Ctrl+Shift+M, F6 navigation, terminal Ctrl+Tab/Shift+Tab, copy/paste and dialog Enter/Escape.

The default dictation chord is CmdOrCtrl+Shift+Space on Windows/Linux and Control+Shift+Space on macOS. Every terminal shortcut checks the current saved dictation chord through the existing `chordClaimed` helper; a user-configured collision leaves that chord to dictation. Keypad `numsub` and `num0` accelerators are normalized for their actual keypad events, preserving the corresponding top-row terminal shortcut. Unit cases cover Windows, macOS and Linux modifiers and all four collisions. Only a focused terminal view claims the new chords.

Electron's native View-menu zoom overlaps `mod+=`, `mod+-` and `mod+0`. The main window now yields precisely those menu shortcuts while a terminal or its search controls have focus, using `before-input-event` and `setIgnoreMenuShortcuts`. Edit-menu copy/paste and other native shortcuts remain active. The running-app check confirms terminal zoom does not zoom the page.

## Builder gates and review

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

## Finishing review

The finishing pass read the three supplied reports under `%TEMP%/terminal-run/881/`: `review-standards.out.md`, `review-spec.out.md` and `design.out.md`. Duplicate findings are grouped below.

- **Image input order (both axes): fixed.** The paste event reserves the renderer's input lane before PNG conversion. Main queues staging and path insertion with writes, including ownership checks and restarted sessions. Deferred conversion/save tests hold later Enter and additional pastes; every real-PTY journey pastes and immediately presses Enter.
- **Literal image paths (spec): fixed.** PowerShell and POSIX single-quote encodings preserve expansions, backticks and apostrophes. A real PowerShell round-trip verifies a path containing `$()`, a variable reference, backticks, ASCII and smart quotes.
- **Existing shortcuts (both axes): fixed.** Search consumes only its handled keys. Every search control has event tests for F6, Shift+F6, Ctrl+Shift+M and Ctrl/Cmd+K. The real drawer journey checks Ctrl+J and opens History from search.
- **Keyboard link activation (standards): fixed.** Tab from search to Open terminal link, then select a native button showing its label and destination. Plain URLs and named OSC 8 links use the same validated main bridge as clicks; unsafe destinations never appear. Escape restores focus. Real-PTY journeys check named and plain links from the keyboard.
- **Overlay hides matches (design): fixed.** Search reserves a row above output. A drawer saved at its 120-pixel minimum temporarily grows to 184 pixels while searching, then restores its saved height. Link choices use the top layer, stay in the viewport and follow their trigger through window resizing. All three surfaces have bounds and highlight-alignment assertions at all capture sizes.
- **Font finishes loading after terminal opens (design): fixed.** Both terminal renderers remeasure when the bundled font loads. Deferred font-loading unit tests cover the DOM and WebGL paths.
- **Escape closes search before reaching the shell (design): retained.** Issue #881 explicitly requires Escape to close search and restore terminal focus; CONTEXT.md and ADR-0049 agree. With no link choices or search open, Escape still belongs to the shell. Changing this would contradict the agreed keyboard path.
- **Highlight fills differ from the prototype (design): retained.** The approved bar's geometry and tokens remain. xterm's current-match selection and bright border distinguish it from other matches' rings, while the count also names the active match. The design report measured count contrast above 4.5:1 in both appearances and found the hierarchy clear. Keeping xterm's selection avoids a second text renderer; light/dark captures and real highlight/text alignment checks cover the result.
- **macOS and Omarchy not run (design): limitation confirmed.** This pass proves the built Windows app with native ConPTYs. It does not claim a packaged-installer, macOS or Omarchy check.

Two additional independent Sol reviews at max reasoning were kept separate as `finishing-standards.out.md` and `finishing-spec.out.md`. Every actionable finding was fixed: search now preserves its active match across case differences, ConPTY repaint and soft-wrap reflow; overwritten OSC 8 destinations are removed even when their label is unchanged; the shortest drawer remains searchable; oversized images name the 10 MiB limit before IPC validation; and paste failures disclose when later queued input was discarded. Real xterm-addon tests exercise repaint/reflow and link replacement. Store tests cover both failure messages.

The extra prototype compared reserved output space, a floating bar that scrolls matches clear, and a full-width search strip. The reserved row and compact link choices were chosen as a reversible assumption after the clarification prompt received no answer. The temporary HTML and variant images stay outside the repository. The new keyboard path adds no chord. Privacy hosts and production dependencies are unchanged.

During final Playwright verification, one bounds read returned the previous composited popover position (right edge 1,231) while the DOM already reported the correct position (right edge 771) in an 820-pixel window. The assertion waits for current painted bounds, without a sleep. A separate real-window journey resizes while link choices remain open; a unit case verifies following and cleanup.

## Finishing gates and captures

| Gate | Final result |
| --- | --- |
| `npm run typecheck` | Pass, exit 0; all three TypeScript projects checked |
| `npm run lint` | Pass, exit 0; no lint errors |
| `npm test -- --maxWorkers=2` | Pass, exit 0; 631 files passed, 51 skipped; 9,280 tests passed, 222 skipped (682 files and 9,502 tests total); 1,301.43 seconds |
| `npm run notices:verify` | Pass, exit 0; 177 components verified |
| `npm run build && npx playwright test` with the five specs named above | Pass, exit 0; build succeeded; 8 tests passed, 0 failed, 0 skipped, one worker (1.3 minutes) |

The finishing pass ran `npm ci` first and ran the full suite once near the end, after the final source changes and app checks. The 36 cited screenshots were retaken by the passing Playwright run and inspected as paired light/dark contact sheets, including full-size minimum-window views. Search never covered output or its matches; focused link choices stayed inside the window. All captures have reduced motion enabled. Existing `review-384` and `terminal-display` images were restored after their specs. No design baseline changed.

All required local gates passed. This evidence covers local build/app verification, not a packaged installer or GitHub CI.

## Compatibility with main after publication

The initial PR reported three conflicts with main's later test/evidence cleanup: concurrent additions in `.gitignore` and `docs/ci.md`, plus the deleted monolithic `tests/integration/ipc.test.ts`. The terminal ignore and guide sections were moved outside those competing hunks. The unchanged font-size IPC assertion now lives in `tests/integration/terminalPreferencesIpc.test.ts`, using the exact shared `tests/fixtures/ipcHarness.ts` already on main. The old IPC file is unchanged from this branch's base, so main's split can delete it normally. No branch merge, rebase or application change was needed.

The full-suite and native-app results above cover the final application code, before this test relocation. The relocated IPC case, test discovery and tracked-file encoding checks passed afterward: `npx vitest run tests/integration/terminalPreferencesIpc.test.ts tests/unit/release/testDiscovery.test.ts tests/unit/release/trackedFileEncoding.test.ts --maxWorkers=2`, exit 0, 3 files and 4 tests passed. Typecheck, lint and notices were repeated for the final revision. The full suite was not repeated for an unchanged application and assertion.

Main then advanced again with #886's shared test fixtures. This changed the same terminal mocks and IPC fixture, so `cc732e398c95989497c0cb54787009ca467bf4b5` was integrated into the feature branch. Upstream factories and every terminal acceptance assertion were preserved; the shared terminal bridge gained the new `pasteImage` method. The new interaction spec now uses the upstream evidence helper, with publication explicitly enabled when refreshing the 36 cited images. The six affected IPC/terminal test files passed after reconciliation: 57 tests, exit 0, two workers. The required gates are repeated for this integrated revision; the earlier full-suite result above remains historical. PR #888 stays open and unmerged.

### Windows archive tool correction

The first integrated full-suite run exited 1: 737 files and 9,391 tests passed; one file and three tests failed; 53 files and 266 tests were skipped (791 files and 9,660 tests total), in 1,468.32 seconds. All three failures were `tests/unit/release/linuxTarball.test.mjs`, before archive verification could run. Git's `C:\Program Files\Git\usr\bin\tar.exe` was first on PATH; its GNU tar interprets an absolute Windows archive path's `C:` as a remote host and reports `Cannot connect to C: resolve failed`.

A tiny archive reproduced exit 128 with the absolute path and exit 0 with a relative path. The original release test reproduced all three failures in 8.53 seconds. Windows's native `C:\Windows\System32\tar.exe` (bsdtar 3.8.8) accepted the absolute path, and the same unmodified release tests passed: three passed, seven skipped, exit 0, 0.733 seconds. A native-tool full rerun was stopped so the fix could support the ordinary command with either tar on PATH.

Fixture packing and Linux distributable extraction now pass a relative archive name from its containing folder. Fixing packing alone reproduced the same drive-letter failure at extraction, confirming both call sites. The existing archive and platform tests passed after both fixes: two files, 11 tests passed, seven skipped, exit 0; 0.642 seconds with Git's GNU tar and 0.501 seconds with Windows's native BSD tar. Content and permission assertions remain intact. The required gates are repeated with the normal PATH; the user's PATH is unchanged. Forge verification is awaiting its Tailscale SSH authentication check.

## Final Windows gates on the integrated branch

These results cover `ba1257b09`, including main through `cc732e398c95989497c0cb54787009ca467bf4b5` and the portable archive invocation. The ordinary full-suite command used Git's GNU tar from the normal PATH, without an environment adjustment.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | Pass, exit 0; all three TypeScript projects checked |
| `npm run lint` | Pass, exit 0; no lint errors |
| `npm test -- --maxWorkers=2` | Pass, exit 0; 738 files passed, 53 skipped; 9,394 tests passed, 266 skipped (791 files and 9,660 tests total); 1,328.01 seconds |
| `npm run notices:verify` | Pass, exit 0; 177 components verified |
| `npm run build` | Pass, exit 0 |
| Playwright with the five specs named above | Pass, exit 0; 8 tests passed, 0 failed, 0 skipped, one worker (1.5 minutes) |

The final Playwright run refreshed all 36 cited images; all six paired contact sheets were inspected afterward. Search and link choices fit the required sizes in both appearances with reduced motion. Existing `review-384` and `terminal-display` baselines were restored. The delivery check verified the 36 cited files, UTF-8 without BOM in all 57 changed text files, and a clean whitespace diff. The final evidence commit changes documentation and cited captures only.

### Remaining access requirement

The Linux archive helper still needs its Forge check under ADR-0062. SSH reported `Tailscale SSH requires an additional check` and timed out; the prepared Node harness never executed remotely. It will check complete contents, missing resources, changed executable contents, relative paths and seven permission changes against the committed scripts. No file was copied to Forge. Browser authentication was not attempted: the computer-use skill's mandatory guidance forbids automating user authentication dialogs.

The listed Windows gates are green. The latest local revision and prepared PR body are held for this required Linux verification. PR #888 remains open and unmerged; its remote head is still `606b5cfb1` until the final push.
