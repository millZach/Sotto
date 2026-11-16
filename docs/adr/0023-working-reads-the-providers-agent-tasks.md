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
an error result, a disconnect, a process exit and a restart. An error result that answers a `/compact` is the exception: a failed compaction stops nothing in the CLI, so it keeps the work (amended October 29, 2026, in [ADR-0127](0127-sotto-compacts-an-idle-claude-thread-before-its-cache-expires.md)). While it is live the session reaper (ADR-0016) leaves the session running, because stopping
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

## Amendment: settings changes reach the running CLI

*September 25, 2026.* Issue #317. A settings change no longer restarts Claude Code as a rule, so it no longer
ends background work as a rule either. The adapter sends the running CLI the control request for each changed
setting: `set_model`, `apply_flag_settings` with `effortLevel`, and `set_permission_mode`. A model change sends
its effort in the same operation, the way `--effort` goes with `--model` at launch: the level the change names,
checked against the new model, or else the new model's default, as a Codex model change does. Claude Code reports
no default level for a model, so a model change that names none clears the old one, and the CLI runs the new
model's own default rather than a level that model may not offer. The thread
is saved and shown only once the CLI answers success, and the session, its transcript, its watches and its
background work carry on. Claude Code 2.1.283 took all three (`docs/verification/2026-09-25-claude-settings-live.md`).

The restart stays as the fallback, and the refusal above now belongs to it alone. The adapter starts the CLI
again when no CLI is running, when the running one refuses a request, and when the thread enters or leaves full
access: the CLI takes `bypassPermissions` only when bypassing was allowed at launch, and a CLI launched with that
allowance keeps it, so those two changes go through a fresh start to keep the launch arguments those of the
mode. Background work still refuses the fallback, and nothing is changed. If the CLI refused part of a change
after taking the rest, what it took is set back first, so that stays true. If it will not take that back either,
the refusal could no longer say nothing was changed, so the adapter stops the CLI as it does for a lost answer,
below. A press that finds the CLI still
starting waits for that start and takes the path its result allows. The fallback records the new settings before
it lets the old CLI go, so a start that comes in meanwhile, such as the window opening the thread, launches with
them. Either way, an accepted change comes back with the snapshot that shows it, and the coordinator takes that
snapshot in place of reading the thread (ADR-0007's amendment for #318).

A request whose answer is lost leaves the CLI on settings Sotto cannot know. The adapter stops that CLI, so
nothing runs on settings the thread does not show, and saves the change as the one the next launch carries. It
reports the change unconfirmed, the coordinator keeps its saved intent, and the thread shows the change from
the launch that runs it, which is what reconciles the intent. Stopping ends any background work: a lost answer,
or a partial change the CLI will not undo, is the one case where a settings change still can. When it does, the
thread shows it the way it shows a CLI that exited under running work, in error with the work gone, and the
result carries an error that names the work and says it stopped with the session. The coordinator shows that
error in place of its own "did not confirm" and keeps the saved intent all the same.

A CLI Sotto lets go can take half a second to exit, and its background work may still be writing to the session
meanwhile. Every stop the adapter makes is recorded until the process has exited, and a start on that thread
waits for it, so one session never has two CLIs, whether the stop came from a settings change, a rewind, a
changed personal context or the session reaper.

A changed personal context waits for background work to finish before it restarts the client. Messages continue on the existing client with its previous context while the work runs, including a message asking Claude to stop that work. The changed context stays pending, and the first send after the work ends restarts the client with the latest context. A context change never refuses a send for this reason.

Clarified September 30, 2026 after review: that wait applies only to changed retrieved preferences. Authored turns typed in a separate Claude CLI require Sotto's next send to restart its client and resume the updated native history, including in project threads and while background work runs. Otherwise the displayed history and the model's loaded context disagree. A committed deletion of a memory supplied to the running client also forces the next send to restart (ADR-0010). Either restart names the work it stopped through the existing stopped-work notice. Native takeover and changed retrieved preferences are tracked separately.

The adapter logs which path each change took, as event names and nothing else: `claude-settings-applied-live`,
`claude-settings-applied-restart`, `claude-settings-live-rejected` and `claude-settings-unconfirmed`.

## Amendment: Cursor's subagents, and work no provider says has ended

*November 15, 2026.* Issue #2631. A Cursor thread started a Task subagent that Cursor moved to the background. Its Task
tool call returned at once, with `isBackground: true`, and Sotto read that return as the subagent's end: the thread
read Idle, its turn counted as finished, and Watcher never heard when the subagent, which wrote files for another
eleven minutes, really ended. Zach asked that any provider's background subagent or task show as running until it
really ends and count as background work.

Cursor says when a subagent ends only to a client that says it takes subagents (the `subagents` client capability,
read in Cursor 2026.11.11's own ACP code): `subagent_spawned` on the session that started one, then
`subagent_state_update` (`completed`, `failed`, `cancelled` or `disconnected`) on the same session when it ends. Sotto
now says it takes them. Cursor then keeps the prompt open until the subagents it started have ended, and hands its
agent their results, which it answers in the same turn. A new prompt would cancel them, so Sotto, which queues
Cursor follow-ups rather than steering, holds them until the turn ends; **Stop** ends the subagents with the turn.
Zach picked this over leaving Cursor as it was, from `docs/prototypes/provider-background-work-prototype.html`
(variant c1). A subagent whose Task call returned while it runs is the thread's background work, type `subagent`,
until its own ending, the same rule as a Claude Code subagent moved to the background; its row reads **Working**
until then. One a subagent started is not counted; it is tracked only so that a permission it asks for on its own
session reaches the thread's cards, as it did before Cursor named those sessions.

The other providers, as their own code and documents say (#2631 has the survey): Grok Build and Codex send a start
and an end for their subagents, which Watcher's roster already counts, but publish no background work; OpenCode 2
runs subagents and shells in the background and shows their end only in its job list; Muse's background items need
a live check; Hermes's background `delegate_task` and `terminal`, and Devin's background shells, have no ending over
their protocols; Pi and DeepSeek Harness run none of their own. Each has its own follow-up. For work no provider says
has ended, Zach picked (variant n1): where it is a process that carries the thread's session mark, Sotto finds it and
holds it as **Working** while the process runs, the way detached runs are found (ADR-0204); work inside the
provider's own process stays unseen until the provider reports it.

## Amendment: Grok Build's background subagents and commands

*November 15, 2026.* Issue #2633, under the amendment above. A live session of Grok Build 1.0.77 on forge showed that a
subagent started with `background: true` returns its spawn tool call at once. Grok then sends `subagent_spawned` on the
thread's session, answers the prompt (`turn_completed`) while the subagent runs, sends `subagent_progress` about every
eight seconds, and sends `subagent_finished` when the subagent ends. With `will_wake: true`, Grok then starts a turn of
its own to report the result. Commands Grok moved to the background come in `background_tasks`, the session's whole list
with each task's status, sent again as one starts or ends (`docs/research/2026-11-15-grok-background-work-probe.md`).

A subagent the thread's session started, with no `parent_subagent_id`, is the thread's background work, type
`subagent`, once a turn has ended while it runs, and stays so through later turns until `subagent_finished`. Until
then, a running turn may be waiting on it, so it is that turn's action. One that wakes Grok is held until Grok's report
turn (`subagent-completed-<id>`) completes, or until a turn that began after it finished does, in case Grok dropped the
report for that prompt. The thread reads Working through the report, as a Claude Code thread does through its own. A
cancel needs no rule of its own: it ends the background subagents too, and Grok says so with `subagent_finished`. A task `background_tasks` lists as `running` is a `command`. A subagent's own
subagents and commands, which come on its own session or name their parent, are its business. Both hold the session
from the reaper. A process that ends takes them with it: its subagents' rows read unknown and their agents interrupted,
so Watcher's roster stops counting them. Nothing new is drawn, so no mock-up was needed.

## Amendment: Codex's sub-agents and commands left running

*November 16, 2026.* Issue #2634, under the amendments above. Live sessions of codex-cli 0.169.0 on forge showed both
(`docs/research/2026-11-16-codex-background-work-probe.md`).

A sub-agent started with `spawn_agent`, not waited for, runs in a thread of its own: its own `turn/started`, the parent's
`turn/completed`, then the sub-agent's own `turn/completed` and a `subAgentActivity` item of kind `completed` on the turn
that started it. Codex does not wake the parent.

A command run with `exec_command` that is still running when its yield time passes stays a unified-exec session. Its
`commandExecution` item is still `inProgress` when the turn completes, and the item's own `item/completed` comes when the
command ends. `thread/backgroundTerminals/list` lists it in between.

So Sotto reads both from Codex's own notifications, without polling. A sub-agent of the thread's that its own
notifications show working (the projection's `working`), once its spawning turn has ended, is background work of type
`subagent` until its own turn ends, whatever later turn messages it. One spawned in a sub-agent's turn is that
sub-agent's business. A command seen starting live and still running when its turn completes on its own is a `command`
until its own completion. It is tracked apart from the rows, so a long turn whose bounded rows dropped it loses nothing.
Each keeps its row running until its ending, through a reread of the same history too. A stopped or failed turn's
commands are closed as before, since nothing shows they carry on. Its sub-agents count only while their own threads say
they work. The thread's app-server holds its session from the reaper while either runs. When the app-server ends, or
Codex is disconnected, they end: their rows read unknown and every agent in them reads interrupted.

## Amendment: OpenCode's background subagents and shells

*November 16, 2026.* Issue #2635, under the amendments above. A live session of OpenCode 2.3.0 on forge showed both
(`docs/research/2026-11-16-opencode-background-work-probe.md`).

Every subagent runs in the background. Its `task` call succeeds at once with `metadata.status: running` and the child
session's `sessionID`. The child's own `session.execution.succeeded` (or `failed`, `interrupted`) is its end.

A shell command moved to the background succeeds with `status: running` and a `shellID`. `shell.exited` with that ID is
its end.

When either ends, OpenCode puts a `<subagent>` or `<shell>` report in the session's inbox (`type: synthetic`, with
`metadata.source`) and runs the session to read it. The job list (`GET /api/experimental/job`) agreed throughout, but
the events say the same and need no polling.

So each is the thread's background work, of type `subagent` or `command`, from its call's success until its end. It is
held through the run OpenCode wakes the session for, as a Claude Code thread reads Working through its own report. The
call's row runs until the work ends and then reads how it ended. OpenCode's own report is not recorded as the user's
message. What a subagent starts comes on its own session and is its business. The thread's server is held from the
reaper while any of this runs, and when the server ends it all ends, its rows reading unknown.

## Amendment: Hermes's background commands, found by their process

*November 16, 2026.* Issue #2637, under Zach's pick n1 above (find its process). Hermes 0.19.0's own source
(`docs/research/2026-11-16-hermes-background-commands-source.md`) shows that `terminal(background=true)` starts the
command, and only such a command, as `[shell, "-lic", "set +m; <command>"]`. It is a child of Hermes's own process, in a
new session of its own, and carries the thread's ACP session as `HERMES_SESSION_KEY`. Hermes's ACP adapter never says it
ended: the completion goes to a queue only its CLI and TUI read.

Sotto runs one Hermes process per thread. When a turn that ran a command ends, Sotto lists that process's children before
the turn's end goes out (for at most 5 seconds), so Watcher reads the end together with its background work; it looks
again 3 seconds after any turn ends. It reads, as the detached-run scan does, only the `HERMES_SESSION_KEY` each child
carries. Hermes's MCP servers get a filtered environment without it (`_build_safe_env`), and foreground commands have
ended with their turn. So a child carrying the thread's own ACP session is a command left in the background, and is the
thread's background work, of type `command`, until its process is gone. The mark is read rather than the command line
because the shell may replace itself with the command, and macOS lists command lines without quotes; the command line
only names it. Sotto looks again every 15 seconds while it finds any, and forgets them when the Hermes process goes. A
look that fails keeps what was known, and one that comes back after a newer one started is dropped. A look made while a
turn runs takes no command it did not know: that turn's own commands carry the same mark. The commands hold the session
from the reaper, which would leave them unwatched, but nothing else. A permission change and a client update go ahead,
and since the commands run in sessions of their own they carry on, but are no longer counted once Hermes restarts.

How a command is named was Zach's choice too (November 16, 2026, after Bug Bot's review of #2652): **literal, else
program**. While the process still shows Hermes's `set +m; <command>`, that text is shown: it is the command as Hermes
was asked to run it, before the shell expands anything, and the thread's own step shows it already. Once the shell has
replaced itself with the command, its arguments hold expanded values, which may be a token, so only the program's name
is shown. Never an expanded value reaches the readout, Watcher or a host's snapshot.

How it shows was Zach's choice (November 16, 2026, over a "Background command" row with Stop as drawn in n1, and over
the detached-run row): **count it only**. The readout reads Waiting with the command's name, the sidebar row reads
Working, and Watcher waits, as for a Claude Code background command. There is no row and no Stop. Work Hermes runs
inside its own process, such as `delegate_task(background=true)`, has no process of its own and stays unseen until
Hermes reports it.

Devin's background shells have no ending over ACP either. Devin is installed on forge but not signed in, so whether its
commands carry a mark is unchecked, and it has its own issue (#2649).

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
ADR-0021 gains an amendment for the order. Only the Claude adapter publishes background work (and, from the
amendments above, the Cursor, Grok, Codex and OpenCode adapters); the adapter contract's case skips the others. T3 Code reads Codex child-agent events as agent work, which may serve a later
issue, but Codex, Grok Build and Devin were not studied for this one and publish nothing. No new setting, IPC
channel, host or dependency.
