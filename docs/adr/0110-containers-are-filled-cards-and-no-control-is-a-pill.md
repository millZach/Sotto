# Containers are filled cards, and no control is a pill

## Status

Accepted October 22, 2026. Zach picked each part from `docs/prototypes/look-tuneup-prototype.html`, the look tune-up mock-up made from user feedback: "thin box outlines, pill designs, provider boxes hard to tell apart with the toggle far away, usage index not scaled correctly, left sidebar text too small, too much grey". His picks: containers B (filled surfaces), controls N1 (soft square), provider cards P1 (the toggle at the end of the name's line), Usage scaling with the room, and the light sidebar tune.

Amended October 23, 2026: decision 3's provider cards are replaced by one card holding a row per provider, each row opening in place to its connection, client and models (Zach's pick, variant A "List" of the prototype tag `prototype/providers-settings`; `docs/verification/2026-10-23-providers-list.md`). The rows are divided by the inset's 2px line like rows on any card, and the toggle keeps its name, `Enable <Provider>`.

Amended October 23, 2026 by [ADR-0113](0113-the-composer-controls-are-text-buttons.md): inside a composer, the option chips, Steer now, the branch toolbar and the queued messages' actions are text buttons with no fill or edge at rest, not filled chips.

Amended October 23, 2026 again: the composer card's edge no longer comes back for focus (below, "The composer's edge").

Amended October 24, 2026: the composer card has no edge in any state, running and at the highest effort included (below, "The composer's edge").

Amended October 26, 2026: one light comes back at the highest effort, the effort trace, a travelling light rather than an edge (below, "The composer's edge").

Amends ADR-0011 (main window themes): the look keeps its character and its colours still come only from theme roles through `--tt-*` tokens, but a container is no longer a hairline box and a control is no longer a pill. Amends ADR-0084 (solid glass) for the composer only: it is painted as a card, not in the field colour; the skill list that opens from it keeps the field colour.

## Context

Almost every container in the main window was a 1px line in the faintest border role, so cards, filters and Settings groups barely separated from the room. Every button was a pill, and so were segmented controls, chips, tags and fields, so a control's shape said nothing about what it was. The providers sat in a row with no edges, each toggle far from its name. Usage's index and chart had fixed sizes that looked cramped at 1280 and thin at 1600, and below a 780 pixel room the index scrolled sideways and cut off its first card. The sidebar's text was small beside a 320 pixel default width.

## Decision

**1. A container is a card.** A filled area one step off the room, with no outline: `--tt-card`, the theme's raised surface by night and the canvas with 4% of the text by day, so every theme follows. Rows on a card are divided by a 2px line of `--tt-card-inset` (the canvas), the last row has none, and fields, samples and segmented tracks on a card take the inset. A selected card or item wears `--tt-card-selected`, the accent surface mixed into the card. Each group of Settings rows, each provider and its detail, Usage's index and chart, the worker roles, a host's provider tiles, the phone pairing code and the Threads composer are cards. The user's message bubble keeps the theme's message surface, which is already a fill, and loses its outline. Lines that divide rather than enclose stay hairlines.

**2. Controls are soft squares; only status is round.** No fully rounded shape is left in the main window, and the pill radius token is gone.

- Buttons and fields, find and search included: 6px corners. A secondary button is the surface inside an edge in the field-border role; the primary keeps its plate in the text colour.
- Segmented controls: a sunken track with no border, 6px corners and 3px padding; segments have 4px corners and the chosen one is raised in `--tt-segment-on` with a small shadow and the text colour.
- Composer chips and the skill picker's scope: filled, no outline, 5px corners.
- Toggles: 5px corners, a 3px knob.
- Tags and count badges: 4px corners, filled, no outline.
- Meters, progress bars and slider tracks: 2px corners. Scrollbar thumbs: 3px.
- A status is a small dot or its icon, and its words, never a capsule. Small status dots and spinner rings stay circles.

`themeTokens.test.ts` fails if any renderer stylesheet uses a radius of 999px or more, or the pill token, and if a rule rounds a corner by 50 pixels or more, or by at least half its own height on anything but a square, unless the corner is 2px. The floating widget's stylesheet is the one it leaves alone.

**3. Each provider is a card with its toggle on its name's line.** Mark, name, then the toggle at the line's end; the status under them across the card. The select button fills the card, and the toggle sits over its corner and follows it in the Tab order, so the markup and the toggle's name (`Enable <Provider>`) are unchanged.

**4. Usage's index and chart scale with the room**, and a narrow room wraps the index into a grid rather than a row that scrolls sideways.

**5. The sidebar's default width is 30% of the window, from 260 to 280 pixels**, and its text is a step larger. Until the user drags the edge the sidebar follows that default; a dragged width stays the user's, and Reset forgets it. Every width saved from now on carries a mark that the user chose it. Only an unmarked 320, the old default that Collapse and Reset wrote down, reads as no choice, so a width the user picks now is kept, 320 included.

## Consequences

- Text and accent text are held to 4.5:1 on the card and the selected card, and chart series to 3:1 on the card, for every built-in theme in both modes. Three chart series moved by less than two OKLab points to clear that: dark slot 4 to `#c33786`, dark slot 5 to `#8056d6`, light slot 3 to `#038db6`. `docs/verification/usage-chart-split.md` records the old values as they were when it was written.
- The design capture baselines change wherever a container, a control or the sidebar shows, and are regenerated on the machines that hold them.
- The floating widget and Omarchy's shell pill keep their own look; this decision is about the main window.
- The message scrubber's card (ADR-0109) keeps the clear border Zach picked, with the soft square's 6px corners, and the question's choices on it are filled 4px labels like every other chip. Its ticks are square-ended lines and stay so.

## The composer's edge

Amended October 23, 2026, at the user's ask. The Threads composer card, like every card, has no outline at rest. Its edge came back for three things: focus, a running turn, and a model's highest effort (ADR-0019). It now comes back for the last two only. Focus is already shown by the caret, and the card is the only text field in its pane, so a press anywhere in it and Tab both land where the caret shows. The edge that lit on every click read as a box drawn round the card, which this decision exists to avoid.

Amended October 24, 2026, at the user's ask: "the thin border around the composer, it is still there I want it gone." The card has no edge in any state: at rest, pointed at, with focus, slim, while a turn runs and at a model's highest effort, in a thread and in Watcher (whose glass card had a faint hairline, ADR-0126). The user chose this over keeping the two edges that said something. A running turn still shows in the stop disc, the status line and the thread's row, and the highest effort in the effort chip's coloured word and the arrival's tide through the card (ADR-0019). The card keeps a transparent border so it keeps its size. Focus is still shown by the caret alone, the user's pick over a brighter fill. `tests/e2e/composer-no-edge.spec.ts` reads every state in every built-in theme, dark and light.

Amended October 26, 2026, at Zach's ask for "the appropriate light tracing around the composer" at Max: the one exception is the effort trace (ADR-0019), a light of the effort colour travelling round the card while the thread sits at the highest level, or at Max under a level past it: a thin bright head on the edge only where the light is, and a soft halo falling on the room outside. It is drawn apart from the card, and the edge is empty wherever the light is not: the card's border, outline and shadow stay empty in every state, and below those levels nothing is drawn. `composer-no-edge.spec.ts` still reads every state for an edge, and now also that the trace shows only at the highest effort.

Keyboard users keep a visible path: the composer's buttons, chips and the branch toolbar keep their focus rings, and the transcript keeps its own. Watcher's composer follows the same rule.

