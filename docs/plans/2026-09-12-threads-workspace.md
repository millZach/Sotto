# Threads workspace implementation plan

Status: approved and published on GitHub in six dependency phases, 2026-09-12. All 31 issues and native blocking relationships have been read back and verified. [Workspace milestone](https://github.com/millZach/Sotto/milestone/1). Implementation has not begun as part of this publication task.

## Published phases

[All tickets and phase roadmap](https://github.com/millZach/Sotto/milestone/1). Each phase is an earliest dependency wave. Tickets within it can run in parallel, and a later-phase ticket can start immediately when its own blockers close. Do not wait for unrelated earlier-phase tickets. Native dependencies are the execution gate.

### Phase 1 — 4 tickets

- [#44 — Send messages immediately and restore per-thread drafts](https://github.com/millZach/Sotto/issues/44)
- [#45 — Organize projects and settle threads or whole projects](https://github.com/millZach/Sotto/issues/45)
- [#46 — Render readable answers and attachment previews](https://github.com/millZach/Sotto/issues/46)
- [#73 — Choose light, dark or system appearance and an accent](https://github.com/millZach/Sotto/issues/73)

### Phase 2 — 7 tickets

- [#47 — Render and inspect diagrams in answers](https://github.com/millZach/Sotto/issues/47)
- [#48 — Follow Codex tool activity and subagents](https://github.com/millZach/Sotto/issues/48)
- [#51 — Queue follow-up messages and explicitly steer a running turn](https://github.com/millZach/Sotto/issues/51)
- [#53 — Drag a second thread into a split workspace](https://github.com/millZach/Sotto/issues/53)
- [#55 — Browse files in a shared, pinnable tools panel](https://github.com/millZach/Sotto/issues/55)
- [#58 — Create independent thread worktrees](https://github.com/millZach/Sotto/issues/58)
- [#63 — Browse and invoke Codex skills](https://github.com/millZach/Sotto/issues/63)

### Phase 3 — 10 tickets

- [#49 — Follow Claude tool activity and subagents](https://github.com/millZach/Sotto/issues/49)
- [#50 — Follow Grok tool activity and subagents](https://github.com/millZach/Sotto/issues/50)
- [#52 — Answer structured questions and approvals in the right thread](https://github.com/millZach/Sotto/issues/52)
- [#54 — Add three- and four-thread layouts and restore the workspace](https://github.com/millZach/Sotto/issues/54)
- [#56 — Run a persistent terminal beside a thread](https://github.com/millZach/Sotto/issues/56)
- [#57 — Browse inside Sotto and choose where links open](https://github.com/millZach/Sotto/issues/57)
- [#59 — Review Git changes in the selected thread](https://github.com/millZach/Sotto/issues/59)
- [#64 — Browse and invoke Claude skills](https://github.com/millZach/Sotto/issues/64)
- [#65 — Browse and invoke Grok skills](https://github.com/millZach/Sotto/issues/65)
- [#68 — Start and resume a project-free Sotto chat with Codex](https://github.com/millZach/Sotto/issues/68)

### Phase 4 — 6 tickets

- [#60 — Stage, commit and manage the active branch](https://github.com/millZach/Sotto/issues/60)
- [#62 — Inspect checkpoints and perform supported thread reverts](https://github.com/millZach/Sotto/issues/62)
- [#66 — Show live tokens, context and estimated thread cost](https://github.com/millZach/Sotto/issues/66)
- [#69 — Use Claude for persistent Sotto chats](https://github.com/millZach/Sotto/issues/69)
- [#70 — Use Grok for persistent Sotto chats](https://github.com/millZach/Sotto/issues/70)
- [#72 — Turn a brainstorming chat into an editable prompt](https://github.com/millZach/Sotto/issues/72)

### Phase 5 — 3 tickets

- [#61 — Push work and open the pull-request surface](https://github.com/millZach/Sotto/issues/61)
- [#67 — Match T3's native compaction behavior](https://github.com/millZach/Sotto/issues/67)
- [#71 — Talk and dictate in the active Sotto conversation](https://github.com/millZach/Sotto/issues/71)

### Phase 6 — 1 tickets

- [#74 — Verify the complete daily workspace and recovery journey](https://github.com/millZach/Sotto/issues/74)

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

## Approved implementation slices

Draft IDs below retain the approved plan numbering. GitHub issue numbers and native blocking links are authoritative. Local ticket files mirror the published behavior and acceptance criteria.

| Draft | GitHub ticket | Phase | Blocked by GitHub issues | Demoable outcome |
|---|---|---|---|---|
| 01 | [#44 — Send messages immediately and restore per-thread drafts](https://github.com/millZach/Sotto/issues/44) | 1 | None | Typing in any thread gives immediate, truthful delivery feedback and each thread keeps its own unsent draft. |
| 02 | [#45 — Organize projects and settle threads or whole projects](https://github.com/millZach/Sotto/issues/45) | 1 | None | Navigate project folders containing multiple threads, with recognizable provider icons and reversible Settled groups. |
| 03 | [#46 — Render readable answers and attachment previews](https://github.com/millZach/Sotto/issues/46) | 1 | None | Read rich, streaming answers with usable code, tables, links and attachments in the existing Threads view. |
| 04 | [#47 — Render and inspect diagrams in answers](https://github.com/millZach/Sotto/issues/47) | 2 | #46 | Agent-generated Mermaid diagrams render inside answers and can be enlarged and copied. |
| 05 | [#48 — Follow Codex tool activity and subagents](https://github.com/millZach/Sotto/issues/48) | 2 | #46 | See Codex's current work and expandable tool results alongside readable answers. |
| 06 | [#49 — Follow Claude tool activity and subagents](https://github.com/millZach/Sotto/issues/49) | 3 | #48 | Claude threads expose the same useful activity view through Claude's native event stream. |
| 07 | [#50 — Follow Grok tool activity and subagents](https://github.com/millZach/Sotto/issues/50) | 3 | #48 | Grok threads expose native ACP work through the shared activity view. |
| 08 | [#51 — Queue follow-up messages and explicitly steer a running turn](https://github.com/millZach/Sotto/issues/51) | 2 | #44 | Send another message while work is running, with a durable queue and an explicit Steer now action. |
| 09 | [#52 — Answer structured questions and approvals in the right thread](https://github.com/millZach/Sotto/issues/52) | 3 | #48 | Respond to complete native questions and approval requests while keeping their thread and tool context visible. |
| 10 | [#53 — Drag a second thread into a split workspace](https://github.com/millZach/Sotto/issues/53) | 2 | #44, #45 | Drag a thread from the sidebar beside the current thread and use both independently. |
| 11 | [#54 — Add three- and four-thread layouts and restore the workspace](https://github.com/millZach/Sotto/issues/54) | 3 | #53 | Arrange more threads with the agreed snapping rules and restore the arrangement after restart. |
| 12 | [#55 — Browse files in a shared, pinnable tools panel](https://github.com/millZach/Sotto/issues/55) | 2 | #45 | Open a Files surface beside a thread and inspect files in that thread's actual working directory. |
| 13 | [#56 — Run a persistent terminal beside a thread](https://github.com/millZach/Sotto/issues/56) | 3 | #55 | Open and use an interactive terminal in the active thread's working directory. |
| 14 | [#57 — Browse inside Sotto and choose where links open](https://github.com/millZach/Sotto/issues/57) | 3 | #55 | Use the embedded browser for local apps and URLs while ordinary agent links open externally by default. |
| 15 | [#58 — Create independent thread worktrees](https://github.com/millZach/Sotto/issues/58) | 2 | #45 | New independent coding tasks get their own working copy and branch, with an explicit shared-working-copy option. |
| 16 | [#59 — Review Git changes in the selected thread](https://github.com/millZach/Sotto/issues/59) | 3 | #55, #58 | Inspect current working changes and diffs from the thread's own branch and worktree. |
| 17 | [#60 — Stage, commit and manage the active branch](https://github.com/millZach/Sotto/issues/60) | 4 | #59 | Complete local Git work from Sotto using the selected thread's working copy. |
| 18 | [#61 — Push work and open the pull-request surface](https://github.com/millZach/Sotto/issues/61) | 5 | #60 | Push a branch, create/open its pull request and follow review/check status inside Sotto. |
| 19 | [#62 — Inspect checkpoints and perform supported thread reverts](https://github.com/millZach/Sotto/issues/62) | 4 | #48, #49, #50, #58, #59 | Review changes associated with completed work and explicitly revert when the native provider supports matching conversation rollback. |
| 20 | [#63 — Browse and invoke Codex skills](https://github.com/millZach/Sotto/issues/63) | 2 | #44 | Type / or $ to find and select Codex's available personal and project skills. |
| 21 | [#64 — Browse and invoke Claude skills](https://github.com/millZach/Sotto/issues/64) | 3 | #63 | Use the same picker for Claude's own global and project skills. |
| 22 | [#65 — Browse and invoke Grok skills](https://github.com/millZach/Sotto/issues/65) | 3 | #63 | Use the shared picker for the skills Grok actually exposes and can invoke. |
| 23 | [#66 — Show live tokens, context and estimated thread cost](https://github.com/millZach/Sotto/issues/66) | 4 | #48, #49, #50 | Read compact native usage indicators while working without opening a separate analytics dashboard. |
| 24 | [#67 — Match T3's native compaction behavior](https://github.com/millZach/Sotto/issues/67) | 5 | #66 | Use the provider's normal compaction strategy and T3's context recommendation and controls. |
| 25 | [#68 — Start and resume a project-free Sotto chat with Codex](https://github.com/millZach/Sotto/issues/68) | 3 | #44, #46, #63 | Open the Sotto area, start a saved conversation without a project and talk to the configured Codex coordinator with its normal skills. |
| 26 | [#69 — Use Claude for persistent Sotto chats](https://github.com/millZach/Sotto/issues/69) | 4 | #68, #64 | Start project-free Sotto conversations with the configured Claude coordinator and resume them later. |
| 27 | [#70 — Use Grok for persistent Sotto chats](https://github.com/millZach/Sotto/issues/70) | 4 | #68, #65 | Start and resume project-free Sotto conversations with Grok and its normal native skills. |
| 28 | [#71 — Talk and dictate in the active Sotto conversation](https://github.com/millZach/Sotto/issues/71) | 5 | #68, #69, #70 | Type, dictate or have a spoken exchange in the selected personal Sotto chat. |
| 29 | [#72 — Turn a brainstorming chat into an editable prompt](https://github.com/millZach/Sotto/issues/72) | 4 | #68 | Generate a useful prompt from a Sotto conversation for the user to copy and use themselves. |
| 30 | [#73 — Choose light, dark or system appearance and an accent](https://github.com/millZach/Sotto/issues/73) | 1 | None | Configure Sotto's appearance while retaining its typography, identity and readable native controls. |
| 31 | [#74 — Verify the complete daily workspace and recovery journey](https://github.com/millZach/Sotto/issues/74) | 6 | #47, #51, #52, #54, #56, #57, #61, #62, #67, #69, #70, #71, #72, #73, #24 | Demonstrate the complete agreed daily workflow with mixed providers, working tools and recoverable state. |

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

## Publication verification

The user approved the breakdown and requested parallel phases. Published 31 issues with ready-for-agent, threads-workspace and phase labels under the workspace milestone. Verified all issue bodies, titles, open state, labels, milestone membership and native blocking edges by reading GitHub back.

The phase-one frontier is [#44](https://github.com/millZach/Sotto/issues/44), [#45](https://github.com/millZach/Sotto/issues/45), [#46](https://github.com/millZach/Sotto/issues/46), [#73](https://github.com/millZach/Sotto/issues/73). Final acceptance [#74](https://github.com/millZach/Sotto/issues/74) also has a native dependency on existing #24. Existing parent issue bodies and states were not modified.

The published manifest and verification report retain draft-to-issue mappings and every native blocker. Local ticket files mirror the published issue contents. This publication does not claim implementation, code push, merge or release completion.
