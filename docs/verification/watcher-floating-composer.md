# Slim composer and Watcher's column verification

October 23, 2026. `feat/floating-composer-shrink`, built on the floating composer fix (`fix/floating-composer`, merged with `main` after #1441), on Windows 11 with the built app (`npm run build`). It covers three changes the user asked for that day:

- the Threads composer card loses its focus edge (ADR-0110, amended);
- the **slim composer**, an Owl feature (`composer-shrink`, ADR-0125, pick B of `docs/prototypes/composer-shrink-prototype.html`, a draft keeps it full);
- Watcher's conversation column (ADR-0126, pick D of `docs/prototypes/watcher-floating-composer-prototype.html`): the composer floats as frosted glass, the night scene runs under the column at 85% and never moves for the words, each word has a glow of the canvas, and Watcher's composer slims as a thread's does.

## How it was run

```sh
npm run typecheck
npm run lint
npx vitest run tests/unit/renderer/slimComposer.test.tsx tests/unit/renderer/watcherNightScene.test.ts tests/unit/renderer/jumpBand.test.tsx tests/unit/shared/owlFeatures.test.ts
npm run build
SOTTO_E2E_EVIDENCE=publish npx playwright test tests/e2e/composer-shrink.spec.ts tests/e2e/watcher-column.spec.ts
npx playwright test tests/e2e/composer-float.spec.ts tests/e2e/watcher-night-scene.spec.ts tests/e2e/watcher-picture.spec.ts
npm run design:verify
```

## Why Watcher's composer did not float

Watcher's pane is a `section.thread-pane` with Watcher's header, the transcript, the greeting slot and the composer as children, the same order a thread's pane has, so it matched the float rule. It did not float for the same reason no composer did: the rule nested one `:has()` in another and the browser dropped it (`docs/verification/composer-float.md`). On the fixed base it floats, and #1441's marks rule keeps it floating. What still made it read as docked was the scene, which kept a gap round the composer, and the solid card.

## The slim composer

`composer-shrink.spec.ts` gives a thread sixteen messages and reads it back. At the end and 120px above it the composer is full; 420px above it the composer is one line (41px against 135px full, at 1280x860), its disc beside the line, the options row, the branch toolbar and the line under the card gone. The composer's own box and the transcript's height are unchanged, so the transcript does not move, and the attribute changes once and stays. Jump to latest sits 14px above the slim card. The textbox keeps its name, the disc its name, and the live regions' words do not change. Coming back within 40px of the end, a click on the slim card, Tab from Jump to latest and a key typed in the transcript each bring it back full; the typed key lands in the composer. A draft keeps it full while reading back, and emptying it lets it slim. A press on the disc acts where it stands without bringing the composer back. The card moves for 200ms; with reduced motion it has no animation. A waiting question keeps it full. With the Owl feature off it never slims, and a key in the transcript stays there. At 820x560 it is one line too, in dark and light, with nothing spilling sideways.

With the composer's focus edge gone, the card's border stays clear while the caret is in it; Tab still reaches the composer's controls, which keep their focus rings.

`slimComposer.test.tsx` holds the rule (reading back, focus, draft, a waiting question, the feature off), the 160px line, which keys count as typing, and the pane's behaviour in jsdom. `jumpBand.test.tsx` checks that a request card under the button is found above what shows of a slim composer.

Captures, dark and light, at 1280x860 and 820x560: `artifacts/composer-shrink/thread-full-*.png` and `artifacts/composer-shrink/thread-slim-*.png`.

## Watcher's column

`watcher-column.spec.ts` seeds a Watcher with twenty-four messages and three watched threads. At 1600x1000, 1280x800 and 820x560, dark and light, Watcher's composer floats (its top margin is minus its height, the transcript keeps that much padding, the last message comes clear at the end), stays above the floating switch, and is glass: the card's colour at 72% with `blur(14px)`. Reading back slims it, and the landscape under the column, the glass card included, stays pixel for pixel the same as the composer slims and as the words scroll a further 480px. Watched keeps the floating composer, Visualize keeps its one line until focused and never slims, and a key typed in the conversation goes to Watcher's composer.

Contrast is read from the canvas. Every pixel the landscape draws in the column below the header is laid over the pane's surface as the screen shows it and compared with every colour a word in the conversation is written in, the glow left out; under the composer, the glass card's colour over each of those pixels, unblurred, is compared with the placeholder and the composer's own words. In all six built-in themes, at 1600x1000 and 1280x800 (`artifacts/watcher-column/readings.json`):

| Theme | Mode | Lowest word over the scene | Lowest composer word over the glass |
| --- | --- | --- | --- |
| Sotto | dark | 4.70:1 | 5.58:1 |
| Hush | dark | 4.86:1 | 4.66:1 |
| Linen | dark | 4.86:1 | 4.70:1 |
| Nocturne | dark | 4.79:1 | 4.61:1 |
| Tropic | dark | 4.85:1 | 4.72:1 |
| Citrine | dark | 4.99:1 | 4.82:1 |
| Sotto | light | 5.01:1 | 4.53:1 |
| Hush | light | 4.76:1 | 5.16:1 |
| Linen | light | 4.77:1 | 5.15:1 |
| Nocturne | light | 5.10:1 | 5.12:1 |
| Tropic | light | 5.11:1 | 5.08:1 |
| Citrine | light | 4.84:1 | 5.12:1 |

The lowest word is always the muted tier (the names and times). No theme needed its share lowered from 85%: the column's ink ceiling, worked out from each theme's text, muted and accent colours, holds every word at 4.6:1 or more in the maths and at the values above on screen. The ceiling is low: before it, the muted tier sits 6.3 to 9.5:1 on the canvas, and the strongest a glyph may go in the column is about a sixth to a quarter of the text colour by night and a tenth by day. The scene in the column reads as faint dotted hills, fainter by day; the margins are unchanged.

`watcherNightScene.test.ts` checks the 85% share in both modes, that the scene runs under the composer, that a point in the column shows the same share however the conversation scrolls, and the ceiling: at it both words keep 4.6:1, a step past it one falls under, and a word already under 4.5:1 on the bare surface leaves no ink. `watcher-night-scene.spec.ts` now expects the landscape in the column under words as well as between them, and still none of the owls.

Captures, dark and light, at 1600x1000, 1280x800 and 820x560: `artifacts/watcher-column/full-*.png` and `artifacts/watcher-column/slim-*.png`.

## Not covered

- Paste, drop and dictation into the composer are covered as "a draft appears", by the draft store the slim rule reads, not one by one.
- Linux is not checked (ADR-0062).
