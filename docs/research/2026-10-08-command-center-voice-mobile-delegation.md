# Command centers by voice, phone, and existing work tools

Researched 2026-10-08. Scope: voice and mobile control of coding agents, delegation through work tools, and how these products return decisions to the user. This is a source study, not an installed-app test; **documented** means a first-party claim, **observed** means inspected source or a dated issue, and **inferred** means a design reading.

Source branches and current documentation were read on that date, not pinned to an installed version. Worker cost/token visibility, conflict resolution, and spoken-summary accuracy are unverified unless explicitly described below.

## Summary

- **Documented:** ChatGPT Voice starts and steers separate Codex tasks and speaks their blockers/results. This is the closest direct voice reference here, subject to rollout. [ChatGPT Voice](https://learn.chatgpt.com/docs/features/voice)
- **Observed:** Happy separates silent context updates from events that require speech. It batches the latter while someone is speaking. Its current tools address a session explicitly and resolve approvals by request ID. [Voice hooks](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/realtime/hooks/voiceHooks.ts), [voice tools](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/realtime/realtimeClientTools.ts)
- **Documented:** Superwhisper now answers coding-agent questions and permission requests by voice. It is more than dictation, but its agent integrations are macOS only. [Coding agents](https://superwhisper.com/docs/get-started/coding-agents)
- **Documented:** Conductor's October 2 release adds iPhone control of cloud workspaces. Its API guide explicitly teaches an external agent to dispatch work and summarize what all agents are doing. Native spoken fleet control could not be verified. [Release](https://www.conductor.build/changelog), [manager example](https://www.conductor.build/docs/api)
- **Documented:** Linear has a conversational agent as well as agent sessions. Jira has an explicit all-session list grouped by whether the user is needed. These are useful references for making attention a durable state rather than another message. [Linear Agent](https://linear.app/docs/linear-agent), [Jira session list](https://support.atlassian.com/jira-software-cloud/docs/view-and-manage-agent-sessions-in-jira/)
- **Documented:** Omnara has pivoted from its remote coding product to a managed-agent platform. Its archived mobile claims and still-listed iOS app must not be treated as proof of the current service. [Archive notice](https://www.omnara.com/blog/mobile-coding-landscape), [current platform](https://docs.omnara.com/introduction), [iOS listing](https://apps.apple.com/us/app/omnara-claude-codex-mobile/id6748426727)
- **Observed, user reports:** Missed attention events and lost routing recur: Happy's background/presence issue, Claude's missing mobile approvals, and Codex Voice losing its live task handlers. These are dated reports, not evidence that every current release still fails. [Happy #1308](https://github.com/slopus/happy/issues/1308), [Claude #36439](https://github.com/anthropics/claude-code/issues/36439), [Codex #36404](https://github.com/openai/codex/issues/36404)
- **Inferred:** The best combination for Sotto is one conversational coordinator over a durable attention queue, explicit destination receipts, and request-bound human approvals. Copying automatic review or exporting transcripts to another control plane would conflict with Sotto's brief. [Happy routing](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/realtime/realtimeClientTools.ts), [OpenAI permissions](https://learn.chatgpt.com/docs/permission-modes), [Sotto constraints](../../AGENTS.md)

## ChatGPT Voice with Codex

- **What it is.** **Documented:** OpenAI's subscription desktop feature. October 8 access depends on plan, rollout, and workspace settings. [Voice](https://learn.chatgpt.com/docs/features/voice)
- **Command-center shape.** **Documented:** One voice conversation coordinates separate tasks. [Voice](https://learn.chatgpt.com/docs/features/voice)
- **Dispatch.** **Documented:** Start, inspect, and steer Codex work by speech. [Voice](https://learn.chatgpt.com/docs/features/voice)
- **What the hub sees.** **Documented:** Mobile exposes tasks across Cloud and connected computers, changed files, diffs, and test results. [Mobile](https://learn.chatgpt.com/docs/mobile)
- **Talking to workers.** **Documented:** Follow up, switch to an available voice-enabled task, then return. [Voice](https://learn.chatgpt.com/docs/features/voice)
- **Attention and approvals.** **Documented:** Activity lists unread, running, and waiting chats. Completion alerts have foreground/background controls; permissions and questions have separate switches. Mobile users review actions. Optional **Approve for me** delegates eligible requests to automatic review, which Sotto cannot copy. [Notifications](https://learn.chatgpt.com/docs/notifications), [mobile](https://learn.chatgpt.com/docs/mobile), [permissions](https://learn.chatgpt.com/docs/permission-modes)
- **Isolation and merge.** **Documented:** Host handoff transfers chat and Git state into a destination worktree. It interrupts an active response and does not support handoff into Codex Cloud. [Remote connections](https://learn.chatgpt.com/docs/remote-connections)
- **Memory and continuity.** **Documented:** Existing conversations continue across paired devices; local work depends on an awake, connected host. Voice resumes inside its conversation. [Remote connections](https://learn.chatgpt.com/docs/remote-connections), [voice](https://learn.chatgpt.com/docs/features/voice)
- **Voice and mobile.** **Documented:** Interruptible speech; one active desktop voice chat. iOS voice uses a paired host. [Voice](https://learn.chatgpt.com/docs/features/voice)
- **Providers.** **Documented:** The documented worker is Codex within OpenAI's product. Control of a user's Claude Code, Grok, or Devin sessions could not be verified. [Mobile](https://learn.chatgpt.com/docs/mobile)
- **Does well.** **Inferred:** The user can keep talking while workers run. [Voice](https://learn.chatgpt.com/docs/features/voice)
- **Falls short.** **Observed, GitHub user report:** #36404 reports task tools losing handlers and live host routing after successful delegation on desktop 26.727.40816, Apple silicon. Filed July 31, still open when read; not reproduced here or verified against today's app. [Issue](https://github.com/openai/codex/issues/36404)
- **For Sotto.** **Inferred:** Take the persistent conversation with inspectable worker results. Avoid automatic approval and treating cached task rows as proof that their host is reachable. [Voice](https://learn.chatgpt.com/docs/features/voice), [failure report](https://github.com/openai/codex/issues/36404), [Sotto constraints](../../AGENTS.md)

## Happy

- **What it is.** **Documented:** Slopus's MIT desktop, mobile, and web project. The original CLI wraps Claude Code and Codex; the newer Happy Harness supports multiple providers. Source on `main` reviewed October 8. Voice has a documented 20-minute free allowance and paid limits. [README](https://github.com/slopus/happy/blob/main/README.md), [voice limits](https://github.com/slopus/happy/blob/main/docs/paid-voice.md)
- **Command-center shape.** **Observed:** One ElevenLabs voice assistant receives a directory of active sessions plus the focused session's context. Background sessions feed it updates too. [Hooks](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/realtime/hooks/voiceHooks.ts)
- **Dispatch.** **Observed:** `sendMessageToSession` takes an explicit session ID and text. No voice tool to create a session appears in that inspected tool table. [Tools](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/realtime/realtimeClientTools.ts)
- **What the hub sees.** **Observed:** Session titles, project paths, history, online/offline events, messages, and permission arguments. These support a roll-up, but do not establish a live complete snapshot of every worker. [Context formatters](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/realtime/hooks/contextFormatters.ts), [hooks](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/realtime/hooks/voiceHooks.ts)
- **Talking to workers.** **Observed:** The assistant can send to a named session. Its success instruction asks it to say only “sent,” with no destination readback. Worker-to-worker messaging through this voice bridge could not be verified. [Tools](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/realtime/realtimeClientTools.ts)
- **Attention and approvals.** **Observed:** Ordinary messages are silent context; permissions and completion trigger replies, queued into one batch while anyone speaks. The system prompt waits for explicit human approval but permits a request to accept future approvals. Request ownership is found by ID. [Hooks](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/realtime/hooks/voiceHooks.ts), [prompt](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/realtime/voiceSystemPrompt.ts), [tools](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/realtime/realtimeClientTools.ts)
- **Isolation and merge.** **Documented:** Projects remain ordinary folders on the user's hardware. A voice-level isolation or merge queue could not be verified. [README](https://github.com/slopus/happy/blob/main/README.md)
- **Memory and continuity.** **Documented:** The relay synchronizes encrypted sessions to phone and web. **Observed:** Voice builds a fresh session directory on each start. [README](https://github.com/slopus/happy/blob/main/README.md), [hooks](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/realtime/hooks/voiceHooks.ts)
- **Voice and mobile.** **Observed:** The prompt requests one-sentence responses, silence when the user addresses someone else, and spoken completion updates. The paid voice path uses ElevenLabs. [Prompt](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/realtime/voiceSystemPrompt.ts), [voice limits](https://github.com/slopus/happy/blob/main/docs/paid-voice.md)
- **Providers.** **Documented:** Claude, Codex, and Grok subscriptions in Happy Harness; original CLI and newer runtime are distinct. [README](https://github.com/slopus/happy/blob/main/README.md)
- **Does well.** **Observed:** Push dispatch removed per-message buzzing and suppresses pushes only for an active user interface. It distinguishes sent, failed, suppressed, and no-device outcomes. [Push source](https://github.com/slopus/happy/blob/main/packages/happy-server/sources/app/push/pushDispatch.ts)
- **Falls short.** **Observed:** The architecture note describes focus-only tools, but current code takes explicit session IDs. **User report:** #1308 describes missing background notifications; current push source contains a narrower presence check, so the issue alone does not establish a current failure. [Older note](https://github.com/slopus/happy/blob/main/docs/voice-architecture.md), [current tools](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/realtime/realtimeClientTools.ts), [issue](https://github.com/slopus/happy/issues/1308), [push source](https://github.com/slopus/happy/blob/main/packages/happy-server/sources/app/push/pushDispatch.ts)
- **For Sotto.** **Inferred:** Take silent context, short speech, and batched attention events. Avoid bare “sent” receipts, future blanket approvals, and debug logging of voice context; keep Sotto IDs and policy records authoritative. [Prompt](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/realtime/voiceSystemPrompt.ts), [hooks](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/realtime/hooks/voiceHooks.ts), [Sotto constraints](../../AGENTS.md)

## Superwhisper

- **What it is.** **Documented:** Superwhisper's desktop and mobile dictation app, with coding-agent plugins. macOS 2.19.2 is dated October 5. Free local dictation; Pro lists $8.49/month, $84.99/year, or $249.99 lifetime. [Changelog](https://superwhisper.com/changelog), [plans](https://superwhisper.com/docs/billing/plans)
- **Command-center shape.** **Documented:** A floating response surface over agents working in the background, including multiple projects. A separate reasoning manager over all threads could not be verified. [Claude integration](https://superwhisper.com/claude-code)
- **Dispatch.** **Documented:** The user starts work in the agent, then responds through Superwhisper when called back. [Plugin README](https://github.com/superultrainc/superwhisper-claude-code)
- **What the hub sees.** **Documented:** Final messages and questions surface with context. **Observed:** Claude hooks cover completion, notification, questions, permissions, and user prompt submission. [Agent docs](https://superwhisper.com/docs/get-started/coding-agents), [hooks](https://github.com/superultrainc/superwhisper-claude-code/blob/main/hooks/hooks.json)
- **Talking to workers.** **Documented:** Dictated replies enter the waiting agent. Cross-worker messages and global spoken status queries could not be verified. [Agent docs](https://superwhisper.com/docs/get-started/coding-agents)
- **Attention and approvals.** **Documented:** The window surfaces on input or completion. Permission calls are gated and users can speak approve or deny. **Observed:** The hook delegates implementation to an app-bundled helper, so replay safety and exact approval binding could not be checked from that public hook. [Agent docs](https://superwhisper.com/docs/get-started/coding-agents), [hook source](https://github.com/superultrainc/superwhisper-claude-code/blob/main/hooks/hooks.json)
- **Isolation and merge.** **Inferred:** Plugins attach to the agent's own configuration; the reviewed integration does not define a separate worktree or merge system. [Plugin README](https://github.com/superultrainc/superwhisper-claude-code)
- **Memory and continuity.** **Documented:** A local database holds transcription history. CLI/MCP can search and export it; agent-session recovery is not specified there. [CLI/MCP](https://superwhisper.com/docs/get-started/cli)
- **Voice and mobile.** **Documented:** Agent integrations are macOS only, despite dictation apps and licensing across Windows, iOS, and Android. Two-way fleet speech on those phones could not be verified. [Agent docs](https://superwhisper.com/docs/get-started/coding-agents), [plans](https://superwhisper.com/docs/billing/plans)
- **Providers.** **Documented:** Claude Code, OpenCode, Codex, Cursor, Pi, Grok, and DeepSeek. [Agent docs](https://superwhisper.com/docs/get-started/coding-agents)
- **Does well.** **Inferred:** It returns the waiting decision to the user without requiring them to find the terminal. [Plugin README](https://github.com/superultrainc/superwhisper-claude-code)
- **Falls short.** **Documented, vendor release notes:** May 15 fixed stale queue state and missing Claude questions; August 6 fixed the wrong message appearing after queue advancement. These are resolved historical defects worth turning into checks, not current bug claims. [Changelog](https://superwhisper.com/changelog)
- **For Sotto.** **Inferred:** Take event-bound voice replies and a visible waiting request. Avoid importing transcription-history export, forced focus, or platform-wide capability claims from a macOS integration. [Agent docs](https://superwhisper.com/docs/get-started/coding-agents), [CLI/MCP](https://superwhisper.com/docs/get-started/cli), [Sotto constraints](../../AGENTS.md)

## Conductor for iOS

- **What it is.** **Documented:** Melty's Conductor companion for iPhone; listing version 1.0.5, iOS 26 minimum. Desktop 0.90.0 announced it October 2. The store lists earlier September versions, so October 2 is the verified announcement date, not necessarily first availability. Mobile is included in Pro at $50/month. [App Store](https://apps.apple.com/us/app/conductor-build/id6791228564), [release](https://www.conductor.build/changelog), [pricing](https://www.conductor.build/pricing)
- **Command-center shape.** **Documented:** Workspaces and agent chats on phone. An external manager can control them through API/MCP; the guide explicitly describes a manager conversation over many workers. [API](https://www.conductor.build/docs/api)
- **Dispatch.** **Documented:** The manager selects a repository, creates a workspace, and sends a self-contained brief. Independent issues use separate workspaces; cooperating agents may share one. [API](https://www.conductor.build/docs/api), [parallel agents](https://www.conductor.build/docs/concepts/parallel-agents)
- **What the hub sees.** **Documented:** Agent status, transcripts, PR status, and code review. API transcript queries support summaries across workspaces. [API](https://www.conductor.build/docs/api), [App Store](https://apps.apple.com/us/app/conductor-build/id6791228564)
- **Talking to workers.** **Documented:** Session messages and cancel operations; manager polls and sends corrections. A queued brief can still report idle, so the guide waits for working before treating idle as completion. [API](https://www.conductor.build/docs/api)
- **Attention and approvals.** **Documented:** Notifications now use chat titles, and sent messages show waiting until read. Local tool calls may ask permission; the mobile approval transport and notification batching were not established. Automerge settings carry to iOS. [Release](https://www.conductor.build/changelog), [security](https://www.conductor.build/docs/reference/security-and-permissions)
- **Isolation and merge.** **Documented:** Cloud workspaces use isolated Linux sandboxes; separate workspaces have separate branches. Shared-workspace agents can edit the same files. Phone supports PR merge. [Cloud](https://www.conductor.build/docs/cloud), [parallel agents](https://www.conductor.build/docs/concepts/parallel-agents), [App Store](https://apps.apple.com/us/app/conductor-build/id6791228564)
- **Memory and continuity.** **Documented:** Organization workspaces and conversations persist across devices and teammates; cloud agents keep running after the Mac closes. [Cloud](https://www.conductor.build/docs/cloud)
- **Voice and mobile.** **Documented:** iPhone control works with cloud workspaces. Native voice input, spoken fleet summaries, and remote control of local Mac workspaces could not be verified. [Release](https://www.conductor.build/changelog)
- **Providers.** **Documented:** First-party Claude Code, Codex, Cursor, and OpenCode harnesses. [Product](https://www.conductor.build/)
- **Does well.** **Inferred:** Its explicit brief, status, transcript, and deep-link contract is a useful dispatch model. [API](https://www.conductor.build/docs/api)
- **Falls short.** **Observed, App Store user report:** A review visible October 8 asks for job-completion notifications. This identifies an attention gap for that reviewer, not a verified absence in every version. Cloud-only mobile scope also excludes local sessions. [Review](https://apps.apple.com/us/app/conductor-build/id6791228564), [release](https://www.conductor.build/changelog)
- **For Sotto.** **Inferred:** Take explicit dispatch receipts and a distinction between queued, working, and done. Avoid treating an idle worker as finished or copying cloud transcript storage and automerge into Sotto's permission model. [API](https://www.conductor.build/docs/api), [security](https://www.conductor.build/docs/reference/security-and-permissions), [Sotto constraints](../../AGENTS.md)

## Linear

- **What it is.** **Documented:** Linear's issue tracker now includes a conversational Linear Agent and cloud coding sessions. Reviewed October 8. The agent platform and Linear Agent appear on Free; coding sessions consume paid workspace AI credits. [Pricing](https://linear.app/pricing), [coding sessions](https://linear.app/docs/coding-sessions)
- **Command-center shape.** **Documented:** A persistent agent chat, issue conversations, and Slack/Teams entry points. The agent summarizes work and starts coding sessions; Loops schedule or trigger recurring work. [Linear Agent](https://linear.app/docs/linear-agent)
- **Dispatch.** **Documented:** Mention or delegate an issue to an agent. A human assignee remains responsible while an agent is the delegate. [Best practices](https://linear.app/developers/agent-best-practices)
- **What the hub sees.** **Documented:** Sessions expose thinking, actions, elicitation, results, and errors. Cloud sessions can produce diffs, tests, screenshots, and recordings. [Interaction](https://linear.app/developers/agent-interaction), [coding sessions](https://linear.app/docs/coding-sessions)
- **Talking to workers.** **Documented:** Users steer coding sessions in Linear. Integration signals carry follow-ups and a stop instruction; stopping must halt actions and API calls. Direct worker-to-worker messaging is not established by that contract. [Coding sessions](https://linear.app/docs/coding-sessions), [signals](https://linear.app/developers/agent-signals)
- **Attention and approvals.** **Documented:** States are `pending`, `active`, `error`, `awaitingInput`, `complete`, and `stale`. Ephemeral progress is replaced by the next activity. Elicitation covers clarification, confirmation, authentication, and option selection; it does not establish enforcement of every provider permission. [Interaction](https://linear.app/developers/agent-interaction), [signals](https://linear.app/developers/agent-signals)
- **Isolation and merge.** **Documented:** Cloud coding uses GitHub, one repository per active environment, and draft PRs. Repository review policy governs shipping. Worktree and conflict handling across those sessions could not be verified. [Coding sessions](https://linear.app/docs/coding-sessions)
- **Memory and continuity.** **Documented:** Chat history persists. Immutable activities preserve conversation inputs; editable issue comments alone are insufficient to reconstruct an agent session. [Linear Agent](https://linear.app/docs/linear-agent), [best practices](https://linear.app/developers/agent-best-practices)
- **Voice and mobile.** **Documented:** Mobile exposes reasoning, past sessions, and further messages where supported. Spoken fleet management could not be verified. [Mobile changelog](https://linear.app/changelog/page/3)
- **Providers.** **Documented:** Built-in cloud coding supports Claude Code and Codex; third-party agents use the platform. [Coding sessions](https://linear.app/docs/coding-sessions), [agents](https://linear.app/docs/agents-in-linear)
- **Does well.** **Documented:** Guidelines ask for glanceable state, inspectable actions, unobtrusive acknowledgement, and immediate stopping. [Interaction guidelines](https://linear.app/developers/aig)
- **Falls short.** **Inferred from developer contract:** An agent can become stale after thirty minutes without an activity. The hub's knowledge depends on integrations reporting faithfully; silence does not prove useful progress. Agents are asked to acknowledge within ten seconds. [Best practices](https://linear.app/developers/agent-best-practices)
- **For Sotto.** **Inferred:** Take typed attention states and replaceable progress, with explicit freshness. Avoid interpreting activity, silence, or an integration's confirmation as a permission grant. [Interaction](https://linear.app/developers/agent-interaction), [Sotto constraints](../../AGENTS.md)

## Jira, Rovo Dev, and Jira Coding Agent

- **What it is.** **Documented:** Atlassian's current Jira coding surface, offered on Standard/Premium with Rovo credits. Standalone Rovo Dev is due to retire, but the final date is unannounced, with at least sixty days' notice promised. October 1 guidance says its tools remain active; December 3 is credit enforcement, not the announced shutdown date. [Coding Agent](https://support.atlassian.com/jira-software-cloud/docs/what-is-the-jira-coding-agent/), [licensing FAQ](https://www.atlassian.com/licensing/rovo-dev)
- **Command-center shape.** **Documented:** A work-item launch surface and an all-session inbox. The separate Agents dashboard measures linked agent work across a space; it is not a universal live conversation. [Sessions](https://support.atlassian.com/jira-software-cloud/docs/view-and-manage-agent-sessions-in-jira/), [dashboard](https://support.atlassian.com/jira-software-cloud/docs/use-the-agents-dashboard/)
- **Dispatch.** **Documented:** Select repositories from a work item; each gets its own coding session. Automation can start and follow up on work. [Generate code](https://support.atlassian.com/jira-software-cloud/docs/generate-code-from-a-work-item-in-jira/), [automation](https://support.atlassian.com/jira-software-cloud/docs/work-with-jira-coding-agent-in-automations/)
- **What the hub sees.** **Documented:** Agent, issue key, summary, state, last update, session history, and code changes. Dashboard data can lag five minutes. [Sessions](https://support.atlassian.com/jira-software-cloud/docs/view-and-manage-agent-sessions-in-jira/), [dashboard](https://support.atlassian.com/jira-software-cloud/docs/use-the-agents-dashboard/)
- **Talking to workers.** **Documented:** Follow-ups and code edits stay in the session. Cross-worker messages could not be verified. [Generate code](https://support.atlassian.com/jira-software-cloud/docs/generate-code-from-a-work-item-in-jira/)
- **Attention and approvals.** **Documented:** **For You → My agent sessions** groups **Needs input**, **Working**, and **Finished**. Badges count review work; finished means ready for review. Sorting uses last update, not documented urgency. Tool-permission response from this inbox could not be verified. [Sessions](https://support.atlassian.com/jira-software-cloud/docs/view-and-manage-agent-sessions-in-jira/)
- **Isolation and merge.** **Documented:** Cloud sandboxes produce draft PRs for human review and merge. Sandbox access belongs to the starter or automation connection owner. [Generate code](https://support.atlassian.com/jira-software-cloud/docs/generate-code-from-a-work-item-in-jira/), [automation](https://support.atlassian.com/jira-software-cloud/docs/work-with-jira-coding-agent-in-automations/)
- **Memory and continuity.** **Documented:** Sessions remain attached to work items and the Jira site. Automation lacks Teamwork Graph access to Confluence. [Sessions](https://support.atlassian.com/jira-software-cloud/docs/view-and-manage-agent-sessions-in-jira/), [automation](https://support.atlassian.com/jira-software-cloud/docs/work-with-jira-coding-agent-in-automations/)
- **Voice and mobile.** **Observed, vendor workflow report:** A March 29 account describes in-app and Slack review notifications. Native spoken control and October mobile approval handling could not be verified. [Workflow report](https://www.atlassian.com/blog/developer/120-prs-two-weeks-rovo-dev-in-jira)
- **Providers.** **Documented:** Jira Coding Agent runs on GitHub Cloud or Bitbucket Cloud. The dashboard can include Claude, Cursor, Copilot, Rovo, and marketplace agents when sessions link to work items. [Coding Agent](https://support.atlassian.com/jira-software-cloud/docs/what-is-the-jira-coding-agent/), [dashboard](https://support.atlassian.com/jira-software-cloud/docs/use-the-agents-dashboard/)
- **Does well.** **Inferred:** Its inbox makes the user's next decision clearer than a flat fleet list. [Sessions](https://support.atlassian.com/jira-software-cloud/docs/view-and-manage-agent-sessions-in-jira/)
- **Falls short.** **Observed, public issue:** ROVO-941, filed June 8 and unresolved when read, requests Jira MCP tools in Generate Code automation and raises connection-user authority. It does not prove all current entry points lack Jira tools. [Issue](https://jira.atlassian.com/browse/ROVO-941)
- **For Sotto.** **Inferred:** Take the attention groups, counts, and update time. Avoid analytics, hidden credential ownership, or equating finished with accepted. [Sessions](https://support.atlassian.com/jira-software-cloud/docs/view-and-manage-agent-sessions-in-jira/), [dashboard](https://support.atlassian.com/jira-software-cloud/docs/use-the-agents-dashboard/), [Sotto constraints](../../AGENTS.md)

## Omnara

- **What it is.** **Documented:** Omnara's current open-source managed-agent platform, advertised under Apache 2.0 with a free platform and paid compute/model resources. Earlier mobile coding posts are explicitly archived after a pivot. Reviewed October 8; the old iOS listing remains at 2.0.5, April 7. [Current product](https://www.omnara.com/), [archive notice](https://www.omnara.com/blog/mobile-coding-landscape), [App Store](https://apps.apple.com/us/app/omnara-claude-codex-mobile/id6748426727)
- **Command-center shape.** **Documented:** Today it is a platform of durable agent conversations, resources, and integrations, controlled by web, CLI, and API. The old app advertises two-way voice, but current fleet voice service could not be verified. [Introduction](https://docs.omnara.com/introduction), [old mobile listing](https://apps.apple.com/us/app/omnara-claude-codex-mobile/id6748426727)
- **Dispatch.** **Documented:** Configurations choose models, tools, machines, and scoped resource grants. Slack, Discord, and GitHub integrations provide entry points. [Concepts](https://docs.omnara.com/concepts)
- **What the hub sees.** **Documented:** Conversation events, execution state, questions, and approval requests. **Observed:** Interaction cards include command and machine context. [Concepts](https://docs.omnara.com/concepts), [interaction source](https://github.com/omnara-ai/omnara/blob/main/docs/events/interactions.mdx)
- **Talking to workers.** **Documented:** API/event interactions send input and resolve questions. Direct cross-worker messaging through the old voice assistant could not be verified. [Concepts](https://docs.omnara.com/concepts)
- **Attention and approvals.** **Observed:** Requests are open, resolved, or canceled; the first answer wins. Repeating the same answer is idempotent, while conflicting or canceled answers fail. **Documented:** Tools can be always allowed, asked, or denied; MCP defaults to asking, unlike built-in/custom tools. [Interaction source](https://github.com/omnara-ai/omnara/blob/main/docs/events/interactions.mdx), [permissions](https://docs.omnara.com/tools/permissions)
- **Isolation and merge.** **Documented:** Current machines can be existing computers or sandboxes. **Historical vendor documentation:** The April remote product synchronized branch, index, working files, and conversation state between local and sandbox; it is not proof of the current platform's merge behavior. [Concepts](https://docs.omnara.com/concepts), [archived sandbox sync](https://www.omnara.com/blog/sandbox-sync)
- **Memory and continuity.** **Documented:** Durable conversations are part of the current platform. The previous hybrid product transferred session context, with best-effort reconstruction of Claude's private transcript format. [Introduction](https://docs.omnara.com/introduction), [archived sync](https://www.omnara.com/blog/sandbox-sync)
- **Voice and mobile.** **Documented, historical/listing:** The mobile product describes local/cloud handoff, native diffs, voice, and Watch support. Current voice documentation returned unavailable; service continuity after the pivot could not be verified. [Archive](https://www.omnara.com/blog/mobile-coding-landscape), [App Store](https://apps.apple.com/us/app/omnara-claude-codex-mobile/id6748426727), [unavailable voice URL](https://docs.omnara.com/voice)
- **Providers.** **Documented:** The old app names Claude and Codex. Current agent configurations choose models and tools rather than promising a wrapper for every installed coding CLI. [App Store](https://apps.apple.com/us/app/omnara-claude-codex-mobile/id6748426727), [concepts](https://docs.omnara.com/concepts)
- **Does well.** **Inferred:** Request state, actor attribution, and conflicting-answer handling are a stronger mobile approval model than a free-form “yes.” [Interaction source](https://github.com/omnara-ai/omnara/blob/main/docs/events/interactions.mdx)
- **Falls short.** **Observed, documentation availability:** Archived descriptions and an unchanged store listing make current mobile capability uncertain. This is a verification gap, not a shutdown claim. [Archive notice](https://www.omnara.com/blog/mobile-coding-landscape), [App Store](https://apps.apple.com/us/app/omnara-claude-codex-mobile/id6748426727)
- **For Sotto.** **Inferred:** Take request-bound, idempotent human answers with cancellation and actor identity. Avoid blanket tool grants and storing full conversation events in a new control-plane log. [Interactions](https://github.com/omnara-ai/omnara/blob/main/docs/events/interactions.mdx), [permissions](https://docs.omnara.com/tools/permissions), [Sotto constraints](../../AGENTS.md)

## Claude mobile with Claude Code

- **What it is.** **Documented:** Anthropic's iOS/Android app connects to Claude Code Remote Control on a user's computer. Pro, Max, Team, and Enterprise access is documented; API-key use is unsupported. Reviewed October 8. [Remote Control](https://code.claude.com/docs/en/remote-control)
- **Command-center shape.** **Documented:** Synced worker conversations, not a verified spoken manager over every session. Remote server mode can expose multiple sessions. [Remote Control](https://code.claude.com/docs/en/remote-control)
- **Dispatch.** **Documented:** Users attach remotely to local work. Cross-session tools separately discover and message other Claude sessions, including remote ones. [Remote Control](https://code.claude.com/docs/en/remote-control), [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)
- **What the hub sees.** **Documented:** Conversation, subagent progress, workflow status, and diffs. Cross-session messages do not automatically transfer another session's full history or files. [Remote Control](https://code.claude.com/docs/en/remote-control), [messaging](https://code.claude.com/docs/en/cross-session-messaging)
- **Talking to workers.** **Documented:** `ListAgents` and `SendMessage` support peer contact. Ambiguous mentions ask for clarification; inbound messages can be held or refused. [Messaging](https://code.claude.com/docs/en/cross-session-messaging)
- **Attention and approvals.** **Documented:** Permission requests and questions reach the phone. Push controls separate model-selected notifications from action-required prompts. Trusted-device approval is an optional beta with recent authentication/biometric checks. [Remote Control](https://code.claude.com/docs/en/remote-control)
- **Isolation and merge.** **Documented:** Multi-session remote spawning supports a shared directory or worktrees. Work executes on the original computer. [Remote Control](https://code.claude.com/docs/en/remote-control)
- **Memory and continuity.** **Documented:** Conversations sync, but the local process and host must remain available. Cross-session subscriptions are time-limited notifications, not a permanent task ledger. [Remote Control](https://code.claude.com/docs/en/remote-control), [messaging](https://code.claude.com/docs/en/cross-session-messaging)
- **Voice and mobile.** **Documented:** General Claude conversations support two-way voice. Claude Code and Cowork support dictation, not that voice mode. This distinction rules out claiming a native spoken coding fleet from the mobile chat feature alone. [Voice mode](https://support.claude.com/en/articles/11101966-use-voice-mode)
- **Providers.** **Documented:** Claude Code sessions. Messaging preserves each session's own permission boundary and rejects requests to bypass another session's blocked action. [Messaging](https://code.claude.com/docs/en/cross-session-messaging)
- **Does well.** **Inferred:** Ambiguity handling and explicit session boundaries offer useful safeguards for conversational routing. [Messaging](https://code.claude.com/docs/en/cross-session-messaging)
- **Falls short.** **Observed, GitHub user report:** #36439 reports a permission blocked locally without appearing on the phone, March 20. It was closed April 25 as duplicate/stale; a current fix was not independently verified. [Issue](https://github.com/anthropics/claude-code/issues/36439)
- **For Sotto.** **Inferred:** Take explicit ambiguous-recipient clarification and the distinction between worker liveness and connection liveness. Avoid treating dictation as a two-way voice coordinator or forwarding authority between sessions. [Voice](https://support.claude.com/en/articles/11101966-use-voice-mode), [messaging](https://code.claude.com/docs/en/cross-session-messaging), [Sotto constraints](../../AGENTS.md)

## VoiceMode MCP

- **What it is.** **Documented:** Mike Bailey's MIT voice MCP server for compatible clients. Release 8.12.0 is dated July 21; `master` documentation reviewed October 8 may describe unreleased changes. Linux, macOS, and Windows are supported. [README](https://github.com/mbailey/voicemode), [license](https://github.com/mbailey/voicemode/blob/master/LICENSE), [release](https://github.com/mbailey/voicemode/releases/tag/v8.12.0)
- **Command-center shape.** **Documented:** A shared speech channel for agents, rather than a fleet-planning agent. A “conch” gives one speaker the microphone/output at a time. [Configuration](https://github.com/mbailey/voicemode/blob/master/docs/guides/configuration.md)
- **Dispatch.** **Inferred:** The MCP client decides work; VoiceMode provides speech and listening tools. No built-in plan splitter was verified. [README](https://github.com/mbailey/voicemode)
- **What the hub sees.** **Documented:** Speaker ownership and waiting order. Worker diffs, tests, costs, and completion evidence belong to the client, not this voice transport. [Configuration](https://github.com/mbailey/voicemode/blob/master/docs/guides/configuration.md)
- **Talking to workers.** **Documented:** Compatible clients share the voice service. Optional conch tools expose a FIFO queue, holder names, and operator overrides; this is turn-taking, not a task mailbox. [Configuration](https://github.com/mbailey/voicemode/blob/master/docs/guides/configuration.md)
- **Attention and approvals.** **Documented:** Busy calls can return “not spoken/not queued”; waiting is optional. Tool allow rules can pre-approve the voice service. No fleet-wide human permission queue is documented there. [Configuration](https://github.com/mbailey/voicemode/blob/master/docs/guides/configuration.md)
- **Isolation and merge.** **Inferred:** Coding isolation and merge remain the client's responsibility. [README](https://github.com/mbailey/voicemode)
- **Memory and continuity.** **Documented:** Configuration and queue state persist locally. Remote conch uses heartbeat/expiry and polling; it does not establish durable task memory. [Configuration](https://github.com/mbailey/voicemode/blob/master/docs/guides/configuration.md)
- **Voice and mobile.** **Documented:** Local Whisper/Kokoro or cloud speech services support conversation. Remote MCP is supported; a native mobile command-center app could not be verified. [README](https://github.com/mbailey/voicemode), [configuration](https://github.com/mbailey/voicemode/blob/master/docs/guides/configuration.md)
- **Providers.** **Documented:** Any compatible MCP client, rather than one coding provider. [README](https://github.com/mbailey/voicemode)
- **Does well.** **Inferred:** Serializing speech and naming its owner address the physical problem of several agents talking at once. [Configuration](https://github.com/mbailey/voicemode/blob/master/docs/guides/configuration.md)
- **Falls short.** **Observed, GitHub user reports:** August 17 issues against 8.12.0 describe concurrent HTTP clients bypassing the conch and an abandoned call retaining a lock. Both were open when read; newer source is not proof that the published release fixes them. [#521](https://github.com/mbailey/voicemode/issues/521), [#522](https://github.com/mbailey/voicemode/issues/522)
- **For Sotto.** **Inferred:** Take single-speaker arbitration and explicit busy outcomes. Avoid letting background workers compete to speak or equating an audio lock with authority to approve tools. [Configuration](https://github.com/mbailey/voicemode/blob/master/docs/guides/configuration.md), [Sotto constraints](../../AGENTS.md)

## Devin in Slack and voice mode

- **What it is.** **Documented:** Cognition's commercial Devin service. October 8 pricing lists Free, Pro $20/month, and Max $200/month; Teams has team and developer-seat charges. [Pricing](https://devin.ai/pricing)
- **Command-center shape.** **Documented:** Slack threads or Code Channels map to sessions; voice calls attach to a session. Devin's MCP tools can list, create, and message sessions. [Slack](https://docs.devin.ai/integrations/slack), [voice](https://docs.devin.ai/work-with-devin/voice-mode), [security profiles](https://docs.devin.ai/product-guides/security-profiles)
- **Dispatch.** **Documented:** `@Devin` starts work, `!new` starts separately, and `!ask` answers without a full run. A message shortcut opens an editable launch form. [Slack](https://docs.devin.ai/integrations/slack)
- **What the hub sees.** **Documented:** Shell, code, browser, work logs, and PRs. A read-only sidechat can explain work while the main task continues. [Session tools](https://docs.devin.ai/work-with-devin/devin-session-tools), [Slack](https://docs.devin.ai/integrations/slack)
- **Talking to workers.** **Documented:** Replies synchronize with the session. Every Code Channel message reaches its worker; after moving there, replies in the old thread no longer do. [Slack](https://docs.devin.ai/integrations/slack)
- **Attention and approvals.** **Documented:** Working/blocked/done chips, completion/failure reactions, DM alerts, mute, asides, and sleep controls. Security profiles can ask about blocked network destinations; phone/voice permission-answer binding could not be verified. [Slack](https://docs.devin.ai/integrations/slack), [security profiles](https://docs.devin.ai/product-guides/security-profiles)
- **Isolation and merge.** **Documented:** Session tools expose Devin's working environment and PR output. Cross-session merge serialization could not be verified. [Session tools](https://docs.devin.ai/work-with-devin/devin-session-tools)
- **Memory and continuity.** **Documented:** Personal memory retains provenance and handles concurrent writes. It excludes live task/PR state, secrets, and summaries; automated sessions do not use it. [Memory](https://docs.devin.ai/product-guides/memory)
- **Voice and mobile.** **Documented:** Calls support interruption, push-to-talk, muting, and continued navigation. Starting a call sends any typed draft; the conversation enters session history. Spoken all-session roll-up could not be verified. [Voice](https://docs.devin.ai/work-with-devin/voice-mode)
- **Providers.** **Documented:** Multiple model families within Devin's harness, not a verified wrapper around arbitrary installed CLIs. [Pricing](https://devin.ai/pricing)
- **Does well.** **Inferred:** Separate codebase questions and read-only sidechats let the user inspect work without redirecting it. [Slack](https://docs.devin.ai/integrations/slack), [session tools](https://docs.devin.ai/work-with-devin/devin-session-tools)
- **Falls short.** **Inferred from vendor workflow:** Moving a session changes its reply destination. Code Channels are still rolling out, and an old-thread reply can miss the worker. [Slack](https://docs.devin.ai/integrations/slack)
- **For Sotto.** **Inferred:** Take separate inspect and instruct paths. Avoid sending a draft merely because voice starts, or treating every ambient channel message as an instruction. [Voice](https://docs.devin.ai/work-with-devin/voice-mode), [Slack](https://docs.devin.ai/integrations/slack)

## Codex through ChatGPT in Slack

- **What it is.** **Documented:** OpenAI's workspace Slack deployment; current guidance moves new `@Codex` requests to `@ChatGPT`. Reviewed October 8; exact plan pricing was not established. [Slack guide](https://learn.chatgpt.com/docs/third-party/slack)
- **Command-center shape.** **Documented:** A Slack conversation delegates repository work to a separate Codex Cloud task. [Guide](https://learn.chatgpt.com/docs/third-party/slack)
- **Dispatch.** **Documented:** Mention the repository; selection uses accessible, published, workspace-shared environments. [Guide](https://learn.chatgpt.com/docs/third-party/slack)
- **What the hub sees.** **Documented:** Returned results; Follow along opens inspectable work when available. [Guide](https://learn.chatgpt.com/docs/third-party/slack)
- **Talking to workers.** **Documented:** Same-thread, same-account follow-ups can reuse the task. Another account may start separately. [Guide](https://learn.chatgpt.com/docs/third-party/slack)
- **Attention and approvals.** **Documented:** Private Allow/Deny cards authorize requests; requester-only Cancel may be available. Fleet-wide attention ranking is unverified. [Guide](https://learn.chatgpt.com/docs/third-party/slack)
- **Isolation and merge.** **Documented:** Work uses the selected cloud environment; results need review before merge. [Guide](https://learn.chatgpt.com/docs/third-party/slack)
- **Memory and continuity.** **Documented:** Different environments require new conversations. Long threads need restated context. [Guide](https://learn.chatgpt.com/docs/third-party/slack)
- **Voice and mobile.** **Inferred:** Slack is the entry point; native spoken control was not verified. [Guide](https://learn.chatgpt.com/docs/third-party/slack)
- **Providers.** **Documented:** Codex Cloud. [Guide](https://learn.chatgpt.com/docs/third-party/slack)
- **Does well.** **Inferred:** Approval and task inspection remain explicit. [Guide](https://learn.chatgpt.com/docs/third-party/slack)
- **Falls short.** **Documented limitation:** Private approval does not make channel results private; Slack Connect is unsupported. [Guide](https://learn.chatgpt.com/docs/third-party/slack)
- **For Sotto.** **Inferred:** Take requester-bound controls. Avoid account-dependent routing hidden behind one conversation. [Guide](https://learn.chatgpt.com/docs/third-party/slack)

## Claude Code in Slack and Claude Tag

- **What it is.** **Documented:** Anthropic retired the individual-account Slack path on October 5 for workspaces connected to Claude organizations. Unconnected Pro/Max workspaces can retain it. Team/Enterprise move to Claude Tag, a public beta using organizational identity and usage in channels. [Transition](https://code.claude.com/docs/en/slack), [Tag overview](https://claude.com/docs/claude-tag/overview)
- **Command-center shape.** **Documented:** A channel agent can hand complex work to thread-bound workers. Requested project digests cover progress, blockers, and stale work. [How it works](https://claude.com/docs/claude-tag/concepts/how-it-works), [project tracking](https://claude.com/docs/claude-tag/users/use-cases/track-projects)
- **Dispatch.** **Documented:** Channel/group-DM requests create coding work; participants steer by replying in its thread. [How it works](https://claude.com/docs/claude-tag/concepts/how-it-works)
- **What the hub sees.** **Documented:** Slack history, connected work tools, an editable checklist, and worker results. [Project tracking](https://claude.com/docs/claude-tag/users/use-cases/track-projects), [how it works](https://claude.com/docs/claude-tag/concepts/how-it-works)
- **Talking to workers.** **Documented:** Parallel threads resemble separate Claude Code sessions; they do not directly share state. [How it works](https://claude.com/docs/claude-tag/concepts/how-it-works)
- **Attention and approvals.** **Documented:** Mention reactions, working indicators, and Stop controls acknowledge work. Responses can be muted or mention-only. Automatic permission checking and administrator allow rules differ from Sotto's human-only authority. [Response rules](https://claude.com/docs/claude-tag/users/when-claude-responds), [Claude Code comparison](https://claude.com/docs/claude-tag/concepts/for-claude-code-users)
- **Isolation and merge.** **Documented:** Workers use separate sandboxes. Repository instructions load; local settings, hooks, and MCP configuration do not simply transfer. [How it works](https://claude.com/docs/claude-tag/concepts/how-it-works), [comparison](https://claude.com/docs/claude-tag/concepts/for-claude-code-users)
- **Memory and continuity.** **Documented:** Thread history persists, but idle sandboxes are discarded. Unpushed/unposted files can disappear when a reply starts a fresh sandbox. [How it works](https://claude.com/docs/claude-tag/concepts/how-it-works)
- **Voice and mobile.** **Documented:** The reviewed entry points are Slack channels and DMs. Spoken digest delivery and phone approval authentication could not be verified. [Overview](https://claude.com/docs/claude-tag/overview)
- **Providers.** **Documented:** Claude's own cloud coding execution. [Comparison](https://claude.com/docs/claude-tag/concepts/for-claude-code-users)
- **Does well.** **Inferred:** A requested digest can bring blockers and stale work together without requiring the user to open every conversation. [Project tracking](https://claude.com/docs/claude-tag/users/use-cases/track-projects)
- **Falls short.** **Documented limitations:** Slack does not notify for checklist edits. Automatic monitoring can silently stop after inactivity or high volume. [How it works](https://claude.com/docs/claude-tag/concepts/how-it-works), [response rules](https://claude.com/docs/claude-tag/users/when-claude-responds)
- **For Sotto.** **Inferred:** Take requested digests and inspectable progress. Avoid silent supervision cutoffs and automatic permissions. [Response rules](https://claude.com/docs/claude-tag/users/when-claude-responds), [comparison](https://claude.com/docs/claude-tag/concepts/for-claude-code-users), [Sotto constraints](../../AGENTS.md)

## Cursor in Slack

- **What it is.** **Documented:** Cursor's commercial cloud-agent Slack app requires usage-based billing. Reviewed October 8; the security page mentions 3.23, October 1, but a separate Slack-app version could not be verified. [Slack](https://prod.cursor.com/docs/integrations/slack), [run modes](https://prod.cursor.com/docs/agent/security/run-modes)
- **Command-center shape.** **Documented:** Slack conversations launch workers; `@Cursor list my agents` lists running work. [Slack](https://prod.cursor.com/docs/integrations/slack)
- **Dispatch.** **Documented:** Name repository, branch, model, environment, worker, and output channel. Requesting a new agent starts separately. [Slack](https://prod.cursor.com/docs/integrations/slack)
- **What the hub sees.** **Documented:** Status, PR links, streamed output, and artifacts. [Slack](https://prod.cursor.com/docs/integrations/slack), [security](https://prod.cursor.com/docs/cloud-agent/security)
- **Talking to workers.** **Documented:** Thread follow-ups continue an agent. When several share a thread, Add follow-up lets the user select the target. [Slack](https://prod.cursor.com/docs/integrations/slack)
- **Attention and approvals.** **Documented:** Reactions mark running/done/failed, with brief updates and optional DMs. Cloud agents automatically run commands and never ask approval for actions. [Slack](https://prod.cursor.com/docs/integrations/slack), [run modes](https://prod.cursor.com/docs/agent/security/run-modes)
- **Isolation and merge.** **Documented:** Dedicated Firecracker VMs produce draft PRs; access follows user and administrator repository grants. [Security](https://prod.cursor.com/docs/cloud-agent/security)
- **Memory and continuity.** **Documented:** Backend conversation state enables resumption. Prompts, responses, tool calls, diffs, and artifacts are retained by default, with different enterprise controls. [Security](https://prod.cursor.com/docs/cloud-agent/security)
- **Voice and mobile.** **Inferred:** Slack offers an existing conversation surface. Native fleet speech and mobile permission handling are unverified; cloud execution itself does not ask those permissions. [Slack](https://prod.cursor.com/docs/integrations/slack), [run modes](https://prod.cursor.com/docs/agent/security/run-modes)
- **Providers.** **Documented:** Cursor's cloud harness, with model selection. [Slack](https://prod.cursor.com/docs/integrations/slack)
- **Does well.** **Inferred:** Explicit worker selection handles a routing ambiguity many chat interfaces create. [Slack](https://prod.cursor.com/docs/integrations/slack)
- **Falls short.** **Documented policy mismatch:** Automatic actions and default protocol retention do not match Sotto's permission/logging constraints. This is a product-policy difference, not a user-reported defect. [Run modes](https://prod.cursor.com/docs/agent/security/run-modes), [security](https://prod.cursor.com/docs/cloud-agent/security), [Sotto constraints](../../AGENTS.md)
- **For Sotto.** **Inferred:** Take target selection and glanceable event states. Avoid attaching several workers to one ambiguous destination without a receipt naming the Sotto thread. [Slack](https://prod.cursor.com/docs/integrations/slack), [Sotto constraints](../../AGENTS.md)

## GitHub Copilot issue assignment and mobile

- **What it is.** **Documented:** GitHub's commercial cloud agent. October 8 plans list Pro $10/month, Pro+ $39, Max $100, and organizational plans. Issue assignment is public preview. [Plans](https://docs.github.com/en/copilot/get-started/plans), [issue flow](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github)
- **Command-center shape.** **Documented:** An agents panel across repositories, with Copilot Chat able to explain an active session's work. [GitHub surface](https://docs.github.com/en/copilot/concepts/copilot-surfaces/copilot-on-github)
- **Dispatch.** **Documented:** Assign an issue and select repository, base branch, agent, model, reasoning, and instructions. It receives existing issue comments at launch. [Issue flow](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github)
- **What the hub sees.** **Documented:** Session reasoning, tools, tests, duration, and token usage. [Tracking](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents)
- **Talking to workers.** **Documented:** Steering applies after the current tool call. Later issue comments do not reach the worker; use the session or PR. Third-party agent steering is unsupported in this surface. [Tracking](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents), [issue flow](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github)
- **Attention and approvals.** **Documented:** Actions workflows on agent changes require human approval by default. Since March 13, administrators can optionally skip it. This is a workflow gate, not proof of per-command human approval. [Change](https://github.blog/changelog/2026-03-13-optionally-skip-approval-for-copilot-coding-agent-actions-workflows/), [responsible use](https://docs.github.com/en/copilot/responsible-use/agents)
- **Isolation and merge.** **Documented:** Ephemeral cloud work; one repository, branch, and PR per task, with a 59-minute session limit. It cannot push directly to the default branch. [GitHub surface](https://docs.github.com/en/copilot/concepts/copilot-surfaces/copilot-on-github), [responsible use](https://docs.github.com/en/copilot/responsible-use/agents)
- **Memory and continuity.** **Documented:** Stopping preserves pushed commits. Sessions can be archived but not deleted. [Tracking](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents)
- **Voice and mobile.** **Documented:** GitHub Mobile launches sessions, assigns issues, and shows current/previous PR work. Spoken fleet queries and voice permissions could not be verified. [Mobile](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-mobile)
- **Providers.** **Documented:** Copilot's cloud agent and model choices; the panel also distinguishes third-party agents with different steering support. [Tracking](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents)
- **Does well.** **Inferred:** Explicit launch choices and inspectable test/tool evidence make dispatch reviewable. [Issue flow](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github), [tracking](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents)
- **Falls short.** **Documented workflow limitation:** The issue remains visible but later comments do not steer its agent. **Inferred:** This invites a plausible message sent to the wrong destination. [Issue flow](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github)
- **For Sotto.** **Inferred:** Take explicit launch targeting and evidence links. Avoid silent issue-to-PR routing changes or turning an optional workflow bypass into permission authority. [Issue flow](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github), [workflow change](https://github.blog/changelog/2026-03-13-optionally-skip-approval-for-copilot-coding-agent-actions-workflows/), [Sotto constraints](../../AGENTS.md)

## Wispr Flow

- **What it is.** **Documented:** Wispr's commercial dictation app for Mac, Windows, iOS, and Android. October 8 pricing lists Free and Pro at $15/user/month. Command-mode documentation was updated October 3. [Coding use](https://wisprflow.ai/use-cases/cursor), [pricing](https://wisprflow.ai/pricing), [command mode](https://docs.wisprflow.ai/articles/4816967992-how-to-use-command-mode)
- **Command-center shape.** **Documented:** Voice text entry plus experimental commands. A separate remote MCP searches meeting notes; it is not a coding-fleet controller. [Command mode](https://docs.wisprflow.ai/articles/4816967992-how-to-use-command-mode), [MCP](https://docs.wisprflow.ai/articles/9551372685-connect-an-mcp-client-to-wispr-flow-remote-mcp-server)
- **Dispatch.** **Documented:** Dictate prompts into an editor; command mode edits selected text or runs supported searches/actions. It is disabled by default on desktop. [Coding use](https://wisprflow.ai/use-cases/cursor), [command mode](https://docs.wisprflow.ai/articles/4816967992-how-to-use-command-mode)
- **What the hub sees.** **Documented:** Command mode uses the selected text or focused field. Meeting MCP reads notes, summaries, transcripts, and tasks; it excludes dictation history. Agent state/diffs/tests are not established. [Command mode](https://docs.wisprflow.ai/articles/4816967992-how-to-use-command-mode), [MCP](https://docs.wisprflow.ai/articles/9551372685-connect-an-mcp-client-to-wispr-flow-remote-mcp-server)
- **Talking to workers.** **Inferred:** The focused application receives text. No session-addressed messaging or worker mailbox was verified. [Coding use](https://wisprflow.ai/use-cases/cursor)
- **Attention and approvals.** **Documented:** Escape cancels a desktop command; some failures produce notifications. Coding permission routing, proactive worker attention, and mobile approval authentication could not be verified. [Command mode](https://docs.wisprflow.ai/articles/4816967992-how-to-use-command-mode)
- **Isolation and merge.** **Inferred:** These remain the editor/agent's responsibility. [Coding use](https://wisprflow.ai/use-cases/cursor)
- **Memory and continuity.** **Documented:** Dictionary and style sync across devices. MCP uses account-wide authorization for existing notes, with separate organization policies. This is not task continuity. [Coding use](https://wisprflow.ai/use-cases/cursor), [MCP](https://docs.wisprflow.ai/articles/9551372685-connect-an-mcp-client-to-wispr-flow-remote-mcp-server)
- **Voice and mobile.** **Documented:** Mobile dictation exists. iOS command mode supports search phrases, but in-place spoken editing is currently not working. Two-way worker speech was not verified. [Coding use](https://wisprflow.ai/use-cases/cursor), [command mode](https://docs.wisprflow.ai/articles/4816967992-how-to-use-command-mode)
- **Providers.** **Documented:** Text entry works with coding editors. MCP supports Claude, ChatGPT, Gemini, Cursor, and other clients for note reading. [Coding use](https://wisprflow.ai/use-cases/cursor), [MCP](https://docs.wisprflow.ai/articles/9551372685-connect-an-mcp-client-to-wispr-flow-remote-mcp-server)
- **Does well.** **Inferred:** It reaches tools the user already uses without requiring a new coding workspace. [Coding use](https://wisprflow.ai/use-cases/cursor)
- **Falls short.** **Documented limitation:** iOS spoken editing can silently fail, and ordinary dictation does not activate commands merely because the user says the wake phrase. [Command mode](https://docs.wisprflow.ai/articles/4816967992-how-to-use-command-mode)
- **For Sotto.** **Inferred:** Take low-friction dictation into the current conversation. Avoid substituting focus for an explicit worker identity or treating a meeting MCP as fleet control. [Coding use](https://wisprflow.ai/use-cases/cursor), [MCP](https://docs.wisprflow.ai/articles/9551372685-connect-an-mcp-client-to-wispr-flow-remote-mcp-server)

## Talon for coding

- **What it is.** **Documented:** Talon Voice LLC's desktop input system for Mac, Windows, and Linux/X11. It has a royalty-free proprietary app license and paid Talon+ features. Release 1.0 is dated September 20. [Product](https://talonvoice.com/), [EULA](https://talonvoice.com/EULA.txt), [changelog](https://talonvoice.com/dl/latest/changelog.html)
- **Command-center shape.** **Documented:** Voice commands, dictation, gaze, and noise-triggered desktop actions. It is an input system, not a documented reasoning hub. [Product](https://talonvoice.com/), [reference](https://talonvoice.com/docs/reference/official.html)
- **Dispatch.** **Documented:** Spoken grammar invokes Python actions in contexts matching applications, titles, or modes. **Inferred:** Custom scripts could dispatch coding work; that is not an out-of-box fleet feature. [Language guide](https://talonvoice.com/docs/reference/guide.language.html)
- **What the hub sees.** **Documented:** App context and accessibility inspection. Worker status, costs, and evidence must be supplied by custom integration. [Language guide](https://talonvoice.com/docs/reference/guide.language.html), [1.0 notes](https://talonvoice.com/dl/latest/changelog.html)
- **Talking to workers.** **Inferred:** Commands can type or operate the desktop; no built-in session mailbox was verified. [Language guide](https://talonvoice.com/docs/reference/guide.language.html)
- **Attention and approvals.** **Documented:** New HUD/subtitle features expose recognized commands. Native agent attention ranking and request-bound permission handling were not verified. [Changelog](https://talonvoice.com/dl/latest/changelog.html)
- **Isolation and merge.** **Inferred:** External coding tools own both; Talon supplies input. [Reference](https://talonvoice.com/docs/reference/official.html)
- **Memory and continuity.** **Documented:** User scripts and configuration define behavior across sessions. Persistent coding-task state was not verified. [Reference](https://talonvoice.com/docs/reference/official.html)
- **Voice and mobile.** **Documented:** Voice is the primary input, with new dictation, command, rejection, and speaker-verification models in 1.0. A mobile coding control app was not verified. [Product](https://talonvoice.com/), [changelog](https://talonvoice.com/dl/latest/changelog.html)
- **Providers.** **Inferred:** Desktop actions can reach many tools, but that is interface compatibility rather than provider-aware coordination. [Language guide](https://talonvoice.com/docs/reference/guide.language.html)
- **Does well.** **Inferred:** Explicit grammars and context scopes make recurring commands predictable and accessible. [Language guide](https://talonvoice.com/docs/reference/guide.language.html)
- **Falls short.** **Documented limitation:** The 1.0 notes say new capabilities are not yet fully documented. The EULA also describes performance-metric uploads and automatic crash reporting, incompatible with copying its privacy defaults into Sotto. [Changelog](https://talonvoice.com/dl/latest/changelog.html), [EULA](https://talonvoice.com/EULA.txt)
- **For Sotto.** **Inferred:** Take visible recognition feedback and explicit command scopes. Avoid relying on speech recognition or speaker matching alone to authorize a pending action. [Changelog](https://talonvoice.com/dl/latest/changelog.html), [Sotto constraints](../../AGENTS.md)

## Patterns across this lane

**Inferred:** A useful comparison separates conversation, transport, and attention. A product can provide one of these without the other two. These are source-backed capabilities, not app-test results. [ChatGPT Voice](https://learn.chatgpt.com/docs/features/voice), [VoiceMode](https://github.com/mbailey/voicemode), [Jira inbox](https://support.atlassian.com/jira-software-cloud/docs/view-and-manage-agent-sessions-in-jira/)

| Pattern | Strongest reference here | Limit that matters to Sotto |
| --- | --- | --- |
| Spoken manager over separate work | **Documented:** [ChatGPT Voice](https://learn.chatgpt.com/docs/features/voice) starts and steers Codex tasks. | **Unverified:** Heterogeneous installed CLI fleets and deterministic summary fidelity. |
| Context without constant speech | **Observed:** [Happy hooks](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/realtime/hooks/voiceHooks.ts) keep ordinary updates silent and batch attention prompts. | **Inferred:** Batching still needs prioritization and an unresolved-request ledger. |
| Explicit attention state | **Documented:** [Linear activities](https://linear.app/developers/agent-interaction) and [Jira groups](https://support.atlassian.com/jira-software-cloud/docs/view-and-manage-agent-sessions-in-jira/) distinguish progress from input/review. | **Inferred:** “Complete” must not mean accepted or permission granted. |
| Safe answer transport | **Observed:** [Omnara interaction state](https://github.com/omnara-ai/omnara/blob/main/docs/events/interactions.mdx) rejects conflicting and canceled answers. | **Inferred:** Speech still needs explicit human intent bound to the current request. |
| Correct destination | **Documented:** [Cursor's follow-up picker](https://prod.cursor.com/docs/integrations/slack) and [Claude's ambiguity check](https://code.claude.com/docs/en/cross-session-messaging) select a worker. | **Inferred:** Read back a human-readable thread/project name while routing by Sotto ID. |
| Honest delivery state | **Documented:** [Conductor](https://www.conductor.build/changelog) distinguishes sent-but-unread; its [API](https://www.conductor.build/docs/api) warns about initial idle. | **Inferred:** Queued, delivered, read, executing, and ready are different facts. |
| Quiet notification channels | **Observed:** [Happy push dispatch](https://github.com/slopus/happy/blob/main/packages/happy-server/sources/app/push/pushDispatch.ts) avoids message-by-message buzzing. | **Inferred:** Active user presence must not be confused with a connected worker process. |

- **Short speech is a policy, not a truth guarantee.** **Observed:** Happy's prompt asks for one sentence; context comes from session events. **Inferred:** Sotto should generate a roll-up from current typed facts, attach update times, and let the user inspect the underlying thread. No deterministic grounding test for spoken summaries was verified in the reviewed products. [Happy prompt](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/realtime/voiceSystemPrompt.ts), [formatters](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/realtime/hooks/contextFormatters.ts)
- **A receipt must name the destination.** **Observed:** Happy's tool requests a bare “sent.” **Documented:** Conductor has a waiting-until-read state. **Inferred:** A short receipt such as “Sent to checkout in storefront; waiting for it to read” combines identity and transport state without exposing provider IDs. [Happy tools](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/realtime/realtimeClientTools.ts), [Conductor release](https://www.conductor.build/changelog), [Sotto vocabulary](../../CONTEXT.md)
- **No notification is not no work.** **Documented:** Edited Slack checklists do not notify, and remote hosts must remain available. **Inferred:** A durable queue must survive missed push delivery and preserve why the user is needed. [Claude Tag](https://claude.com/docs/claude-tag/concepts/how-it-works), [remote hosts](https://learn.chatgpt.com/docs/remote-connections)
- **A phone is a controller, not a new grant.** **Documented:** Products range from per-request private cards to always-allowed cloud commands. **Inferred:** Sotto should preserve its permission record, actor, request identity, cancellation, and explicit user answer across desktop, phone, and voice; a coordinator summary never approves. [OpenAI Slack](https://learn.chatgpt.com/docs/third-party/slack), [Cursor modes](https://prod.cursor.com/docs/agent/security/run-modes), [Omnara interactions](https://github.com/omnara-ai/omnara/blob/main/docs/events/interactions.mdx), [Sotto constraints](../../AGENTS.md)

## Gaps nobody fills well

These are gaps in the reviewed evidence, not proof that no implementation exists.

- **One private spoken fleet across installed providers.** **Documented/observed:** ChatGPT has spoken Codex delegation; Happy has multiple session targets; Superwhisper supports several agents. **Unverified:** One product combining a spoken manager, every installed CLI's live evidence, persistent ranked attention, and Sotto's no-new-host/no-log constraints. [Voice](https://learn.chatgpt.com/docs/features/voice), [Happy tools](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/realtime/realtimeClientTools.ts), [Superwhisper agents](https://superwhisper.com/docs/get-started/coding-agents), [Sotto brief](../../AGENTS.md)
- **A short, true “everyone” answer.** **Unverified:** Completeness, freshness, and contradiction handling for every worker in a spoken roll-up. **Inferred:** Start with counts and exceptions, then drill down: “Two working. Checkout needs your approval. Tests are ready.” Qualify unreachable hosts instead of guessing. [Happy context](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/realtime/hooks/contextFormatters.ts), [Linear state contract](https://linear.app/developers/agent-interaction), [Codex routing report](https://github.com/openai/codex/issues/36404)
- **Permission safety over voice.** **Observed:** Happy resolves request IDs and Omnara rejects conflicting answers. **Unverified:** End-to-end replay protection, stale-request handling, and explicit per-request intent in Superwhisper's bundled helper or Devin's voice path. This is a verification requirement, not a demonstrated exploit. [Happy tools](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/realtime/realtimeClientTools.ts), [Omnara interactions](https://github.com/omnara-ai/omnara/blob/main/docs/events/interactions.mdx), [Superwhisper hook](https://github.com/superultrainc/superwhisper-claude-code/blob/main/hooks/hooks.json), [Devin voice](https://docs.devin.ai/work-with-devin/voice-mode)
- **Attention that survives missed delivery without flooding.** **Unverified:** Cross-product urgency ranking, duplicate suppression, and offline catch-up. **Inferred:** Historical missed-alert reports justify an independent queue. [Jira sessions](https://support.atlassian.com/jira-software-cloud/docs/view-and-manage-agent-sessions-in-jira/), [Happy report](https://github.com/slopus/happy/issues/1308), [Claude mobile report](https://github.com/anthropics/claude-code/issues/36439)
- **Clear current capability after a pivot or rollout.** **Unverified:** Omnara's current mobile service, Conductor's native voice/phone approval transport, and complete rollout of Devin Code Channels. **Documented:** Rovo Dev's final retirement date is unannounced. [Omnara archive](https://www.omnara.com/blog/mobile-coding-landscape), [Conductor release](https://www.conductor.build/changelog), [Devin Slack](https://docs.devin.ai/integrations/slack), [Rovo FAQ](https://www.atlassian.com/licensing/rovo-dev)


## Sources

First-party documentation and inspected source unless marked as a user report. All were read on October 8; older dates identify the evidence, not current reproducibility.

### ChatGPT Voice with Codex

- [Voice](https://learn.chatgpt.com/docs/features/voice).
- [Mobile](https://learn.chatgpt.com/docs/mobile).
- [Notifications](https://learn.chatgpt.com/docs/notifications).
- [permissions](https://learn.chatgpt.com/docs/permission-modes).
- [Remote connections](https://learn.chatgpt.com/docs/remote-connections).
- [Issue](https://github.com/openai/codex/issues/36404) — public user report/request.

### Happy

- [README](https://github.com/slopus/happy/blob/main/README.md).
- [voice limits](https://github.com/slopus/happy/blob/main/docs/paid-voice.md).
- [Hooks](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/realtime/hooks/voiceHooks.ts).
- [Tools](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/realtime/realtimeClientTools.ts).
- [Context formatters](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/realtime/hooks/contextFormatters.ts).
- [prompt](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/realtime/voiceSystemPrompt.ts).
- [Push source](https://github.com/slopus/happy/blob/main/packages/happy-server/sources/app/push/pushDispatch.ts).
- [Older note](https://github.com/slopus/happy/blob/main/docs/voice-architecture.md).
- [issue](https://github.com/slopus/happy/issues/1308) — public user report/request.

### Superwhisper

- [Changelog](https://superwhisper.com/changelog).
- [plans](https://superwhisper.com/docs/billing/plans).
- [Claude integration](https://superwhisper.com/claude-code).
- [Plugin README](https://github.com/superultrainc/superwhisper-claude-code).
- [Agent docs](https://superwhisper.com/docs/get-started/coding-agents).
- [hooks](https://github.com/superultrainc/superwhisper-claude-code/blob/main/hooks/hooks.json).
- [CLI/MCP](https://superwhisper.com/docs/get-started/cli).

### Conductor for iOS

- [App Store](https://apps.apple.com/us/app/conductor-build/id6791228564).
- [release](https://www.conductor.build/changelog).
- [pricing](https://www.conductor.build/pricing).
- [API](https://www.conductor.build/docs/api).
- [parallel agents](https://www.conductor.build/docs/concepts/parallel-agents).
- [security](https://www.conductor.build/docs/reference/security-and-permissions).
- [Cloud](https://www.conductor.build/docs/cloud).
- [Product](https://www.conductor.build/).

### Linear

- [Pricing](https://linear.app/pricing).
- [coding sessions](https://linear.app/docs/coding-sessions).
- [Linear Agent](https://linear.app/docs/linear-agent).
- [Best practices](https://linear.app/developers/agent-best-practices).
- [Interaction](https://linear.app/developers/agent-interaction).
- [signals](https://linear.app/developers/agent-signals).
- [Mobile changelog](https://linear.app/changelog/page/3).
- [agents](https://linear.app/docs/agents-in-linear).
- [Interaction guidelines](https://linear.app/developers/aig).

### Jira, Rovo Dev, and Jira Coding Agent

- [Coding Agent](https://support.atlassian.com/jira-software-cloud/docs/what-is-the-jira-coding-agent/).
- [licensing FAQ](https://www.atlassian.com/licensing/rovo-dev).
- [Sessions](https://support.atlassian.com/jira-software-cloud/docs/view-and-manage-agent-sessions-in-jira/).
- [dashboard](https://support.atlassian.com/jira-software-cloud/docs/use-the-agents-dashboard/).
- [Generate code](https://support.atlassian.com/jira-software-cloud/docs/generate-code-from-a-work-item-in-jira/).
- [automation](https://support.atlassian.com/jira-software-cloud/docs/work-with-jira-coding-agent-in-automations/).
- [Workflow report](https://www.atlassian.com/blog/developer/120-prs-two-weeks-rovo-dev-in-jira).
- [Issue](https://jira.atlassian.com/browse/ROVO-941) — public user report/request.

### Omnara

- [Current product](https://www.omnara.com/).
- [archive notice](https://www.omnara.com/blog/mobile-coding-landscape).
- [App Store](https://apps.apple.com/us/app/omnara-claude-codex-mobile/id6748426727).
- [Introduction](https://docs.omnara.com/introduction).
- [Concepts](https://docs.omnara.com/concepts).
- [interaction source](https://github.com/omnara-ai/omnara/blob/main/docs/events/interactions.mdx).
- [permissions](https://docs.omnara.com/tools/permissions).
- [archived sandbox sync](https://www.omnara.com/blog/sandbox-sync).
- [unavailable voice URL](https://docs.omnara.com/voice) — unavailable when checked.

### Claude mobile with Claude Code

- [Remote Control](https://code.claude.com/docs/en/remote-control).
- [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging).
- [Voice mode](https://support.claude.com/en/articles/11101966-use-voice-mode).
- [Issue](https://github.com/anthropics/claude-code/issues/36439) — public user report/request.

### VoiceMode MCP

- [README](https://github.com/mbailey/voicemode).
- [license](https://github.com/mbailey/voicemode/blob/master/LICENSE).
- [release](https://github.com/mbailey/voicemode/releases/tag/v8.12.0).
- [Configuration](https://github.com/mbailey/voicemode/blob/master/docs/guides/configuration.md).
- [#521](https://github.com/mbailey/voicemode/issues/521) — public user report/request.
- [#522](https://github.com/mbailey/voicemode/issues/522) — public user report/request.

### Devin in Slack and voice mode

- [Pricing](https://devin.ai/pricing).
- [Slack](https://docs.devin.ai/integrations/slack).
- [voice](https://docs.devin.ai/work-with-devin/voice-mode).
- [security profiles](https://docs.devin.ai/product-guides/security-profiles).
- [Session tools](https://docs.devin.ai/work-with-devin/devin-session-tools).
- [Memory](https://docs.devin.ai/product-guides/memory).

### Codex through ChatGPT in Slack

- [Slack guide](https://learn.chatgpt.com/docs/third-party/slack).

### Claude Code in Slack and Claude Tag

- [Transition](https://code.claude.com/docs/en/slack).
- [Tag overview](https://claude.com/docs/claude-tag/overview).
- [How it works](https://claude.com/docs/claude-tag/concepts/how-it-works).
- [project tracking](https://claude.com/docs/claude-tag/users/use-cases/track-projects).
- [Response rules](https://claude.com/docs/claude-tag/users/when-claude-responds).
- [Claude Code comparison](https://claude.com/docs/claude-tag/concepts/for-claude-code-users).

### Cursor in Slack

- [Slack](https://prod.cursor.com/docs/integrations/slack).
- [run modes](https://prod.cursor.com/docs/agent/security/run-modes).
- [security](https://prod.cursor.com/docs/cloud-agent/security).

### GitHub Copilot issue assignment and mobile

- [Plans](https://docs.github.com/en/copilot/get-started/plans).
- [issue flow](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github).
- [GitHub surface](https://docs.github.com/en/copilot/concepts/copilot-surfaces/copilot-on-github).
- [Tracking](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents).
- [Change](https://github.blog/changelog/2026-03-13-optionally-skip-approval-for-copilot-coding-agent-actions-workflows/).
- [responsible use](https://docs.github.com/en/copilot/responsible-use/agents).
- [Mobile](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-mobile).

### Wispr Flow

- [Coding use](https://wisprflow.ai/use-cases/cursor).
- [pricing](https://wisprflow.ai/pricing).
- [command mode](https://docs.wisprflow.ai/articles/4816967992-how-to-use-command-mode).
- [MCP](https://docs.wisprflow.ai/articles/9551372685-connect-an-mcp-client-to-wispr-flow-remote-mcp-server).

### Talon for coding

- [Product](https://talonvoice.com/).
- [EULA](https://talonvoice.com/EULA.txt).
- [changelog](https://talonvoice.com/dl/latest/changelog.html).
- [reference](https://talonvoice.com/docs/reference/official.html).
- [Language guide](https://talonvoice.com/docs/reference/guide.language.html).

### Sotto context

- [Sotto brief](../../AGENTS.md).
- [Sotto vocabulary](../../CONTEXT.md).
