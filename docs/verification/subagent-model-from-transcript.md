# Subagent models from their own transcripts — 2026-09-22

Tools > Agents said **Model not reported** for the agents a Claude Code thread ran through Workflows and background Agent calls (#230). This note records what the installed CLI actually sends and writes, and how the fix was checked.

## What Claude Code 2.1.280 reports

Two runs in empty temporary folders outside the repository, each `claude -p --model haiku --output-format stream-json --verbose`, output saved beside them in `%TEMP%`. The prompts asked for one background Agent call and one inline workflow with one agent; the only task text was "Reply with the single word hello."

**Background Agent call** (no `model` in the tool input):

- `task_started`: `task_id`, `tool_use_id`, `description`, `subagent_type`, `is_backgrounded`, `spawn_depth`, `task_type: "local_agent"`, `prompt`. No model. The `task_id` is the native agent id (`a3a0e66ba6fe555ae`).
- The launch result (`tool_use_result` on the stream, `toolUseResult` in the parent transcript): `isAsync`, `status: "async_launched"`, `agentId` (the same id), `description`, `resolvedModel: "claude-opus-5"`, `prompt`, `outputFile`, `canReadOutputFile`. The parent ran on Haiku; the agent defaulted to Opus.
- One sidechain `assistant` frame with `parent_tool_use_id` and `message.model` arrived in this run. It is not guaranteed for background agents.
- Then `task_updated` (`patch: { status, end_time }`) and `task_notification` (`status: "completed"`, `output_file`, `usage`).
- Files: `~/.claude/projects/<project-slug>/<session-id>/subagents/agent-<agentId>.jsonl` and `agent-<agentId>.meta.json` (`agentType`, `description`, `toolUseId`, `spawnDepth`, `requestShape`, `requestNonInteractive`; no model). In the transcript the first line is the task (`type: "user"`), then attachments, then the first `type: "assistant"` line with `message.model: "claude-opus-5"`.

**Workflow** (Workflow tool, one agent):

- `task_started`: `task_id` (`wmiwtbf0l`, not a native agent id), `tool_use_id`, `task_type: "local_workflow"`, `workflow_name`, `description`, `prompt`. No model. The binary's schema says `workflow_name` is set only for `local_workflow`.
- The launch result: `status: "async_launched"`, `taskId`, `taskType`, `workflowName`, `runId: "wf_79f40664-5f1"`, `summary`, `transcriptDir`, `scriptPath`.
- `task_progress` frames carry `workflow_progress`, one entry per agent: `type: "workflow_agent"`, `agentId`, `model: "claude-opus-5"`, `state`, timings, `promptPreview`, `resultPreview`. Their `last_tool_name` is the agent's label, which here was the task text.
- No sidechain frames at all.
- Files: `<session-id>/subagents/workflows/<runId>/agent-<agentId>.jsonl` and `.meta.json` (`agentType: "workflow-subagent"`, no model; older runs on this machine recorded an alias such as `opus`), plus `journal.jsonl` (`type`, `key`, `agentId`). The agent transcript has the same shape as a background agent's.

An existing workflow folder from earlier Claude Code work on this machine had the same layout. No frame, file name or model value from these runs is stored in the repository; the fixture writes its own.

## What Sotto does now

A subagent row takes a model as soon as one of these names it: the Agent tool's `model` input, the launch result's `resolvedModel`, a sidechain reply, a `model` on `task_started` should a later CLI add one, a workflow's `workflow_progress`, or the agent's own transcript. A reply or a resolved model replaces an alias typed into the tool input; the transcript is read only while no model is known. A workflow row lists the models its agents ran on, up to four.

The transcript is read on the thread's one-second transcript poll, only for agents still without a model: a background agent's file by its task id or `agentId`, a workflow's files by the `runId` its launch reported. Identifiers that are not short native tokens build no path. Each thread opens at most 16 files per poll, 256 KB each, 8 MB per file in all, and skips any line over 1 MB unparsed. Only lines containing a quoted `"assistant"` are parsed, and only `message.model` is kept; `<synthetic>` notices are ignored. A file stops being read once its model is known, and an agent that has stopped is given up after three reads. Nothing is logged.

The model patches the rows that already show the agent, so the roster keeps one row and its status. The roster's store keeps a model once it has one.

## Checks

- `tests/unit/main/claudeSubagentModels.test.ts`: both file layouts, first assistant line only, a line split across polls, a missing file, giving up a stopped agent, `<synthetic>` and oversized lines, the per-poll file bound, identifiers that would escape the folder, workflow model lists.
- `tests/unit/main/subagentObservations.test.ts`: a workflow row patched in place from its run, later `workflow_progress` models added to it, `resolvedModel` from a stream launch and from replayed `toolUseResult`, a future `task_started` model.
- `tests/integration/claudeSubagentModel.test.ts`: the fake CLI (`tests/fixtures/fakeClaudeThread.mjs`, action `subagent`) emits a workflow-style and a background-style `task_started` with no model anywhere in the stream and writes the agent's transcript. The workspace's roster shows `claude-opus-5-5` on the one existing row, still working, and the saved workspace holds neither the task nor the reply. With the transcript read switched off, both cases fail with the model `undefined`.
