# Sidebar thread navigation follows the rail

November 21, 2026. Worktree: `cf19bfa6-a41f-4a33-95f9-8994dfa642ae`, branched from `origin/main` at `d147285e73e1de4b420bb84f63d3132c809fed87`. Node 24.22.1, Apple silicon macOS. No live provider or paid service was used.

## Cause and entry points

`ThreadsView` mounts `ThreadSidebar` with `shortcutsLive` and passes its focused Sotto thread ID. Its `openThread` sends `select-thread`. `ThreadSidebar` resolves the user's Next/Previous shortcuts (Ctrl+Alt+Down/Up; Cmd+Option on a Mac), and its window keydown handler previously always stepped through `openOrder`.

That order is the expanded list's project-folder order or Working now followed by Recent (ADR-0201). The collapsed rail is independent: ADR-0146's project trays put waiting and moving tiles together, then resting tiles at the foot. Waiting or watched settled threads can have tiles too. The rail's plain arrows already use `useRovingList` and DOM order, move focus without selection, and do not wrap (ADR-0164).

Next/Previous now read `listControls(railNav)` when the rail is showing, selecting only its `rail:` thread controls in rendered order. This shares the plain arrows' exclusion of menus, cards, hidden/inert and disabled controls. Reading happens on the shortcut, with no added work on a streamed update. Expanded and overlay lists retain their prior order, including folded groups. Wrap, shortcut guards, dictation priority, Settle/Restore and Next waiting are unchanged.

## Regression and checks

- Before changing production code, the new targeted rail regression failed in both project and status settings: Down expected `wav-stall`, but the unfixed handler requested `grok-previews`. The source at that point was the base commit above. The failing command was `npx vitest run tests/unit/renderer/threadSidebarRail.test.tsx -t 'steps both ways'`.
- After the fix, the three targeted renderer files passed: **55 tests**. They check every adjacent pair and wrap in both directions, project/status settings, rail feature on/off, a watched settled tile, and unchanged expanded navigation through folded groups. Existing plain-arrow and row-menu tests are included.
- The new Electron journey passed on macOS using real `page.keyboard.press` events, every tile in both directions and wrap, under both grouping settings. Plain Up/Down kept their focus-only behavior and stopped at the first tile. This journey was then moved unchanged into `tests/e2e/sidebar-thread-navigation.spec.ts` and added to the Windows desktop smoke selection; the setup still uses the same design fixture.
- The displayed Electron order differed from the host's input order: Visual gate flake, Footer links, Weekly note, Grok voice previews, Streaming WAV stall. [Order receipt](../../artifacts/thread-list-keyboard/rail-navigation-order.json), [inspected screenshot at 1600×1000, dark](../../artifacts/thread-list-keyboard/rail-navigation-order.png). The screenshot shows the three project trays and resting tray, distinct provider marks, and the selected bottom tile.
- The older `thread-list-keyboard.spec.ts` also ran locally: **one passed, two failed**. One expects `Control+Shift+E` where macOS reports `Meta+Shift+E`; the same hard-coded expectation is present on the base. The other expects Tab after Expand to focus the current tile, but the intervening Watcher tile takes focus. These paths are outside the changed shortcut branch. No same-base executable comparison was run, so these are recorded as unresolved local failures, not flakes or proven main failures. Their assertions were left alone.
- Typecheck, lint and notices completed locally before the updated instruction to run CI only in GitHub Actions. The full local suite was stopped when that instruction arrived; no full-suite result is claimed. Final gates and the standalone Electron journey run in GitHub Actions.
- No interface strings, stylesheet, layout or design baseline changed. The additional screenshot is behavioral evidence, not a regenerated baseline. Light/minimum-size verification is left to retained CI evidence where available; no new local claim is made.

## Two-axis review

Standards: no new dependency, setting, host, permission, feature gate or terminology. The existing Sotto IDs, shortcut guards and Owl rail gates are retained. The control read runs only on a user action. Documentation and the desktop smoke selection reflect the regression coverage.

Spec: the actual selected-thread shortcut path now follows visible rail order rather than the input or expanded list. Tests exercise both directions, project/resting boundaries, wrap, settled watched tiles, both grouping settings, and the existing focus-only arrows. Expanded folded-group behavior remains covered. No unrelated production change was made.
