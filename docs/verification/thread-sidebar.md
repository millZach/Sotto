# Thread sidebar: project rows and remembered width

September 19, 2026. Implements Zach's selection of prototype A, retaining Sotto's existing Lucide symbols, including the Settings gear. Selection and acceptance checks are in [the plan](../plans/thread-sidebar.md). Work is isolated on `feat/thread-sidebar-layout`, based on `main` at `da44e954`.

Thread rows keep project grouping and expose provider, status and activity time. More width reveals model and working-copy context. Branch information comes from the working-copy record; pending, detached and failed states never invent a branch. Existing row actions stay reachable by pointer and keyboard. Their temporary overlay at narrow widths follows the existing interaction; complete thread facts remain available in the accessible description.

The shared sidebar starts at 320px, resizes between 260px and 480px while preserving room for the conversation, and collapses to a rail. Width and collapse survive reloads and page changes. Resizing supports pointer drag, arrow keys, Shift for larger steps, Home/End and double-click reset. Local storage failures retain the preference in memory. Settings and Chats keep their own columns.

## Verified on Windows

- `npm run typecheck`, `npm run lint`, `npm run notices:verify`.
- `npm test -- --maxWorkers=2`: 295 files passed, 16 skipped; 3,845 tests passed, 31 skipped. Focused regressions cover working-copy labels, accessible metadata and storage failure. Existing workspace tests distinguish the sidebar divider from pane dividers.
- Built Electron with `npm run build`. Two new `thread-sidebar-resize.spec.ts` journeys passed: pointer/keyboard resize, collapse, persistence, draft retention, unchanged Settings SVG, navigation and bounded controls.
- Expanded/collapsed at 1600x1000, 1280x800 and 820x560 in light and dark, with reduced motion. Inspected rendered captures. An initial clipped room switch in the rail was corrected; the regression checks actual visible control bounds as well as scroll overflow.
- Neighboring project, split-pane, terminal and thread journeys: 12 passed across the five relevant specs. Three asynchronous receipt assertions now poll the same confirmed result instead of reading before it arrives.
- `npm run design:capture`: 10 capture tests passed; 144 exact deterministic design-review tuples verified. Baselines deliberately refreshed for the approved shared-sidebar change.
- The final design comparison passed all 10 journeys, followed by verification of all 144 tuples. An initial Help element-screenshot stability timeout did not recur on the unchanged build; see `design-verify-recheck.log`.
- Separate standards and spec reviews completed. Findings about working-copy labels, accessible metadata and storage failures were fixed and covered by regressions.

## Existing failures and limits

Two neighboring `thread-workspace.spec.ts` cases still fail: a queue fixture sends before the expected paused state, and a skill draft is empty after reload. Both fail at the same assertions on untouched `da44e954` in an independently installed and built baseline worktree. No assertions were weakened to conceal them. This feature does not change their coordinator paths.

macOS reserves space for the native window controls, but was not exercised on a Mac in this Windows session. This is a local source implementation, not an installed release.

## Evidence

Local captures and logs are under the ignored `artifacts/thread-sidebar/` directory. The refreshed authoritative design baselines are tracked under `artifacts/design/app-review/`.

- [Expanded light at 1600](../../artifacts/thread-sidebar/expanded-1600-light.png)
- [Expanded dark at 1280](../../artifacts/thread-sidebar/expanded-1280-dark.png)
- [Collapsed dark at the minimum size](../../artifacts/thread-sidebar/collapsed-820-dark.png)
- [Full suite](../../artifacts/thread-sidebar/suite-final.log)
- [Sidebar and neighboring Electron tests](../../artifacts/thread-sidebar/e2e.log)
- [Neighbor recheck](../../artifacts/thread-sidebar/e2e-neighbor-recheck.log)
- [Clean baseline reproduction](../../artifacts/thread-sidebar/e2e-baseline.log)
- [Design capture](../../artifacts/thread-sidebar/design-capture.log)

## PR review follow-up

Greptile on PR #151 identified the divider action name and detached-checkout icon inconsistency. The divider now says "Resize sidebar" with an accessible keyboard description. Working-copy symbols match the existing header control for ready, detached, pending and failed states. The 43 focused unit tests and both Electron sidebar journeys pass after these changes; typecheck, lint and notices also pass.
