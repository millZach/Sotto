# A workflow's agents in the subagent roster — 2026-09-26

A Claude thread ran a workflow of six agents, and Tools > Agents showed one row for it (#339). That row was named after whichever agent reported last, and its model line read "claude-opus-5-5[1m], opus". The user picked variant C, Strip, from the mock-up on `prototype/workflow-agent-rows`, and the plan is [2026-09-26-workflow-agent-rows.md](../plans/2026-09-26-workflow-agent-rows.md). This note records what the running app now shows and how that was checked.

## What Claude Code sends

Claude Code 2.1.280 was read for how it fills `workflow_progress`. On every `task_progress` frame that carries the list, it lists every agent the run has queued, as `type: "workflow_agent"` with:

- `index`, from queueing onwards;
- `label` and `phaseTitle`;
- `agentId`, once the agent starts;
- `model`, the launch's alias while the agent is queued and the resolved name once it runs;
- `state`: `start`, `progress`, `done` or `error`, plus `skipped` when the user skipped it;
- `startedAt` and `durationMs` in milliseconds;
- `promptPreview` and `resultPreview`, which Claude Code cuts itself and ends with "…";
- `error`.

An agent waiting for a place to start is sent as `state: "start"` with `queuedAt` and no `startedAt`, or with no state while a rate limit holds it; retries carry `attempt`. The same list holds `workflow_phase` and `workflow_log` entries, which Sotto skips. A frame may leave the list out when only progress changed. Claude Code writes none of these frames to the session transcript, so after a restart a workflow's agents come back from the saved roster, not from replaying the transcript. The frame's `description` is `"<phaseTitle>: <label>"` of the agent that reported last, which is why the old row's title kept changing. These field names come from the CLI's own emitter; no task text from a run is stored here.

## What Sotto does now

- **The workflow's row.** It is named for the workflow's launch, with its `workflow_name` as secondary text, and progress frames no longer rename it. It carries a count of its agents by state.
- **Each agent's row.** Each agent is a row under the workflow, keyed by its index. It has its label, status, model, start time, duration, and task and result from the previews. A retry is a new assignment of the same row, so it reads as working again without the failed attempt's result.
- **Status.** The workflow stays working until its own notification. That notification settles it. Any agent still working then reads finished if the run completed and interrupted otherwise.
- **Waiting agents.** An agent still waiting to start is counted in the total and drawn at the end of the strip. It gets a row, and counts as working, only once it starts.
- **Models.** An agent's model is the latest one reported, so the resolved name replaces the alias. An agent the stream names no model for has its own transcript watched, at `subagents/workflows/<runId>/agent-<agentId>.jsonl`, and the run folder is no longer read for the workflow.
- **Counting.** The workflow's row is not counted as an agent, so a workflow of six adds six to the roster's count.
- **In the roster.** The workflow is one row, with a strip and its count. Past forty agents the strip joins neighbouring segments in the same state. Pressing the row opens the workflow page, where its agents are ordinary rows. "All agents" or Escape goes back, and focus returns to the row. Reduced motion stops the working segments' pulse.

## Automated checks

- `tests/unit/main/subagentObservations.test.ts` feeds a workflow start, its launch and progress frames listing three agents in different states. The result is one workflow row named for the workflow, three agent rows with their own labels, states and models, and a title that stays put. Replaying the same frames gives the same rows. A frame without the list keeps them. A projector resumed from the saved classification alone keeps the agents' identities. One agent failing leaves the run working, and the notification settles the run and the agent still working. An alias gives way to the resolved name. An agent with no model has its own transcript watched and patched.
- `tests/unit/main/subagentStore.test.ts` checks that the workflow's row is kept out of the summary, including after a disconnect, and that its count survives a sighting without one.
- `tests/unit/main/claudeSubagentModels.test.ts` reads one workflow agent's file by run and agent id.
- `tests/integration/claudeSubagentModel.test.ts` covers a workflow's agent with no model in the stream: through the fake CLI, it gets its model from its own transcript, on its own row under the workflow's.
- `tests/unit/renderer/subagents.test.tsx` covers:
  - the strip and count in words;
  - the page with the full label on each title;
  - distinct model names;
  - Escape closing an open agent first, then leaving the page with focus back on the row;
  - the strip falling back to the counts while agents are still loading.

## In the running app

`tests/e2e/workflow-agent-rows.spec.ts` reports a workflow of six agents and one ordinary agent to the built app, then moves them on. Every capture goes to ignored `artifacts/e2e-runs/workflow-agent-rows-run/` by default, or `artifacts/workflow-agent-rows-run/` with `SOTTO_E2E_EVIDENCE=publish`. The ones below are copied to `artifacts/workflow-agent-rows/`. See [E2e evidence](../ci.md#e2e-evidence) for the root override.

- `roster-strip-1600-dark.png`: the roster with the workflow as one row. The strip shows one failed, three finished and two working, and the count reads "3 of 6 finished · 1 failed". The line of chrome reads "7 agents · 2 working".
- `workflow-page-1600-dark.png`, `workflow-page-1280-light.png`, `workflow-page-820-dark.png` and `workflow-page-820-light.png`: the workflow page at each size.
  - The chrome has **All agents**, the workflow's title and its count.
  - Under the strip are the count, the elapsed time, `phase-1-perf` and "claude-opus-5-5[1m], claude-sonnet-5".
  - The workflow's task and latest update follow, then the six agents. #311 is open on its task and **What happened**.
- `workflow-page-tools-380-light.png`: Tools at its 380px minimum. The back button keeps its icon and the title ellipsizes.
- `roster-strip-finished-380-light-reduced.png`: after the run's notification, with reduced motion on. The row reads **Finished** with "5 of 6 finished · 1 failed", and the chrome says "None working".

At each of 1600x1000, 1280x800 and 820x560, in dark and light, the spec checks both the roster and the workflow page for three things: the panel and the page do not scroll sideways, the lowest text contrast on the panel is at least 4.5:1 (7.76 dark, 6.26 light; `checks.json`), and there were no page errors. It also checks that the running segments pulse with motion on and stop with reduced motion.

Not checked: a real Claude Code workflow in the running app. The stream's shape was read from the CLI and is exercised through the projection and the fake CLI; a live run is a hand test on the pull request.
