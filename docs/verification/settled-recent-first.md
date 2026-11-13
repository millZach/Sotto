# Settled, newest settled first

November 13, 2026. Implements the November 13 amendment of [ADR-0201](../adr/0201-the-threads-sidebar-groups-open-threads-by-status.md): by status, the Threads sidebar's Settled shelf is one list with no project folders, the thread settled last first. Zach picked each part from the prototype kept as the tag `prototype/settled-recent-first`.

## In the running app

The built app was launched on the Windows laptop on the design fixture (`design-threads`), from the default settings, with Playwright driving it: `npm run build && npx playwright test tests/e2e/settled-recent-first.spec.ts`, 1 passed. The captures are four of the eight that run wrote.

| What | Capture |
| --- | --- |
| The shelf at 1280 × 800, dark, with a row settled with its project pointed at | [shelf-1280-dark.png](../../artifacts/settled-recent-first/shelf-1280-dark.png) |
| The same at 1600 × 1000, light | [shelf-1600-light.png](../../artifacts/settled-recent-first/shelf-1600-light.png) |
| 820 × 560, the whole sidebar opened over the conversation | [shelf-820-dark.png](../../artifacts/settled-recent-first/shelf-820-dark.png) |
| Thirty-eight settled threads: the thirtieth row, then **Show 8 more**, light | [show-more-light.png](../../artifacts/settled-recent-first/show-more-light.png) |

What the journey did, and what the captures show:

- **No folders, newest settled first.** The fixture's four settled threads stand in the order they were settled, under no folder. Settling Grok voice previews from its row in Recent put it first, above three threads that last moved after it did.
- **The time says when it was settled.** The thread settled in the run shows its clock and its tooltip starts "Settled"; the fixture's threads, settled in July, show their dates ("Jul 12").
- **Restore project on the row.** With the project `notes` settled, Weekly note and Notes cleanup stand in the list. Pointed at, Weekly note offers **Restore project notes** and no Restore of its own. **Restore project** in Notes cleanup's row menu brought both threads back, and Weekly note returned to the open groups.
- **Thirty at a time.** With thirty-eight threads settled, the shelf drew thirty and **Show 8 more**. Down from the thirtieth row reached it, Enter drew all thirty-eight, and the control went. Searching "Put away" listed all thirty-three matches with no **Show more**.
- **Sizes.** Checked at 1600 × 1000 and 1280 × 800 in dark and light, and at 820 × 560 with the sidebar opened over the conversation, where no row is wider than the list.

## Design baselines

`threads-search.png` and `threads-search-light.png` change on purpose: the search opens the Settled shelf, which showed a `workshop` folder over Release notes 1.4 and now shows the row alone, with the date it was settled. Both were retaken on the Windows laptop with `npm run design:capture`, and their two entries in the manifest carry the new hashes.

That run also rewrote thirteen baselines this change does not touch: `appearance-system-dark`, `appearance-system-light`, `dictate-journal-more`, `dictate-journal-open`, `dictate-journal-open-light`, `dictate-listening-light`, `dictate-reduced-motion-light`, `focus-switch`, `settings-appearance`, `setup-iphone`, `threads-new-thread-chooser-light`, `threads-open-running-light` and `threads-stopped`. They were put back as committed and are not part of this change; why they differ on this laptop was not looked into.

## Not checked here

- Reduced motion: the shelf adds no motion of its own.
- A remote host's settled threads in the same list: the order rule is covered by a unit test, not a paired forge.
- Zach's own shelf of 387 threads: the journey used thirty-eight.
