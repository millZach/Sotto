# Phase 1 appearance (#73): verification

Lane `appearance`, branch `work/phase1-appearance`, based on 0598d48. The work was implemented by the authorized Opus 5 fallback for Fable. The ticket is `docs/plans/threads-workspace/tickets/30.md`. The decision is recorded in [ADR-0009](../adr/0009-main-window-appearance-apart-from-widget-theme.md).

## What shipped

- **Settings.** `appearance` accepts `system`, `light` or `dark`; `accent` accepts `teal`, `blue`, `violet`, `rose`, `amber` or `green`. Both fields are validated per field and are ordinary settings patch keys. New installs and settings files that predate the fields get `dark` with `teal`, whatever the widget `theme` or the Windows scheme is. The widget-only `theme` field is untouched. Invalid values fall back to the defaults. The explicit black-only rule is superseded in CONTEXT.md, ADR-0009 and the redesign-3 README.
- **Application.** The main window root carries the resolved `data-theme="dark|light"` and `data-accent`.
  - System mode follows `prefers-color-scheme` live.
  - A localStorage hint paints the last look before settings arrive over IPC.
  - A change of mode marks the root `data-theme-switching` for two frames, which turns transitions off.
  - Pending choices live in `AppearancePreview`, so overlapping saves still show both choices together. An older response never repaints an older choice, and a failed final save restores the persisted value.
- **Tokens.** All colour values live in `tokens.css`, in four layers:
  1. The base dark block.
  2. A light block.
  3. A block per accent.
  4. A block per light accent, each setting exactly `--tt-accent`, `--tt-accent-hover`, `--tt-accent-text`, `--tt-on-accent` and `--tt-focus-ring`.

  Derived tokens use `var()` and `color-mix`. Every stylesheet this lane owns reads tokens only. `color-scheme` is declared per mode, so native selects, scrollbars and form controls follow the room. The orb's additive glow is inverted with `--tt-orb-filter` in light mode.
- **Settings UI.** A new Appearance section, placed before Application, holds two controls:
  - **Mode:** a segmented control for System, Light and Dark.
  - **Accent:** a radiogroup of six swatches. It is a single tab stop, arrow keys move between swatches, each swatch is labelled with its name, and the chosen one shows a check.

## Checks run

| Check | Result |
|---|---|
| `vitest` on `themeTokens`, `appearance`, `app`, `settingsView`, `designSystem`, `shared/settings` and `release/designCaptureMatrix` (maxWorkers=2) | 176 passed |
| `vitest` on the main settings and IPC tests (`settingsRepository`, `nativeSettingsCoordinator`, `agentMembership`, `memoryIpc`, `agentProjectDirectoryIpc`, `agentSpeechIpc`) | 90 passed |
| `tsc -p tsconfig.web.json` and `tsc -p tsconfig.node.json` | clean |
| `eslint` on every changed source, test and script file | clean |
| `npm run design:verify` | 7 Playwright tests passed; "Verified 131 exact deterministic design-review tuples." |
| `tests/e2e/app.spec.ts` › keeps the widget theme apart from the main window and applies a persisted appearance after reload | passed |
| `SOTTO_APPEARANCE_EVIDENCE=1 playwright test tests/e2e/appearance-evidence.spec.ts` | 5 passed. Native select popup screen captures need `SOTTO_APPEARANCE_SCREEN_CAPTURE=1` on an otherwise clear screen. |

## Overlapping saves (parent review item)

`tests/unit/renderer/app.test.tsx` renders the real App against a bridge whose saves resolve only when the test says so.

- **Light, then Violet, with the Light save still pending.** The root is light and violet immediately, and both controls show those choices.
- **Resolving the saves.** The settings queue sends `{ appearance: 'light' }` and then `{ accent: 'violet' }`. Resolving each in turn never repaints Dark or Teal.
- **Failed final save.** Light then Amber, where the Light save succeeds and the Amber save rejects. The root keeps the saved Light, returns to Teal, and the Teal swatch is checked. The save error alert is shown.
- **Store level.** `tests/unit/renderer/appearance.test.ts` covers the preview store directly:
  - It keeps the newest choice per field.
  - A superseded failure is ignored.
  - A saved choice is dropped once settings catch up.
  - Subscribers are notified on each edit and settle.

## Contrast

Contrast is checked on resolved colours, not on screenshots. `tests/unit/renderer/themeTokens.test.ts` parses `tokens.css` the way the cascade applies it, for every mode and accent. It resolves `var()` and `color-mix(in srgb)` and composites translucent tokens over the canvas before measuring WCAG contrast.

The first table gives the lowest ratio found for each role on the surfaces named in its column heading.

| Mode | text | text-2 | muted | faint | control border | success | warning | error | pill ink on pill |
|---|---|---|---|---|---|---|---|---|---|
| dark | 15.91 | 10.43 | 5.10 | 5.10 | 3.98 | 11.41 | 10.50 | 9.95 | 19.05 |
| light | 14.36 | 8.29 | 5.05 | 5.05 | 3.30 | 4.94 | 5.42 | 5.63 | 16.52 |

- **Text tiers:** measured on all ten reading surfaces: canvas, surface, elevated, sunken, panel, field, sidebar, bubble, strong hover and selected.
- **Border and status colours:** measured on canvas, surface, panel and field.

The second table gives, for each accent, the lowest ratio on canvas, surface, elevated, panel, field, sidebar and selected.

| Mode | Accent | accent text | accent graphic | focus ring | on-accent | on-accent (hover) |
|---|---|---|---|---|---|---|
| dark | teal | 7.61 | 7.61 | 12.65 | 8.70 | 12.37 |
| dark | blue | 7.49 | 7.49 | 11.59 | 8.56 | 12.18 |
| dark | violet | 7.87 | 7.87 | 11.99 | 8.99 | 12.57 |
| dark | rose | 8.10 | 8.10 | 12.12 | 9.26 | 12.66 |
| dark | amber | 9.07 | 9.07 | 12.75 | 10.37 | 13.37 |
| dark | green | 9.08 | 9.08 | 12.83 | 10.38 | 13.48 |
| light | teal | 4.96 | 4.96 | 4.96 | 6.10 | 8.07 |
| light | blue | 4.80 | 4.80 | 4.80 | 5.90 | 7.84 |
| light | violet | 4.93 | 4.93 | 4.93 | 6.06 | 8.06 |
| light | rose | 4.69 | 4.69 | 4.69 | 5.80 | 7.67 |
| light | amber | 4.96 | 4.96 | 4.96 | 6.09 | 7.94 |
| light | green | 4.68 | 4.68 | 4.68 | 5.73 | 7.85 |

The test enforces these thresholds:

- Text tiers, accent text and status colours: at least 4.5:1.
- Control borders, focus rings, accent graphics, swatches and the attention dot: at least 3:1.
- On-accent text on accent and on accent hover: at least 4.5:1.
- Error text on the error surface, code text on the code background, and provider badge ink on each provider colour: at least 4.5:1.

The existing `designSystem` contrast test now runs across both rooms and all six accents instead of the one black palette, and its 4.5:1 bar for the activity colour was kept.

## Design gate

`scripts/design-capture-matrix.mjs` grew from 74 to 131 tuples, and no existing tuple was removed. Application tuples now carry the resolved mode: `dark`, which replaces `black` with identical captures, or `light`. The widget tuples still use the emulated system scheme.

New tuples:

- Light repeats of onboarding (the OpenRouter key step) and of Dictate: ready, listening, pasted and error.
- The Agents room.
- History with feedback.
- Settings: saved feedback, providers, dictation, application, validation error and appearance.
- Help.
- All five focus targets.
- Reduced motion.
- The Appearance section in dark.
- Every non-default accent in both rooms: `accent-{blue,violet,rose,amber,green}-{dark,light}`.
- System following the emulated scheme live: `appearance-system-{dark,light}`.
- Width 760 for Dictate, Agents and full Settings in both rooms. The window is narrowed below its shipped 820 minimum.
- Light Dictate and full Settings at 100, 125, 150 and 200 percent.

Captures launched in the light room assert the persisted mode on the root and the painted canvas. Captures switched to it live also assert that the `color-scheme` of `<html>` and the first `<select>` match the room.

### Dark default preserved

Every committed baseline from before this work was compared with a fresh capture, using the gate's own noise floor and limits.

- **Unchanged within the gate:** 62 of 74, including every Dictate, History, Help, onboarding, Threads and widget capture and every non-Settings scale capture.
- **Changed by design:**
  - Ten Settings captures. Four are full-page scale captures that grew for the new Appearance section. `settings-application-privacy` changed height by 1px. `settings-agents`, `settings-capture`, `settings-feedback`, `settings-key-verified` and `settings-validation-error` scrolled differently or picked up the larger 14px segmented control.
  - `focus-switch`, which is scrolled to the same control past the new section.
- **Changed by token consolidation:** `agents-attention` changed by 7–10 units per channel on 1,558 pixels, because the attention card's near-black fill now uses `--tt-panel`. No visible difference.

The side sheet's shadow strength was restored so `agents-session` is back within the gate.

## Rendered evidence

The design gate baselines are in `artifacts/design/app-review/baseline/`. The other rendered evidence is in `artifacts/verification/phase-1-appearance/`.

### Modes and accents

- **Dark and light at desktop width:** `dictate-ready.png`, `dictate-ready-light.png`, `agents-room-light.png`, `history-populated-light.png`, `settings-feedback-light.png` and `help-light.png`.
  - The orb reads as ink on paper in light.
  - The wave, focus rings and selection use the accent.
  - The primary action stays the neutral pill.
- **Minimum width 760:** `width-760-{dictate,agents,settings}-{dark,light}.png`.
  - The gate asserts no horizontal overflow and no clipped controls.
  - This capture found that the Settings control column clipped the Language select below 880px. That bug predates this work and is now fixed.
  - `width-760-zoom-150-settings-appearance-light.png` combines 760 with 150% page zoom, which gives a CSS viewport of about 507px, the stacked Settings layout and no overflow.
- **System:** `appearance-system-dark.png` and `appearance-system-light.png`.
  - The same window follows the emulated scheme without relaunching.
  - The sentence reads "Sotto follows Windows, dark right now…" or "…light right now…".
- **Accents:** `accent-*-{dark,light}.png`, plus `keyboard-accent-focus-light.png`, where the arrow keys moved the choice to Blue and the focus ring surrounds the checked swatch.

### Scale, focus, controls and motion

- **Scale:** `scale-{100,125,150,200}-{dictate,settings}-light.png`, alongside the existing dark captures.
- **Focus:** `focus-{switch-tab,navigation,input,switch,destructive}-light.png`. The 3px accent ring is visible on the light canvas; the gate asserts outline width, style and colour.
- **Native select:**
  - `native-select-open-light.png` and `native-select-open-dark.png` are screen captures of the open Chromium popup: light list in the light room, dark list in the dark room.
  - The gate also asserts the computed `color-scheme` on `<select>`.
- **Reduced motion:** `dictate-reduced-motion.png` and `dictate-reduced-motion-light.png`. A mode switch never animates colour, because of `data-theme-switching`.
- **Provider controls, overlays and the widget:**
  - `settings-providers-light.png`.
  - `agents-attention-light.png` and `agents-session-light.png` (the Workshop sheet).
  - `widget-listening-system-{dark,light}-room-light.png`: with the room light and the accent rose, the widget still follows the emulated system scheme and has no accent.
- **Immediate application:** `switch-timing.json`. Clicking Light set the root attribute 2.6–5.5ms after activation, and the light canvas was painted by the second animation frame, measured at 31–62ms across two runs. The choice persisted across a reload.

## Tastify acceptance

Target: Windows Electron desktop, pointer and keyboard. Review widths are 1080 and 760, at display scales of 100–200% and with reduced motion. Phone is out of scope. This is a scoped edit inside the Crossing identity.

| Check | Rendered view inspected | Result |
|---|---|---|
| Concept and reference: Crossing's typography and branding are kept; light is a cool paper field with dark ink, from `design/redesign-3/02-harbor-dictate-ready-light.png` | `dictate-ready-light.png` beside the Harbor light reference and `dictate-ready.png` | Pass. Same composition, Bricolage Grotesque, Sotto mark and wave. There is one field, one ink and one accent, and the accent sits only on the wave, focus and selection. |
| Composition: the Dictate room still has one dominant element | squint at `dictate-ready-light.png` and the `accent-*` captures | Pass. The headline dominates and the wave leads into it. No accent competes with the primary pill. |
| Type: body 16–18px, controls at least 14px, secondary text at least 12px, and recompose before shrinking | Appearance section at 1080, 760 and 760 with 150% zoom | Pass for the new UI. The sentence is 16px, row labels 15px, segment labels 14px (raised from 13px for both segmented controls), descriptions 13px and the heading 28px. At about 507px CSS width the section recomposes into a stack instead of shrinking. |
| Colour and contrast | contrast tables above, plus the light and dark captures | Pass. Every mode and accent combination meets the thresholds, and a unit test enforces them. |
| Copy budget and repetition for the new section | `settings-appearance-light.png` | There are 9 visible text elements: the heading "Appearance", the state sentence, "Mode", the Mode instruction, the labels System, Light and Dark, "Accent", and the Accent instruction. The swatch names are accessible names only. The two instructions are operating instructions and are exempt. The state sentence repeats the selected controls in fixed modes. It was kept because every Settings section opens with a summary sentence of its state, and in System mode it carries the one fact the controls do not show: the mode currently in effect. |
| Motion | reduced-motion captures and a mode switch | Pass. No new motion was added, and a colour switch is instant, with no transition in any motion setting. |
| Keyboard and targets | focus captures, `keyboard-accent-focus-light.png` and unit tests | Pass. Mode is a radiogroup and Accent is a single tab stop with arrow keys. The swatches are 28px, above the 24px pointer minimum, with 8px gaps. |
| Rendered review at the target sizes | all captures listed above | Pass for the surfaces this lane owns. See the gaps below. |

## Material gaps

- **Threads page in light (resolved in integration).** The shared Threads styles and rich-message components now honor the main appearance tokens. `artifacts/verification/phase-1-appearance/threads-open-running-light.png` was regenerated against the integrated app; the parent also verifies five light Threads states in the permanent matrix and the model picker/new-thread dialog in actual Electron.
- **Minimum width.** The shipped main window minimum is still 820 (`windowManager.ts`, outside this lane's files). The 760 tuples narrow the window in the test only.
- **Native window background.** `BrowserWindow.backgroundColor` stays `#000000`. The renderer paints the correct room before the window is shown, but enlarging a light window can briefly expose a dark edge before Chromium repaints.
- **Dark select popup highlight.** In the dark room, Chromium's popup highlights the hovered option in light blue with grey text, which is low contrast. This was already true under Crossing; the popup's hover colours come from Chromium, not from page CSS.
- **ADR number.** ADR-0009 may collide with an ADR another lane adds. Renumber on integration if needed.

## Parent integration closure

The lane-era Threads light gap above is resolved in the integration branch: project folders, composer and rich messages use the shared tokens. Current `artifacts/crossing/phase-one-*-light.png` and the five new light Threads matrix states supersede the old dark-remnant screenshot. Parent inspection also verifies the light model picker/new-thread dialog and integrated keyboard focus. The window still ships at 820px minimum; 760px captures are additional stress tests with an explicit test-only minimum override. The corrected 150% zoom capture asserts its actual viewport.
