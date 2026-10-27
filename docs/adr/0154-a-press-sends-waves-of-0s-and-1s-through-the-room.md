# A press sends waves of 0s and 1s through the room

## Status

Accepted October 27, 2026. Zach asked for the click ripple to change: "when I click I would like it to have the accent color distort that part of the page with 0 and 1s in the accent color", on every click in the app, keeping the ripple a new owl sends out of the moon in Watcher. Over four rounds of `docs/prototypes/click-binary-prototype.html` he picked N, **Both, ragged**, after sending a recording of the Claude desktop app's click effect as the look he meant. It is an Owl feature, `click-effect` (ADR-0072). **Number provisional until merge** (docs/agents/domain.md).

## Context

The only click effect Sotto had was in Watcher's night scene: a press in the open margin sent a ring of glyphs through the landscape there (ADR-0126). Nothing answered a press anywhere else. The moon's ripple, when a watched thread's owl arrives, is drawn by the same code and was to stay as it is.

The rounds narrowed it. Round one offered four strengths of a burst under the press (a spray of digits, a lens, a glitch, a disc that decodes); the disc came closest, but Zach wanted something that travels out rather than a disc. Round two made it a clean expanding ring; "you still have everything circular". His recording showed what he meant: a field of characters over the whole window, unseen until a click disturbs it, whose waves run out, bounce off the window's edges, cross each other and die away. Round three built that; H, closest to the recording, was "too close to the ripple effect, it needs more abstraction to how it goes out". Round four made the spread uneven.

## Decision

**1. The room has water under it, and a press disturbs it.** A 2D wave simulation on an 8-pixel grid covers the main window (`src/renderer/src/components/clickWater.ts`). A press throws a drop under the pointer and six more around it, each its own size, strength and sign, so their waves break each other up from the start. The water carries waves faster in some places than others (smooth noise over the grid), so a front bends into uneven blobs instead of staying round. The window's edges reflect. Each step keeps a fiftieth of the height per four seconds, so the waves fade over about four seconds and the last speckles are gone within about ten.

**2. The water shows as 0s and 1s in the accent.** Over a grid of 7 by 13 pixels, a 0 or a 1 in the theme's accent (`--tt-accent`) in the theme's monospace face shows where the water is high or low enough, up to 65% strength. Each cell has its own threshold, so a band's edges are speckled, and a 0 on a crest is a 1 in a trough, so the digits flip as the water passes. Each glyph leans a few pixels along the water's slope.

**3. It lies under the page.** The canvas sits under everything in the window and over only the room's own background: a card, a message bubble, the composer, a menu or a dialog lies over the waves, so nothing pressed is ever covered, and the canvas never takes the pointer. While the canvas is there the shell (`.app-shell`) is its own stacking context, so its negative layer stays inside the shell; where the effect is held or off there is no canvas and the shell stacks as it always has. Watcher's pane is a stacking context of its own (ADR-0126), so the night scene draws over the waves and never repaints for them.

**4. In Watcher's margin the waves stand in for the press's ripple.** While the click effect is on, a press in the open margin sends out no ripple of its own; Watcher's owl still looks toward it. The moon's ripple when an owl arrives is unchanged. Where the effect is off, held, or motion is reduced, the margin's ripple is exactly as before.

**5. It is cheap and leaves nothing running.** Presses only add drops to the same water, so many fast presses cost what one does. The loop runs only while some glyph could still show; then it clears the canvas and stops. It steps sixty times a second whatever the display's rate, skips rows the water has not reached, and stamps two prepared glyphs rather than drawing text. A hidden window or a new window size stills the water at once. Pointer presses are read on the window in the capture phase and passively, so nothing the page does can stop or wait on it.

**6. Reduced motion turns it off.** With motion reduced, by the system or by Sotto's own setting, nothing of the effect exists (Zach's pick, over a still "01" fading in place).

**7. It can be turned off.** Settings → Appearance → Motion → **Click effect**, on by default (`clickEffect`). Off, nothing of it exists. The switch shows only where the feature is on.

## Considered options

- **Round one's bursts** (A Spark, B Lens, C Glitch, D Decode): a disturbance under the press that never leaves it. Not picked; it had to travel.
- **Round two's rings** (E Wave, F Wave and echo, G Swell): a clean ring of digits bending the page as it passes. Too circular.
- **Round three's water** (H as the recording, I quicker, J over the page, K bolder): the right idea, with fronts too much like ripples.
- **L Uneven water and M Scattered splash**, each half of N alone. N's two together read least like a ripple.
- **Drawing over the page** (J): waves across the words and the composer, fainter to keep them readable. Not picked; under the page keeps every card clear.

## Consequences

- The digits pass behind the conversation's words for a few seconds after a press, at up to 65% of the accent, so a word can read at less than 4.5:1 while a wave crosses it. The effect is transient and can be turned off; the end-to-end design profile keeps it off, so a capture or a contrast check that presses something measures the page and not the waves.
- Watcher's night scene keeps its column ceiling (ADR-0126) for what it draws; the waves under the pane are not part of that ceiling.
- Clicks inside a native view, the embedded browser, never reach the window, so they send no waves.
- The floating widget is its own window and has no click effect.
