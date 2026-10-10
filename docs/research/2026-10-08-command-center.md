# A command center for Sotto: who does it, and where to start

Researched 2026-10-08. Scope: products that give one place, usually one conversation, the job of managing many coding-agent threads. The findings come from four research notes, listed at the end, which read vendor docs, source code and issue trackers; the load-bearing claims below were checked again against their sources. No app was installed or run. The ideas at the end are proposals, not decisions.

Decided the same day, after the research had started: the command center is typed, not spoken. Sotto's voice control comes out with this work and dictation stays. The per-thread Manage controls come out too, and the command center replaces them. The removal is planned in [`docs/plans/2026-10-08-remove-voice-control.md`](../plans/2026-10-08-remove-voice-control.md).

## The short version

- **Every large vendor now ships a coordinator conversation.** Claude Code Projects, Cursor Projects, Amp's Puck, ChatGPT's dots, VS Code's Agents window and the T3 Code V2 preview each let one conversation start threads, send to them and gather what they report. The idea is no longer new. How Sotto does it is what sets it apart. [Claude Projects](https://code.claude.com/docs/en/claude-projects), [Cursor Projects](https://cursor.com/docs/agent/projects), [Puck](https://ampcode.com/docs/puck), [dots](https://learn.chatgpt.com/docs/dots/tasks-and-memory), [VS Code](https://code.visualstudio.com/docs/agents/run/sessions/manage-sessions), [T3 tools](https://github.com/pingdotgg/t3code/blob/393ff4c968073d8419e5bade06000998602af6ad/docs/orchestration-v2/orchestrator-mcp-server.md)
- **None of them covers what Sotto already has.** Sotto runs threads on the user's own installed Codex, Claude Code, Grok Build and Devin, on this computer and on remote hosts, keeps their history local, and leaves every permission to the user. The others run one vendor's agents, run in the cloud, or let the manager or an automatic reviewer approve. [Vendor gaps](2026-10-08-command-center-vendor-agent-managers.md#gaps-nobody-fills-well), [workbench gaps](2026-10-08-command-center-parallel-workbenches.md#gaps-nobody-fills-well)
- **T3 Code, Sotto's reference for Git, has built this as a tool set.** In its V2 preview a thread can list, read, launch, send to, wait on and interrupt other threads by T3's own thread IDs. Sends carry retry keys. A child can never get a wider permission mode than its parent. No tool answers an approval. It is the closest blueprint for Sotto. [T3 contract](https://github.com/pingdotgg/t3code/blob/393ff4c968073d8419e5bade06000998602af6ad/docs/orchestration-v2/orchestrator-mcp-server.md)
- **The managers that work keep the record outside the manager.** Gas Town's Mayor reads status, mail and assignments from durable records rather than remembering them. Devin's manager is woken when a child finishes or needs input, rather than polling. Managers that rely on their own memory go quiet after the first task, or report work that never ran. [Mayor](https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/internal/templates/roles/mayor.md.tmpl), [Devin](https://docs.devin.ai/work-with-devin/advanced-capabilities), [Gas Town #289](https://github.com/gastownhall/gastown/issues/289), [Ruflo #1397](https://github.com/ruvnet/ruflo/issues/1397)
- **The most common failure is one badge standing for several states.** Working, waiting on you, background work, silent, finished and merged get shown as one thing. The second most common is a manager taking a worker's word as proof. [Workbench patterns](2026-10-08-command-center-parallel-workbenches.md#patterns-across-this-lane), [MAST](https://arxiv.org/html/2503.13657v3)
- **The safe line on authority is the one Claude Code Projects draws.** A permission is answered inside the worker thread, and telling the coordinator to go ahead does not reach it. Claude Code's cross-session messages follow the same rule: a message from another session "can't approve anything". [Projects](https://code.claude.com/docs/en/claude-projects), [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)

## Who does it

In order of how much each teaches Sotto.

| Product | What it is | Good at | Falls short |
| --- | --- | --- | --- |
| [Claude Code Projects](https://code.claude.com/docs/en/claude-projects) | One coordinator conversation. Each thread it starts shows as a card under your message. An Overview pane groups threads as Ready for review, Waiting on you, Working, Landing, Idle and Resolved. | Grouping by what you have to do next. Approvals stay in the worker thread. The coordinator works from what threads report, not every step they take. | Threads run in the cloud and are Claude only. "Run at most two threads" is an instruction Claude keeps to, not a cap. Threads run in auto mode. |
| [T3 Code V2 tools](https://github.com/pingdotgg/t3code/blob/393ff4c968073d8419e5bade06000998602af6ad/docs/orchestration-v2/orchestrator-mcp-server.md) (preview) | Twelve tools any thread can use: capabilities, delegate a task, create 1 to 20 threads, launch, list, read from a position, update, send (auto, queue, steer or restart), wait, interrupt. | App-owned IDs. Retry keys on sends. Children never get wider modes than the caller. No approval tool. | Preview only. Launch has no retry key. User reports of threads stuck on Working during checkpoints ([#15124](https://github.com/pingdotgg/t3code/issues/15124)) and queued threads losing live updates ([#15289](https://github.com/pingdotgg/t3code/issues/15289)). |
| [Amp Puck](https://ampcode.com/docs/puck) | A personal assistant conversation over all projects and threads: starts agents, sends them more instructions, splits work and brings results back. Also on iPhone and Slack. | A manager that is always one shortcut away and keeps track of the agents it started. | Amp's tools run without approval by default ([tools](https://ampcode.com/docs/tools)). No stated freshness for what Puck reports. |
| [Cursor Projects](https://cursor.com/docs/agent/projects) and Agents window | A coordinator beside a live tree of its workers. Needs Attention groups approvals, questions, plans and unread results across workspaces. Best-of-N in worktrees. | The worker tree and grouping attention by kind. | Users missed approvals in the window ([forum](https://forum.cursor.com/t/agents-approval-window/170388)). Cloud agents run commands without asking. |
| [Gas Town](https://github.com/gastownhall/gastown) | Steve Yegge's Mayor over many workers on many CLIs, with Beads issue records, convoys and a Refinery merge queue run by its own role. | Durable records. Merging kept apart from managing. | Claude and Codex presets bypass permissions. A Mayor that idled after its first task ([#289](https://github.com/gastownhall/gastown/issues/289)). Expensive, by the author's own account. |
| [Devin](https://docs.devin.ai/work-with-devin/advanced-capabilities) | Any session can manage child sessions. It wakes when a child finishes or needs input. Recorded workflows resume after an interruption. | Event wake-ups instead of polling. | Child launches are approved automatically by default. Cognition's own account: managers over-prescribe and fail to pass findings between children ([April 2026](https://cognition.com/blog/multi-agents-working)). |
| [Agent Deck](https://github.com/asheshgoplani/agent-deck/blob/34cf3690c39614f33aa683e8f8a280322320de59/docs/COMMAND-CENTER.md) | A persistent Conductor conversation over tmux sessions, with durable inboxes and a stale state. | Durable per-session delivery and quiet escalation. | Its policy lets the Conductor answer when confident. Replies reaching the wrong Conductor ([#2547](https://github.com/asheshgoplani/agent-deck/issues/2547)). |
| [Nimbalyst](https://github.com/nimbalyst/nimbalyst/blob/e506dfca634659dac0eb522aa64e32f30501a9b6/docs/SESSION_HIERARCHY.md) (Crystal's successor) | An alpha Meta Agent over one workspace. Caps each manager at four children in flight. | An app-enforced capacity limit. Reports tied to each child's output. | The manager has a tool that answers permission requests. A background result displaced an unanswered question ([#1557](https://github.com/nimbalyst/nimbalyst/issues/1557)). Two managers used much of a subscription window in an hour ([#889](https://github.com/nimbalyst/nimbalyst/issues/889)). |
| [Linear](https://linear.app/developers/agent-interaction) and [Jira](https://support.atlassian.com/jira-software-cloud/docs/view-and-manage-agent-sessions-in-jira/) | Typed agent states (Linear: pending, active, error, awaitingInput, complete, stale) and an inbox grouped as Needs input, Working and Finished. | State as a record rather than a message. "Stale" after thirty minutes with no activity. | Finished is not the same as accepted. Both are cloud services. |
| [ChatGPT and Codex](https://learn.chatgpt.com/docs/notifications) | Codex now lives inside ChatGPT desktop. Activity lists unread, running and waiting chats. Dots delegates ongoing work. | Approvals name the thread they came from and open it. | Optional automatic approval review. Pausing dots does not stop the tasks it started ([dots](https://learn.chatgpt.com/docs/dots/tasks-and-memory)). |

Also worth knowing. [Superset](https://github.com/superset-sh/superset/blob/edcec5b936643560165b90af730d70d742616156/plugins/superset/skills/orchestrate/SKILL.md) ships the manager as a skill inside an ordinary Claude or Codex conversation, and tells it a listed terminal is no proof of completion. [Conductor's API](https://www.conductor.build/docs/api) warns that a worker reads idle before its brief is delivered, so idle is not done. [cmux](https://github.com/manaflow-ai/cmux/blob/v0.65.0/docs/agent-messages.md) holds a message back while the agent waits on a human question. [Kiro](https://kiro.dev/docs/ide/experimental/focus-mode/) shows the exact question or command on its waiting card. [Warp](https://docs.warp.dev/platform/managing-cloud-agents/) warns that a parent's success does not mean its children finished. [Claude Code cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging) asks which session you mean when two share a name.

## What they do well

1. **One conversation, with every thread it touches shown as a card you can open.** Claude Projects, T3 and Puck all do this. The worker stays a real thread the user can read and type into.
2. **Grouping by what the user must do next, not by project.** Waiting on you, Ready for review, Working, Landing, Idle (Claude Projects); Needs input, Working, Finished (Jira); approvals, questions, plans and results (Cursor).
3. **Records the manager reads rather than remembers.** Gas Town keeps assignments in Beads. T3 keeps durable projections of every run. Devin records workflow results so an interrupted manager does not reconstruct them.
4. **Being woken instead of polling.** Devin's manager wakes on a child's finish or question. T3 notifies the parent when an async task completes. Claude Code can ask for one notice when another session goes idle.
5. **Typed operations on app-owned IDs, with retry keys.** T3 and Sculptor address threads by their own IDs. Kilo lists real session IDs before sending.
6. **A self-contained brief for each worker.** T3's delegated child sees only its task, not the parent's history. Conductor's manager prompt and Superset's skill both write the brief out in full.
7. **Waiting cards that show the actual question or command** (Kiro), rather than a dot.
8. **Limits the app enforces.** Nimbalyst reserves capacity before launching and caps four children in flight. Claude Projects' limits are only instructions, which it says plainly.

## Where they fall short

1. **The manager can approve.** Nimbalyst's manager has a tool that answers permission requests. Agent Deck's policy lets the Conductor answer when confident. Cline's approval to spawn a subagent covers all of that subagent's tools. Claude teams accept a lead's plan approvals automatically. Cloud agents at Cursor, Amp and Google run commands without asking. [Coordinator note](2026-10-08-command-center-coordinator-agents.md#authority-and-takeover)
2. **State that misleads.** One badge for many states. A worker that reads idle before its brief arrives, taken as done. Threads that stay Working through checkpoints. Silence taken as progress, which is why Linear marks a session stale after thirty minutes.
3. **Managers that forget.** A Mayor that idled after its first task. An Agent Deck Conductor restored after a restart with no recovery turn, leaving work dormant ([#2518](https://github.com/asheshgoplani/agent-deck/issues/2518)). Claude agent teams do not restore teammates on resume.
4. **A worker's claim taken as proof.** The MAST failure taxonomy, built from traces across seven multi-agent frameworks, includes a planner accepting example test output as real results and an editor claiming an edit it never made. [MAST](https://arxiv.org/html/2503.13657v3)
5. **Attention that never arrives.** Approvals that did not reach where the user was looking: Cursor's window, Claude teams on tmux ([#36007](https://github.com/anthropics/claude-code/issues/36007)), Claude on the phone ([#36439](https://github.com/anthropics/claude-code/issues/36439)).
6. **Messages sent to the wrong place.** Agent Deck replies reaching the first Conductor alphabetically. GitHub issue comments that do not reach the agent working the issue. Happy's voice tool confirming a send with a bare "sent".
7. **Cost nobody has measured fairly.** Anthropic's research system used about fifteen times the tokens of a chat. One Overstory run used 8 million tokens ($60) with twenty agents against 1.2 million ($9) done in sequence. No study compares a manager with the same workers alone at equal quality. [Cost table](2026-10-08-command-center-coordinator-agents.md#cost-what-the-available-numbers-do-and-do-not-say)
8. **Integration left to chance.** Worktrees separate files but not ports or databases. Nobody checks that the combined result works. Merging is left to a person or another agent.

## What Sotto already has to build on

- **Thread tool servers.** A thread already gets Sotto's own tools over a loopback MCP connection with a token per thread (`src/main/agents/threadToolServer.ts`). The browser, host setup, visuals and pull request babysitting are four of them. A command center's tools would be one more.
- **Wake-ups.** Babysitting already sends a thread a message through its own send path when its pull request changes, or queues it behind the user's own follow-ups (ADR-0061). The same path can wake the command center when a thread it started finishes, asks, fails or goes quiet.
- **The approval surface is Sotto's** (ADR-0043). A thread's request arrives on its request card, and only the user answers it there. A command center adds no new way to answer.
- **The rest of the plumbing:** Sotto thread IDs (ADR-0002), the event store (ADR-0016), the follow-up queue, steering, delivery receipts and the outbox, the attention queue, the subagent roster, remote hosts, and the phone's Needs you list.
- **What it does not have.** Today's coordinator is a text-only model with no tools (`src/main/agents/reasoning.ts:34`). It turns one sentence into one of seven intents, and judges one assigned thread from its last twelve messages. It holds no conversation and cannot see across threads.

## Ideas for Sotto's command center

### The shape

**Recommended: the command center is a thread.** It is a pinned thread on whichever provider and model the user picks (Claude Code, Codex or Grok Build, on the user's own plan), given a Sotto tool server over every other thread. It reads, starts and sends. It never answers a request. Everything a thread already has comes with it: transcript, composer, steering, the follow-up queue, history and the phone. This is the shape T3, Superset and Claude Projects chose. It needs no new key or host, and it follows ADR-0026, which already moved Sotto's own short writing onto a thread's provider.

The alternative is to grow today's coordinator, the reasoning account in Settings → Agents, into a conversational agent with tools. That gives Sotto more control over prompts and cost. But Sotto would then own an agent loop and its tool calling, and the user would pay a second account for it.

Devin cannot be the command center's provider, since its pinned client takes no Sotto tool connection, though Devin threads can be managed by it. A command center on this computer could reach threads on remote hosts through the router that already joins every connected host's threads; that needs checking before it is promised.

### Its tools, after T3

A first `sotto_threads` server:

- `list_threads`: the roster. For each thread: Sotto thread ID, title, project, host, provider and model, state, what it waits on, branch, pull request, last activity and when that was read. Filters by project and state.
- `read_thread`: a thread's recent turns from a position, bounded, or its activity.
- `start_thread`: project, host, model, effort, a permission no wider than the user's default, current checkout or new worktree, and the first prompt.
- `send_to_thread`: send now, queue or steer, with a retry key so a lost answer never sends twice.
- `stop_thread` and `settle_thread`.
- No waiting tool. The command center ends its turn and is woken.
- No tool answers a question or a permission, and none widens a thread's permission.

### What the user sees

- **Thread cards in its transcript.** Each thread it starts or sends to appears under that message as a card with title, project, state and what it waits on. Pressing the card opens the thread's pane.
- **An overview beside it, grouped by what you need to do:** Needs you (questions, permissions, failures), Ready for review (pull request open), Working, Landing (approved or merging), Quiet (working with no activity for a while) and Idle, with counts.
- **A roll-up when asked.** "What's everyone doing?" is answered from the roster, counts and exceptions first, each line linked to its thread.
- **Receipts that name the destination.** "Sent to *Fix checkout* in storefront. It's working on it." Never just "sent".

### Keeping it honest

- **The record lives in main, not in the model.** Main records who started which thread for which request, what was sent, and what each thread waits on. The command center reads it through its tools, so a restart loses nothing and the model cannot invent a thread's state.
- **Claims carry evidence.** "Done" names what Sotto saw (the pull request's checks, the diff, the test command the thread ran and its exit code) and keeps it apart from what the agent said.
- **States that do not blur:** started, sent, working, waiting on you, finished, ready for review, merged.

### Authority

- **It may start threads and send prompts within what the user asked of it, in plain view.** It answers nothing. A thread's question or permission stays on the request card in that thread, and the overview's Needs you group links to it. Telling the command center "go ahead" approves nothing.
- **Typing into a thread directly is a takeover of that thread.** The command center stops sending to it and says so.
- **Limits the app enforces, not the model:** threads in flight (four to start with), prompts per thread for one request, and Stop all.
- **A relayed message**, one thread's finding carried to another, is marked as coming from the command center and never counts as consent.

### Being woken, not polling

When a thread it started finishes, asks, fails or goes quiet, main sends the command center a wake-up through the path babysitting uses, batched so several events arrive as one. The command center ends its turn rather than sleeping or polling `list_threads`.

### Later

- **Plans before starting.** For a batch ("fix these three issues") it proposes the threads (project, model, working copy, brief) as one card, and **Start these** starts them. Accepting a plan grants no permission.
- **Best of N.** One brief to Claude Code, Codex and Grok Build in separate worktrees, compared by diff and checks.
- **Relay.** Carry a finding from one thread to the others it affects, the way Claude Code's cross-session messages do.
- **Merge order.** Warn when two worktree threads change the same files, propose an order, and let the user press Merge: a light version of Gas Town's Refinery.
- **Routines.** A morning roll-up, or a check across every babysat pull request.
- **Cost.** Token use per request, where providers report it.

## Decisions for Zach

1. **Shape.** A pinned command-center thread on a provider (recommended), or Sotto's own coordinator grown into an agent.
2. **How much it may do without asking.** Start threads and send prompts within the request (recommended), propose and wait for Start, or drafts only.
3. **Where it lives.** This needs a prototype with variants: a pinned pane on the Threads page with the overview beside it; its own page where the old Agents room was; or the top of the sidebar.
4. **How many.** One command center per computer (recommended for a first version), or one per project.
5. **Its name.** "Command center" is Zach's word. Once chosen, it goes into `CONTEXT.md`.

## The research notes

- [Vendor agent managers](2026-10-08-command-center-vendor-agent-managers.md): Claude Code, VS Code, Cursor, Warp, Codex and ChatGPT, Kiro, JetBrains Air, Antigravity, GitHub, Devin Desktop, Zed.
- [Parallel workbenches](2026-10-08-command-center-parallel-workbenches.md): Agent Deck, Superset, T3 Code, Nimbalyst, Sculptor, Conductor, cmux, Emdash, Vibe Kanban, Claude Squad, HumanLayer, Container Use, opcode, Terragon.
- [Coordinator agents](2026-10-08-command-center-coordinator-agents.md): Amp, Gas Town, Claude Code teams, Devin, Factory, Kilo, Overstory, OpenHands, Cline, Roo Code, Ruflo, and the research on how multi-agent systems fail.
- [Voice, mobile and delegation](2026-10-08-command-center-voice-mobile-delegation.md): written before voice was dropped. Its attention, receipt and phone findings still apply; its spoken-interface findings are now background only.
