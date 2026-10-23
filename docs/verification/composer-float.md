# Floating composer verification

October 23, 2026. The fix on `fix/floating-composer` from `main` at c9a681b15, on Windows 11 with the built app (`npm run build`). It makes #1391's composer float over the transcript's foot, which Sotto Owl 0.1.41-owl.20261023.5 shipped without doing.

## What was wrong

#1391 turned the float on with one rule in `src/renderer/src/agents/threads.css` that gave the pane `--thread-compose-height` unless a question waited:

```css
.thread-pane:has(> .thread-transcript + .thread-greeting-slot:empty + .thread-workspace__compose:not(:has(> .thread-questions))) { … }
```

A `:has()` inside another `:has()` is not valid CSS. Chromium drops the whole rule, so the variable was never set, the composer kept a zero margin, and the transcript stopped above it as before. The release build had the rule; nothing overrode it, and the question-waits test was never reached. In the built app before the fix, the pane had measured the composer (`--thread-compose-measured: 123px`) but `--thread-compose-height` was empty, the composer's top margin was `0px` and the transcript's bottom padding `28px`. #1391's own test change still passed, because it only allowed the composer to cover the transcript's padding, and a composer that does not float covers nothing.

The two tests now sit side by side on the pane, which is valid:

```css
.thread-pane:has(> .thread-transcript + .thread-greeting-slot:empty + .thread-workspace__compose):not(:has(> .thread-workspace__compose > .thread-questions)) { … }
```

With the float working, a second fault showed. The pane measured the composer with a `ResizeObserver` on its content box, and a short window changes only the composer's padding, so after shrinking to 820x560 the pane still held 165px for a 119px composer. It observes the border box now.

## How it was run

```sh
npm run build
SOTTO_E2E_EVIDENCE=publish npx playwright test tests/e2e/composer-float.spec.ts
npx vitest run tests/unit/renderer/cssSelectors.test.ts
```

`composer-float.spec.ts` gives three threads twelve messages each, scrolls each transcript to its end and checks that the composer's top margin is minus its height, that it covers the transcript by its full height, that the transcript's bottom padding keeps the last message clear of the card, and that a press in the strip right of the card lands in the transcript. It checks this for one pane at 1280x860 and at 820x560, for three panes side by side at 1280x620 (each a short pane), and with a permission card in a pane's transcript, whose Deny button it focuses and finds uncovered. A question waiting in one pane stacks that pane's composer under its transcript again, with a zero margin, while the pane beside it keeps floating. On the build before the fix the same spec fails at its first check (`marginTop 0`, `overlap 0`).

`cssSelectors.test.ts` reads every stylesheet under `src/` and fails on any `:has()` nested in another. Run against the old rule it names it; there are no others.

## What the captures show

Each capture scrolls the transcript 220px back from its end, so the last messages sit where the composer is.

- Before, [1280 dark](../../artifacts/composer-float/before/single-1280-dark.png), [1280 light](../../artifacts/composer-float/before/single-1280-light.png), [820x560 dark](../../artifacts/composer-float/before/single-820-dark.png) and [820x560 light](../../artifacts/composer-float/before/single-820-light.png): the transcript ends in a straight edge at the composer's top, and nothing shows below or beside the card.
- After, [1280 dark](../../artifacts/composer-float/single-1280-dark.png), [1280 light](../../artifacts/composer-float/single-1280-light.png), [820x560 dark](../../artifacts/composer-float/single-820-dark.png) and [820x560 light](../../artifacts/composer-float/single-820-light.png): the messages run on under the card and show below it and beside it, and the transcript's scroll bar runs to the bottom of the pane.
- [Three panes with a permission card, 1280x620](../../artifacts/composer-float/split-permission-1280x620-dark.png): each short pane's composer floats, and the permission card's Allow once and Deny sit clear above it.

## Not checked here

The new-thread greeting keeps the composer in the middle and was not changed; its own specs cover it. Watcher's room does not float its composer yet, which is separate work.
