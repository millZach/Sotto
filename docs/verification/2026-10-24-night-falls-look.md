# Night falls look: Band or Stars, October 24, 2026

The user approved the plan in `docs/plans/night-falls-look.md`, which builds ADR-0119's decision 6: a second look, **Stars**, for night falls, the move between Threads and Watcher's room. Band stays the default and is unchanged. This note says what was built, what I worked out where the plan and the prototype did not reach, and what was run.

## What was built

- **The setting.** `roomTransitionLook`, `band` or `stars`, default `band`, in `src/shared/settings.ts`, and on the patch allow-list in `src/main/ipc/registerIpc.ts`. A value Sotto does not know, or a settings file from before the look, reads as `band`.
- **The run.** `src/renderer/src/watcher/nightFalls.ts` chooses the painter: the shipped `paintBand`, or the new `paintStars`. The front (`frontEdge`), the clip that reveals the room being opened (`revealPolygon`, 36 keyframes), the timing (`NIGHT_FALLS_MS`, 840 ms at speed 1), the owl's flight and the reduced-motion skip are the shipped ones for both looks. The Stars painter is a thin loop over pure functions: `frontStar` (each row's glyph and strength for a flicker step), `trailStrength` and `trailMark` (the trail thinning with distance), `trailLeft` (the trail leaving as the front passes the far side) and `starsCells` (every cell one frame paints). `starsInk` takes the inks through the night scene's `sceneInk`, so on a light surface the accent takes `LIGHT_ACCENT_BOOST` and the trail `LIGHT_INK_BOOST`. The colours are read from `--tt-canvas`, `--tt-text` and `--tt-accent` with `toRgb`, which moved from `WatcherNightScene.tsx` to `src/renderer/src/watcher/canvasColor.ts` so night falls can use it without importing the night scene's component.
- **Which run plays.** `nightFallsRun` in `nightFalls.ts` now holds the decision `navigate` in `AppContext.tsx` made inline: between the two rooms, with `night-falls` and Watcher shipped and the switch on, it plays the set look at the set speed; settings not yet read play the band at speed 1.
- **Settings.** In `NightFallsSettings.tsx`, a row **Night falls look** between the switch and the speed dial: a two-choice segmented control, **Band** and **Stars**, each described by its own line under the row's name. It saves as it is chosen; the arrow keys move the choice and the focus; it rests while the switch is off, as the dial does. It is gated with the switch (`nightFallsOn`), and Find a setting has a row for it (`night-falls-look`, gate `night-falls`). `SegmentedControl` options can now name their own description (`describedBy`).
- **Words.** Five new messages, all in the `settings` catalogs, each drafted in the 29 languages. `CONTEXT.md` (the Night falls entry) and `docs/guide.md` (Watcher's paragraph and the Appearance item) name the look.

## What I worked out

- **The stars sit on the shipped front.** The prototype's variant C drew its stars along its own line, a slow wave with its own reveal. The plan keeps the shipped reveal, so the stars follow the shipped front instead: each row's star is in the cell its front edge falls in, on a cell of the canvas colour, and the trail runs back from it into the room being opened. The wave is not kept, since stars off the reveal's edge would leave the edge bare; the front keeps the shipped one-cell ragged edge.
- **The trail leaves with the run.** The prototype's star line travelled 140 px past the window. The shipped front ends 90 px past it, which would leave the faint end of the trail on screen when the canvas is removed. `trailLeft` thins the trail to nothing over that last stretch.
- **Where the colours cannot be read, the band plays.** If one of the three tokens paints nothing, Stars has no inks; the run falls back to the band rather than painting in a guessed colour.
- **The catalogs are `settings`, not `features`.** The brief named `src/locales/features/*.po`; Lingui extracts `src/renderer/src/features/settings` into `src/locales/settings/*.po`, so the drafts are there. The other night falls messages beside them have no translations yet. The drafts keep "Night falls" as a name, untranslated, so the row reads with its untranslated neighbours.

## What was run

On the Windows laptop, in the worktree `.worktrees/night-falls-look-build`:

- `npm run typecheck` and `npm run lint`: pass.
- `npx vitest run` on `tests/unit/shared/settings.test.ts`, `tests/integration/settingsHistoryIpc.test.ts`, `tests/unit/renderer/watcherNightFalls.test.tsx`, `tests/unit/renderer/features/settings/settingsNightFalls.test.tsx` and `tests/unit/shared/interfaceCatalogs.test.ts`: pass.
- `npm run build`, then `npx playwright test tests/e2e/night-falls-look.spec.ts`: both tests pass. The first launches an Owl build (the shared `releaseTrack.ts` fixture) on an owned profile with Stars set, and plays the move into Watcher's room and back in dark and light at 1600x1000, 1280x800 and 820x560. Each run is held at 40% of its length by pausing the page's animations and its next frame, captured, and let go. Every held run was 840 ms long, had the clip on the room being opened, and had canvas pixels in the theme's accent, which the band never paints. The second, with reduced motion on, saw no transition and no canvas on either move.
- `npx playwright test tests/e2e/watcher-gate.spec.ts`: the Owl test, which now also checks that Appearance shows the look row with Band and Stars, passes. The stable test fails before it reaches Settings, on its first check that stable has no Watcher (`watcherEnabled` is true): Watcher was sent to stable (`sentToStable: true` in `src/shared/owlFeatures.ts`) and that expectation predates this change, so the stable half of the new check did not run here.
- `npm run design:verify`: the Appearance captures match their baselines (they are taken on stable, which shows no night falls rows), so nothing was regenerated. Two captures outside this change differed on this laptop, `scale-125-onboarding.png` and `widget-idle-light.png`; they were left as they are.
- The full `npm test` was not run on this laptop; CI runs it.

The captures, published with `SOTTO_E2E_EVIDENCE=publish`, each held at 40% of a Stars run:

| Theme | Size | Into Watcher's room | Back to Threads |
| --- | --- | --- | --- |
| Dark | 1600x1000 | [stars-in-dark-1600x1000.png](../../artifacts/night-falls-look/stars-in-dark-1600x1000.png) | [stars-out-dark-1600x1000.png](../../artifacts/night-falls-look/stars-out-dark-1600x1000.png) |
| Dark | 1280x800 | [stars-in-dark-1280x800.png](../../artifacts/night-falls-look/stars-in-dark-1280x800.png) | [stars-out-dark-1280x800.png](../../artifacts/night-falls-look/stars-out-dark-1280x800.png) |
| Dark | 820x560 | [stars-in-dark-820x560.png](../../artifacts/night-falls-look/stars-in-dark-820x560.png) | [stars-out-dark-820x560.png](../../artifacts/night-falls-look/stars-out-dark-820x560.png) |
| Light | 1600x1000 | [stars-in-light-1600x1000.png](../../artifacts/night-falls-look/stars-in-light-1600x1000.png) | [stars-out-light-1600x1000.png](../../artifacts/night-falls-look/stars-out-light-1600x1000.png) |
| Light | 1280x800 | [stars-in-light-1280x800.png](../../artifacts/night-falls-look/stars-in-light-1280x800.png) | [stars-out-light-1280x800.png](../../artifacts/night-falls-look/stars-out-light-1280x800.png) |
| Light | 820x560 | [stars-in-light-820x560.png](../../artifacts/night-falls-look/stars-in-light-820x560.png) | [stars-out-light-820x560.png](../../artifacts/night-falls-look/stars-out-light-820x560.png) |

In each, the stars stand on the edge of the room being opened, the faint trail lies over that room behind them, and the room being left is untouched ahead of them. No capture of the Settings row was taken by this spec.
