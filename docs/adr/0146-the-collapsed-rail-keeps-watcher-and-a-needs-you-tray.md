# The collapsed rail keeps Watcher and a Needs you tray

## Status

Accepted October 26, 2026. Drake picked **Owl apart** (column D of `tray.html`) on the tag `prototype/sidebar-rail-mockups`, after comparing ten directions for the collapsed rail (`index.html` on the same tag) and five refinements of the one he took further, the needs-you tray. It is the Owl feature `sidebar-rail` (ADR-0072). The number is provisional until merge (see `docs/agents/domain.md`).

Amends ADR-0135 in one place: "The collapsed rail is unchanged" holds while this feature is off. While it is on, the rail says need with its own tray, reading the same Needs you queue the card does. Nothing in ADR-0004 changes: the tray opens threads and answers nothing.

## Context

Collapsing the Threads sidebar left a rail of one-letter tiles, one per open thread, each with its status ring. Three things were missing. Watcher could not be reached: the rail hides the room switch, the owl with it, so the only way there was to expand the sidebar first. Need was a ring among rings, so a thread waiting on the user looked like any other tile. And one letter rarely told two threads apart; a project's threads often start with the same word.

## Decision

While the Owl feature `sidebar-rail` is on, the collapsed rail is, from the top:

1. **Expand sidebar**, as before.
2. **Watcher's tile**, while Watcher is on: the owl on a raised tile with Watcher's own status ring (waiting on you, working, or at rest), then a hairline. Its name is **Open Watcher**, and a press opens Watcher's room, the same navigation as the room switch's owl. It reads as current while Watcher's room is open.
3. **The Needs you tray**, only while something waits on the user: an amber panel in the attention colour with the count at its head and a tile for each waiting thread, in the Needs you queue's own order (ADR-0135), settled threads that wait included. Its accessible name says how many wait. With nothing waiting there is no tray.
4. The open threads that are **moving**: working (delegating included), just finished, a prototype ready, or babysitting or monitoring something.
5. A hairline, then the **resting** open threads as smaller tiles in muted text.

The foot is unchanged. Every tile keeps what the rail's tiles had: the thread's title as its accessible name, the title and status as its tooltip, its status ring, and the current look for the focused thread. The focused thread stays on the rail once settled, as before. A tile shows two letters instead of one: the first letters of the title's first two words, or a one-word title's first two ("Branch picker search" reads Bp). Colour comes only from theme roles.

While the feature is off the rail is exactly what it was.

## Considered

The ten directions on the tag (monograms, project stacks, recency with a peek, pixel identicons and others), and four other refinements of the tray: the owl leading the tray, project stripes, a ring that says why the thread waits, and resting threads folded into one +N button. Owl apart keeps Watcher reachable whether or not anything waits, and leaves the tray to say only what waits.
