# Agents view implementation

September 20, 2026. Implements the approved B (roomier) design in [the plan](../plans/issue-124-agents-view.md).

## Delivered behavior

Tools has an Agents tab for its selected or pinned thread. Rows show the reported task, model, status and available elapsed time, with nested children and earlier assignments in expandable details. Missing models stay explicit. The small static dot at the upper-left of the outside Tools icon follows working children without opening Tools or changing its tab.

Provider observations feed a separate indexed SQLite roster. Ordinary activity eviction cannot discard its assignments. Restart and disconnect turn unconfirmed work into “Last seen working”; fresh provider evidence restores live status. A parent or spawn tool finishing does not complete its child.

History-off erases saved task and result text. Content-free hashes prevent native replay from restoring erased assignments, including after restart. Erased assignments remain text-free even if they later complete; fresh assignment identities can retain new text. Only text-free subagent identity and classification are retained beside workspace organization. Indexed classification lookups also recognize late completion after activity eviction and restart; task text has no second saved copy.

## Verification

The Windows Electron journey uses scripted provider observations with the real application, preload, coordinator, SQLite storage and renderer. It covers two independently completing agents, returned results, reused identity, nesting, failure, missing model, empty and disconnected states, keyboard tabs and Escape, tab preservation, restart and history deletion. This is not a live native-provider acceptance claim.

Light and dark captures cover 1600×1000, 1280×800 and the exact 820×560 minimum, plus a 380-pixel Tools panel. The rendered checks found no horizontal overflow and sampled text contrast of at least 6.95:1. Reduced motion disables the detail animation. Root visual review inspected the dark roster and narrow light assignment history; the separate UI review also checked visual and keyboard order. A narrow toolbar ordering issue was fixed and the rebuilt app was checked again.

Representative captures and measurements:

- [Dark roster](../../artifacts/agents-view/app-roomy-1280-dark.png)
- [Minimum light roster](../../artifacts/agents-view/app-roomy-820-light.png)
- [Earlier assignment](../../artifacts/agents-view/app-roomy-history-820-light.png)
- [Disconnected](../../artifacts/agents-view/app-disconnected-820-light.png)
- [Rendered measurements](../../artifacts/agents-view/app-visual-checks.json)

Structural regressions cover 5,000 saved assignments, 20 live agents and 600 updates across three threads. Small and large archives perform the same 1,830 indexed reads, 600 row writes and 600 assignment writes, with zero archive-page reads during updates. Separate provider tests push 5,000 assignments through Claude and Codex, evict ordinary activities, and verify compact identity caches plus late lifecycle/reuse. Renderer tests verify unaffected row identity, unrelated-thread notification isolation, bounded live caches and stopped hidden/uncertain clocks. [Performance methodology and measurements](../perf/issue-124-agents.md) distinguish main-process measurements from the renderer queue-feedback gate.

Independent standards and specification reviews found and fixed Claude error status, provider payload retention, oversized Codex metadata truncation, erased-text replay and duplicate workspace persistence. The final standards re-review reports no remaining material findings.

## PR branch verification

The issue-only branch starts from main at `93b2f0f5`, preserving the merged monitoring lifecycle and lazy terminal loading.

- `npm run typecheck`, `npm run lint`, and `npm run notices:verify` passed (174 notice components).
- `npm test -- --maxWorkers=2`: 317 files and 4,124 tests passed; 17 files and 34 tests skipped. No failures. Duration 338.44 seconds.
- `npm run build` and Playwright `subagents`, `tools-sidecar`, and `thread-monitoring`: five tests passed in 40.6 seconds. Final root visual inspection covered the dark roster and minimum light assignment history; the separate UI review covered all six size/theme captures.
- Final opt-in performance gates: four files and 62 tests passed. The five-sample isolated-branch benchmark passed its 250 ms heartbeat gate; see the linked performance note for measured overhead and limits.
- Real scripted Claude child-process tests cover workspace restart, saved transcript cursor, start-event eviction beyond 2,000 activities, monitor exclusions and streamed resume. Bounded hashed aliases preserve agent identity across restart without saving task text in workspace classification records.
- Independent standards and spec re-reviews found no remaining material issues after the restart/classification and streamed-reuse fixes.

Live paid providers and macOS were not exercised. Existing design baselines were not regenerated for this PR; the new Agents evidence is retained separately.
