# Transcript inset and reading position

October 30, 2026. `fix/chat-transcript-inset`, from `d5ec2219b`. Drake reported words showing beside Watcher's floating composer and continuing below the window. The same `ThreadPane` and `ThreadTranscript` draw Watcher and ordinary threads.

## Cause and correction

The composer floated over a full-height scroll box. Its measured height supplied bottom padding, which made the last item reachable at maximum scroll, but did not stop other messages painting or accepting presses behind the composer while reading back. Jump to latest also stood over the words. The resize observer watched message content only, so changing composer padding or window height could leave a following reader short of the new end.

A non-scrolling viewport now clips the transcript above the measured visible floating composer and the measured Jump button. Keeping the scroll box and its bottom spacer preserves the existing slim-composer reading position. The existing 14px Jump gap supplies both sides of its clear space. A waiting question keeps the existing 26px overlap under its rounded corners without clipping those words (#1815); Jump's clear space still sits above that stacked composer. No new spacing constant, color, typography, radius, shadow, glass effect or motion was introduced. The readable edge has no CSS transition: the global reduced-motion rule otherwise made it lag the composer for a frame. The observer now also watches the scroll box's content size, which changes with its padding and the window.

`reachesJumpBand` uses the composer's inset independently of the button's reserved space. A permission card still makes Jump step aside without making that decision feed back on itself.

Implementation: `ThreadTranscript.tsx` and `threads.css`. The existing 10px scrollbar size in `global.css` is now named once so the clip can leave that gutter whole without changing its styling. Comments in `ThreadPane.tsx` and `watcher/nightScene.css`, the guide and ADRs 0125/0126 now describe the readable boundary.

## Maintained regression and allowed local checks

The first implementation change followed a new case in `tests/unit/renderer/slimComposer.test.tsx`: **keeps following when the composer or window resizes, but leaves a reader in place**. With the original implementation, adding 180px of composer padding left scrollTop at **2400**, where **2580** was required. The focused run genuinely failed: **11 passed, 1 failed**. With the fix, the file passes **12/12**, including the final extension that shrinks the window by 100px before checking the reader's position and Jump to latest.

Commands actually run:

```sh
NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/unit/renderer/slimComposer.test.tsx --maxWorkers=1
NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/unit/renderer/jumpBand.test.tsx --maxWorkers=1
npm run typecheck
npm run lint
```

`jumpBand.test.tsx`: **5/5 passed** initially, including separation of the composer inset from Jump's clear space; the question regression below brings it to **6/6**. Typecheck and lint passed. The Node option avoids this machine's Node 25 built-in localStorage conflicting with JSDOM; it does not alter the test's layout mocks.

The maintained `composer-float.spec.ts` and `watcher-column.spec.ts` now assert that neither the composer margin nor Jump's band exposes transcript hit targets, alongside their existing geometry checks. The floating-composer check also requires the scrollbar gutter to remain reachable down to the scroll box's bottom. **These Electron specs were not run locally.** The project's CI-only instruction overrides the local gate commands. No installed app, Electron app, full unit suite, design capture/verify, or Owl build was launched.

## Headless renderer evidence

A temporary Vite entry under ignored `test-results/transcript-inset/` rendered the production `ThreadPane`, `ThreadTranscript`, `ThreadComposer`, `ThreadDraftStore`, `WatcherNightScene` and styles, with the established renderer-fixture pattern of an in-memory AgentContext and deterministic provider state. It used 24 alternating messages with paragraphs and links, and real request, attachment, follow-up, prototype and activity rendering. Watcher's header was a simple fixture header; its coordinator, sidebar and OS window were not mounted. The runner used cached Chromium headless shell 1248 through Playwright, with no native window.

Observed results before the waiting-question review correction below; this matrix was not rerun for that correction:

- **150 layouts**: Watcher and ordinary thread, 1600x1000, 1280x800 and 820x560, Sotto dark/light. Idle, working, reading back, multiline draft, banner, streaming while reading, Jump, permission, question, compacting, queued follow-up, attachment, prototype (ordinary thread), and a half-width/65%-height split pane. Every bottom-follow check ended with **0px remaining**. Final items cleared the composer by **14–56px**, using the existing item/padding rules. No transcript hit targets below the visible edge and no outer-pane overflow. Composer, banner and appended-content changes retained the tracked message within **1px** while reading back.
- **56 additional layouts**: full and quiet composers on both surfaces with normal motion at devicePixelRatio 1.5; growth while following, resize to 820x560, reading back, height resize to 820x760, multiline growth, Jump and an activity row. The quiet-composer cases also switched through all six built-in palettes, dark and light. Every bottom-follow check ended with **0px remaining** and every last item was above the readable edge. No page errors in either matrix.
- The 560-to-760 height resize crossed an existing compact typography breakpoint: the tracked message moved **4.5px**, retained the same reading line, and subsequent composer growth added no movement. This is recorded rather than claimed as a zero-pixel resize.
- **180 normal-motion frames**, 45 per surface/composer combination, sampled an eight-line draft expanding a slim composer. The transcript never crossed the moving card; the tracked scrollTop range was **0px** in all four cases.
- **35 reduced-motion frames** sampled growth through 187px and 204px composer heights. Jump's gap above the readable edge stayed at least **14px** after removing the inherited transition.

A final scrollbar review caught the initial rectangular clip shortening the native scrollbar thumb. The matching headless hit check failed with `false !== true` before the correction. The final polygon leaves only the existing scrollbar gutter outside the content clip. **16 headless layouts** with native scrollbar painting enabled passed across both surfaces, desktop/narrow and dark/light, at the end and while reading back. This checks Chromium's scrollbar, not the OS window. The [inspected scrollbar capture](../../artifacts/composer-float/inset-thread-1280-dark-scrollbar.png) uses the production styling.

Measurements: [scrollbar checks](../../artifacts/composer-float/inset-scrollbar-measurements.json), [main matrix](../../artifacts/composer-float/inset-measurements.json), [additional matrix and reduced-motion frames](../../artifacts/composer-float/inset-extra-measurements.json), [normal-motion frames](../../artifacts/composer-float/inset-motion-measurements.json).

All of these reading-back PNGs were opened and visually inspected:

| Surface | Desktop, 1280x800 | Narrow, 820x560 |
| --- | --- | --- |
| Watcher | [dark](../../artifacts/composer-float/inset-watcher-1280-dark-reading.png), [light](../../artifacts/composer-float/inset-watcher-1280-light-reading.png) | [dark](../../artifacts/composer-float/inset-watcher-820-dark-reading.png), [light](../../artifacts/composer-float/inset-watcher-820-light-reading.png) |
| Thread | [dark](../../artifacts/composer-float/inset-thread-1280-dark-reading.png), [light](../../artifacts/composer-float/inset-thread-1280-light-reading.png) | [dark](../../artifacts/composer-float/inset-thread-820-dark-reading.png), [light](../../artifacts/composer-float/inset-thread-820-light-reading.png) |

The inspected bottom-follow captures are [Watcher, dark at 820x560](../../artifacts/composer-float/inset-watcher-820-dark-latest.png) and [thread with a multiline draft, light at 1280x800](../../artifacts/composer-float/inset-thread-1280-light-multiline-latest.png).

## PR #1885 review: preserve the waiting-question corners

The initial clip incorrectly treated #1815's 26px question overlap as covered space. A waiting question now sets the composer cover to **0px**, while keeping the **26px** overlap and its existing bottom padding. The floating composer still clips. Since the question's scroll box extends 26px below Jump's anchor, Jump's reserved band and `reachesJumpBand` retain that offset independently of the cover. The guide's question/link explanation is restored, and ADRs 0125/0126 distinguish the floating composer from a waiting question.

Added **keeps the question overlap out of the clip without moving the button's band** to `tests/unit/renderer/jumpBand.test.tsx` before the correction. With an unclipped question and the old band calculation it failed authentically: **5 passed, 1 failed**, `false` instead of `true` for a request reaching Jump. After the correction: **6/6 passed**, including a request below the band. Typecheck and lint passed again. The maintained `composer-float.spec.ts` now also checks the 26px extension, zero cover and transcript hits in both rounded corner gaps; that Electron spec was not run locally.

One targeted Watcher waiting-question case was rendered at **1280x800**, in **Sotto dark and light**, using the same headless fixture. These two captures were opened and visually inspected: [dark](../../artifacts/composer-float/inset-question-corners-1280-dark.png), [light](../../artifacts/composer-float/inset-question-corners-1280-light.png). The last reply includes a web link and a paragraph positioned across the card's rounded top edge. The prior captures and measurements remain unchanged.

| Measurement | Dark | Light |
| --- | --- | --- |
| Composer top / question card top | 317px / 327px | 317px / 327px |
| Scroll box bottom / overlap | 343px / 26px | 343px / 26px |
| Composer cover / bottom padding | 0px / 54px | 0px / 54px |
| Transcript hit at both corner gaps, 1px inside the card's bounds | yes | yes |
| Same hits with the prior 26px cover temporarily restored | neither | neither |
| Jump height / reserved scroll-padding | 36px / 90px | 36px / 90px |
| Readable edge / Jump top / clear gap | 253px / 267px / 14px | 253px / 267px / 14px |
| Remaining scroll after Jump / final item's gap above composer | 0px / 52.25px | 0px / 52.25px |

[Exact measurements](../../artifacts/composer-float/inset-question-corners-measurements.json). No page errors were observed. No full matrix, narrow or split layouts, other themes, Electron run or CI watch was repeated for this follow-up.

## Remaining verification

GitHub CI owns the Electron journeys and full gates. Windows/macOS/Linux window insets and scrollbar behavior in Electron, application zoom, custom/Glass/Omarchy palettes, real provider streams, and image preview loading were not exercised locally. The headless attachment check used a staged image handle and exercised the attachment's composer height, not disk loading. The headless split was pane geometry, not a drag on the live divider. No independent density setting exists in the current settings; full, quiet, slim and the existing short/narrow layout rules were checked.

The requested bundled durable-test-collateral and taste skills were unavailable in this environment; the user explicitly authorized proceeding without them before the first edit.
