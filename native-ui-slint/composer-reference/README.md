# Today's Electron composer, for the Slint copy

These files are a reference for Zach's two-row composer (`form.thread-prompt[data-quiet]`, ADR-0168 and ADR-0172,
`src/renderer/src/agents/quietComposer.css`) as today's Electron Sotto draws it.

Build: `origin/main` at `83edcf6ce57bd2cb59537bd7b969b178514823ab` ("Merge pull request #2693 from
millZach/fix/devin-guide-floor"), package version 0.1.43. I ran it on forge on November 19, 2026, in the nested
Hyprland from `../tools/nested-up.sh` (1800x1200 output, scale 1, animations off). The window was Wayland-native
(`--ozone-platform=wayland`, `xwayland: false`), sized and moved to 1280x800 at the output's origin.
`innerWidth` x `innerHeight` was 1280 x 800 and `devicePixelRatio` was 1. The theme was `t3-code` for both halves,
and the appearance was set to `dark`, then `light`. Font: Figtree, bundled with the app.

## The thread

The thread is a Claude Code thread in project "Shelf", titled "Check the crash run". It holds one finished exchange,
made through the repository's fake Claude CLI (`tests/fixtures/fakeClaudeThread.mjs`). The fake CLI gave this
catalogue: Opus 5.5 (five efforts, fast mode offered), Sonnet 5.5 and Haiku 5.5. This is the catalogue Sotto's own
worker-roles journey uses, with fast mode added on Opus so the speed bolt shows. The thread is idle.

- The model chip says **Opus 5.5**, with Claude's provider mark.
- The effort word says **Default**: the thread is on the provider's default effort, at Standard speed. Its bolt is the
  outline "off" bolt at 0.55 opacity.
- The permissions shield says **Ask for approval**.

## Files

Each state has a PNG and a JSON file with the same name. Every file name starts with the appearance, `dark-` or
`light-`.

| File | What it shows |
|------|---------------|
| `*-1a-empty` | The empty composer, not focused, with its placeholder "What would you like to do next?". The send disc is in its disabled look. |
| `*-1b-typed` | The prompt is focused by a click, then holds `Before merging, check crash-after.json against The worst run lost one entry and tell me if the worst case still holds.` It wraps to two lines. The caret shows after "holds.". This draft makes Sotto offer more effort (ADR-0172 decision 4): the effort word reads "Default ⚡ → **High**", and the chips move 61.5 px left to make room. The disc is enabled. |
| `*-1c-attached` | The same text with one file attached. The file is `crash-after.json`, 766 B, pasted into the prompt as a `File`. That goes through the composer's own paste path, and main staged it as an attachment. The file shows as a pill (`li.attached-file`) in a row between the text and the footer. The pill has a file-type icon, the name cut in the middle ("crash-a" + "fter.json"), the size in muted text and a remove ×. The form grows from 107 to 151 px tall. |
| `*-3a-permissions-menu` | The permissions shield's list (Ask for approval ✓, Allow edits, Auto, Full access), opened by a click from the empty state. The list opens above the chip. The open chip takes the accent wash. |
| `*-3b-model-menu` | The model chip's picker, opened by a click from the empty state. It has a search field (focused, with its focus ring), Opus 5.5 ✓, Sonnet 5.5 and Haiku 5.5. Under them are the note "This thread stays with Claude Code." and the Dynamic and Model routing switches, both off. Its right edge runs past the form's, so this PNG is wider. |
| `*-3c-effort-menu` | The effort word's list (Low, Medium, High, XHigh, Max, Ultracode, with none checked because the thread is on Default), with the Standard and Fast speed switch under it. It was opened by a click from the empty state. |

Each PNG is `webContents.capturePage(rect)`. The rect is the composer form's bounding box, joined with the open menu
where there is one, plus 24 px on every side. It is clipped to the window, so the bottom margin is 20 px and not 24:
the form ends 20 px above the window's bottom edge. `captureRectInWindow` in each JSON file gives the exact rect.

Each JSON file holds:

- `dump.roots[]`: every visible element under the root, in document order, with its `depth`, tag, class, id, role,
  `aria-label`, title, `aria-expanded`/`checked`/`selected`, `data-*` and its own text.
  - `box` is relative to the form's top-left corner (the border box). `window` is in window coordinates.
  - `style` holds the computed styles. Each colour appears as Chromium computes it (often `oklch`/`oklab`, from the
    theme tokens), with a `<property>@srgb` sibling in hex. The hex came from painting the colour on a canvas; 8-digit
    hex carries alpha. Border colours are left out for sides whose width is 0.
  - SVG icons carry `svg` (width, height, viewBox, the stroke-width, stroke and fill attributes, and their shapes),
    plus computed `color`, `stroke`, `stroke-width`, `fill` and `opacity`.
  - `pseudo` holds `::before` and `::after` wherever they have content. The placeholder is the prompt editor's
    `::before`. The form's `::before` is the top-effort light from `effortTrace.css`, at opacity 0 in every capture
    here.
  - The menu states have two roots, the open menu and then the whole form.
  - `hiddenForAssistiveTechnology` lists the elements that are clipped to 1x1 for screen readers, by text only.
- `context`: the window; the pane (`section.thread-pane`); `formRelativeToPane`, the form's distance from the pane's
  left, right and bottom; `lastMessage` and its gap to the form; `transcript`, the transcript's boxes, padding and
  `scroll-padding`; and `ancestors`, the form's parents up to the pane, with their padding and their children's boxes.
- `activeElement` and `hasFocus`.

## Key numbers (dark, empty state, unless noted)

Coordinates are relative to the form's top-left corner unless noted.

- **Pane:** `section.thread-pane`, 1000 x 800, at window x 280.
- **Form:** x 120, y 673, w 760, h 107 relative to the pane. That is 120 px from the pane's left and right and 20 px
  from its bottom. The form sits in `.thread-workspace__compose`, with padding `10px 120px 20px` and margin-top −137 px,
  which lays it over the transcript. The transcript (`.thread-workspace__transcript`) has padding `28px 120px 165px` and
  `scroll-padding-bottom: 137px`. When scrolled to the end, the last content therefore sits 165 − 137 + 10 = 38 px above
  the form. With only two messages here it is 396 px.
- **Form styles:** `border-radius` 20 px, from `--tt-radius-overlay`. `padding` 14 / 10 / 8 / 16 (top, right, bottom,
  left), inside a 1 px transparent border, so the content starts at x 17, y 15. No shadow. Background `#111316` dark,
  `#efeeeb` light. The page behind it is `#0e0d0b` dark and `#f9f8f5` light, sampled from the PNG. It is a grid of
  columns `22px 710px` and rows `0 45 0 38` (empty state).
- **Text:** Figtree 15 px, weight 400, line height 22.5 px, letter-spacing normal. Colour `#f9fafe` dark, `#221d17`
  light. The editor is at (17, 15), 732 x 45, with `min-height` 45 and `max-height` 220, and padding-right 6. Two lines
  fill the 45 px exactly.
- **Placeholder:** the same font, at 15 / 22.5. Colour `#94979e` dark, `#6f6961` light.
- **Footer:** `.thread-prompt__footer` at (39, 66), 710 x 32, gap 4. It is 6 px under the editor (margin-top 6) and
  8 px + 1 px border above the form's bottom.
- **Attach (paperclip) button:** (9, 67), 30 x 30. Ghost button with radius 8 and margin `6px 0 0 -8px`. The icon is
  16 x 16 at (16, 74), stroke 2. Colour `#adb1b9` dark, `#5d5750` light.
- **Permissions chip:** (425.44, 68), 130.14 x 28. Radius 6, padding 0 7, gap 6, and margin-right 2 on the shield slot.
  The shield icon is 14 x 14 at (433.44, 75), stroke 2. "Ask for approval" is 13 px / 19.5, weight 400. Colour
  `#adb1b9` dark, `#5d5750` light; the icon is the same colour.
- **Model chip:** (559.58, 68), 82.95 x 28. Radius 8, padding-left 7, padding-right 4, gap 5. The Claude mark is
  13 x 13 at (567.58, 75.5), filled `#e3b58e`, no stroke. "Opus 5.5" is 13 px / 19.5, weight 400, colour `#f9fafe`
  dark, `#221d17` light. There is no chevron (hidden in the quiet composer).
- **Effort word:** the button is at (642.53, 67), 70.47 x 30, though the CSS says height 28. Radius 8, padding
  0 8 0 4, gap 5. "Default" is 13 px / 19.5, weight 400, colour `#d0d3d9` dark, `#403b34` light. The bolt is 11 x 11
  at (694, 76.5), stroke 2, opacity 0.55 (Standard speed).
- **Gaps along the footer:** paperclip to the meta row 0. Shield chip's right edge (555.58) to the model chip 4 px:
  the 2 px margin plus the 2 px row gap. Model chip to effort word 0. Effort word's right edge (713) to the disc 4 px.
  Disc to the form's inner right edge 10 px padding plus 1 px border. Nothing has a fill at rest, and no chip has an
  edge.
- **Send disc:** (717, 66), 32 x 32, a circle (radius 50%). The arrow-up icon is 16 x 16 at (725, 74), stroke 2.4.
  - Empty and disabled: fill `#2f3135` with icon `#adb1b9` dark; fill `#cbc8c4` with icon `#5d5750` light.
    `cursor: not-allowed`.
  - With text: fill `#f9fafe` with icon `#040507` dark; fill `#221d17` with icon `#f9f8f5` light.
- **Effort offer (typed state):** `.split-chip-effort__suggest` is at (647.5, 67), 65.5 x 30, padding 0 4 0 2, gap 5.
  The arrow "→" is 13 px, coloured `#adb1b9` dark and `#5d5750` light. "High" sits on a 42.09 x 22 pill: radius 6,
  padding 0 7, 13 px, weight 600. Dark: text `#8ad9cc` on `#45baa71a`. Light: text `#005e56` on `#0080761a`. With the
  offer showing, the chips sit at: shield 363.94, model 498.08, effort 581.03.
- **File pill (attached state):** the `ul.attached-files` row is at (17, 72), gap 8. The pill is at (17, 72),
  190.34 x 32, with radius 8, a 1 px border and padding-left 9, padding-right 4, gap 7. Its text is 12 px. Dark: fill
  `#090a0e`, border `#3b414e`. Light: fill `#fdfcf9`, border `#c3bdb2`. The size "766 B" is muted. The form is 151 px
  tall and the footer moves to y 110.
- **Open menus:** all three open above the footer. The permissions and effort lists have a 1 px border, radius 10 and
  padding 6. The model picker has radius 14 and no padding. All three cast a shadow of `0 16px 48px`, in `#000000ba`
  dark and `#1616162e` light.
  - Menu fill: `#111316` dark (the model picker is `#18191d`); `#f2f0ec` light (the model picker is `#efece8`). Border
    `#3b414e` dark, `#c3bdb2` light.
  - Rows are 32 px tall with radius 8 and padding-left 10, at 13 px / 19.5. The chosen row is in the accent text,
    `#8ad9cc` dark and `#005e56` light, with a check mark. The other rows are `#d0d3d9` dark and `#403b34` light.
  - An open chip takes the accent wash `#0b3a36b3` dark, `#cfece7b3` light.
  - The permissions list is 180 x 142. The model picker is 300 x 247.8. The effort list is 318 x 246. The effort list's
    speed switch has two 147 x 30 segments: the chosen one is 12 px, weight 600, on the menu fill with a 1 px hairline
    ring; the other is 12 px, weight 400, muted.

## How it was driven, and what could not be captured

The harness is in `harness/`. It is adapted from `../electron-baseline/` and touches nothing in Sotto's source.
- `cref-main.cjs` is loaded into Electron's main process through `NODE_OPTIONS=--require`.
- `run.sh prepare` seeds the thread and saves a profile template. `run.sh drive` starts Sotto from that template,
  under `env -i` with a private HOME, XDG folders and profile, and no session bus.
- `sequence.sh <dark|light>` runs every state through `step.sh`/`ev.sh`, which pass main-process JavaScript to the
  hook, and `shoot.sh`, which captures one state with `shoot.cjs` and `dump.js`.
- Clicks and keys are real Chromium input events (`webContents.sendInputEvent`), so focus and `:focus-visible` behave
  as they do for a person's click. After each click the pointer moves to empty transcript space (700, 400), so no
  capture shows a hover. The compositor's own pointer was parked outside the window.
- The text was entered with `webContents.insertText`. The file was attached by dispatching a paste event carrying a
  `File`.
- Before each state the build lock was held with `flock -o $HOME/.cache/sotto-tmp/bakeoff-measure.lock`.
- Afterwards Electron was stopped by PID, along with its session, and the nested compositors with `nested-down.sh`.
  `.worktrees/electron-baseline` was removed. Rerunning needs that worktree rebuilt the way `../electron-baseline/results.md`
  says, then `run.sh prepare`.

Not captured, or different from what was asked:

- **The empty state is unfocused.** I did not capture a separate focused-and-empty state. The quiet composer draws no
  edge or ring in any state, so focus shows only as the caret.
- **The caret blinks.** The caret shows in both typed captures, but a capture taken at another moment may miss it.
- **The effort word reads "Default", not a level.** The fake thread is on the provider's default effort. A thread on,
  say, High would read "High" and would get no "→ High" offer for this draft.
- **The model picker's search field has its focus ring.** It is a text field and takes focus when the picker opens,
  so the ring is what a person sees too.
- **The model chip's halves.** The split chip's two halves are the model picker (`Thread model`, a dialog) and the
  effort word (`Thread reasoning`, a dialog with a listbox). Both are captured. The effort offer's "High" button opens
  nothing; it sets the level when pressed, so it has no menu.
- **No hover states and no dropdowns past these three.** Nothing else in the composer opens a menu. The paperclip
  opens the system file chooser, which I did not capture.
