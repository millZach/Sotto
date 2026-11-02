# A pane's header is the Git action, Watch, one ··· menu and close

October 30, 2026. The branch `feat/pane-header-one-menu` from `main` at 81d8d8001, closing #1828 (finding 10 of `docs/research/2026-10-29-ui-hillclimb-desktop.md`) with Zach's pick B and his answer on the Git action, recorded in ADR-0163. Checked on forge (Linux, Omarchy) in an owned nested desktop through `scripts/verify-linux-window-minimum.mjs --exec`, with the built app and the `design-threads` fixture. Not checked on Windows or macOS.

## What changed

- The header reads: the title, project and folder, then the Git action, Watch, `···` and, in a split, close, pinned to the right. Tools, the Terminal drawer, Zoom pane, the arrangement switch, the grip and Initialize Git left it.
- `···` (More actions) lists the layout first: Open beside, Tools in the focused pane, Terminal drawer (Ctrl+J), Zoom pane or Show all panes (Ctrl+Shift+M), the arrangement with three or more panes, and Move pane toward each neighbour. Then the thread's own rows, Initialize Git first for a folder without Git, and Settle (Ctrl+Shift+E) or Restore (Ctrl+Alt+R) with their keys.
- Tools' dot moves to the focused pane's `···` button, with its words as that button's description; closing the panel hands focus back to it.
- In a split the title is the handle that moves the pane; a drag that starts on the working copy or another control inside it stays that control's.
- Watch keeps its word at every pane width in the Threads workspace, and a split pane keeps its project down to 560px instead of 720px.

## How it was run

```sh
npm run build
node scripts/verify-linux-window-minimum.mjs --exec "$PWD/node_modules/.bin/playwright" test tests/e2e/pane-header.spec.ts
node scripts/verify-linux-window-minimum.mjs --exec "$PWD/node_modules/.bin/playwright" test tests/e2e/pane-layouts.spec.ts
node scripts/verify-linux-window-minimum.mjs --exec "$PWD/node_modules/.bin/playwright" test tests/e2e/daily-workspace.spec.ts
node scripts/verify-linux-window-minimum.mjs --exec "$PWD/node_modules/.bin/playwright" test tests/e2e/git-actions.spec.ts tests/e2e/compact-pane-and-request-layout.spec.ts
```

Each run ran in the foreground, one at a time, with `NODE_OPTIONS=--max-old-space-size=3072`, and each removed its own Hyprland root and left the live Omarchy trees unchanged.

`pane-header.spec.ts` holds the window at 1600x1000 and opens Footer links beside Streaming WAV stall. In both panes the controls are Watch, `···` and close in that order, with no layout button and no grip; the title, the project and the folder all show, and none is cut off. It opens the left pane's menu: Open beside, Tools, Terminal drawer, Zoom pane and Move pane right lead it, Terminal drawer and Zoom pane carry their keys, and Escape closes it with focus back on `···`. Ctrl+J in the pane's composer opens its Terminal drawer, the menu's row is ticked while it shows, and the row hides it again. It records where every control sits against its pane's right edge, drags the divider 160px, and finds every control where it was, and the right pane's controls where they were on screen. It moves the pane right from the menu by the keyboard, then back by dragging its title, and checks the order at 1280x800 and, in tabs, at 820x560, where no control runs outside the header.

| Spec | Result |
| --- | --- |
| `pane-header.spec.ts` | Passed. |
| `pane-layouts.spec.ts` | Passed: Arrange in a single row and back by the keyboard, Move pane right and down from the menu with focus kept on `···`, a pane dragged by its title, Show all panes, and Tools from the pane's menu at 1280x800. One hover on a sidebar row now holds the row by its name; it had landed on the row's actions in the nested desktop. |
| `daily-workspace.spec.ts` | The split recovery journey passed; the mixed-provider journey skips off Windows. |
| `git-actions.spec.ts` | Passed, Initialize Git pressed from the pane's `···` menu, with its notice above the composer. |
| `compact-pane-and-request-layout.spec.ts` | The arrangement journey passed at 1280 and 820. The structured-forms journey failed at its Tab to Send; it fails the same way on `main` at 47672c1ff in the same desktop, so it was not chased. |
| `pane-terminal.spec.ts`, `terminal-search-links-zoom.spec.ts` | Skipped off Windows; their Terminal drawer presses go through the menu and are left to Desktop check (Windows). |
| `files-panel.spec.ts`, `files-panel-split.spec.ts` | Both stopped at a sidebar row the nested desktop never listed, before any control this change touches. Not chased. |
| `host-update.spec.ts` | Stopped in Settings, where its SSH host never connected in the nested desktop, before the Threads page. Not chased. |

The unit tests for the header, the menu, the split, the Git action, Tools, the drawer, the catalogs, theme tokens and the pointer rule passed with `npx vitest run --maxWorkers=2` on those files.

## What the captures show

- `artifacts/pane-header-one-menu/split-1600x1000-dark.png` and `-light.png`: two panes at 1600x1000, each header "title / project · folder" then Watch, `···` and close, nothing cut off.
- `artifacts/pane-header-one-menu/menu-1600x1000-dark.png` and `-light.png`: the left pane's `···` menu, the layout rows with Ctrl+J and Ctrl+Shift+M at their ends, then Rename, Regenerate title and Settle with Ctrl+Shift+E.
- `artifacts/pane-header-one-menu/split-1280x800-dark.png` and `-light.png`: the same split at 1280x800, where each pane is under 560px and gives up its project before its title.
- `artifacts/pane-header-one-menu/tabs-820x560-dark.png` and `-light.png`: the minimum window, the panes as tabs, the shown pane's header whole.

## Limits

- Linux draws no window controls, so the pane under Windows' controls and the macOS traffic lights was not seen. The header keeps the same inset rules as before. The host update pill's margin now holds in a split too, which `host-update.spec.ts` measures; that journey did not reach the Threads page here.
- The fixture's folders have no Git status, so the captures show no Git action; Initialize Git in the menu is proved by `git-actions.spec.ts` and the unit tests.
- Reduced motion: nothing added moves. The menu keeps its existing pop-down, which reduced motion already turns off.
