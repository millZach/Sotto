# A move suggestion under the machines line

Checked on Linux (Omarchy) on October 30, 2026, in the built app on forge, for #1309. The window draws Zach's picks
(tag `prototype/move-suggestions`): when the machines line's reading says a machine is short on memory or busy and another
has room, a line under it names one thread to move there, with **Move to forge**, **Choose threads…** and **Not now**.

## What was done

"a machine short on memory gets a move suggestion under the machines line…" in `tests/e2e/watcher.spec.ts` ran on Sotto
Owl on a nested desktop of its own (`scripts/verify-linux-window-minimum.mjs --exec`, alone on forge, with Node's memory
capped), with the machines and the moves stood in for by the window's end-to-end stand-ins. Watcher's proposal journey ran
beside it and passed again. It passed in dark and light with reduced motion, at 1600x1000, 1280x800 and the 820x560
minimum, with nothing out of bounds and text at 4.5:1 or better at every size.

- Watcher had placed a start on forge, so the line read the machines once: "This computer 3 working, short on memory ·
  forge 0 working", forge with headroom for three more workers.
- Under it: "This computer is short on memory, and forge has room. Move Grok voice previews there? It last worked 5 hr.
  ago and is between turns." The stand-in's preview said only that one would move now.
- From the keyboard, Tab went from **Move to forge** to **Choose threads…** to **Not now** in that order, each named for
  what it does ("Choose threads to move to forge", "Not now, until This computer reads fine again").
- Enter on Move to forge started the move: its card, "Moving Grok voice previews", appeared in Watcher's conversation under
  "You asked to move 1 thread to forge.", the line went away, and focus went to This computer on the machines line.

| Screenshot | What it shows |
| --- | --- |
| `artifacts/move-suggestions/moves-suggestion-dark-1280x800.png` | The suggestion under the machines line, dark |
| `artifacts/move-suggestions/moves-suggestion-light-820x560.png` | The same at the minimum window, light |
| `artifacts/move-suggestions/moves-suggestion-moved-light-1280x800.png` | After Move: the line gone, the move's card in Watcher's conversation |

## Not checked here

Which thread is named, a thread that would start narrower opening the sheet, Choose threads… opening it at the machine
with room, a refused press, Not now until the machine reads fine, and one preview per reading however the threads update,
are in `tests/unit/renderer/moveSuggestion.test.tsx` and `tests/unit/renderer/moveThreads.test.tsx`. No real machine ran
short of memory, and Windows and macOS were not checked.
