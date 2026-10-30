# Worker swarms

October 29, 2026. Implements the approved [Workers plan](../plans/watcher-worker-counts.html) and [ADR-0162](../adr/0162-worker-swarms-give-each-angle-a-worktree-and-one-lead.md). The Owl switch is `worker-swarms`; stable leaves it off.

## Local checks

`npm run typecheck` and `npm run lint` passed. `npm run i18n:extract` updated the Settings and Threads catalogs; the interface catalog check passed. No app was launched, and no full suite, e2e spec, design capture or packaging gate was run locally. GitHub CI owns those checks.

The selected existing unit files passed, 586 tests in 19 files. Each Vitest invocation used `NODE_OPTIONS=--no-experimental-webstorage` for Node 26:

| Run | Files | Tests |
| --- | --- | ---: |
| Shared and coordinator | `shared/workerRoles`, `shared/settings`, `main/delegationRemote`, `main/delegationRelay`, `main/hostDelegation`, `main/workerMachineTools`, `main/watcherToolsInFlight`, `main/watcherWakeUp`, `main/workspaceOrganization`, `main/settingsRepository`, `main/watcherPairedReconciliation`, `main/zodSchemaSites`, `renderer/threadDelegation` | 433 |
| Recovery | `main/delegationEnds` | 13 |
| Settings and interface | `renderer/workerRolesSettings`, `renderer/workerMachineSettings`, `renderer/threadSidebarFolders`, `renderer/themeTokens`, `shared/interfaceCatalogs` | 140 |

Paths in the table are under `tests/unit/`, with their existing `.test.ts` or `.test.tsx` extension. The commands were `npx vitest run` with the listed paths, not `npm test`.

The checks cover role defaults and reset, the 1,000-angle input bound, stable preservation, retries, queued cancellation, cross-controller capacity, lead synthesis, recovery, grouping and settlement. Recovery cases include a saved synthesis queue behind a busy machine, a wake-up delivered before its completion marker was saved, a known-unsent angle plan, an uncertain admitted angle, and more than 2,000 saved groups.

## Headless appearance

Temporary render fixtures mounted the real `SettingsView` and `ThreadSidebar` with synthetic host and provider state, then wrote their DOM. Headless Chromium rendered that DOM with the repository's styles, fonts and default light/dark theme tokens. The Settings fixture confirmed that Worker capacity mounts exactly once. These were component renders, not a running Electron app or a live provider session.

The captures below were inspected. Workers stay inside the role cards, Orchestrating has no count control, the ceiling fields remain readable at the minimum size, and long angle titles truncate inside the sidebar. The overflow scan found no content outside the Watcher card; only the existing intentionally hidden accessibility spans had clipped content. The narrow layout scrolls vertically.

| Size | Workers, dark | Workers, light | Capacity, dark | Capacity, light |
| --- | --- | --- | --- | --- |
| 1600 × 1000 | [Capture](../../artifacts/worker-swarms/settings-roles-dark-1600x1000.png) | [Capture](../../artifacts/worker-swarms/settings-roles-light-1600x1000.png) | [Capture](../../artifacts/worker-swarms/settings-capacity-dark-1600x1000.png) | [Capture](../../artifacts/worker-swarms/settings-capacity-light-1600x1000.png) |
| 1280 × 800 | [Capture](../../artifacts/worker-swarms/settings-roles-dark-1280x800.png) | [Capture](../../artifacts/worker-swarms/settings-roles-light-1280x800.png) | [Capture](../../artifacts/worker-swarms/settings-capacity-dark-1280x800.png) | [Capture](../../artifacts/worker-swarms/settings-capacity-light-1280x800.png) |
| 820 × 560 | [Capture](../../artifacts/worker-swarms/settings-roles-dark-820x560.png) | [Capture](../../artifacts/worker-swarms/settings-roles-light-820x560.png) | [Capture](../../artifacts/worker-swarms/settings-capacity-dark-820x560.png) | [Capture](../../artifacts/worker-swarms/settings-capacity-light-820x560.png) |

The sidebar was also inspected open in [dark](../../artifacts/worker-swarms/sidebar-dark.png) and [light](../../artifacts/worker-swarms/sidebar-light.png), and folded in [dark](../../artifacts/worker-swarms/sidebar-closed-dark.png) and [light](../../artifacts/worker-swarms/sidebar-closed-light.png). An angle needing the user remains visible while folded. The new chevron disables its transition for reduced motion; keyboard open and stop behavior is covered by the existing sidebar unit file.

## Review changes

Muse review led to separate stopped and synthesized states, independent sidebar rows for delegated leads, bounded request allocation, and durable synthesis recovery through the same machine queue. The original retry can fill only angles that were never admitted. An uncertain start remains Unknown rather than being repeated.

No live multi-machine swarm or provider completion was exercised locally. Those paths have focused coordinator tests; the full CI gates remain required before merge.
