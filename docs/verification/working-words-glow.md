# A light you can see on the working words, and the turn's clock: verification

October 25, 2026. `fix/working-words-glow`, on Windows 11 with the built app (`npm run build`) and the thread activity fixture, which mounts the real Threads page with a stubbed agent connection. It covers [ADR-0134](../adr/0134-a-running-turns-steps-fold-under-its-working-words.md)'s October 25 amendment: Zach's pick, the letters lit with no accent halo, from `docs/prototypes/working-words-glow-strength-prototype.html`, and the clock after the words with nothing between.

## How it was run

```sh
npm run typecheck
npm run lint
npx vitest run tests/unit/renderer/threadActivity.test.tsx tests/unit/renderer/threadWorkingDisplay.test.tsx tests/unit/renderer/ownServerTurn.test.tsx tests/unit/shared/omarchyThemes.test.ts tests/unit/renderer/themeTokens.test.ts
npm run build
npx playwright test tests/e2e/thread-activity.spec.ts --timeout=180000
```

The full suite runs in CI on the pull request, not on this machine.

## Why the light was faint

`prototype-today-held.png` holds the light that shipped mid-word in four themes: dark and light of the default theme, a rose accent in dark and a violet one in light. The band blended the muted ink into the accent's text tone, which on a dark theme is nearly the same lightness, so it changed only the hue, and only at the band's centre. In the stills it cannot be found.

## The light now

`prototype-picked-held.png` holds the picked light at the same moment in the same four themes, and `live-glow-held-dark.png` and `live-glow-held-light.png` hold it in the running app, at twice the pixel density, through Web Animations paused 1.55 seconds into the cycle. "bing the de" reads in a vivid accent: lighter than the muted words in dark, deeper in light. There is no halo.

The spec checks that the lit copy carries the `thread-activity-glow` animation and that its colour differs from the words' own. Its colour, `--tt-working-light`, is now audited as text on the canvas and surface in every one of the 22 stock Omarchy palettes (`omarchyThemes.test.ts`), and passes 4.5:1 in all of them.

With reduced motion on, nothing moves: the words keep their ink, the still dot stands beside them, and the lit copy is not drawn at all (`content: none`), at the 820 minimum.

## The clock

The line reads the words and then the turn's clock, "1m 07s" in the held captures, in the muted ink a size smaller (`live-glow-held-*.png`). The spec watches the clock change within three seconds, and the unit test moves fake time on by a second and sees "1m 05s" become "1m 06s"; the clock is the transcript's own `Elapsed`, which sets its own text once a second rather than drawing the transcript again. It counts from Send while a prompt is on its way. Disconnected, the line reads Last seen working with no clock, and the button keeps its name, "Working, 3 steps so far", at every tick.

## Not checked here

- The iPhone keeps its own light and has no clock, as the amendment says; nothing in `apps/ios` changed.
- The design captures have no running turn, so their baselines do not change.
- In this run the activity fixture drew the thread sidebar without its styles. This change does not touch the sidebar, so the note cites only the working line's own captures.
