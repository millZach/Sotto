# Phase 3 themes

Scope: branch `work/phase3-themes`. The main window's Accent chooser is replaced with T3 Code's Themes capability, from reference pin `d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3` (MIT, T3 Tools Inc.). Decision record: ADR-0011. Open VSX hardening is recorded separately in `phase-3-themes-network.md`. Target: Windows desktop Electron, pointer and keyboard. Phone layouts are out of scope.

## Acceptance checklist

- [x] Accent chooser gone, with a safe migration. `accent` is dropped on read, and a patch carrying it is accepted and ignored. Upgraded files keep their mode. Covered by `settings.test.ts`, and on restart the saved `settings.json` has no `accent`.
- [x] System, Light and Dark tiles, with a visible ring on the chosen one. The E2E samples a real capture: the Dark tile's edge pixel is rgb(162, 210, 244), exactly the accent ink, and differs once Light is chosen.
- [x] Independent light and dark halves. Grove for Light and Iris for Dark saved and painted separately. System follows `prefers-color-scheme` live.
- [x] Six exact T3 built-ins, with Ocean the default for both halves. Palettes are compared against the reference in `themes.test.ts`, with attribution in source, THIRD_PARTY_NOTICES and ADR-0011.
- [x] Dual preview circles with sun and moon badges on the active halves.
- [x] Duplicate, edit and remove, with a confirmation. Removing the active theme falls back to Ocean.
- [x] Editor: simple and advanced colours, live preview over the saved look, Cancel restores it, Save persists. "Pick app color" inspector, label spotlights, and corner-grip resize within the window at 820x560.
- [x] T3 JSON and VS Code import, and export. Invalid JSON and a `url()` colour both give plain alerts, and nothing is saved.
- [x] Open VSX search and install through main IPC. In the E2E the fixture "harbor" installs as Harbor Theme.
- [x] Contrast (50-200%) and Glass (40-100%) sliders change the painted surfaces. At 200% the ink changes and the canvas does not. Slider saves are debounced by 250 ms, and reset buttons restore the defaults.
- [x] Palette on settings, sidebar, threads, requests, terminal variables, dialogs, toasts and diagrams, through `--tt-*` tokens.
- [x] Persistence through restart: halves, contrast, custom themes and the painted contrast variable on the first frame.
- [x] Server environment themes, the `t3 theme` CLI and mobile appearance are recorded as not applicable, with reasons, in ADR-0011.
- [x] Inspector and diagram repaint loop reported by root: fixed and measured idle (below).
- [x] Visual critic finding 2: the minimized editor is one row (title, Expand, Close) resting in the footer's right end, clear of Send and the footer links at 820x560 and 1280. Dragged low and then expanded, the whole panel is pulled back inside the window (visual-fixes observation).
- [ ] Mark, voice sphere and widget following the selected palettes. The branding worker owns this; ADR-0011 and CONTEXT record the rule.

## Tests

Focused unit run, 17 files, 348 tests passed:
- `themesIpc`, `themesOpenVsx`, `themeOpenVsxCorrections`
- `designCaptureMatrix`, `notices`
- `app`, `appearance`, `designSystem`, `diagramSafety` (two files), `messageDiagrams`
- `settingsView`, `themeInspector`, `themeLibrary`, `themeTokens`
- shared `settings` and `themes`

Other checks:
- `npm run typecheck` (node and web) passes.
- ESLint on the changed files is clean.
- `npm run notices:verify` verified 170 components.
- The full suite is root's final gate and was not run here.

Electron, after `npm run build`, `SOTTO_THEMES_E2E=1 npx playwright test tests/e2e/phase-three-themes.spec.ts --workers=1`: 3 passed (about 37 s). One earlier run of the whole file failed test 1 at 8.4 s on a visibility check, and that run's output was overwritten. The next two whole-file runs and three repeats of test 1 passed.

1. **The whole themes journey (about 22 s).** Every item in the checklist above, plus:
   - keyboard activation of a theme card keeps focus;
   - reduced motion turns off the tile transitions;
   - the capture matrix is taken;
   - the app restarts and the choices are still in force.
2. **A spotlight over a drawn diagram (about 11 s).** This follows root's reproduction:
   - a Mermaid reply is drawn;
   - the editor is open over Threads;
   - "Show where Background is used" is pressed.

   After an 800 ms settle, the page does nothing on its own for 2600 ms: 0 probe spans, 0 spotlight redraws and 0 root style writes. A second reply refreshes the spotlight, then the page is quiet again. With the fix removed, the same test measured 5 probes, 5 spotlights and 30 style writes, root's numbers exactly. The unit regressions in `themeInspector.test.tsx` fail with either half of the fix removed.
3. **A minimized editor (about 4 s).** At 820x560 and at 1280, over a thread with a draft:
   - the bar is one row, at most 44px tall;
   - it does not overlap Send or the footer links;
   - Playwright trial clicks land on Send and on every footer link;
   - then the bar is dragged, expanded with the keyboard (focus lands on Theme name), minimized again and dragged as low as it goes at 820x560;
   - expanded again, the panel is wholly inside the window with its action visible. This check fails without the fix.

Journey notes (`artifacts/phase-three-themes/journey-notes.txt`):
- Hovering the Appearance heading labels it "Text".
- A pick takes about half a second end to end.
- Picking the History footer link selects "Text" without navigating.
- The import errors read "That is not valid JSON. Check for a missing comma or quote." and "The color for "canvas" must be a literal CSS color such as oklch(0.62 0.2 280)."

## Evidence

All images are in `artifacts/phase-three-themes/`:
- `themes-{1280,1600,820x560}-{light,dark,system}.png` and `threads-…` for the same nine combinations.
- `theme-editor-820x560-light.png` and `theme-editor-resized-820x560-dark.png`.
- `inspector-hover-1600-dark.png`, `inspector-spotlight-1600-dark.png` and `inspector-diagram-1280-dark.png`.
- `editor-minimized-threads-{820x560,1280}-dark.png` and `editor-expanded-after-low-drag-820x560-dark.png`.
- `sliders-1600-dark.png`, `import-error-1600-dark.png` and `open-vsx-results-1600-dark.png`.

## Visual review

I inspected the rendered images myself, against the user's T3 Code Themes screenshot.

- **Gallery.** Three columns by two rows at 1280 and 1600, matching the reference's 3x2. Two columns at 820. Cards are equal height, and the circles are centred above left-aligned names.
- **Chosen states.** The chosen mode tile has a 2px accent ring inside its edge, over the wireframe panes, and nothing clips at the scroller edge. The chosen theme card has a tinted fill plus the ringed circle and badge.
- **Palette spread.** In Threads, light Grove and dark Iris or Aurora reach the sidebar, selection, message bubbles, composer, request card and footer. No teal accent is left in the room.
- **Remaining teal.** The Sotto mark in the strip is still teal. That belongs to the branding worker.
- **Editor at 820x560.** The editor fits with Save and Cancel reachable. After resizing, it stays inside the window. The spotlight glow outlines the used elements, and a picked row is highlighted and scrolled into view.
- **Minimized editor.** At 820x560 it is a 175x35 pill in the footer's right end. It covers only the end of the footer status sentence; Send and the links are clear.
- **Sliders.** They show their value and reset control on one line, with one description each.

## Tastify checks

- **Concept and reference.** This is a working settings tool, so the controls lead. The user picked T3 Code's Themes, so no new concept was invented. The mode tiles, halves, circles, badges, editor and import dialog follow the reference's structure in Sotto's type and spacing.
- **Composition.** At 1280 and 1600 the first screen reads in order: heading, one sentence, Color scheme tiles, Themes gallery. The gallery is the largest element. The Create and Add actions sit on the Themes heading row, beside what they affect.
- **Copy budget.** The first screen has five text elements: the "Appearance" heading, the intro sentence, the "Color scheme" and "Themes" section labels, and the "Create theme" / "Add theme" actions. The rest are labels a control needs: tile names, theme names and settings navigation. The intro was cut to one sentence. The widget fact appears there only, and the "using Iris" repeat was removed in 82df220.
- **Type and colour.** This check first failed. Tile labels were 13px, theme names 13.5px, and the editor's colour labels, hex fields and buttons 12.5px, with group headings and picker labels at 10.5-11px. Controls and meaningful labels are now 14px, and secondary text is at least 12px, matching the 14-15px labels elsewhere in Settings. The editor still fits at 820x560 with Save reachable, and the gallery stays three columns at 1600. Each theme supplies one field, one ink and one accent. The accent is reserved for actions, selection and the chosen ring. Contrast is checked by `themeTokens.test.ts` for every built-in.
- **Motion.** Tile and card transitions are short and turn off under reduced motion, which the E2E checks. The inspector turns transitions off while probing, so colours never visibly flash.
- **Keyboard.** Tiles and cards are buttons with `aria-pressed`. Enter on a card keeps focus. Escape backs out of inspecting, then clears a spotlight, then closes the editor. The focus ring has a 2px offset inside a 4px gutter.

## Gaps and limits

- Mark, voice sphere and widget palettes are the branding worker's, and still pending on this branch.
- Open VSX was exercised here against the offline fixture only. The live default-client search and install is recorded in `phase-3-themes-network.md`.
- The window's native `backgroundColor` stays black (ADR-0009). An enlarged light window can briefly show a dark edge.
- Other workers' E2E specs that still pass `accent`, and the crossing and agent-attention specs that click "violet orb", were not edited here. The branding worker owns the orb specs.
