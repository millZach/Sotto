# Stepping through a visual in Expand: verification

October 27, 2026. Issue #1673, on `feat/visual-expand-steps`. Zach asked to step through a visual's walkthrough in Expand. He
picked variant A of `prototype/visual-expand-walkthrough`: the card's own bar (count, dots, Back and Next, the step's
words) under the picture, growing with a long step. Left and Right step; Up, Down and dragging still move the picture;
Escape still closes.

## How it was run

`tests/e2e/visual-walkthrough.spec.ts` launches the built app on Windows 11 against the end-to-end provider fixture and
draws the walkthrough's visuals through the end-to-end channel, now with a seven-step flowchart whose fourth step is a
long paragraph. On the flowchart it opens Expand on step 2 from the keyboard and checks that the bar under the picture
reads Step 2 of 4, that Right from the picture steps to 3 and lights the Provider group, that Left steps back, that the
bar's Next steps, and that Escape closes back on Expand with the card on step 3. Then, at 1600x1000, 1280x800 and
820x560, dark and light, it opens Expand on the long step and checks that the dialog fits the window, the bar's buttons
and words and the line of keys sit inside the dialog, the words are not cut off, the picture keeps at least 150 pixels,
and the count, words, buttons and line of keys meet 4.5:1.

`tests/e2e/visual-sandbox.spec.ts` does the same for an interactive page: Expand opens on the card's step with the bar
under the page, Right with the focus on Close steps it and the sealed page shows "Step 2 of 2", and Escape leaves the
card on step 2. In the first run the window capture came back with the page on step 2 and the bar still on step 1,
while the dialog itself already read step 2 (a screenshot of the page taken straight after showed it); the next run's
capture matches, and that one is committed.

The rest is unit tested in `tests/unit/renderer/visualWalkthrough.test.tsx` and `interactiveVisual.test.tsx`: Left and
Right step from the picture, from Close and from the bar's own buttons without stepping twice, and leave a zoomed
picture where it was; Up and Down still move it; under Read all, and for a visual with one step, Left and Right move the
picture as before and the line of keys says so; and an interactive page in Expand gets each step sent to it from the
bar and from Left and Right on Close, with the card on the step Expand closed on.

## Captures

In `artifacts/visual-walkthrough/`, from that run:

- `flowchart-expanded-1280x800-dark.png`: Expand on step 3 of the flowchart, the Provider group lit, the bar under it.
- `long-step-expanded-1600x1000-dark.png`, `long-step-expanded-1280x800-light.png`,
  `long-step-expanded-820x560-dark.png` and `long-step-expanded-820x560-light.png`: Expand on the long step. At
  820x560 the bar takes about a third of the dialog and the drawing fits the rest at 59 percent.

In `artifacts/interactive-visual/`: `expanded-1280x800-dark.png`, the expanded page on step 2 with the bar under it.

## What is not covered

- While an interactive page has the focus, Left and Right are the page's own, so a page can use them; Escape inside
  the page closes Expand as before.
- A step longer than half the dialog scrolls inside the bar, so the picture always keeps at least half.
