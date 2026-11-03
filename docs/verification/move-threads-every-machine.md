# Moving threads from every machine, in the window

Checked on Linux (Omarchy) on October 29, 2026, in the built app on forge, for part 3b of #1178. The window draws Zach's
picks for part 3 (tag `prototype/move-threads-directions`): **Move threads** gathers threads from every other machine,
nothing in its sheet starts ticked, and asking Watcher in words shows the preview as a card with **Move** and **Not now**.

## What was done

Two journeys in `tests/e2e/watcher.spec.ts` ran on Sotto Owl on a nested desktop of its own
(`scripts/verify-linux-window-minimum.mjs --exec`, alone on forge, with Node's memory capped), with Watcher's room, the
paired machines, the moves and Watcher's proposal stood in for by the window's end-to-end stand-ins
(`src/renderer/src/e2e/watcherStandIn.ts`). Both passed, in dark and light with reduced motion, at 1600x1000, 1280x800
and the 820x560 minimum, with nothing out of bounds and text at 4.5:1 or better at every size.

- "Move threads asks once in a sheet, nothing ticked…": forge and studio connected, lab not. With This computer's
  threads alone, This computer is not offered; the sheet lists the other machines, lab disabled with "Not connected".
  After picking forge it asked **Choose threads to move to forge**, Move off, every row saying where its thread is now
  (This computer). Focus started on Cancel; Tab passed the Move it could not press yet, to the lists and the first box;
  Space ticked it, and the title became **Move 1 thread to forge?**. With three ticked the foot stayed in view in a short
  window. Escape put it away with nothing moved; pressing **Move 3 threads** later put each move's card in Watcher's
  conversation, as in part 2.
- "Watcher's proposal from the user's words…": Sotto's line, "Watcher proposes moving 2 threads to forge. Nothing moves
  until you press Move.", then the preview with both threads Watcher named ticked and the one that stays without a box,
  saying why. From the keyboard, Space unticked one, Tab reached **Move 1 thread**, and Enter moved only the other: the
  line became "You chose 1 of the threads Watcher proposed moving to forge.", the boxes went, and the move's card followed under its own line. (Changed October 30 in part 4: after part 3b's review it read the same as the move's own line, shown twice.)

| Screenshot | What it shows |
| --- | --- |
| `artifacts/move-threads-every-machine/moves-sheet-dark-1280x800.png` | The sheet with three threads ticked, each row saying where it is, dark |
| `artifacts/move-threads-every-machine/moves-sheet-light-820x560.png` | The same at the minimum window, light, its lists scrolled |
| `artifacts/move-threads-every-machine/moves-proposal-dark-1280x800.png` | Watcher's proposal in its conversation, dark |
| `artifacts/move-threads-every-machine/moves-proposal-light-820x560.png` | The proposal at the minimum window, light |
| `artifacts/move-threads-every-machine/moves-proposal-moved-dark-1280x800.png` | The proposal after Move, with the move's card |

## Not checked here

The end-to-end fixture has no thread on another machine, so the sheet's This computer row and a host's thread in it are
checked in `tests/unit/renderer/moveThreads.test.tsx`, and **Continue on another machine…** on a host's thread in
`tests/unit/renderer/threadPaneMenu.test.tsx`. The fixture's threads name no provider, so the sheet's rows show none,
as in part 2. No thread moved between real machines, and Windows and macOS were not checked. The design captures do not
cover Watcher's room with another machine connected, so no baseline changes.
