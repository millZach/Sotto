# The collapsed rail's thread tiles open the row menu

October 30, 2026. The branch `feat/rail-tile-menu` from `main` at 0b386e526, closing #1909, the follow-up ADR-0164 left for the rail. Checked on forge in the owned nested Omarchy desktop, at 1600x1000, 1280x800 and the 820x560 minimum, in dark and light, and with reduced motion on.

## What changed

- A thread's tile on the collapsed rail opens the row menu on Shift+F10, the menu key and a right-click: Open (Enter), Open beside, Rename (F2), Regenerate title, Watch and Settle or Restore, the same items in the same words with the same keys as the thread's row, built by the same code.
- The keys open it at the tile's end, level with the tile's top; a right-click opens it at the pointer, as on a row. Escape hands the focus back to the tile, and choosing an item leaves it there.
- F2 on a tile, or Rename from its menu, opens the row's name field beside the tile. Escape or Enter hands the focus back to the tile.
- Settle from a tile is the sidebar's own Settle, worktree question included. While the sidebar is collapsed the question stands over the window rather than in the hidden list, for Settle's keys too. The rail holds no gap for a settled tile.

## Captures

The menu open on Streaming WAV stall's tile, the thread on screen, from Shift+F10. It stands beside the tile in the pane menu's frame, wholly inside the window, with Open focused.

| Window | Dark | Light |
| --- | --- | --- |
| 1600x1000 | `artifacts/rail-tile-menu/rail-menu-1600x1000-dark.png` | `artifacts/rail-tile-menu/rail-menu-1600x1000-light.png` |
| 820x560 | `artifacts/rail-tile-menu/rail-menu-820x560-dark.png` | `artifacts/rail-tile-menu/rail-menu-820x560-light.png` |

At 1280x800, with reduced motion on, the menu and the rename field are checked inside the window and still. At 820x560 the menu from the rail's last tile is checked inside the window too. Its colours are the row menu's, the pane menu's look, so nothing new is drawn on a surface: no new contrast to measure.

## How it was run

```sh
npm run i18n:extract
npm run build
node scripts/verify-linux-window-minimum.mjs --exec "$PWD/node_modules/.bin/playwright" test tests/e2e/thread-list-keyboard.spec.ts
```

With `NODE_OPTIONS=--max-old-space-size=3072`, one run at a time, alone on the nested desktop. It removed its own Hyprland root and left the live Omarchy trees unchanged.

| Spec | Result |
| --- | --- |
| `thread-list-keyboard.spec.ts`, the thread list's walk, row menu and F6 | Passed |
| `thread-list-keyboard.spec.ts`, the rail's menu: Shift+F10 on the focused tile with the row's words and keys, beside the tile and inside the window, Escape back to the tile, the menu key, a right-click at the pointer, F2's field beside the tile, Open from another tile, the menu and the field at 1280x800 with reduced motion, and the first and last tiles at 820x560 | Passed |

The unit tests in `tests/unit/renderer/threadListKeys.test.tsx` and `threadSidebarRail.test.tsx` cover the same on stable's rail and Owl's, Settle and Open beside from a tile, the worktree question over the window after a Settle from the rail, F2 and Shift+F10 standing down for dictation, a waiting tile on Owl whose Open names no keys, and where `followRow` places the menu.

## Windows design captures

None changes. No design capture collapses the sidebar or opens a menu, and a closed menu draws nothing: a tile is the same button it was, with `aria-keyshortcuts` for Open beside where a pane stands beside it.
