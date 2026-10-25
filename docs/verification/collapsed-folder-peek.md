# Peek inside a closed folder

October 24, 2026. Zach's picks from `docs/prototypes/collapsed-folder-peek-prototype.html`: variant B (ghost opening), no peek on the Settled shelf itself, and an Owl feature. The plan is `docs/plans/collapsed-folder-peek.md`.

## What was checked, and where

The design was checked in the prototype, in a real browser at 1280×800, before the pick:

- Variant B on a 12-thread folder expands in place under a guide line and pushes the folders below it down; that cost is the one Zach accepted in picking it.
- Opening a thread from a peek left its folder closed (the prototype's state strip names the truly open folders).
- A thread finishing while its folder's peek was open updated its row and the folder's dots in place.
- Searching stood the peek down; search still opens folders. Light, a narrow sidebar and a short window held.
- Two findings from that pass are in the build: the peek follows its folder on scroll and resize instead of vanishing, and Escape latches the preview shut until focus leaves the folder, because the focus Escape returns would otherwise reopen it.

The build itself — `folder-peek` in `src/shared/owlFeatures.ts`, the ghost preview in `ThreadSidebar.tsx` and `threadSidebar.css` — was not run in the desktop app in this session, and no local gates were run. Its proof is CI: `tests/unit/renderer/threadSidebarPeek.test.tsx` covers the hover intent and grace, opening a thread without opening its folder, the keyboard path and the Escape latch, touch standing down, the Owl-off sidebar, and Keep open. The standing folder suites cover what did not change.

## Not yet checked

- The real app at 1600×1000, 1280×800 and 820×560, dark and light, with an Owl build (`SOTTO_OWL_FEATURES=folder-peek=1` unpackaged): the sweep down the folders, the diagonal move into the preview, a long folder pushing Settled down, and Escape by hand.
- Dragging a thread out of a preview and resizing the sidebar during one; both are guarded in code but unobserved.
- Design captures are unchanged: with the Owl feature off nothing renders, and no capture baseline turns it on.
