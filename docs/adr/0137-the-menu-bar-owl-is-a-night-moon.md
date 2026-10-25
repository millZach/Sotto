# The menu bar owl is a night moon

Accepted by Drake on October 25, 2026, from the prototypes `docs/prototypes/menubar-icon-ten-prototype.html` (design 7, Night) and `docs/prototypes/menubar-icon-night-prototype.html` (design N, Night polished). It amends [ADR-0114](0114-the-menu-bar-owl-is-alive.md) for what the menu bar owl looks like; its schedule, settings and costs stay as that ADR has them.

## Context

The owl perched on a wooden branch "just doesn't work" at menu bar size: 27 points of body, wings, beak, branch, twig and leaves blur into a brown smudge beside Apple's one-colour symbols. Drake asked for ten other designs in the crisp pixel style, picked Night (a crescent moon with the owl's eyes in its dark side and one star), and then picked its polished version over ten more that took it other ways.

## Decision

**The picture.** The menu bar owl is a crescent moon on an 18 by 18 point grid, with the owl's two eyes, 2 by 2 points each with a one-point glint, in the moon's dark side, and one star above it. The dark side is left clear, so the bar shows through. It is drawn pixel by pixel with no anti-aliasing and shown pixel-doubled, as before.

**It reads the owl's poses.** `poses.mjs` and the schedule are unchanged, so it blinks, glances and flaps when the owl did. The eyes move a point with the look, blink half then shut, and flare on a glance or a flap. A flap becomes the star's twinkle: the star flickers through it, bright while the wings would be up and faint while they would be down. So the star twinkles every 5 to 10 seconds, on an uneven beat. The wings, lean and hop are not drawn.

**The settings keep their names and colours.** Owl body colours the moon and the star (Slate, Ink, Light); Owl eyes colours the eyes (Sotto teal, Ice blue, Amber). The swatches are still the colours drawn. The default stays slate with teal eyes.

**Drawn in Node.** The drawing is plain pixels (`scripts/lib/trayOwlDraw.mjs`), so `npm run tray:owl` writes the frames without Electron, and no longer compares them against the old prototype. The frames are 18 by 18 points, so the menu bar item is 20 points wide rather than 29.

## Alternatives the prototypes showed

The first ten: the perch simplified, the owl's head alone, two eyes alone, a one-tint owl, level bars, a speech bubble, Night, a pixel S, an owl microphone and a round owl that hops. From Night: eyes peeking over a cloud, an owl crossing a full moon, an eclipse ring, a star field, an owl in the crescent's cradle, moon phases, a framed window of sky, a moon-faced owl, an owl backlit by the moon, and Night asleep until dictation starts.

A faint fill in the moon's dark side, to give the eyes a dark ground on a light bar, was tried while building and dropped: it turned the crescent into a grey disc.

## Consequences

- On a light bar the eyes' white glints are lost against the bar; the coloured eyes still show. The Ink body suits a light bar, Light a dark one.
- Many of the 73 frames now look alike (every wing angle draws the same), so some swaps redraw an identical picture. That costs what ADR-0114 measured and no more.
- Not decided here, as in ADR-0114: the icon reacting to dictation. The prototypes show eyes that turn red while listening; that is a later question.
