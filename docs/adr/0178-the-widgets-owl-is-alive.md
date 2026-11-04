# The widget's owl is alive

## Status

Accepted November 2, 2026, by Drake's pick from `docs/prototypes/widget-alive-prototype.html`: the smooth owl, lively. It is an Owl feature (`living-widget-owl`, [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)), Drake's call. It answers the question [ADR-0114](0114-the-menu-bar-owl-is-alive.md) left open, the owl reacting to dictation, for the floating widget only, and builds on ADR-0064's November 2 amendment, which took the owl's tile away in the widget.

## Context

Drake asked for polish rounds on the dictation widget. By the third, the capsule led with the owl alone, in the tile's colour, and he asked for that owl to be polished and to have "a dynamic and alive nature". The menu bar owl already blinks, glances and keeps its eyes lit, but nothing in Sotto moved with the dictation itself: the voice bars said Sotto was hearing, and the rest of the capsule was still.

## Decision

**The owl reacts to the dictation.** While the capsule shows, the owl does what the dictation is doing:

- **Waiting** (listening with no voice heard, or asking for the microphone): it breathes, blinks twice a cycle with the second blink doubled, and glances left and right. Its eyes are faintly lit.
- **Hearing you**: its ears go up, its eyes light and it nods with the voice.
- **Transcribing**: its head tilts 8 degrees about its middle, so it stays in its place, and its eyes look up, as if thinking, their light pulsing slowly.
- **Copied**: it hops, and its eyes close into happy arches.
- **Pasted**: it returns to Ready as soon as delivery finishes.
- **Error**: its head droops 7 degrees, its eyes look down and dim, and sad lids, higher at the inner end, come down over them.

**The smooth owl, lively.** The prototype also offered a pixel owl, drawn at 1x and shown pixel-doubled as the menu bar owl is, and a subtle version of every movement at about half the size. Drake picked the smooth vector owl, which matches the capsule's smooth shapes and type, at the lively size.

**Drawn in parts and moved by the stylesheet.** `WidgetOwl` is the mark's own geometry from `SottoMark` (the head, the eyes and the beak cut through it, the pupils), split into groups the stylesheet can move. The shell's `data-status` and `data-speaking` attributes choose the movements, and every movement is a CSS animation or transition, so the owl adds no timer, no script loop and nothing to main's update path. It moves only while the capsule shows; the resting sliver has no owl.

**Reduced motion holds it still.** With reduced motion, from the system or Sotto's own setting, the owl does not breathe, blink, glance, nod, tilt or hop. Its expressions stay, because they change without moving: lit eyes while it hears you, happy eyes when the text lands, sad eyes on an error.

**An Owl feature.** Main gives the widget's renderer `--sotto-living-owl` only while `living-widget-owl` is on, and the widget bridge then carries `livingOwl`. Stable shows the same tile-less owl, still. It goes to stable when Zach sets its `sentToStable`.

**November 3 amendment: no pause after automatic paste.** Drake's dictation latency request removes the success-display hold after a paste. Delivery still publishes its success before returning to Ready, but does not wait for the owl's hop. The configured success-message duration applies to Copied, where the user still needs to paste. Errors keep their recovery controls.

## Consequences

- The widget's owl and the menu bar owl now share a vocabulary (blinks, glances, lit eyes) but not their drawing: the menu bar owl is pre-drawn frames (ADR-0114), the widget's owl is vector parts moved by CSS.
- The owl is 22 pixels wide, so its movements are a few pixels at most. A hop or tilt draws a little outside the owl's own box, inside the capsule.
- The same round made Stop a square in the text colour and kept the capsule's edge neutral in every state; the bars and the owl now say that dictation is live. That polish is not held in Owl.
