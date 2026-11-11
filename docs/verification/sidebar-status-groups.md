# Sidebar status groups

November 10, 2026. Implements [ADR-0201](../adr/0201-the-threads-sidebar-groups-open-threads-by-status.md): the Threads sidebar groups open threads as Working now and Recent under the Needs you card, by default, with Settings › Threads › **Group threads in the sidebar** to go back to project folders. `needs-you-queue` is sent to stable with it. Zach picked the look from [the prototype](../prototypes/sidebar-status-groups-prototype.html), variant D.

## In the running app

The built app was launched on forge (Linux, under `xvfb-run` at 1920×1200) on the design fixture (`design-threads`), from the default settings, with Playwright driving it. These are Linux renders, not the Windows design baselines.

| What | Capture |
| --- | --- |
| Status groups, dark, 1600 × 1000 | [status-dark-1600.png](../../artifacts/sidebar-status-groups/status-dark-1600.png) |
| Status groups, dark, 1280 × 800 | [status-dark-1280.png](../../artifacts/sidebar-status-groups/status-dark-1280.png) |
| Status groups, light, 1600 × 1000 | [status-light-1600.png](../../artifacts/sidebar-status-groups/status-light-1600.png) |
| Status groups, light, 1280 × 800 | [status-light-1280.png](../../artifacts/sidebar-status-groups/status-light-1280.png) |
| 820 × 560, the sidebar standing as the rail | [status-dark-820.png](../../artifacts/sidebar-status-groups/status-dark-820.png) |
| Working now folded from its head, light | [status-light-folded.png](../../artifacts/sidebar-status-groups/status-light-folded.png) |
| Settings › Threads › Sidebar, By status chosen | [settings-dark.png](../../artifacts/sidebar-status-groups/settings-dark.png) |
| After choosing By project: the folders, as before | [project-light.png](../../artifacts/sidebar-status-groups/project-light.png) |

What they show: the Needs you card stands under the search with the waiting approval and the failed turn; Working now holds Footer links and Weekly note, each naming its project (sotto-site, notes) before its Working word; Recent holds the two threads in Needs you, reading ↑ In Needs you with their project, and Grok voice previews as a one-line resting row; Settled is folded at the foot. Choosing By project in Settings changed the sidebar at once, with no restart. At 820 × 560 the sidebar stands as the rail, unchanged.

## Not checked here

- The Windows design captures were not regenerated. The populated Threads captures change on purpose (status groups, and the Needs you card in place of the **need attention** line on stable); they need `npm run design:capture` on the Windows PC.
- Reduced motion: only the existing ring animation moves, and its reduced-motion rules are unchanged.
- A real remote host: the badge on a remote row is covered by a unit test, not a paired forge.
