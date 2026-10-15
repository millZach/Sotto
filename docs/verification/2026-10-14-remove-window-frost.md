# The window and its surfaces are always solid

October 14, 2026, for ADR-0084. Windows 11, from `chore/remove-window-frost`.

## Settings → Appearance

`tests/e2e/settings-index.spec.ts` opens every Settings section in the built app at 1280x800, 1600x1000 and 820x560, in dark and light, and checks that nothing overflows or clips. At 820x560 it now scrolls the Contrast slider into view, where it used to look for Glass opacity. It passed. The captures were opened and checked:

- [1280 dark](../../artifacts/remove-window-frost/appearance-1280-dark.png) and [1280 light](../../artifacts/remove-window-frost/appearance-1280-light.png): the color scheme, the two theme columns and the live preview, as before.
- [820 dark](../../artifacts/remove-window-frost/appearance-820-dark-sliders.png) and [820 light](../../artifacts/remove-window-frost/appearance-820-light-sliders.png): under Effort color, Contrast is the only slider. There is no Glass opacity, Frosted window or See-through.

`tests/unit/renderer/themeLibrary.test.tsx` checks that the page has exactly one slider, Contrast, and no frost switch.

## Solid surfaces and window

- `tests/unit/renderer/themeTokens.test.ts` resolves `tokens.css` in both modes: `--tt-glass` equals `--tt-surface-overlay`, `--tt-glass-field` equals `--tt-field`, both are opaque, and text on each is at least 4.5:1.
- `tests/unit/main/windowConstruction.test.ts` checks that the main window on Windows, macOS and Linux is made with a `#000000` background, no `backgroundMaterial`, `vibrancy` or `visualEffectState`, and only the role and platform launch arguments. The Linux window keeps `transparent: true`.
- `tests/unit/shared/settings.test.ts` opens a settings file carrying `glassOpacity`, `frostedWindow` and `frostSeeThrough`. It parses to the same settings as a file without them, and the keys are dropped. `tests/unit/renderer/appearance.test.ts` does the same for the first-frame cache, and checks that applying it writes no glass or frost style or attribute to the root.
- `tests/e2e/sotto-owl-night-sky.spec.ts` passed with its frosted-band check removed.

## Design baselines

`npm run design:verify` was run on this branch and, with the change stashed, on its base (e3e7e2c34). On the base, the appearance, pages and threads captures passed, and the scaling and widget specs failed at `scale-125-onboarding.png` and `widget-idle-light.png`. Those two show a one-pixel layout shift and a widget drawn two pixels taller, nothing to do with this change. On this branch, five captures changed because of it and were regenerated:

- `settings-appearance.png`, `settings-appearance-light.png`, `appearance-system-dark.png` and `appearance-system-light.png`: the Appearance page is shorter by the Glass opacity slider.
- `threads-new-thread-chooser-light.png`: the project chooser dialog is solid instead of 80% glass over the blurred room.

Every other capture `npm run design:capture` rewrote was put back, so no unrelated baseline moved. The manifest's hashes for twelve captures (`onboarding-step-2-look`, nine theme captures and the two Threads search captures) did not match the committed images on the base, so `scripts/verify-design-captures.mjs` failed there. The manifest now records the committed images' hashes; no image changed. After the regeneration the appearance, pages and threads specs pass.

`npm run design:verify` still fails on this branch, and it fails the same way on `main` at e3e7e2c34 without this change. Two specs fail there before this branch touches anything:

- `design-capture-scaling.spec.ts` fails at `scale-125-onboarding.png`, a one-pixel layout shift.
- `design-capture-voice-widget.spec.ts` fails at `widget-idle-light.png`, the widget drawn two pixels taller.

Both specs stop at their first failure, so these captures were not compared, on this branch or on `main`:

- Scaling: the rest of 125% (`scale-125-dictate`, `-widget-light`, `-widget-dark`, `-history`, `-settings`, `-help`, `-dictate-light` and `-settings-light`) and the same nine captures at 150% and 200%, starting with `scale-150-onboarding` and `scale-200-onboarding`. The nine 100% captures were compared and passed.
- Widget: `widget-permission-light` and `widget-cancelled-light`, and the whole dark test, which did not run: `widget-idle-dark`, `widget-permission-dark` and `widget-cancelled-dark`.

`design:verify` runs `scripts/verify-design-captures.mjs` only when every capture passes, so the manifest check was run on its own here. It verified 144 tuples.

## Not verified

- `SOTTO_THEMES_E2E=1 npx playwright test tests/e2e/theme-library-evidence.spec.ts`: the Appearance sliders journey, edited here, passed. "A spotlight over a drawn diagram goes quiet" fails the same way on the base, with root style changes while it should be idle, so it was not counted.
- macOS and Linux were not run. Their window options are covered only by the unit test above.
- A dialog, menu or the composer over busy content was not captured by hand. The design captures below are the visual check of those surfaces.
