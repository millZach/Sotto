# Phase 3 theme branding: mark, voice sphere and widget

Owner: `work/phase3-theme-branding` (exact Claude Opus 5), from main `b8995d8`. User request: the selected theme must also colour the Sotto icon and the voice sphere, and the widget must follow too. This supersedes the frozen widget palette.

Target: Windows Electron desktop. Main window and the floating widget, light and dark, system-following widget, reduced motion. No real audio, no provider calls.

## Tastify acceptance checks

- [x] A built-in or custom theme colours the app `SottoMark` and the Agents voice sphere. This holds on selection, on unsaved editor drafts, on contrast or mode repaint, after restart, and in light, dark and system modes.
- [x] The independent orb colour chooser is gone. The stored `orbColor` field still parses, so old `agents.json` files load, but nothing reads it.
- [x] The orb keeps its single canvas and renderer, along with its animation, state changes, reduced motion and pause on hide. Colours change through `setColors` on the live handle.
- [x] Brand colours come from canonical roles:
  - The tile is `accent` over `canvas`.
  - The glyph is `accentForeground`, or a readable foreground when that is under 4.5:1.
  - The orb pair keeps the accent hue.
  - The mark geometry is unchanged.
- [x] The widget mark, voice bars, live rim, progress, spinner and surfaces all paint from the same palette. The pill's size and behaviour are unchanged, and there is no orb in the widget.
- [x] The widget's mode still follows the system and paints the matching half of the selected light and dark themes.
- [x] Error text and icon use the theme's `errorForeground`, and the stop control stays red. Both are verified distinct from the accent in Electron.
- [x] There is one palette source, the canonical engine (`resolveThemeFor`), with no second hardcoded widget palette.
  - Path: settings → `widgetPresentationFor` → main stamps every widget publish → strict `widgetSnapshotSchema` → dedicated widget preload bridge → `WidgetEntry` root `--theme-*`.
- [x] Updates are live without a new recording:
  - While idle, main republishes the idle snapshot.
  - Mid-session, `NativeDictationLifecycle.repaint()` republishes the current snapshot with the new palette.
- [x] The snapshot carries only nine canonical OKLCH roles per half. Theme ids, names, the library, API keys and other settings are never sent. The widget bridge surface is unchanged.
- [x] Preview fixtures fall back to the default theme's palette (`DEFAULT_WIDGET_PALETTE`).
- [x] Real Electron evidence covers Ocean, Iris, Ember and a custom theme, in light and dark, with live switching and restart. All captures were opened and inspected.
- [x] Focused regressions cover propagation, schema, live updates, orb colours and renderer retention.

## Design

`src/shared/themeBranding.ts` projects the widget palette and derives the brand (`themeBrand`). Both windows read their brand from their own root's `--theme-*` roles through `useThemeBrand`, which is a `useSyncExternalStore` over a MutationObserver on `style` / `data-theme` / `data-theme-id` plus the system scheme query. The main window's roles are painted by the theme owner's `applyAppearance` (including editor drafts). The widget's roles are painted by `applyRootPresentation` from the snapshot. As a result, the mark and orb need no AppContext plumbing.

The light room's `--tt-orb-filter: invert(1) hue-rotate(180deg)` (theme owner's token) turns the orb's additive glow into ink. `AgentOrb` reads the canvas's computed filter and draws the colour that shows as the theme colour through it (`orbColorsBeneath`). A colour whose rotation would clip is first reduced in chroma toward its equal-luminance grey (`inkableColor`), so hue holds. A probe in real Electron confirmed Chromium applies the filter in sRGB.

Main is authoritative for widget presentation. It stamps `theme`, `palette` and `reducedMotion` on every publish, so a renderer snapshot built from older settings cannot repaint a stale palette. The renderer controller also reads current settings rather than the session's.

## Evidence

`tests/e2e/phase-three-theme-branding.spec.ts` (opt-in `SOTTO_THEME_BRANDING_EVIDENCE=1` after `npm run build`) passes in the real Windows Electron app. The captures and sampled colours (`samples.json`) are in `artifacts/phase-three-theme-branding/`.

1. **Ocean dark.** Covers the app mark, the Agents room orb, the widget idle hover and the widget listening capsule.
2. **Iris selected mid-session.** The main room repaints and the same listening session's widget repaints, with no new session.
3. **Ember light room, widget following the system.** The widget shows the light Ember half while idle and while listening. Emulating a dark system mid-session flips the widget to the dark Iris half.
4. **Custom theme (Saffron, from `createVividThemeColors`).** Covers the light room and the widget.
5. **Restart on the same profile.** The custom light room, the widget in both system schemes, and Iris dark after switching the room are all preserved.
6. **Transcription failure (`transcription-failure` scenario).** The error capsule is shown in Ember light and Iris dark. Its copy colour equals `errorForeground` and differs from the accent.

Sampled results:

- **Mark tiles:** every app and widget mark tile matched `themeBrand().tile` pixel-exact (distance 0, tolerance 6).
- **Orb and voice-bar hue:** within 5° of the accent hue in every case (tolerance 30), including the light room's filtered orb.

Visual review:

- **Iris, Ember and custom rooms:** the sphere is violet, warm ember and red, and the mark tile matches in each.
- **Widget capsules:** they keep their geometry. The accent reaches the rim and the voice bars, and the red stop control stays distinct.
- **Error capsules:** readable in both halves.

Other checks:

- **Widget preview baselines:** the 12 `artifacts/design/baseline/{idle,listening,processing,pasted,copied,error}-{light,dark}.png` files were regenerated deliberately with `SOTTO_UPDATE_WIDGET_BASELINES=1`. An old-versus-new composite showed identical geometry with the frozen teal and amber replaced by Ocean roles. `visual-previews.spec.ts` then passed 16/16 without the update flag.
- **Other Electron journeys:**
  - `crossing.spec.ts` and `agent-attention.spec.ts` now switch to Iris through `updateSettings` instead of clicking `violet orb`; their original assertions are kept.
  - `app.spec.ts`, `pill-controls.spec.ts`, `widget-topmost.spec.ts`, `dictation-focus.spec.ts` and `agentVoice.spec.ts` pass.

## Tests

Focused Vitest, 17 files: 508 passed, 2 failed. The two failures are already on `b8995d8` and unrelated to this change:

- `tests/integration/ipc.test.ts › typed preload bridge › creates a frozen main-only surface…`: the bridge keys now include browser, gitChanges, personalChats, terminal and themes.
- `tests/integration/ipc.test.ts › IPC validation and lifecycle › validates a settings patch…`: it expects `webLinkDestination`.

New or extended:

- `tests/unit/shared/themeBranding.test.ts` (21): projection of built-in and custom halves, no leak of ids or settings, strict schema rejections, snapshot requires palette, brand contrast and hue for every built-in in both modes.
- `tests/unit/renderer/themeBrand.test.tsx` (12):
  - The main-window mark follows selection, mode, custom themes and drafts.
  - `AgentOrb` keeps one renderer while colours, state and reduced motion change.
  - It compensates for the light ink filter.
  - Gamut-limited ink colours keep their hue for every built-in.
  - `AgentAppearance` has no orb chooser.
- `tests/unit/renderer/widgetApp.test.tsx`: the mark wears the painted palette; the live palette repaints within a session; system scheme changes flip the painted half; the root is cleaned up.
- `tests/unit/main/nativeDictationLifecycle.test.ts`: main stamps override the renderer, repaint mid-session, no-op when idle, and renderer-gone keeps the palette.
- `tests/unit/renderer/dictationController.test.ts`: publishes the palette in force now and keeps the session shortcut.

Node and web typecheck pass. ESLint passes on changed files, except the `z` unused import in `src/main/index.ts`, which predates this change and root already removed on main (`bc5b22a`).

## Limitations

- The packaged OS, taskbar and tray icon (`build/icon.svg`, installer icons) stays the static teal mark. Only in-app marks follow the theme.
- The widget follows saved settings. An unsaved theme-editor draft repaints the main window's mark and orb, not the widget.
- The appearance contrast and glass sliders affect the main window's painted roles only. The widget receives the theme's canonical roles, not the contrast-adjusted tokens.
- A saturated accent can match the error hue, as with a red custom theme. The error state stays distinguishable by its icon, copy and missing live rim, not by hue alone.
- In the light room, very saturated orb colours lose some chroma to fit through the ink filter. Hue holds, and perceived lightness can shift up to about 0.1 OKLCH L.
- `design-capture.spec.ts` (opt-in) screenshots of the widget and Agents room were not regenerated and will show the themed colours.
