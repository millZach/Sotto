# Night falls moves the window between Threads and Watcher's room

## Status

Accepted October 23, 2026, at Drake Morey's request. An Owl feature (ADR-0072), `night-falls`, next to Watcher's own (ADR-0073), whose room it moves into and out of. **Number provisional until merge** (docs/agents/domain.md).

## Context

Pressing the owl on the room switch swapped the whole window in one frame: the sidebar vanished, the thread pane became **Watcher's room**, and the switch, Usage, Settings, Help and the update control reappeared as the floating switch under Watcher's composer. Drake found it abrupt and confusing; the controls seemed to jump to the bottom of the prompt box.

## Decision

**1. Night falls, variant 9 of ten.** `docs/prototypes/watcher-room-transition-prototype.html` holds the ten variants, each run both ways; Drake picked 9. A band of text characters sweeps across the window, left to right going into Watcher's room and right to left coming back. The room being opened shows behind the band and the one being left ahead of it, edged in character cells, and the room switch's owl rides the band from the sidebar foot to the floating switch, or back.

**2. Only between those two rooms.** Every other page change stays a one-frame swap, and a page opened while a run plays ends the run at once; navigations apply in the order they were asked for.

**3. On the View Transitions API.** The page being left is a still snapshot and the one opened is live, so the app still renders one page at a time. The band is a canvas over both, painted from the theme's `--tt-canvas`, `--tt-text` and `--tt-font-mono`, so it follows light and dark themes without a colour of its own. The native views (the thread browser, the test iPhone) step aside while it covers them.

**4. The user can turn it off and set its speed.** Settings → Appearance has a switch, Night falls between Threads and Watcher (on by default), and a dial for its speed, from half speed to twice as fast in quarter steps (0.84 s at 1x). Reduced motion, from the system or Sotto's own setting, skips it, as does a renderer without view transitions.

**5. Held to Owl.** It shows only where both `night-falls` and `watcher` are on. Stable shows neither control and plays nothing; its saved `roomTransition` and `roomTransitionSpeed` stay whole, so sending it to stable restores the user's choice.

## Considered options

The prototype's other nine, each described at the top of its file: Glide, Stay put, Fold, Owl flight, Stretch, Iris, Pan, Zoom and Rise. Drake picked night falls. Shipping it straight to stable was not chosen: new features go through Owl first (ADR-0072).

## Consequences

Two settings, `roomTransition` and `roomTransitionSpeed`, on the patch allow-list. The prototype stays in `docs/prototypes/` as the record of the pick.
