# Coordinators that manage other coding agents

Researched 2026-10-08. Scope: agents that dispatch, monitor and steer other coding agents, plus evidence on their failure modes and cost. This is a documentation, source and issue study; no software was installed or exercised.

**Documented** means the maker describes the behavior. **Observed** means it appears in inspected source or a published experiment, not a local app test. **User report** identifies an issue author's account, which was not reproduced. **Inferred** identifies a design reading. Live documentation was read on the research date; an undated page does not establish when a feature shipped. Sotto directions preserve its [thread IDs, privacy and permission rules](../../AGENTS.md) and [coordinator, assignment, attention queue and takeover vocabulary](../../CONTEXT.md).

## Summary

- **Documented:** Amp's Puck is the closest product shape: a separate conversation that starts agents, checks threads, sends instructions and gathers results. It also has realtime voice and iPhone access. [Puck](https://ampcode.com/docs/puck)
- **Observed:** Gas Town's best idea is keeping assignments and recovery state outside the Mayor's conversation. Its source teaches the Mayor to fetch status, mail and convoy records instead of holding all implementation detail in context. [Mayor instructions](https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/internal/templates/roles/mayor.md.tmpl)
- **Documented:** Devin combines conversational management with event-driven child wake-ups and resumable scripted workflows. The latter records completed calls instead of making the manager reconstruct them after an interruption. [Managed Devins](https://docs.devin.ai/work-with-devin/advanced-capabilities), [Dynamic Workflows](https://docs.devin.ai/work-with-devin/dynamic-workflows)
- **Documented:** Claude Code teams separate communication from consent: teammate tool prompts reach the user in the lead session, but the lead can approve teammate plans. That distinction matters for Sotto. [Team permissions](https://code.claude.com/docs/en/agent-teams#permissions)
- **Documented / observed:** Context isolation does not imply file isolation. Kilo children share the parent's checkout; OpenHands task source does too. Parallel writers need explicit ownership or separate worktrees. [Kilo delegation](https://kilo.ai/docs/code-with-ai/agents/orchestrator-mode), [OpenHands task manager](https://github.com/OpenHands/software-agent-sdk/blob/9c4fd8c6664dfce98524d04d965b4f009f390fbe/openhands-tools/openhands/tools/task/manager.py)
- **Observed:** Coordinators sometimes treat another agent's report as proof. MAST includes nonexistent edits and illustrative test output mistaken for actual verification. [MAST v3](https://arxiv.org/html/2503.13657v3)
- **Documented / inferred:** The 2026 evidence favors bounded consultation, review and independent work. Cognition revised its earlier rejection of multi-agent systems; Anthropic still found weak results on tightly coupled game-building work. [Cognition follow-up](https://cognition.com/blog/multi-agents-working), [Anthropic experiments](https://www.anthropic.com/research/multiagent-systems)
- **Inferred:** Sotto should combine a conversational command center with authoritative host records, evidence links, bounded dispatch and direct takeover. Copying permission bypass or prompt-body logging would contradict its existing rules. [Sotto authority](../adr/0004-authority-in-policy-records.md), [Sotto context](../../CONTEXT.md)

## Amp: Puck, worker threads, Oracle and handoff

- **What it is.** Documented: Amp's commercial coding environment spans web, CLI, macOS and iOS. Current pricing offers a free tier with user-supplied model access and paid usage tiers; these are the live terms seen on 2026-10-08. [Introduction](https://ampcode.com/docs), [Pricing](https://ampcode.com/docs/pricing)
- **Command-center shape.** Documented: Puck is a separate assistant conversation over projects and threads. It can use the currently viewed page as context. Ordinary Amp agents can also delegate to other threads. [Puck](https://ampcode.com/docs/puck), [Agent to Agent](https://ampcode.com/docs/orbs/agent-to-agent)
- **Dispatch.** Documented: Puck splits independent work and gathers reports. Amp also routes Task workers and Oracle consultations through distinct model roles. Oracle is a second opinion rather than a fleet manager. [Puck](https://ampcode.com/docs/puck), [Model roles](https://ampcode.com/docs/the-dial), [Oracle](https://ampcode.com/docs/tools)
- **What the hub sees.** Documented: Puck checks active and previous threads and can inspect connected GitHub checks. Worker threads expose messages, tool calls and changes. The precise freshness contract for a Puck summary could not be verified. [Puck](https://ampcode.com/docs/puck), [Threads](https://ampcode.com/docs/threads)
- **Talking to workers.** Documented: Agents send instructions and exchange files explicitly. Each delegated orb has its own conversation and working copy; a message alone does not transfer commits or uncommitted files. [Agent to Agent](https://ampcode.com/docs/orbs/agent-to-agent)
- **Attention and approvals.** Documented: Apps notify when a thread is ready. Users can steer a working thread or interrupt it. Amp tools run without approval by default; isolation or a custom policy plugin is recommended for untrusted inputs. Puck's exact authority restrictions were not established. [Introduction](https://ampcode.com/docs), [Thread control](https://ampcode.com/docs/threads), [Tools](https://ampcode.com/docs/tools)
- **Isolation and merge.** Documented: Orb delegation separates machines and checkouts. Threads provide Ship, Review and Sync actions; shipping follows project behavior. A cross-thread merge queue was not established by these pages. [Agent to Agent](https://ampcode.com/docs/orbs/agent-to-agent), [Changes](https://ampcode.com/docs/threads)
- **Memory and continuity.** Documented: Puck conversations keep separate histories. Threads are searchable and accessible across clients. Handoff starts a fresh thread with selected context; this preserves a reference trail but is still a selective transfer. [Puck](https://ampcode.com/docs/puck), [Threads](https://ampcode.com/docs/threads), [Handoff](https://ampcode.com/news/handoff)
- **Voice and mobile.** Documented: Puck supports realtime spoken replies and app shortcuts for dictation and calls, including iPhone. [Puck](https://ampcode.com/docs/puck)
- **Providers.** Documented: Multiple model vendors, BYOK and connected subscriptions can serve the main agent, Oracle and subagents. This is Amp's harness over models, not management of arbitrary installed provider CLIs. [The Dial](https://ampcode.com/docs/the-dial)
- **Does well.** Inferred: A separate manager stays accessible; explicit file transfer clarifies worker isolation. [Puck](https://ampcode.com/docs/puck), [Agent to Agent](https://ampcode.com/docs/orbs/agent-to-agent)
- **Falls short.** Documented / inferred: Oracle adds latency and expense, so Amp does not force its use. Permission-free tool execution does not match Sotto. No controlled Puck-versus-workers-alone cost comparison was found in the inspected material. [Tools](https://ampcode.com/docs/tools), [Pricing](https://ampcode.com/docs/pricing)
- **For Sotto.** Inferred: Take the separate, persistent management conversation with links back to workers. [Puck](https://ampcode.com/docs/puck)
  Inferred: Avoid its default permission-free execution and copying its connected-service surface without Sotto's host review. [Puck](https://ampcode.com/docs/puck), [Sotto rules](../../AGENTS.md)

## Gas Town: Mayor, convoys, Beads and Refinery

- **What it is.** Documented / observed: Steve Yegge's MIT workspace manager, launched January 1, 2026. The former `steveyegge/gastown` URL now redirects to `gastownhall/gastown`. Source inspected at `649b832` (July 23, 2026); full Windows operation uses a Linux environment for tmux. [Repository](https://github.com/gastownhall/gastown), [Launch post](https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04)
- **Command-center shape.** Documented: A conversational Mayor coordinates repositories called rigs. Polecats execute work; Crew supports hands-on work; Witness manages worker lifecycles; Deacon patrols across rigs; Dogs handle infrastructure; Refinery processes merges. [Architecture](https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/docs/design/architecture.md), [Roles](https://github.com/gastownhall/gastown)
- **Dispatch.** Documented: The Mayor creates Beads issues, groups them into convoys and uses `gt sling` to assign workers. Molecules encode multi-step workflows. A convoy groups tracked work; it is not another reasoning agent. [Convoys](https://github.com/gastownhall/gastown/blob/main/docs/concepts/convoy.md), [Command reference](https://github.com/gastownhall/gastown/blob/main/docs/reference.md)
- **What the hub sees.** Observed: Mayor instructions name commands for town status, worker status, ready/blocked issues, convoy progress and mail. They discourage reading implementation details into the Mayor's context. No complete cost ledger is promised by that interface. [Mayor instructions](https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/internal/templates/roles/mayor.md.tmpl)
- **Talking to workers.** Observed: Durable mail and queued nudges serve different purposes. Instructions require `gt nudge`, not tmux keystrokes; handoff mail carries continuity across sessions. [Mayor instructions](https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/internal/templates/roles/mayor.md.tmpl)
- **Attention and approvals.** Documented / observed: Severity-routed escalation can reach the human Overseer. Default Claude and Codex presets bypass permissions; this is an autonomy choice, not a user-owned approval inbox. Users can attach to individual sessions. [Escalation](https://github.com/gastownhall/gastown/blob/main/docs/design/escalation.md), [Runtime flags](https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/internal/config/agents.go), [Emergency manual](https://steve-yegge.medium.com/gas-town-emergency-user-manual-cf0e4556d74b)
- **Isolation and merge.** Documented: Workers use worktrees. Refinery verifies and integrates completed branches through a merge queue, isolating failures for repair or redispatch. Queue processing belongs to a role distinct from the Mayor. [Refinery](https://github.com/gastownhall/gastown), [Refinery source](https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/internal/cmd/refinery.go)
- **Memory and continuity.** Observed: Hooks retain assignments; Beads supplies structured work state. Current Mayor instructions describe Dolt-backed shared memories, injected at recovery through `gt prime`, rather than per-path Claude auto-memory. [Mayor instructions](https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/internal/templates/roles/mayor.md.tmpl)
- **Voice and mobile.** Could not verify a native voice or mobile command center in the inspected repository or manual. The documented main surface is tmux plus CLI/dashboard tooling. [Repository](https://github.com/gastownhall/gastown), [Manual](https://steve-yegge.medium.com/gas-town-emergency-user-manual-cf0e4556d74b)
- **Providers.** Observed: Runtime presets include Claude, Codex, Gemini, Amp, Copilot and others. Worker runtime can be chosen per dispatch. [Presets](https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/internal/config/agents.go), [Dispatch reference](https://github.com/gastownhall/gastown/blob/main/docs/reference.md)
- **Does well.** Inferred: Persistent work records, recoverable sessions and a separate merge process are the strongest architectural reference in this lane. [Architecture](https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/docs/design/architecture.md), [Convoys](https://github.com/gastownhall/gastown/blob/main/docs/concepts/convoy.md)
- **Falls short.** User reports: January issue #289 describes a Mayor claiming to monitor, then idling after the first task. March issue #3076 reports convoy completion polling broken by a Beads schema mismatch in Gas Town 0.12.1. Both are closed historical reports, not established current defects. Yegge's launch post explicitly reports high expense, duplicated work and lost fixes; it is an author account, not a benchmark. [#289](https://github.com/gastownhall/gastown/issues/289), [#3076](https://github.com/gastownhall/gastown/issues/3076), [Launch account](https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04)
- **For Sotto.** Inferred: Take durable grouped assignments and reconciliation against actual worker state. [Mayor instructions](https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/internal/templates/roles/mayor.md.tmpl)
  Inferred: Avoid the permission-bypass defaults and making routine monitoring depend on the Mayor remembering to run. [Mayor instructions](https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/internal/templates/roles/mayor.md.tmpl), [Runtime flags](https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/internal/config/agents.go)

## Claude Code: agent teams, subagents and workflows

- **What it is.** Documented: Anthropic's commercial CLI; teams remain experimental as read on 2026-10-08. API and subscription billing differ. [Teams](https://code.claude.com/docs/en/agent-teams), [Costs](https://code.claude.com/docs/en/costs)
- **Command-center shape.** Documented: A fixed lead coordinates teammates through mailboxes and a shared task list. Subagents are narrower parent-child delegation. [Team architecture](https://code.claude.com/docs/en/agent-teams#architecture), [Subagents](https://code.claude.com/docs/en/sub-agents)
- **Dispatch.** Documented: Locked task claims prevent duplicate assignment; the lead can approve teammate plans. [Assignment](https://code.claude.com/docs/en/agent-teams)
- **What the hub sees.** Documented: Messages, notifications and task state. Teammates receive project context, not the lead's conversation. Hooks can block completion. [Context](https://code.claude.com/docs/en/agent-teams#context-and-communication), [TaskCompleted](https://code.claude.com/docs/en/hooks#taskcompleted)
- **Talking to workers.** Documented: Peer messages and direct human instructions to selected teammates. [Control](https://code.claude.com/docs/en/agent-teams)
- **Attention and approvals.** Documented: Human tool approvals appear in the lead session; skip-permissions propagates. Agent messages cannot grant consent. Subagent prompts name the requester. [Permissions](https://code.claude.com/docs/en/agent-teams#permissions), [Subagents](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background)
- **Isolation and merge.** Documented: Avoid overlapping team edits; subagents support worktree isolation. [Team guidance](https://code.claude.com/docs/en/agent-teams#best-practices), [Worktrees](https://code.claude.com/docs/en/sub-agents)
- **Memory and continuity.** Documented: `/resume` does not restore in-process teammates; task state can lag. Subagents support resume and persistent memory. [Limitations](https://code.claude.com/docs/en/agent-teams#limitations), [Subagents](https://code.claude.com/docs/en/sub-agents)
- **Voice and mobile.** Could not verify an account-wide voice command center for teams. The desktop documentation says team orchestration is unavailable in Desktop; these findings concern the CLI. [Desktop limits](https://code.claude.com/docs/en/desktop)
- **Providers.** Documented: Claude agents through supported Anthropic deployment providers; this is not a lead controlling Codex, Grok and Devin CLI threads. [Claude Code overview](https://code.claude.com/docs/en/overview)
- **Does well.** Inferred: Named agent messages, direct human intervention and completion hooks are useful foundations. Current subagent docs say results wait for completion notifications; before v2.1.211, results could be reported early. [Subagent result timing](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background), [Hooks](https://code.claude.com/docs/en/hooks#taskcompleted)
- **Falls short.** User report: v2.1.79 Ubuntu/tmux MCP approvals failed to reach the lead; #36007 closed as a duplicate. Documented: leads can terminate prematurely. [#36007](https://github.com/anthropics/claude-code/issues/36007), [Limitations](https://code.claude.com/docs/en/agent-teams#limitations)
- **For Sotto.** Inferred: Take direct worker access and host-side completion gates. [Hooks](https://code.claude.com/docs/en/hooks#taskcompleted)
  Inferred: Avoid treating lead-approved plans as permission grants or relying on a resumed lead's recollection of its workers. [Hooks](https://code.claude.com/docs/en/hooks#taskcompleted), [Sotto authority](../adr/0004-authority-in-policy-records.md)

## Devin: managed Devins, sessions API and Dynamic Workflows

- **What it is.** Documented: Cognition's commercial service, with cloud sessions and a local CLI. Enterprise uses ACUs; self-serve plans use quota and prepaid credits. Current docs were seen on 2026-10-08. [Usage](https://docs.devin.ai/admin/billing/usage), [Devin CLI](https://docs.devin.ai/work-with-devin/devin-cli)
- **Command-center shape.** Documented: Any Devin session can coordinate managed child sessions. A workflow adds deterministic orchestration code around the conversation. [Advanced Capabilities](https://docs.devin.ai/work-with-devin/advanced-capabilities), [Dynamic Workflows](https://docs.devin.ai/work-with-devin/dynamic-workflows)
- **Dispatch.** Documented: The manager scopes work packages, prompts, playbooks, tags and per-child ACU limits. A workflow can fan out or pipeline structured results. [Managed Devins](https://docs.devin.ai/work-with-devin/advanced-capabilities), [Workflows](https://docs.devin.ai/work-with-devin/dynamic-workflows)
- **What the hub sees.** Documented: Child status and compute consumption; full session events can be listed, searched and fetched through MCP. This is a useful summary-first, detail-on-demand interface. [Session inspection](https://docs.devin.ai/work-with-devin/devin-mcp)
- **Talking to workers.** Documented: The manager sends child follow-ups, sleeps or terminates children, and wakes automatically when they finish or need input. MCP also lets outside agents manage Devin sessions. The current API is v3; v1/v2 are legacy. [Managed controls](https://docs.devin.ai/work-with-devin/advanced-capabilities), [MCP](https://docs.devin.ai/work-with-devin/devin-mcp), [API overview](https://docs.devin.ai/api-reference/overview)
- **Attention and approvals.** Documented: Child launches and workflows are auto-approved by default, with preference switches to require review. A user can stop a running workflow and open its child sessions. Organization roles govern these operations; this is not a promise that every child tool requires human approval. [Launch defaults](https://docs.devin.ai/work-with-devin/advanced-capabilities), [Workflow control](https://docs.devin.ai/work-with-devin/dynamic-workflows)
- **Isolation and merge.** Documented: Managed children normally run on separate VMs. Workflow agents can instead share the manager's machine. The manager resolves conflicts; no guaranteed automatic merge correctness was established. [Managed isolation](https://docs.devin.ai/work-with-devin/advanced-capabilities), [Execution locations](https://docs.devin.ai/work-with-devin/dynamic-workflows)
- **Memory and continuity.** Documented: Workflow run IDs retain completed results for replay/resume. Playbooks and knowledge reuse organizational procedures; personal Memory and Dreaming carry preferences and lessons across sessions. [Workflow recovery](https://docs.devin.ai/work-with-devin/dynamic-workflows), [Memory](https://docs.devin.ai/product-guides/memory)
- **Voice and mobile.** Documented: Voice mode supports spoken planning and handoff. A native mobile fleet-management experience was not verified in these sources. [Voice mode](https://docs.devin.ai/work-with-devin/voice-mode)
- **Providers.** Documented: Worker sessions are Devins. External agents can coordinate them through Devin MCP; that does not make Devin an account-wide manager of arbitrary local CLI sessions. [MCP](https://docs.devin.ai/work-with-devin/devin-mcp)
- **Does well.** Inferred: Automatic completion/input events avoid expensive periodic reasoning checks. Recorded workflow results improve recovery and explain what actually ran. [Managed controls](https://docs.devin.ai/work-with-devin/advanced-capabilities), [Recorded execution](https://docs.devin.ai/work-with-devin/dynamic-workflows)
- **Falls short.** Documented, Cognition's April 22, 2026 engineering account: Managers can overprescribe work without codebase knowledge, assume state is shared, and fail to relay discoveries between children. It publishes no controlled manager overhead figure. [What is working](https://cognition.com/blog/multi-agents-working)
- **For Sotto.** Inferred: Take event-driven wake-ups and fetchable event detail, adapted to Sotto IDs. [MCP](https://docs.devin.ai/work-with-devin/devin-mcp)
  Inferred: Avoid default launch approvals becoming tool approvals or adopting Devin's cloud/storage boundary as Sotto's. [MCP](https://docs.devin.ai/work-with-devin/devin-mcp), [Sotto identity](../adr/0002-sotto-owned-thread-identity.md), [Sotto rules](../../AGENTS.md)

## Factory: Missions and custom droids

- **What it is.** Documented: Factory's commercial CLI and app. Individual Pro starts at $20/month in the live pricing seen on 2026-10-08. Missions require Extra Usage enabled and pause on rate limits. Some old documentation paths now redirect to `docs.factory.com`. [Pricing](https://docs.factory.ai/pricing/individuals), [Current Missions docs](https://docs.factory.com/missions/overview)
- **Command-center shape.** Documented: A conversational Mission orchestrator plus Mission Control. Ordinary custom droids are focused subagents, not persistent project managers. [Missions](https://docs.factory.com/missions/overview), [Subagents source documentation](https://raw.githubusercontent.com/Factory-AI/factory/c6ea47082007a32a8a76bb99da42e387565f119a/docs/cli/configuration/custom-droids.mdx)
- **Dispatch.** Documented: Collaborate on features, milestones and success criteria before approving execution. Workers implement; validation workers check milestones. [Planning](https://docs.factory.com/missions/planning)
- **What the hub sees.** Documented: Feature/milestone progress and worker activity in Mission Control. Custom Task calls stream tool activity and return results; TaskOutput retrieves background output. [Running Missions](https://docs.factory.ai/missions/running-cli), [Subagents](https://raw.githubusercontent.com/Factory-AI/factory/c6ea47082007a32a8a76bb99da42e387565f119a/docs/cli/configuration/custom-droids.mdx)
- **Talking to workers.** Documented: Users pause and redirect the orchestrator. Task supports foreground/background execution, stop and resume by task ID. Worker-to-worker mail was not established by these pages. [Running Missions](https://docs.factory.ai/missions/running-cli), [Task controls](https://raw.githubusercontent.com/Factory-AI/factory/c6ea47082007a32a8a76bb99da42e387565f119a/docs/cli/configuration/custom-droids.mdx)
- **Attention and approvals.** Documented: Mission plan approval starts execution. Subagents inherit or use a configured autonomy level, capped by enterprise policy; AskUser is disabled inside them, so blockers return to the parent. Approval of a plan does not explain every later tool decision. [Missions](https://docs.factory.com/missions/overview), [Subagent autonomy](https://raw.githubusercontent.com/Factory-AI/factory/c6ea47082007a32a8a76bb99da42e387565f119a/docs/cli/configuration/custom-droids.mdx)
- **Isolation and merge.** Could not verify a mandatory separate worktree per Mission worker or a specified merge queue from the inspected guides. Vendor product copy claims conflict coordination; treat that as a claim until the execution contract is established. [Product description](https://factory.ai/product/missions), [Missions reference](https://docs.factory.com/missions/reference)
- **Memory and continuity.** Documented: Missions inherit AGENTS.md, skills, MCP, hooks and custom droids. Subagent resume retains its transcript. Mission-specific crash/restart guarantees were not established. [Reference](https://docs.factory.com/missions/reference), [Subagent resume](https://raw.githubusercontent.com/Factory-AI/factory/c6ea47082007a32a8a76bb99da42e387565f119a/docs/cli/configuration/custom-droids.mdx)
- **Voice and mobile.** Could not verify a Mission voice/mobile interface in the inspected guides. [Missions surfaces](https://docs.factory.com/missions/overview)
- **Providers.** Documented: Orchestrator, workers and validators have separately configurable models. This is multiple models inside Droid, not a hub over installed competing CLIs. [Model settings](https://docs.factory.com/missions/reference)
- **Does well.** Inferred: Milestone validation and an explicit warning that the app needs a scriptable QA environment connect completion to an exercisable product. [Planning and QA](https://docs.factory.com/missions/planning)
- **Falls short.** Documented: Factory still calls parallelism's benefit and cost/quality balance open questions. User report #99 describes mission proposal and question tools breaking in Droid 0.150.1 on June 18, 2026; it remained open when inspected. [Open questions](https://docs.factory.com/missions/overview), [#99](https://github.com/Factory-AI/droid-action/issues/99)
- **For Sotto.** Inferred: Take milestones with independent verification criteria. [Planning](https://docs.factory.com/missions/planning)
  Inferred: Avoid hiding blocked worker input behind an opaque manager or assuming a plan approval grants authority. [Planning](https://docs.factory.com/missions/planning), [Sotto authority](../adr/0004-authority-in-policy-records.md)

## Kilo Code: native delegation, Swarm and Agent Manager

- **What it is.** Documented / observed: Kilo's MIT coding agent for IDEs and CLI, with mobile/cloud surfaces. Live docs on 2026-10-08 deprecate the dedicated Orchestrator mode; this is a material change from older Roo-derived descriptions. [Repository](https://github.com/Kilo-Org/kilocode), [Deprecation](https://kilo.ai/docs/code-with-ai/agents/orchestrator-mode)
- **Command-center shape.** Documented: Code, Plan and Debug can delegate directly. Swarm is a shared board within one task tree. Agent Manager separately supervises independent top-level sessions, and a chat agent can control those through a tool. [Orchestration layers](https://kilo.ai/docs/automate/agent-manager), [Board tools](https://kilo.ai/docs/automate/tools)
- **Dispatch.** Documented: `task` launches foreground/background children. `agent_manager` creates independent worktree or local sessions. It can list actual session IDs before sending targeted prompts. [Task delegation](https://kilo.ai/docs/code-with-ai/agents/orchestrator-mode), [Manager tool](https://kilo.ai/docs/automate/tools)
- **What the hub sees.** Documented: Board posts can contain findings, blockers and corrections; manager sessions provide status, diffs and review/PR surfaces. Notices are best-effort and do not prove a worker read a message. [Board contract](https://kilo.ai/docs/automate/tools), [Agent Manager](https://kilo.ai/docs/automate/agent-manager)
- **Talking to workers.** Documented: Board reads use an incremental cursor. Posting does not wake or assign a worker, and unrelated sessions do not share the board. Targeted manager prompts queue while a session is busy. [Board semantics](https://kilo.ai/docs/automate/tools), [Prompt delivery](https://kilo.ai/docs/automate/agent-manager)
- **Attention and approvals.** Documented: Pending questions/permissions block new prompts. The agent can answer questions through an approved action; permission requests are resolved in Agent Manager's Permission Dock. Creation, prompting, stopping, moving and answering have separately scoped approvals. [Manager control](https://kilo.ai/docs/automate/agent-manager)
- **Isolation and merge.** Documented: Child tasks share the parent's project/worktree, so edits are not isolated. Agent Manager can create separate worktrees and exposes review/merge controls. [Deprecation guide](https://kilo.ai/docs/code-with-ai/agents/orchestrator-mode), [Agent Manager](https://kilo.ai/docs/automate/agent-manager)
- **Memory and continuity.** Documented: Session history and custom agent definitions persist. A durable account-wide command-center recovery guarantee was not established. Board membership follows a task tree, not every session in a repository. [Custom subagents](https://kilo.ai/docs/customize/custom-subagents), [Board scope](https://kilo.ai/docs/automate/tools)
- **Voice and mobile.** Documented: iOS/Android clients and voice dictation; on-device recognition is the default, with an explicit Gateway transcription option. This is prompt input, not evidence of spoken fleet supervision. [Mobile](https://kilo.ai/docs/code-with-ai/platforms/mobile)
- **Providers.** Documented: Configurable models per agent/subagent. Subagent model fallback and permission settings are explicit in custom definitions. [Custom subagents](https://kilo.ai/docs/customize/custom-subagents)
- **Does well.** Inferred: It separates message receipt, wake-up, task assignment and consent, and distinguishes children from independently supervised sessions. [Tool contracts](https://kilo.ai/docs/automate/tools)
- **Falls short.** Documented / inferred: Swarm cannot serve as the all-thread board by itself. Shared-checkout children can conflict. The deprecated Orchestrator is an unsuitable current feature specification. [Board scope](https://kilo.ai/docs/automate/tools), [Deprecation](https://kilo.ai/docs/code-with-ai/agents/orchestrator-mode)
- **For Sotto.** Inferred: Take explicit delivery states and discovery of real IDs before sending. [Manager control](https://kilo.ai/docs/automate/agent-manager)
  Inferred: Avoid allowing its question-answer action to answer requests Sotto reserves for the user. [Manager control](https://kilo.ai/docs/automate/agent-manager), [Sotto authority](../adr/0004-authority-in-policy-records.md)

## Overstory: persistent coordinator and real-user failures

- **What it is.** Observed: Jaymin West's MIT CLI orchestrator; main's package is 0.11.0. The original repository was archived May 28, 2026 and directs new development to Warren. Issues show use, not a measured active-user count. [Repository](https://github.com/jayminwest/overstory), [Package](https://raw.githubusercontent.com/jayminwest/overstory/main/package.json)
- **Command-center shape.** Documented: A persistent coordinator over leads and workers, with CLI/web fleet views. [README](https://github.com/jayminwest/overstory#readme)
- **Dispatch.** Observed: The coordinator decomposes work into task groups and delegates ownership through leads. Recovery reads checkpoints, sessions, groups and mail. [Coordinator definition](https://raw.githubusercontent.com/jayminwest/overstory/main/agents/coordinator.md)
- **What the hub sees.** Documented / observed: Worker state, mail, timelines and usage estimates. Typed `worker_done` and `merge_ready` events mean different things; the coordinator is instructed not to infer readiness from a completed status. [README](https://github.com/jayminwest/overstory#readme), [Coordinator definition](https://raw.githubusercontent.com/jayminwest/overstory/main/agents/coordinator.md)
- **Talking to workers.** Documented: SQLite mail supports worker communication. Interactive workers can be steered through tmux. [README](https://github.com/jayminwest/overstory#readme)
- **Attention and approvals.** Observed: Critical escalations stop dispatch until the human responds. Headless Claude workers use `bypassPermissions`; interactive runtime settings offer ask/bypass choices. [Coordinator](https://raw.githubusercontent.com/jayminwest/overstory/main/agents/coordinator.md), [Claude runtime](https://raw.githubusercontent.com/jayminwest/overstory/main/src/runtimes/claude.ts)
- **Isolation and merge.** Observed: Worktrees and a merge queue. Resolver escalation progresses from clean merge to mechanical/AI repair and then reimplementation, which changes the work rather than merely transporting it. [README](https://github.com/jayminwest/overstory#readme), [Resolver](https://raw.githubusercontent.com/jayminwest/overstory/main/src/merge/resolver.ts)
- **Memory and continuity.** Observed: Checkpoints and external coordination/expertise records let a replacement session recover its role. [Coordinator definition](https://raw.githubusercontent.com/jayminwest/overstory/main/agents/coordinator.md)
- **Voice and mobile.** Could not verify either from the repository's documented surfaces. [README](https://github.com/jayminwest/overstory#readme)
- **Providers.** Documented: Runtime adapters include Claude Code, Codex, Gemini and Amp. [README](https://github.com/jayminwest/overstory#readme)
- **Does well.** Inferred: It explicitly separates implementation completion from merge readiness and documents the cost of coordination. [Coordinator](https://raw.githubusercontent.com/jayminwest/overstory/main/agents/coordinator.md), [Author's risk analysis](https://raw.githubusercontent.com/jayminwest/overstory/main/STEELMAN.md)
- **Falls short.** User reports: #131 (March 24) describes reviewers missing nonfunctional Lambda reconnection before coordinator merge; #103 (March 8, v0.8.6) reports commits including unrelated human edits; #141 (April 9, v0.9.3) reports Windows/POSIX path mismatches blocking writes. Current Warren behavior and fixes were not verified. [#131](https://github.com/jayminwest/overstory/issues/131), [#103](https://github.com/jayminwest/overstory/issues/103), [#141](https://github.com/jayminwest/overstory/issues/141)
- **For Sotto.** Inferred: Take typed readiness events and recoverable coordination records. [Coordinator](https://raw.githubusercontent.com/jayminwest/overstory/main/agents/coordinator.md)
  Inferred: Avoid interpreting completion prose as verified behavior, automatic merge authority, or permission bypass. [Coordinator](https://raw.githubusercontent.com/jayminwest/overstory/main/agents/coordinator.md), [Sotto authority](../adr/0004-authority-in-policy-records.md)

## OpenHands: TaskToolSet and delegation infrastructure

- **What it is.** Documented / observed: OpenHands' MIT Software Agent SDK, alongside CLI/cloud products. Source inspected at `9c4fd8c` on 2026-10-08. Old DelegateTool examples are superseded by TaskToolSet. [SDK repository](https://github.com/OpenHands/software-agent-sdk), [Migration issue](https://github.com/OpenHands/benchmarks/issues/715)
- **Command-center shape.** Documented: A parent agent delegates to specialized child conversations. Current TaskToolSet is synchronous; it is not an account-wide, always-running conversational command center. [Task guide](https://docs.openhands.dev/sdk/guides/task-tool-set)
- **Dispatch.** Documented: A task prompt and subagent type create a child; a task ID resumes its previous conversation. The parent blocks for the result. [Task lifecycle](https://docs.openhands.dev/sdk/guides/task-tool-set)
- **What the hub sees.** Documented / observed: A typed observation carries task ID, child type, completion/error status and text. Source rolls child metrics into parent totals. Status does not prove the requested behavior passed. [Task observation](https://docs.openhands.dev/sdk/guides/task-tool-set), [Metrics source](https://github.com/OpenHands/software-agent-sdk/blob/9c4fd8c6664dfce98524d04d965b4f009f390fbe/openhands-tools/openhands/tools/task/manager.py)
- **Talking to workers.** Documented: Follow-up calls resume by task ID with full child history. A persistent peer mailbox was not established by the task guide. [Resumption](https://docs.openhands.dev/sdk/guides/task-tool-set)
- **Attention and approvals.** Documented / observed: The SDK offers AlwaysConfirm, NeverConfirm and risk-based policies. Task source inherits or sets child policy, but its run loop continues pending actions when no confirmation handler is supplied. A Sotto integration would need an explicit human handler; policy inheritance alone is insufficient. [Security guide](https://docs.openhands.dev/sdk/guides/security), [Confirmation loop](https://github.com/OpenHands/software-agent-sdk/blob/9c4fd8c6664dfce98524d04d965b4f009f390fbe/openhands-tools/openhands/tools/task/manager.py#L455)
- **Isolation and merge.** Observed: Children use the parent's working directory. Task delegation does not create a worktree or merge queue. [Task manager](https://github.com/OpenHands/software-agent-sdk/blob/9c4fd8c6664dfce98524d04d965b4f009f390fbe/openhands-tools/openhands/tools/task/manager.py)
- **Memory and continuity.** Documented / observed: Child histories persist for resume; source uses a parent's persistence directory when available, otherwise temporary storage. Broader conversation persistence is configurable. [Task guide](https://docs.openhands.dev/sdk/guides/task-tool-set), [Source](https://github.com/OpenHands/software-agent-sdk/blob/9c4fd8c6664dfce98524d04d965b4f009f390fbe/openhands-tools/openhands/tools/task/manager.py), [Persistence](https://docs.openhands.dev/sdk/guides/convo-persistence)
- **Voice and mobile.** Could not verify native voice/mobile delegation controls in the SDK documentation. [SDK overview](https://docs.openhands.dev/sdk)
- **Providers.** Documented: Configurable LLM providers; an ACP agent can delegate to compatible CLI servers. That is a programmable bridge, not proof of a finished cross-provider command center. [ACP guide](https://docs.openhands.dev/sdk/guides/agent-acp)
- **Does well.** Inferred: Typed results, explicit resumption and combined metrics are useful building blocks. [Task guide](https://docs.openhands.dev/sdk/guides/task-tool-set), [Metrics](https://docs.openhands.dev/sdk/guides/metrics)
- **Falls short.** Observed, repository issue: SDK v1.23.0 removed DelegateTool and broke benchmark imports; #715 was closed through migration. Inferred: synchronous tasks and shared files do not solve independently running thread management. [#715](https://github.com/OpenHands/benchmarks/issues/715), [Task guide](https://docs.openhands.dev/sdk/guides/task-tool-set)
- **For Sotto.** Inferred: Take structured child outcomes and explicit evidence retrieval. [Task manager](https://github.com/OpenHands/software-agent-sdk/blob/9c4fd8c6664dfce98524d04d965b4f009f390fbe/openhands-tools/openhands/tools/task/manager.py)
  Inferred: Avoid adopting its default missing-handler behavior or equating a tool's completed status with verified work. [Task manager](https://github.com/OpenHands/software-agent-sdk/blob/9c4fd8c6664dfce98524d04d965b4f009f390fbe/openhands-tools/openhands/tools/task/manager.py), [Sotto authority](../adr/0004-authority-in-policy-records.md)

## Cline: agent teams and subagents

- **What it is.** Documented: Apache-2.0 Cline, available as SDK, IDE extensions, CLI and Desktop. Docs seen on 2026-10-08 distinguish the newer CLI/SDK coordination from extension capabilities. [Repository](https://github.com/cline/cline), [Teams](https://docs.cline.bot/cli/agent-teams), [Subagents](https://docs.cline.bot/features/subagents)
- **Command-center shape.** Documented: A coordinator over teammates and a shared task board. Teams apply to SDK, CLI and Kanban, not the VS Code/JetBrains extensions. [Teams](https://docs.cline.bot/cli/agent-teams)
- **Dispatch.** Documented: `/team` requests coordination, but Cline can form a team automatically. The coordinator spawns teammates, assigns/runs tasks and combines outcomes. [CLI behavior](https://docs.cline.bot/cli/agent-teams), [SDK tools](https://docs.cline.bot/sdk/guides/multi-agent-teams)
- **What the hub sees.** Documented: Team status, runs, task claims/completions, mission log and outcome fragments. Outcome tools separate attaching a result from reviewing/finalizing it. [SDK tools](https://docs.cline.bot/sdk/guides/multi-agent-teams)
- **Talking to workers.** Documented: Direct messages, broadcasts and mailbox reads. Teammates have peer tools, while only the coordinator can spawn or shut down the team. [SDK roles](https://docs.cline.bot/sdk/guides/multi-agent-teams)
- **Attention and approvals.** Documented: Approving `spawn_agent` authorizes all that subagent's tool calls; its tools do not ask again. Plan mode reduces available edits but does not block every filesystem mutation. The SDK offers approval callbacks, but the inspected team guide does not fully specify teammate prompt routing. [Subagent approvals](https://docs.cline.bot/features/subagents), [SDK approval surface](https://docs.cline.bot/cline-sdk/sessions)
- **Isolation and merge.** Could not verify automatic worktrees or a merge queue per teammate. SDK examples configure a workspace; outcome merging describes results, not necessarily Git integration. [SDK team guide](https://docs.cline.bot/sdk/guides/multi-agent-teams)
- **Memory and continuity.** Documented: Task board, mailbox, mission log, outcomes and teammates are stored in `teams.db` under session ID and restored on resume. Ordinary subagents do not provide that persistent team state. [Persistence](https://docs.cline.bot/sdk/guides/multi-agent-teams)
- **Voice and mobile.** Could not verify a voice/mobile team command center in these guides. [Teams](https://docs.cline.bot/cli/agent-teams)
- **Providers.** Documented: Configurable providers/models through Cline's harness. The SDK also supports local/hub/remote execution backends. [ClineCore](https://docs.cline.bot/cline-sdk/sessions)
- **Does well.** Inferred: Persistent team state and a reviewed outcome lifecycle go beyond a collection of transient subagent reports. [SDK outcome tools](https://docs.cline.bot/sdk/guides/multi-agent-teams)
- **Falls short.** Documented: Teams add overhead and are unsuitable for simpler work. Subagent-wide approval is a material incompatibility with Sotto, even for a task described as research. [Team guidance](https://docs.cline.bot/sdk/guides/multi-agent-teams), [Approval warning](https://docs.cline.bot/features/subagents)
- **For Sotto.** Inferred: Take persistent mail/task/outcome records. [Persistence](https://docs.cline.bot/sdk/guides/multi-agent-teams)
  Inferred: Avoid translating permission to launch a worker into blanket permission for its actions. [Persistence](https://docs.cline.bot/sdk/guides/multi-agent-teams), [Sotto authority](../adr/0004-authority-in-policy-records.md)

## Roo Code: Boomerang as a historical pattern

- **What it is.** Observed / documented: Roo Code, Inc.'s Apache-2.0 VS Code extension shut down May 15, 2026; source and archived docs remain. The company pivoted to Roomote. This section describes Boomerang, not a currently maintained Roo product. [Shutdown notice](https://github.com/RooCodeInc/Roo-Code), [Roomote](https://roomote.dev), [Archived guide](https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks/)
- **Command-center shape.** Documented: Orchestrator delegates through a nested task hierarchy. [Boomerang](https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks/)
- **Dispatch.** Documented: `new_task` pauses the parent until child completion. [Boomerang](https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks/)
- **What the hub sees.** Documented: Summary-only return; default Orchestrator cannot inspect files or run commands. [Boundary](https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks/)
- **Talking to workers.** Documented: Launch instructions down, `attempt_completion` summary up. No peer mailbox established. [Boomerang](https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks/)
- **Attention and approvals.** Documented: Child creation/completion requires approval by default, configurable through auto-approval. The UI permits navigation through active and paused tasks. [Task approvals](https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks/), [Auto-approval](https://roocodeinc.github.io/Roo-Code/features/auto-approving-actions/)
- **Isolation and merge.** Observed / documented: Task creation delegates inside the extension's workspace. Checkpoints record workspace changes; no per-child merge queue was verified. [NewTaskTool](https://github.com/RooCodeInc/Roo-Code/blob/main/src/core/tools/NewTaskTool.ts), [Checkpoints](https://roocodeinc.github.io/Roo-Code/features/checkpoints/)
- **Memory and continuity.** Documented: Task history and shadow-Git checkpoints persist; context transfer remains summary-only. [Checkpoints](https://roocodeinc.github.io/Roo-Code/features/checkpoints/), [Boomerang](https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks/)
- **Voice and mobile.** Could not verify either as part of the archived Boomerang contract. [Guide](https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks/)
- **Providers.** Documented: Multiple AI-provider profiles; these select models for Roo, not independent competing CLI threads. [Profiles](https://roocodeinc.github.io/Roo-Code/features/api-configuration-profiles/)
- **Does well.** Inferred: Its narrow coordinator keeps execution detail out of the management conversation. [Default tool limits](https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks/)
- **Falls short.** Inferred: Summary-only reporting prevents independent verification. Documented: discontinued product. [Boomerang](https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks/), [Shutdown](https://github.com/RooCodeInc/Roo-Code)
- **For Sotto.** Inferred: Take focused task briefs and clear parent/child navigation. [Boomerang](https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks/)
  Inferred: Avoid summary-only verification or forcing independent threads into a serial task stack. [Boomerang](https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks/), [Sotto context](../../CONTEXT.md)

## Ruflo / claude-flow: queen-led swarms and a verification caution

- **What it is.** Documented / observed: Ruvnet's MIT harness, renamed from Claude Flow to Ruflo. Source inspected at `5f709e3` on 2026-10-08. Its current README advertises native Claude Code/Codex integration and optional console/plugins. [Repository](https://github.com/ruvnet/ruflo), [Pinned README](https://raw.githubusercontent.com/ruvnet/ruflo/5f709e36799274be6bb68fff69090bdbc8621220/README.md)
- **Command-center shape.** Observed: Hive Mind supplies a Queen prompt, worker registry, shared memory and consensus tools. The prompt tells the Queen to coordinate workers; a topology label alone does not establish executing processes. [Hive source](https://github.com/ruvnet/ruflo/blob/5f709e36799274be6bb68fff69090bdbc8621220/v3/%40claude-flow/cli/src/commands/hive-mind.ts)
- **Dispatch.** Observed: Current `hive-mind work` claims a queued task and actually runs `claude -p`, then records success/error, session ID, elapsed time and reported cost. This is stronger evidence than older registry-only descriptions. [Worker execution source](https://github.com/ruvnet/ruflo/blob/5f709e36799274be6bb68fff69090bdbc8621220/v3/%40claude-flow/cli/src/commands/hive-mind-worker.ts)
- **What the hub sees.** Documented / observed: Console status, outputs, models, tokens and cost; the README explicitly labels its displayed workflow animation a sample. The worker path captures provider output and exit status, not a separately verified diff. [README](https://raw.githubusercontent.com/ruvnet/ruflo/5f709e36799274be6bb68fff69090bdbc8621220/README.md), [Worker source](https://github.com/ruvnet/ruflo/blob/5f709e36799274be6bb68fff69090bdbc8621220/v3/%40claude-flow/cli/src/commands/hive-mind-worker.ts)
- **Talking to workers.** Observed: Hive broadcast, task and memory tools; a Queen prompt orchestrates these. Cross-machine federation is separately advertised and would add a distinct sharing boundary. [Hive source](https://github.com/ruvnet/ruflo/blob/5f709e36799274be6bb68fff69090bdbc8621220/v3/%40claude-flow/cli/src/commands/hive-mind.ts), [README](https://raw.githubusercontent.com/ruvnet/ruflo/5f709e36799274be6bb68fff69090bdbc8621220/README.md)
- **Attention and approvals.** Observed: Current Queen launch adds skip-permissions only when explicitly requested. The inspected worker runner does not itself add that flag. A unified human approval/takeover interface across all advertised paths was not verified. [Queen launch](https://github.com/ruvnet/ruflo/blob/5f709e36799274be6bb68fff69090bdbc8621220/v3/%40claude-flow/cli/src/commands/hive-mind.ts), [Worker runner](https://github.com/ruvnet/ruflo/blob/5f709e36799274be6bb68fff69090bdbc8621220/v3/%40claude-flow/cli/src/commands/hive-mind-worker.ts)
- **Isolation and merge.** Observed: This worker execution path uses the supplied cwd without making a worktree. A reliable general merge queue across the larger plugin surface was not established. [Worker source](https://github.com/ruvnet/ruflo/blob/5f709e36799274be6bb68fff69090bdbc8621220/v3/%40claude-flow/cli/src/commands/hive-mind-worker.ts)
- **Memory and continuity.** Documented / observed: Shared/vector memory is advertised; Hive exposes memory backends and stores a Queen prompt for continuation. Persisted registry state and resumable reasoning are separate guarantees. [README](https://raw.githubusercontent.com/ruvnet/ruflo/5f709e36799274be6bb68fff69090bdbc8621220/README.md), [Hive source](https://github.com/ruvnet/ruflo/blob/5f709e36799274be6bb68fff69090bdbc8621220/v3/%40claude-flow/cli/src/commands/hive-mind.ts)
- **Voice and mobile.** Could not verify native voice/mobile orchestration in the inspected core sources. [README](https://raw.githubusercontent.com/ruvnet/ruflo/5f709e36799274be6bb68fff69090bdbc8621220/README.md)
- **Providers.** Documented / observed: Broader harness advertises several integrations; this inspected Hive worker path specifically runs Claude Code. Do not generalize one implementation to every runtime. [README](https://raw.githubusercontent.com/ruvnet/ruflo/5f709e36799274be6bb68fff69090bdbc8621220/README.md), [Runner](https://github.com/ruvnet/ruflo/blob/5f709e36799274be6bb68fff69090bdbc8621220/v3/%40claude-flow/cli/src/commands/hive-mind-worker.ts)
- **Does well.** Inferred: A concrete subprocess outcome with IDs, errors and cost is a useful minimum for proving dispatch occurred. [Worker source](https://github.com/ruvnet/ruflo/blob/5f709e36799274be6bb68fff69090bdbc8621220/v3/%40claude-flow/cli/src/commands/hive-mind-worker.ts)
- **Falls short.** User reports: March #1397 describes registered workers that never executed in v3.5.42. July #2799 reports inconsistent stores making status show zero workers in v3.32.22; #2808 confirms the total-count fix in v3.32.24 but reports idle workers labelled active. These closed historical issues do not prove the current runner is fake. They do demonstrate why status and claimed capabilities need verification. [#1397](https://github.com/ruvnet/ruflo/issues/1397), [#2799](https://github.com/ruvnet/ruflo/issues/2799), [#2808](https://github.com/ruvnet/ruflo/issues/2808)
- **For Sotto.** Inferred: Take process-backed dispatch receipts and reconciled state. [Worker source](https://github.com/ruvnet/ruflo/blob/5f709e36799274be6bb68fff69090bdbc8621220/v3/%40claude-flow/cli/src/commands/hive-mind-worker.ts)
  Inferred: Avoid registry entries, consensus labels or attractive sample dashboards being mistaken for completed work; avoid copying prompt/output logs. [Worker source](https://github.com/ruvnet/ruflo/blob/5f709e36799274be6bb68fff69090bdbc8621220/v3/%40claude-flow/cli/src/commands/hive-mind-worker.ts), [Sotto privacy](../../AGENTS.md)

## Patterns across this lane

### What belongs in the coordinator's context

**Inferred:** Keep the user's objective, decisions, scope, dependencies and a small current thread roster in the management conversation. Fetch worker detail when needed. Gas Town makes this separation explicit; Devin exposes summary/detail event reads; Roo demonstrates the limit of relying only on summaries. Fetchable evidence is the missing companion to context compression. [Mayor source](https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/internal/templates/roles/mayor.md.tmpl), [Devin MCP](https://docs.devin.ai/work-with-devin/devin-mcp), [Boomerang](https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks/)

**Inferred for Sotto:** The host should hold status, pending requests, send receipts and the newest user-message identity. The coordinator reads these by Sotto thread ID before sending or summarizing. An acknowledgement that a prompt was accepted must remain distinct from delivery, a worker reply, verified behavior and merged work. Existing takeover and stale-reply checks already supply part of that contract. [Sotto context](../../CONTEXT.md), [Sotto-owned identity](../adr/0002-sotto-owned-thread-identity.md)

### Evidence and counter-evidence

- **Documented, Anthropic engineering, June 13, 2025:** Its lead/research-worker system improved an internal research evaluation by 90.2% over single-agent Opus 4. It reports roughly 15 times chat token use, compared with roughly four times for agents generally. Workers filter independent research; external plans and artifact references reduce handoff loss. Early failures included unnecessary spawning, duplication and unbounded searches. The synchronous system could not steer workers during a run. Anthropic explicitly cautions that coding is less independently divisible. This supports selective delegation, not a general coding-productivity claim. [Engineering post](https://www.anthropic.com/engineering/multi-agent-research-system)
- **Documented, Cognition, June 12, 2025 and April 22, 2026:** The original warning identifies incompatible implicit decisions and lossy handoffs. The follow-up endorses review loops and expert consultation with one writing agent. Weak models failed to know when or how to ask a stronger consultant. Full-context forks were a practical compromise. Neither post establishes a universal ban or a measured coordination discount. [Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents), [2026 revision](https://cognition.com/blog/multi-agents-working)
- **Observed, MAST v3, October 26, 2025:** The taxonomy derives from 150 expert-analyzed traces; its expanded dataset contains 1,642 traces across seven frameworks. Fourteen modes span design, alignment and verification. Examples include a planner accepting example test output as real results and an editor claiming an unapplied edit. The earlier v2 category percentages should not be substituted for v3 results. These are trace studies, not failure rates for Sotto or the products above. [Paper/version history](https://arxiv.org/abs/2503.13657), [v3 examples](https://arxiv.org/html/2503.13657v3#A14)
- **Documented, Google research, January 28, 2026:** Across 180 configurations, centralized coordination improved Finance-Agent performance by 80.9%, while multi-agent setups degraded sequential PlanCraft results by 39–70%. Error amplification was 17.2 times in independent systems and 4.4 times in centralized ones. These benchmark-specific findings support coordination as a validation bottleneck; they do not measure coding throughput or approval safety. [Research post](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/), [Paper](https://arxiv.org/abs/2512.08296)
- **Documented, Anthropic research, August 13, 2026:** Cooperating vulnerability agents found 266 vulnerabilities using 27 million tokens; independent agents found 21 using 6.5 million. Search coverage differed; within comparable directories, tokens per finding were similar. In twelve-hour game-building experiments, CEO hierarchies did not materially rescue poor outcomes. Agents also trusted false peer information or failed to relay private discoveries. These are constructed experiments, not installed-product reliability measurements. [Research experiments](https://www.anthropic.com/research/multiagent-systems)

### Cost: what the available numbers do and do not say

| Evidence | Reported comparison | What it establishes |
| --- | --- | --- |
| Documented, Anthropic research system | About 15× chat tokens for multi-agent work; about 4× for agents generally | A chat baseline, not coordinator overhead over identical standalone coding workers. [Post](https://www.anthropic.com/engineering/multi-agent-research-system) |
| Documented, Claude Code | Team tokens scale with active teammates; cache and model choices affect cost | A warning to measure each role, without a universal multiplier. [Costs](https://code.claude.com/docs/en/costs) |
| Documented, Devin | Planning/actions and some VM/network usage consume quota; sleeping does not | A manager consumes compute too; event wake-ups help bound idle reasoning. [Usage](https://docs.devin.ai/admin/billing/usage) |
| Documented, Factory | Missions share limits and require Extra Usage; worker/validator models are configurable | Budget pressure can pause a run; validation is additional work. [Pricing](https://docs.factory.ai/pricing/individuals), [Model settings](https://docs.factory.com/missions/reference) |
| Author account, Overstory | Twenty-agent run: 8 million tokens/$60; sequential: 1.2 million/$9 | An anecdote without a reproducible equal-quality comparison. [STEELMAN](https://raw.githubusercontent.com/jayminwest/overstory/main/STEELMAN.md) |

**Inferred:** Measure total accepted work per cost, including manager, workers, reviewers, retries and integration. Lower wall time alone is insufficient. A useful Sotto pilot would compare the same tasks and acceptance checks with manually supervised workers and the command center, reporting unavailable provider cost data as unknown. [Google scaling study](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/), [Sotto coordinator independence](../../CONTEXT.md)

### Authority and takeover

**Inferred:** There are at least four separate decisions: start a worker, assign work, accept a plan, and authorize an action. The studied tools combine them differently. Claude gives plan acceptance to the lead while tool prompts go to the user; Cline subagent launch grants its later tool actions; Devin launches children by default; Kilo scopes manager actions separately. Sotto should preserve its own boundary across adapters instead of inheriting these products' defaults. [Claude permissions](https://code.claude.com/docs/en/agent-teams#permissions), [Cline approvals](https://docs.cline.bot/features/subagents), [Devin defaults](https://docs.devin.ai/work-with-devin/advanced-capabilities), [Kilo scopes](https://kilo.ai/docs/automate/agent-manager), [Sotto authority](../adr/0004-authority-in-policy-records.md)

**Inferred:** Human takeover needs a state transition, not just another message in the mailbox. Keep a worker directly accessible, suspend automatic sends after a takeover and reject stale coordinator replies. A blocked permission must remain visible even if the coordinator sleeps, crashes or summarizes incorrectly. [Sotto takeover and stale-reply checks](../../CONTEXT.md), [Historical invisible-prompt report](https://github.com/anthropics/claude-code/issues/36007)

## Gaps nobody fills well

- **Inferred, within this study:** A verified global conversation over already-running heterogeneous local CLI threads, with durable attention routing and human-only permissions. Puck is closest in interaction shape; Gas Town is closest in runtime diversity, but their authority/storage choices differ from Sotto's. This is not a claim that no other product exists. [Puck](https://ampcode.com/docs/puck), [Gas Town presets](https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/internal/config/agents.go), [Sotto rules](../../AGENTS.md)
- **Inferred:** Completion claims tied to immutable evidence: which checkout/version, which test exit, which artifact and which revision the human reviewed. Existing completion text and task statuses are insufficient; MAST and Overstory provide concrete counterexamples. [MAST](https://arxiv.org/html/2503.13657v3), [Overstory #131](https://github.com/jayminwest/overstory/issues/131)
- **Could not verify:** A controlled cost comparison between a coordinator and the identical coding workers alone at equal accepted quality. The available research and author anecdotes use different baselines. [Anthropic research system](https://www.anthropic.com/engineering/multi-agent-research-system), [Overstory account](https://raw.githubusercontent.com/jayminwest/overstory/main/STEELMAN.md)
- **Inferred:** Restart reconciliation that admits a worker is missing, a summary is stale or a send is uncertain. Claude's resume limitations and Ruflo's historical status-store mismatch show why persisted conversation text cannot be the only authority. [Claude limitations](https://code.claude.com/docs/en/agent-teams#limitations), [Ruflo #2799](https://github.com/ruvnet/ruflo/issues/2799)
- **Inferred:** Approval prompts that remain reachable across desktop, phone and voice without a manager approving them. Amp demonstrates voice/mobile management, but its default tool policy differs; Cline and OpenHands expose delegation paths requiring special care. [Puck voice](https://ampcode.com/docs/puck), [Amp tools](https://ampcode.com/docs/tools), [Cline approvals](https://docs.cline.bot/features/subagents), [OpenHands task loop](https://github.com/OpenHands/software-agent-sdk/blob/9c4fd8c6664dfce98524d04d965b4f009f390fbe/openhands-tools/openhands/tools/task/manager.py#L455)
- **Could not verify:** Current fixes for every historical issue, production adoption counts, closed-source internal verification algorithms, Factory's mandatory worker isolation, or universal voice/mobile support. The sections above identify the exact evidence boundary. No app behavior, performance or permission guarantee was tested locally.

## Sources

### Amp

- [Puck](https://ampcode.com/docs/puck)
- [Introduction](https://ampcode.com/docs)
- [Pricing](https://ampcode.com/docs/pricing)
- [Agent to Agent](https://ampcode.com/docs/orbs/agent-to-agent)
- [Model roles](https://ampcode.com/docs/the-dial)
- [Oracle](https://ampcode.com/docs/tools)
- [Threads](https://ampcode.com/docs/threads)
- [Handoff](https://ampcode.com/news/handoff)

### Gas Town

- [Mayor instructions](https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/internal/templates/roles/mayor.md.tmpl)
- [Repository](https://github.com/gastownhall/gastown)
- [Launch post](https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04)
- [Architecture](https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/docs/design/architecture.md)
- [Convoys](https://github.com/gastownhall/gastown/blob/main/docs/concepts/convoy.md)
- [Command reference](https://github.com/gastownhall/gastown/blob/main/docs/reference.md)
- [Escalation](https://github.com/gastownhall/gastown/blob/main/docs/design/escalation.md)
- [Runtime flags](https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/internal/config/agents.go)
- [Emergency manual](https://steve-yegge.medium.com/gas-town-emergency-user-manual-cf0e4556d74b)
- [Refinery source](https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/internal/cmd/refinery.go)
- [#289](https://github.com/gastownhall/gastown/issues/289)
- [#3076](https://github.com/gastownhall/gastown/issues/3076)

### Claude Code

- [Team permissions](https://code.claude.com/docs/en/agent-teams#permissions)
- [Teams](https://code.claude.com/docs/en/agent-teams)
- [Costs](https://code.claude.com/docs/en/costs)
- [Team architecture](https://code.claude.com/docs/en/agent-teams#architecture)
- [Subagents](https://code.claude.com/docs/en/sub-agents)
- [Context](https://code.claude.com/docs/en/agent-teams#context-and-communication)
- [TaskCompleted](https://code.claude.com/docs/en/hooks#taskcompleted)
- [Subagents](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background)
- [Team guidance](https://code.claude.com/docs/en/agent-teams#best-practices)
- [Limitations](https://code.claude.com/docs/en/agent-teams#limitations)
- [Desktop limits](https://code.claude.com/docs/en/desktop)
- [Claude Code overview](https://code.claude.com/docs/en/overview)
- [#36007](https://github.com/anthropics/claude-code/issues/36007)

### Devin

- [Managed Devins](https://docs.devin.ai/work-with-devin/advanced-capabilities)
- [Dynamic Workflows](https://docs.devin.ai/work-with-devin/dynamic-workflows)
- [Usage](https://docs.devin.ai/admin/billing/usage)
- [Devin CLI](https://docs.devin.ai/work-with-devin/devin-cli)
- [Session inspection](https://docs.devin.ai/work-with-devin/devin-mcp)
- [API overview](https://docs.devin.ai/api-reference/overview)
- [Memory](https://docs.devin.ai/product-guides/memory)
- [Voice mode](https://docs.devin.ai/work-with-devin/voice-mode)

### Factory

- [Pricing](https://docs.factory.ai/pricing/individuals)
- [Current Missions docs](https://docs.factory.com/missions/overview)
- [Subagents source documentation](https://raw.githubusercontent.com/Factory-AI/factory/c6ea47082007a32a8a76bb99da42e387565f119a/docs/cli/configuration/custom-droids.mdx)
- [Planning](https://docs.factory.com/missions/planning)
- [Running Missions](https://docs.factory.ai/missions/running-cli)
- [Product description](https://factory.ai/product/missions)
- [Missions reference](https://docs.factory.com/missions/reference)
- [#99](https://github.com/Factory-AI/droid-action/issues/99)

### Kilo Code

- [Kilo delegation](https://kilo.ai/docs/code-with-ai/agents/orchestrator-mode)
- [Repository](https://github.com/Kilo-Org/kilocode)
- [Orchestration layers](https://kilo.ai/docs/automate/agent-manager)
- [Board tools](https://kilo.ai/docs/automate/tools)
- [Custom subagents](https://kilo.ai/docs/customize/custom-subagents)
- [Mobile](https://kilo.ai/docs/code-with-ai/platforms/mobile)

### Overstory

- [Repository](https://github.com/jayminwest/overstory)
- [Package](https://raw.githubusercontent.com/jayminwest/overstory/main/package.json)
- [README](https://github.com/jayminwest/overstory#readme)
- [Coordinator definition](https://raw.githubusercontent.com/jayminwest/overstory/main/agents/coordinator.md)
- [Claude runtime](https://raw.githubusercontent.com/jayminwest/overstory/main/src/runtimes/claude.ts)
- [Resolver](https://raw.githubusercontent.com/jayminwest/overstory/main/src/merge/resolver.ts)
- [Author's risk analysis](https://raw.githubusercontent.com/jayminwest/overstory/main/STEELMAN.md)
- [#131](https://github.com/jayminwest/overstory/issues/131)
- [#103](https://github.com/jayminwest/overstory/issues/103)
- [#141](https://github.com/jayminwest/overstory/issues/141)

### OpenHands

- [OpenHands task manager](https://github.com/OpenHands/software-agent-sdk/blob/9c4fd8c6664dfce98524d04d965b4f009f390fbe/openhands-tools/openhands/tools/task/manager.py)
- [SDK repository](https://github.com/OpenHands/software-agent-sdk)
- [Migration issue](https://github.com/OpenHands/benchmarks/issues/715)
- [Task guide](https://docs.openhands.dev/sdk/guides/task-tool-set)
- [Security guide](https://docs.openhands.dev/sdk/guides/security)
- [Confirmation loop](https://github.com/OpenHands/software-agent-sdk/blob/9c4fd8c6664dfce98524d04d965b4f009f390fbe/openhands-tools/openhands/tools/task/manager.py#L455)
- [Persistence](https://docs.openhands.dev/sdk/guides/convo-persistence)
- [SDK overview](https://docs.openhands.dev/sdk)
- [ACP guide](https://docs.openhands.dev/sdk/guides/agent-acp)
- [Metrics](https://docs.openhands.dev/sdk/guides/metrics)

### Cline

- [Repository](https://github.com/cline/cline)
- [Teams](https://docs.cline.bot/cli/agent-teams)
- [Subagents](https://docs.cline.bot/features/subagents)
- [SDK tools](https://docs.cline.bot/sdk/guides/multi-agent-teams)
- [SDK approval surface](https://docs.cline.bot/cline-sdk/sessions)

### Roo Code / Roomote

- [Shutdown notice](https://github.com/RooCodeInc/Roo-Code)
- [Roomote](https://roomote.dev)
- [Archived guide](https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks/)
- [Auto-approval](https://roocodeinc.github.io/Roo-Code/features/auto-approving-actions/)
- [NewTaskTool](https://github.com/RooCodeInc/Roo-Code/blob/main/src/core/tools/NewTaskTool.ts)
- [Checkpoints](https://roocodeinc.github.io/Roo-Code/features/checkpoints/)
- [Profiles](https://roocodeinc.github.io/Roo-Code/features/api-configuration-profiles/)

### Ruflo / Claude Flow

- [Repository](https://github.com/ruvnet/ruflo)
- [Pinned README](https://raw.githubusercontent.com/ruvnet/ruflo/5f709e36799274be6bb68fff69090bdbc8621220/README.md)
- [Hive source](https://github.com/ruvnet/ruflo/blob/5f709e36799274be6bb68fff69090bdbc8621220/v3/%40claude-flow/cli/src/commands/hive-mind.ts)
- [Worker execution source](https://github.com/ruvnet/ruflo/blob/5f709e36799274be6bb68fff69090bdbc8621220/v3/%40claude-flow/cli/src/commands/hive-mind-worker.ts)
- [#1397](https://github.com/ruvnet/ruflo/issues/1397)
- [#2799](https://github.com/ruvnet/ruflo/issues/2799)
- [#2808](https://github.com/ruvnet/ruflo/issues/2808)

### Research evidence

- [MAST v3](https://arxiv.org/html/2503.13657v3)
- [Cognition follow-up](https://cognition.com/blog/multi-agents-working)
- [Anthropic experiments](https://www.anthropic.com/research/multiagent-systems)
- [Engineering post](https://www.anthropic.com/engineering/multi-agent-research-system)
- [Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents)
- [Paper/version history](https://arxiv.org/abs/2503.13657)
- [v3 examples](https://arxiv.org/html/2503.13657v3#A14)
- [Research post](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/)
- [Paper](https://arxiv.org/abs/2512.08296)

### Sotto

- [thread IDs, privacy and permission rules](../../AGENTS.md)
- [coordinator, assignment, attention queue and takeover vocabulary](../../CONTEXT.md)
- [Sotto authority](../adr/0004-authority-in-policy-records.md)
- [Sotto identity](../adr/0002-sotto-owned-thread-identity.md)
