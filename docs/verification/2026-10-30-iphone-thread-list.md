# iPhone thread list and the Duo rail's ground verification

October 30, 2026, on `feat/iphone-threads-list`. This is ADR-0151's second October 30 amendment and ADR-0051's matching one, Zach's picks from `docs/prototypes/iphone-threads-list-prototype.html`, issue #1849, and Zach's report that the Duo's rail didn't match the theme. Captures were taken on GitHub's `xcode-27` runner from the throwaway branch `chore/ios-captures-threads-list`, with the Debug-only `--ui-fixture`, `--ui-still` and `--ui-watcher`:

- the iPhone Duo on iOS 27.1, folded and unfolded by the posture tool from the tag `prototype/iphone-duo-layout`;
- an iPhone SE (3rd generation) and an iPhone 17 Pro Max on iOS 27.0, since the 27.1 runtime offers no iPhone but the Duo. The Max was turned by the app.

All images are in `artifacts/iphone-threads-list/`.

## The thread list

1. **SE, Threads** (`se-threads.jpg`): the list, with the computer menu beside search, one note for Studio Mac and no counts line. The first Needs you row starts about 38% of the way down the screen, inside the top half #1849 asks for.
2. **Max, Threads** (`max-threads.jpg`, and with a question waiting in `max-threads-question.jpg`): Needs you, Working now and Recent rows, each with its light, provider mark, line and age. A Needs you row is a row like the others, with no choices on it.
3. **Max held sideways** (`max-sideways.jpg`): the list at the 680-point reading width, not columns.
4. **Duo folded, Threads** (`folded-threads.jpg`): the same list, with New thread on the rail.
5. **Duo sideways, a thread** (`sideways-thread-sidebar.jpg`): the sidebar is the same rows, the open thread on the accent chip.

The unfolded Duo's Threads page with no thread open keeps its columns of cards, as on `main`.

## The rail's ground

Before, the rail in the strip painted the plain page ground, while the page beside it carries the theme's wash, so the strip read as a darker panel down most of the folded screen. In Sotto dark, at the top of the folded screen, the strip measured `4,5,7` before and `14,19,16` after, with the page beside it at `10,13,13`. Each image pairs `main` (left or top) with this branch (right or bottom):

- folded: `rail-folded-glass-dark.jpg`, `rail-folded-sotto-dark.jpg`, `rail-folded-citrine-light.jpg`, `rail-folded-clay-dark.jpg`;
- unfolded and sideways: `rail-sideways-glass-dark.jpg`, `rail-sideways-citrine-light.jpg`.

After, the wash runs on under the rail and there is no edge at the strip, in every theme and in light and dark.

## Limits

- **Not seen:**
  - a real Duo or iPhone;
  - VoiceOver;
  - a delegated thread's Needs you row, which the fixture doesn't hold;
  - several unreachable computers, since the fixture has one;
  - the accessibility text sizes.
- **Thread pages are unchanged.** A thread's own wash spans only its reading column, so a thread beside the sideways rail still has a plain margin before the strip, as it has on either side.
