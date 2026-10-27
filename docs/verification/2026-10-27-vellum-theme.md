# Vellum, the warm built-in theme held to 7:1

October 27, 2026, on an Apple silicon Mac, from branch `feat/vellum-theme` ([ADR-0154](../adr/0154-vellum-is-a-warm-built-in-theme-held-to-7-to-1.md)). The app was not launched for this note, at Drake's request: the measurements come from the token resolver the theme tests use, and the look from a prototype page that paints with the real `tokens.css`. The design capture baselines for `theme-vellum` have not been taken yet.

## How it was measured

`tests/fixtures/renderer/themeTokenResolver.ts` resolves every `--tt-*` token from Vellum's roles the way Chromium paints them, the Contrast setting's mixes included, and composites translucent tokens over the room. Each row below is the lowest ratio of that ink over every surface the window puts it on (for body text: the room, the surface, the raised and overlay surfaces, the field, the card, the selected card, the selected row and the hover wash). The theme tests hold Vellum, like every built-in, to every text pair in `tests/fixtures/renderer/paintedTextPairs.ts` at 4.5:1, and `themeTokens.test.ts`, `themes.test.ts`, `iosPalettes.test.ts` and `omarchyThemes.test.ts` pass with it.

| Pair (lowest over the surfaces it sits on) | Target | Day 100% | Night 100% | Day 150% | Night 150% |
|---|---|---|---|---|---|
| Body text | 7:1 | 10.46 | 8.99 | 13.36 | 10.20 |
| Sidebar text | 7:1 | 10.46 | 8.99 | 13.36 | 10.20 |
| Your message | 7:1 | 12.07 | 10.91 | 15.42 | 12.37 |
| Code | 7:1 | 13.05 | 13.22 | 16.67 | 15.42 |
| Composer filled button (pill ink on pill) | 7:1 | 13.89 | 13.30 | 17.74 | 15.08 |
| Primary action label | 7:1 | 8.09 | 9.10 | 8.09 | 9.10 |
| Label on the accent | 7:1 | 8.09 | 9.10 | 8.09 | 9.10 |
| Secondary text (text-2) | 4.5:1 | 7.95 | 7.18 | 12.73 | 9.22 |
| Muted text | 4.5:1 | 6.00 | 5.75 | 11.92 | 8.31 |
| Sidebar muted text | 4.5:1 | 6.73 | 7.44 | 14.48 | 11.19 |
| Placeholder and ghost buttons | 4.5:1 | 5.82 | 6.16 | 13.72 | 10.14 |
| Links and accent text | 4.5:1 | 6.42 | 6.64 | 12.14 | 8.87 |
| Warning (Watcher needs you) | 4.5:1 | 6.04 | 8.51 | 13.55 | 11.02 |
| Error text | 4.5:1 | 6.27 | 7.13 | 14.03 | 10.77 |
| Control boundary (icon-only buttons) | 3:1 | 4.50 | 5.25 | 5.14 | 5.91 |
| Focus ring | 3:1 | 5.64 | 9.22 | 5.64 | 9.22 |
| Live activity mark | 3:1 | 7.86 | 8.93 | 14.86 | 11.94 |
| Finished mark | 3:1 | 5.94 | 8.88 | 5.94 | 8.88 |
| Selected row against the sidebar | – | 1.25 | 1.40 | 1.25 | 1.40 |
| Card against the room | – | 1.09 | 1.10 | 1.09 | 1.10 |
| Sidebar against the room | – | 1.06 | 1.06 | 1.06 | 1.06 |
| Hairline against the room | – | 1.31 | 1.35 | 1.64 | 1.89 |

For comparison, Sotto's own default holds body text at 12.38:1 by day and 10.43:1 by night and muted text at 5.28:1 and 5.07:1, and its control boundary is 3.76:1 by day. Vellum keeps body text above 7:1 with a lighter night room (`oklch(0.225 0.008 70)` against Sotto's `oklch(0.115 0.008 265)`) and lifts every secondary tier.

## The prototype

`docs/prototypes/vellum-theme-prototype.html` (tag `prototype/vellum-theme`) links `src/renderer/src/styles/tokens.css` and sets Vellum's `--theme-*` roles, generated from `palettes.ts`, on each window as a `[data-theme-scope]` element, so `tokens.css` derives every token exactly as the app does. Its own rules read only `--tt-*` tokens. It draws three windows in each half: a thread with a message, code, a tool line, a question card, the working words, the scrubber's ticks and the composer while a turn runs with nothing typed (Steer, and Stop filled with its light); Watcher's room with a needs-you card, a refused-send notice and the composer with something typed (Steer, Stop stepped back, Queue filled); and Settings › Appearance with the theme tiles, the Contrast slider, a select and switches. Below 600px of pane the keyed buttons show only their keys, as ADR-0153 says. It was captured with headless Playwright 1.64.1 at 1280x800 and 820x560, served from the repository root.

Every capture was looked at. In both halves the room, sidebar, cards and composer read as one surface with hairlines between them; the selected row, the focus ring on New thread and the filled button are the first things the eye finds; amber appears only where it means something (Watcher's needs-you mark and the warning, and the Ember effort word), and the ink-blue accent is the only cool colour.

## Captures

In `artifacts/vellum-theme/`:

- `threads-dark-1280x800.png` and `threads-light-1280x800.png`: a thread, its question card and the composer while a turn runs.
- `threads-dark-820x560.png` and `threads-light-820x560.png`: the same at the minimum window, with the composer's keys alone.
- `watcher-dark-1280x800.png` and `watcher-light-820x560.png`: Watcher's room with a needs-you card and something typed.
- `settings-light-1280x800.png` and `settings-dark-820x560.png`: Settings › Appearance with Vellum chosen among the seven tiles.
- `threads-dark-1280x800-contrast-150.png` and `threads-light-1280x800-contrast-150.png`: the thread at 150% Contrast.

## Not checked here

- The built app, the design captures and the Playwright specs: they run on GitHub or on the Windows capture machine, not on this Mac.
- The iPhone: its palettes are regenerated and `iosPalettes.test.ts` holds the derived text at 4.6:1, but the simulator journeys were not run.
