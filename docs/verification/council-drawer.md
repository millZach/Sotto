# The Council in a thread pane's drawer

November 3, 2026. ADR-0177 (amended), ADR-0182 (amended).

## What was exercised

The renderer as `npm run build` bundles it, in a headless Chromium (Playwright's cached headless shell 1248), served from `out/renderer`. Main did not run: `window.sotto` was a stub bridge with `threadsStateFixture()` threads, the `council` and `watcher` Owl features on, a Council bridge (no Councils, an estimate of 12 messages and 3,000 words), and a terminal bridge listing two running drawer shells. Sotto itself was not launched, by the owner's rule for this Mac. So the pane, header, drawer, tabs, divider, Council form and chamber are the real components and stylesheets. The shells' output, Councils running in main and the Electron window chrome are not.

Pressed through the page with real pointer events: the header's **Council** button, a shell's tab, the **Council** tab, the divider (dragged up 180px and down to its minimum, then double-clicked), the header button again to hide it, and **Ask the Council** under a finished reply.

## What it showed

| Window | Pane height | Drawer at default | Seats bar width | Drawer width |
| --- | --- | --- | --- | --- |
| 1600 × 1000 | 1000 | 500 (50%) | 1320 | 1320 |
| 1280 × 800 | 800 | 400 (50%) | 1000 | 1000 |
| 820 × 560 | 560 | 240 (43%: the conversation keeps its 320px) | 560 | 560 |

- With the Council off, as on stable, the header is unchanged: Watch, Tools, Terminal drawer, ··· (`header-council-off.png`).
- The Council button sits right after Watch and before Tools, a 30px `pane-action` with lucide's landmark at 16px, as Tools and the Terminal drawer are. Pressed, it wears the same tint they do (`header-council-open.png`, `header-council-open-light.png`).
- Opening it gives `Council*` selected before `zsh 1` and `zsh 2` on one bar. The Council button is pressed and the Terminal drawer button is not. A shell's tab gives the shells at a third of the pane (333px) with the Terminal drawer button pressed. The Council tab brings the Council back at 500px.
- Dragged taller, the drawer measured 680px. At its 240px minimum the Council became one column that scrolls: the figures at 120px, the seats, then the form. Double-clicking the divider went back to 500px, and the header button hid the drawer.
- **Ask the Council** under the reply opened the drawer on the Council with `From: Grok voice previews` and the question `> Done. The preview plays…` filled in (`reply-press-opens-council.png`).
- No element in the drawer was wider than its box at any size, and the page never scrolled. At 1600 × 1000 and 1280 × 800, **Ask the Council** shows without scrolling the form's column.

## Found on main

`src/renderer/src/agents/CouncilPress.tsx` (from #2111) used JSX without importing React. The renderer bundle compiles JSX to `React.createElement`, so the first finished reply that drew **Ask the Council** threw `React is not defined` and blanked the Threads page. The unit tests use the classic runtime, and none of them rendered the press. This change imports React there.

Screenshots and measurements: `artifacts/council-drawer/`.
