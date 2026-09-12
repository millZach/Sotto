# Threads workspace implementation plan

Status: product specification and final behavior defaults approved by Zach on 2026-09-12. Ticket granularity/dependency review pending under the requested to-tickets skill. No new GitHub issues have been published for this batch.

## Outcome

Make Sotto a daily coding workspace: project folders with multiple native-provider threads; rich answers, diagrams and inspectable work; browser/terminal/files/Git tools; draggable thread panes; and independent project-free Sotto conversations with voice, memory and normal native skills. Preserve user control. The personal chat can produce an editable prompt, but does not become an automatic project-routing harness.

The approved [discussion and decisions](../threads-product-discussion.md) are the product source of truth. This plan turns them into complete, individually demoable slices rather than separate schema, API and renderer tickets.

## Baseline and existing issues

- Working baseline: branch `work/thread-providers` through local commit `52f1f42`, containing independent Codex/Claude/Grok providers and inline coordinator settings. This foundation is locally committed and verified; do not assume it has been pushed or merged.
- Existing [#24](https://github.com/millZach/Sotto/issues/24) tracks removal of the T3 host and delivery of native adapters. Reuse that work; do not rebuild or duplicate those adapter tickets. Initial slices can branch from the explicit integration baseline. The final delivery gate requires #24 to be completed and the foundation integrated.
- Existing [#32](https://github.com/millZach/Sotto/issues/32) still contains the older black-only Crossing direction. The user's newly approved light/dark/system plus accent settings supersede that product constraint. Keep Sotto typography, branding and unaffected dictation/widget behavior. Do not modify or close #32 as part of this ticket publication.
- [#38](https://github.com/millZach/Sotto/issues/38) Dictionary, [#25](https://github.com/millZach/Sotto/issues/25) history import, [#26](https://github.com/millZach/Sotto/issues/26) hybrid retrieval, [#27](https://github.com/millZach/Sotto/issues/27) memory bake-off, and [#18](https://github.com/millZach/Sotto/issues/18) voice instrumentation retain their existing scopes. Existing scoped memory and chosen MAI/Grok/Kokoro services are reused. This plan does not promise to close those issues or duplicate their work.
- T3 source reference is pinned at `d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3`. Read the relevant native adapter and user-flow source before implementing each comparable slice. T3 uses Codex App Server, Claude Agent SDK and Grok ACP, not ACP for all providers; transport uniformity is not a goal.

## Implementation approach

1. Deliver immediate usability in the existing app: send feedback/drafts, project navigation, readable answers and themes. These four independent roots can run in parallel.
2. Extend the current implementation additively. The first complete Codex activity slice creates the shared event/presentation seam; the first skill-picker slice creates the shared catalog/invocation seam. Claude and Grok then extend those complete paths independently. Do not publish a schema-only or UI-shell-only ticket.
3. Add a functional Files side panel first, then build terminal and browser surfaces on it. Develop Git worktrees in parallel; diff review then leads to local commit and PR workflows.
4. Establish two usable thread panes before adding three/four-pane snapping, saved layouts and focused views. Shared surfaces bind to actual thread working directories and may be pinned; focus never changes ownership of requests, drafts or processes.
5. Add project-free personal chat as a distinct durable conversation kind without weakening the existing project Thread binding. First land Codex end to end, then Claude and Grok, then conversational voice. Preserve normal native skills and the existing memory/permission boundaries. Update relevant glossary/ADRs within this feature, not via a speculative global rewrite.
6. Finish capability-aware context/usage/compaction and checkpoint workflows; run a final real daily-work/recovery journey across the combined app. Continuous slice-level testing and visual inspection remain required; final integration is not the first time features are tested.

Each issue should fit a fresh implementation context. A provider-specific mapping, a concrete user surface or one recoverable interaction is a slice. If implementation reveals that a ticket exceeds this bound, split along another complete user path before starting a broad refactor. Local prefactoring belongs at the beginning of the slice that needs it, preserving the existing working path.

## Proposed tickets

Numbers below are draft IDs, not GitHub issue numbers. Every linked draft contains the complete behavior, checkbox acceptance criteria and blocker list.

| Draft | Ticket | Blocked by draft | Demoable outcome |
|---|---|---|---|
| 01 | [Send messages immediately and restore per-thread drafts](threads-workspace/tickets/01.md) | None | Typing in any thread gives immediate, truthful delivery feedback and each thread keeps its own unsent draft. |
| 02 | [Organize projects and settle threads or whole projects](threads-workspace/tickets/02.md) | None | Navigate project folders containing multiple threads, with recognizable provider icons and reversible Settled groups. |
| 03 | [Render readable answers and attachment previews](threads-workspace/tickets/03.md) | None | Read rich, streaming answers with usable code, tables, links and attachments in the existing Threads view. |
| 04 | [Render and inspect diagrams in answers](threads-workspace/tickets/04.md) | 03 | Agent-generated Mermaid diagrams render inside answers and can be enlarged and copied. |
| 05 | [Follow Codex tool activity and subagents](threads-workspace/tickets/05.md) | 03 | See Codex's current work and expandable tool results alongside readable answers. |
| 06 | [Follow Claude tool activity and subagents](threads-workspace/tickets/06.md) | 05 | Claude threads expose the same useful activity view through Claude's native event stream. |
| 07 | [Follow Grok tool activity and subagents](threads-workspace/tickets/07.md) | 05 | Grok threads expose native ACP work through the shared activity view. |
| 08 | [Queue follow-up messages and explicitly steer a running turn](threads-workspace/tickets/08.md) | 01 | Send another message while work is running, with a durable queue and an explicit Steer now action. |
| 09 | [Answer structured questions and approvals in the right thread](threads-workspace/tickets/09.md) | 05 | Respond to complete native questions and approval requests while keeping their thread and tool context visible. |
| 10 | [Drag a second thread into a split workspace](threads-workspace/tickets/10.md) | 01, 02 | Drag a thread from the sidebar beside the current thread and use both independently. |
| 11 | [Add three- and four-thread layouts and restore the workspace](threads-workspace/tickets/11.md) | 10 | Arrange more threads with the agreed snapping rules and restore the arrangement after restart. |
| 12 | [Browse files in a shared, pinnable tools panel](threads-workspace/tickets/12.md) | 02 | Open a Files surface beside a thread and inspect files in that thread's actual working directory. |
| 13 | [Run a persistent terminal beside a thread](threads-workspace/tickets/13.md) | 12 | Open and use an interactive terminal in the active thread's working directory. |
| 14 | [Browse inside Sotto and choose where links open](threads-workspace/tickets/14.md) | 12 | Use the embedded browser for local apps and URLs while ordinary agent links open externally by default. |
| 15 | [Create independent thread worktrees](threads-workspace/tickets/15.md) | 02 | New independent coding tasks get their own working copy and branch, with an explicit shared-working-copy option. |
| 16 | [Review Git changes in the selected thread](threads-workspace/tickets/16.md) | 12, 15 | Inspect current working changes and diffs from the thread's own branch and worktree. |
| 17 | [Stage, commit and manage the active branch](threads-workspace/tickets/17.md) | 16 | Complete local Git work from Sotto using the selected thread's working copy. |
| 18 | [Push work and open the pull-request surface](threads-workspace/tickets/18.md) | 17 | Push a branch, create/open its pull request and follow review/check status inside Sotto. |
| 19 | [Inspect checkpoints and perform supported thread reverts](threads-workspace/tickets/19.md) | 05, 06, 07, 15, 16 | Review changes associated with completed work and explicitly revert when the native provider supports matching conversation rollback. |
| 20 | [Browse and invoke Codex skills](threads-workspace/tickets/20.md) | 01 | Type / or $ to find and select Codex's available personal and project skills. |
| 21 | [Browse and invoke Claude skills](threads-workspace/tickets/21.md) | 20 | Use the same picker for Claude's own global and project skills. |
| 22 | [Browse and invoke Grok skills](threads-workspace/tickets/22.md) | 20 | Use the shared picker for the skills Grok actually exposes and can invoke. |
| 23 | [Show live tokens, context and estimated thread cost](threads-workspace/tickets/23.md) | 05, 06, 07 | Read compact native usage indicators while working without opening a separate analytics dashboard. |
| 24 | [Match T3's native compaction behavior](threads-workspace/tickets/24.md) | 23 | Use the provider's normal compaction strategy and T3's context recommendation and controls. |
| 25 | [Start and resume a project-free Sotto chat with Codex](threads-workspace/tickets/25.md) | 01, 03, 20 | Open the Sotto area, start a saved conversation without a project and talk to the configured Codex coordinator with its normal skills. |
| 26 | [Use Claude for persistent Sotto chats](threads-workspace/tickets/26.md) | 25, 21 | Start project-free Sotto conversations with the configured Claude coordinator and resume them later. |
| 27 | [Use Grok for persistent Sotto chats](threads-workspace/tickets/27.md) | 25, 22 | Start and resume project-free Sotto conversations with Grok and its normal native skills. |
| 28 | [Talk and dictate in the active Sotto conversation](threads-workspace/tickets/28.md) | 25, 26, 27 | Type, dictate or have a spoken exchange in the selected personal Sotto chat. |
| 29 | [Turn a brainstorming chat into an editable prompt](threads-workspace/tickets/29.md) | 25 | Generate a useful prompt from a Sotto conversation for the user to copy and use themselves. |
| 30 | [Choose light, dark or system appearance and an accent](threads-workspace/tickets/30.md) | None | Configure Sotto's appearance while retaining its typography, identity and readable native controls. |
| 31 | [Verify the complete daily workspace and recovery journey](threads-workspace/tickets/31.md) | 04, 08, 09, 11, 13, 14, 18, 19, 24, 26, 27, 28, 29, 30; existing #24 (delivery) | Demonstrate the complete agreed daily workflow with mixed providers, working tools and recoverable state. |

## Parallel work and merge discipline

- Initial frontier: **01, 02, 03, 30**. Separate worktrees branch from the agreed integration baseline; preserve its existing changes.
- After 02: Files panel (12) and worktrees (15) are independent. Once 01 also lands, two-pane work (10) can start.
- After 03: diagrams (04) and Codex activity (05) are independent. After 05: Claude activity (06), Grok activity (07) and structured requests (09) are independent.
- After 01: queued sends/steering (08) and Codex skills (20) can start independently. After 20: Claude skills (21) and Grok skills (22) can proceed independently.
- After 12: terminal (13) and browser (14) are independent; diff review (16) also needs actual worktree binding (15).
- Personal chat begins once 01, 03 and 20 land. Claude/Grok chat then proceed independently once their respective skills path exists; prompt generation can proceed alongside them. Voice follows native chat parity.
- Shared-file contention is coordination, not a fake dependency. Reserve shared composer, activity, settings and side-panel boundaries while others work in provider adapters or feature modules. Merge completed seams before dependent branches start. Follow the repository's applicable subagent routing and design-skill requirements when implementation begins.

## Cross-cutting acceptance

- Preserve Sotto thread IDs, provider binding, project memory scopes, explicit supervision/policy authority, disconnected history and uncertain-action reconciliation. No silent native-thread migration or retry that duplicates a send.
- The agreed provider lock applies once a conversation starts. Existing-thread model choices honor actual native capabilities; an empty draft can choose any ready provider. The configured coordinator and thread providers remain independent.
- UI acceptance means rendered Windows verification at normal and minimum sizes, keyboard use, readable controls and long-history behavior. Test all supported themes once the theme slice lands. New captures supplement actual journey inspection rather than replacing it.
- Use focused unit/integration tests for ownership, persistence, transitions and protocol behavior; mock Electron journeys for repeatability; bounded native-client checks for claims about native skills, steering, compaction and resume. Do not infer support from successful text transport.
- Measure local input acknowledgement, provider acceptance, streamed output and voice timing separately. A slow provider is not an excuse for an unresponsive composer. The send-feedback target is 100 ms on the documented Windows fixture; report observed native latency without promising network-dependent response times.
- Native compaction must match the pinned T3 capability/predicate/dismissal behavior, including the Claude-only 100,000-token/70-minute suggestion. Do not infer cache expiry or charge savings from inactivity alone.
- Preserve default external-browser links with configurable destination. Native/global/project skills are browse/invoke only. Native usage may be unavailable; estimates must never be presented as actual subscription charges.

## Explicit exclusions

No cross-provider conversation transfer; no skill CRUD/install interface; no automatic personal-chat-to-project handoff; no new custom skill/compaction/orchestration engine; no dictation-model or voice-model bake-off; no detailed usage dashboard; no unrelated Dictionary, import, licensing or hybrid-retrieval expansion. Custom activity animations are optional polish after the required experience works.

## Publication procedure

The requested to-tickets skill requires review of the proposed breakdown and blocking edges before publication. After Zach approves or revises this list:

1. Publish one GitHub issue per approved slice in dependency order, using the ready-for-agent label and the complete draft body with the agreed baseline context.
2. Replace every draft dependency with its real issue number and attach GitHub's native blocked-by relationship using database issue IDs. Final delivery also depends on existing #24. Use text blockers only if native dependencies are unavailable.
3. Read back all issues and native edges; validate count, labels, acyclic dependencies and acceptance coverage. Record real URLs in this plan and the batch manifest.
4. Do not close or modify existing parent issues. Do not create a speculative new parent or begin implementation as part of ticket publication.

Current deliverables: this plan, 31 individual issue drafts and a machine-readable batch manifest. Publication is pending the skill's breakdown review, not GitHub access or authorization to prepare the work.

