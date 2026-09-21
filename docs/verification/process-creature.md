# Monitoring creature verification

September 20, 2026. Approved C process perch for #125, isolated on feat/monitoring-creature from main at 865e9484. The original shared checkout contained unrelated work; none of that work is included in this feature branch.

## Behavior and provider boundary

A pixel creature walks to the task readout above either thread composer only while the provider confirms active monitoring. No elapsed-time buffer, assistant-text classification, ordinary command or surviving-shell heuristic is used. Pending requests, coordinator attention, errors, closed threads, interruption, disconnect and completion hide it. System or app reduced motion holds an inspection pose; hidden windows stop the animation loop. Drafts, sending and focus retain their existing behavior.

Claude clients emitting explicit monitor/monitor_mcp lifecycle events provide this evidence. SDK 0.3.278 types were inspected as primary evidence, not as a claimed minimum version: https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.278/sdk.d.ts. Native IDs remain adapter-owned; the public observation uses opaque Sotto IDs. A live watch holds its provider session open, but is excluded from main and renderer cache writes and restoration. It grants no authority.

Codex terminal interaction arrives after polling returns and does not establish when a watch ends. Codex, Grok Build and Devin therefore remain hidden. No live account traffic or Apple silicon run was performed: adapter tests use scripted child processes and Electron tests use explicit host fixtures.

## Isolated validation

- npm run typecheck: passed.
- npm run lint: passed.
- npm run runtime:prepare and npm run build: passed.
- npm run notices:verify: passed, 174 components.
- Backend monitoring plus native activity and Claude adapter contract: 50 tests passed.
- Full npm test -- --maxWorkers=2: 4,026 passed, 34 skipped; 308 passing files and 17 skipped. No failures (558.96 seconds).
- Electron monitoring: all three tests passed on the isolated build. Lifecycle, manual/managed draft and send, stable identity, focus, permissions/questions/disconnect, six size/theme combinations, long labels, two tasks, track endpoints, system/app reduced motion and text contrast were checked.
- Final Electron checks: monitoring (three scenarios) and thread-workspace (four scenarios) each ran twice: 6 + 8 passed. Commands: npx playwright test tests/e2e/thread-monitoring.spec.ts --output artifacts/process-creature/results --repeat-each=2, and the same command with thread-workspace.spec.ts and workspace-results.

Root visually inspected the isolated build's dark minimum-size long/multiple capture. The feet meet the composer edge, the task readout remains readable and no input or controls are covered. Text contrast is at least 6.95:1; exact measurements are in [contrast.json](../../artifacts/process-creature/contrast.json). Windows scaling produces image files 1.5 times the measured CSS viewport dimensions. Existing design baselines were not regenerated.

Evidence: [dark minimum](../../artifacts/process-creature/dark-820x560.png), [light minimum with multiple tasks](../../artifacts/process-creature/light-820x560-long-multiple.png), [dark 1280](../../artifacts/process-creature/dark-1280x800.png), [light 1600](../../artifacts/process-creature/light-1600x1000.png), [reduced motion](../../artifacts/process-creature/system-reduced-motion.png), [managed composer](../../artifacts/process-creature/managed-minimum.png).

## Test synchronization

Two existing thread-workspace tests reproduced their failures on untouched main at 865e9484. The first mistook optimistic send feedback for native execution and now waits for the host to report running before queueing. The second directly installed a saved draft while the composer still had a debounced empty save pending. It now waits for accepted delivery and the persisted empty revision before seeding its draft; a running-only guard proved insufficient. The original paused/resume, draft and exactly-once assertions remain. The stronger saved-draft guard passed five baseline repeats. The monitoring geometry test also waits for the old indicator to disappear before starting a new lifecycle. No fixed sleeps or shorter timeouts were added. See [baseline evidence](../../artifacts/process-creature/queue-test-baseline.md).

## Independent review

Separate standards and specification reviews found no remaining code findings in the isolated port. Fixes during implementation included a namespaced React key, removal of an unused history-detail schema field, full-label hover on the task readout, coordinator-attention suppression, renderer cache exclusion and explicit long/multiple/extreme-position tests. The session-reaper glossary and ADR now both describe the live-monitor exemption. Current main's cache throttling and hidden-window behavior were preserved.

## Design source

The user's confirmed composer-only C direction supersedes #125's initial inferred header/sidebar/widget proposal. The [approved throwaway prototype](https://github.com/millZach/Sotto/blob/888c639b/docs/prototypes/process-creature-prototype.html) is archived at prototype/process-creature, commit 888c639b. It stays outside main. The [T3 source study](../research/2026-09-20-t3-monitoring-popup.md) records the lifecycle evidence behind removing the provisional ten-second buffer.

Integration update: main at b8349c12 (question-panel PR #164) was merged before publication. Typecheck, lint and build passed again; 105 affected unit/integration tests and all seven Electron scenarios passed on the combined build. The final Electron run completed in 37.0 seconds. GitHub CI runs the full suite on the combined revision.

## PR review fixes

PR #166 review identified three confirmed issues. Bounded root/nested launch evidence replaces a permanent overflow latch, so fresh root monitors remain eligible after 4,096 launches while unknown ownership stays hidden. Positive, bounded subagent classification replaces retained monitor identities; completed monitors and their delayed progress never enter the agent roster. A ready notification no longer hides a live watch; permission, question and coordinator blocks still do.

After integrating main at 886c0f26 (queued-message PR #165), typecheck, lint, notices and 108 focused unit/integration tests passed. Build and all eight Electron scenarios across thread-monitoring, thread-workspace and queued-steering passed (26.5 seconds). The managed-ready regression preserves the sprite instance, draft and sending. The refreshed managed minimum capture was visually inspected. An independent source review found no remaining issue in the bounded lifecycle fixes. The original published revision passed Windows CI; the new revision must pass again before merge.

A subsequent review found that a fresh activity projector after transcript-cursor resume also needs to accept updates for retained subagent rows. The final implementation uses those rows as positive type evidence and retains exclusions only when a non-subagent start reuses a retained subagent ID. Exclusions are pruned to the bounded activity window. Fresh-projector progress/completion, delayed excluded events, ID reclassification and missed-start shell completion are covered. All 44 focused monitoring/activity/session-log tests and 22 adapter/cursor-catch-up tests passed (five classification tests overlap); typecheck and lint passed again. No UI code changed in this follow-up.
