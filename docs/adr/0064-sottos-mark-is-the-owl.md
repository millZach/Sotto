# Sotto's mark is the owl

## Status

Accepted October 8, 2026, by the owner's choice. The owner supplied a brand sheet, "04 / Scout", generated with OpenAI's Codex, and asked for its owl to replace the mark everywhere. Asked where, they chose everywhere, with the mark inside the app still painted by the theme. Asked about the wordmark beside it, they kept "Sotto" as it is. Amends [ADR-0024](0024-sotto-ships-its-own-palettes-in-light-and-dark-columns.md) only in what the icon draws; its colours and the theme rule are unchanged.

Renumbered from ADR-0062 on October 9, 2026, after the accepted Linux desktop ADR used the same number. The decision is unchanged.

## Context

The mark was a bar and a wave on a teal tile: a caret and a sound, from the months when Sotto was a dictation tool. Sotto now spends most of its time running coding agents' threads, and the owner wanted a mark with a character rather than a symbol. The sheet shows the owl as an app icon (a black owl on a teal tile, its eyes and beak cut through to the tile), a lockup with a lowercase wordmark, and a small inverted variant on a black tile. It is a raster image, so it cannot be the master for a 16-pixel menu-bar icon or a mark that a theme repaints.

## Decision

**1. The owl is the mark in every place the old mark was.** The Windows executable and installer icons, the installer sidebar, the macOS icon, the macOS menu-bar template, the iPhone app icon, Android's square and round launcher icons, and `SottoMark` wherever the app draws it: the strip, the sidebar top row, the widget and the theme preview.

**2. `build/icon.svg` is the one master, redrawn by hand.** The owl was traced from the sheet's app icon as cubic curves on the existing 96-unit tile with the same 22-unit corner radius. Measured against the sheet at 800 pixels, the trace and the original's owl overlap by 98.4 percent; what differs is edge softening in the raster. `scripts/generate-brand-assets.mjs` renders every derivative from it, and now writes the phone apps' icons too, so they can no longer drift from the desktop's.

**3. The colours stay the app icon's.** The tile is `#47b8a9` and the owl black (`APP_ICON_BRAND`). The sheet's teal measures `#43bbae`, which cannot be told apart at icon sizes; keeping `#47b8a9` keeps the Sotto theme's dark accent exactly the icon's colour (ADR-0024).

**4. The eyes and beak are holes, not shapes.** In the app the theme still paints the mark (ADR-0011, ADR-0024): the tile is the accent and the owl takes a foreground that reads on it, and the default theme wears the icon's own colours. Because the eyes and beak are cut out of the owl, they always show the tile, in any theme, without a third colour.

**5. The menu-bar template is the owl simplified for 16 pixels.** At that size the beak is a grey smudge and the pupils vanish, so `build/tray-template.svg` drops the beak and draws the pupils larger. Everywhere else, including the 16-pixel entry of the Windows icon, shows the full owl on its tile.

**6. The wordmark stays "Sotto" in Figtree.** The sheet's lowercase lockup is not adopted, and neither is its inverted black-tile variant.

**7. Provenance is recorded with the notices.** `THIRD_PARTY_NOTICES.md` says the owl was generated with OpenAI's Codex and redrawn as the vector master, and the sheet is kept as `artifacts/design/brand/owl-brand-sheet.png`. The retired artwork's sources stay in `artifacts/design/brand/` as history.

## Consequences

Nearly every design capture shows the mark, so the baselines were regenerated in the change that made this decision. The old mark's prototype captures in `artifacts/` and `docs/prototypes/` are left as they were: they record what was decided then. A future change to the owl is a change to `build/icon.svg` and one run of the generator; the in-app mark's path in `SottoMark.tsx` is kept in step with it by hand, as before.
