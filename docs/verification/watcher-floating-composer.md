# Slim composer and Watcher's column verification

October 23, 2026, and October 24 for pick D2. `feat/floating-composer-shrink`, built on the floating composer fix (`fix/floating-composer`, merged with `main` after #1441), on Windows 11 with the built app (`npm run build`). It covers three changes the user asked for that day:

- the Threads composer card loses its focus edge (ADR-0110, amended);
- the **slim composer**, an Owl feature (`composer-shrink`, ADR-0125, pick B of `docs/prototypes/composer-shrink-prototype.html`, a draft keeps it full);
- Watcher's conversation column (ADR-0126, picks D and D2 of `docs/prototypes/watcher-floating-composer-prototype.html`): the composer floats as frosted glass, the night scene runs under the column at 85% and never moves for the words, each word has a glow of the canvas, the conversation's names and times are in the secondary text colour, and Watcher's composer slims as a thread's does.

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

### Names and times in the secondary colour (pick D2)

On October 24, 2026 the user picked D2 on round 3 of the prototype. As first built, the column's ink ceiling was held down by the muted tier the conversation's names and times are written in: it sits only 6.3 to 9.5:1 on the canvas, so no glyph under the column could go past about a sixth to a quarter of the text colour by night and a tenth by day, and the column read faint. In Watcher's conversation the muted tier now takes the secondary tier (`--tt-text-muted` is set to `--tt-text-2` on the conversation), and the ceiling is worked out from the text colour, the secondary tier and the link colour. The strength stays at 85%. The spec checks that a reply's time is in the secondary colour, and the fixture now has a link in each reply so the link colour is measured too.

Contrast is read from the canvas. Every pixel the landscape draws in the column below the header is laid over the pane's surface as the screen shows it and compared with every colour a word in the conversation is written in, the glow left out; under the composer, the glass card's colour over each of those pixels, unblurred, is compared with the placeholder and the composer's own words. A decorative mark (the faint dot between New Watcher and the model, which is hidden from screen readers) is not counted as a word. In all six built-in themes, at 1600x1000 and 1280x800 (`artifacts/watcher-column/readings.json`). The ceiling is the highest step each ink may take in the column, with the alpha a glyph's core is drawn at in brackets (by day the ink is made stronger, 1.9 times for the text colour and 1.5 times for the accent):

| Theme | Mode | Lowest word over the scene | Lowest composer word over the glass | Ceiling, text ink | Ceiling, accent ink |
| --- | --- | --- | --- | --- | --- |
| Sotto | dark | 5.14:1 | 7.34:1 | 0.30 (0.30) | 0.45 (0.45) |
| Hush | dark | 4.99:1 | 5.46:1 | 0.25 (0.25) | 0.35 (0.35) |
| Linen | dark | 4.95:1 | 5.46:1 | 0.25 (0.25) | 0.35 (0.35) |
| Nocturne | dark | 5.01:1 | 5.36:1 | 0.25 (0.25) | 0.40 (0.40) |
| Tropic | dark | 4.87:1 | 5.49:1 | 0.25 (0.25) | 0.45 (0.45) |
| Citrine | dark | 4.97:1 | 5.28:1 | 0.25 (0.25) | 0.30 (0.30) |
| Sotto | light | 4.82:1 | 5.67:1 | 0.10 (0.19) | 0.20 (0.30) |
| Hush | light | 5.28:1 | 5.04:1 | 0.15 (0.28) | 0.35 (0.52) |
| Linen | light | 5.31:1 | 5.03:1 | 0.15 (0.28) | 0.35 (0.52) |
| Nocturne | light | 5.27:1 | 5.02:1 | 0.15 (0.28) | 0.30 (0.45) |
| Tropic | light | 5.11:1 | 5.14:1 | 0.15 (0.28) | 0.30 (0.45) |
| Citrine | light | 5.07:1 | 5.06:1 | 0.15 (0.28) | 0.40 (0.60) |

No theme needed its share lowered from 85%. The ceiling targets 4.6:1 so rounding never lands under 4.5:1. By night the ceiling rose from 0.15 to 0.25 of the text colour to 0.25 to 0.30; by day from about 0.10 to about 0.28. Sotto by day is the exception at 0.19: its link colour sits at 7.2:1 on the canvas, below its secondary tier, so its links set its ceiling. The scene in the column now reads as clear dotted hills, still quieter than the margins.

`watcherNightScene.test.ts` checks the 85% share in both modes, that the scene runs under the composer, that a point in the column shows the same share however the conversation scrolls, and the ceiling: at it every word keeps 4.6:1, a step past it one falls under, the muted tier would hold it lower than the secondary one, and a word already under 4.5:1 on the bare surface leaves no ink. `watcher-night-scene.spec.ts` now expects the landscape in the column under words as well as between them, and still none of the owls.

Captures, dark and light, at 1600x1000, 1280x800 and 820x560: `artifacts/watcher-column/full-*.png` and `artifacts/watcher-column/slim-*.png`.

## Not covered

- Paste, drop and dictation into the composer are covered as "a draft appears", by the draft store the slim rule reads, not one by one.
- Linux is not checked (ADR-0062).
