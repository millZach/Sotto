# Phase 3 native providers verification

Date: 2026-09-13. Branch: `work/phase3-providers`, based on `bf500b4` (ancestor verified). Backend/native scope for #49, #50, #52, #64 and #65. No renderer/design edits, dependency installation, push, or external comments. No additional agents were spawned.

## Delivered checks

- [x] Claude streaming CLI retained. Native tool starts/results, shell commands, file operations, parent tool references and task lifecycle project into the existing bounded, ordered activity rail.
- [x] Grok ACP tool snapshots/results, command exit codes, file diffs and reported subagent attempts project into that same rail. Unknown fields stay absent. No provider child address becomes a thread binding.
- [x] Stable anchors across native history reconstruction; replay upserts do not repeat output or native execution. Empty Claude tool-only messages cannot own anchors. Grok uses native prompt/stream metadata because its durable history coalesces streamed message chunks, and separates narration around tools.
- [x] All tool-request question items, native IDs, options/descriptions/previews, supported multiselect and free-text answers reach the backend. Codex string MCP elicitation fields are also exposed individually. Legacy answer strings remain supported.
- [x] Approval choices map to exact original native payloads. One-time boolean answers never silently widen to remembered grants. Explicit selected native session/rule/profile choices keep their original scope and payload. Grok does not copy T3's fallback from absent `allow_always` to `allow_once`.
- [x] Answer reservations are persisted before Claude/Grok writes; concurrent submissions and reappearing answered requests cannot replay a decision. Validation/save errors leave a request answerable; uncertain writes retain its context and mark delivery uncertain. Grok public request identity uses the bound thread and native tool request, not reconnect-reused RPC counters. Existing coordinator outbox and policy guards remain in place.
- [x] Claude discovery uses its own `initialize.commands` catalog under the same environment and cwd as the provider. Native configuration, duplicate-name precedence, plugin loading, enabled flags and user-invocability are resolved by Claude itself. Omitted metadata is not invented.
- [x] Grok discovery uses installed `inspect --json`; personal/project/plugin/bundled provenance and native enabled/invocable fields are retained. Discovery errors are not successful empty catalogs.
- [x] Selected skills are freshly validated against the owning thread's actual working copy before native creation/dispatch. Both adapters support one guaranteed selected slash invocation per message; multiple selections fail before dispatch. Manual slash invocations pass through the native protocol. No skill body is expanded by Sotto.
- [x] Native Grok effort-confirmation race fixed: a `set_model` response may precede `model_changed`; read the existing native session's model state before confirming the requested effort. This never sends a model prompt.
- [x] Focused regressions, typecheck and native smoke checks below completed. UI, keyboard accessibility, combined workspace rendering and the final full suite remain with the integrator/UI owner.

## Contracts and ownership

Early contract note: `D:/Talk to Text Application/.worktrees/phase3-orchestration/providers-contract.md`.

`AgentRequest` adds `questions`, `permissionChoices`, `context`, and uncertain `delivery`. `answer` adds `questionAnswers` and `permissionChoice`. Shared schemas keep old saved state valid. Native adapter aliases add default-empty answered-request identity lists, containing no answer contents.

`AgentSkillCatalog.providerId` supports all three providers. Skills may expose `enabled`, `userInvocable`, `userInvocationOnly`, `invocation`, and `nativeSource`. Claude native catalog paths are opaque cwd/name identities, not filesystem paths; the handshake does not expose physical paths or disabled entries. Grok source paths come from its own catalog. Existing name/path references and draft/send shapes remain valid.

The only `codex.ts` edit forwards the two additive answer fields to `answerRequest`. Codex request normalization lives in `codexRequests.ts`; personal-chat code is untouched. Shared wiring changes are confined to `agents.ts`, `agentActivity.ts`, `agentSkills.ts`, `host.ts`, `control.ts` and `workspace.ts`. Existing thread/provider wrappers already forward these additive contracts correctly.

## Reference and protocol evidence

Read CLAUDE.md, CONTEXT.md, ADRs 0002–0005/0007/0008, the approved workspace plan/discussion, tickets 06/07/09/21/22, and fetched GitHub issues #49/#50/#52/#64/#65 with `gh issue view`.

T3 reference: main repository `.claude/tmp/t3-reference-24`, pinned `d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3`. Inspected `ClaudeAdapter.ts`, `GrokAdapter.ts`, `ClaudeSkills.ts`, `ClaudeSkillDispatch.ts`, `GrokSkills.ts`, `GrokAcpSupport.ts` and the generated Codex protocol types. T3's SDK choice is not needed for these Claude capabilities: the installed streaming CLI proved catalog discovery, slash expansion and native tool history directly.

Primary sources checked alongside installed-client behavior:

- [Claude skills documentation](https://code.claude.com/docs/en/skills) for native discovery, invocability and slash behavior.
- [Grok skills documentation](https://docs.x.ai/build/features/skills-plugins-marketplaces) and [ACP/headless documentation](https://docs.x.ai/build/cli/headless-scripting).
- [Grok native notification source](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-grok-shell/src/extensions/notification.rs), [question protocol](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-grok-tools/src/implementations/grok_build/ask_user_question/types.rs), and [native skill discovery](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-grok-shell/src/extensions/skills.rs). This public source is supporting protocol evidence, not a claim that its source revision equals the installed binary.

## Installed-client smoke evidence

Installed: Claude Code **2.1.270**; Grok **1.0.5 (5115b46bc9)** / ACP **1**. All work used temporary synthetic folders; native credentials and global settings were not modified. Tool commands were bounded marker echoes. No native subagents were spawned.

| Probe | Actual model / model calls | Result |
| --- | --- | --- |
| Claude selected skill + manual slash, first run | `claude-haiku-4-5-20251001`, 3 calls across 2 user turns | Both returned a random token stored only inside SKILL.md; Bash output observed. Found the empty-message anchor defect. |
| Claude same journey after fix | Same model, 3 calls across 2 user turns | Both expansions and Bash result passed. Native transcript reload preserved activity semantically. A JSON property-order comparison initially reported false; a zero-call deep-equality reread confirmed exact field equality. |
| Claude isolated configured-home/worktree catalog | No model calls; 3 initialization probes | User duplicate precedence, YAML `user-invocable: no`, disabled override, manual-only skill, real Git worktree-only skill and refreshed local settings passed. |
| Grok raw ACP slash expansion | `grok-4.6-build` (requested `grok-4.6`), 1 reported model call | Returned a random marker present only in SKILL.md, with no tool/file reads. This proves native expansion, not merely text transport. |
| Grok adapter selected + manual skill, first run | Same model, native usage reported 2 + 1 calls | Expansion, echo command and output passed. Found native coalesced-history anchor defect. |
| Grok adapter journey after fix | Same model, native usage reported 2 + 1 calls | Exact message/activity equality after reconnect passed, including command exit code 0. |
| Grok explicit effort setup | No model calls | Initial adapter attempt exposed response-before-event ordering. After regression/fix, native `low` effort was confirmed by the owned session's returned state. |

**Total paid model calls in this work: Claude 6 + Grok 7 = 13**, across 4 Claude and 5 Grok user turns. Metadata/catalog/reload/setup probes sent no model prompts. Claude counts use distinct native assistant message IDs/model fields in its synthetic transcript; Grok counts use native `turn_completed.usage.modelCalls`, not estimates or user-turn counts.

Local synthetic evidence roots (not committed; contain only this verification's synthetic prompts/results):

- Claude first: `%TEMP%/sotto-phase3-claude-SvFsog`; final: `%TEMP%/sotto-phase3-claude-uzjN7A`.
- Claude catalog: `%TEMP%/sotto-phase3-catalog-AjXkmT`.
- Grok raw expansion: `%TEMP%/sotto-phase3-grok-wJxAPa`.
- Grok adapter first: `%TEMP%/sotto-phase3-grok-adapter-zK9ImO`; final: `%TEMP%/sotto-phase3-grok-adapter-ZaybC1`.

Reproduction entry points: `tests/fixtures/phase3NativeProbe.ts` (explicit `SOTTO_PHASE3_NATIVE` modes), `nativeProviderCatalogsLive.test.ts` (`SOTTO_PHASE3_CATALOG_LIVE=1`), and `nativeProviderGrokLive.test.ts` (`SOTTO_PHASE3_GROK_LIVE=1`). Paid probes are opt-in and excluded from normal runs.

## Focused tests

Regressions were first observed failing at adapter/request boundaries, then fixed: missing projectors/contracts, terminal ACP arrays dropped by the old parser, Claude empty-message anchoring, Grok coalesced stream identities, native approval payloads and delayed effort confirmation. Single relevant files and typecheck were run throughout.

Final focused batch: **14 files / 136 tests passed**: Claude shared contract/safety, Grok shared contract/failures, native provider activity/skills/requests, native activity/request/skill units, Codex host/skills, workspace skill routing and shared activity merging. After final bounds/timestamp and late-subagent-completion refinements, **8 activity tests in 2 files passed**. Final catalog-error and multiple-selection checks: **6 skill tests in 2 files passed**. `npm run typecheck` passes (both node and web projects). Scoped ESLint passes for all changed production provider/request/shared files.

No full test suite was run; that gate belongs to the integrator. No rendered UI claim is made.

## Limits kept explicit

- Claude's native catalog only advertises currently user-invocable commands; disabled/non-invocable physical files and unavailable source-path/flag details are not fabricated. Grok exposes its richer native source metadata. A catalog probe is not a model call or an invocation.
- One selected skill per message is guaranteed. Additional manually written mentions follow the provider's native behavior; no claim is made that every mention expands. Multiple selected skills are rejected before dispatch.
- Native child-tool/private reasoning streams not present on the owning thread's supported history channel are not invented or promoted to main-thread messages. Subagent lifecycle mapping is supported by inspected native source and fixtures; a live subagent run was deliberately not performed under the no-more-agents instruction. Stream-only observations rely on the existing workspace history cache when enabled.
- Codex MCP elicitation retains the existing string-field validator. Unsupported richer schemas reject before a reply is reserved; they can still be answered in the native client. Unknown approval amendment payloads are not converted into grants.
- A reply transport cannot prove remote consumption. Uncertain decisions are reserved, displayed as uncertain and never replayed. Native resolution/reconciliation determines what remains pending.
- Native clients and rendering were verified on this Windows installation only; macOS and combined UI journeys remain unverified here.
