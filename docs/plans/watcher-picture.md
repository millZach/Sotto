# Watcher's picture

Zach asked for "an easier way to see what you are doing": the threads Watcher manages drawn as a picture, with messages moving between them. Issue #1339 is this first piece, the live picture; #1340 is history and replay. The prototype is kept at the tag `prototype/watcher-picture` (`docs/prototypes/watcher-picture-prototype.html` there); its variant A is the spec. The glossary calls it **Watcher's picture** and the tab **Visualize**; READY TO MERGE, GO MERGE and MERGED are **merge turns**.

## Zach's picks, October 22, 2026

- **Desktop first.** The iPhone and Android clients come later, as their own work.
- **An Owl feature under Watcher.** It rides Watcher's switch (ADR-0072) and adds no gate of its own.
- **A press on a thread opens a detail card**: its state, its last messages with Watcher, its pull requests, and Open beside Watcher.
- **Blobs move live and on replay.** With reduced motion nothing travels: the line lights and a still mark appears.
- **Watched threads only, settled ones folded away** behind a count.
- **Grouped by project**, with the computer named on remote threads.
- **A, the constellation.** Watcher in the middle; the threads it watches around it in clusters, a line from Watcher to each, blobs travelling along the lines.
- **Visualize is a third tab** beside Conversation and Watched.
- **The composer shrinks to one line** while the picture shows, and grows back with focus.
- **Live first, history second.** The timeline and replay (#1340) need a saved record of their own.

Confirmed for the build by Watcher, also October 22:

- **One line per thread.** A cluster of fifteen to twenty threads stays readable at 820x560, and settled threads stay folded.
- **The reduced-motion mark never covers a title.**
- **No shortcut of its own.** The tabs already move with the arrow keys.
- **No new per-update work in main or the renderer's hot path**, while the perf batch #1326-#1336 is in flight.

## How it is built

- **The model and layout.** `src/renderer/src/watcher/constellation.ts` is pure: what the picture is built from (`buildPicture`), where each part goes (`layoutPicture`), the lines and the points a blob travels through (`edgePath`, `edgePoints`), which messages moved since the picture last looked (`pictureMessages`), and what Watcher last did with a thread (`nodeActivity`). Its tests are in `tests/unit/renderer/watcherConstellation.test.tsx`.
- **The component.** `src/renderer/src/watcher/WatcherPicture.tsx` draws it in Watcher's pane, in the conversation's place, as the Watched view does.
  - The clusters are an SVG of hulls and lines under absolutely placed buttons, one per thread. Those buttons carry the surface's colour, so a line runs under a title rather than through it.
  - Blobs are spans moved with the Web Animations API on a layer of their own, so a redraw never interrupts one, and a new layout clears them.
  - The picture samples the room and the window's state at most four times a second, and does nothing while another tab shows.
- **Main's side.** It is told in ADR-0106:
  - `send_to_thread` takes an optional `mergeTurn`, which main takes off before the send and remembers in memory.
  - `sotto:watcher:read-merge-turns` gives the picture read_state's merge queue and those merge turns, read only while the picture shows.
  - Nothing new goes into the room's publish or the saved record.
- **Styles.** They are in `src/renderer/src/watcher/watcherPicture.css`: every colour a theme role, the rings the room's own (`.watcher-row__ring`), each message kind its own shape as well as its colour.
- **The room.** `WatcherView` adds the third tab, marks Watcher's pane with `data-view`, and mounts the picture. While the picture shows, the composer keeps one line until focused: no options and no attach button, with Send at its end.
- **The built-app checks.** `tests/e2e/watcher-picture.spec.ts` checks it in the built app at 1600x1000, 1280x800 and 820x560, in Sotto light and dark and Tropic dark. It checks no overflow, 4.5:1 for every word in the picture, the card, the keyboard path, a check-in, a question and a GO MERGE moving, and reduced motion.
  - The Watcher stand-in answers the merge-turns read from its seed and can publish a script of later states.
  - e2e runs can set a thread's linked pull requests with a `pull-requests` event.

## Where it departs from the prototype

- **One line per thread** (Watcher's confirmation), in place of the prototype's two lines at large sizes.
  - A cluster takes as many columns as it needs to fit the height, the column nearest Watcher first, so the threads that need the user sit closest to it.
  - A thread too narrow for its pull request's chip leaves it to the merge turns and its card.
- **Any number of projects.** The prototype put four clusters in four quarters. The build shares clusters between Watcher's two sides, keeping them even. Narrower than 640 pixels, with a thread open beside Watcher for instance, Watcher goes to the top and the clusters stack under it.
- **You sits under Watcher**, in the middle column, rather than across the bottom, which gave the clusters the height they need at 820x560.
- **No timeline.** History and replay are #1340.
- **The detail card shows what Watcher did, not its words.** Each entry is an action from Sotto's own receipts: started, sent, gave its merge turn, stopped, settled, and how it went. Watcher's words and the thread's reply show under an entry only when the window already holds that thread's history.
  - Reading a thread's history just to show the card would count it as seen, and a later finish or failure would not raise Needs attention (#1193). So the card never reads it.
  - Open beside Watcher shows the whole thread.
- **The merge turns are Sotto's facts.** READY TO MERGE is read_state's merge queue, and MERGED is GitHub's state. GO MERGE is a send Watcher marked with `mergeTurn`, which a restart forgets (#1340 keeps it).

## The owls replace the constellation, October 22, 2026

Zach saw two things in the constellation on Owl 0.1.38. "You · nothing waiting" sat under Watcher and ran into the project boxes on both sides, with the lines running through the labels. He also asked for the owls from Conversation and Watched on Visualize. The prototype is kept at the tag `prototype/watcher-visualize-owls` (`docs/prototypes/watcher-visualize-owls-prototype.html` there). It offered A, owls in the margins beside the constellation; B, owls as the picture; and C, a night strip over a list. Zach picked **B**, and then:

- **A press on an owl or its name opens the thread's card**, as before.
- **Messages fly, owls perch.** Owls stay on their limbs: a working thread's owl blinks, and one waiting on the user glows. Watcher's own owl blinks on its post. There are no flights or moon whirlpool here; those stay in the margins.
- **A busy project grows another limb** under its first, and the picture scrolls when the trees run out of height.

How it is built:

- **The layout.** `src/renderer/src/watcher/pictureGrove.ts` is pure. It makes a tree for each computer, a limb for each project and an owl for each thread, and gives every word its own box.
  - Wide, Watcher sits on its post in the middle, and the middle is as wide as Watcher's name or You, whichever is wider, measured in the window. Narrower than 960 pixels, the two share a line at the top.
  - Whole computers go to the shorter side. A project moves to the other side only when one side would otherwise be taller than the view, so a single computer stands as one tree, with the other side open, while it fits.
  - A pull request's chip shows when it fits beside where the thread stands. Otherwise it wraps out of sight and the words keep their line; the merge turns along the top and the card still name it.
  - The layout is kept while only the threads' states change, so the landscape is built again only when a thread, a project or a computer comes or goes, or the pane changes size.
  - `tests/unit/renderer/watcherPictureGrove.test.ts` checks that no two boxes meet at any size, and that no box leaves the picture.
- **The painting.** `src/renderer/src/watcher/pictureGrovePainter.ts` draws the landscape, the trees, the moon and every owl as the night scene does. It shares the night scene's owl, moon and glyph helpers (`nightScenePainter.ts`), and nothing is drawn under a word.
  - It checks eight times a second while anything could blink, twinkle or glow, paints only what changed, and holds still with motion reduced or the window hidden.
- **The overlap, at its root.** The constellation's middle was a fixed 64 to 96 pixels, set without reading how wide its labels were. Now the layout is given their measured widths.
  - The picture also takes the pane's whole width: the conversation column's padding had been winning over the picture's own. The merge turns keep to the column.
- **The built-app checks** add one: no two of You, Watcher's name, a thread, a project's sign or a computer's name meet, at every size and theme.
