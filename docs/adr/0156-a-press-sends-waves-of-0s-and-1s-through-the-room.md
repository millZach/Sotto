# A press sends waves of 0s and 1s through the room

## Status

Accepted October 27, 2026. Zach asked for the click ripple to change: "when I click I would like it to have the accent color distort that part of the page with 0 and 1s in the accent color", on every click in the app, keeping the ripple a new owl sends out of the moon in Watcher. Over four rounds of `docs/prototypes/click-binary-prototype.html` he picked N, **Both, ragged**, after sending a recording of the Claude desktop app's click effect as the look he meant. It is an Owl feature, `click-effect` (ADR-0072). **Number provisional until merge** (docs/agents/domain.md).

## Context

The only click effect Sotto had was in Watcher's night scene: a press in the open margin sent a ring of glyphs through the landscape there (ADR-0126). Nothing answered a press anywhere else. The moon's ripple, when a watched thread's owl arrives, is drawn by the same code and was to stay as it is.

The rounds narrowed it. Round one offered four strengths of a burst under the press (a spray of digits, a lens, a glitch, a disc that decodes); the disc came closest, but Zach wanted something that travels out rather than a disc. Round two made it a clean expanding ring; "you still have everything circular". His recording showed what he meant: a field of characters over the whole window, unseen until a click disturbs it, whose waves run out, bounce off the window's edges, cross each other and die away. Round three built that; H, closest to the recording, was "too close to the ripple effect, it needs more abstraction to how it goes out". Round four made the spread uneven.

## Decision

**1. The room has water under it, and a press disturbs it.** A 2D wave simulation on an 8-pixel grid covers the main window (`src/renderer/src/components/clickWater.ts`). A press throws a drop under the pointer and six more around it, each its own size, strength and sign, so their waves break each other up from the start. The water carries waves faster in some places than others (smooth noise over the grid), so a front bends into uneven blobs instead of staying round. The window's edges reflect. A press in a composer (the thread's, Watcher's, or a new thread's draft) sends no waves: typing is not a place for them (Zach, October 27, after the pull request opened). Nor does a press in the sidebar, on any page that has one (Zach, October 27, after the eleventh review). The water loses all but a fiftieth of its energy every four seconds, so the waves fade over about four seconds and the last speckles are gone within about ten.

**2. The water shows as 0s and 1s in the accent, as strong in every theme.** Over a grid of 7 by 13 pixels, a 0 or a 1 in the theme's accent (`--tt-accent`) in the theme's monospace face shows where the water is high or low enough, up to 65% strong, as in the prototype's N, in every theme. A theme or mode changed while waves run is read again before the next frame, so they take the new accent at once. Each cell has its own threshold, so a band's edges are speckled, and a 0 on a crest is a 1 in a trough, so the digits flip as the water passes. Each glyph leans a few pixels along the water's slope.

The waves are not held to AGENTS.md's 4.5:1 for the words over them. An earlier build capped each theme's strength so every word over a glyph kept 4.5:1. The cap came to 3% to 22% across the built-in themes, and to 3% in light Graphite, where the waves barely showed. Every see-through fill found afterwards (selected text, the highlight Show where it asked lays on a reply, notices' washes, a card a custom theme makes see-through) took it lower, to 0% to 6% once counted. On October 27 Zach chose the prototype's strength in every theme over the cap: words over a passing wave may read under 4.5:1 for the second or two it takes to pass. This exception is for this transient effect only.

**3. It lies under the page.** The canvas sits under everything in the window and over only the room's own background: a card, a message bubble, the composer, a menu or a dialog lies over the waves, so nothing pressed is ever covered, and the canvas never takes the pointer. While the canvas is there the shell (`.app-shell`) wears the mark `data-click-effect` and is its own stacking context, so the canvas's negative layer stays inside the shell (a mark, not `:has()`, since the shell stands above the terminal); where the effect is held or off there is no canvas and the shell stacks as it always has. Watcher's pane is a stacking context of its own (ADR-0126), so the night scene draws over the waves and never repaints for them.

**4. In Watcher's margin the waves stand in for the press's ripple.** While the click effect is chosen, a press in the open margin sends out no ripple of its own: the waves run there instead, and with motion reduced nothing does, not even the ripple's brightened spot. Watcher's owl still looks toward it. The moon's ripple when an owl arrives is unchanged. Where the effect is turned off or held, the margin's ripple is exactly as before.

**5. It is cheap and leaves nothing running.** Presses only add drops to the same water, so many fast presses cost what one does. The loop runs only while some glyph could still show; then it clears the canvas and stops. It steps sixty times a second by the clock, whatever the display's rate; a frame that comes late runs at most four steps and fades the water by the rest, so a press dies away in about the same time on a window the system draws slowly (nine seconds at sixty frames a second, twelve at one). It skips rows the water has not reached, and stamps two prepared glyphs rather than drawing text. A hidden window, a new window size or a new pixel ratio stills the water at once. Pointer presses are read on the window in the capture phase and passively, so nothing the page does can stop or wait on it.

**6. Reduced motion shows nothing.** With motion reduced, by the system or by Sotto's own setting, nothing of the effect exists and a press shows nothing, in Watcher's margin too (Zach's pick, over a still "01" fading in place).

**7. It can be turned off.** Settings → Appearance → Motion → **Click effect**, on by default (`clickEffect`). Off, nothing of it exists. The switch shows only where the feature is on.

## Considered options

- **Round one's bursts** (A Spark, B Lens, C Glitch, D Decode): a disturbance under the press that never leaves it. Not picked; it had to travel.
- **Round two's rings** (E Wave, F Wave and echo, G Swell): a clean ring of digits bending the page as it passes. Too circular.
- **Round three's water** (H as the recording, I quicker, J over the page, K bolder): the right idea, with fronts too much like ripples.
- **L Uneven water and M Scattered splash**, each half of N alone. N's two together read least like a ripple.
- **Drawing over the page** (J): waves across the words and the composer, fainter to keep them readable. Not picked; under the page keeps every card clear.

## Consequences

- The digits pass behind the conversation's words for a few seconds after a press, at the prototype's strength, so words over a passing wave may read under 4.5:1 while it passes (decision 2). The end-to-end design profile keeps the effect off, so a capture that presses something measures the page and not the waves.
- Watcher's night scene keeps its column ceiling (ADR-0126) for what it draws; the waves run under the whole pane, the column included, and are not part of that ceiling.
- Clicks inside a native view, the embedded browser, never reach the window, so they send no waves.
- The floating widget is its own window and has no click effect.
