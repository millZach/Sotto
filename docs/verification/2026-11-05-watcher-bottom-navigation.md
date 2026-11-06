# Watcher navigation at the bottom left

Watcher now renders `SidebarFoot`, the component used by Threads. Its width follows the saved Threads sidebar width, including the one-pixel inset occupied by the sidebar border. The room switch, page links and update control keep their order, size, spacing, tooltips, shortcuts and keyboard handling. The expanded footer occupies its own row below both panes, including when Memory makes the update control wrap. Collapsed, Watcher reuses `SidebarRail` as well: the 80px macOS or 52px Windows/Linux rail sits beside both panes, its vertical footer matches Threads, and Expand sidebar restores the saved width and focuses Watcher. The macOS rail itself reserves the traffic lights, so the room does not reserve that space twice.

All threads and its count stay in the header because they open the room's list. Stop all and the Watcher/Teams tabs also stay there. The header is 44px high at every checked width. Stop all keeps its words above 650px; All threads keeps its words from 600px. Below 600px, the Watcher tab carries the name when Teams is on; without Teams the heading stays visible. The heading cannot shrink to an ellipsis and All threads cannot wrap.

## Headless checks

A scratch Vite page rendered the real Watcher and Threads components, styles, fonts and compiled interface catalogs with fixture app/agent contexts and a local bridge. Chromium ran headlessly; no Sotto/Electron window was launched. Before frames use `2cb2deb52`, the branch's starting `origin/main`. Fixtures include 672 other threads, a running Watcher, Stop all and a real thread beside Watcher. The macOS frames reserve the native traffic-light area but do not draw native controls.

- 72 layouts: Windows, macOS and Linux; 820×560, 1280×800 and 1600×1000; light/dark; full/beside; Teams on/off. Every header control was checked for clipping, overlap and pane bounds. Both panes and composers remain above the footer. Each footer button's rectangle exactly matched Threads after switching through the real room switch. No failures or page errors.
- 240 boundary readings: 400, 500, 599, 600, 601, 649, 650, 651, 700 and 800px panes; three platforms; English and expanded `en-XA`; Teams on/off; Stop all on/off. Memory was enabled and the sidebar resized to 400px. No header clipping, overlap, pane-bound or footer-placement failures. The resized footer also matched Threads exactly.
- At 820×560 with Memory on and the default 260px sidebar width, the update button wraps onto a second line in both rooms with identical button rectangles.
- 72 collapsed layouts matched every visible footer control rectangle against Threads and restored the saved width/focus on expansion. A further 24 checks at 820×560 covered both themes, all three platforms, full/beside and Memory on/off after removing the duplicate macOS traffic-light inset; no clipping, header overlap, footer overlap or page errors.
- Visually inspected the collapsed macOS/Windows beside layouts at 820×560, plus the 820px Windows/macOS full and beside layouts in light/dark, and the 1280px and 1600px light layouts. Reduced motion was enabled throughout.
- After integrating PR #2249, repeated 24 expanded and 24 collapsed layouts at 820×560 across all three platforms and both themes. Every expanded header stayed 44px; footer rectangles still matched Threads, with no clipping, overlap or page errors. Rechecked the macOS/Windows renders visually; typecheck and lint passed again.

## Frames

| Layout | Before | After |
| --- | --- | --- |
| macOS, 820×560, full | [Before](../../artifacts/watcher-bottom-navigation/before-mac-820.png) | [After](../../artifacts/watcher-bottom-navigation/after-mac-820.png) |
| Windows, 820×560, beside | [Before](../../artifacts/watcher-bottom-navigation/before-windows-beside-820.png) | [After](../../artifacts/watcher-bottom-navigation/after-windows-beside-820.png) |
| Collapsed, 820×560, beside | — | [macOS](../../artifacts/watcher-bottom-navigation/collapsed-mac-820.png), [Windows](../../artifacts/watcher-bottom-navigation/collapsed-windows-820.png) |
| macOS, light, beside | — | [1280×800](../../artifacts/watcher-bottom-navigation/after-mac-beside-1280-light.png), [1600×1000](../../artifacts/watcher-bottom-navigation/after-mac-beside-1600-light.png) |

## Code checks and limits

`npm run typecheck` and `npm run lint` passed. `NODE_OPTIONS=--no-experimental-webstorage ./node_modules/.bin/vitest run tests/unit/renderer/watcherView.test.tsx` passed all 68 tests. The Node option avoids Node 26's incomplete native localStorage in this test environment; the first run without it failed during setup.

The e2e steps retain header clipping, overlap, Teams and focus assertions, update navigation selectors to the footer, and compare footer rectangles against Threads in both expanded and collapsed layouts. The collapsed regression also opens a beside pane at all three window sizes and checks expansion and focus. They now expect the footer after the conversation/composer in Tab order and a one-row header. No e2e, full test suite, design capture/verify or native app launch ran locally. GitHub CI provides the native desktop checks.

ADR-0152 is amended because its previous decision placed these controls after All threads. ADR-0158's keyboard behavior is unchanged. PR #2249 was integrated from `origin/main` at `493a8e1a0`. Its whole-title, no-wrap and Teams clipping protections are retained; its navigation-driven second row and 800/1000px label thresholds are superseded by the one-row rules above. Both header-height assertions expect 44px, and `NAME_FROM` and `CAPTURE_100` remain 600px.
