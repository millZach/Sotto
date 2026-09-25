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
which is an agent started by an agent. These two narrow agent work only; a monitor's watch keeps the rules it
had.

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
the CLI would stop the work it reports. For the same reason changing the thread's settings and rewinding it,
which both restart the CLI, are refused while it is live, with an error that says nothing was changed and to wait
for the agents. If a bookend is ever lost, a reconnect clears the state and lets both through again.

**Three poses, one track.** The composer keeps room for one creature. A monitoring task keeps it first, because a
watch says the provider is looking at something; background work next, because it is confirmed but claims only
that agents are running; the held action last, because it is a clock. All three are hidden on the same
`ornamentAllowed` condition in `ThreadPane`.

**The count is of tasks.** *Working · N agents* and the small agents on the track count the provider's tasks, one
each, which is the copy the issue's spec gave. A workflow that runs dozens of agents is one task, because Claude
Code reports it as one and Sotto does not look inside it; the readout names the task, and the hover title lists
every task by name.

**Bounded and anonymous.** At most 64 tasks are kept, counted apart from watches so a wide workflow cannot crowd
out a watch. Native task IDs stay in the adapter; the thread carries opaque IDs, sanitised labels and Sotto's own
type names (`workflow`, `subagent`, `teammate`, `remote-agent`). The field is `backgroundWork`, beside
`monitoring`, and like it is stripped from the workspace file, the renderer's shell cache and any thread whose
provider is disconnected.

## Amendment: a command left running in the background

*September 25, 2026.* The decision above left a background shell inert, so a thread that started a long command
with `run_in_background` and ended its turn looked idle for as long as the command ran, and the session reaper
could stop the session under it. Zach asked for it to be shown as waiting. A `local_bash` task is now background
work of type `command`, on the same evidence and ownership rules as agent work: a start, the bookend that ends it,
started by this thread and not by an agent. A shell the turn is still running is marked `is_backgrounded: false`
and stays the turn's own action, as a foreground subagent does, until it is sent to the background. `shell`,
`mcp_task`, `plan`, `dream` and `scheduled` stay inert.

A command waits rather than works, so it does not take the dispatcher. Once the turn has ended, a running command
holds the hourglass: the reader is told **Waiting**, the readout names the command by its description, and the
clock counts from when Sotto saw it start, since the frames carry no time of their own (*Waiting · 2 commands*
when there are several). While the turn is live, the turn's own held action keeps the glass. Agents outrank
commands: with both running the dispatcher stays and counts the commands beside the agents, *Working · 2 agents ·
1 command*, chosen from three mock-ups (`docs/prototypes/background-shell-prototype.html` on
`prototype/background-shell`). Because it is background work, a running command also holds its session from the
reaper and refuses settings changes and rewinds, and the refusal now says "background work" rather than "agents".
The field keeps its name; `backgroundWork` entries gain an optional `startedAt`.

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
