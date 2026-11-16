# Grok Build background work, live probe

November 15, 2026, issue #2633. Grok Build 1.0.77 (`50ca579fa996`), signed in on forge, driven over ACP the way Sotto starts it (`--permission-mode default agent --no-leader stdio`). The script sent `initialize`, `session/new` in an empty folder, and one prompt. The prompt asked Grok to start one subagent in the background to run `sleep 45` and write `done.txt`, then end its turn without waiting. Each permission request was allowed once. Every frame was logged with its time; the times below are milliseconds from the start.

## What Grok sent

| ms | Frame | What it says |
|---|---|---|
| 4,457 | `session/update` `tool_call` `spawn_subagent` | `rawInput.background: true`; `_meta.subagentBackground: true` |
| 4,457 | `session/request_permission` | to spawn the subagent |
| 4,471 | `tool_call_update` `completed` | "Subagent started in background", with its `subagent_id` in the text |
| 4,478 | `_x.ai/session_notification` `subagent_spawned` (parent's session) | `subagent_id`, `attempt_id`, `parent_session_id`, `parent_prompt_id`, `child_session_id`, `subagent_type`, `description`, `model`; no background flag |
| 4,717 on | `session/update` on the child's own session | the subagent's own prompt and tool calls |
| 6,450 | `turn_completed` (parent) | `prompt_id` of the user's prompt, `stop_reason: end_turn` |
| 6,511 | `session/prompt` answered | `end_turn`, while the subagent runs |
| 6,717 on | `subagent_progress` (parent's session) | about every 8 s: duration, turns, tool calls, tokens |
| 8,147 | `session/request_permission` (parent's session) | the subagent's own command; asked on the parent's session |
| 38,201 | `_x.ai/task_backgrounded`, `background_tasks` (child's session) | the subagent's command moved to the background after 30 s; the list gives each task's `status` |
| 53,201 | `_x.ai/task_completed`, `background_tasks` (child's session) | the command ended; the list now says `completed` |
| 58,580 | `subagent_finished` (parent's session) | `status: completed`, `duration_ms`, `output`, `will_wake: true` |
| 58,580 | `_x.ai/queue/changed` (parent) | `runningPromptId: subagent-completed-<subagent_id>`: Grok's own turn to report |
| 62,627 | `turn_completed` (parent) | `prompt_id: subagent-completed-<subagent_id>` |

## What follows for Sotto

- A background subagent outlives the turn, and Grok says when it really ends (`subagent_finished`).
- The spawn tool call returns at once, so its completion is not the subagent's end.
- `subagent_spawned` carries no background flag; a subagent still running when the turn ends is in the background.
- With `will_wake: true`, Grok starts a turn of its own after the subagent ends.
- Background commands come as a whole list with each task's status (`background_tasks`), on the session that ran them. Here that was the subagent's, so it is the subagent's business.
- A subagent's permission requests come on the parent's session, where Sotto already shows them.

## A cancel, second probe

A second probe started the same background subagent (`sleep 50`) and let that turn end. It then sent a new prompt to run `sleep 30` in the foreground and cancelled it with `session/cancel` 9 s later. Grok ended both turns `cancelled` at once, the prompt's and the subagent's own, and answered the prompt. 2.4 s later it sent `subagent_finished` with `status: cancelled` and `will_wake: false` on the parent's session. A cancel ends the background subagents too, and Grok says so itself.

Not seen in either probe: a background command started by the parent itself, and a foreground subagent. The parent's own `background_tasks` is assumed to take the same shape as the subagent's.
