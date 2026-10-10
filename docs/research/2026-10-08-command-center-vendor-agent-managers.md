# Vendor command centers for coding-agent threads

Researched 2026-10-08. Scope: the major vendors' desktop, editor, web and mobile surfaces for managing concurrent coding sessions, including conversational control of other sessions. This is documentation, source and issue research; no applications were installed or run.

**Evidence labels.** Documented means the vendor says it. Observed means a source implementation or a dated issue/user report was inspected, not that the application was exercised. Inferred means a design reading. Current documentation was read on 2026-10-08; rollout and preview qualifications matter.

## Summary

- **Inferred: the closest references are conversational.** Claude/Cursor Projects, VS Code orchestration and ChatGPT Voice direct identifiable workers conversationally. [Claude](https://code.claude.com/docs/en/claude-projects), [Cursor](https://cursor.com/changelog/projects), [VS Code](https://code.visualstudio.com/docs/agents/run/sessions/manage-sessions), [ChatGPT Voice](https://learn.chatgpt.com/docs/features/voice)
- **Inferred: visibility differs from control.** Claude Desktop messaging and dots delegation each cover a subset of visible work. [Desktop](https://code.claude.com/docs/en/desktop), [Dots](https://learn.chatgpt.com/docs/dots/tasks-and-memory)
- **Inferred: the best attention idea is actionable waiting cards.** Kiro shows the question/command; Cursor groups demands for the user. [Kiro](https://kiro.dev/docs/ide/experimental/focus-mode/), [Cursor answer](https://forum.cursor.com/t/agents-approval-window/170388/5)
- **Inferred: hidden or misleading state recurs.** Reports describe missed approvals/stale status; Warp warns that parent success can hide unfinished children. [Cursor report](https://forum.cursor.com/t/agents-approval-window/170388), [VS Code issue](https://github.com/microsoft/vscode/issues/336955), [Warp](https://docs.warp.dev/platform/managing-cloud-agents/)
- **Documented: past five agents, organization dominates.** Air offers 5/10/15/all rows; VS Code offers grouping/grids. Neither establishes measured capacity. [Air](https://www.jetbrains.com/help/air-ides/air-manage-agent-sessions.html), [VS Code](https://code.visualstudio.com/docs/agents/run/agents-window)
- **Inferred: isolation is often conflated with permission.** VS Code worktrees force Allow all; Cursor cloud auto-runs commands. Sotto must preserve human approval. [VS Code](https://code.visualstudio.com/docs/agents/run/agent-harnesses), [Cursor](https://cursor.com/docs/cloud-agent/security-network)
- **Documented: old names/screenshots mislead.** Windsurf became Devin Desktop; Antigravity separated its app; Codex desktop capabilities now sit within ChatGPT. [Devin](https://docs.devin.ai/desktop/devin-desktop-faq), [Google](https://www.antigravity.google/blog/introducing-google-antigravity-2), [OpenAI](https://learn.chatgpt.com/docs/whats-new)
- **Inferred: provider choice does not ensure parity.** ACP managers and Kiro expose different steering/resume/permission capabilities, rather than uniform installed-CLI control. [Air](https://www.jetbrains.com/help/air-ides/air-key-concepts.html), [Zed](https://zed.dev/docs/ai/external-agents), [Kiro](https://kiro.dev/docs/crew/features/agent-backends/)

## Claude Code Desktop, Projects and agent teams

- **What it is.** Documented: Anthropic's paid coding product; Desktop, terminal and web. April 14 redesign; current October 8 docs record later messaging changes. [Redesign](https://claude.com/blog/claude-code-desktop-redesign), [Desktop](https://code.claude.com/docs/en/desktop)
- **Command-center shape.** Documented: cross-repository sidebar plus review panes. [Redesign](https://claude.com/blog/claude-code-desktop-redesign)
  Projects adds one continuing coordinator conversation. [Projects](https://code.claude.com/docs/en/claude-projects)
  CLI-only teams instead has a lead within one coding effort. [Teams](https://code.claude.com/docs/en/agent-teams), [Desktop scope](https://code.claude.com/docs/en/desktop)
- **Dispatch.** Documented: Projects routes into existing/new threads across repositories. [Projects](https://code.claude.com/docs/en/claude-projects)
  Cowork Dispatch starts Code sessions, including mobile requests, on Pro/Max. [Desktop](https://code.claude.com/docs/en/desktop)
- **What the hub sees.** Documented: Projects receives worker reports and groups work by state; urgency ordering unverified. [Projects](https://code.claude.com/docs/en/claude-projects)
  Desktop exposes files/diffs, terminal and context usage. [Redesign](https://claude.com/blog/claude-code-desktop-redesign)
- **Talking to workers.** Documented: Desktop list/read/send covers local/SSH/WSL Code-tab sessions, excluding cloud/CLI/VS Code; searches 20 recent by default. Sender-attributed messages queue. [Desktop](https://code.claude.com/docs/en/desktop)
  Separate cross-session messaging has broader reach; teams supports peer messages. [Messaging](https://code.claude.com/docs/en/cross-session-messaging), [Teams](https://code.claude.com/docs/en/agent-teams)
- **Attention and approvals.** Documented: Project permissions must be answered at the worker; telling the coordinator to proceed is insufficient. Cloud uses Auto mode. [Projects](https://code.claude.com/docs/en/claude-projects)
  Desktop offers Manual through Bypass. [Desktop](https://code.claude.com/docs/en/desktop)
  Teams routes tool permissions to the user but automatically accepts lead-session plan approvals. [Teams](https://code.claude.com/docs/en/agent-teams)
- **Isolation and merge.** Documented: local worktrees, SSH and cloud. [Desktop](https://code.claude.com/docs/en/desktop)
  Projects has PR/CI/review/conflict actions; cloud requires github.com and the Claude GitHub App. [Projects](https://code.claude.com/docs/en/claude-projects)
- **Memory and continuity.** Documented: Project memory/context compaction; local Project threads do not load cloud memory files. [Projects](https://code.claude.com/docs/en/claude-projects)
  Messaging is local on one machine, Remote Control across machines. [Messaging](https://code.claude.com/docs/en/cross-session-messaging)
  In-process teammates are not restored by lead resume. [Teams](https://code.claude.com/docs/en/agent-teams)
- **Voice and mobile.** Documented: connected local sessions on web/mobile require the computer; Dispatch adds conversational mobile requests. A global spoken supervisor was not verified. [Remote Control](https://code.claude.com/docs/en/remote-control), [Desktop](https://code.claude.com/docs/en/desktop)
- **Providers.** Documented: Claude workers; coordinator and worker models can differ. [Projects](https://code.claude.com/docs/en/claude-projects)
- **Does well.** Inferred: visible continuing conversation. Preferred worker limits are instructions, not enforced caps. [Projects](https://code.claude.com/docs/en/claude-projects)
  Past five workers, status/project filters help; teams collapse idle rows. [Redesign](https://claude.com/blog/claude-code-desktop-redesign), [Teams](https://code.claude.com/docs/en/agent-teams)
- **Falls short.** Documented vendor limits: explicit targeting may be needed; multi-repository Projects does not inherit repository permission rules. [Projects](https://code.claude.com/docs/en/claude-projects)
  Teams has status lag, restart limitations and no Windows Terminal split mode. [Teams](https://code.claude.com/docs/en/agent-teams)
- **For Sotto.** Inferred: take linked workers and attributed messages.
  Avoid scope ambiguity and automatic permission/plan approval. [Messaging](https://code.claude.com/docs/en/cross-session-messaging), [Teams](https://code.claude.com/docs/en/agent-teams)

## VS Code Agent Sessions and Agents window

- **What it is.** Documented: Microsoft's free Windows/macOS/Linux editor. October 7 docs include preview/experimental controls. [Download](https://code.visualstudio.com/download), [Window](https://code.visualstudio.com/docs/agents/run/agents-window)
- **Command-center shape.** Documented: all-workspace Agents window; ordinary Chat is workspace-scoped. Supported Agent Host agents also coordinate sessions conversationally. [Window](https://code.visualstudio.com/docs/agents/run/agents-window), [Management](https://code.visualstudio.com/docs/agents/run/sessions/manage-sessions)
- **Dispatch.** Documented: create independent sessions/peer chats, select project/worktree. Copilot/Claude support orchestration; Codex does through Agent Host. [Management](https://code.visualstudio.com/docs/agents/run/sessions/manage-sessions)
- **What the hub sees.** Observed main-branch source: status/activity, directory/project, changes, Git/GitHub and timestamps; summary/digest/full context levels. Source presence does not guarantee release availability. [Tools source](https://github.com/microsoft/vscode/blob/main/src/vs/platform/agentHost/node/shared/sessionServerTools.ts)
- **Talking to workers.** Observed source: asynchronous steering versus queued turns; pending messages can be replaced/cancelled. [Tools source](https://github.com/microsoft/vscode/blob/main/src/vs/platform/agentHost/node/shared/sessionServerTools.ts)
- **Attention and approvals.** Documented: preview input/unread/failing-CI badge, without verified urgency ordering. Manual, model-assisted and Allow all coexist; Autopilot answers questions automatically. [Management](https://code.visualstudio.com/docs/agents/run/sessions/manage-sessions), [Approvals](https://code.visualstudio.com/docs/agents/run/approvals)
- **Isolation and merge.** Documented: worktree sessions force Allow all, despite worktrees lacking security isolation. Experimental Agent Merge can repair reviews/checks/conflicts and optionally merge. [Harnesses](https://code.visualstudio.com/docs/agents/run/agent-harnesses), [Window](https://code.visualstudio.com/docs/agents/run/agents-window)
- **Memory and continuity.** Documented: user/repository/session memory; Copilot history syncs to GitHub by default with opt-out/exclusions. [Memory](https://code.visualstudio.com/docs/agents/run/memory), [History](https://code.visualstudio.com/docs/agents/run/sessions/session-history)
- **Voice and mobile.** Documented: experimental Voice Mode discusses/starts sessions and announces routing; eligible individual plans only. Copilot remote control synchronizes questions/approvals with GitHub Mobile. [Voice](https://code.visualstudio.com/docs/configure/accessibility/voice), [Harnesses](https://code.visualstudio.com/docs/agents/run/agent-harnesses)
- **Providers.** Documented: Copilot/Claude/Codex and cloud targets. External discovery is hidden by default; Copilot discovery covers recent repository sessions, not every process. [Harnesses](https://code.visualstudio.com/docs/agents/run/agent-harnesses), [Management](https://code.visualstudio.com/docs/agents/run/sessions/manage-sessions)
- **Does well.** Inferred: navigation/control tools mirror the UI. Past five sessions, grouping, pinning, filtering and grids enable selective inspection. [Source](https://github.com/microsoft/vscode/blob/main/src/vs/platform/agentHost/node/shared/sessionServerTools.ts), [Window](https://code.visualstudio.com/docs/agents/run/agents-window)
- **Falls short.** Observed September 20 Insiders issue: stale status after another client's resume, closed as duplicate; shipped fix unverified. Source process backstops are depth three, 50 created sessions/50 chats/100 messages, not UI capacity promises. [Issue](https://github.com/microsoft/vscode/issues/336955), [Source](https://github.com/microsoft/vscode/blob/main/src/vs/platform/agentHost/node/shared/sessionServerTools.ts)
- **For Sotto.** Inferred: take list/read/create/send with Sotto-ID links.
  Avoid worktree autoapproval and default cloud history sync. [Source](https://github.com/microsoft/vscode/blob/main/src/vs/platform/agentHost/node/shared/sessionServerTools.ts), [Harnesses](https://code.visualstudio.com/docs/agents/run/agent-harnesses), [History](https://code.visualstudio.com/docs/agents/run/sessions/session-history)

## Cursor Agents window and Projects

- **What it is.** Documented: Anysphere's Windows/macOS/Linux app. Agents window launched April 2, Projects beta September 10; window 3.23 October 1. Projects needs paid access, Enterprise 3.21.9+. [Download](https://cursor.com/download), [Releases](https://cursor.com/docs/release-notes), [Projects](https://cursor.com/docs/agent/projects)
- **Command-center shape.** Documented: across-repository local/cloud/SSH window. Projects adds a planning/delegating coordinator. Inferred: its workers are narrower than every unrelated window session. [Window](https://cursor.com/docs/agent/agents-window), [Projects](https://cursor.com/docs/agent/projects)
- **Dispatch.** Documented: workers, schedules and Slack/PR subscriptions. Best-of-N compares models in separate worktrees. [Projects](https://cursor.com/docs/agent/projects), [Worktrees](https://cursor.com/docs/configuration/worktrees)
- **What the hub sees.** Documented vendor answer: nested live-status worker trees beside the coordinator. Cloud runs expose conversation, changes, screenshots/video and logs. [Hierarchy](https://forum.cursor.com/t/hierarchical-ui-concurrency-view-for-multi-agent-workflows-in-agents-window/171765/4), [Cloud](https://cursor.com/docs/cloud-agent)
- **Talking to workers.** Documented: direct worker chat, shared Project files, Slack mentions/listing and Linear comments that steer existing runs. [Projects](https://cursor.com/docs/agent/projects), [Slack](https://cursor.com/docs/integrations/slack), [Linear](https://cursor.com/docs/integrations/linear)
- **Attention and approvals.** Documented vendor answer: Needs Attention groups approvals/questions/plans/unread results across workspaces. Cloud auto-runs commands; Auto-review/Run Everything also exist. Urgency ordering unverified. [Attention](https://forum.cursor.com/t/agents-approval-window/170388/5), [Security](https://cursor.com/docs/cloud-agent/security-network), [Releases](https://cursor.com/docs/release-notes)
- **Isolation and merge.** Documented: local worktrees/cloud VMs; apply a selected worktree or delegate cloud PR preparation. Independent merge queue unverified. [Worktrees](https://cursor.com/docs/configuration/worktrees), [Subagents](https://cursor.com/docs/subagents)
- **Memory and continuity.** Documented: persistent shared Project context and cloud work after laptop closure. Cloud history is indefinite by default; unused snapshots expire after 90 days. [Projects](https://cursor.com/docs/agent/projects), [Retention](https://cursor.com/docs/cloud-agent/security-network)
- **Voice and mobile.** Documented: iPhone/iPad dictation, notifications and Live Activities for eight agents. October 6 adds local-session phone access while the computer is online. Execution placement could not be verified: mobile docs describe a cloud loop; changelog says runs stay on the computer. Android is planned. [Mobile](https://cursor.com/docs/cloud-agent/mobile), [Changelog](https://cursor.com/changelog)
- **Providers.** Documented: multiple model vendors in Cursor's harness, not verified control of their separately installed CLIs. [Models](https://cursor.com/docs/models-and-pricing)
- **Does well.** Inferred: past five workers, combine hierarchy and attention grouping; persistent subscriptions reduce repeated prompting. [Hierarchy](https://forum.cursor.com/t/hierarchical-ui-concurrency-view-for-multi-agent-workflows-in-agents-window/171765/4), [Attention](https://forum.cursor.com/t/agents-approval-window/170388/5), [Launch](https://cursor.com/changelog/projects)
- **Falls short.** Observed September user reports: unnoticed approvals and hidden parent context. Vendor replies identify existing controls, so this is discoverability evidence. Documented: Projects excludes Legacy Privacy Mode. [Approval report](https://forum.cursor.com/t/agents-approval-window/170388), [Hierarchy report](https://forum.cursor.com/t/hierarchical-ui-concurrency-view-for-multi-agent-workflows-in-agents-window/171765), [Projects](https://cursor.com/docs/agent/projects)
- **For Sotto.** Inferred: take continuing conversation, worker tree and attention grouping.
  Avoid automatic commands and cloud transcript retention. [Projects](https://cursor.com/docs/agent/projects), [Security](https://cursor.com/docs/cloud-agent/security-network)

## Warp and Oz

- **What it is.** Documented: Warp desktop on Windows/macOS/Linux and Oz cloud platform. April open-source announcement specifies AGPL; Free/paid/BYOK plans. Management docs updated October 6. [Announcement](https://www.warp.dev/blog/warp-is-now-open-source), [Plans](https://docs.warp.dev/support-and-community/plans-and-billing/plans-pricing-refunds), [Management](https://docs.warp.dev/platform/managing-cloud-agents/)
- **Command-center shape.** Documented: management panel plus conversational orchestration. Personal includes local/cloud; All includes team cloud, excluding teammates' local runs. Oz web is cloud-scoped. [Management](https://docs.warp.dev/platform/managing-cloud-agents/), [Oz web](https://docs.warp.dev/platform/oz-web-app/)
- **Dispatch.** Documented: user-approved breakdown/prompts/environments/parallelism; one child level. API/CLI/Slack/Linear/scheduled runs appear in management. [Orchestration](https://docs.warp.dev/platform/orchestration/), [Management](https://docs.warp.dev/platform/managing-cloud-agents/)
- **What the hub sees.** Documented: status/source/creator/duration, prompt/plan/command/artifact drill-down and credits. Local children use pills, cloud children rows. [Management](https://docs.warp.dev/platform/managing-cloud-agents/), [Oz web](https://docs.warp.dev/platform/oz-web-app/)
- **Talking to workers.** Documented: durable agent-ID mailboxes, explicit messages rather than shared transcripts; results precede success and finished children can wake again. [Orchestration](https://docs.warp.dev/platform/orchestration/)
- **Attention and approvals.** Documented: parent notifications; children need inspection. Interactive Always ask/Agent decides/Always allow coexist. Run until completion bypasses command denylists by default unless configured otherwise; enforced team rules remain. Dispatch-plan approval is separate from tool permission. [Orchestration](https://docs.warp.dev/platform/orchestration/), [Permissions](https://docs.warp.dev/agents/capabilities/agent-profiles-permissions/)
- **Isolation and merge.** Documented: local worktrees/cloud environments and branch/artifact review. Docker isolates containers; Direct isolates directories but shares kernel. Cross-harness merge guarantees unverified. [Guide source](https://github.com/warpdotdev/docs/blob/main/src/content/docs/guides/agent-workflows/how-to-run-multiple-ai-coding-agents.mdx), [Security](https://docs.warp.dev/platform/execution-security/)
- **Memory and continuity.** Documented: durable follow-ups/cloud history. Self-hosting still routes transcripts/inference through Warp; local source storage does not mean local-only conversations. [Orchestration](https://docs.warp.dev/platform/orchestration/), [Oz web](https://docs.warp.dev/platform/oz-web-app/), [Security](https://docs.warp.dev/platform/execution-security/)
- **Voice and mobile.** Documented: mobile browser access to Oz; desktop voice transcription uses Wispr Flow. Spoken fleet priority routing unverified. [Oz web](https://docs.warp.dev/platform/oz-web-app/), [Voice](https://docs.warp.dev/agents/local-agents/interacting-with-agents/voice/)
- **Providers.** Documented: Warp/Claude Code/Codex orchestration harnesses; other local CLI tabs. [Orchestration](https://docs.warp.dev/platform/orchestration/), [Guide](https://github.com/warpdotdev/docs/blob/main/src/content/docs/guides/agent-workflows/how-to-run-multiple-ai-coding-agents.mdx)
- **Does well.** Inferred: ordered messages and lifecycle make delegation inspectable. Past five runs, filters narrow the list; urgency ranking unverified. Observed source emits notifications for blocked/success/error changes. [Orchestration](https://docs.warp.dev/platform/orchestration/), [Management](https://docs.warp.dev/platform/managing-cloud-agents/), [Notification source](https://raw.githubusercontent.com/warpdotdev/warp/master/app/src/ai/agent_management/agent_management_model.rs)
- **Falls short.** Documented vendor warning: parent success does not establish child success/completion. Parent-only notifications can hide unfinished work. [Management](https://docs.warp.dev/platform/managing-cloud-agents/), [Orchestration](https://docs.warp.dev/platform/orchestration/)
- **For Sotto.** Inferred: take durable ordered messages and separate parent/child outcomes.
  Avoid automatic approvals and backend transcript routing. [Orchestration](https://docs.warp.dev/platform/orchestration/), [Security](https://docs.warp.dev/platform/execution-security/)

## OpenAI Codex, ChatGPT desktop and dots

- **What it is.** Documented: OpenAI Codex app/CLI/cloud and ChatGPT Work. Codex merged into ChatGPT desktop on July 9 for macOS/Windows, across plans including Free. October 8 snapshot; dots access is staged/plan-dependent. [Changes](https://learn.chatgpt.com/docs/whats-new), [App](https://learn.chatgpt.com/docs/app), [Dots](https://learn.chatgpt.com/docs/dots)
- **Command-center shape.** Documented: projects/thread navigation and Activity, with voice task coordination. Dots delegates ongoing work but cannot see every conversation in every app. [Projects](https://learn.chatgpt.com/docs/projects), [Activity](https://learn.chatgpt.com/docs/notifications), [Voice](https://learn.chatgpt.com/docs/features/voice), [Dots tasks](https://learn.chatgpt.com/docs/dots/tasks-and-memory)
- **Dispatch.** Documented: dots creates local/cloud tasks and can continue local Codex tasks on its connected computer. Codex subagents delegate in parallel; CLI also browses/applies cloud work. [Dots tasks](https://learn.chatgpt.com/docs/dots/tasks-and-memory), [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [CLI](https://learn.chatgpt.com/docs/codex/cli)
- **What the hub sees.** Documented: unread/running/waiting categories, questions/permissions, subagent conversations and delegated task results. [Activity](https://learn.chatgpt.com/docs/notifications), [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [Dots tasks](https://learn.chatgpt.com/docs/dots/tasks-and-memory)
- **Talking to workers.** Documented: spawn/follow-up/wait/close and CLI child navigation. Dots follows its delegated tasks; arbitrary installed-process fleet control unverified. [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [Dots tasks](https://learn.chatgpt.com/docs/dots/tasks-and-memory)
- **Attention and approvals.** Documented: child sandbox/permissions are inherited; inactive-thread approvals identify their source and can open it. Non-interactive approvals fail to the parent. [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
  Optional automatic review means human-only approval is not universal. Urgency ordering unverified. [Long-running work](https://learn.chatgpt.com/docs/long-running-work), [Activity](https://learn.chatgpt.com/docs/notifications)
- **Isolation and merge.** Documented: detached-HEAD worktrees, thread/code handoff, cleanup versus permanent projects, configured ignored-file transfer; isolated cloud tasks. [Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees), [CLI](https://learn.chatgpt.com/docs/codex/cli)
- **Memory and continuity.** Documented: resume/history and project instructions/chats. [CLI](https://learn.chatgpt.com/docs/codex/cli), [Projects](https://learn.chatgpt.com/docs/projects)
  Scheduled run chats persist; local automations need the app/computer. [Automations](https://learn.chatgpt.com/docs/automations)
  Dots keeps notes; pausing it does not stop delegated tasks/schedules. [Dots memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory)
- **Voice and mobile.** Documented: ChatGPT Voice starts/checks/follows up tasks, brings back blockers/results and switches conversations on connected hosts; staged availability, same task permissions. Work syncs desktop/web/mobile; dots supports one personal computer at once. [Voice](https://learn.chatgpt.com/docs/features/voice), [Changes](https://learn.chatgpt.com/docs/whats-new), [Dots](https://learn.chatgpt.com/docs/dots)
- **Providers.** Documented: OpenAI agents; general multi-vendor CLI management unverified. [App](https://learn.chatgpt.com/docs/app)
- **Does well.** Inferred: distinct goals/schedules/children. Past five threads, project pin/search/archive and Activity filters help; child concurrency is configurable, not a universal fleet-size promise. [Projects](https://learn.chatgpt.com/docs/projects), [Activity](https://learn.chatgpt.com/docs/notifications), [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [Goals](https://learn.chatgpt.com/docs/long-running-work)
- **Falls short.** Documented vendor limits: dot rollout/one computer, independent stopping; event-driven automation excludes desktop/CLI/IDE. No large-fleet reliability test was performed. [Dots](https://learn.chatgpt.com/docs/dots), [Dots tasks](https://learn.chatgpt.com/docs/dots/tasks-and-memory), [Automations](https://learn.chatgpt.com/docs/automations)
- **For Sotto.** Inferred: take attributed approvals and separate stop controls. [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [Dots tasks](https://learn.chatgpt.com/docs/dots/tasks-and-memory)
  Avoid automatic approval review and pause-as-stop-all assumptions. [Goals](https://learn.chatgpt.com/docs/long-running-work), [Dots tasks](https://learn.chatgpt.com/docs/dots/tasks-and-memory)

## Kiro Focus mode, workflows and Crew

- **What it is.** Documented: AWS Kiro IDE/CLI/web/mobile, Free/paid tiers; Crew is Apache-2.0 open source. Current docs plus IDE 1.0.293 August 11 and September Crew docs. [Pricing](https://kiro.dev/pricing/), [Repository](https://github.com/kirodotdev/KiroCrew), [Release](https://kiro.dev/changelog/ide/1-0-293/), [Crew](https://kiro.dev/docs/crew/)
- **Command-center shape.** Documented: cross-workspace experimental Focus view; Crew continuing chat with sessions/Activity/tasks and peer-message primitives. Automatic adoption of all IDE sessions unverified. [Focus](https://kiro.dev/docs/ide/experimental/focus-mode/), [Chat](https://kiro.dev/docs/crew/chat/), [Workflows](https://kiro.dev/docs/crew/features/workflows/)
- **Dispatch.** Documented: workflow graphs with parallel/sequential/loop steps; Crew persistent tasks, schedules and separate-context children. [Workflows](https://kiro.dev/docs/workflows/), [Crew](https://kiro.dev/docs/crew/), [Subagents](https://kiro.dev/docs/crew/features/subagents/)
- **What the hub sees.** Documented: Focus status/diffs/artifacts; Crew tools, running/done/failed/stalled children, elapsed time and Stop/Retry. [Focus](https://kiro.dev/docs/ide/experimental/focus-mode/), [Subagents](https://kiro.dev/docs/crew/features/subagents/), [Chat](https://kiro.dev/docs/crew/chat/)
- **Talking to workers.** Documented: session_send supplies a peer's next turn; agents control their own child runs, owner dashboard sees all. Observed source: separate child sessions/callback results, no recursive spawn. [Workflows](https://kiro.dev/docs/crew/features/workflows/), [Subagents](https://kiro.dev/docs/crew/features/subagents/), [Source](https://raw.githubusercontent.com/kirodotdev/KiroCrew/main/src/kiro_crew/subagent.py)
- **Attention and approvals.** Documented: bell cards show question/exact command/path with answer controls. Crew default Automatic differs from Interactive; Autopilot grants actions passing gates. Native preapproval can bypass interception. [Focus](https://kiro.dev/docs/ide/experimental/focus-mode/), [Security](https://kiro.dev/docs/crew/security/), [Backends](https://kiro.dev/docs/crew/features/agent-backends/)
- **Isolation and merge.** Documented: workflow artifacts/contexts are explicit; sandbox behavior differs by platform/backend, including Windows fail-closed cases. Universal Crew worktree/merge queue unverified. [Workflows](https://kiro.dev/docs/workflows/), [Security](https://kiro.dev/docs/crew/security/)
- **Memory and continuity.** Documented: separate histories/approval state, shared memory, Persistent/Incognito/Temporary choices. Durable tasks persist before acknowledgement; restart recovery avoids uncertain replay. [Chat](https://kiro.dev/docs/crew/chat/), [Subagents](https://kiro.dev/docs/crew/features/subagents/), [Task specification](https://github.com/kirodotdev/KiroCrew/blob/main/docs/system-specs/modules/subagent.md)
- **Voice and mobile.** Documented: dictation/local Piper speech, web/CLI/messaging and remote gateway. Kiro mobile/cloud continuity exists; one combined Crew/IDE mobile inventory unverified. [Chat](https://kiro.dev/docs/crew/chat/), [Crew](https://kiro.dev/docs/crew/), [Continuity](https://kiro.dev/docs/how-kiro-works/)
- **Providers.** Documented: Developer Mode preview Kiro/Claude/Codex/OpenCode/Pi/goose backends. Capability cards qualify resume/steer/MCP; Pi lacks Crew MCP, Codex requires sandbox. [Backends](https://kiro.dev/docs/crew/features/agent-backends/)
- **Does well.** Inferred: actionable waiting cards. Past five workers, grouping/pins handle display; hardware-aware admission and memory/concurrency queues handle execution. [Focus](https://kiro.dev/docs/ide/experimental/focus-mode/), [Subagents](https://kiro.dev/docs/crew/features/subagents/), [Task specification](https://github.com/kirodotdev/KiroCrew/blob/main/docs/system-specs/modules/subagent.md)
- **Falls short.** Documented vendor limits: Claude-native preapprovals bypass Crew deny/audit observation; adapters lose features. Observed repository instructions expose verbose protocol/message logs. [Backends](https://kiro.dev/docs/crew/features/agent-backends/), [Repository](https://github.com/kirodotdev/KiroCrew)
- **For Sotto.** Inferred: take waiting cards, durable dispatch and capability reporting.
  Avoid default automatic permissions, text logging and assumed total interception. [Focus](https://kiro.dev/docs/ide/experimental/focus-mode/), [Task specification](https://github.com/kirodotdev/KiroCrew/blob/main/docs/system-specs/modules/subagent.md), [Backends](https://kiro.dev/docs/crew/features/agent-backends/)

## JetBrains Air, Junie and ACP

- **What it is.** Documented: JetBrains Air standalone and IDE surfaces; macOS/Linux/Windows, Windows Docker in July notes. October 5 docs: own local subscriptions need no mandatory JetBrains AI; cloud requires eligible enabled organizations. [July release](https://blog.jetbrains.com/air/2026/07/what-s-new-air-gets-more-agents-local-models-and-java-kotlin-code-intelligence/), [Overview](https://www.jetbrains.com/help/air-ides/air-overview.html), [IDE access](https://www.jetbrains.com/air/ides/), [Cloud](https://www.jetbrains.com/help/air-ides/air-start-a-new-session.html)
- **Command-center shape.** Documented: session tree, structured chat/native terminal and selected-session global prompt. Conversational fleet supervisor unverified. [Concepts](https://www.jetbrains.com/help/air-ides/air-key-concepts.html), [Creation](https://www.jetbrains.com/help/air-ides/air-start-a-new-session.html)
- **Dispatch.** Documented: select preset/provider, create/fork, choose checkout/worktree/cloud. Agent-created folder metadata groups work but does not prove peer dispatch. [Creation](https://www.jetbrains.com/help/air-ides/air-start-a-new-session.html), [Management](https://www.jetbrains.com/help/air-ides/air-manage-agent-sessions.html)
- **What the hub sees.** Documented: status/input/review/unread counts, optional files/commits, nested children and provider-dependent costs; supported external Codex app/cloud sessions. [Management](https://www.jetbrains.com/help/air-ides/air-manage-agent-sessions.html)
- **Talking to workers.** Documented: selected-session messages; ACP progress/tools/permission forms or native terminal. Universal peer mailbox unverified. [Concepts](https://www.jetbrains.com/help/air-ides/air-key-concepts.html), [ACP](https://www.jetbrains.com/acp/)
- **Attention and approvals.** Documented: counters/filters, optional macOS LED signals; CLI permissions remain agent-owned, ACP exposes requests. Global urgency ranking unverified. [Management](https://www.jetbrains.com/help/air-ides/air-manage-agent-sessions.html), [Concepts](https://www.jetbrains.com/help/air-ides/air-key-concepts.html)
- **Isolation and merge.** Documented: temporary worktrees; commit/cherry-pick into the currently checked-out destination. Cloud uses pushed GitHub/GitLab commits. [Creation](https://www.jetbrains.com/help/air-ides/air-start-a-new-session.html)
- **Memory and continuity.** Documented: active/archived transcript search, folders/pins/restore; provider-dependent forks/history; cloud reconnect after IDE closure. [Management](https://www.jetbrains.com/help/air-ides/air-manage-agent-sessions.html), [Concepts](https://www.jetbrains.com/help/air-ides/air-key-concepts.html), [Creation](https://www.jetbrains.com/help/air-ides/air-start-a-new-session.html)
- **Voice and mobile.** Could not verify voice coordination/mobile fleet view. [Overview](https://www.jetbrains.com/help/air-ides/air-overview.html)
- **Providers.** Documented: Junie/Claude/Codex/Copilot/Gemini/OpenCode and ACP/CLI agents with their own credentials/config. [IDE access](https://www.jetbrains.com/air/ides/), [Concepts](https://www.jetbrains.com/help/air-ides/air-key-concepts.html)
- **Does well.** Inferred: explicit 5/10/15/all rows per project plus Show more/folders. All attached projects can be shown; current-project-only is default. [Management](https://www.jetbrains.com/help/air-ides/air-manage-agent-sessions.html)
- **Falls short.** Documented vendor limits: personal licenses cannot use described IDE cloud execution; provider features/costs vary. [Creation](https://www.jetbrains.com/help/air-ides/air-start-a-new-session.html), [Concepts](https://www.jetbrains.com/help/air-ides/air-key-concepts.html)
- **For Sotto.** Inferred: take bounded lists, explicit integration destination and provider forms.
  Avoid implying folders confer coordination authority. [Management](https://www.jetbrains.com/help/air-ides/air-manage-agent-sessions.html), [Creation](https://www.jetbrains.com/help/air-ides/air-start-a-new-session.html)

## Google Antigravity Agent Manager

- **What it is.** Documented: Google's macOS/Windows/Linux app; Antigravity 2 separated from the IDE May 19. October 7: app 2.21.1/CLI 1.3.1. Free/paid quotas. [Launch](https://www.antigravity.google/blog/introducing-google-antigravity-2), [Features](https://www.antigravity.google/docs/features), [Changelog](https://antigravity.google/docs/changelog), [Plans](https://antigravity.google/docs/plans)
- **Command-center shape.** Documented: project/conversation manager and grouped children. Conversational control of every independent session unverified. [Deep dive](https://antigravity.google/blog/google-io-2026-feature-deep-dive), [Subagents](https://antigravity.google/docs/subagents)
- **Dispatch.** Documented: prompts/projects, dynamic children and scheduled tasks, now Automations. Child delegation is narrower than demonstrated peer coordination. [Deep dive](https://antigravity.google/blog/google-io-2026-feature-deep-dive), [Changelog](https://antigravity.google/docs/changelog), [Subagents](https://antigravity.google/docs/subagents)
- **What the hub sees.** Documented: status/project grouping, artifacts/worktrees/tool summaries; CLI child lifecycle and tool/output inspection. [Deep dive](https://antigravity.google/blog/google-io-2026-feature-deep-dive), [Changelog](https://antigravity.google/docs/changelog), [CLI views](https://www.antigravity.google/docs/cli/commands/agents/)
- **Talking to workers.** Documented: individual conversations and scoped invoke_subagent calls; user child inspection/termination. Independent-session mailboxes unverified. [Subagents](https://antigravity.google/docs/subagents), [CLI views](https://www.antigravity.google/docs/cli/commands/agents/)
- **Attention and approvals.** Documented: remote done/needs-input notifications and child approvals. macOS/Linux default auto-runs sandboxed commands; Request review/Turbo differ. Windows uses legacy settings. Current ranked Inbox unverified. [Changelog](https://antigravity.google/docs/changelog), [Subagents](https://antigravity.google/docs/subagents), [Settings](https://www.antigravity.google/docs/agent-settings)
- **Isolation and merge.** Documented: shared/new Git worktrees; non-Git folders may remain shared. Cross-session merge queue unverified. [Projects](https://www.antigravity.google/docs/projects/)
- **Memory and continuity.** Documented: project rules/settings, searchable history, scheduled work and CLI service restart improvements. Global coordinator memory unverified. [Features](https://www.antigravity.google/docs/features), [Changelog](https://antigravity.google/docs/changelog)
- **Voice and mobile.** Documented: Gemini Audio transcription and browser remote control/notifications; dedicated mobile spoken supervisor unverified. [Deep dive](https://antigravity.google/blog/google-io-2026-feature-deep-dive), [Changelog](https://antigravity.google/docs/changelog)
- **Providers.** Documented: Gemini/eligible third-party models, no BYOK in reviewed plans; not installed-CLI management. [Plans](https://antigravity.google/docs/plans)
- **Does well.** Inferred: past five conversations, project/status grouping and artifacts aid inspection. August sidebar/output-scale fixes do not establish measured concurrency capacity. [Deep dive](https://antigravity.google/blog/google-io-2026-feature-deep-dive), [Changelog](https://antigravity.google/docs/changelog)
- **Falls short.** Observed February–March user reports: old Inbox disappeared without explanation; restoration in the new app unverified. Documented platform-specific settings complicate defaults. [Report](https://discuss.ai.google.dev/t/did-they-remove-the-inbox-in-agent-manager/126943), [Settings](https://www.antigravity.google/docs/agent-settings)
- **For Sotto.** Inferred: take grouping/artifacts.
  Avoid silently losing attention controls or equating sandbox execution with user permission. [Deep dive](https://antigravity.google/blog/google-io-2026-feature-deep-dive), [Report](https://discuss.ai.google.dev/t/did-they-remove-the-inbox-in-agent-manager/126943), [Settings](https://www.antigravity.google/docs/agent-settings)

## GitHub Agent HQ, Mission Control and Copilot app

- **What it is.** Documented: GitHub Agent HQ announced October 28, 2025; agents page covers cloud repositories. Windows/macOS/Linux Copilot app GA June 17, 2026. Third-party agents remain paid-plan preview. [HQ](https://github.blog/news-insights/company-news/welcome-home-agents/), [App release](https://github.blog/changelog/2026-06-17-github-copilot-app-generally-available/), [Third parties](https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents)
- **Command-center shape.** Documented: cross-repository dashboard/conversation entry points; desktop repository groups. Autonomous global supervisor unverified. [Management](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents), [App](https://docs.github.com/en/copilot/how-tos/github-copilot-app/agent-sessions)
- **Dispatch.** Documented: prompts/issues/PR mentions and recurring automation; parallel desktop sessions. [Third parties](https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents), [Release](https://github.blog/changelog/2026-06-17-github-copilot-app-generally-available/)
- **What the hub sees.** Documented: progress/tokens/duration and linked reasoning/tool/validation logs; desktop plans/PRs/terminal/browser canvases. [Management](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents), [Release](https://github.blog/changelog/2026-06-17-github-copilot-app-generally-available/)
- **Talking to workers.** Documented: Copilot steering waits for the current tool call; third parties instead iterate through PR comments. Peer mailboxes unverified. [Management](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents), [Third parties](https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents)
- **Attention and approvals.** Documented: cloud review requests; Copilot cannot approve/merge/mark-ready its PR. Workflow approval can be automated by setting. Desktop Interactive/Plan/Autopilot differs. Urgency ranking unverified. [Mitigations](https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/risks-and-mitigations), [App](https://docs.github.com/en/copilot/how-tos/github-copilot-app/agent-sessions)
- **Isolation and merge.** Documented: constrained cloud branches/ephemeral environments; desktop checkout/worktree/cloud options. PR rules govern integration. [Mitigations](https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/risks-and-mitigations), [App](https://docs.github.com/en/copilot/how-tos/github-copilot-app/agent-sessions)
- **Memory and continuity.** Documented: natural-language search over synced history. Local sync defaults on; cloud sessions are repository-reader-visible, local sharing opt-in. [Management](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents), [Data](https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/session-data)
- **Voice and mobile.** Documented: Mobile starts third-party tasks; desktop dictation downloads a local model and inserts editable text. [Third parties](https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents), [App](https://docs.github.com/en/copilot/how-tos/github-copilot-app/agent-sessions)
- **Providers.** Documented: Copilot/Claude/Codex; other original promised partners unverified. Desktop model-provider configuration is separate. [Third parties](https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents), [App](https://docs.github.com/en/copilot/how-tos/github-copilot-app/agent-sessions)
- **Does well.** Inferred: reviewable issues/branches/PRs. Past five tasks, repository groups and parallel sessions help; overload policy unverified. [Release](https://github.blog/changelog/2026-06-17-github-copilot-app-generally-available/)
- **Falls short.** Documented vendor limits: Copilot cloud is one repository/branch/PR and 59 minutes, unlike local desktop sessions. Third-party steering is weaker. [Limits](https://docs.github.com/en/copilot/concepts/copilot-surfaces/copilot-on-github), [Management](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents)
- **For Sotto.** Inferred: take worker/issue/PR/activity links.
  Avoid default transcript sync and uniform-provider assumptions. [Data](https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/session-data), [Management](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents)

## Devin Desktop, formerly Windsurf

- **What it is.** Documented: Cognition renamed Windsurf June 2; plans/settings continue, Cloud separate, local-only supported. September 29 version 3.10.48. Added for its direct Command Center relevance. [FAQ](https://docs.devin.ai/desktop/devin-desktop-faq), [Changelog](https://docs.devin.ai/desktop/changelog)
- **Command-center shape.** Documented: local/cloud Kanban, sidebar and Spaces. Sidebar is workspace-scoped; all-workspace conversation supervisor unverified. [Command Center](https://docs.devin.ai/desktop/agent-command-center), [Spaces](https://docs.devin.ai/desktop/spaces)
- **Dispatch.** Documented: provider-selected local/cloud sessions and grouped Spaces; Local preview subagents. Shared context alone does not establish peer supervision. [Center](https://docs.devin.ai/desktop/agent-command-center), [Spaces](https://docs.devin.ai/desktop/spaces), [Local](https://docs.devin.ai/desktop/devin-local)
- **What the hub sees.** Documented: status/session/file/PR/context and conversation/diff views. Fleet cost/test summaries unverified. [Center](https://docs.devin.ai/desktop/agent-command-center), [Spaces](https://docs.devin.ai/desktop/spaces)
- **Talking to workers.** Documented: selected messages/queued prompts; docs describe running sessions as locked/read-only, without establishing provider-wide live steering. ACP uses installed native binaries. [Center](https://docs.devin.ai/desktop/agent-command-center), [ACP](https://docs.devin.ai/desktop/acp)
- **Attention and approvals.** Documented: optional input/completion notifications, off by default. Local Deny overrides Ask/Allow; external policy varies. Urgency ranking unverified. [Center](https://docs.devin.ai/desktop/agent-command-center), [Local](https://docs.devin.ai/desktop/devin-local), [ACP](https://docs.devin.ai/desktop/acp)
- **Isolation and merge.** Documented: worktrees/Merge and cloud execution. Native child contexts share tools; this alone is not filesystem isolation. [Local](https://docs.devin.ai/desktop/devin-local)
- **Memory and continuity.** Documented: migration retains history/settings; Spaces share context, plans persist as Markdown. Global coordinator memory unverified. [FAQ](https://docs.devin.ai/desktop/devin-desktop-faq), [Spaces](https://docs.devin.ai/desktop/spaces), [Local](https://docs.devin.ai/desktop/devin-local)
- **Voice and mobile.** Could not verify spoken fleet control/mobile Command Center. [Center](https://docs.devin.ai/desktop/agent-command-center)
- **Providers.** Documented: Devin and installed Claude/Codex/Gemini/Junie/OpenCode ACP agents. Plan restrictions; native auth/billing. [ACP](https://docs.devin.ai/desktop/acp)
- **Does well.** Inferred: past five agents, status columns/Spaces organize a shared outcome. Sustained large-fleet usability untested. [Center](https://docs.devin.ai/desktop/agent-command-center), [Spaces](https://docs.devin.ai/desktop/spaces)
- **Falls short.** Documented release fixes: September memory leaks, multi-folder creation failures and stalls. Historical fixes do not establish current reproducibility. [Changelog](https://docs.devin.ai/desktop/changelog)
- **For Sotto.** Inferred: take outcome groups and execution provenance.
  Avoid hiding approvals behind optional notifications or implying shared files confer coordination. [Spaces](https://docs.devin.ai/desktop/spaces), [Center](https://docs.devin.ai/desktop/agent-command-center)

## Zed Agent Panel, parallel agents and ACP

- **What it is.** Documented: Zed Industries' open-source editor, free with own keys/external agents; optional hosted plans. October 8 docs/main source snapshot; release number unverified. [Pricing](https://zed.dev/pricing), [Agents](https://zed.dev/docs/ai/agents), [Source](https://raw.githubusercontent.com/zed-industries/zed/main/crates/agent_ui/src/agent_panel.rs)
- **Command-center shape.** Documented: project-grouped native/ACP/terminal peers. Observed: native create_thread is feature-gated; global conversational supervision is not established. [Parallel agents](https://zed.dev/docs/ai/parallel-agents), [Source](https://raw.githubusercontent.com/zed-industries/zed/main/crates/agent_ui/src/agent_panel.rs), [Gates](https://raw.githubusercontent.com/zed-industries/zed/main/crates/agent/src/tools.rs)
- **Dispatch.** Documented: independent threads/worktrees. Observed: create_thread needs user request/agreement and initial prompt; spawn_agent is for returned results. Flag rollout unverified. [Parallel](https://zed.dev/docs/ai/parallel-agents), [Tool source](https://raw.githubusercontent.com/zed-industries/zed/main/crates/agent/src/tools/create_thread_tool.rs)
- **What the hub sees.** Documented: grouped conversations/tools or terminals. Terminal semantic progress depends on the CLI's output. [Panel](https://zed.dev/docs/ai/agent-panel), [Terminals](https://zed.dev/docs/ai/terminal-threads)
- **Talking to workers.** Documented: queued prompts; live Steer is native-only. Observed: sibling creation returns no controllable session ID/output; creator cannot later supervise it. [Panel](https://zed.dev/docs/ai/agent-panel), [Tool source](https://raw.githubusercontent.com/zed-industries/zed/main/crates/agent/src/tools/create_thread_tool.rs)
- **Attention and approvals.** Documented: ACP/native policies differ; terminals retain CLI permissions and unfocused bells can notify. Global semantic urgency queue unverified. [External agents](https://zed.dev/docs/ai/external-agents), [Terminals](https://zed.dev/docs/ai/terminal-threads)
- **Isolation and merge.** Documented: detached-HEAD worktrees, normal Git integration/hooks. Archive saves Git state and can remove unused worktrees; resume recreates. [Parallel](https://zed.dev/docs/ai/parallel-agents)
- **Memory and continuity.** Documented: provider-dependent history/import; Cursor/Gemini import unsupported. Terminal restoration recreates commands, not necessarily conversations; closing is not chat archive. [Parallel](https://zed.dev/docs/ai/parallel-agents), [Terminals](https://zed.dev/docs/ai/terminal-threads)
- **Voice and mobile.** Could not verify voice supervisor/mobile fleet surface. [Agents](https://zed.dev/docs/ai/agents)
- **Providers.** Documented: native models, ACP subprocesses and CLI/TUI terminals; auth/config/permissions/skills do not transfer uniformly. [External agents](https://zed.dev/docs/ai/external-agents), [Terminals](https://zed.dev/docs/ai/terminal-threads)
- **Does well.** Inferred: editor-owned organization with CLI-owned execution. Past five threads, grouping spans added projects/linked worktrees; many terminal entries are allowed, capacity unmeasured. [Parallel](https://zed.dev/docs/ai/parallel-agents), [Terminals](https://zed.dev/docs/ai/terminal-threads)
- **Falls short.** Observed June user report: desired peer workspace creation/coordination and better terminal continuity. Current source adds narrower creation, so the old report does not prove present absence. [User report](https://www.reddit.com/r/ZedEditor/comments/1u0o6st/is_anyone_using_terminal_threads/), [Tool source](https://raw.githubusercontent.com/zed-industries/zed/main/crates/agent/src/tools/create_thread_tool.rs)
- **For Sotto.** Inferred: take provider-independent organization/capability reporting.
  Avoid equating spawn or terminal restoration with durable addressable supervision. [External agents](https://zed.dev/docs/ai/external-agents), [Tool source](https://raw.githubusercontent.com/zed-industries/zed/main/crates/agent/src/tools/create_thread_tool.rs)

## Patterns across this lane

- **Inferred: organize a body of work above its transcripts.** Projects/Spaces bind workers to shared outcomes. Sotto can retain assignments while keeping its thread IDs. [Cursor launch](https://cursor.com/changelog/projects), [Devin Spaces](https://docs.devin.ai/desktop/spaces)
- **Inferred: create, steer and resume need separate contracts.** Zed sibling creation lacks later control; GitHub third-party steering differs; Kiro reports backend capabilities. [Zed source](https://raw.githubusercontent.com/zed-industries/zed/main/crates/agent/src/tools/create_thread_tool.rs), [GitHub](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents), [Kiro](https://kiro.dev/docs/crew/features/agent-backends/)
- **Inferred: summarize first, inspect selectively.** VS Code context levels and Claude worker reports reduce indiscriminate transcript loading. [VS Code source](https://github.com/microsoft/vscode/blob/main/src/vs/platform/agentHost/node/shared/sessionServerTools.ts), [Claude](https://code.claude.com/docs/en/claude-projects)
- **Inferred: display capacity differs from execution capacity.** Air bounds visible rows; Crew admits work according to resources. Neither mechanism prioritizes user decisions by itself. [Air](https://www.jetbrains.com/help/air-ides/air-manage-agent-sessions.html), [Crew](https://kiro.dev/docs/crew/features/subagents/)

## Gaps nobody fills well

These are gaps in the reviewed evidence, not proof that no unpublished capability exists.

- **Could not verify: Sotto's exact control contract.** No reviewed source establishes one conversation over every existing local/remote multi-provider thread with every permission answered by the user. [VS Code approvals](https://code.visualstudio.com/docs/agents/run/approvals), [Kiro backends](https://kiro.dev/docs/crew/features/agent-backends/), [Cursor security](https://cursor.com/docs/cloud-agent/security-network)
- **Inferred: first-needs-you ordering remains weak.** Cards/counters expose demand without documented assignment urgency, dependency impact or fairness. Sotto's attention queue is a useful foundation. [Cursor answer](https://forum.cursor.com/t/agents-approval-window/170388/5), [Kiro Focus](https://kiro.dev/docs/ide/experimental/focus-mode/)
- **Inferred: aggregate completion needs explicit semantics.** Parent success and coordinator pause do not establish child completion or stop-all. [Warp](https://docs.warp.dev/platform/managing-cloud-agents/), [Dots](https://learn.chatgpt.com/docs/dots/tasks-and-memory)
- **Inferred: durable dispatch must preserve privacy.** Persisted submission and ordered mailboxes are useful; Sotto must keep prompt/protocol text out of logs and avoid extra hosts. [Crew specification](https://github.com/kirodotdev/KiroCrew/blob/main/docs/system-specs/modules/subagent.md), [Warp security](https://docs.warp.dev/platform/execution-security/)
- **Could not verify: sustained usability beyond five active workers.** No apps were run; grouping and historical scale fixes cannot establish responsiveness or reliable notifications. [Antigravity fixes](https://antigravity.google/docs/changelog), [Devin fixes](https://docs.devin.ai/desktop/changelog)
- **Could not verify: changing feature boundaries.** Antigravity Inbox restoration, Cursor mobile execution placement/Android release and Zed create-thread rollout remain open. [Inbox report](https://discuss.ai.google.dev/t/did-they-remove-the-inbox-in-agent-manager/126943), [Cursor mobile](https://cursor.com/docs/cloud-agent/mobile), [Cursor changelog](https://cursor.com/changelog), [Zed flags](https://raw.githubusercontent.com/zed-industries/zed/main/crates/agent/src/tools.rs)
- **Could not verify: additional reach.** Air/Devin/Zed voice/mobile supervision, a shipped fix for the VS Code duplicate-status issue, or GitHub partners beyond Claude/Codex. [Air](https://www.jetbrains.com/help/air-ides/air-overview.html), [Devin](https://docs.devin.ai/desktop/agent-command-center), [Zed](https://zed.dev/docs/ai/agents), [VS Code issue](https://github.com/microsoft/vscode/issues/336955), [GitHub agents](https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents)

## Sources

### Claude Code Desktop, Projects and agent teams

- [Redesign](https://claude.com/blog/claude-code-desktop-redesign)
- [Desktop](https://code.claude.com/docs/en/desktop)
- [Projects](https://code.claude.com/docs/en/claude-projects)
- [Teams](https://code.claude.com/docs/en/agent-teams)
- [Messaging](https://code.claude.com/docs/en/cross-session-messaging)
- [Remote Control](https://code.claude.com/docs/en/remote-control)

### VS Code Agent Sessions and Agents window

- [Download](https://code.visualstudio.com/download)
- [Window](https://code.visualstudio.com/docs/agents/run/agents-window)
- [Management](https://code.visualstudio.com/docs/agents/run/sessions/manage-sessions)
- [Tools source](https://github.com/microsoft/vscode/blob/main/src/vs/platform/agentHost/node/shared/sessionServerTools.ts)
- [Approvals](https://code.visualstudio.com/docs/agents/run/approvals)
- [Harnesses](https://code.visualstudio.com/docs/agents/run/agent-harnesses)
- [Memory](https://code.visualstudio.com/docs/agents/run/memory)
- [History](https://code.visualstudio.com/docs/agents/run/sessions/session-history)
- [Voice](https://code.visualstudio.com/docs/configure/accessibility/voice)
- [Issue](https://github.com/microsoft/vscode/issues/336955)

### Cursor Agents window and Projects

- [Download](https://cursor.com/download)
- [Releases](https://cursor.com/docs/release-notes)
- [Projects](https://cursor.com/docs/agent/projects)
- [Window](https://cursor.com/docs/agent/agents-window)
- [Worktrees](https://cursor.com/docs/configuration/worktrees)
- [Hierarchy](https://forum.cursor.com/t/hierarchical-ui-concurrency-view-for-multi-agent-workflows-in-agents-window/171765/4)
- [Cloud](https://cursor.com/docs/cloud-agent)
- [Slack](https://cursor.com/docs/integrations/slack)
- [Linear](https://cursor.com/docs/integrations/linear)
- [Attention](https://forum.cursor.com/t/agents-approval-window/170388/5)
- [Security](https://cursor.com/docs/cloud-agent/security-network)
- [Subagents](https://cursor.com/docs/subagents)
- [Mobile](https://cursor.com/docs/cloud-agent/mobile)
- [Changelog](https://cursor.com/changelog)
- [Models](https://cursor.com/docs/models-and-pricing)
- [Launch](https://cursor.com/changelog/projects)
- [Approval report](https://forum.cursor.com/t/agents-approval-window/170388)
- [Hierarchy report](https://forum.cursor.com/t/hierarchical-ui-concurrency-view-for-multi-agent-workflows-in-agents-window/171765)

### Warp and Oz

- [Announcement](https://www.warp.dev/blog/warp-is-now-open-source)
- [Plans](https://docs.warp.dev/support-and-community/plans-and-billing/plans-pricing-refunds)
- [Management](https://docs.warp.dev/platform/managing-cloud-agents/)
- [Oz web](https://docs.warp.dev/platform/oz-web-app/)
- [Orchestration](https://docs.warp.dev/platform/orchestration/)
- [Permissions](https://docs.warp.dev/agents/capabilities/agent-profiles-permissions/)
- [Guide source](https://github.com/warpdotdev/docs/blob/main/src/content/docs/guides/agent-workflows/how-to-run-multiple-ai-coding-agents.mdx)
- [Security](https://docs.warp.dev/platform/execution-security/)
- [Voice](https://docs.warp.dev/agents/local-agents/interacting-with-agents/voice/)
- [Notification source](https://raw.githubusercontent.com/warpdotdev/warp/master/app/src/ai/agent_management/agent_management_model.rs)

### OpenAI Codex, ChatGPT desktop and dots

- [Changes](https://learn.chatgpt.com/docs/whats-new)
- [App](https://learn.chatgpt.com/docs/app)
- [Dots](https://learn.chatgpt.com/docs/dots)
- [Projects](https://learn.chatgpt.com/docs/projects)
- [Activity](https://learn.chatgpt.com/docs/notifications)
- [Voice](https://learn.chatgpt.com/docs/features/voice)
- [Dots tasks](https://learn.chatgpt.com/docs/dots/tasks-and-memory)
- [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [CLI](https://learn.chatgpt.com/docs/codex/cli)
- [Long-running work](https://learn.chatgpt.com/docs/long-running-work)
- [Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)
- [Automations](https://learn.chatgpt.com/docs/automations)

### Kiro Focus mode, workflows and Crew

- [Pricing](https://kiro.dev/pricing/)
- [Repository](https://github.com/kirodotdev/KiroCrew)
- [Release](https://kiro.dev/changelog/ide/1-0-293/)
- [Crew](https://kiro.dev/docs/crew/)
- [Focus](https://kiro.dev/docs/ide/experimental/focus-mode/)
- [Chat](https://kiro.dev/docs/crew/chat/)
- [Workflows](https://kiro.dev/docs/crew/features/workflows/)
- [Workflows](https://kiro.dev/docs/workflows/)
- [Subagents](https://kiro.dev/docs/crew/features/subagents/)
- [Source](https://raw.githubusercontent.com/kirodotdev/KiroCrew/main/src/kiro_crew/subagent.py)
- [Security](https://kiro.dev/docs/crew/security/)
- [Backends](https://kiro.dev/docs/crew/features/agent-backends/)
- [Task specification](https://github.com/kirodotdev/KiroCrew/blob/main/docs/system-specs/modules/subagent.md)
- [Continuity](https://kiro.dev/docs/how-kiro-works/)

### JetBrains Air, Junie and ACP

- [July release](https://blog.jetbrains.com/air/2026/07/what-s-new-air-gets-more-agents-local-models-and-java-kotlin-code-intelligence/)
- [Overview](https://www.jetbrains.com/help/air-ides/air-overview.html)
- [IDE access](https://www.jetbrains.com/air/ides/)
- [Cloud](https://www.jetbrains.com/help/air-ides/air-start-a-new-session.html)
- [Concepts](https://www.jetbrains.com/help/air-ides/air-key-concepts.html)
- [Management](https://www.jetbrains.com/help/air-ides/air-manage-agent-sessions.html)
- [ACP](https://www.jetbrains.com/acp/)

### Google Antigravity Agent Manager

- [Launch](https://www.antigravity.google/blog/introducing-google-antigravity-2)
- [Features](https://www.antigravity.google/docs/features)
- [Changelog](https://antigravity.google/docs/changelog)
- [Plans](https://antigravity.google/docs/plans)
- [Deep dive](https://antigravity.google/blog/google-io-2026-feature-deep-dive)
- [Subagents](https://antigravity.google/docs/subagents)
- [CLI views](https://www.antigravity.google/docs/cli/commands/agents/)
- [Settings](https://www.antigravity.google/docs/agent-settings)
- [Projects](https://www.antigravity.google/docs/projects/)
- [Report](https://discuss.ai.google.dev/t/did-they-remove-the-inbox-in-agent-manager/126943)

### GitHub Agent HQ, Mission Control and Copilot app

- [HQ](https://github.blog/news-insights/company-news/welcome-home-agents/)
- [App release](https://github.blog/changelog/2026-06-17-github-copilot-app-generally-available/)
- [Third parties](https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents)
- [Management](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents)
- [App](https://docs.github.com/en/copilot/how-tos/github-copilot-app/agent-sessions)
- [Mitigations](https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/risks-and-mitigations)
- [Data](https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/session-data)
- [Limits](https://docs.github.com/en/copilot/concepts/copilot-surfaces/copilot-on-github)

### Devin Desktop, formerly Windsurf

- [FAQ](https://docs.devin.ai/desktop/devin-desktop-faq)
- [Changelog](https://docs.devin.ai/desktop/changelog)
- [Command Center](https://docs.devin.ai/desktop/agent-command-center)
- [Spaces](https://docs.devin.ai/desktop/spaces)
- [Local](https://docs.devin.ai/desktop/devin-local)
- [ACP](https://docs.devin.ai/desktop/acp)

### Zed Agent Panel, parallel agents and ACP

- [Pricing](https://zed.dev/pricing)
- [Agents](https://zed.dev/docs/ai/agents)
- [Source](https://raw.githubusercontent.com/zed-industries/zed/main/crates/agent_ui/src/agent_panel.rs)
- [Parallel agents](https://zed.dev/docs/ai/parallel-agents)
- [Gates](https://raw.githubusercontent.com/zed-industries/zed/main/crates/agent/src/tools.rs)
- [Tool source](https://raw.githubusercontent.com/zed-industries/zed/main/crates/agent/src/tools/create_thread_tool.rs)
- [Panel](https://zed.dev/docs/ai/agent-panel)
- [Terminals](https://zed.dev/docs/ai/terminal-threads)
- [External agents](https://zed.dev/docs/ai/external-agents)
- [User report](https://www.reddit.com/r/ZedEditor/comments/1u0o6st/is_anyone_using_terminal_threads/)
