# The Threads sidebar on every page

Verification of the `feat/sidebar-on-every-page` branch in the built app (`npm run build`, Electron under Playwright, Windows 11, 100% scale). The screenshots are in `artifacts/sidebar-on-every-page/`; each name carries the page, the window size and the appearance. The look was chosen on the `prototype/dictate-sidebar` branch (`docs/prototypes/dictate-sidebar-prototype.html`, verdict in its header), where the user picked look A for Dictate: the same sidebar, unchanged.

## What was checked

| Journey | Evidence | Result |
| --- | --- | --- |
| Dictate seats the Threads sidebar beside the room, the mark with the wordmark in the top row, the window controls on a drag strip above the room, the model sentence in a thin foot under it | `dictate-1280x800-dark.png`, `dictate-1280x800-light.png`, `dictate-1600x1000-dark.png`, `dictate-820x560-dark.png` | The room keeps its composition at every size; nothing clips at 820x560. |
| History and Help take the same sidebar; Clear history moved from the footer into the History head | `history-1280x800-*.png`, `help-1280x800-*.png`, `history-820x560-dark.png`, `help-820x560-dark.png` | Head fits on one line at 820. "Kept on this computer only." sits in the foot under the room. |
| Settings and Chats keep their own column and give it the sidebar top row and the sidebar foot; window controls at the top right and the page's sentence in the bottom-right corner | `settings-1280x800-*.png`, `chats-1280x800-*.png`, `settings-820x560-dark.png`, `chats-820x560-dark.png` | The Settings sections scroll inside the column at 560 tall while the foot stays put. The Chats "Connect" notice clears the window controls. |
| The sidebar foot lights the open room or page: Dictate on Dictate, Threads on Threads and Chats, the page icon on History, Settings and Help | every page capture | The lit control matches the page in each capture. |
| A thread that finishes while the window is on another page wears the finished ring, and the ring clears once the thread is on screen in a pane on Threads | `dictate-finished-1280x800-dark.png`, `threads-after-finished-1280x800-dark.png` | Footer links wears the green filled ring on Dictate; on Threads, with the thread open in a pane, the row is plain again. |
| Terminal mode's project head offers Settle project; the folder actions sit centred on the head row in both modes | `terminal-folder-actions-1280x800-dark.png`, `thread-folder-actions-1280x800-dark.png`, `threads-terminal-*.png` | New terminal and Settle project align with the head in Terminal mode; New thread and Settle project align in the thread list. |
| Light and dark, all pages | the `-light` and `-dark` pairs at 1280x800 | Colour comes from the theme roles; the status sentence reads on both. |

## Keyboard

- On Settings the column is one tab sequence: the sections, then the sidebar foot (the room switch, the page links, the update control), then the open section's panel. `tests/unit/renderer/settingsView.test.tsx` walks it.
- The sidebar beside Dictate answers the same keys as on Threads (arrow keys on the mode switch and the room switch). `tests/unit/renderer/pageSidebar.test.tsx` covers the sidebar's own behaviour on a page: open a thread, New thread, the Terminal side of the switch.

## Gates

Recorded in the pull request: `npm run typecheck`, `npm run lint`, `npm test -- --maxWorkers=2`, `npm run notices:verify`, `npm run design:capture` (baselines regenerated because the look changed on purpose), and the Playwright specs for the shell, the crossing pages, the thread workspace, Terminal mode and the Settings index.

## macOS

Not run on a Mac in this pass. The macOS branch hides the wordmark under the traffic lights (`.thread-nav--mac .thread-nav__wordmark`) and leaves the window controls to the system in the sidebar layout, which `tests/unit/renderer/appShell.test.tsx` checks.
