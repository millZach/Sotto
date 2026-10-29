# Moving threads in the window

Checked on Linux (Omarchy) on October 29, 2026, in the built app on forge, for part 2 of #1178. The window draws the moves
part 1 built, as Zach picked on October 29 (variant B, tag `prototype/move-threads`): **Move threads** beside Stop all,
one sheet that asks once, and each move as a card in Watcher's conversation.

## What was done

`tests/e2e/watcher.spec.ts`, "Move threads asks once in a sheet…", ran on Sotto Owl on a nested desktop of its own
(`scripts/verify-linux-window-minimum.mjs --exec`), with Watcher's room, the paired machines and the moves stood in for by
the window's end-to-end stand-ins (`src/renderer/src/e2e/watcherStandIn.ts`). Forge and studio were connected and lab
was not. It passed, in dark and light with reduced motion, at 1600x1000, 1280x800 and the 820x560 minimum, with nothing
out of bounds and text at 4.5:1 or better at every size.

- **Move threads** showed beside Stop all, with its label at 1280 pixels and as an icon below 900 pixels of pane.
- From the keyboard, Enter opened the sheet on its machines. Lab was listed, disabled, with "Not connected".
- After picking forge, the sheet asked **Move 3 threads to forge?**: two that move now, one that asks first, and four that
  stay, Watcher among them, each with why. It named the model each thread runs on there, and the one forge lacks. Focus
  started on Cancel, Tab went on to the move and round to the lists, and Escape put the sheet away, back to Move threads,
  with nothing moved. In a short window the lists scrolled and the foot stayed in view.
- Pressing **Move 3 threads** closed the sheet. Watcher's conversation gained Sotto's line, "You asked to move 3 threads
  to forge. Sotto reports each move here.", then a card for each: one started there with its steps, one that continued
  there, and one waiting for its press. **Move it on Allow edits** moved that one, and its card said it was holding sends.

| Screenshot | What it shows |
| --- | --- |
| `artifacts/move-threads-window/moves-choose-dark-1280x800.png` | The machines, lab not connected, dark |
| `artifacts/move-threads-window/moves-sheet-dark-1280x800.png` | The sheet, dark, 1280x800 |
| `artifacts/move-threads-window/moves-sheet-light-820x560.png` | The sheet at the minimum window, light, its lists scrolled |
| `artifacts/move-threads-window/moves-cards-dark-1280x800.png` | The three cards, dark |
| `artifacts/move-threads-window/moves-cards-light-820x560.png` | The cards at the minimum window, light |

## Not checked here

No thread moved between two real machines: the moves and the machines were stood in for, and main's side is covered by
`tests/unit/main/threadMoves.test.ts` and `tests/integration/threadMoves.test.ts`, which moves a thread to a real host
fixture. Windows and macOS were not checked. The design captures do not cover Watcher's room with another machine
connected, so no baseline changes.
