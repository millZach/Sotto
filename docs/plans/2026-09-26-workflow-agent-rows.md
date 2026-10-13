# A workflow's agents in the subagent roster (#339)

A Claude thread that runs a workflow of six agents shows one row in Tools > Agents. That row is named after whichever agent reported last, and its model line names one model twice. This plan gives the workflow its own row and each agent a row under it.

## The pick

The HTML mock-up is `docs/prototypes/workflow-agent-rows-prototype.html` on the branch `prototype/workflow-agent-rows`. It offered today's single row and three variants: nested rows, a group with a count, and a strip. The user picked **variant C, Strip**:

- The workflow stays one roster row. Its title is the launch's description, and a strip under it has one segment per agent, coloured by state (working, finished, failed). Its meta line reads "Workflow" and the count, e.g. "4 of 6 finished · 1 failed".
- Pressing the row opens the **workflow page** inside the Agents tab. The line of chrome gets an "All agents" back button, the workflow's title and the count. The page shows the strip, the count, the elapsed time, the models its agents ran on, the workflow's task and its latest update or result, then its agents as ordinary roster rows. Each agent row opens its own task and result.
- "All agents", or Escape when nothing inside is open, goes back to the roster and returns focus to the workflow's row. Reduced motion stops the working segments' pulse.

## Decisions

1. **Name.** The workflow's row takes the launch's description. The workflow's own name (`workflow_name`) is secondary text when the stream gives one. A progress frame never renames it.
2. **Status.** The workflow's status comes from its own task frames. One agent finishing leaves it working. Its `task_notification` settles it. Any agent still working then reads finished when the run completed and interrupted otherwise, so a failed run does not count agents it never heard from as failed. A completed run with a failed agent reads "Finished", and the count carries the failure. An agent still waiting for a place to start is counted in the total and drawn at the end of the strip, and has no row until it starts, so the roster's "N working" counts only agents that are running.
3. **Labels.** Each agent's label shows as the CLI sends it, ellipsized, with the full label in the row's accessible name and tooltip.
4. **Previews.** The task and result come from `promptPreview` and `resultPreview`. Claude Code cuts a long preview itself and ends it with "…", so the text shows as it comes and never claims to be complete. An agent's error is its result when it failed.
5. **Missing model.** An agent the stream names no model for reads "Model not reported", as elsewhere in the roster. Its own transcript, `subagents/workflows/<runId>/agent-<agentId>.jsonl`, is watched for one. The run folder is no longer read for the workflow's row.
6. **Model names.** An agent's model is the latest one reported, so a resolved name replaces the launch alias. The workflow page lists distinct models and drops an alias (`opus`) once another agent's resolved name (`claude-opus-5-5`) covers it. The workflow's row no longer carries a joined model line.
7. **Identity.** An agent's row is keyed by its index in the workflow, which Claude Code sends from the moment the agent is queued. `agentId` arrives only once the agent starts, and a retry gets a new one. `agentId` names the transcript. A retry (`attempt` above 1) is a new assignment of the same row, so it reads as working again, with **Run 2**, rather than keeping the failed attempt's result.
8. **Opening and size.** The workflow page opens nothing by default. A finished workflow stays one row. The page lists the agents the roster has loaded, with the roster's own "Load earlier agents" when there are more. The count comes from the workflow's row, so it is right before every agent has loaded. Past forty agents the strip joins neighbouring segments in the same state, so it keeps to its row.
9. **Counting.** The chrome's "N agents" counts a workflow's agents and not the workflow, so a workflow of six adds six.

## Steps

- [x] Mock-up with variants and the pick, recorded here and on the issue.
- [x] Main: project `workflow_progress` into child observations under the workflow (`claudeActivity.ts`), keep the workflow's name and status, and watch each agent's own transcript.
- [x] Shared and store: a row can be a workflow with its agents' counts; the summary leaves a workflow out of its totals.
- [x] Renderer: the strip row, the workflow page and its chrome, Escape and focus return, and reduced motion.
- [x] Tests: projection, replay and cursor resume, settling, model names, store counts, renderer and e2e captures.
- [x] Docs: `CONTEXT.md` (Workflow page), `docs/guide.md`, the verification note.
