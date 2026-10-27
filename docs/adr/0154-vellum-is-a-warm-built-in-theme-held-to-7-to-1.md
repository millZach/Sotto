# Vellum is a warm built-in theme held to 7:1

## Status

Accepted October 27, 2026. Drake asked for "a new theme for Sotto that is high contrast and help everything blend + is easy on the eyes", as a bundled theme with a light and a dark half, going straight to stable. It amends [ADR-0011](0011-main-window-themes-replace-the-accent.md) and [ADR-0024](0024-sotto-ships-its-own-palettes-in-light-and-dark-columns.md), whose built-ins become seven: Sotto, Hush, Citrine, Graphite, Clay, Fern and Vellum. It is not an Owl feature: Drake asked for it in the stable picker, and unlike Glass ([ADR-0150](0150-glass-is-a-see-through-theme-held-in-owl.md)) it changes nothing about how the window is drawn. The prototype is `docs/prototypes/vellum-theme-prototype.html`, kept at the tag `prototype/vellum-theme`.

## Context

Every built-in already keeps text at 4.5:1 on every surface the window paints it on (#936). High contrast usually buys more than that by going to black and white, which is Graphite, and which is tiring over a long session: a pure white room by day, near-black by night with near-white words, and boxes that read as boxes. Drake asked for the opposite trade, a lot of contrast where words and controls carry meaning and very little between the surfaces themselves.

## Decision

1. **Vellum** (id `vellum`) is the seventh built-in, after Fern in the picker, in both columns, on the iPhone and in first-run setup. Its palettes are fixed values in `src/shared/themes/palettes.ts`, like the other six.
2. **It holds these bars on the window's surfaces**, measured with the token resolver in `tests/fixtures/renderer/themeTokenResolver.ts` at the default 100% Contrast. The surfaces are the room, panels, raised and overlay surfaces, fields, cards, the selected card, the sidebar, the selected row, the hover wash, the user's message and the code block. `themeTokens.test.ts` holds Vellum to them.
   - Body text, sidebar text, the user's message, code, the composer's filled button ([ADR-0153](0153-the-composers-buttons-are-its-keys.md)), the primary action and the label on the accent: 7:1 or more. The lowest is 8.09:1 by day and 8.99:1 by night.
   - Secondary, muted and placeholder text, links, warnings and errors: 5.75:1 or more by day and by night.
   - Control boundaries (icon-only buttons), the focus ring, the live mark and the finished mark: 4.5:1 or more, against the 3:1 the window needs. The focus ring is 5.64:1 by day and 9.22:1 by night.
   - Changes' tinted lines are the exception. There the added, removed and picked tints sit over the code block, and words fall below these bars while keeping the 4.5:1 every built-in keeps on every pair the window paints (`paintedTextPairs.ts`): code and body text hold 6.44:1 by night and 7.73:1 by day, and the lowest pair, a picked line's added sign by day, is 4.62:1. Status text on the selected row's tint is 5.52:1 by day.
   - At 150% Contrast every word rises. Fills that the Contrast setting does not mix (the accent, the primary action, the focus ring and the finished mark) stay where they are; at 50% the words fall toward the room as they do on every theme.
3. **The surfaces blend.** The room, the sidebar, cards, the composer, menus and the scrubber's lane sit within a few lightness steps of each other (card against the room 1.09:1 by day and 1.10:1 by night, the sidebar 1.06:1), and hairlines do the separating. No role is pure black or pure white.
4. **Warm neutral, not blue.** The room is warm paper by day (`oklch(0.955 0.013 85)`) and a lamp-lit sepia room by night (`oklch(0.225 0.008 70)`), with low chroma on every surface. By night the room is lifted off black and the words kept under white (`oklch(0.915 0.016 85)`), so 7:1 comes from narrowing the range rather than from the brightest white on the darkest black.
5. **The accent is ink blue, used sparingly**: links, focus, the selected row and the accent fill (`oklch(0.41 0.1 262)` by day, `oklch(0.8 0.075 262)` by night). It is the one cool colour, far from the warning's amber, so Watcher's needs-you amber, the Ember effort colourway and the warning text read as themselves, and the accent colourway ([ADR-0019](0019-effort-colourways-and-the-highest-level-outline.md)) has a hue of its own. No large area is blue.

## Consequences

- `vellum` joins the ids a saved theme cannot keep: a theme of the user's own saved under it moves to `vellum-2` and its halves follow, as Graphite, Clay, Fern and Glass did.
- The iPhone's `ThemePalettes.swift` is regenerated and lists Vellum.
- The design capture matrix names `theme-vellum` in both rooms. Its baselines have not been captured yet; they are taken with the next Windows capture run.
- First-run setup's theme grid holds seven tiles in three rows of three on stable, as Owl's did with Glass.

## Considered Options

- **A high-contrast switch that pushes any theme further.** The Contrast slider already does that for every theme; what it cannot do is keep the surfaces close while the words get stronger.
- **A cool, near-black high-contrast theme.** Graphite is already black and white. Blue rooms are the ones Drake asked to avoid.
- **A warm accent (amber or terracotta).** It would sit on the warning's hue and make Watcher's needs-you amber ambiguous. Clay already wears terracotta.
