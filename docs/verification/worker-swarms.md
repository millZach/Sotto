# Worker swarms

October 29, 2026. Implements the approved [Workers plan](../plans/watcher-worker-counts.html) and [ADR-0162](../adr/0162-worker-swarms-give-each-angle-a-worktree-and-one-lead.md). The Owl switch is `worker-swarms`; stable leaves it off.

## Local checks

`npm run typecheck` and `npm run lint` passed. `npm run i18n:extract` updated the Settings and Threads catalogs; the interface catalog check passed. No app was launched, and no full suite, e2e spec, design capture or packaging gate was run locally. GitHub CI owns those checks.

The selected existing unit files passed, 593 tests in 20 files. Each Vitest invocation used `NODE_OPTIONS=--no-experimental-webstorage` for Node 26:

| Run | Files | Tests |
| --- | --- | ---: |
| Shared and coordinator | `shared/workerRoles`, `shared/settings`, `main/delegationRemote`, `main/delegationRelay`, `main/hostDelegation`, `main/workerMachineTools`, `main/watcherToolsInFlight`, `main/watcherWakeUp`, `main/workspaceOrganization`, `main/settingsRepository`, `main/watcherPairedReconciliation`, `main/zodSchemaSites`, `renderer/threadDelegation`, `shared/clientIdentity` | 439 |
| Recovery | `main/delegationEnds` | 14 |
| Settings and interface | `renderer/workerRolesSettings`, `renderer/workerMachineSettings`, `renderer/threadSidebarFolders`, `renderer/themeTokens`, `shared/interfaceCatalogs` | 140 |

Paths in the table are under `tests/unit/`, with their existing `.test.ts` or `.test.tsx` extension. The commands were `npx vitest run` with the listed paths, not `npm test`.

The checks cover role defaults and reset, the 1,000-angle input bound, stable preservation, retries, queued cancellation, cross-controller capacity, lead synthesis, recovery, grouping and settlement. Recovery cases include a saved synthesis queue behind a busy machine, a wake-up delivered before its completion marker was saved, a known-unsent angle plan, an uncertain admitted angle, more than 2,000 saved groups, and synthesis after six failed delivery attempts without a restart. Sidebar grouping is checked after projecting paired-host identities as well as locally.

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

Muse review led to separate stopped and synthesized states, independent sidebar rows for delegated leads, bounded request allocation, and durable synthesis recovery through the same machine queue. Final review also caught unqualified paired-host lead IDs and a five-attempt delivery limit that prevented later synthesis; both now have regression coverage. The original retry can fill only angles that were never admitted. An uncertain start remains Unknown rather than being repeated.

No live multi-machine swarm or provider completion was exercised locally. Those paths have focused coordinator tests; the full CI gates remain required before merge.


## PR #1814 CI follow-up

Read the failed Windows and Linux test jobs in [run 40992305570](https://github.com/millZach/Sotto/actions/runs/40992305570), for `fb45edb74`. The failures had four causes:

- The swarm field was serialized even on ordinary threads, changing their progress fingerprints and adding serialization on every observation. Ordinary threads now use the original fingerprint bytes and cost. The existing fingerprint unit file pins both that cost and changes to swarm progress; no performance budget was raised.
- Cancelling a queued check lost the established machine-specific receipt. Checks keep that wording; queued workers use their own receipt.
- The machine-ceiling Settings test edited before initial host loading finished. It now flushes that initial update before editing.
- The move test read fence cleanup before the terminal-state save finished. It now waits for cleanup. A targeted rerun also exposed the same ordering assumption in its Watcher-news test, which now waits for the news it asserts.

Main did not carry these fixes. #1812 then merged as `07604b760`; its changes conflicted with this branch, so main was merged in. Speed and Workers remain independent saved choices and survive changes or resets to the other field. Swarm leads and angles carry the resolved speed, including queued and remote receipts. A separate read-only check found no remaining speed propagation gap.

After the merge, `npm run typecheck` and `npm run lint` passed. The nine existing unit files below passed 110 tests in total; `threadMoves` and `workerRolesSettings` were rerun after their final corrections. The last test edits also passed focused lint. `npm run i18n:extract` completed without changing the merged catalogs, and the catalog unit file passed.

- `shared/workerRoles`, `shared/interfaceCatalogs`
- `main/watcherProgressFingerprint`, `main/watcherToolsInFlight`, `main/delegationEnds`, `main/threadMoves`
- `renderer/workerRolesSettings`, `renderer/workerRolesOrchestrating`, `renderer/workerMachineSettings`

The six Workers captures above were refreshed and inspected after bringing in #1812's Speed controls. Dark and light passed at 1600 × 1000, 1280 × 800 and 820 × 560, with no content extending beyond the Watcher card. The capacity captures were unchanged byte for byte. The headless component render also passed; no Electron app, integration suite, performance suite, e2e spec or local CI gate was launched. GitHub will verify the full combination on the next push.
