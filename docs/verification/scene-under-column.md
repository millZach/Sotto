# A ripple and an owl cross under Watcher's conversation

October 25, 2026. `feat/scene-under-column`, on Windows 11 with the built app (`npm run build`). The user asked, after the composer fixes (#1496): "when you click on the watcher background the ripple cuts off at the thread background, it shouldnt, also the Owl should be visible behind the thread words now, since everything is "transparent"". Since #1472 the hills and the sky run on under the conversation's column; the ripples and the owls still stopped at its edge.

## The pick

`docs/prototypes/watcher-scene-under-column-prototype.html` showed three strengths for the ripple and the owl under the column, each measured against every word colour by day and by night: A, the hills' share (85%) under the column's ink ceiling; B, half that; C, full strength with only the words' glow. C left words at 1:1 and was not offered. The user picked A.

## What changed

- `nightScenePainter.ts`: a ripple's ring and bend run on under the column and the scrubber's lane. Those cells already take the column's share and ink ceiling in `cell()`, so the ring there is as quiet as the hills.
- `nightScenePainter.ts`, `nightScene.ts`: where an owl is drawn is `owlLayer`. Over the margins it is drawn over everything on the owls' canvas, as before. Over the column and the scrubber's lane, below the header and away from the words that stand still, it is drawn behind the words, on the landscape's canvas, at the cell's share and under the column's ink ceiling, with the landscape cleared under it so it reads. Perches stay in the margins, so only a flight between the trees crosses.
- ADR-0126 is amended, and `CONTEXT.md` and `docs/guide.md` say so.

A press still starts a ripple only in the open margin, and reduced motion still turns it into a still spot and keeps the owls home.

## How it was run

```sh
npm run typecheck
npm run lint
npx vitest run tests/unit/renderer/watcherNightScene.test.ts
npm run build
npx playwright test tests/e2e/watcher-column.spec.ts tests/e2e/watcher-night-scene.spec.ts tests/e2e/watcher-scene-steady.spec.ts tests/e2e/composer-slim-steady.spec.ts
```

`watcher-column.spec.ts` gains a case, dark and light: a press in the margin beside the column sends a ripple, the landscape over a band of the column changes within the next second, and every word in the column keeps 4.5:1 against every pixel the scene draws there in each frame read. On `origin/main` it fails at "the ripple reached the column"; on this branch it passes. Its existing case reads every word against the scene in all six built-in themes, dark and light, which now includes any ripple or owl passing under the column. The unit tests pin `owlLayer`: over the margins, behind over the column and the lane, nowhere in the header band or around still words.

Of the 17 cases in those four specs, 16 pass. The "newcomer comes out of the moon" case of `watcher-night-scene.spec.ts` fails at its frame rate, one display frame in a second, the same way on `origin/main`'s source on this machine, so it is not this change.

The owl's flight is at random times on a live clock, so it is shown here rather than in a test: a capture on the live fixture, with every roll pinned to 0 so Watcher's owl leaves home after the shortest stay and flies to the other tree, across the column.

## Evidence

In `artifacts/scene-under-column/`, Watcher at 1280x800:

- `owl-behind-words-dark.png`, `owl-behind-words-light.png`: three frames of the owl's flight, top in the margin over everything, then behind the words as it crosses.
- `ripple-under-column-dark.png`, `ripple-under-column-light.png`: four frames of a ripple from the left margin running on under the scrubber's lane and the column.
- `owl-crossing-dark.mp4`, `owl-crossing-light.mp4`, `ripple-dark.mp4`, `ripple-light.mp4`: the same, as the screen drew them.
