# Sotto management-window redesign, round 2 — every tab, three directions

Three candidate visual directions for the management window, each covering
all four tabs (Home, History, Settings, Help) in both themes. The floating
widget is out of scope, exactly as in round 1: it keeps its frozen tokens in
`src/renderer/src/widget/widget-tokens.css` and none of these directions
touch it. The amber mark and the widget's teal are the thread that ties each
direction back to the widget.

Open any `0N-*.html` in a browser. The tab row works, `?view=history` and
`?theme=dark` deep-link, and the `t` key flips the theme. PNGs are 2× renders
of every tab in both themes; regenerate them from the repo root with
`node design/redesign-2/capture.mjs` (Playwright's bundled Chromium, fonts
from Google Fonts).

What all three deliberately drop from the current "Low lume" build: the
tracked-out all-caps mono eyebrows, middle-dot meta strings, and the
three-column meter row. Each direction keeps the four destinations, the
status affordance, a start button with the global shortcut, and the recent
list on Home.

## 01 — Notebook (light first, typographic)

The window is a page. No left rail: a text tab row sits under the titlebar
and everything reads in one 720px column. Literata carries the user's words
and every heading; Manrope stays for controls. Home shows the last dictation
on ruled paper with a hairline level meter above it; the weekly stats are a
sentence, not tiles. History is grouped by day with times in the margin and
quiet text-link actions. Settings and Help carry a section index in the left
margin, book-style. Signature: the ruled page and the serif.

## 02 — Deck (dark first, dense, keyboard-led)

A pro-tool layout in cool slate rather than warm black, set in IBM Plex.
Sidebar with icons plus a model/input readout, a search field in the
titlebar, and the one structural idea: a dictation transport bar docked
under every tab, so Start, level, timer, and shortcut are never more than
one glance away. Home is an overview with a real seven-day bar chart and a
status list. History is a split pane: a scrolling roll on the left, the full
transcript with a metadata grid on the right. Settings uses sub-navigation
and grouped rows with right-aligned controls. Help is grouped, expandable
questions with a keyboard reference beside them. Signature: the transport bar
and the split pane.

## 03 — Tidepool (light first, soft, rounded)

Seafoam canvas with a faint teal glow at the top, white panels at 24px radius,
Fraunces for greetings and headings, Plus Jakarta Sans for everything else.
Navigation is a floating pill centred under the titlebar. Home opens with a
greeting and the teal orb, the start object, with ripple rings; weekly
figures and a smooth area sparkline sit beside it. History uses filter chips
and day-grouped cards with pill actions. Settings sections each get a tinted
icon chip, a segmented theme control, and large pill toggles. Help leads with
a numbered three-step "how it works" (a real sequence) and expandable
questions. Dark mode is deep teal-black rather than grey. Signature: the orb
and the pill nav.

## Notes for whichever direction goes forward

- Each file is a complete token set in CSS custom properties, so porting to
  `styles/tokens.css` is a rename, not a redraw.
- Fonts: Literata, IBM Plex Sans/Mono, Fraunces, and Plus Jakarta Sans are all
  OFL-licensed and can be bundled the way Manrope and Spline Sans Mono are in
  `src/renderer/src/assets/fonts/`.
- Onboarding isn't a tab and isn't mocked here; each direction's tokens and
  type extend to it directly.
- Deck's transport bar and split-pane History change component structure
  (`AppShell` gains a bottom region; `HistoryView` gains a selection). The other
  two are restyles of the existing view components.

## Round 3: three takes on Deck (`deck/`)

Direction 2 (Deck) was chosen. The three files in `deck/` keep its shell, IBM Plex type, and cool slate palette
unless noted, and every one of them brings the widget's seven-bar voice wave onto Home next to Start dictation.
The wave is the widget's exact rhythm (0.9s ease-in-out loop, 0.12s stagger, teal activity colour), scaled up.
Click Start dictation (or the capsule) in any mockup to see it move; `?state=listening` renders that state directly.

| File | What changes |
| --- | --- |
| `deck/a-stage.html` | Deck as approved. Home gains a full-width dictation stage at the top: Start button, large wave, timer, shortcut, status. The bottom transport bar stays on History, Settings and Help with the wave at widget size. |
| `deck/b-rail.html` | Icon-only 60px rail. Page title moves into the titlebar beside search. A dictation strip with the wave is pinned under the titlebar on every tab, so Home has no separate hero and gets a denser three-column layout. |
| `deck/c-capsule.html` | Adopts the widget's own warm palette and amber primary from `widget-tokens.css`. Home's hero is the widget capsule itself at 2.4x (mark, wave, timer, stop, esc). The other tabs carry a real-size capsule at the bottom of the sidebar. No transport bar. |

Render with `node design/redesign-2/deck/capture.mjs`. Output: `deck/{variant}-{view}[-listening]-{theme}.png` (30 images).
