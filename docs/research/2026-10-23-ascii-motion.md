# ASCII Motion for Watcher's owl and the room move

October 23, 2026. Research only; no product code changed. Read against `origin/main` at `322391955`.

## Answer

ASCII Motion is a free, open-source editor for ASCII art animations, run in a browser. It is a drawing tool, not a library. Sotto should not depend on it, and should copy no code from it until its licence is settled (see below).

Sotto already draws its owls as text. The thread owls are three-row text sprites in `owlFamily.ts`. So the useful part of ASCII Motion is the editor, used to design more owl poses and then played by Sotto's own painter. For the move between Threads and Watcher, it adds little: the shipped night falls is procedural and sized to the window, and authored frames would be large and would replace a look already picked (ADR-0119).

- **The owl scene: a fit as a design tool.** Draw more owl poses (mood variants, flap frames, a bigger perched Watcher owl) as glyph rows, and keep Sotto's painter and timing. This changes what the user sees, so it needs a prototype and a pick.
- **The threads to Watcher move: not a fit as a runtime.** Keep night falls as shipped. An authored front shape, drawn in the editor and scaled to the window, is worth one prototype.
- **Licence: unclear for the code.** The repository's `LICENSE-MIT` is MIT, but the README scopes MIT to `packages/core/`, and the editor's code sits in the root `src/`, which neither licence names. Treat the editor's code as off-limits until the author confirms.

## What ASCII Motion is

Sources are listed at the end. Checked by hand against the repository: the licence files, the README's licence section, the package layout, and the types in `src/types/`. Read only through a summary: the site pages, the docs site and the editor's tool list.

- **The app** is at https://ascii-motion.app/. The page is client-rendered, so a plain fetch returned only a loading message.
- **The repository** is `CameronFoxly/Ascii-Motion` on GitHub. Its default branch is `main`, it was last pushed on 2026-10-20, it is not archived, and it has 930 stars (GitHub API).
- **The author** writes in the README that the project is "currently maintained entirely by me, an animator and brand designer with next to no prior experience with building tools." One maintainer is the risk to weigh before depending on it at all.
- **The editor** keeps art as layers, each holding content frames, with keyframe tracks for position, scale, rotation and anchor. A keyframe has a cubic-bezier easing. Timing is in frames at a set frame rate, not milliseconds (`src/types/timeline.ts`: `frameRate`, `startFrame`, `durationFrames`, `easing`). A cell is `{ char, color, bgColor }` (`src/types/index.ts`), so every cell carries its own colour.
- **Export** has 13 format identifiers in `src/types/export.ts`: `png`, `svg`, `mp4`, `session`, `media`, `text`, `json`, `html`, `react`, `ink`, `opentui`, `bubbletea` and `ansi`. The README also lists JPEG and WebM, and GIF in its licence section; the code paths for those are not checked.
- **The stack** is React 19, Vite, TypeScript, Tailwind and Zustand, as the README's tech stack section says.

## The licence, in detail

- **`LICENSE-MIT`** at the repository root reads "MIT License, Copyright (c) 2025 ASCII Motion".
- **`LICENSE-PREMIUM`** is a proprietary licence that "applies ONLY to" `packages/premium/`, `packages/web/` and files marked `@license Proprietary`.
- **The README's licence section** (lines 129 to 146) says `packages/core/` is MIT and lists "Canvas editor, drawing tools, animation system" and "Export features" under it. It lists `packages/premium/`, `packages/web/marketing/` and `packages/web/docs-site/` as proprietary. It does not name the root `src/`.
- **The layout does not match the README.** `CanvasGrid.tsx`, `timeline.ts` and `exportRenderer.ts` are in the root `src/`. `packages/core/` holds shared UI components such as the shadcn-style ones.
- **The app pulls in a lot.** The root `package.json` lists 48 runtime dependencies, among them Stripe, Supabase, Vercel analytics, ffmpeg, and 17 Radix packages.

What this means: MIT is the licence the root file carries, and the proprietary notice does not reach `src/`. But the README draws the MIT line around `packages/core/`, so the status of the editor's code is ambiguous. Sotto should not copy or port that code until the author has said which licence covers it. Drawing art in the editor is a different question from copying its code. Nothing read here suggests the editor claims the art it is used to draw. Exporting the art as the editor's React component would be using its code, so ask the author first.

## Sotto today

### The owl scene

- **The maths** is in `src/renderer/src/watcher/nightScene.ts` (662 lines, pure). It holds the layout, the owl's pose, ripples, pacing and ink.
- **The painter** is `nightScenePainter.ts` (704 lines). Watcher's owl is drawn as vectors on an offscreen canvas (`drawOwl`), then turned into glyph cells by coverage. The landscape is rasterised once per window size.
- **The thread owls are text sprites written in code.** `PERCHED_OWL` is three rows (`{o,o}`, `/)__)`, and ` " " `), `FLYING_OWL` has three flap frames, and the rail uses `oo` (`owlFamily.ts` lines 308 to 312).
- **The owl's pose is continuous.** `OwlPose` (`nightScene.ts` lines 400 to 417) has turn, spread, flap, legs, bank and squash, and its gaze follows the last press. Authored frames would have to cover the poses that these values reach.
- **Pacing:** `MOVING_MS` is 33 ms while anything moves, `IDLE_CHECK_MS` is 125 ms while it only blinks and twinkles, and nothing is drawn when it holds still (`nightScene.ts` lines 542 to 554).
- **Ink:** `sceneInk` takes the theme's text and accent colours and boosts them by 1.9 and 1.5 on a light surface. The choice is made from luminance, not from a theme's name (`LIGHT_INK_BOOST`, `LIGHT_ACCENT_BOOST`).
- **Size:** the six night-scene and night-falls files total about 124 KB of source (`nightScene.ts` 35 KB, `nightScenePainter.ts` 41 KB, `WatcherNightScene.tsx` 32 KB, the rest small). That is source, not the bundle, which was not measured.

### The move between Threads and Watcher

- **Navigation.** `AppContext.tsx` (`navigate`, around lines 690 to 700) calls `playNightFalls` when the move is between Threads and Watcher, unless `roomTransition` is off or the `night-falls` or `watcher` Owl feature is not shipped.
- **The run.** `nightFalls.ts` (192 lines) uses the View Transitions API. A canvas band 90 px wide flickers through the ramp ` .:-=+*#%@` in 7 by 12 px cells, changing every 45 ms. The band sweeps across the window in 840 ms at speed 1. The new page is clipped along a ragged front by 36 keyframes, and the room's owl is a view-transition element that rides the band.
- **Reduced motion.** `nightFallsAvailable()` returns false when `prefersReducedMotion()` is true, and the page swaps in one frame.
- **Gating.** `night-falls` is an Owl feature with `sentToStable: false` (`src/shared/owlFeatures.ts`, line 34). Its settings are `roomTransition` and `roomTransitionSpeed`.

## Comparison

| | ASCII Motion | Sotto today |
| --- | --- | --- |
| Licence | MIT at the root, but the README scopes MIT to `packages/core/`. Premium is proprietary. | Sotto's own code. |
| Runtime | A full React and Vite app with 48 runtime dependencies. | Three production dependencies: `zod`, `node-pty`, `sherpa-onnx-node` (AGENTS.md). |
| Art data | Layers, content frames and keyframes in session JSON; a colour string per cell. | Owl art in code as text rows; the landscape computed per size. |
| Timing | Frames at a frame rate, with bezier easing. | Seconds from the scene's start; 33 ms moving, 125 ms still. |
| Rendering | Editor on canvas; exported React component on a 2D canvas with `fillText` and `fillRect`. | Two canvases; a glyph cache; an offscreen rasterised landscape. |
| Export | Thirteen identifiers including `text`, `ansi`, `react`, `svg`, `png`. | None; the art is code. |
| Themes | A fixed hex colour per cell. | Theme tokens (`--tt-*`), with ink strength from luminance. |
| Reduced motion | Not seen in the types. | `prefersReducedMotion()` skips the run; the scene holds still and draws nothing. |
| Translation | No words in the art. | Lingui, with 32 PO catalogs (30 languages plus two test pseudo-languages). |
| iPhone | No native port seen. | Watcher's owl is the `WatcherOwl` image asset. No scene, no transition. |

### (a) Making and editing the owl scene

Fits:

- **Drawing more poses.** The thread owls are three rows in TypeScript. A frame-based editor with onion skin would make a larger owl, or a set of mood variants, easier to draw than string arrays. The owl's pose is a bigger job than a flap sheet, so this is worth it only if the owl gets more art.
- **A data file, not a dependency.** The editor can export text or JSON. A small table of glyph rows, committed and checked by a unit test, adds no dependency.
- **The same painter.** Sotto's painter already draws glyph cells, with theme ink and reduced motion. Only the art changes.

Does not fit:

- **Continuous pose.** Watcher's owl is vector-drawn from continuous values (turn, spread, flap, legs, bank). Authored frames cover only the poses drawn, so the owl would move in steps unless it is sampled across the values.
- **Size.** The landscape is computed to fit every window, so authored landscape art would have to be drawn per size.
- **Colour.** The editor stores a hex colour per cell. Sotto's art must follow the theme's tokens and the luminance rule, so an export keeps only the characters and the density, not the colours.
- **Still frames.** The still pose is `owlAt` with `still` set. Any sprite set would name its still frame.

### (b) The threads to Watcher move

Does not fit as a runtime:

- **Size per window.** At 1600 by 1000 the band's grid is 229 columns by 84 rows (7 px and 12 px cells). A run has 19 flicker steps (840 ms at 45 ms). Stored as full-window frames, that is 229 × 84 × 19, about 365,000 cells per run, and it would have to be redone for every window size. The procedural band is a hash and a ramp.
- **A decision already made.** ADR-0119 picked night falls, variant 9 of 10 in `docs/prototypes/watcher-room-transition-prototype.html`. Replacing its look would amend the ADR.

What could fit: the band's front edge taken from a keyframed glyph silhouette, scaled to the window. That keeps the data to a few shapes, but changes the look, so it needs a prototype and a pick.

## Other fits and limits

- **Bundle size.** Not measured for either. ASCII Motion's app is far too large to take in: it pulls Stripe, Supabase, ffmpeg and 17 Radix packages, and AGENTS.md allows three production dependencies. A table of sprite rows adds bytes, not a dependency.
- **Performance in Electron.** Not profiled. Sotto's scene already draws glyph cells on a canvas, the method the exported React component uses. Nothing in the source suggests a cost Sotto does not already have.
- **The iPhone client.** It shows Watcher's owl as an image asset (`WatcherOwlMark` in `apps/ios/Sotto/ProviderMarks.swift`, lines 27 to 33). Android has no owl art in its sources. The scene and the transition are desktop-only today. Authored glyph art would not change that; an iPhone scene would need its own renderer and its own decision.
- **Reduced motion.** The transition is skipped and the scene holds still. Any sprite system must keep both paths.
- **Light and dark.** Handled by luminance and tokens. An export must not bake in the editor's fixed colours.
- **Translation.** The art has no words, and the canvases are `aria-hidden`. Any new visible text, such as an owl's accessible name or a settings label, goes through `msg` and the Lingui catalogs. Sotto uses Lingui: `lingui.config.ts`, `@lingui/core/macro` in `src/renderer/src/features/settings/settingsPages.ts`, and 32 PO files in `src/locales/features/`, under ADR-0123. An editor adds no text to translate.

## What to do next

No change follows from this note by itself.

1. If the owl direction is picked, the next step is a prototype of the owl's poses in the scene, then a plan. The art is ours to draw; if the editor's exported code is used, the licence question comes first.
2. If the transition direction is picked, it needs an ADR amendment to ADR-0119 before any code.
3. If neither is picked, the editor can still serve as a sketch tool for prototypes. That changes nothing in the product and needs no decision.

## Sources

ASCII Motion (read on 2026-10-23):

- https://ascii-motion.app/ (client-rendered; only the loading message was readable)
- https://ascii-motion.com/ (landing page, read through a summary)
- https://docs.ascii-motion.com/ (documentation, read through a summary; the site says it is "in active development")
- https://github.com/CameronFoxly/Ascii-Motion (repository; GitHub API: licence `MIT`, pushed 2026-10-20, 930 stars, not archived)
- https://github.com/CameronFoxly/Ascii-Motion/blob/main/LICENSE-MIT
- https://github.com/CameronFoxly/Ascii-Motion/blob/main/LICENSE-PREMIUM
- https://github.com/CameronFoxly/Ascii-Motion/blob/main/README.md (licence section, lines 129 to 146)
- https://github.com/CameronFoxly/Ascii-Motion/blob/main/src/types/index.ts (the `Cell` type)
- https://github.com/CameronFoxly/Ascii-Motion/blob/main/src/types/timeline.ts (frames, keyframes, easing, frame rate)
- https://github.com/CameronFoxly/Ascii-Motion/blob/main/src/types/export.ts (export identifiers)
- https://github.com/CameronFoxly/Ascii-Motion/blob/main/src/utils/exportRenderer.ts (exporter imports; its React component output was not read line by line)
- https://github.com/CameronFoxly/Ascii-Motion/blob/main/src/components/features/CanvasGrid.tsx (editor canvas location)
- https://github.com/CameronFoxly/Ascii-Motion/blob/main/package.json (48 runtime dependencies)
- https://github.com/CameronFoxly/Ascii-Motion/blob/main/packages/core/package.json (shared UI components)

Other things called ASCII Motion or close to it (found by search and summaries; not checked against source):

- Framer "ASCII Motion" component: https://www.framer.com/marketplace/components/ascii-motion/
- Framer "AsciiMotion" plugin: https://www.framer.com/marketplace/plugins/asciimotion
- After Effects "ASCIIMotionTemplate": https://s1lax.gumroad.com/l/ASCIIMotionTemplate
- AsciiAnimator (Java, MIT, last pushed 2020): https://github.com/thatcherclough/AsciiAnimator
- Aewan (curses-based ASCII animation editor for Linux terminals): https://download.salixos.org/x86_64/extra-15.0/source/graphics/aewan/README
- `ascii-motion-mcp` npm package, a development aid for the editor: https://www.npmjs.com/package/ascii-motion-mcp

Sotto (this repository, `origin/main` at `322391955`):

- `src/renderer/src/watcher/nightScene.ts`, `nightScenePainter.ts`, `WatcherNightScene.tsx`, `nightScene.css`
- `src/renderer/src/watcher/owlFamily.ts` (thread owl sprites, lines 308 to 312)
- `src/renderer/src/watcher/nightFalls.ts`, `src/renderer/src/state/AppContext.tsx` (`navigate`)
- `src/renderer/src/features/settings/NightFallsSettings.tsx`, `settingsPages.ts`
- `src/shared/owlFeatures.ts` (`night-falls`)
- `apps/ios/Sotto/ProviderMarks.swift` (`WatcherOwlMark`)
- `lingui.config.ts`, `src/locales/features/*.po`
- `docs/adr/0018`, `0072`, `0119`, `0123`; `docs/plans/watcher-night-scene.md`; `docs/verification/2026-10-21-watcher-night-scene.md`
