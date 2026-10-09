# Screenshot resize verification

October 9, 2026: Voice control and thread management described below are historical under [ADR-0065](../adr/0065-remove-voice-control-and-thread-management.md); the original plan or evidence is retained.

September 26, 2026. Issue #321, on `perf/screenshot-resize` from `main` at e093bd6c. The bound, the sources behind it and the byte and timing measurements are in [the performance note](../perf/2026-09-26-screenshot-resize.md).

## In the built app

`tests/e2e/screenshot-resize.spec.ts` launches the built app with the e2e success scenario, opens the Workshop thread and pastes four images drawn in the window's own canvas into its composer. For each it waits for the saved draft to carry the attachment, then checks the recorded sizes and decodes the data URL the draft holds in the window to read its real pixel size.

- A 3840x2160 PNG with a photograph-like strip is saved as a PNG (the data URL starts with the PNG signature), records `{ original: 3840x2160, sent: 2576x1449 }` and decodes at 2576x1449. Its chip says **Resized from 3840 x 2160 to 2576 x 1449**, and the text a screen reader reads is "Resized from 3840 by 2160 to 2576 by 1449 pixels".
- A 1200x800 PNG records the same size both ways, decodes at 1200x800 and has no note.
- A 4032x3024 JPEG is saved as a JPEG (the data URL starts with the JPEG signature) and decodes at 2576x1932.
- A 3840x2160 PNG of text and flat panels only, whose scaled-down copy comes out larger in bytes, is saved as it was attached: 3840x2160 both ways, and no note.

Exactly two chips carry the note. The spec then sets reduced motion and, at 1600x1000, 1280x800 and the 820x560 minimum in dark and light, checks that Send and the first noted chip are in the viewport and that the note sits inside its chip without overflowing it. The first run failed that last check at 820x560: the compact composer lays a chip out as a three-column grid of thumbnail, name and remove, and the note had fallen into the remove button's column. `threads.css` now puts the note under the name in that layout, with the thumbnail and the remove button spanning both lines, only for a chip that has the note.

## Captures

- `artifacts/screenshot-resize/composer-1600-dark.png`: the full composer at 1600x1000 in dark, four chips in the wide layout, two of them saying "Resized from" and both sizes under the name.
- `artifacts/screenshot-resize/chips-1600-light.png`: the same chips alone in light.
- `artifacts/screenshot-resize/composer-820-dark.png` and `composer-820-light.png`: the minimum window, the compact one-row chips, with "Resized from" and both sizes under the name of the two scaled-down ones and the remove button still at each chip's right.

The note uses `--tt-text-muted`, the colour the name above it already uses, at the name's size in the Threads view (12 px) and 10 px elsewhere. No new colour, no motion.

`tests/e2e/agent-browser.spec.ts` adds browser feedback to a draft through the same path, now through `prepareScreenshot` on the capture's bytes, and still finds the one attachment on the saved draft. Its capture is under the bound, so it is handed on untouched; `tests/unit/renderer/tools/browserReview.test.tsx` covers one past it.

After the review, the sizes a file names in its first bytes are read before anything is decoded (`tests/unit/renderer/screenshotResize.test.ts` pins PNG, animated PNG, JPEG with and without an EXIF quarter turn, the three WebP kinds and GIF), several files are read one at a time (`screenshotInput.test.tsx`), and a screenshot still being read when the user moves to another thread lands in the draft it was pasted into (`threadsView.test.tsx`). The second review found the sizes only in a tooltip, which a keyboard user never sees, so the chip now shows the sent size itself ("Resized to 2576 x 1449") and the captures above were taken again. The same review found three more gaps, each now pinned by a unit test: returning to a thread before its screenshot finished reading left Send enabled (`threadsView.test.tsx` holds Send until it lands), a late screenshot that no longer fitted was dropped without a word (`threadDraftStore.test.ts` adds what fits and names the rest), and a PNG whose metadata pushed its image data past the first 256 KB could be scaled though animated (`screenshotResize.test.ts`). Browser feedback now tells the agent the size it sends and lets Cancel stop a pending add (`tools/browserReview.test.tsx`).

After the review of the merged work, the chip shows both sizes itself, "Resized from 3840 x 2160 to 2576 x 1449", with each size held on one line, and the tooltip is gone; the four captures above were taken again from this spec. The rest of that review's fixes are pinned by unit tests: a screenshot that fails after its composer closed hands on the ones read before it and names itself on the thread (`screenshotInput.test.tsx`, `threadDraftStore.test.ts`); a late screenshot is refused by a draft that now answers a question or a model that does not read screenshots, and the thread's screenshot problem clears on the next edit or send (`threadDraftStore.test.ts`); an image past 16384 x 16384 pixels in area is never decoded (`screenshotResize.test.ts`); and browser feedback decodes its capture from the data URL once instead of up to three times (`tools/browserReview.test.tsx`).

## Not checked

The note was checked in a thread's composer (`ThreadComposer`). The coordinator's composer (`AgentView`) renders the same `ScreenshotInput` but was not captured, and it still drops a screenshot that finishes reading after its thread changes, because its draft follows the coordinator's current target rather than the thread the screenshot was pasted into (#361). No animated PNG or WebP, and no Display P3 capture, went through the built app. No live provider received a resized image in this pass: the adapters send the data URL as before, only smaller, and `tests/integration/claudeImages.test.ts` and `codexImages.test.ts` cover the send path unchanged.

## Re-run

```sh
npm run build
npx playwright test tests/e2e/screenshot-resize.spec.ts
```

Captures go to `artifacts/screenshot-resize-run/`, which is ignored; the four cited above were copied from there.
