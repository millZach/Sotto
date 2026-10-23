# The terminal's text size steps no longer take seconds

October 23, 2026, issue #1423. The terminal journey (`terminal-search-links-zoom.spec.ts`, tools case) failed at its font zoom poll on main and on every pull request after #1397 merged. The press was not lost. One Control+= step held the renderer for two to five seconds, so the 5 second poll ran out before the saved size changed.

**Cause.** A CDP profile of the renderer after the press put 6.5 of 11 seconds in xterm's DOM renderer measuring characters (`_measure`, then `offsetWidth`). There were 204 forced style and layout passes, at about 35 ms each. A trace of 20 measurement writes showed each pass restyling 368 elements. Removing #1397's rule `.watcher-dock__pill:has(.update-control:not([data-state='idle'], [data-state='checking'])) > :not(.watcher-dock__tab)` brought that to 117. Changed in the live renderer, the same rule's last part restyled 368 elements as `> *` or ` :not(.x)`, 173 as `> span`, 118 as `> .class`, and 117 when the rule only set a custom property on the pill. Chromium restyles everything a `:has()` rule's last part could match after any change to the page. A last part that names nothing can match every element, so the slowdown hit every page, not just Watcher's room.

**Change.** When the pill is open it sets `--watcher-dock-open` and `--watcher-dock-press`, and its controls read them. `tests/unit/renderer/hasSelectors.test.ts` reads every renderer stylesheet and fails on a `:has()` rule whose last part names nothing. Against main's stylesheet it names exactly the old rule.

**Running app.** Built app, dark, reduced motion on. A pill with the dock's own classes was added to the page and its computed styles read after 500 ms:

| State | Links and update opacity | Up-arrow tab opacity | Pill outline clip |
| --- | --- | --- | --- |
| At rest, update idle | 0 | 1 | `inset(21px calc(50% - 28px) 0px round 10px)` |
| Focus inside | 1 | 0 | `inset(0px round 10px)` |
| Update available, no focus | 1 | 0 | `inset(0px round 10px)` |
| Update checking | 0 | 1 | shut, as at rest |

These match the old rule's states. The touch-only `pointer-events` follows the same variable and could not be exercised on this mouse-only machine.

**Journeys.** Before: the spec failed 1 of 1 plain runs. After: 2 of 2 cases passed in each of 3 plain runs, and in 1 run pinned to two cores with a busy-loop competitor (`docs/ci.md`), taking 3.3 minutes. No deadline or input in the journey changed.

**Not this.** #1125, a lost Enter in the drawer's find box after reopening, was filed on October 17, before #1397 merged. It has a separate cause and stays open.
