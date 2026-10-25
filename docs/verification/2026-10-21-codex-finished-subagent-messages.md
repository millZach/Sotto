# A Codex sub-agent sent a message after it finished: what was checked

October 21, 2026. Issue #1261.

## The cause

A code-review delegation to Codex (codex-cli 0.163, multi-agent v2) spawned two sub-agents and finished its turn at 07:15:07 UTC. Sotto read the delegation as `background` for the next 7.5 hours, and every later turn on the thread as well.

- Codex's own logs for the root thread and both sub-agents. The second sub-agent completed at 07:13:57. At 07:13:59 the root sent it one more `send_message`, which Codex reported as a `subAgentActivity` item of kind `interacted`. The sub-agent's own log shows no turn after its completion.
- Sotto's agent roster (`subagents.sqlite`, read only). The second sub-agent's row was `running`, with an assignment that started at 07:13:59.015, the moment of that message. The roster counted it as working, so every finished turn on the thread read as `background` (`watcherOutcomes.ts`, `watcherBackgroundWorkCount`).

The projection treated any `interacted` item on a finished agent as new work. Codex reports two different things that way: `send_message`, which leaves the message in the agent's mail and starts nothing, and `followup_task`, which starts the agent's turn.

## What Codex sends for each

Two probes against `codex app-server` 0.163 on this laptop, each a root thread that spawns one sub-agent, waits for it, then writes to it once more. Notification methods, thread identities and item kinds were recorded; no prompt or reply text was kept.

- `send_message` to the finished agent: an `interacted` item on the root, then nothing from the sub-agent's thread. Its status stayed idle and no turn started.
- `followup_task` to the finished agent: an `interacted` item on the root, then, in the same instant, the sub-agent's own `thread/status/changed` to active and `turn/started`, and later its `turn/completed` and a `completed` item on the root.

The sub-agent's own notifications do reach the client. So an agent that had finished becomes working again only once it shows work: its own turn starting, or a later completion that shows a turn ran, which is all a history read has.

## The tests

Each failed before the change.

- `tests/unit/main/subagentObservations.test.ts`: the sequence from the log (a message while working, a follow-up task, completion, then a message) leaves the agent finished, live and read again from history. A follow-up task opens a new assignment when the agent's own turn starts, timed from the message. A history read opens one when a later completion follows the message.
- `tests/unit/main/subagentWorkspace.test.ts`: two sub-agents through the workspace roster. Both finish, the root writes to one of them, and the turn ends. The roster counts nothing working, the turn reads `answered` with its reply, and so does the next turn on the same thread.
