# The thread list is one Tab stop with a row menu, and F6 goes round the regions

October 30, 2026. The branch `feat/thread-list-keyboard` from `main` at 6f24ccbfd, closing #1827 (finding 9 of `docs/research/2026-10-29-ui-hillclimb-desktop.md`) with Zach's pick A, recorded in ADR-0164. Checked on forge in the owned nested Omarchy desktop, at 1600x1000, 1280x800 and the 820x560 minimum, in dark and light, and with reduced motion on.

## What changed

- The thread list (its folders, rows and the Settled shelf) is one Tab stop. Up and Down move through it, Home and End go to its ends, Right and Left open and close a folder and step in and out, and Enter opens the thread. The list remembers the row it last held, and starts on the thread on screen.
- Shift+F10, the menu key or a right-click on a row opens its row menu: Open (Enter), Open beside, Rename (F2), Regenerate title, Watch and Settle or Restore, with their keys. Escape closes it and puts the focus back on the row. F2 renames the row. A folder's head has its own menu with New thread here and Settle project. The hover icons stay for the pointer, out of the Tab order.
- F6 and Shift+F6 go round the regions: the sidebar (at the list's stop), the focused pane (at its transcript) and its composer (at its prompt). In a split, the trip from the sidebar starts at the focused pane and goes round every pane before it comes back.
- The collapsed rail's tiles are one Tab stop with Up and Down.
- Settings › Keyboard lists the four fixed keys under Fixed & elsewhere.

## Tab counts

Measured by pressing Tab from Search threads until the focused pane's composer had the focus, on the design-threads fixture with Streaming WAV stall open, in the built app on the nested desktop. "Before" is a build of `main` at 12d0efa76 in a throwaway worktree, "after" this branch. The two lists of stops are in `artifacts/thread-list-keyboard/tab-walk-before.json` and `tab-walk-after.json`.

| Build | Window | Presses to the composer | Stops in the sidebar |
| --- | --- | --- | --- |
| `main`, stable | 1600x1000 and 820x560 | 51 | 44 |
| `main`, Owl | 1600x1000 and 820x560 | 53 | 46 |
| This branch, stable | 1600x1000 and 820x560 | 13 | 6 |
| This branch, Owl | 1600x1000 and 820x560 | 15 | 8 |

After the change the sidebar's stops are: the Needs you card's two (Owl only, still right after the search field, as ADR-0135 asks), the thread list (Streaming WAV stall), the room tab, Usage, Settings, Help and Resize sidebar. Before, the list alone took 39: three folders with their New thread and Settle project icons, five rows with up to five icons each, and the Settled shelf. The pane's seven stops (the working copy, Watch, More actions, the transcript, two Copy buttons, the prompt) are the same before and after.

## How it was run

```sh
npm run i18n:extract
npm run build
node scripts/verify-linux-window-minimum.mjs --exec "$PWD/node_modules/.bin/playwright" test tests/e2e/thread-list-keyboard.spec.ts
node scripts/verify-linux-window-minimum.mjs --exec "$PWD/node_modules/.bin/playwright" test tests/e2e/watcher.spec.ts -g "Watch from a pane header, a row and All threads"
node scripts/verify-linux-window-minimum.mjs --exec "$PWD/node_modules/.bin/playwright" test tests/e2e/workspace-draft-and-delivery-journeys.spec.ts -g "keyboard navigation exposes folder actions"
node scripts/verify-linux-window-minimum.mjs --exec "$PWD/node_modules/.bin/playwright" test tests/e2e/split-workspace.spec.ts
```

Each run ran in the foreground, one at a time, with `NODE_OPTIONS=--max-old-space-size=3072`, and each removed its own Hyprland root and left the live Omarchy trees unchanged. The Tab counts came from a throwaway walk spec run the same way against each build; it is not committed.

| Spec | Result |
| --- | --- |
| `thread-list-keyboard.spec.ts` (new) | Passed. The Tab walk has exactly one stop in the thread list, the thread on screen, at both sizes. Down, Up, Home and End move through the list, and Shift+Tab then Tab comes back to where the list was. Shift+F10 opens the row menu with Open focused and Rename (F2) and Settle (Ctrl+Shift+E) showing their keys, wholly inside the window at both sizes; Escape, the menu key and a right-click at the pointer behave as above. F2 renames in place and Escape returns to the row. F6 goes row, transcript, prompt, row, and Shift+F6 the other way. In a split opened beside from the keyboard with Ctrl+Enter, F6 goes the new pane's transcript and prompt, the other pane's, and back to the row. At 1280x800 with reduced motion on, the menu is whole and has no animation. |
| `watcher.spec.ts`, the Watch journey | Passed: Shift+F10 on Weekly note's row, Watch ticked off, Enter watches it and the focus is back on the row. |
| `workspace-draft-and-delivery-journeys.spec.ts`, the keyboard journey | The folder menu part passed: Tab into the list, Home, Down to Sotto test's folder, Shift+F10, Settle project focused with a 3px ring, Escape back to the folder. The journey then failed at its failed-send Retry step, which fails the same way at 6f24ccbfd in the same desktop (with the old folder walk taken out, since on 6f24ccbfd that walk fails first, on the icons' fade). Not chased. |
| `split-workspace.spec.ts` | Failed at its first hover of the Footer links row, before the F6 step this change edits: the row's own icons cover its middle once the pointer is there. It fails the same way at 6f24ccbfd. The split F6 trip is covered by `thread-list-keyboard.spec.ts` and the unit test instead. |

Unit tests run with `npx vitest run --maxWorkers=2` on named files: the new `threadListKeys.test.tsx` (one stop, the walk, Right and Left, Right into an empty folder going nowhere, the row and folder menus, F2, dictation's keys, the focus handed on when a row goes or follows it to another folder, one stop after starting collapsed and expanding, the rail) and `regionCycle.test.tsx` (the trip in both directions, a split, Tools after the panes, the Threads workspace only while it holds no pane, the search field and room entries, a dialog, a terminal, dictation's F6), with `splitWorkspace`, `threadRename`, the sidebar's peek, folders, rail and Needs you tests, the pane menu, the Keyboard page, the catalogs, theme tokens and CSS selectors, and the Watcher and app shell tests that touch the sidebar. All passed.

## What the captures show

All at the design-threads fixture, Streaming WAV stall open and its row focused from the keyboard, dark and light.

- `focused-row-1600x1000-dark.png`, `-light.png` and `focused-row-820x560-dark.png`, `-light.png`: the row's 3px ring and its hover icons, which show for the focused row as they always have. Nothing clips at 820x560.
- `row-menu-1600x1000-dark.png`, `-light.png` and `row-menu-820x560-dark.png`, `-light.png`: the row menu under the row, Open focused with its ring, then Rename (F2), Regenerate title and Watch, and Settle (Ctrl+Shift+E), in the pane menu's look and colours from the theme. At 820x560 the menu sits inside the window and over the sidebar's edge rather than under it.

## Not checked here

- Windows and macOS. The design captures do not change (none focuses the list or opens a menu), and no baseline was regenerated.
- Watcher's room and Settings with F6 in the running app; their regions are covered by the unit tests' generic cases only.
- A screen reader. The rows keep their button role and names; the list follows the tree pattern's keys without its roles (ADR-0164).
