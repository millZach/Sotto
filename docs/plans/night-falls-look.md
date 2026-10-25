# Night falls look: Band or Stars

Status: plan, waiting for the user's approval. The decision is ADR-0119, decision 6, amended October 24, 2026. The build follows in its own pull request once the plan is approved.

## Goal

Add Stars as a second look for the move between Threads and Watcher's room. Band stays the default and stays exactly as shipped. Both looks sit under the existing `night-falls` Owl feature, so there is one switch, one gate and no new Owl feature.

## The setting

- **Key and values:** `roomTransitionLook`, either `band` or `stars`. Default `band`.
- **Where it lives in Settings:** Settings → Appearance, directly under the switch "Night falls between Threads and Watcher" and above the speed dial "Night falls speed". It is a radio group named "Night falls look" with two options, "Band" and "Stars", each with one line under it saying what it does.
- **Gate:** the same as the switch and the dial (`nightFallsOn` in `SettingsView.tsx`, which is `useOwlFeature('night-falls') && watcherOn`). Stable shows no row and plays nothing. Its saved value stays whole.
- **Search:** a row in `settingsPages.ts` with id `night-falls-look`, section `settings-appearance`, gate `night-falls`, and words such as "transition animation stars band look".

## Files

Settings and IPC:

- `src/shared/settings.ts`: the type next to `roomTransition` and `roomTransitionSpeed` (around line 219), the zod schema (around line 373), the default `band` (around line 471), and the `parseField` line (around line 630).
- `src/main/ipc/registerIpc.ts`: `roomTransitionLook` on the patch allow-list, next to the other two (around line 123). `tests/integration/settingsHistoryIpc.test.ts` fails if this is missed.

Playback:

- `src/renderer/src/watcher/nightFalls.ts`: `NightFallsOptions` gains `look`. `playNightFalls` chooses the paint function: the shipped `paintBand` for Band, and a new `paintStars` for Stars. The clip-path reveal (`revealPolygon`, 36 keyframes) and the timing (`NIGHT_FALLS_MS` 840) are shared, so only the paint differs. New pure helpers pick each row's star and the trail's fade.
- `src/renderer/src/state/AppContext.tsx`, in `navigate` (around line 698): pass `look: current?.roomTransitionLook ?? 'band'` with the speed.
- `src/renderer/src/watcher/watcher.css`: no change expected. Both looks paint on the same `.night-falls-band` canvas.

Settings UI:

- `src/renderer/src/features/settings/NightFallsSettings.tsx`: the radio group, placed between the switch and the dial. It is disabled when the switch is off, as the dial is.
- `src/renderer/src/features/settings/settingsPages.ts`: the search row.

Docs, in the build PR:

- `CONTEXT.md`, the **Night falls** entry: the look choice, and the new word **Stars** (the stars look) if the glossary needs it.
- `docs/guide.md`, the Appearance paragraph: one sentence on night falls, its speed and its look, in the "in an Owl build" wording the guide already uses.
- `docs/verification/2026-10-24-night-falls-look.md`, with its captures in `artifacts/night-falls-look/`.

## The Stars look

Taken from variant C of the Band and Stars prototype, `room-front`:

- A front of `*`, `+` and `·`, chosen per row by a hash and the 45 ms flicker beat, in the accent ink.
- A faint trail of ramp characters behind the front, 140 px long, thinning with distance.
- One cell of background behind each star, so the edge is crisp. Only the trail darkens the room being opened.

The port must keep the shipped clip-path reveal, so the room being opened appears the same way under both looks. The prototype's own reveal is not used.

## Reduced motion

Nothing changes in the gate. `nightFallsAvailable()` already returns false under `prefersReducedMotion()`, so the page swaps in one frame, whichever look is set. The look is not read on that path. The Settings row stays usable with reduced motion on.

## Light and dark

- **Band** keeps its shipped inks: `--tt-text` on `--tt-canvas`, with `--tt-font-mono`.
- **Stars** takes `--tt-accent` through the same light-surface rule the night scene uses (`sceneInk` in `nightScene.ts`, with `LIGHT_ACCENT_BOOST`). The surface colour comes from `--tt-canvas` through the colour helper already in `WatcherNightScene.tsx`, exported for reuse. No colour is written into the component.
- The run lasts 840 ms and covers the words only while it plays, as the shipped band does. The Settings row itself keeps the theme's 4.5:1 text contrast.
- The verification captures are taken in both themes at 1600×1000, 1280×800 and the 820×560 minimum.

## Lingui

- New messages: the row name "Night falls look", the two option names "Band" and "Stars", their two descriptions, and the search label. They use `msg` in `settingsPages.ts` and `t` and `Trans` in `NightFallsSettings.tsx`, as the existing night falls strings do.
- Run `npm run i18n:extract` to add the message IDs to the 32 catalogs in `src/locales/features/`.
- Every catalog gets a translation for each new message. The drafts are made against the `CONTEXT.md` glossary and the list of names that are not translated, as ADR-0123 describes.
- `tests/unit/shared/interfaceCatalogs.test.ts` checks that every message the code writes is in every catalog, that none is left over, and that every translation parses with its placeholders intact. It runs in the normal test gate.
- Not translated: the setting key, the values `band` and `stars`, and the glyphs `*`, `+` and `·`, which are not words.

## Tests

- **Shared settings**, `tests/unit/shared/settings.test.ts`: the default is `band`; an invalid value falls back to `band`; the value round-trips.
- **IPC**, `tests/integration/settingsHistoryIpc.test.ts`: a patch with `roomTransitionLook: 'stars'` is saved, and the key is on the allow-list.
- **Playback**, `tests/unit/renderer/watcherNightFalls.test.tsx`:
  - `stars` calls the Stars painter and not the Band painter;
  - under reduced motion, Stars does not start a view transition and calls `update` once;
  - with `night-falls` not shipped, nothing plays;
  - each row's star is the same for the same row and flicker step;
  - the trail thins with distance;
  - on a light surface the accent uses the boosted ramp.
- **Settings row**, `tests/unit/renderer/features/settings/settingsNightFalls.test.tsx`: Band is selected by default; choosing Stars saves `roomTransitionLook: 'stars'`; the row is disabled with the switch off; the arrow keys move the selection; the row is absent when `night-falls` is off.
- **Gate**, `tests/e2e/watcher-gate.spec.ts` (existing): stable shows no look row.
- **Built app**, a new `tests/e2e/night-falls-look.spec.ts`: with both Owl features on, a Stars run plays on the way to Watcher and back; under reduced motion it does not play.
- **Catalogs**, `tests/unit/shared/interfaceCatalogs.test.ts` (existing).
- **Design**: `npm run design:verify` compares the Settings captures. The Appearance page changes with the new row. If its baseline changes, regenerate it with `npm run design:capture` and say so in the PR.
- **Gates before the PR:** `npm run typecheck`, `npm run lint`, `npm test -- --maxWorkers=2`, `npm run notices:verify`, and the Playwright specs above, after `npm run build`.

## Verification in the running app

Run the built app with `night-falls` and `watcher` on. Capture Stars at 40% of a run, toward Watcher and back, in light and dark, at the three sizes. Write the verification note with the captures, and name the commands run.

## Sequence

1. This pull request: the ADR-0119 amendment and this plan, docs only.
2. After approval, the build pull request on a `feat/` branch from `origin/main`. Before it is marked ready, a code review through the Codex delegate, then the gates, then READY TO MERGE.
3. The prototype's files are pushed as the tag `prototype/night-falls-look` when the build lands.

## Out of scope

- Stable. The look row and the Stars run stay Owl-only. Sending night falls to stable is a separate decision.
- The owl-wing front (variant B). It did not read as a wing, so it is not built.
- The iPhone and Android clients. Neither has a transition today.
- Changing the Band or its timing.
