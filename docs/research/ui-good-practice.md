# UI good practice: a rubric for reviewing Sotto

Studied on 2026-10-29 in worktree `ea3833a9-ce6e-402b-8e60-afde99d707a0`, on branch `sotto/ea3833a9`, against main `e1f838016`. Sections 1 to 6 are research from outside sources; the app was not looked at for them. The last section measures Sotto's own rules and stylesheets against them. The review that applies this rubric to the running app is [the desktop UI hillclimb findings](2026-10-29-ui-hillclimb-desktop.md).

This note is the rubric that a screenshot review and a keyboard walk of Sotto are judged against. Each rule says what to check and names its source. Where a source gives numbers, the numbers are here. Where sources disagree, one line says so. Section 5 lists the tells of model-generated ("vibe-coded") interfaces, with how to spot each one and the usual fix. Section 6 ranks findings.

## Basis and limits

- **Sources.** Standards (W3C WCAG 2.2 and the ARIA Authoring Practices, MDN, web.dev), platform guidelines (Apple HIG, Microsoft Learn and Fluent 2, Material 3), a research firm (Nielsen Norman Group), and practitioners writing about their own work (Linear, Vercel, Rauno Freiberg, Emil Kowalski, Adam Wathan and Steve Schoger, Aza Raskin). For model-generated frontends, Anthropic's own docs, cookbook, blog post and `frontend-design` skill. No secondary source is relied on.
- **Read as raw text** (quotes here are verbatim):
  - Apple HIG, 20 pages. The HTML pages render in the browser and WebFetch returned only their titles, so each page was read from Apple's own JSON at `https://developer.apple.com/tutorials/data/design/human-interface-guidelines/<page>.json` and converted to text.
  - Microsoft Learn, 13 pages. WebFetch returned the page source as Markdown.
  - Material 3 token values, from Google's `material-components-android` docs and `material-web` token files on GitHub, because m3.material.io returned only its title.
  - Fluent UI token source files on GitHub.
  - Electron's `custom-window-interactions.md` from the electron/electron repository.
  - Anthropic's `frontend-design` SKILL.md (last commit 2026-09-03) and the frontend-aesthetics cookbook notebook (last commit 2026-10-24), both from GitHub. The Claude prompting pages on platform.claude.com.
  - Refactoring UI's "7 Practical Tips for Cheating at Design". Medium returned 403, so it was read from the Internet Archive snapshot of 2026-10-17 (`web.archive.org/web/20261017033701/...`).
- **Read through WebFetch summaries** (quotes are as the summary gave them and should be checked against the live page before reuse): the WCAG 2.2 Understanding pages, the ARIA dialog pattern, MDN, web.dev, every NN/g article, Vercel's guidelines page and repo, both Linear posts, Rauno Freiberg, Emil Kowalski, A List Apart, the Fluent 2 site, Anthropic's blog post, and refactoringui.com.
- **Did not load.** m3.material.io (title only), so Material's written guidance on elevation, states and motion is not here, only its token values. The Fluent 2 motion page gave no numbers, so Fluent durations and curves come from the token source.
- **Not settled.** The Fluent 2 shapes page (summary) lists Large as 8 px; the Fluent UI token source lists Large 6 px and XLarge 8 px. This note uses the token source. Emil Kowalski's pages showed no date. The Sonnet 5 prompting page links the `frontend-design` skill in the anthropics/claude-code repository; a tree listing of that repository (which may be truncated) did not show it, so the anthropics/skills copy was read.
- **Units.** WCAG and Vercel give CSS pixels. Microsoft gives effective pixels (epx), Material dp, Apple points. This note treats all of them as CSS px at 100% zoom. That is an approximation for review, not a conversion any source states.
- **Left out.** Web-only rules (URL state, hydration, mobile zoom, iOS input sizes) do not apply to a desktop Electron app.
- **Two Microsoft pages are old.** The Win32 mouse and notification-area guides say they were written for Windows 7 and "much of the guidance still applies in principle". They are cited for pointer and tray conventions that current pages do not cover.

## How to run the review

1. **Screenshot pass.** Capture each surface at the largest and smallest supported window sizes, in light and dark, with and without reduced motion. Apple suggests testing "the largest and the smallest layouts" first <https://developer.apple.com/design/human-interface-guidelines/layout>. Check sections 1 and 5 against each capture.
2. **Keyboard walk.** From launch, use only the keyboard. Tab through every surface, open and close everything that opens, trigger each primary action, and note where focus is after each step. Check sections 2 and 4 during the walk.
3. **Record each finding** with the rule it breaks, the surface, the window size and theme, a severity and an effort (section 6).

## 1. Look

### 1.1 Hierarchy

- Put the most important item near the top and the leading side; people read top to bottom and leading to trailing. Indented items read as subordinate <https://developer.apple.com/design/human-interface-guidelines/layout>.
- Not everything gets equal weight. Linear's 2026 refresh calls this "Don't compete for attention you haven't earned": what the task needs stays prominent, and navigation and orientation recede. They dimmed the sidebar, shrank icons and cut separators <https://linear.app/now/behind-the-latest-design-refresh>.
- Build hierarchy with colour and weight before size. "Try and stick to two or three colors" for text (dark for primary, grey for secondary, lighter grey for ancillary), and "two font weights is usually enough for UI work": 400 or 500 for most text, 600 or 700 for emphasis. "Stay away from font weights under 400 for UI work" <https://medium.com/refactoring-ui/7-practical-tips-for-cheating-at-design-40c736799886>. Apple says avoid Ultralight, Thin and Light <https://developer.apple.com/design/human-interface-guidelines/typography>. Windows uses Regular for most text and Semibold for titles, and leaves Bold and Italic out of its ramp <https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/typography>.
- Refactoring UI's lighter-grey tier says nothing about contrast. Any grey that carries meaning still has to pass 4.5:1 (1.4).

**Check:** in each capture, name the one element that matters most; it is where the eye lands first. Count text colours and weights. More than three text colours or two weights is a finding unless each maps to a named role.

### 1.2 Spacing

- **Base unit 4 px.** Fluent 2: "The base unit is four pixels." Its ramp is 0, 2, 4, 6, 8, 10, 12, 16, 20, 24, 28, 32, 36, 40, 48, 52, 56; the 2, 6 and 10 steps exist for icon padding <https://fluent2.microsoft.design/layout>. The Fluent UI token source has 2, 4, 6, 8, 10, 12, 16, 20, 24, 32 <https://github.com/microsoft/fluentui/blob/master/packages/tokens/src/global/spacings.ts>.
- **Standard gaps on Windows:** 8 epx between buttons, between a button and its flyout, and between a control and its header; 12 epx between a control and its label and between content areas; 16 epx from a surface edge to its text <https://learn.microsoft.com/en-us/windows/apps/design/basics/content-basics>.
- **Space makes groups.** Closer items read as related, and consistent spacing can make sections without dividers <https://fluent2.microsoft.design/layout>. Apple groups with "negative space, container shapes, or separator lines" <https://developer.apple.com/design/human-interface-guidelines/layout>.
- **Space around targets.** "About 12 points of padding around elements that include a bezel. For elements without a bezel, about 24 points" <https://developer.apple.com/design/human-interface-guidelines/accessibility>.

**Check:** measure gaps in a capture at 100%. Every gap is on the 4 px scale (2, 6 and 10 px only as icon padding). Gaps inside a group are smaller than gaps between groups. The same relationship uses the same gap on every surface.

### 1.3 Type

Reference ramps. The rows pair nearest equivalents; neither platform publishes this mapping.

| Role | Windows 11 (epx, size/line) | macOS (pt, size/line) |
|---|---|---|
| Caption | 12/16 | Caption 10/13, Footnote 10/13 |
| Body | 14/20 Regular; Body Strong 14/20 Semibold | Body 13/16; Headline 13/16 Bold |
| Body Large | 18/24 | Title 3 15/20 |
| Subtitle | 20/28 Semibold | Title 2 17/22 |
| Title | 28/36 Semibold | Title 1 22/26 |
| Title Large / Large Title | 40/52 Semibold | 26/32 |

Sources: <https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/typography> and <https://developer.apple.com/design/human-interface-guidelines/typography>. Material's baseline scale has 15 styles from 11 to 57 sp <https://github.com/material-components/material-components-android/blob/master/docs/theming/Typography.md>.

- **Minimums.** Windows: 12 px Regular and 14 px Semibold; "Text smaller than these sizes and weights are illegible in some languages." macOS: default 13 pt, minimum 10 pt <https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/typography>, <https://developer.apple.com/design/human-interface-guidelines/typography>.
- **One family.** "You should use one font throughout your app's UI" <https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/typography>. "Minimize the number of typefaces you use, even in a highly customized interface" <https://developer.apple.com/design/human-interface-guidelines/typography>.
- **How many sizes.** Microsoft's own layout example uses Title, Subtitle and Body. In a confined space it uses Body Strong as the title, and Caption only "for very confined spaces" <https://learn.microsoft.com/en-us/windows/apps/design/basics/content-basics>. Inference, not a source rule: a dense tool screen needs Caption, Body, Body Strong and one or two heading sizes. Five or more sizes on one screen is worth a finding unless each is a named role.
- **Case.** Windows: "Use sentence casing for all UI text, including titles" <https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/typography>. Fluent: don't use all caps to get attention, because it is hard to read <https://fluent2.microsoft.design/typography>. Apple uses title case for menu items and button titles <https://developer.apple.com/design/human-interface-guidelines/menus>, <https://developer.apple.com/design/human-interface-guidelines/alerts>, and says to pick a style per element type and keep it <https://developer.apple.com/design/human-interface-guidelines/writing>.
- **Alignment.** "Align left by default, Align center only in rare cases such as text below icons" <https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/typography>.
- **Line length.** Windows: 50 to 60 characters, never more than 60. Anthropic's skill: under 80. *Sources disagree*; 60 to 80 is the range.
- **Truncation.** Ellipsis in most cases (Windows). Use the single "…" character, not three dots <https://vercel.com/design/guidelines>.
- **Numbers that get compared** (counts, costs, times) use tabular figures <https://vercel.com/design/guidelines>.

**Check:** list every font size and weight in a capture. Each maps to a role. No text under 12 px. No all-caps labels unless they are one deliberate role. Long text stays under 60 to 80 characters a line at the widest window.

### 1.4 Colour and contrast

- **Text: 4.5:1**; large text (18 pt, or 14 pt bold, about 24 px or 18.5 px) 3:1. Placeholder text is covered. Disabled controls are exempt. WCAG 2.2 1.4.3, level AA <https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html>.
- **Non-text: 3:1** against adjacent colours for anything needed to identify a control or its state, including focus indicators and a border when the border is the only cue. Hover is exempt, but it must not lower the contrast of the control or of other state cues. WCAG 2.2 1.4.11, level AA <https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html>.
- **Aim higher for custom colours.** "For custom foreground and background colors, strive for a contrast ratio of 7:1, especially in small text" <https://developer.apple.com/design/human-interface-guidelines/dark-mode>.
- **Accent sparingly, for meaning.** "Accent colors are used sparingly to highlight important elements and convey information about an interactive element's state", and "choose one color to indicate elements of your application that are interactive" <https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/color>. "Avoid using the same color to mean different things" <https://developer.apple.com/design/human-interface-guidelines/color>. Static text should not share the interactive colour <https://www.nngroup.com/articles/clickable-elements/>.
- **Never colour alone.** Pair it with shape, icon or text <https://developer.apple.com/design/human-interface-guidelines/accessibility>. About 8 percent of men are red-green colourblind <https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/color>.
- **A defined palette.** 8 to 10 greys and 5 to 10 shades of each primary, defined up front instead of generated with lighten or darken <https://www.refactoringui.com/previews/building-your-color-palette>. Linear generates each theme from three inputs (base colour, accent colour, contrast) in LCH <https://linear.app/now/how-we-redesigned-the-linear-ui>.
- **States outrank rest.** Hover, active and focus have more contrast than the resting state <https://vercel.com/design/guidelines>.
- **Tinted surfaces.** On a tinted background, tint borders, shadows and text toward the same hue <https://vercel.com/design/guidelines>; "Don't use grey text on colored backgrounds" <https://medium.com/refactoring-ui/7-practical-tips-for-cheating-at-design-40c736799886>.
- *Sources disagree:* Vercel prefers APCA to WCAG 2 for perceptual accuracy. WCAG 2 ratios are the conformance test; Apple's Accessibility Inspector uses the WCAG AA values and mentions APCA.

**Check:** sample every text and background pair in each theme, light and dark: body, secondary, placeholder, text on accent, status text, text in menus and tooltips. Sample input outlines, toggles and the focus ring against both neighbours for 3:1.

### 1.5 Light and dark

- Dark colours "aren't necessarily inversions of their light counterparts". Avoid hard-coded colours. Darken white-background images so they don't glow. Test with Increase Contrast and Reduce Transparency on <https://developer.apple.com/design/human-interface-guidelines/dark-mode>.
- "In both light and dark color modes, darker colors indicate background surfaces of less importance. Important surfaces are highlighted with lighter and brighter colors" <https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/color>.
- Set `color-scheme: dark` so scrollbars and native controls follow the theme, and set `background-color` and `color` on `<select>` to avoid a Windows dark-mode bug <https://vercel.com/design/guidelines>.
- *Sources disagree:* Apple says "Avoid offering an app-specific appearance setting". Microsoft says the app follows the user's Windows theme by default but "you can set the theme specifically for your app". Both make the system preference the default.

**Check:** every capture in both modes. Nothing works in only one: a hairline that vanishes in light, an icon that glows in dark. Scrollbars, selects and menus match the theme.

### 1.6 Density and alignment

- Linear's 2024 redesign aimed to "reduce visual noise, maintain visual alignment, and increase the hierarchy and density of navigation elements" <https://linear.app/now/how-we-redesigned-the-linear-ui>; its 2026 refresh kept the density but made it calmer <https://linear.app/now/behind-the-latest-design-refresh>. Fluent warns that "Too much dense information can also be disorienting and overwhelming" <https://fluent2.microsoft.design/layout>.
- Align every element to a grid, baseline, edge or optical centre. Nudge about 1 px where the eye disagrees with the geometry. Balance icon and text lockups, for example a heavier stroke on a thin icon beside medium text <https://vercel.com/design/guidelines>. Apple adds padding inside custom icons so they centre optically <https://developer.apple.com/design/human-interface-guidelines/icons>.
- In mixed content, centre images and icons and left-align text <https://fluent2.microsoft.design/layout>.

**Check:** draw vertical guides along left edges in a capture and count the distinct edges; each should be deliberate. Icons sit on the optical centre line of their text. At the smallest window nothing clips, overlaps or wraps badly.

### 1.7 Shape, borders and shadows

- **Radius by level.** Windows 11: 4 px for in-page controls (buttons, list backplates, text boxes, progress bars), 8 px for top-level containers (windows, flyouts, dialogs), 0 where straight edges meet and when a window is snapped or maximized. Tooltips use 4 px <https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/geometry>. Fluent UI tokens: 0, 2, 4, 6, 8, 12, 16, 24, 32, 40, circular <https://github.com/microsoft/fluentui/blob/master/packages/tokens/src/global/borderRadius.ts>. Material: 0, 4, 8, 12, 16, 20, 28, 32, 48, full <https://github.com/material-components/material-components-android/blob/master/docs/theming/Shape.md>.
- **Nested radii.** A child's radius is no larger than its parent's and is concentric with it <https://vercel.com/design/guidelines>.
- **Fewer borders.** "Using too many of them can make your design feel busy and cluttered." Use a box shadow, two background colours or extra space instead <https://medium.com/refactoring-ui/7-practical-tips-for-cheating-at-design-40c736799886>. Linear's second principle is "Structure should be felt not seen": fewer separators, softer contrast <https://linear.app/now/behind-the-latest-design-refresh>. A border that is the only cue for a control needs 3:1 (1.4).
- **Shadows mean elevation.** Offset shadows vertically instead of using large blur and spread <https://medium.com/refactoring-ui/7-practical-tips-for-cheating-at-design-40c736799886>. Use at least two layers, ambient and direct <https://vercel.com/design/guidelines>. Material has six elevation levels: 0, 1, 3, 6, 8 and 12 px <https://github.com/material-components/material-web/blob/main/tokens/versions/latest/sass/_md-sys-elevation.scss>.

**Check:** list the distinct radii, border styles and shadows in a capture. Radii come from two or three values tied to level (control, overlay, window). Inner radius is never larger than outer. Each shadow means "this is above". Where a border and a background change both separate the same two areas, one of them can go.

### 1.8 Icons

- "All interface icons in your app need to use a consistent size, level of detail, stroke thickness (or weight), and perspective." Match icon weight to the text beside it <https://developer.apple.com/design/human-interface-guidelines/icons>.
- In a menu group, "provide icons for all menu items in a group, or none of them". "Don't display an icon if you can't find one that clearly represents the menu item" <https://developer.apple.com/design/human-interface-guidelines/menus>.
- "Don't use an icon if its meaning isn't clear, or if making it clear requires a complex shape." Good icons "don't mix metaphors" <https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/icons>.
- Few icons are universal (home, print, search). Keep text labels visible and don't rely on hover to reveal them <https://www.nngroup.com/articles/icon-usability/>. Icon-only buttons need an accessible name <https://vercel.com/design/guidelines>.
- Icons drawn at 16 to 24 px look "chunky" at three or four times that size <https://medium.com/refactoring-ui/7-practical-tips-for-cheating-at-design-40c736799886>. Windows title-bar icons are 16 px <https://learn.microsoft.com/en-us/windows/apps/design/basics/titlebar-design>.
- Linear's 2026 refresh used fewer and smaller icons and removed coloured team-icon backgrounds <https://linear.app/now/behind-the-latest-design-refresh>.

**Check:** every icon in a capture comes from one set, at one or two sizes, with one stroke weight. No icon whose meaning a new user would have to guess without a visible label or accessible name.

### 1.9 Empty, loading and error states

- **Empty.** Say whether content is missing, loading or failed; teach how content gets there; give a direct path to act. "Do not default to totally empty states." Never show "No records" while still loading <https://www.nngroup.com/articles/empty-state-interface-design/>. "Provide clear next steps on any blank screens" <https://developer.apple.com/design/human-interface-guidelines/writing>. Design empty, sparse, dense and error states, and handle short, average and very long content <https://vercel.com/design/guidelines>.
- **Error.** Show it next to its cause, in plain words, say precisely what went wrong and how to fix it, don't blame, and keep the user's input <https://www.nngroup.com/articles/error-message-guidelines/>. Don't title an alert "Error" or "Error 329347 occurred" <https://developer.apple.com/design/human-interface-guidelines/alerts>. Avoid "oops" and "uh-oh", and avoid "we" <https://developer.apple.com/design/human-interface-guidelines/writing>. "Errors don't apologize, and they are never vague about what happened" <https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md>.
- **Loading.** See 2.6.

**Check:** for each surface, capture empty, loading, one item, many items, very long content and an error. Each says what is happening and what to do next.

## 2. Interaction

### 2.1 Feedback for every action

- Keep users "informed about what is going on, through appropriate feedback within a reasonable amount of time" <https://www.nngroup.com/articles/ten-usability-heuristics/>.
- **Response limits.** 0.1 s feels instant; 1 s keeps the flow of thought; 10 s holds attention. Past 1 s show that work is happening; past 10 s show when it will finish and offer a way to stop <https://www.nngroup.com/articles/response-times-3-important-limits/>.
- "Always include a press state for a custom button" <https://developer.apple.com/design/human-interface-guidelines/buttons>.
- Put status next to what it describes. Confirm completion only for important tasks, "because people typically expect their action or task to succeed, they only need to know when it doesn't". Show when a command can't run and why <https://developer.apple.com/design/human-interface-guidelines/feedback>.
- Without feedback, users assume the click was lost and click again <https://www.nngroup.com/articles/progress-indicators/>. "Ignore redundant mouse clicks while your program is inactive" and have clicks take effect on mouse up <https://learn.microsoft.com/en-us/windows/win32/uxguide/inter-mouse>. Disable submit only once the request starts <https://vercel.com/design/guidelines>.
- *Sources look opposed but agree:* Microsoft says "Don't display feedback unless it is absolutely necessary" <https://learn.microsoft.com/en-us/windows/apps/develop/input/guidelines-for-visualfeedback>. The visible result is the feedback; add a message only when the result isn't visible.

**Check:** press every control in the walk. Within 0.1 s something visibly changes: a pressed state, the result, or a progress cue. A second press during work does not run the action twice.

### 2.2 Keyboard and focus

- **Visible focus.** 2.4.7, level AA: a visible focus indicator <https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html>. Removing or hiding the outline with styles is a listed failure (F78). Use `:focus-visible` so pointer users don't see rings, and `:focus-within` for groups <https://vercel.com/design/guidelines>.
- **Strong focus.** 2.4.13, level AAA: at least the area of a 2 CSS px perimeter, with 3:1 between focused and unfocused pixels; a solid 2 px outline meets it <https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html>. Windows draws a 2 px outer and 1 px inner border, 1 px from the control <https://learn.microsoft.com/en-us/windows/apps/develop/input/guidelines-for-visualfeedback>. Material's focus ring is 3 px with a 2 px outer offset <https://github.com/material-components/material-web/blob/main/tokens/versions/latest/sass/_md-sys-state-focus-indicator.scss>.
- **Not hidden.** 2.4.11, level AA: the focused control is never entirely hidden by author content such as a sticky header, footer or non-modal panel <https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html>.
- **Order.** 2.4.3, level A: focus order preserves meaning <https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html>. Visual order and tab order can diverge in grids, so test them <https://learn.microsoft.com/en-us/windows/apps/design/accessibility/keyboard-accessibility>.
- **No trap.** 2.1.2, level A: focus can always leave a component by keyboard. A modal that holds focus is fine if the user knows how to leave it <https://www.w3.org/WAI/WCAG22/Understanding/no-keyboard-trap.html>.
- **Dialogs.** Focus moves into the dialog when it opens. Tab and Shift+Tab stay inside. "Escape: Closes the dialog." Focus returns to the control that opened it <https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/>. On macOS, Esc cancels "the current action or process" <https://developer.apple.com/design/human-interface-guidelines/keyboards>.
- **Desktop keys.** Enter and Space activate. Arrow keys move inside composite controls such as lists and grids, which keep one tab stop. F6 and Shift+F6 move between major panes; "You must implement F6 navigation explicitly". Make shortcuts discoverable through tooltips and accessible names <https://learn.microsoft.com/en-us/windows/apps/design/accessibility/keyboard-accessibility>. Esc abandons a drag, move or resize <https://learn.microsoft.com/en-us/windows/win32/uxguide/inter-mouse>. "Avoid overriding system-defined keyboard shortcuts" <https://developer.apple.com/design/human-interface-guidelines/accessibility>.
- **Don't move focus on your own.** "Avoid changing focus without people's interaction" <https://developer.apple.com/design/human-interface-guidelines/focus-and-selection>. Autofocus the single primary input on desktop <https://vercel.com/design/guidelines>.
- **Platform look.** On macOS, a focus ring for text and search fields, a row highlight for lists <https://developer.apple.com/design/human-interface-guidelines/focus-and-selection>.

**Check:** in the walk, focus is always visible and never lost (it never lands on `body` after a close or a delete). Tab order matches reading order. Every popover, menu, dialog and panel closes with Escape and returns focus to its opener. F6 or an equivalent moves between panes. Nothing traps focus. No focused control sits under a sticky bar.

### 2.3 Motion

- **Purpose.** "Don't add motion for the sake of adding motion" <https://developer.apple.com/design/human-interface-guidelines/motion>. Animate only to clarify cause and effect, or for deliberate delight <https://vercel.com/design/guidelines>. "Motion that answers a person's action (opening, expanding, confirming) is welcome when it shows what changed" <https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md>.
- **Frequency.** "In apps, generally avoid adding motion to UI interactions that occur frequently" <https://developer.apple.com/design/human-interface-guidelines/motion>. At hundreds of uses a day, animation "does start to feel more like cognitive burden"; macOS context menus and the app switcher skip it <https://rauno.me/craft/interaction-design>. Never animate keyboard-initiated actions; hover effects used many times a day are best with no animation <https://emilkowal.ski/ui/you-dont-need-animations>.
- **Durations.**

| Source | Values |
|---|---|
| Windows 11 | Fade 83 ms linear (opacity only); entrances and point-to-point moves 167, 250 or 333 ms; exits 167 ms, always with a fade <https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/motion> |
| Fluent UI tokens | 50, 100, 150, 200, 250, 300, 400, 500 ms <https://github.com/microsoft/fluentui/blob/master/packages/tokens/src/global/durations.ts> |
| Material | 16 steps, 50 to 1000 ms; "duration should increase as the area/traversal of an animation increases" <https://github.com/material-components/material-components-android/blob/master/docs/theming/Motion.md> |
| Emil Kowalski | UI animation usually under 300 ms; a 180 ms dropdown feels more responsive than a 400 ms one <https://emilkowal.ski/ui/great-animations>, <https://emilkowal.ski/ui/you-dont-need-animations> |

- **Easing.** Windows entrances and exits `cubic-bezier(0,0,0,1)`, point-to-point `cubic-bezier(0.55,0.55,0,1)`. Fluent `curveDecelerateMid` `cubic-bezier(0,0,0,1)` and `curveEasyEase` `cubic-bezier(0.33,0,0.67,1)` <https://github.com/microsoft/fluentui/blob/master/packages/tokens/src/global/curves.ts>. Material standard `cubic-bezier(0.2,0,0,1)`, standard decelerate `cubic-bezier(0,0,0,1)` for entering, standard accelerate `cubic-bezier(0.3,0,1,1)` for exiting. Kowalski: ease-out for UI. Fluent: linear only for constant-rate motion such as rotation <https://fluent2.microsoft.design/motion>.
- **Implementation.** Animate `transform` and `opacity`; never `transition: all`; let user input interrupt; anchor `transform-origin` where the motion starts <https://vercel.com/design/guidelines>. "Let people cancel motion" <https://developer.apple.com/design/human-interface-guidelines/motion>.
- **Reduced motion.** 2.3.3, level AAA: motion triggered by interaction can be turned off unless essential; `prefers-reduced-motion` is the listed technique <https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html>. It maps to Windows 11 Settings > Accessibility > Visual effects > Animation effects, macOS Reduce motion and GNOME Reduced animation <https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion>. Under it, reduce zooming, scaling and peripheral motion, replace x, y and z movement with fades, and don't animate blur <https://developer.apple.com/design/human-interface-guidelines/accessibility>.
- *Sources disagree:* Anthropic's cookbook prompt asks for "one well-orchestrated page load with staggered reveals" <https://github.com/anthropics/claude-cookbooks/blob/main/coding/prompting_for_frontend_aesthetics.ipynb>. That is advice for one-off web pages. For a tool opened many times a day, the frequency rule above wins.

**Check:** list every animation seen in the walk. Each one shows what changed, runs under about 300 ms (83 ms for a plain fade), eases out, and can be interrupted. Keyboard-triggered changes and frequent hovers are instant. With reduced motion on, nothing slides, scales or zooms.

### 2.4 Hover and press

- Material state-layer opacities: hover 8%, focus 10%, pressed 10%, dragged 16%, disabled 38% <https://github.com/material-components/material-web/blob/main/tokens/versions/latest/sass/_md-sys-state.scss>.
- Hover does not need 3:1 but must not lower contrast (1.4.11).
- "Primary UI (such as commit buttons) must have a static click affordance. Users shouldn't have to hover to discover primary UI." Secondary commands may show their affordance on hover. "Make hover redundant": nothing should need hover to be done <https://learn.microsoft.com/en-us/windows/win32/uxguide/inter-mouse>.
- Tooltips: delay the first one in a group; neighbours then open at once <https://vercel.com/design/guidelines>, with no animation <https://emilkowal.ski/ui/you-dont-need-animations>. Windows treats hovering as pointing "without moving for at least a second" <https://learn.microsoft.com/en-us/windows/win32/uxguide/inter-mouse>.

**Check:** every control shows rest, hover, pressed, focus and disabled states that differ from each other. Nothing needed for the main task appears only on hover.

### 2.5 Affordances and targets

- "Never require users to click an object to determine if it is clickable" <https://learn.microsoft.com/en-us/windows/win32/uxguide/inter-mouse>. "If part of a control looks interactive, make it interactive" <https://vercel.com/design/guidelines>. Don't give headings a background colour or links' colour on static text, which makes them look clickable <https://www.nngroup.com/articles/clickable-elements/>.
- **Targets.** 2.5.8, level AA: 24 by 24 CSS px, or spaced so a 24 px circle centred on each small target touches no other target <https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html>. Vercel: expand any hit area under 24 px to 24 px <https://vercel.com/design/guidelines>. macOS: default control 28 by 28 pt, minimum 20 by 20 <https://developer.apple.com/design/human-interface-guidelines/accessibility>. Make the whole target clickable, icon and label together; splitters at least 5 px wide <https://learn.microsoft.com/en-us/windows/win32/uxguide/inter-mouse>.
- *Sources disagree on size:* WCAG 24 px; Apple macOS 28 pt default and 20 pt minimum, but Apple's buttons page gives 44 by 44 pt "as a general rule"; the Windows 7 guide gives 16 by 16 px for mouse. Use 24 by 24 as the floor.

**Check:** measure the hit area of every icon button, close button, chevron and row action. Under 24 px is a finding unless the spacing exception holds.

### 2.6 Waiting

- **Thresholds.** Under 1 s, show no indicator. 2 to 10 s, a looped indicator. 10 s or more, percent done, and let users stop it. The article itself is loose about 1 to 2 s <https://www.nngroup.com/articles/progress-indicators/>.
- **Skeleton or spinner.** Skeletons for full-screen loads, spinners for one module, progress bars for downloads and long jobs. Skeletons that show only frame and no structure make the page look broken. Skeletons "do not replace performance-optimization efforts" <https://www.nngroup.com/articles/skeleton-screens/>. Skeletons should match the final content exactly <https://vercel.com/design/guidelines>.
- **No flicker.** Wait about 150 to 300 ms before showing a spinner or skeleton, then keep it at least about 300 to 500 ms. A loading button keeps its label and adds an indicator <https://vercel.com/design/guidelines>.
- **Optimistic updates.** Update at once when success is likely, reconcile later, and on failure show the error and roll back or offer Undo. Mutations should finish in under 500 ms <https://vercel.com/design/guidelines>.
- **Keep working.** "Show something as soon as possible", and let people do other things while content loads <https://developer.apple.com/design/human-interface-guidelines/loading>. Don't combine a busy pointer with a progress bar <https://learn.microsoft.com/en-us/windows/win32/uxguide/inter-mouse>.
- **Layout shift.** A shift is bad when the user didn't cause it. Good is 0.1 CLS or less, poor above 0.25. Shifts within 500 ms of a click or keypress don't count. Common causes: media without dimensions, late fonts, content injected above existing content <https://web.dev/articles/cls>. Hiding a Windows info badge with Collapsed moves its neighbours; hiding it with opacity keeps its space <https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/info-badge>.

**Check:** throttle or slow the slowest paths. Fast actions show no spinner flash. Slow ones show the right indicator for their length. Nothing under the pointer moves while the user is aiming at it.

### 2.7 Undo over confirm

- "If an interface is to be humane, it must respect habituation." "Never use a warning when you mean undo" <https://alistapart.com/article/neveruseawarning/>.
- Confirm only serious, rare, irreversible actions; "if you cry wolf too many times, people will stop paying attention". Label buttons with the outcome ("Delete file", "Keep file"), not Yes and No, and don't default to Yes <https://www.nngroup.com/articles/confirmation-dialog/>.
- "Avoid displaying alerts for common, undoable actions, even when they're destructive." "Avoid showing an alert when your app starts." Button titles are one or two words that describe the result; avoid OK except in purely informational alerts; always title the cancel button "Cancel"; never give a destructive button the primary role <https://developer.apple.com/design/human-interface-guidelines/alerts>, <https://developer.apple.com/design/human-interface-guidelines/buttons>.
- Don't warn when data loss is the expected result of the action, as the Finder does not when moving to the Trash <https://developer.apple.com/design/human-interface-guidelines/feedback>.

**Check:** list every confirmation. For each, ask whether the action can be undone. If yes, the confirmation should become an undo. If no, the buttons name the outcome and Cancel is the safe default.

### 2.8 Progressive disclosure

- Show "only a few of the most important options" first; put the rest behind one obvious, labelled control. More than two levels "typically have low usability" <https://www.nngroup.com/articles/progressive-disclosure/>.
- "If a particular command will be used frequently and you have the space available, consider placing it directly in its own element" <https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/menus-and-context-menus>.

**Check:** frequent actions are one step away. Rare ones are behind one control, never two levels deep.

## 3. Simplicity

- **Fewer elements.** "Interfaces should not contain information that is irrelevant or rarely needed" <https://www.nngroup.com/articles/ten-usability-heuristics/>. "Spend your boldness in one place." The skill quotes Chanel: look in the mirror and "remove one accessory" <https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md>. Show status only if users would act on it <https://learn.microsoft.com/en-us/windows/win32/uxguide/winenv-notification>.
- **One primary action per view.** "Keep the number of prominent buttons to one or two per view." Use style, not size, to mark the preferred choice <https://developer.apple.com/design/human-interface-guidelines/buttons>. "Most pages only have one true primary action, a couple of less important secondary actions, and a few seldom used tertiary actions"; style tertiary actions as links, and don't make a destructive action red unless it is the primary one <https://medium.com/refactoring-ui/7-practical-tips-for-cheating-at-design-40c736799886>.
- **Chrome recedes.** Navigation and orientation should not compete with the work <https://linear.app/now/behind-the-latest-design-refresh>.
- **Consistent patterns.** Follow platform norms so users don't guess <https://www.nngroup.com/articles/ten-usability-heuristics/>. Things opened from the same place open and close the same way <https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/motion>. Support context menus everywhere or nowhere <https://developer.apple.com/design/human-interface-guidelines/context-menus>. "An action keeps the same name through the whole flow, so the button that says 'Publish' produces a toast that says 'Published'" <https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md>.
- **Labels say what a press does.** Use a verb; "Send" works better than "Let's do it!"; never "Click here". Drop words that aren't needed. Describe a setting by what it does when on <https://developer.apple.com/design/human-interface-guidelines/writing>. Drop articles from menu items; add "…" when more input is needed before the action completes <https://developer.apple.com/design/human-interface-guidelines/menus>. A button says "Save changes", not "Submit"; name things as users understand them, not as the system is built <https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md>. Don't explain buttons whose titles are clear <https://developer.apple.com/design/human-interface-guidelines/alerts>, and don't explain how to use an icon in its tooltip <https://learn.microsoft.com/en-us/windows/win32/uxguide/winenv-notification>.

**Check:** per view, count filled or accent buttons (one, at most two). For each element, ask what breaks if it goes; if nothing, it is a finding. Read every label alone: does it say what a press does?

## 4. Desktop-native specifics

What separates a desktop app from a web page in a frame.

### 4.1 Title bar and drag strip

- Windows: standard title bar 32 px tall, 48 px when it holds search or an account picture. "All empty space in the title bar or space taken up by non-interactive elements like the window title should be draggable." Right-click on empty title bar shows the system window menu; double-click maximizes and restores. "All title bar elements should be semi-transparent when the window is inactive." Custom caption buttons have rest, hover, pressed, active and inactive states, full-bleed backplates, and Segoe Fluent glyphs E921 (minimize), E922 (maximize), E923 (restore), E8BB (close). The title uses Caption style and may truncate, but the caption buttons always stay fully visible <https://learn.microsoft.com/en-us/windows/apps/design/basics/titlebar-design>.
- Windows 11 windows have 8 px corners and square corners when snapped or maximized <https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/geometry>.
- Apple: "Avoid creating custom window UI ... Doing so without perfectly matching the system's look and behavior can make your app feel broken." Custom windows must still look different when main, key and inactive <https://developer.apple.com/design/human-interface-guidelines/windows>.
- Electron: `app-region: drag` makes an area move the window, and "draggable areas ignore all pointer events", so every button in it needs `app-region: no-drag`. Set `user-select: none` on drag areas so dragging doesn't select text. "You should never use a custom context menu on draggable areas", because some platforms show the system menu there <https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions>.

**Check:** drag from every empty part of the strip; it moves the window. Every control in it clicks. Right-click on empty strip shows the system menu on Windows. Double-click maximizes. Blur the window: the strip dims. Drag across the title: no text selects.

### 4.2 Menus and context menus

- macOS: support the standard menus in their standard order and their standard shortcuts; always show the same items, disabling rather than hiding <https://developer.apple.com/design/human-interface-guidelines/the-menu-bar>.
- Context menus hold the commands most likely needed in that context, stay short (about three groups at most), use one level of submenu at most, and repeat commands available in the main interface. Hide unavailable items in context menus (except Cut, Copy and Paste on macOS); don't show keyboard shortcuts in context menus <https://developer.apple.com/design/human-interface-guidelines/context-menus>.
- Windows: use a menu when the element's job is to show commands, and a context menu for secondary commands on content. "If you want to add commands (such as Cut, Copy, and Paste) to a text or image element, use a context menu" <https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/menus-and-context-menus>.
- *Sources disagree:* Apple hides unavailable context-menu items and disables unavailable menu-bar items; the Windows 7 tray guide says remove rather than disable.

**Check:** right-click in every text field and on selected text: Cut, Copy and Paste appear and work. Right-click on items that have actions: a short menu of those actions appears, the same ones the UI offers elsewhere. No browser items (Reload, Inspect, Back) appear in a shipped build.

### 4.3 Pointer

- "Use the hand (or 'link select') pointer only for text and graphic links." "Command buttons already have a strong affordance, so they don't need a hand pointer." Arrow for most objects, I-beam for text. Show the busy pointer only when users must wait more than one second <https://learn.microsoft.com/en-us/windows/win32/uxguide/inter-mouse>. On macOS the pointing hand means "a URL link to a webpage, document, or other item" <https://developer.apple.com/design/human-interface-guidelines/pointing-devices>.

**Check:** hover every button, row and chip. The pointer stays an arrow unless the target is a link. Text fields and selectable content show an I-beam. Splitters show a resize pointer.

### 4.4 Text selection

- Drag regions get `user-select: none` <https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions>; disable selection while dragging <https://vercel.com/design/guidelines>. Text-display controls can take focus for "text selection and clipboard operations" without being tab stops <https://learn.microsoft.com/en-us/windows/apps/design/accessibility/keyboard-accessibility>.
- Inference from the two above: chrome (labels, buttons, tabs, the strip) is not selectable; content people may want to copy (messages, code, paths, error text) is.

**Check:** Ctrl+A or a drag across the window does not select chrome labels. Message text, code and error text can be selected and copied.

### 4.5 Window sizes

- "Make sure that your windows adapt fluidly to different sizes" <https://developer.apple.com/design/human-interface-guidelines/windows>. Apple's visionOS section adds that minimum and maximum sizes keep elements from overlapping and layouts from sprawling, "but don't use minimum and maximum sizes as a way to prevent resizing" <https://developer.apple.com/design/human-interface-guidelines/layout>.
- macOS: "Avoid placing controls or critical information at the bottom of a window. People often move windows so that the bottom edge is below the bottom of the screen" <https://developer.apple.com/design/human-interface-guidelines/layout>.
- Use effective pixels; type scales with the system, so don't adjust sizes per screen <https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/typography>.
- On a desktop with a fine pointer, set `overscroll-behavior: none` on the root so the whole window doesn't bounce like a page; use `contain` in panels and drawers. Show only scrollbars that are needed, and test with always-visible scrollbars <https://vercel.com/design/guidelines>.

**Check:** at the smallest size nothing clips, overlaps or hides a control. At the largest, text doesn't stretch past 60 to 80 characters. Scrolling past the end of the window does not rubber-band the whole UI.

### 4.6 Tray and menu bar

- Windows tray (Windows 7 guide): an icon for notifications, status and features with no window, not for quick launch. Left-click shows what users most likely want, usually a small flyout near the icon; right-click shows a context menu with the default command in bold. Menu order: Open (bold), Run, a separator, toggles with check marks, a separator, Options, Exit. Remove rather than disable items that don't apply. Icons at 16, 20 and 24 px. No flashing and no long-running animation; "an icon's presence in the notification area sufficiently indicates continuous activity". Tooltip: app name and status, without explaining how to click <https://learn.microsoft.com/en-us/windows/win32/uxguide/winenv-notification>.
- macOS menu bar extra: the menu bar is 24 pt tall; use a template symbol; "Display a menu — not a popover"; let people decide whether it appears; don't rely on it being visible <https://developer.apple.com/design/human-interface-guidelines/the-menu-bar>.

**Check:** the tray icon reads at 16 px in light and dark taskbars. Left-click and right-click do the conventional things. Its menu has the conventional order and no disabled dead items.

### 4.7 Platform fonts, focus and keys

- Microsoft recommends Segoe UI Variable as the one UI font for Windows apps <https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/typography>; Apple's system font is SF Pro <https://developer.apple.com/design/human-interface-guidelines/typography>.
- *Sources disagree:* Anthropic's prompts tell models to avoid "Inter, Roboto, Arial, system fonts" to escape a generic look <https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5>. That advice targets generated web pages. For a desktop tool, a deliberate custom family is fine; what matters is one family, used consistently, legible at 12 px.
- Focus rings and keys: see 2.2.

## 5. Vibe-coded tells

Anthropic names what model-built frontends default to. Without guidance a model will "conform to Inter fonts, purple gradients on white backgrounds, and minimal animations", because "Safe design choices ... dominate web training data" <https://claude.com/blog/improving-frontend-design-through-skills>. A current model "might settle into a consistent default visual style", which "can read well for some briefs but be a poor fit for dashboards, dev tools, fintech, healthcare, or enterprise apps" <https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5>. The `frontend-design` skill lists today's clusters: cream with a serif and a terracotta accent; near-black with one acid-green or vermilion accent; broadsheet hairlines with zero radius; "the SaaS-card kit"; and "template chrome" (ALL-CAPS eyebrows, "A · B · C" meta strings, "WORD — fragment" labels, tinted near-black, monospace data labels, "→" on buttons). It adds that "All traits are legitimate for some briefs, but they are defaults rather than choices" <https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md>. So a tell is a finding when it isn't a choice, and its severity comes from section 6, not from being a tell.

| Tell | How to spot it | Why it hurts (principle, source) | Usual fix |
|---|---|---|---|
| Gradient and glow overuse | Gradient washes behind panels or buttons; coloured glows or blur halos; glowing focus or hover | Decoration competes with content (NN/g heuristic 8); the SaaS-card kit uses "gradient washes as decoration" (Anthropic skill) | Flat theme surfaces; colour only where it carries meaning (1.4) |
| Generic default palette | Purple-to-blue on white or dark; or one of the skill's clusters, unrelated to the product | Named defaults: "purple gradients on white or dark backgrounds" (Sonnet 5 page) and the skill's clusters | Palette from theme roles; one accent with a job (Windows colour) |
| Every element its own colour | Each section, tag or icon gets a different hue; colour no longer predicts meaning | "Avoid using the same color to mean different things" (Apple colour); accent sparingly (Windows colour); Linear removed coloured icon backgrounds | Neutral by default; accent for interactive and selected; status colours only for status |
| Emoji or icon soup | Emoji as icons or bullets; an icon on every heading and row; decorative icons that add nothing | Icons only when meaning is clear and simple (Windows icons); all or none in a group (Apple menus); fewer, smaller icons (Linear 2026) | Remove decorative icons; one set; keep icons on actions and navigation |
| Mixed icon sets | Outline beside filled icons, different strokes or corner styles, odd sizes, icons blown up from 16 px | One size, detail level, stroke and perspective (Apple icons); "Don't blow up icons that are meant to be small" (Refactoring UI) | One library, one or two sizes, stroke matched to text weight |
| Card-in-card nesting | A bordered, shadowed box inside another, often inside a panel; three nested radii | "Content chopped into identical rounded cards" (Anthropic skill); "Use fewer borders" (Refactoring UI); "Structure should be felt not seen" (Linear) | Flatten to one container; separate with space or a background step |
| One radius on everything, or radii that clash | Same 12 to 16 px radius on buttons, inputs, panels and windows; or five different radii; inner radius larger than outer | "One border-radius on everything regardless of hierarchy" (Anthropic skill); radius tied to level (Windows geometry); nested radii (Vercel) | Two or three radius tokens by level; inner never larger than outer |
| Same soft shadow under everything | Identical grey blur under every card, including flat surfaces that sit on nothing | "The same soft grey shadow (rgba(0,0,0,.1)) under each" (Anthropic skill); shadows mean elevation (Material levels, Refactoring UI) | Shadow only on overlays (menus, dialogs, popovers); two-layer shadow (Vercel) |
| Borders on everything | Every region outlined; borders plus background change plus shadow on one box | "Busy and cluttered" (Refactoring UI); fewer separators (Linear 2026) | Drop the border where space or a background step already separates; keep 3:1 where a border is the only cue (WCAG 1.4.11) |
| Too many font sizes and weights | More than about five sizes or more than two weights on one screen; light weights under 400 | Ramp roles (Windows typography); one family (Microsoft, Apple); two weights (Refactoring UI); avoid light weights (Apple) | Map every text style to a ramp role and delete the rest |
| All-caps micro-labels everywhere | Tracked-out ALL-CAPS eyebrows over headings and sections | All caps is hard to read (Fluent typography); "Using all caps for labels" is among "the commonest tells" (Anthropic skill) | Sentence case (Windows typography); drop labels the heading already makes clear |
| Template chrome strings | Meta joined with " · ", labels as "WORD — fragment", "→" after button text, "01 / 02 / 03" on items that aren't a sequence, one word in a headline set in another colour | Named template defaults (Anthropic skill); "Visual structure is information" (same) | Keep a device only where it encodes something true (a real sequence, a real separator) |
| Centred everything | Headings, body text, empty states and forms all centre-aligned in a tool UI | "Align left by default, Align center only in rare cases" (Windows typography); leading-edge reading order (Apple layout) | Left-align text and controls; centre only short text under an icon |
| Placeholder or filler copy | Lorem ipsum, "Welcome to your dashboard!", "Get started" with no next step, marketing taglines, "Oops!" | Words "make it easier to understand and use" (Anthropic skill); no "oops", be action-oriented (Apple writing); NN/g error guidelines | Real states with real next steps; plain sentences in the glossary's nouns |
| Redundant labels | A heading that restates the only button; a tooltip repeating the visible label; an eyebrow repeating the heading; a badge and a sentence saying the same status | "Check each word to be sure it needs to be there" (Apple writing); "Avoid explaining alert buttons" (Apple alerts); "Let each written element do exactly one job" (Anthropic skill) | Keep the one that does the job. An icon beside its label is fine (NN/g icon usability); an icon that adds nothing is not |
| Vague labels | "OK", "Submit", "Yes/No", "Continue" where a verb fits; "Error" as a title; error codes | Labels name the result (Apple alerts, NN/g confirmation); plain words, no codes (NN/g errors) | Verb plus object ("Delete thread", "Keep thread") |
| Spinners everywhere | Spinner on every fetch, including sub-second ones; spinner flashes; spinner beside a progress bar | Under 1 s needs none; looped only for 2 to 10 s (NN/g progress); show delay and minimum time (Vercel) | Delay 150 to 300 ms, hold 300 to 500 ms; skeleton matching layout for full views; percent done past 10 s |
| Layout shift | Content jumps when data, fonts, badges or images arrive; a row moves under the pointer | Unexpected shift is the harm; good CLS 0.1 or less (web.dev); reserve space (Vercel) | Reserve space, fixed sizes for media and badges, hide with opacity rather than collapse when position matters |
| Inaccessible contrast | Light grey on white, grey on a coloured fill, placeholder used as the only label, faint dividers as the only control boundary | WCAG 1.4.3 (4.5:1) and 1.4.11 (3:1) | Fix the theme role, not the component; recheck both themes |
| Missing or weak focus states | `outline: none` without a replacement; focus shown only by a faint background; focus lost after closing something | WCAG 2.4.7 (F78), 2.4.11, 2.4.13; ARIA dialog focus return | 2 px ring at 3:1 via `:focus-visible`; return focus to the opener |
| Over-badging | Counts or dots on many nav items; "New" or "Beta" pills that never go away; badges on things needing no action | Badges are for dismissible, non-permanent messages, not "a permanent way of bringing the user's focus" (Windows info badge); indicators "can introduce noise and clutter" (NN/g indicators) | Badge only actionable, clearable state; remove permanent pills |
| Modal overuse | Settings, details or simple choices in modals; modal on launch; modal on modal; multi-step wizards in a modal | Modals interrupt and are for critical, short, direct decisions (NN/g modal); "Avoid showing an alert when your app starts" (Apple alerts) | Inline panel or popover; modal only for blocking or irreversible choices |
| Toasts for everything | A toast after every action, including ones whose result is visible; errors in toasts that fade | Confirm only important completions (Apple feedback); a fading error toast was missed for 5 minutes (NN/g indicators); avoid time-boxed elements (Apple accessibility) | Let the visible result be the feedback; put errors inline next to their cause; toasts for background events, with undo where it applies |
| Confirm dialogs for reversible actions | "Are you sure?" before delete, archive or close when the action could be undone | Habituation (Raskin); "cry wolf" (NN/g confirmation); no alerts for common undoable actions (Apple alerts) | Do it at once, offer Undo |
| Decorative motion | Fade-and-slide on every section, hover lift on every card, staggered list entrances, `transition: all`, animation on keyboard actions | "Fade-and-slide-up entrances on each section and hover transitions on every card are the generic default and read as AI-generated" (Anthropic skill); frequency rule (Apple, Rauno, Kowalski) | Remove; keep motion that shows what changed, under 300 ms, interruptible, off under reduced motion |
| Hover-only affordances | Row actions, close buttons or labels that appear only on hover; tooltip as the only label | Primary UI needs a static affordance; "Make hover redundant" (Windows 7 mouse guide); labels "visible at all times" (NN/g icon usability) | Show primary actions at rest; make hover-revealed actions reachable by keyboard and focus |
| Ghost buttons with no hierarchy | Every action the same outline or ghost style; or every action filled with accent | One or two prominent buttons per view (Apple buttons); primary, secondary, tertiary pyramid (Refactoring UI) | One filled primary; secondary quieter; tertiary as text |
| Dead zones and false affordances | Padding around a control that doesn't click; static text styled like a link; headings with fills | "No dead zones" (Vercel); don't make static items look clickable (NN/g clickable) | Hit area equals visual area; reserve the interactive colour for interactive things |
| Web-page tells | Hand pointer on every button; rubber-band scroll of the whole window; chrome text selects on drag; right-click does nothing in a text field or shows Reload or Inspect; default browser focus ring | Hand pointer only for links (Windows 7 mouse guide, Apple pointers); overscroll none (Vercel); `user-select: none` and no custom menu on drag areas (Electron); Cut, Copy, Paste in a context menu on text (Microsoft menus) | Arrow pointer; fix overscroll; non-selectable chrome; native-feeling context menus |

## 6. Severity and effort

Rank each finding by impact first.

1. **Blocks a task or fails WCAG A or AA.** A task can't be done by keyboard or pointer; focus is lost, hidden or trapped; text or a control boundary fails 4.5:1 or 3:1; a target fails 24 px with no exception; content clips at the smallest window; a destructive action has neither undo nor a confirmation. WCAG 1.4.3, 1.4.11, 2.1.2, 2.4.3, 2.4.7, 2.4.11 and 2.5.8 sit here.
2. **Confuses or slows.** A label that doesn't say what a press does; a hover-only primary action; no feedback within 0.1 s or no indicator past 1 s; a modal or confirmation that interrupts a reversible action; layout shift under the pointer; inconsistent patterns between surfaces; motion on frequent or keyboard actions; no reduced-motion variant. The AAA criteria (2.4.13 focus appearance, 2.3.3 animation from interactions) count here unless the project's own rules make them required.
3. **Looks unfinished.** Off-scale spacing, misaligned edges, mixed radii, shadows or icon sets, too many sizes or weights, borders on everything, filler copy, spinner flashes.
4. **Taste.** A palette, font or density preference with no rule behind it. Record it, but it needs the owner's call, not a fix.

Then note effort, so cheap wins are visible:

- **Small:** one token or one CSS value, fixed everywhere at once (a radius, a gap, a theme role's colour, a duration).
- **Medium:** one component, used on several surfaces (a button variant, a menu, the focus ring, an empty state).
- **Large:** a layout or interaction-model change (moving an action, replacing a modal with inline UI, a new keyboard path). These need a mock-up before building.

Within a severity, list small-effort findings first. Fix tells at the token or theme-role level where possible, so one change fixes every surface.

## Sources

Standards:

- WCAG 2.2 Understanding: <https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html>; <https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html>; <https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html>; <https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html>; <https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html>; <https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html>; <https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html>; <https://www.w3.org/WAI/WCAG22/Understanding/no-keyboard-trap.html>; <https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html>
- ARIA Authoring Practices, modal dialog: <https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/>
- MDN `prefers-reduced-motion` (modified 2026-06-10): <https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion>
- web.dev, Cumulative Layout Shift (Mihajlija and Walton, updated 2023-04-12): <https://web.dev/articles/cls>

Platform guidelines:

- Apple HIG (read from the JSON form of each page): <https://developer.apple.com/design/human-interface-guidelines/layout>; <https://developer.apple.com/design/human-interface-guidelines/typography>; <https://developer.apple.com/design/human-interface-guidelines/color>; <https://developer.apple.com/design/human-interface-guidelines/dark-mode>; <https://developer.apple.com/design/human-interface-guidelines/accessibility>; <https://developer.apple.com/design/human-interface-guidelines/motion>; <https://developer.apple.com/design/human-interface-guidelines/feedback>; <https://developer.apple.com/design/human-interface-guidelines/loading>; <https://developer.apple.com/design/human-interface-guidelines/alerts>; <https://developer.apple.com/design/human-interface-guidelines/buttons>; <https://developer.apple.com/design/human-interface-guidelines/icons>; <https://developer.apple.com/design/human-interface-guidelines/menus>; <https://developer.apple.com/design/human-interface-guidelines/context-menus>; <https://developer.apple.com/design/human-interface-guidelines/the-menu-bar>; <https://developer.apple.com/design/human-interface-guidelines/windows>; <https://developer.apple.com/design/human-interface-guidelines/pointing-devices>; <https://developer.apple.com/design/human-interface-guidelines/focus-and-selection>; <https://developer.apple.com/design/human-interface-guidelines/keyboards>; <https://developer.apple.com/design/human-interface-guidelines/writing>. Also read but not cited: toolbars.
- Microsoft Learn, Windows apps: <https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/geometry>; <https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/typography>; <https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/motion>; <https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/color>; <https://learn.microsoft.com/en-us/windows/apps/design/basics/content-basics> (reached from `/design/style/spacing`); <https://learn.microsoft.com/en-us/windows/apps/design/basics/titlebar-design>; <https://learn.microsoft.com/en-us/windows/apps/develop/input/guidelines-for-visualfeedback>; <https://learn.microsoft.com/en-us/windows/apps/design/accessibility/keyboard-accessibility>; <https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/menus-and-context-menus>; <https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/icons>; <https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/info-badge>
- Microsoft Learn, Windows 7 UX guide (marked by Microsoft as not updated): <https://learn.microsoft.com/en-us/windows/win32/uxguide/inter-mouse>; <https://learn.microsoft.com/en-us/windows/win32/uxguide/winenv-notification>
- Fluent 2: <https://fluent2.microsoft.design/typography>; <https://fluent2.microsoft.design/layout>; <https://fluent2.microsoft.design/shapes>; <https://fluent2.microsoft.design/motion>
- Fluent UI tokens: <https://github.com/microsoft/fluentui/blob/master/packages/tokens/src/global/durations.ts>; <https://github.com/microsoft/fluentui/blob/master/packages/tokens/src/global/curves.ts>; <https://github.com/microsoft/fluentui/blob/master/packages/tokens/src/global/borderRadius.ts>; <https://github.com/microsoft/fluentui/blob/master/packages/tokens/src/global/spacings.ts>
- Material 3 tokens: <https://github.com/material-components/material-components-android/blob/master/docs/theming/Motion.md>; <https://github.com/material-components/material-components-android/blob/master/docs/theming/Shape.md>; <https://github.com/material-components/material-components-android/blob/master/docs/theming/Typography.md>; <https://github.com/material-components/material-web/blob/main/tokens/versions/latest/sass/_md-sys-state.scss>; <https://github.com/material-components/material-web/blob/main/tokens/versions/latest/sass/_md-sys-elevation.scss>; <https://github.com/material-components/material-web/blob/main/tokens/versions/latest/sass/_md-sys-state-focus-indicator.scss>
- Electron: <https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions> (read from <https://github.com/electron/electron/blob/main/docs/tutorial/custom-window-interactions.md>)

Research:

- Nielsen Norman Group: <https://www.nngroup.com/articles/ten-usability-heuristics/>; <https://www.nngroup.com/articles/response-times-3-important-limits/>; <https://www.nngroup.com/articles/progressive-disclosure/>; <https://www.nngroup.com/articles/skeleton-screens/>; <https://www.nngroup.com/articles/progress-indicators/>; <https://www.nngroup.com/articles/confirmation-dialog/>; <https://www.nngroup.com/articles/empty-state-interface-design/> (Kaplan, 2021-09-19); <https://www.nngroup.com/articles/indicators-validations-notifications/> (Flaherty, 2024-01-17); <https://www.nngroup.com/articles/error-message-guidelines/> (Neusesser and Sunwall, 2023-05-14); <https://www.nngroup.com/articles/modal-nonmodal-dialog/> (Fessenden, 2017-04-23); <https://www.nngroup.com/articles/icon-usability/> (Harley, 2014-07-27); <https://www.nngroup.com/articles/clickable-elements/> (Loranger, 2015-03-08)

Practitioners:

- Vercel: <https://vercel.com/design/guidelines>; <https://github.com/vercel-labs/web-interface-guidelines>
- Linear: <https://linear.app/now/how-we-redesigned-the-linear-ui> (Saarinen and others, 2024-03-28); <https://linear.app/now/behind-the-latest-design-refresh> (Aufmann and Heckel, 2026-03-12)
- Rauno Freiberg, "Invisible Details of Interaction Design" (July 2023): <https://rauno.me/craft/interaction-design>
- Emil Kowalski (undated): <https://emilkowal.ski/ui/great-animations>; <https://emilkowal.ski/ui/you-dont-need-animations>
- Aza Raskin, "Never Use a Warning When you Mean Undo" (2007-07-21): <https://alistapart.com/article/neveruseawarning/>
- Adam Wathan and Steve Schoger, "7 Practical Tips for Cheating at Design" (2018-02-20): <https://medium.com/refactoring-ui/7-practical-tips-for-cheating-at-design-40c736799886>, read from <https://web.archive.org/web/20261017033701/https://medium.com/refactoring-ui/7-practical-tips-for-cheating-at-design-40c736799886>; <https://www.refactoringui.com/>; <https://www.refactoringui.com/previews/building-your-color-palette>

Anthropic, on model-generated frontends:

- `frontend-design` skill: <https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md>
- Cookbook, "Frontend Aesthetics: A Prompting Guide": <https://github.com/anthropics/claude-cookbooks/blob/main/coding/prompting_for_frontend_aesthetics.ipynb>
- "Improving frontend design through Skills" (2025-11-12): <https://claude.com/blog/improving-frontend-design-through-skills>
- Prompting Claude Sonnet 5, "Design and frontend defaults": <https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5>
- Prompting best practices, "Frontend design" (reached from `docs.claude.com/.../claude-4-best-practices`): <https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices>

## How Sotto measures up

Read from `AGENTS.md`, `CONTEXT.md`, the ADRs named below and the 106 stylesheets under `src/renderer` on main `e1f838016`. This section covers rules and code only. What the running app shows is in [the desktop findings](2026-10-29-ui-hillclimb-desktop.md).

### Already the practice, by rule and by check

- **Colour comes from theme roles** (ADR-0011). `themeTokens.test.ts` fails a stylesheet on its `owned` list that uses a literal colour. There is one accent, the app icon's teal (ADR-0024), and status colours mean status. This avoids "every element its own colour" and the generic palettes (section 5). The one deliberate exception is the effort colourways (ADR-0019), which are a choice the user makes.
- **Text sizes and corners come from a named scale** (ADR-0169, October 30, 2026): nine type steps from 11 to 28 px and seven corner steps from 2 to 20 px, as `--tt-type-*` and `--tt-radius-*` tokens. `scaleTokens.test.ts` fails a renderer stylesheet that writes a size or a corner off the scale, unless its reason is on the test's exception list (1.3, 1.7).
- **Contrast is a rule, not a hope.** `AGENTS.md` requires 4.5:1 for text. The Omarchy theme's readability check mixes text to 4.5:1 and focus to 3:1 (`CONTEXT.md`, Readability check). `builtin-palette-contrast.spec.ts` and the `textContrast` and `elementContrast` helpers measure it in the running app (1.4).
- **Containers are filled cards with no outline, and no control is a pill** (ADR-0110). The composer's options are text buttons (ADR-0113). These answer "borders on everything", "card-in-card" and boxed chips at the rule level (1.7, section 5).
- **Surfaces are solid** (ADR-0084). There is no glassmorphism except the Glass theme, which the user picks in Owl (ADR-0150).
- **Every UI change is checked** in light, dark and reduced motion, at 1600x1000, 1280x800 and the 820x560 minimum (`AGENTS.md`). The design gate holds 145 committed captures (`artifacts/design/app-review/baseline`), including focus captures, four display scales and a 760-pixel width (1.5, 4.5).
- **The keyboard path is designed, not inherited** (`AGENTS.md`):
  - focus follows reading order;
  - every control has a name that says what a press does;
  - anything that opens answers Escape;
  - controls in the drag strip opt out of dragging;
  - a new shortcut is checked against the dictation hotkey (2.2, 4.1).
- **Words are plain** (`AGENTS.md`, Plain words). A control's name says what a press does. An error says what happened, whether anything was lost and what to do next. Nothing announces itself unasked. There are no error codes. This is the rubric's 1.9 and its labels rule (section 3) almost word for word.
- **Motion is short and uniform.** 411 transitions use 120 ms and most of the rest use 140 to 220 ms, inside the 83 to 300 ms range (2.3). Reduced motion stills the decoration: the night sky, the menu bar owl and the effort trace (`CONTEXT.md`).
- **Desktop-native by brief.** The window has drag regions, a tray, a floating widget and each platform's own window controls. The 820x560 minimum is verified on every platform, including Linux (`docs/verification/linux-window-minimum.md`) (section 4).
- **Looks are chosen, not defaulted.** A new look starts as a mock-up with variants, and Zach's pick is recorded in the ADR. Examples are the sidebar foot, the room switch, the appearance page and the composer. Anthropic's skill says model defaults are "defaults rather than choices". Sotto's look is a record of choices.

### Where the stylesheets drift from the rubric

Measured with `grep` over `src/renderer/**/*.css` on main `e1f838016`, as of the review. The type and radius rows have since been fixed by ADR-0169; their numbers after it are in each row.

| Rubric rule | What the code has |
|---|---|
| A few type roles (1.3) | 34 distinct `font-size` values, all literals, in half-pixel steps from 9 to 34 px. The commonest are 13 (373 uses), 12 (208), 12.5 (190), 14 (185) and 13.5 (84). There are no type tokens. **Since ADR-0169:** 1,283 of 1,292 size declarations name one of nine `--tt-type-*` steps. The rest are 3 `inherit`, Usage's 2 figures that grow with the room, and 4 sizes in the floating widget. |
| Two weights, or three with roles (1.1) | 600, 500 and 400 carry the app. 550 and 450 appear 17 times. |
| Two or three radii by level (1.7) | `--tt-radius-sm`, `md` and `lg` exist, but only 126 of the 731 radius declarations use them. There are 43 distinct values: 6 px (138 uses), 8 (70), 4 (55), 2 (48), 7 (36), 12 (34), 3 (33), 5 (32), 10 (28) and more. **Since ADR-0169:** 663 of 754 corner declarations name a `--tt-radius-*` step; 84 are `0`, `inherit` or a circle's `50%`, and 7 keep a size of their own with a reason (Usage's bars, the skill pill, the effort trace's halo and glow, Drake's pill, two in the widget). Seven steps is more than the rubric's two or three, but each is tied to what it rounds. |
| Shadows mean elevation (1.7) | 148 `box-shadow` declarations with 62 distinct values. |
| Sentence case (1.3) | 5 `text-transform: uppercase` rules (Dictate's stats, the theme studio, the global styles). |
| One way to show a status (section 5, redundant labels) | A coloured left-edge stripe beside status words and a status ring appears on six surfaces: the request card, a ready prototype, a lifted thread, client updates, a provider error and agent errors and notices. |

These are drift rather than defaults. Each has a token-level fix (section 6, small effort): a type ramp and a radius scale as `--tt-*` tokens, with the literals moved onto them. That is one change that tidies every surface without changing the look Zach chose, and for type and radii it has been made (ADR-0169). The iPhone review found the same drift in `apps/ios` (`~/ui-hillclimb/shared-notes.md`), so one shared ramp and radius scale would serve both apps.
