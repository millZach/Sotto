# Threads workspace discussion

Status: requirements and final behavior defaults approved by Zach on 2026-09-12. The interview is complete. The approved [implementation plan](plans/2026-09-12-threads-workspace.md) has been published as 31 GitHub tickets in six dependency phases under the [Threads workspace milestone](https://github.com/millZach/Sotto/milestone/1). Publication and native dependencies are verified. Implementation has not begun as part of ticket publication.

## Confirmed direction

- The target is a custom T3-like daily workspace, with Sotto branding, voice, memory and an independent coordinator. Existing provider/coordinator separation remains.
- Start a new project or a new thread inside an existing project, then prompt the agent.
- Project folders contain multiple threads, as in the supplied Codex screenshot. Both completed threads and inactive projects can be settled.
- Rich conversation information like T3, with ChatGPT-style diagrams and detail. Accepted activity presentation: compact live feed with current action, elapsed time, available token counts and subagent status; expandable commands, results and file changes. Answers support formatted text, tables and rendered diagrams with zoom and copy. Custom activity animations are optional, not a requirement.
- A side panel provides working surfaces. The supplied T3 reference shows Browser, Terminal, Files, Diff, Pull request and Agents. Browser, terminal and built-in Git are frequently used and essential to the intended experience.
- Drag threads from the sidebar into the workspace. One fills the area; two split it evenly side by side; three place the third across the full row below the first two; four form a 2-by-2 grid. Dividers are adjustable and users can choose a single-row arrangement. The accepted recommendation allows threads from different projects, with a shared tools panel following the focused thread and a pin option. Beyond four panes, narrow-window behavior and layout persistence remain to refine.
- Agent links open in the user's default external browser by default. An app setting can change the default destination, and either destination remains available for individual links.
- Use recognizable provider icons. Theme controls provide light, dark and system modes plus an accent-color choice, preserving Sotto typography and layout.
- A dedicated Sotto area uses the configured coordinator without requiring a project, with separate saved conversations and a New chat action. It supports typing, dictation and live voice. Memory persists across conversations while each conversation retains its own context. No automatic chat-to-project transfer or new orchestration harness: the user decides what to do after brainstorming. A “Turn this chat into a prompt” button may generate editable/copyable text using a specific, well-tested format; it must not create, route or launch project work automatically.
- Show compact live token activity, estimated thread cost, context usage near the composer, and a compaction recommendation. Detailed usage reporting is a lower priority. Estimates must be distinguished from actual provider billing and unavailable measurements.
- Enter sends the message; Shift+Enter inserts a newline. Preserve standard IME composition behavior.
- Follow T3's provider boundary: a started conversation stays with its provider. Cross-provider continuation is out of this redesign's scope. Same-provider model changes remain subject to native capabilities; T3's empty, unstarted thread can choose another provider.
- Messages submitted during a running turn queue by default; offer a separate explicit “Steer now” action. Provider support and queued-message editing/cancellation behavior must be defined.
- Independent tasks use separate Git worktrees, with an explicit shared-working-copy option for threads collaborating on the same changes.
- Skills scope is browse/select/invoke only: `/` or `$` opens the selected provider's available global and project skills. No separate skill creation, editing, installation or management UI. Preserve the native agent's normal skill access in both personal chat and project threads; do not invent a distinct Sotto-only skill whitelist. Availability still depends on the provider's own enabled/invocable catalog and current directory, not ACP transport alone.
- Settled threads appear in the Settled section and can be unsettled back into their owning project. Settling a whole project moves the project and its thread group into Settled; restoring it returns the same folder and threads, preserving which individual threads were already settled.
- Compaction must match T3's existing policy, native strategy and recommendation behavior. Exact predicates are verified below. No independent Sotto compaction strategy.
- Preserve the existing memory and authority model: retrieve relevant thread/project/global preferences without granting authority from memory. Existing explicit Manage, Pause managing and Stop managing controls remain the baseline; ordinary manual threads do not become supervised implicitly.

## Reference evidence

- Supplied screenshots: T3 conversation beside a right-side surface chooser; Codex project folders with nested thread entries.
- Inspected T3 checkout: `.claude/tmp/t3-reference-24` in the main workspace, commit `d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3`. Started conversations are locked to the original provider driver; compatible same-driver session continuation is supported. This proves behavior, not the maintainers' motivation.
- Verified T3 transport boundary: Codex uses native App Server over stdio (`CodexSessionRuntime.ts:1344`); Claude uses `@anthropic-ai/claude-agent-sdk` and its native Claude Code executable (`ClaudeAdapter.ts:14,4717`); Grok uses ACP over stdio (`acp/GrokAcpSupport.ts:71`). T3's common ProviderAdapter interface is not the ACP wire protocol. Current Sotto likewise uses native App Server for Codex and ACP for Grok, but directly manages Claude's streaming CLI rather than using T3's SDK integration. Do not describe all providers as ACP or claim identical integration implementations.
- Herdr's [concepts](https://herdr.dev/docs/concepts/) and [quick start](https://herdr.dev/docs/quick-start/) describe project workspaces, tabs, splittable panes and resizable borders. Sotto's requested equivalent is multiple graphical thread views, not a literal copy of terminal panes.
- Current Sotto gaps found in source include plain paragraph transcripts, limited activity events, missing browser/terminal/Git review surfaces and manual unsent drafts held only in renderer state.
- Follow-up source inspection: T3 uses provider-specific resume state and routes active tools, approvals, interruption and conversation rollback through the bound session. A visible-text handoff can seed another session, but cannot transfer those live continuations. Keeping one visible thread across different provider sessions is a possible new application feature, not a direct native-session resume. The maintainers' intent has not been established from a statement by them.
- Current Sotto coordinator is command intake: its reasoner receives a system instruction and structured current input and produces a constrained intent/decision. Clarifications and operation logs do not constitute a persistent conversational transcript. The requested personal chat needs its own durable conversation model.
- Skills follow-up: T3 provides a searchable, provider/workspace-scoped skills catalog and inserts skill mentions; invocation handling differs across native providers. Sotto currently passes raw prompt text without a skill catalog or structured skill selection. T3's inspected web sources have rich Markdown and highlighted code blocks but no Mermaid renderer was found; Sotto currently renders plain paragraphs. Provider-native availability must be distinguished from a uniform app picker.
- [ACP slash-command documentation](https://agentclientprotocol.com/protocol/v1/slash-commands) specifies optional agent-advertised available commands and invocation through regular prompts. It does not itself discover or enable every skill for the provider.
- T3 compaction source follow-up: the proactive banner is Claude-only, at least 100,000 used tokens and at least 70 minutes since the latest context-window update (`ContextWindowMeter.logic.ts`). This is an age/size heuristic, not a measured cache-expiry or billing check. It offers Compact or Keep full history. A separate native Claude resume-return prompt offers Compact and continue, Keep full history and Don't ask again. Preserve native auto-compaction defaults.

## Decision tree

1. Conversation/session identity — provider lock and dedicated coordinator chat settled. Automatic project promotion rejected; optional prompt-generation action only. Preserve existing scoped memory and explicit management authority.
2. Workspace — project/thread hierarchy, initial pane layouts, shared/pinnable tools panel, worktree isolation, individual thread settlement and whole-project settlement are settled. Layout persistence and narrow-window behavior are implementation defaults for final review.
3. Conversation experience — diagrams/details, activity feed, queued send with explicit steering settled. Native skill browsing/invocation only, no skill manager. Compaction delegates to the exact T3/native behavior; source verification is recorded above.
4. Personal agent — normal provider skills, separate saved personal chats and shared scoped memory are settled; no new custom workflow harness. Prompt-output format is proposed below for final review.
5. Supporting behavior — external-browser default with configurable destination, light/dark/system themes and accent color are settled. Queued-message controls, usage measurement and recovery details use reference behavior and explicit reviewable defaults below.

## Approved implementation defaults

Zach approved these defaults with the final behavior check.

- Prompt-generation format: objective; relevant context and decisions; constraints and non-goals; requested deliverables; acceptance checks; unresolved questions. Omit empty sections. Preserve the user's latest corrections, distinguish decisions from suggestions and do not invent requirements. Output is editable/copyable text only. Evaluate the format against representative brainstorming conversations, including changed decisions, missing details and conflicting constraints, before calling it tested.
- Persist per-thread unsent drafts, queued messages and workspace pane arrangement across restart. Queued messages can be edited or removed before submission; delivery state must distinguish queued, submitting, accepted and failed without silently resending uncertain submissions.
- Preserve existing provider permissions and explicit supervision controls. Closing a pane affects the view, not execution; changing focus must not lose terminal sessions or browser state.
- Keep panes readable at smaller window sizes: offer a focused/zoomed pane while preserving the multi-pane arrangement for return. Avoid shrinking every composer and tools surface until controls become unusable. Additional panes can extend the layout; the documented one-through-four arrangements are defaults, not an implicit hard limit.

## Completed prerequisite

Agents settings were moved inline immediately below Providers by a subagent, committed locally as `52f1f42`, and verified in the visible development renderer. The later interview settled the provider boundary in favor of T3's behavior.
