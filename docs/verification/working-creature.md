# Working creature verification

September 22, 2026. Issue #221, on `feat/working-creature` from `main` at ed2cbc40. The owner picked pose A, the
dispatcher, and the status word **Working** from the throwaway prototype on `prototype/working-creature`
(b7cf5e14, `docs/prototypes/working-creature-prototype.html`), which stays off `main`. The decision is ADR-0023;
the glossary term is **Background work**.

## What the provider sends

The first pass read the shapes off the binary and the SDK because this session's permission classifier refused a
headless `claude -p` that spawns an agent. After review they were captured live, three times, with Claude Code
2.1.280 in empty temporary folders outside the repo, `--model haiku --output-format stream-json --verbose`, and
prompts that asked only for the single words *done* and *ok*. The captures were read and deleted; only the field
names and values below were kept.

- **A background subagent** (Agent tool, `run_in_background: true`): the root assistant frame carries the Agent
  `tool_use` with `parent_tool_use_id: null`, then `{ type: "system", subtype: "task_started", task_id,
  tool_use_id, description, subagent_type: "general-purpose", is_backgrounded: true, spawn_depth: 1, task_type:
  "local_agent" }` whose `tool_use_id` is that call. It ends with `task_updated` `patch: { status: "completed",
  end_time }` and then `task_notification` `status: "completed"` with the same `tool_use_id`. No
  `owned_by_subagent` field is sent.
- **A foreground subagent** (Agent tool, `run_in_background: false`): the same `task_started`, but with
  `is_backgrounded: false`, and the same two bookends. This is the frame the foreground rule keeps out of
  background work.
- **A workflow** (Workflow tool, inline script with one agent step): `task_started` with `task_type:
  "local_workflow"`, `workflow_name`, `description` and the Workflow call's `tool_use_id`, and neither
  `is_backgrounded` nor `spawn_depth`. `task_progress` frames follow with a `description` of the form
  *phase: step*, which the adapter reads as the new label, then the same `task_updated` end patch and
  `task_notification`. Headless, the Workflow tool is refused until it is allowed (`--allowedTools Workflow`).

In all three the `task_started` arrived inside the turn, before its `result`, and a `background_tasks_changed`
frame with the whole live set came just before the start and just before the end. The fake CLI's background
subagent now follows the first shape, including that order. Not seen live: a `task_updated` patch with
`is_backgrounded: true` (Ctrl+B or the SDK's own request), a teammate and a remote agent, which rest on the
SDK's declarations (`@anthropic-ai/claude-agent-sdk` 0.3.270 `sdk.d.ts`) and the emitter in the binary. The
adapter still accepts `workflow` as well as `local_workflow`, since the SDK's task summaries use that label.

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
