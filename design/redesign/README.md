# Sotto main-window redesign — direction mockups

Three candidate visual directions for the management window (Home view mocked).
The widget is explicitly out of scope: it keeps its current look, which means
the widget must get its own frozen copy of the design tokens before any of
these lands (today `widget.css` imports the shared `tokens.css`).

Serve and view: any static server in this folder, or open the PNGs.
Reference point: Wispr Flow's rebrand language (Figtree + editorial serif,
soft neutrals, calm-vitality green, gentle curves, generous spacing) — used as
a quality bar, not something to clone.

## 01 — Manuscript (light, editorial)

Your words are the interface. Newsreader serif for transcripts and stat
numerals, Manrope for UI; gallery-white canvas, ink text, the widget's teal
(#2c7a72) promoted to the app accent. Stats read as a typeset folio line
("2,847 words · 132 wpm · 43 minutes"), not tiles. Recent transcripts are set
like manuscript entries with hanging timestamps. Quietest of the three;
signature is the typography itself.

## 02 — Low lume (dark, hushed studio)

"Sotto voce" at night. Warm near-black, Spline Sans Mono instrument readouts
for stats, and the widget's 7-bar visualizer grown up into a full-width
resting "breath line" inside the dictation surface, with a slow pooled glow
that breathes while listening. Teal is the only live color; amber reserved
for success. Signature is the breath line.

## 03 — Flow (light, soft modern — closest to the Wispr reference)

Figtree UI sans with Instrument Serif greeting ("Good afternoon, Zach."),
porcelain canvas, floating white panels with soft shadows, sage-teal orb as
the start-dictation object with a slow ripple, one stat strip instead of
three cards, and a "Private by design" chip anchoring the rail. Signature is
the orb + greeting.

## Shared decisions across all three

- Terracotta/cream is retired; the widget's teal family becomes the brand
  accent thread so app and widget read as one product.
- Stats stop being three separate cards.
- Recent transcripts are content, not chrome: minimal borders, real text.
- Every direction keeps: left rail nav (Home/History/Settings/Help), status
  affordance, start button + global shortcut hint, 3 recent entries.
