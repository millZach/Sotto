# Watcher's header at the minimum window

The title could shrink to its `3em` floor and show an ellipsis. The narrow grid also placed the newer Teams tabs into columns that had been sized for the older header. The old breakpoints underestimated the room switch, page links and update control. At 400 pixels this squeezed All threads on macOS and put Windows navigation over Stop all and outside the pane.

The replacement uses three container queries. Stop all loses its words and gaps tighten at 1000 pixels. Below 800, All threads keeps its icon and count; the title stays unless the Watcher tab already supplies the name. Below 650, navigation and Stop all take a second row. The heading remains available to assistive technology. Names, handlers, keyboard order and drag exclusions are unchanged.

| At 820×560 | Title | All threads | Stop all, when present |
| --- | --- | --- | --- |
| Full pane, Teams on or off | Whole | Whole words and count | Icon |
| 400px beside pane, Teams on | Hidden whole; Watcher tab remains | Icon and count | Icon on row two |
| 400px beside pane, Teams off | Whole | Icon and count | Icon on row two |

## Measurements

Before is `120ca77d0`. Both versions used the real renderer bundle, fonts and compiled catalogs with a scratch preload bridge and the cached headless Chromium shell. The bridge supplied a running Watcher room, both platforms, Teams on/off, Stop all on/off, counts 8/643, light/dark and English/`en-XA`. A real All threads press opened a real thread beside Watcher. Sotto and its Electron window were never launched.

The scratch script copied `pageBoundProblems` and the header reading from the e2e spec, keeping their tolerances and adding the Teams buttons. Widths below are client width / scroll width.

| Measurement | Before | After |
| --- | --- | --- |
| Full macOS 820, Teams, Stop all, 643: title | 45 / 56px | 56 / 56px |
| macOS 400, same state: All threads | 17 / 39px | 73 / 73px |
| Full 820: cases with header clipping/overlap/outside bounds | 16 / 64 | 0 / 64 |
| Beside at 820: cases with header problems | 24 / 64 | 0 / 64 |
| 400px panes at 1280 and 1600: cases with header problems | 8 / 16 | 0 / 16 |
| `pageBoundProblems` failures across all 160 readings | 12 | 0 |

The 16 full-width readings at 1280×800 and 1600×1000 have identical header/control rectangles and text widths before and after. These cover both platforms, both Teams states, both appearances, Stop all and 643 threads. The extra sweep checks 47 pane widths from 400 through 820, including both sides of 650 and 800, with macOS, Windows and Linux bridges, Teams on/off, Stop all on/off, `en-XA` and 643 threads: 564 readings with no header or page-bound problems. All renders used reduced motion.

## Frames

Each matrix has macOS full/beside, then Windows full/beside across its columns. Rows cover every Teams, Stop all and count combination.

| Appearance and language | Before | After |
| --- | --- | --- |
| Dark, English | [Frame](../../artifacts/watcher-header-820/before-dark-en.png) | [Frame](../../artifacts/watcher-header-820/after-dark-en.png) |
| Dark, en-XA | [Frame](../../artifacts/watcher-header-820/before-dark-en-XA.png) | [Frame](../../artifacts/watcher-header-820/after-dark-en-XA.png) |
| Light, English | [Frame](../../artifacts/watcher-header-820/before-light-en.png) | [Frame](../../artifacts/watcher-header-820/after-light-en.png) |
| Light, en-XA | [Frame](../../artifacts/watcher-header-820/before-light-en-XA.png) | [Frame](../../artifacts/watcher-header-820/after-light-en-XA.png) |

Full-window macOS frames with Teams, Stop all and 643 threads: full pane [before](../../artifacts/watcher-header-820/before-mac-full-820.png) / [after](../../artifacts/watcher-header-820/after-mac-full-820.png); beside pane [before](../../artifacts/watcher-header-820/before-mac-beside-820.png) / [after](../../artifacts/watcher-header-820/after-mac-beside-820.png). [Wider headers](../../artifacts/watcher-header-820/wide-headers.png) pairs all 16 full-width comparisons.

## Checks and limits

`npm ci --ignore-scripts`, `npm run build`, `npm run typecheck` and `npm run lint` passed. Each unit file ran separately: `tests/unit/renderer/themeTokens.test.ts` (113), `scaleTokens.test.ts` (4) and `watcherView.test.tsx` (65), all passed. No interface string or token changed.

The e2e steps now expect two rows below 650 and the heading only where it is visible. They also measure Teams buttons. Their overlap, clipping and pane-bound assertions were retained. No e2e spec, full unit suite or design gate ran. The original reported assertions at lines 584, 758–762, 913/942, 1506 and 2019–2130 are expected to clear for this header; native Electron execution remains unproved. No requested width or state remains unfixed in the headless measurements. The renderer check does not prove native traffic-light hit areas or provider behavior.
