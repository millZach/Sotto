# Phase 3 #54: multi-pane thread layouts

Verified on Windows 11, September 13, 2026, on `work/phase3-layout` from baseline `bf500b4`. The production Electron build ran through `tests/e2e/support/sottoLaunch.ts` with the `design-threads` fixture providers and owned temporary E2E profiles. No native provider turns were used, and no user profile was opened.

Scope is the renderer only: `splitLayout.ts` (model, persistence, store), `ThreadPanes.tsx` (placement, dividers, drag targets, tabs, zoom, pane controls), `splitWorkspace.css`, and the layout wiring in `ThreadsView.tsx`. No main, preload, IPC, shared schema or dependency changed. The cross-worker contract is `.worktrees/phase3-orchestration/layout-contract.md`.

## What a user can do

- **Snapping.** One thread fills the workspace. A second opens beside it. A third spans the row below the first two, and a fourth completes a 2×2 grid. More panes keep snapping with `ceil(√n)` columns (5 → 3+2, 7 → 3+3+1), and there is no cap.
- **Opening.** Sidebar **Open beside**, Ctrl+Enter on a sidebar row, and dragging a thread onto the workspace all add a pane in the next slot. While a thread is dragged, the workspace previews the new arrangement: each box names the thread it keeps, **Add here** marks the new slot, and **Show here** replaces a pane. Panes may come from any project.
- **Pane controls.** Each pane's header carries its controls at the top right:
  - **Single row** toggle, on the focused pane when three or more panes are placed
  - **Move** grip: drag it onto another pane (**Move here**), or focus it and use the arrow keys to swap with the neighbouring pane
  - **Zoom** / **Show all panes**, also Ctrl+Shift+M
  - **Close**
  Closing removes only the view, and the thread keeps running in the sidebar.
- **Dividers.** Every column and row boundary is a `separator` with its current, minimum and maximum values. It resizes by pointer, snapping to an even boundary within 12px, or by keyboard: arrows move it 5%, Home and End jump to the limits, and Enter or a double-click evens it. A pane never goes below 400×300 px. Grid and single-row arrangements keep separate sizes, so switching back restores the previous sizes. A drag moves the boxes directly and commits once, on release or when pointer capture is taken away.
- **Compact and zoom.** When the area cannot give every pane 400×300, one pane shows at a time with tabs (arrow keys, Home and End). The other panes stay mounted but `inert`, so drafts, scroll position and live state are kept, and the arrangement returns when there is room. Zoom is the same presentation chosen on purpose.
- **Short panes.** A pane under 600px tall composes like a short window: the title and crumb share a row, the composer rests smaller and keeps its actions, and the transcript gives way. In a multi-row grid, unfocused panes rest their composer at one line and keep only warning statuses. Focusing a pane restores its composer.
- **Persistence.** The arrangement, pane threads and order, both sets of sizes, zoom, and the focused pane are saved in validated renderer storage (`sotto.threadWorkspace.layout`, version 1). They come back after a restart. Restoring sends no select, create, send, or assign command. A saved pane whose thread is not yet available is hidden, not forgotten.
- **Page order.** Each pane's layout controls come first, then its header, transcript and composer. Each divider follows the pane before it, so Tab and Shift+Tab run pane, divider, pane, row by row. F6 cycles panes. A polite live region announces moves, arrangement changes and zoom.

## Electron journeys

`tests/e2e/pane-layouts.spec.ts` covers one journey on the real app, about 20 seconds long:

1. **Three panes at 1600×1000.** Grok voice previews (workshop), Footer links (sotto-site) and Weekly note (notes) are opened from the sidebar. The geometry is checked: two on top, and the third spans them. A draft is typed in each pane.
2. **Single row.** The focused pane's **Single row** control switches to one row of equal widths, and Enter on the control returns to the grid.
3. **Fourth pane.** Visual gate flake, with its pending permission request, forms a 2×2 grid. That request stays visible through every later move.
4. **Dividers.**
   - The top column divider is dragged by pointer past 60%, then dropped 8px from the middle and snaps to 50.
   - The row divider is dragged by pointer, evened with Enter, and moved to 60 with two ArrowDown presses.
5. **Fifth pane by drag.** Streaming WAV stall is dragged from the sidebar onto the previewed **Add here** slot, giving three on top and two below with every pane at least 400px wide. Drafts are unchanged.
6. **Five in a row.** This cannot fit at 1600, so it shows tabs. ArrowLeft changes the tab, and two panes are closed from the tab view. Three then fit in a row. The closed Visual gate flake is still running and listed in the sidebar. Returning to the grid and reopening it brings the rows back at 60.
7. **Moves.** The Move grip is used with ArrowRight and then ArrowDown, and focus stays on the grip with the draft intact. A real pointer drag of another pane's grip onto a pane (**Move here**) swaps them.
8. **Zoom.** Ctrl+Shift+M from a composer zooms that pane, keeping focus and the draft. **Show all panes** returns the same order and sizes.
9. **1280×800.** The 2×2 grid holds with every pane at least 400×300. Opening Files leaves too little width, so tabs appear. Closing Files restores the grid.
10. **820×560.** Tabs with a readable composer, and Home and End between tabs.
11. **1600×560.** Four panes show tabs. Closing down to two restores the side-by-side split, and reopening two more shows tabs again.
12. **Reduced motion.** With the setting on, divider transitions resolve to the app's reduced-motion duration.
13. **Restart.** Before closing, the rows divider is set to 45 and the top column divider to 40, and a draft is typed. The same profile is relaunched: pane order, every divider value, the focused pane and both drafts return. There are no assignments, and user message counts are unchanged.

The existing specs pass against the new layout:
- `tests/e2e/split-workspace.spec.ts` (two panes, keyboard resize, narrow focus, close, 125% scaling)
- `tests/e2e/files-panel-split.spec.ts`
- `tests/e2e/composer-short-window.spec.ts` (Shift+Tab from the divider into the previous pane)
- `tests/e2e/thread-workspace.spec.ts`

The refreshed `artifacts/crossing/split-*` captures show the pane controls. `artifacts/phase-two-tools-fixed/*` and `artifacts/crossing/thread-workspace-*` were re-rendered and inspected, but they are not committed here. The tools and UI workers own those surfaces, and regenerating them at integration avoids binary conflicts.

### Captures

Captures are in `artifacts/phase-three-layout/`, in dark and light unless noted. Each was inspected as an image.

| Capture | What it shows |
| --- | --- |
| `three-1600` | Snapped third pane across the row below |
| `three-row-1600` | Single row, pressed toggle on the focused pane |
| `four-1600`, `four-row-divider-focus-dark` | 2×2 grid, keyboard focus bar on the row divider |
| `five-drop-preview-dark` | Next-arrangement preview naming each kept thread, **Add here** filled |
| `five-1600` | Three over two |
| `five-row-compact-1600` | Row too wide for the area, tabs |
| `four-move-preview-dark` | Pane grip drag, **Move here** on the target pane |
| `four-zoomed-1600` | Zoomed pane, **Show all panes** beside Close |
| `four-1280x800`, `four-1280x800-files` | Laptop grid with one-line unfocused composers; Files open, tabs |
| `four-820x560` | Minimum window |
| `two-1600x560` | Short window, side by side |
| `four-restored-1600` | After restart |

## Defects found by rendering and fixed

- **Grip drag.** A pointer drag of a pane grip was cancelled immediately, with `dragstart` followed at once by `dragend`. The move targets mounted over the grip during `dragstart`, and Chromium cancels a drag whose source is covered as it starts. The targets now appear on the next task. A unit test asserts that they are absent synchronously.
- **Stuck divider drag.** A divider could lose pointer capture mid-drag in Electron and stay stuck in `data-dragging`. Losing capture now ends the drag and keeps the size reached.
- **Clipped composers.** In a 2×2 grid at 1280×800 (panes about 343px tall), composers overflowed the pane bottom and send buttons were clipped. Short-pane composition and one-line unfocused composers fixed this, and all four composers now keep their actions.
- **Truncated titles.** Narrow split panes reserved the layout controls' width twice: a wide-pane `:has()` rule out-specified the narrow override. Titles such as "Footer links" were truncated. The rule is fixed, and the title keeps priority over its crumb.
- **Wrapping actions.** A short pane wider than 720px wrapped its header actions around the title. Short panes up to 1000px wide now stack their header.
- **Ghosting preview.** The add preview drew the new geometry over the old panes at 82% opacity, and the two layers read as one. It now uses a solid surface and names the thread each box keeps.
- **Tab order.** Controls rendered after pane content, and every divider after every pane, so Shift+Tab from a divider skipped into the wrong pane. The existing short-window spec caught it. The page order now follows placement, with a unit assertion.

## Tastify checks (Windows Electron desktop)

- **Concept and composition.** The work stays dominant: panes are the transcripts themselves, with no cards around them. Layout controls are 32×34 icon buttons in the header, beside the title they act on. No new text is visible at rest, and drag targets appear only while dragging.
- **Copy.** New visible copy is limited to operating labels: Single row, Move here, Add here, Show here, Show all panes, and tab names. Tooltips name each shortcut. There are no explanatory paragraphs.
- **Type and colour.** Existing Crossing sizes are kept: 18px titles, 14px controls and tabs, 12–13px secondary text. The focused pane keeps the accent top line. Dividers use the hairline token, the accent on hover or drag, and the focus-ring colour on keyboard focus. Checked in light and dark at 1.5 device scale, and the 125% zoom capture in the split spec still passes.
- **Motion.** Only the existing 160ms divider and drop-target colour transitions. Both the media query and the in-app reduced-motion setting remove them.
- **Small windows.** At 820 wide, and at 1280×800 with Files open, one pane shows with tabs instead of squeezing composers. At 1280×800 without Files, four panes fit, with unfocused composers at one line.
- **Reference.** T3 Code's schema-validated local sizing persistence is the model for storage. Its sidebar and terminal drawer resize handles informed the separator semantics.

## Tests

- **Unit.**
  - `tests/unit/renderer/splitLayout.test.tsx`: 12 model and persistence tests covering snapping, size retention, divider ranges and snapping, `fitsArea`, round trip, and hostile storage.
  - `tests/unit/renderer/splitWorkspace.test.tsx`: 24 tests, the Phase 2 two-pane journeys plus multi-pane snapping, row mode, row resize, zoom, short compact, keyboard move, drag preview, grip drag start, lost capture, page order, grid close, restart without commands, and a missing saved thread.
  - The renderer unit folder passes 862/862. One full-folder run failed `threadQueueSkills` "queues with Enter while a turn runs". It passed alone and on the next full run. It does not touch layout code.
- **Electron.** The five specs above pass on the production build.
- **Static.** `npm run typecheck` passes, and eslint is clean on the touched source and tests.

## Limitations

- **Crash timing.** Layout is saved in renderer storage on each committed change. A process crash within Chromium's storage flush window can lose the last change, although a normal quit does not.
- **Order after a move.** Page and tab order follow the new placement, so a keyboard user who moves a pane finds it in its new reading position.
- **Wide tab lists.** At the minimum window with many panes, tabs scroll horizontally, and the last tab can sit partly out of view until scrolled or reached by keyboard.
- **Short-pane dependency.** Short-pane composition assumes the current composer structure (`.thread-prompt` and `.agent-composer`). New request or tool surfaces inside panes should follow the contract note so they fit.
- **Personal chat.** Personal chat is not a pane and is outside this layout.
