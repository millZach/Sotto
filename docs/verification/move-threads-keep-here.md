# Keep it here, on a move waiting on its machine

Checked on Linux (Omarchy) on October 30, 2026, in the built app on forge, for part 4 of #1178. The window draws Zach's
picks for part 4 (tag `prototype/move-threads-reconcile`): **Keep it here** appears only on a move waiting on a machine
that is not answering, asks first on the card when that machine made the new thread, and is remembered while the machine
can't be reached.

## What was done

"Keep it here on a move waiting on its machine…" in `tests/e2e/watcher.spec.ts` ran on Sotto Owl on a nested desktop
of its own (`scripts/verify-linux-window-minimum.mjs --exec`, alone on forge, with Node's memory capped), with the moves
stood in for by the window's end-to-end stand-ins, beside the two move journeys of parts 2 and 3, which passed again.
It passed in dark and light with reduced motion, at 1600x1000, 1280x800 and the 820x560 minimum, with nothing out of
bounds and text at 4.5:1 or better at every size.

- The card of a move whose new thread forge had made said "Waiting for forge" and "This thread is waiting for forge to
  answer about its move. Nothing was lost.", with **Keep it here**.
- From the keyboard, Enter on Keep it here opened the question on the card, "Stop the new thread on forge and keep this
  one here?", with focus on Cancel. Escape closed it, focus back on Keep it here, nothing sent. Enter opened it again,
  Shift+Tab reached **Stop it there and keep this one**, and Enter pressed it.
- With forge not connected, the card then said "Keeping it here" and "You chose to keep this thread here. Sotto asks
  forge to call the move off, … as soon as forge answers. This thread takes no sends until then. Nothing was lost.",
  with nothing more to press.
- Watcher's proposal journey now checks that after Move its line, "You chose 1 of the threads Watcher proposed moving
  to forge.", is not the move's own line, which shows once.

| Screenshot | What it shows |
| --- | --- |
| `artifacts/move-threads-keep-here/moves-keep-question-dark-1280x800.png` | Keep it here's question on the card, dark |
| `artifacts/move-threads-keep-here/moves-keep-question-light-820x560.png` | The same at the minimum window, light |
| `artifacts/move-threads-keep-here/moves-keeping-dark-1280x800.png` | The card once pressed, waiting for forge, dark |
| `artifacts/move-threads-keep-here/moves-keeping-light-1280x800.png` | The same, light |

## Not checked here

The machine calling the move off, and the card's kept end, are main's: `tests/unit/main/threadMoves.test.ts` (a press kept
across a restart, then called off when forge is back; a move never asked to start; a machine too old to call one off),
`tests/unit/main/threadMovesHost.test.ts` and `tests/integration/threadMoves.test.ts`, which calls a move off over the
real socket and sees the host's thread stopped and settled and its start refused. No move between real machines was
called off, and Windows and macOS were not checked.
