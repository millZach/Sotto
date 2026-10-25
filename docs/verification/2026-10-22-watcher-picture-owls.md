# Watcher's picture as owls, October 22, 2026

Visualize draws the night scene: a tree for each computer, a limb for each project and an owl for each thread Watcher watches, with Watcher on its post and You at its foot (`docs/plans/watcher-picture.md`, Zach's pick B of `prototype/watcher-visualize-owls`). It replaces the constellation, whose "You · nothing waiting" ran into the project boxes on both sides. Checked in Sotto Owl built from the branch, on Windows, with `npx playwright test tests/e2e/watcher-picture.spec.ts` (5 passed). Main's Watcher was stood in for by the spec's seeded projection: eight watched threads in three projects on this computer, one settled, with #1288 merged, #1291 given its turn and #1295 in the queue.

## What was checked

- **Nothing meets You or Watcher, at three sizes.** At 1600x1000 ([dark](../../artifacts/watcher-picture-owls/sotto-dark-1600x1000.png), [light](../../artifacts/watcher-picture-owls/sotto-light-1600x1000.png)) and 1280x800 ([dark](../../artifacts/watcher-picture-owls/sotto-dark-1280x800.png)), Watcher sits on its post in the middle with its name under it, and You stands at the post's foot. The trees keep to the sides. At the 820x560 minimum ([dark](../../artifacts/watcher-picture-owls/sotto-dark-820x560.png), [light](../../artifacts/watcher-picture-owls/sotto-light-820x560.png)), Watcher and You share the top line and the picture scrolls for the rest.
  - The spec checks every pair of You, Watcher's name, each thread, each project's sign and each computer's name at every size in Sotto dark, Sotto light and Tropic dark ([Tropic, 1280x800](../../artifacts/watcher-picture-owls/tropic-dark-1280x800.png)). No pair meets.
  - It also checks no overflow or clipping (`pageBoundProblems`) and 4.5:1 for every word in the picture.
- **Owls for threads.** The thread waiting on a permission glows in the accent. Working threads' owls have round eyes, and resting or settled ones have shut eyes. Each thread's name and where it stands sit under its owl, and its pull request's chip when it fits beside the words. Where it does not, the words keep their line and the merge turns along the top and the card name the pull request.
- **One computer, one tree, while it fits.** At 1600x1000 and 1280x800 the stand-in's eight threads, all on this computer, stand as one tree on the left, its four projects on their limbs, with the right half of the night open. At 820x560 they need more height than the window has, so two projects cross to a second tree on the right.
- **The card.** A press on a thread's owl opens its card beside it ([820x560](../../artifacts/watcher-picture-owls/sotto-dark-card-820x560.png)). Enter opens it from the keyboard, focus goes to Close details, and Escape gives focus back to the thread.
- **Messages fly between owls.** A check-in flew from Watcher's owl to Footer links, whose owl is ringed while it moves ([in flight](../../artifacts/watcher-picture-owls/sotto-dark-blob-1280x800.png)). A question flew on to You, and #1295's GO MERGE moved, as before.
- **Reduced motion.** Nothing travels: the thread's owl is ringed and a still mark stands beside it, clear of its name ([1280x800](../../artifacts/watcher-picture-owls/sotto-dark-reduced-motion-1280x800.png)).

## Covered by unit tests

`tests/unit/renderer/watcherPictureGrove.test.ts`:

- Watcher on its post in the middle with You below it at 1600, 1280 and 960 wide.
- Each computer a tree, each project a limb, every owl on a limb.
- Watcher and You on one line when narrow, or on two lines when they do not fit side by side.
- Twenty threads in one project growing more limbs and scrolling.
- One side only below 480 pixels.
- At each of those, no two boxes meet and none leaves the picture.

`tests/unit/renderer/watcherPicture.test.tsx` still covers the tab, the card, the merge turns and the reduced-motion mark.

## Not covered

- macOS and Linux windows. The picture is drawn the same way on each, and the run was on Windows.
- More than one computer in the built app. The stand-in's threads are all on this computer; the unit tests lay out two to four.
- A thread open beside Watcher. The pane is narrower then and takes the narrow layout, which the unit tests cover at 420 and 479 pixels.
