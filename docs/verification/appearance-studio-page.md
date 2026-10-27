# Settings → Appearance as a studio: verification

October 26, 2026. `feat/appearance-studio-page`, on Windows 11 with the built app (`npm run build`). It covers Zach's pick, direction A (Studio) of `prototype/appearance-rework`: the Theme, Details and Motion cards beside a Preview card that stays in view as the page scrolls.

## How it was run

```sh
npm run typecheck
npm run lint
npx vitest run tests/unit/renderer/features/settings tests/unit/renderer/themeLibrary.test.tsx tests/unit/renderer/omarchyTheme.test.tsx tests/unit/renderer/creatureChoice.test.tsx tests/unit/renderer/themeTokens.test.ts tests/unit/renderer/effortArrival.test.ts tests/unit/renderer/appAppearance.test.tsx tests/unit/shared/interfaceCatalogs.test.ts --maxWorkers=2
npm run build
SOTTO_E2E_EVIDENCE=publish npx playwright test tests/e2e/appearance-studio-evidence.spec.ts
npx playwright test tests/e2e/settings-index.spec.ts tests/e2e/effort-picker.spec.ts tests/e2e/theme-editor-and-request-layout.spec.ts
SOTTO_THEMES_E2E=1 SOTTO_APPEARANCE_EVIDENCE=1 SOTTO_THEME_EVIDENCE=1 npx playwright test tests/e2e/theme-library-evidence.spec.ts tests/e2e/appearance-evidence.spec.ts tests/e2e/theme-palettes-evidence.spec.ts
npm run design:capture
```

The full suite runs in CI on the pull request, not on this machine.

## The page at the three sizes

`appearance-dark-1600x1000.png`, `appearance-light-1600x1000.png`, `appearance-dark-1280x800.png` and `appearance-light-1280x800.png` show two columns: the Theme card (color scheme, the six theme tiles, each split corner to corner into its light and dark halves, the switch, Create theme and Add theme) and the Details card under it on the left; the Preview card on the right with Threads in the theme the window is in. `appearance-dark-820x560.png` and `appearance-light-820x560.png` show one column, the preview above the cards. The spec checks at each size and mode that no control, card or tile reaches outside the scroll area and no card scrolls sideways; that with two columns the preview is still in view after the page scrolls 400 pixels; and that with one column it scrolls away with the page. Two columns hold from 1280x800 up.

## The split switch and the other half

`appearance-split-on-1280x800.png` and `appearance-preview-light-half-1280x800.png`: with **A different theme when dark** on, a Light grid ("Used when you switch to Light.") and a Dark grid ("Painting the window now."). With **Light** chosen in the preview, the preview window is painted in Sotto's light half while the window stays dark; the spec checks that the window keeps `data-theme="dark"`, that the preview carries `data-theme-scope="light"` and that the saved appearance did not change.

## Watcher's room

`appearance-watcher-dark-1280x800.png` and `appearance-watcher-light-1280x800.png` show Watcher's header, the conversation in its centred column, the glass composer, and the night scene in the margins: hills, trees, stars, Watcher's owl in its left tree and three thread owls, one glowing while it waits. The scene is the room's own painter (`nightScenePainter.ts`), laid out for the room scaled up until its margins hold the trees and drawn back at the preview's size, as one still frame. The spec reads the scene's canvas on every animation frame while the window goes from dark to light and is resized twice, and finds no frame without the scene.

## Keyboard

`appearance-keyboard-tile-1280x800.png`: focus on the Hush tile in the Light grid after an arrow key, its focus ring drawn round the tile, the choice saved ("Theme saved."). The unit tests walk Color scheme, then the tiles (one Tab stop, arrows choose), then the switch.

## Design captures

`settings-appearance.png`, `settings-appearance-light.png`, `appearance-system-dark.png` and `appearance-system-light.png` in `artifacts/design/app-review/baseline/` were captured again on purpose, and only their entries in `manifest.json` changed. `npm run design:capture` rewrote other baselines on this machine through drift unrelated to this page; those were put back.

## Failures seen that main has too

Run against main's source on the same machine, these fail the same way, so they are not from this change: `theme-library-evidence.spec.ts` "a spotlight over a drawn diagram goes quiet" (18 root style writes while idle), `claude-bot-creature.spec.ts` "the readout is words on the room", `night-falls-look.spec.ts` "plays stars on the way into Watcher's room and back", and `watcher-gate.spec.ts` "stable keeps saved special kinds".

## Not verified here

macOS (the Menu bar owl row) and Linux (the Omarchy tile) were not run; their unit tests pass. The Linux-only Omarchy e2e specs were updated but not run.
