# Text sizes and corners come from a named scale

## Status

Accepted October 30, 2026, by Zach's pick A, "Snap", of the before/after prototype on the tag `prototype/type-radius-scale` (`docs/prototypes/type-radius-scale/type-radius-scale-prototype.html`), for #1833. **Number provisional until merge** (docs/agents/domain.md).

Amends [ADR-0011](0011-main-window-themes-replace-the-accent.md): stylesheets read tokens for their text sizes and corners as well as their colours. Amends [ADR-0110](0110-containers-are-filled-cards-and-no-control-is-a-pill.md) decision 2: its corner sizes are now named steps, and its no-pill check reads each step at the size it draws.

## Context

Every stylesheet wrote its text sizes and corners as numbers. At `0790b7dfa` the renderer had 1,289 size declarations with 29 different pixel sizes, in half-pixel steps from 9 to 36, and no type tokens. It had 741 corner declarations with 37 different sizes once tokens were resolved; only 134 used `--tt-radius-sm`, `md` or `lg`. The desktop UI review called this drift rather than a look (finding 15 of `docs/research/2026-10-29-ui-hillclimb-desktop.md`): nobody reads 12.5 beside 13 as a choice.

The prototype put three scales beside today's app: A keeps every whole size Sotto already leans on and snaps the rest to the nearest; B is six steps, with the text people read most going from 15 to 14 px; C copies Windows' Fluent ramp and squares the cards. Zach picked A: today's look stays, and the values move onto named steps.

## Decision

**1. Nine type steps, `--tt-type-*`.** In `tokens.css`, each with a line naming what it is for:

| Step | px | Took today's |
|---|---|---|
| micro | 11 | 9, 9.5, 10, 10.5, 11 |
| caption | 12 | 11.5, 12, 12.5 |
| small | 13 | 13, 13.5 |
| body | 14 | 14, 14.5 |
| reading | 15 | 15 |
| lead | 16 | 16, 17 |
| heading | 18 | 18, 19, 20 |
| figure | 22 | 21 to 25 |
| title | 28 | 26 to 36 |

`--tt-text-*` already names text colours (`--tt-text`, `--tt-text-muted`, `--tt-text-faint`), so `--tt-text-caption` would read as a colour. Sizes take their own prefix.

**2. Seven corner steps and full, `--tt-radius-*`.**

| Step | px | Took today's |
|---|---|---|
| mark | 2 | 1 to 3 |
| tag | 4 | 4, 5 |
| control | 6 | 6, 7 |
| row | 8 | 8, 9 |
| inset | 10 | 10 to 12 |
| card | 14 | 13 to 17 |
| overlay | 20 | 18 to 24 |
| full | 50% | a circle on a square box |

Full is `50%`, never a large pixel radius, so it draws a dot or a ring and never a pill (ADR-0110). `--tt-radius-sm`, `md` and `lg` stay, as aliases of control, inset and card, so the 130 declarations that name them round as they did.

**3. Each size went to its nearest step.** A size exactly between two steps went down, except under 12 px, where it went up, which takes the sizes under Windows' 12 px minimum from 87 to 34. Corners written per corner moved corner by corner. The rewrite was mechanical. One corner was set by hand: the composer's card rounds at the card step, Zach's two-row composer (ADR-0168) included, which the mapping alone would have put at overlay. Drake's pill (ADR-0161) takes the overlay step.

**4. What stays as written, and why.** `0`, `inherit` and `50%`. Usage's two index figures, which grow with the room between two sizes (`clamp()`, ADR-0110 decision 4), and its bars' top corners, which the chart works out from each bar's width. The skill pill's corner in `em`, which rounds with the composer's text around it. The effort trace's halo and glow (47 and 25 px), concentric with the composer's corner out past it (ADR-0019). Each is an entry with its reason in `tests/unit/renderer/scaleTokens.test.ts`.

**5. The floating widget keeps its look.** It does not read `tokens.css`, so `widget/widget-tokens.css` carries the same scale in place of its own `sm` 10 and `md` 12 overrides, which nothing in it read. Only what draws the same on a step moved there: 11 px text, the 4, 14 and 20 px corners, and the 1 px corners of its 2 px progress bar, which draw the same at 2. Its 9, 10, 10.5 and 11.5 px text and its 3 and 12 px corners have no step at their look and stay, each named in the test, until Zach decides the widget's shape (ADR-0110).

**6. Text drawn outside the stylesheets.** A Mermaid diagram is laid out in a document of its own, so it takes the reading step from `TYPE_STEPS` (`styles/typeSteps.ts`), which the test holds equal to `tokens.css`. The terminal's size is the user's setting; the test iPhone's corners and the theme inspector's outline are worked out from what they draw.

**7. A test holds it.** `scaleTokens.test.ts` reads every renderer stylesheet and fails on a `font-size`, a `font` shorthand's size or a `border-radius` length that is not a step `tokens.css` declares, listing each under its stylesheet. It also fails on an exception no stylesheet writes any more, and when the widget's copy of the scale or `TYPE_STEPS` differs from `tokens.css`.

## Consequences

- The look stays. At the 820 × 560 minimum and at 1600 × 1000 most text moves half a pixel. The changes that show are the rare large sizes (the phone pairing code 36 to 28, Memory's title 30 and 27 to 28, Usage's large ring figure 34 to 28, Settings' section title 26 to 28 and its sidebar title 25 and 24 to 22), a 17 px line going to 16 (the Dictate room's sentence among them), 12 px corners going to 10 (35 of them, onboarding's and the theme studio's cards most), and the composer's card going from 16 or 18 px to 14. A line that wrapped at 12.5 px can fit at 12, which moves what is under it. `docs/verification/type-radius-scale.md` has the before and after.
- The Windows design captures shift by these amounts and are retaken on Windows.
- A new stylesheet writes a step, or names its reason in the test's exception list. A number the scale lacks is a change to the scale, not a literal.
- Shadows are not part of this decision: 151 declarations with 64 values are left as they are.
- The iPhone's half is #1858: its text is already on six steps (`TextScale`); its corners are not.

## Considered options

- **B, six steps.** The issue's ramp, named with the iPhone's six roles: a cleaner ramp, but the transcript, the composer, journal entries and settings labels would go from 15 to 14 px, and every dialog from 20 to 14 px corners.
- **C, Fluent.** Windows' five sizes and three corners. Every 13 px label grows to 14 and every 15 px reading line shrinks to 14, which flattens the hierarchy, and cards lose their soft corner.
- **`--tt-text-*` names, as the issue suggested.** They collide with the text colour tokens.
- **Leaving the widget on the mapping.** Its Esc key would grow 2 px inside a capsule whose fixed width is measured to hold the longest status line.
