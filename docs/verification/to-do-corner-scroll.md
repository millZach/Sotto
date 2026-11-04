# The to-do list's corner scroll

November 3, 2026. Forge (Linux), built app under `xvfb-run`; not installed or released. ADR-0188 decisions 4 to 6. Part two of #2134. Zach's pick came from the prototype kept as the tag `prototype/to-do-scroll`, variant A.

## What was proved in the running app

`tests/e2e/to-do-list.spec.ts`, with the `to-do-list` Owl feature on and a list saved on this computer:

- The icon stands in the corner on Threads, Settings and Help. The captures show the pane's header stopping clear of it; no assertion measures that.
- The badge reads an orange 1 for the one new item. A press unrolls the list, and from then on it reads a quiet 14.
- At 1600×1000, 1280×800 and 820×560 the list stands inside the window. A long list scrolls inside the sheet, with **Add your own** and **Roll up** still in view.
- Steps fold open. Escape, **Roll up**, the icon and a press outside each roll it up, and Escape hands focus back to the icon.
- A check-off shows **Undo** and moves focus to it. Undo takes it back. Left alone through rolling up, it is gone after five seconds and the badge has counted it out from the start.
- Your own item goes on the list.
- In light and dark, every line of the sheet and the badge measure at least 4.5:1 on what they sit on.
- With reduced motion on, the list fades: its only transition is opacity.
- With the feature off, there is no icon and no `toDos` bridge.

Captures in `artifacts/to-do-list/`:

- `badge-new-dark.png`, `badge-new-light.png`: the loud count in the corner.
- `open-1280x800-dark.png`, `open-820x560-dark.png`: the list at those sizes, with a long list scrolling.
- `open-steps-dark.png`, `open-steps-light.png`: steps open, at the minimum.
- `undo-dark.png`: a row checked off, with **Undo**.
- `open-settings-dark.png`: on the Settings page.

## A prototype waiting for review

The same spec's third journey, on a thread whose finished reply names a page: the badge reads an orange 1, the list shows **Review the prototype** with its thread and **Open the prototype**, with no **It didn't work**. Opening the page takes the item off and rolls the list up, and the thread's Prototype ready line goes with it. `prototype-dark.png` is that list. Part of #2134, part three.

## What was proved below the app

`tests/unit/renderer/toDoCorner.test.tsx` covers what the journey can't reach without a waiting thread or a second computer: **It didn't work** standing only on an item a thread waits on, its words going at once, Escape closing the note without rolling up, the words staying when they could not be sent, a press going back to the computer that holds the item, a wait dropped when another client checks the item off first, the last item standing until its press has an answer, the list unrolling to say a press failed after it was rolled up, a newer draft kept when an earlier add fails, and no box where this computer keeps no list. Two Bug Bot findings on #2135 are fixed in `tests/unit/main/toDos.test.ts`: a refused add gives back its own slot on a thread's ten, and a failed save after a thread was told does not tell it the same thing twice, though words the user writes after that still go.

## What was not proved

- Windows and macOS. Only Linux ran here, where the window has no controls of its own. On Windows the icon stands left of them; the CSS gives the same 34 pixels on all three, and the journey has not run there.
- A real paired host. The socket's side has its own tests from part one (`tests/integration/socketToDos.test.ts`); the window with a second computer is covered only with a fake bridge.
- A second tell after a restart. What a thread has heard while a save fails is held in memory, because the save is what failed, so a restart in that state tells it once more.
- How the roll looks moving. The captures show it at rest. A hand look at the motion is worth having, since the journey only checks that the transition is what it should be.
