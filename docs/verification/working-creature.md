# Working creature verification

September 22, 2026. Issue #221, on `feat/working-creature` from `main` at ed2cbc40. The owner picked pose A, the
dispatcher, and the status word **Working** from the throwaway prototype on `prototype/working-creature`
(b7cf5e14, `docs/prototypes/working-creature-prototype.html`), which stays off `main`. The decision is ADR-0023;
the glossary term is **Background work**.

## What the provider sends

The brief asked for one cheap live capture of the frames with the installed CLI. It was not made: this session's
permission classifier refused to launch a headless `claude -p` that spawns an agent, with or without
`--dangerously-skip-permissions`, and that refusal was left standing. The shapes below come from the two primary
sources on this machine instead, and no prompt text was written anywhere.

- **The CLI's own emitter.** Claude Code 2.1.280 (`~/.local/bin/claude`) builds the frame as
  `{ type: "system", subtype: "task_started", task_id, owned_by_subagent, tool_use_id, description, subagent_type,
  is_backgrounded, spawn_depth, task_type: e.type, workflow_name, prompt, skip_transcript, ambient? }`. The
  workflow task's `type` is `local_workflow`; `workflow` appears only as the friendly label of the SDK's task
  summaries. `owned_by_subagent` is set only for a `local_bash` started by an agent.
- **The Agent SDK's declarations.** `@anthropic-ai/claude-agent-sdk` 0.3.270 `sdk.d.ts`: `SDKTaskStartedMessage`
  (`is_backgrounded` is false for a subagent the spawning tool call blocks on and is set for `local_agent` and
  `local_bash`; `spawn_depth` is 1 for a top-level spawn; `workflow_name` only for `local_workflow`),
  `SDKTaskUpdatedMessage` (`patch.status`, `patch.end_time`, `patch.is_backgrounded` when a foreground task is
  moved to the background), and `SDKTaskNotificationMessage` (`status: completed | failed | stopped`).

Whether the Workflow tool runs headlessly was not checked. The adapter accepts both `local_workflow` and
`workflow`, and the unit tests cover both. The fake CLI now emits a `local_agent` start shaped like the emitter
above, after its `result`.

## Behaviour

A root task of type `local_workflow`/`workflow`, `local_agent`, `in_process_teammate` or `remote_agent`, running
or with no status, is background work. `shell`, `local_bash`, `mcp_task`, `plan`, `dream`, `scheduled` and
unknown types are inert. Nested, `ambient`, `skip_transcript`, `owned_by_subagent` and `spawn_depth` above one
are excluded, as is a subagent started with `is_backgrounded: false` until a patch moves it to the background.
The `result` frame leaves it alone; its `task_notification`, a terminal status, an end time, an interrupt, an
error result, a disconnect, a process exit and a restart clear it. While any is live the session reaper leaves
the session running. A transcript replay never produces it, and neither the workspace file nor the shell cache
keeps it.

Above the composer the creature stands at the readout end facing left, its near arm lifting, its eyes blinking,
and small agents (the prototype's 12 × 10 sprite, one per task, at most six) walk out from behind it and off the
track's clipped left edge on a loop. Under system or app reduced motion they stand still in a line a stride
apart, and a change in their number repaints at once. The readout names the first task, lists every task in its
hover title, and reads **Working** or *Working · N agents*. A monitoring task takes the track first, background
work next and a held action last; all three hide for a pending request or question, a coordinator block, an
error, a closed thread and a disconnect. It is the same polite `role="status"` region, with nothing focusable.

## Checks

- Unit, `tests/unit/main/claudeBackgroundWork.test.ts`: each accepted and inert type, ownership, foreground and
  backgrounding, the turn's end, each bookend, pause and resume, separate bounds of 64. The monitoring tests
  are unchanged and pass.
- Unit, `tests/unit/renderer/threadsView.test.tsx`: the readout's wording and title, one to six small agents,
  the order monitoring, working, held, and every hiding condition. Workspace and shell-cache exclusion in
  `monitoringWorkspace.test.ts` and `agentShellAssembly.test.tsx`.
- Integration: the adapter contract's new case passes for Claude stream-json and skips for Codex, Grok, Devin
  and the fake provider; `claudeMonitoring.test.ts` covers interrupt, error result, disconnect and reconnect,
  and the reaper holding a working session; the transcript catch-up and subagent recovery tests assert that
  replayed `local_agent` starts produce none.
- Electron, `tests/e2e/thread-monitoring.spec.ts`, the new scenario: the draft survives, the creature holds the
  readout end within 2 px, the small agents move and set out from the creature's edge, the count reads 3 and 7, six
  are drawn for seven, a watch takes the track and gives it back, a permission hides it, every size in both
  themes fits with nothing overflowing, the held line spaces six agents on the minimum track, and a disconnect
  removes it. Text contrast on the readout is at least 6.95:1 ([contrast.json](../../artifacts/working-creature/contrast.json)).

Evidence, each viewed: [dark minimum, reduced motion](../../artifacts/working-creature/dark-820x560.png),
[light minimum, reduced motion](../../artifacts/working-creature/light-820x560.png),
[dark 1600](../../artifacts/working-creature/dark-1600x1000.png),
[light 1280](../../artifacts/working-creature/light-1280x800.png),
[dark minimum, seven agents in motion](../../artifacts/working-creature/dark-820x560-seven-agents.png). Windows
scaling makes the images 1.5 times the CSS viewport. Design baselines were not regenerated: no captured design
state carries background work.
