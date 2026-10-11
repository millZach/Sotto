# Sotto Owl night sky, October 10, 2026

Zach picked a night sky for an Owl build's sidebar header from [the header stars prototype](C:/Users/zache/AppData/Local/zstack-scratch/owl-stars/index.html): its third variant, the night tint with the slow twinkle. The prototype stays outside the repository; ADR-0072 records the pick. This note says what was built, what I worked out where the prototype did not reach, and how it was checked on the built app.

## What an Owl build shows

Behind the Threads sidebar's top row and its search field, an Owl build paints a faint night band that fades into the sidebar over the 16 pixels under the field. The accent glows softly behind the tile. Eleven tiny stars sit around the tile and behind the toolbar, three of them in the accent, at the positions Zach's screenshot has them. Four slowly dim to a fifth of their strength and come back, on 9, 11, 13 and 15 second cycles that never line up. The search field and the Threads | Terminal switch take the night too. With reduced motion, from Windows or from **Settings → Application → Reduced motion**, nothing moves and the sky is the still night. By day the stars take the accent, a little larger, and the four faintest drop out, so three twinkle. The band becomes a faint wash of the accent that is never darker than the sidebar.

Stable is unchanged: no sky, no band, no change to the field or the switch. The tile, Watcher's records and everything outside the sidebar header are untouched.

## Where it lives

- `src/renderer/src/agents/SidebarFrame.tsx` renders `OwlSky` and sets `data-sky` on the sidebar when `useReleaseTrack() === 'owl'` and the sidebar is open. That is the signal `SidebarTop` already uses for the tile. Collapsing the sidebar takes the sky away with the list.
- `src/renderer/src/agents/OwlSky.tsx` holds the eleven stars, read off the prototype, and draws them `aria-hidden`, with nothing focusable.
- `src/renderer/src/agents/owlSky.css` paints it. It is on the `owned` list `themeTokens.test.ts` checks. The band is the sidebar's own background, a gradient from the night to the sidebar between 76 and 92 pixels. The stars and the glow lie in a positioned layer with `pointer-events: none` and no app region. The top row and the search field are positioned after it, so every control paints over the sky.
- `src/renderer/src/styles/tokens.css` derives every colour from theme roles: the `--tt-owl-*` tokens, with light mode's differences in its light block. `frost.css` frosts the band at the sidebar's solidity.

## What I worked out

- **The night's hue comes from the sidebar, not the canvas.** The prototype took the canvas hue from a table of theme ids. Feature CSS never branches on the theme, so each night colour is a relative colour of its own surface: the sidebar, the switch's two surfaces. It keeps that surface's hue unless its chroma is under 0.001, in which case it takes Sotto's night blue, 265. Citrine's sidebar has none. Sotto's night is 265 either way, Tropic's 158 (the prototype had 156) and Nocturne's 254 (the prototype had 262). A theme the user makes gets its own night with no table to update.
- **The dark search field is a deeper pool of the night.** The prototype lifted the theme's own field 0.04 in lightness. On Sotto that gives `oklch(0.185 0.026 265)`, the field in Zach's screenshot. On the other five themes it took the placeholder from about 5.0:1 to 4.50–4.56:1 and made the field lighter than the band. The field is now the sidebar 0.05 darker, with its chroma lifted. On Sotto that is the same colour to the pixel. Everywhere else the placeholder reads better than on stable, and the field stays darker than the band, as in the screenshot.
- **Light mode mixes the accent in at full lightness.** The prototype mixed 10% of the accent and added 0.045 lightness back. That left Nocturne's wash a shade darker than its sidebar, and a theme with a deep accent would be darker still. The wash is now `color-mix(in oklab, sidebar 90%, accent at lightness 1)`. Its lightness is 0.9 × the sidebar's + 0.1, never below the sidebar's, whatever the theme.
- **macOS.** The tile sits 64 pixels further in, right of the traffic lights, and the glow and the left-hand stars move with it. On a sidebar narrower than 319 pixels the open sky between the tile and the toolbar closes, so the six stars in it go and five remain. The sidebar's own query measures 318 pixels inside its 1-pixel border. No star sits where the traffic lights are drawn.
- **Only the Threads sidebar has a sky.** It covers Threads and Terminal mode and the same sidebar beside Dictate, History and Help. The Settings column and the collapsed rail have no search field to fade under, and keep only the tile.

## How it was run

`tests/e2e/sotto-owl-night-sky.spec.ts` runs the output of `npm run build`. Each launch has its own owned e2e profile and the `design-threads` fixture, never Zach's data. Owl launches start Electron on a temporary folder whose `package.json` declares an Owl version, the same mechanism the branding note describes: `0.1.35-owl.20261010.1` when this evidence was published, and since #922 the shared `tests/e2e/support/releaseTrack.ts` fixture's `0.1.37-owl.20261012.1`. `tests/e2e/support/sottoOwl.ts` now only holds and releases the twinkle. The run published with `SOTTO_E2E_EVIDENCE=publish`, and every measured value is in [night-sky.json](../../artifacts/sotto-owl-night-sky/night-sky.json).

Checked on Owl in the Sotto, Tropic and Citrine themes, dark and light, at 1600x1000, 1280x800 and 820x560:

- **Stars.** Eleven are shown by night and seven by day, three of them in the accent. No star's box touches the glyph of any toolbar control, the tile or the search field. `elementFromPoint` at each star's centre finds the control or the sidebar beneath, never the sky, so no star catches a press. The same holds at the sidebar's narrowest (260) and widest (480).
- **On screen, not just in the page.** Each shown star's strongest pixel, against the median of a ring around it in a capture of the strip, changes by 23 to 125 levels at the three brighter strengths by night and 48 to 135 by day. A star the band painted over would read 0. The first build had that fault: the sky sat under the sidebar's own background, because the sidebar is not a stacking context. This check is what found it.
- **Drag strip.** The top row's computed `-webkit-app-region` is still `drag`, and the sky's is not. This is a CSS check; a native drag was not exercised.
- **Twinkle.** Four animations run, lasting 9, 11, 13 and 15 seconds. Their time advances, and a star out of step is below its own strength. With reduced motion from Windows alone, and then from Sotto's setting alone, no animation exists and every star is at exactly its own strength.
- **Captures.** They still the twinkle first, so they repeat exactly. The twinkle runs on the compositor, which does not repaint a paused animation moved to another time, so the captures switch it off and show every star at its own strength. The design gate's own captures are of stable, which has no sky.
- **Frost.** With the frosted window on, the band and the sidebar both paint at the sidebar's solidity (alpha 0.68 at the default), so the header is one sheet of frost.
- **Stable.** No `data-sky`, no sky or star elements, and no background image on the sidebar.

### Contrast on the band

Measured on the built app at 1280x800 from computed colours, ink against the surface under it: stable → Owl. The stable value is what stable paints there: the sidebar, the switch's own surfaces and the theme's field. The placeholder's colour is first checked to be the faint text token it is painted in. The values are the same at all three sizes. Nothing on the band is below 4.5:1, and nothing gives up more than a twentieth of its stable contrast. `themeTokens.test.ts` asserts the same for all six built-in themes in both modes.

| Theme | Mode | Band | Add project, New thread | Collapse sidebar | Switch, unlit | Switch, lit | Search placeholder | Search icon |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Sotto | dark | `#151b29` | 5.70 → 5.88 | 7.76 → 8.00 | 9.09 → 9.09 | 17.84 → 17.92 | 6.76 → 6.40 | 9.20 → 8.70 |
| Sotto | light | `#edf4ed` | 4.56 → 4.64 | 6.26 → 6.37 | 6.05 → 6.05 | 14.69 → 14.69 | 5.06 → 5.06 | 6.95 → 6.95 |
| Tropic | dark | `#022313` | 4.62 → 4.77 | 5.78 → 5.97 | 5.52 → 5.54 | 13.75 → 13.68 | 4.97 → 5.18 | 6.23 → 6.49 |
| Tropic | light | `#e9e6de` | 4.82 → 4.90 | 5.67 → 5.76 | 5.78 → 5.78 | 14.19 → 14.19 | 5.28 → 5.28 | 6.21 → 6.21 |
| Citrine | dark | `#141925` | 4.65 → 4.80 | 5.82 → 5.99 | 5.56 → 5.58 | 14.60 → 14.59 | 4.99 → 5.16 | 6.23 → 6.45 |
| Citrine | light | `#eee9db` | 4.69 → 4.79 | 5.55 → 5.66 | 5.61 → 5.61 | 14.34 → 14.34 | 5.13 → 5.13 | 6.07 → 6.07 |

The band is darker than the sidebar by night, so the icons read better. The one loss is Sotto's dark search field, about 5%, where the night field is the colour Zach picked from his screenshot.

## Against the prototype

I compared the captures with the prototype's `threads-3-twinkle-1280x800-dark.png` and `-light.png`, its `window-header-3-twinkle-1600x1000-*` close-ups and its Tropic and Citrine theme captures. Then I sampled the same CSS points in each: open sky 200 pixels in and 5 down, the glow 60 pixels in, the field, and the sidebar under the band.

| | Band | Glow | Field | Sidebar |
| --- | --- | --- | --- | --- |
| Sotto dark, prototype / app | 21 27 41 / 21 27 41 | 24 38 49 / 25 39 50 | 13 18 30 / 13 18 30 | 29 30 32 / 29 30 31 |
| Sotto light | 237 243 237 / 237 244 237 | 224 236 230 / 225 238 231 | 253 252 249 / 253 252 249 | 242 240 234 / 242 239 234 |
| Tropic dark | 4 35 18 / 3 36 19 | 20 40 26 / 21 41 29 | 12 40 24 / 0 26 12 | 12 37 24 / 12 37 23 |
| Citrine dark | 20 25 37 / 20 26 37 | 35 37 36 / 36 39 38 | 26 30 39 / 12 17 27 | 28 28 28 / 28 28 28 |

Every sample is within three levels of the prototype except the dark search field in Tropic and Citrine, the deeper field described above. The stars sit where the prototype and Zach's screenshot have them. The close-ups at 150%, the scaling Zach's screenshots were taken at, show them at the size he sees. Differences left on purpose: the deeper dark field outside Sotto; the light wash a level lighter; Nocturne's and Tropic's night a few degrees from the prototype's hue.

## Captures

Threads, Owl, Sotto: [dark 1600x1000](../../artifacts/sotto-owl-night-sky/threads-owl-sotto-dark-1600x1000.png), [dark 1280x800](../../artifacts/sotto-owl-night-sky/threads-owl-sotto-dark-1280x800.png), [dark 820x560](../../artifacts/sotto-owl-night-sky/threads-owl-sotto-dark-820x560.png), [light 1600x1000](../../artifacts/sotto-owl-night-sky/threads-owl-sotto-light-1600x1000.png), [light 1280x800](../../artifacts/sotto-owl-night-sky/threads-owl-sotto-light-1280x800.png), [light 820x560](../../artifacts/sotto-owl-night-sky/threads-owl-sotto-light-820x560.png). Nothing overflows or clips at the minimum.

Other themes at 1280x800: [Tropic dark](../../artifacts/sotto-owl-night-sky/threads-owl-tropic-dark-1280x800.png), [Tropic light](../../artifacts/sotto-owl-night-sky/threads-owl-tropic-light-1280x800.png), [Citrine dark](../../artifacts/sotto-owl-night-sky/threads-owl-citrine-dark-1280x800.png), [Citrine light](../../artifacts/sotto-owl-night-sky/threads-owl-citrine-light-1280x800.png).

The header at 150%: [Sotto dark](../../artifacts/sotto-owl-night-sky/header-owl-sotto-dark-150.png), [Sotto light](../../artifacts/sotto-owl-night-sky/header-owl-sotto-light-150.png), [Tropic dark](../../artifacts/sotto-owl-night-sky/header-owl-tropic-dark-150.png), [Citrine dark](../../artifacts/sotto-owl-night-sky/header-owl-citrine-dark-150.png). At the sidebar's [narrowest](../../artifacts/sotto-owl-night-sky/header-owl-sotto-dark-sidebar-260.png) and [widest](../../artifacts/sotto-owl-night-sky/header-owl-sotto-dark-sidebar-480.png). Reduced motion [from Windows](../../artifacts/sotto-owl-night-sky/header-owl-sotto-dark-reduced-motion-system.png) and [from Sotto's setting](../../artifacts/sotto-owl-night-sky/header-owl-sotto-dark-reduced-motion-setting.png). Stable, unchanged: [dark](../../artifacts/sotto-owl-night-sky/header-stable-sotto-dark.png), [light](../../artifacts/sotto-owl-night-sky/header-stable-sotto-light.png).

The macOS layout, at the [default 320-pixel sidebar](../../artifacts/sotto-owl-night-sky/header-owl-sotto-dark-mac-320.png) and the [narrowest](../../artifacts/sotto-owl-night-sky/header-owl-sotto-dark-mac-260.png). A Windows run cannot draw the traffic lights. The spec puts the sidebar's own macOS layout on the live sidebar, so the inset, the tile's place and the sky's are real; the window buttons are not. The tile measures 78 pixels in, as on a Mac.

Not seen directly: the sky on a Mac, and the twinkle over a full minute. The animations' timing and their dimming were measured, not watched.

Noticed, not changed: in the macOS layout at the narrowest sidebar, the Owl tile and the toolbar need 266 pixels and have 259, so Collapse sidebar is cut by the sidebar's edge ([capture](../../artifacts/sotto-owl-night-sky/header-owl-sotto-dark-mac-260.png)). That is the tile's width in the inset row, not the sky. Stable's 18-pixel mark is a pixel over too. The tile was out of scope here.

## Tests and gates

Unit: `tests/unit/renderer/owlSky.test.tsx` covers the sky on each track: present on Owl, absent on stable, decoration only, gone when the sidebar collapses. `tests/unit/renderer/themeTokens.test.ts` adds contrast on the band for every built-in theme in both modes, the night's hue, the wash never darker than the sidebar (a custom theme with a deep accent included), and the resolver's relative colours. The resolver in `tests/fixtures/renderer/themeTokenResolver.ts` now evaluates `oklch(from …)`. It reads a theme role exactly, carries a relative colour's own OKLab into `color-mix()`, and refuses a channel expression it cannot read. The branding spec stills the sky before its window captures. Its earlier evidence is unchanged, and the October 9 note now says those captures predate the sky.

Run on the Windows laptop in this order, after the last code change. Free physical memory was above 9 GB before each full run.

| Command | Result |
| --- | --- |
| `npm run typecheck` | Exit 0; all four TypeScript projects |
| `npm run lint` | Exit 0 |
| `npm test -- --maxWorkers=2` | Exit 0; 729 files passed, 56 skipped; 9,059 tests passed, 278 skipped; 1,031.13 seconds |
| `npm run notices:verify` | Exit 0; 182 components |
| `npm run build` | Exit 0 |
| `npm run design:verify` | Exit 1, from before this change: see below. No baseline regenerated |
| `npx playwright test tests/e2e/sotto-owl-night-sky.spec.ts` | 14 passed, published with `SOTTO_E2E_EVIDENCE=publish` |
| `npx playwright test` on `sotto-owl-branding`, `thread-sidebar-resize`, `thread-sidebar-question` and `terminal-loading` | 11 passed; `terminal-loading`'s workspace case failed, alone too, from before this change: see below |

The design gate fails on its six Help captures (`help`, `help-light` and `scale-100/125/150/200-help`). In each, the only changed pixels are the About line's version: the committed baselines read "Sotto 0.1.34", and this branch's `package.json` has read 0.1.35 since the 0.1.35 release merged into it. Help shows stable's sidebar, which has no sky. The gate stops each spec at its first mismatch, so I checked the rest this way. I gave those six baselines their version-only captures for one run, and every capture in all nine specs then matched. The manifest step failed only on those six files' digests. Then I put the six files and the manifest back byte for byte; `git status` shows `artifacts/design` unchanged. The Threads captures, stable's sidebar header included, pass against the committed baselines as they stand.

`terminal-loading.spec.ts`'s workspace case fails before its terminal opens. The agent state it reads has no thread with the id `workshop`. Its tools case passes. This change touches no agent state, scenario, fixture or main-process code, and that spec runs stable, which has no sky.

After `main` (with #920's design baselines, regenerated at 0.1.36) merged into this branch, both gaps closed on their own: `npm run design:verify` passed all nine specs, 144 deterministic captures, against the committed baselines with none regenerated, and `terminal-loading.spec.ts` passed both cases.
