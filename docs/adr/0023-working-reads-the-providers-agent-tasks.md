# Working reads the provider's agent tasks

Accepted September 22, 2026, for issue #221. A turn can end while the work it started carries on: a workflow
with dozens of agents, a subagent sent to the background, a teammate. Until now the thread went quiet at the
turn's `result`, because the hourglass (ADR-0021) needs a live turn and the monitoring walk needs a watch. Zach
reviewed `docs/prototypes/working-creature-prototype.html` on `prototype/working-creature` (b7cf5e14) and chose
variant A, the dispatcher, with the status word **Working**. This records what that pose is allowed to claim and
where its evidence comes from.

## Decision

**Background work is the provider's own claim, read off its task frames.** Claude Code emits a `task_started`
system frame for every task it registers and a `task_notification` when one settles. A task counts when its
`task_type` is `local_workflow`, `local_agent`, `in_process_teammate` or `remote_agent`, its status is running
or absent, and this thread started it. `workflow` is accepted beside `local_workflow`: it is the friendly label
the SDK's task summaries use, while the CLI's emitter writes the discriminant (`task_type: e.type`). `shell`,
`local_bash`, `mcp_task`, `plan`, `dream` and `scheduled` stay inert, and so does anything unknown. Elapsed time
and transcript text are not evidence, for the reason `docs/verification/process-creature.md` gives for
monitoring: they are guesses about the provider, and this pose speaks for it.

**Only work this thread started.** The ownership rules are the monitor's: not a frame with a
`parent_tool_use_id` or `isSidechain`, not launched by a tool call seen inside a subagent, not `ambient`, not
`skip_transcript`. Two fields the CLI adds exclude too: `owned_by_subagent`, and a `spawn_depth` above one,
which is an agent started by an agent.

**A subagent the turn is blocking on is not background work.** The CLI marks a `local_agent` started in the
foreground with `is_backgrounded: false`. That is the turn's own action, and the held action already names it
after twenty seconds; counting it here would put **Working** over every foreground subagent from its first
second. It becomes background work only when a `task_updated` patch sets `is_backgrounded: true`, which is what
Ctrl+B or the SDK's background request sends. A task that omits the field, as workflows and teammates do, is
taken at its word as running in the background.

**It survives the turn and holds its session.** The `result` frame ends a turn, not its agents, so it does not
clear background work. The matching `task_notification`, a terminal status or a `task_updated` end time does, and
so does anything after which Sotto can no longer hear the bookend or trust the process to send it: an interrupt,
an error result, a disconnect, a process exit and a restart. While it is live the session reaper (ADR-0016) leaves the session running, because stopping
the CLI would stop the work it reports.

**Three poses, one track.** The composer keeps room for one creature. A monitoring task keeps it first, because a
watch says the provider is looking at something; background work next, because it is confirmed but claims only
that agents are running; the held action last, because it is a clock. All three are hidden on the same
`ornamentAllowed` condition in `ThreadPane`.

**Bounded and anonymous.** At most 64 tasks are kept, counted apart from watches so a wide workflow cannot crowd
out a watch. Native task IDs stay in the adapter; the thread carries opaque IDs, sanitised labels and Sotto's own
type names (`workflow`, `subagent`, `teammate`, `remote-agent`). The field is `backgroundWork`, beside
`monitoring`, and like it is stripped from the workspace file, the renderer's shell cache and any thread whose
provider is disconnected.

## Considered Options

- **The `background_tasks_changed` level signal.** The SDK documents a frame carrying the whole set of live
  background tasks, meant to stop a missed bookend from wedging an indicator. It also says its order against
  the bookends is unspecified and asks consumers not to correlate the two. Reading the edges keeps one rule for
  watches and agents and the evidence the issue asked for; the level signal is the better answer to a lost
  bookend if one is ever seen.
- **Counting nested agents, as T3 Code does.** T3 counts a subagent's own agents as working. Here they are the
  subagent's business, the same rule monitoring applies, and the root agent that started them is already counted.
- **Counting foreground subagents.** Rejected above: it would say **Working** over the turn's own action.

## Consequences

`CONTEXT.md` gains **Background work** and amends **Monitoring task**, **Held action** and **Session reaper**.
ADR-0021 gains an amendment for the order. Only the Claude adapter publishes background work; the adapter
contract's case skips the others. T3 Code reads Codex child-agent events as agent work, which may serve a later
issue, but Codex, Grok Build and Devin were not studied for this one and publish nothing. No new setting, IPC
channel, host or dependency.
