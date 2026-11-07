# The collapsed rail keeps Watcher and a Needs you tray

## Status

Accepted October 26, 2026. Drake picked **Owl apart** (column D of `tray.html`) on the tag `prototype/sidebar-rail-mockups`, after comparing ten directions for the collapsed rail (`index.html` on the same tag) and five refinements of the one he took further, the needs-you tray. It is the Owl feature `sidebar-rail` (ADR-0072). The number is provisional until merge (see `docs/agents/domain.md`).

Amended October 27, 2026: the rail's group holds the threads Watcher watches, not the threads that wait on the user, and the tray is gone (below, "October 27, 2026 amendment: Watcher's threads").

Amended October 28, 2026: rounded trays in their own colours replace the rail's hairlines (below, "October 28, 2026 amendment: group trays").

Amended October 29, 2026, by ADR-0135's amendment of the same day: while the Needs you queue is on, a waiting tile pops its thread's Needs you card beside the rail instead of opening the thread, and that card answers through the same store as the pane. "The rail opens threads and answers nothing" holds for the tiles themselves.

Amended November 5, 2026, by Zach's pick of variant C: the rail is 64px, each tile is its provider's mark and status ring, and the waiting and moving threads sit in a tray for each project under its name. It replaces Drake's two letters and the group of Watcher's threads (below, "November 5, 2026 amendment: provider mark, project trays").

Amends ADR-0135 in one place: "The collapsed rail is unchanged" holds while this feature is off. While it is on, the rail says need by putting waiting threads first, in the same Needs you queue order the card uses, with an amber edge (a tray until the October 27 amendment). Nothing in ADR-0004 changes: the rail opens threads and answers nothing.

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

## October 27, 2026 amendment: Watcher's threads

Looking at the tray's refinements again, Drake took the first, the owl heading an amber group, with two changes: the owl stays its own tile at the top, and the group holds the threads Watcher is watching rather than the threads that need him. Four ways to draw that are on the tag `prototype/sidebar-rail-watched` (`prototype/sidebar-rail-mockups/watched.html`, each in dark, light, nothing watched and eight watched): a neutral card, the amber panel kept with the owl counting what waits, a card in the accent, and no box with an owl on each watched tile. Drake picked the last, **No box, owl marks**, on October 27, 2026. Amber then keeps one meaning on the rail, that something waits on you, and the owl on a tile is the mark a watched row already wears in the expanded sidebar.

Items 3 to 5 of the decision become:

3. **Watcher's threads**, while Watcher watches any: each **watched thread** (CONTEXT.md) as a tile with a small owl at its top-left corner, in the muted text colour, directly under Watcher's tile and its hairline, with no box around them. They form a group named "Watched by Watcher", and each tile's tooltip ends with it. A watched thread shows here even once settled. With none watched the group and its hairline are gone.
4. A hairline, then the **other** open threads.
5. Inside each of the two parts the order is what waits on the user first, in the Needs you queue's order and settled threads that wait included, then the moving threads, then the resting ones as smaller tiles in muted text. In the other threads a hairline comes before the resting ones; among Watcher's threads it does not.

A thread that waits on the user, watched or not, takes the attention colour on its whole edge as well as its ring, except the focused thread, whose edge keeps the current look as every focused tile does (its ring still says it waits); the full colour keeps the edge above 3:1 on the light sidebar, where a part-strength edge falls under it. There is no tray and no count: Watcher's tile shows only its own ring, and the Needs you queue in the expanded sidebar keeps the count. Not picked: the neutral card (amber kept one meaning there too, but a card is one more container on a narrow strip), the amber panel (amber would mean two things), and the accent card (in Citrine the accent is also the working arc).

## October 28, 2026 amendment: group trays

Drake did not like the hairlines that split the rail's parts. Of ten ways to draw the split, he took two further, a tray and a tint, and picked the tinted tray, then asked that each group take its own colour. This supersedes the October 27 amendment's "no box" in one respect: a part now sits in a box. Amber still means only that something waits, because a tray is a faint wash, never the attention colour on a tile's edge.

The hairlines go, the one under Watcher's tile included. Each of the rail's parts (Watcher's threads, the other moving threads, the resting threads) that holds two or more tiles sits in a rounded tray, a 7% wash and a 1px edge at 22% in that tray's colour. A part with one tile stands bare. Trays take four theme-derived colours in turn, `--tt-rail-group-1` to `-4` (`tokens.css`): the accent, then the accent turned round the hue wheel at its own lightness and chroma. A grey accent such as Graphite's borrows the Owl night's blue, and a turned hue that lands on red, orange or amber turns further so a tray never reads as an error or as waiting. On Citrine the trays are yellow, blue, green and pink. Not picked: wider gaps, a short dash, a dot, a faded rule, a spine down the group, round tiles, a segmented stack, smaller tiles, and the tinted tiles without a tray.

## November 5, 2026 amendment: provider mark, project trays

Zach chose this. The design pass asked what a tile on the collapsed rail should show at the 820 x 560 minimum window, where six of the capture's 22 tiles fitted above the foot, two letters each, and the thread on screen stood far below them among the resting ones. On November 5 he tried three answers in the design pass's prototype `sotto-council/prototypes/rail-tiles/index.html`, kept outside the repository, each at 820 x 560 in the real window with Split AgentControl open and 22 threads in four projects: A, the rail as it stood, 52px with two letters a tile (Drake's pick in the decision above); B, a 96px rail with the thread's name in each tile, two lines while it waits or works and one once it rests; and C, a 64px rail with the provider's mark in each tile and the waiting and moving threads grouped by project. He picked C. The prototype's stylesheets are Sotto's own at commit `fd7e62643`. Zach's pick replaces Drake's two letters, and with them the group of Watcher's threads from the October 27 amendment; the records above stay as Drake decided them.

**What changed.** While the feature is on, the rail is, from the top:

1. **Expand sidebar** and **Watcher's tile**, as before.
2. A **project tray** (CONTEXT.md) for each project that has a thread waiting on the user or moving, with the project's name at its head, cut short when it is long. The projects come in the order of their first tile, so the project of the first thread in the Needs you queue leads. Inside a tray, what waits on the user comes first, in the queue's order and edged in the attention colour, then what is moving.
3. One tray at the foot for the resting threads, as smaller tiles, after every project's.

Each tile is its thread's provider mark (Claude, Codex, Grok and the rest) with its status ring, in place of the letters, the resting ones smaller. A thread Watcher watches sits in its own project's tray with the owl at its corner, its tooltip ending "Watched by Watcher", and shows even once settled; there is no separate group for Watcher's threads. Every tile keeps its press, its menu, the title as its accessible name, and the current look for the focused thread. Its tooltip is the title, the project and its status, and the keys reaching it name the same words beside the rail. Each project tray is a group named for its project. The rail is 64px, so at an 820px window the thread keeps 756px; on a Mac it stays 80px, where the window's buttons need the room.

**Colour.** Sotto keeps no colour for a project, and the prototype took each tray's colour from where it fell on the rail, which would have given a project a different colour as other projects came and went. So every project tray takes the same theme role, the first of the rail's group colours (`--tt-rail-group-1`), and the resting tray the muted ink, and the project's name at the head tells one tray from the next. The prototype also edged each resting tile in its project's colour; that edge is not drawn. The October 28 amendment's wash and edge stand; its colours in turn do not.

**What it costs.** A tile says where a thread is and who runs it, not which thread it is: three Claude threads in one project look the same until the pointer or the keys reach one. What waits comes first only inside its project, so a waiting thread in a second project sits below the first project's moving ones. The thread loses 12px at the minimum window. A project name much longer than "sotto-site" is cut.

While the feature is off the rail is exactly what it was: 52px, one letter a tile.
