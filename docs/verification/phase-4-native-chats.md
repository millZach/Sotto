# Phase 4 native personal chats (#69, #70) and Claude rewind (#62)

Baseline `d596d832ea2466bb515d58560f11dc410ff3df78`; native foundation `52f1f42` is an ancestor. Read the approved Threads workspace plan, tickets 26/27, ADR0010, phase-3 native evidence and pinned T3 reference `d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3`.

## Delivered checks

- [x] Claude/Grok personal aliases contain no project ID; project host snapshots exclude these conversations.
- [x] New chats capture configured provider/model/effort; changing coordinator leaves saved chats bound to their original provider through send, refresh, skill discovery, answers and restart.
- [x] Normal persistent native clients, tools, skills and native permissions remain active. No classification client, disabled-tool profile, custom compaction or project orchestration harness.
- [x] Relevant existing global-only memory retrieval. No project memory query or management capability is introduced.
- [x] Native provider connection failures retain cached history and drafts; uncertain delivery remains unreplayed. Disconnected partial snapshots cannot erase cached messages.
- [x] Provider marks, composer/answer/connection labels and skill syntax follow the saved provider. Synthetic Electron runtime overrides all three personal providers, preventing real-account launches during UI tests.
- [x] Installed native create/send/skill invocation/restart/same-session follow-up verified for Claude and Grok.
- [x] Claude matching native conversation rewind uses official SDK fork, exact retained boundaries, durable lineage and restart recovery. Full original native transcript is unchanged.
- [x] Electron keyboard/composer, request decisions, disconnect/reconnect and light/dark renders at1280x900 and820x560 inspected.

## Native behavior and evidence

Claude uses existing stream-json `--session-id`/`--resume`, default permissions and host decisions. `--append-system-prompt` retains its normal system prompt/tools/skills. Updated relevant global context restarts the same session before a subsequent turn only when needed. [Official flag documentation](https://code.claude.com/docs/en/cli-reference).

Grok uses normal ACP `session/new`, model selection, `session/load`, native pending requests and history updates. Personal/global context follows the leading native skill invocation; verified origin/digest matching removes only this generated suffix from Sotto history. No extra plaintext prompt is stored in alias metadata. The existing normal provider profile remains untouched. [Official headless documentation](https://docs.x.ai/build/cli/headless-scripting).

Opt-in `SOTTO_PHASE4_PERSONAL_NATIVE=1 npx vitest run tests/integration/personalChatProvidersNative.test.ts`: **2 passed in26.22s**. Each provider sent two bounded synthetic user turns: selected native skill expansion (random marker known only to SKILL.md), then a new follow-up after process/service restart. Both retained their original native IDs and two distinct accepted submission identities after the configured coordinator changed to Codex. Neither created a project. Claude used configured `haiku` with installed2.1.270; Grok used `grok-4.6` with1.0.5/ACP1. Catalogs contained103 and77 entries respectively, including each owned synthetic skill. These are four user turns, not an invented billing/model-call count. No tool execution, delegation, global setting change or arbitrary native conversation access was requested. Normal skill invocation was exercised live; exact permission decisions and connection failure use protocol fixtures.

Sanitized evidence: [phase-4-chat-native.json](phase-4-chat-native.json). Full synthetic local evidence: `artifacts/phase-four-native-chats/{claude,grok}.json`. The source probe now snapshots configuration rather than retaining its mutable object reference and records final native version; sanitized evidence separately records the independently read Claude installed version because its initial pre-conversation host version was empty.

## Claude rewind and uncertain recovery

T3's ClaudeAdapter lines5236?5289 uses native `forkSession` at the last retained message and remaps UUIDs under the existing application thread. Installed CLI `--fork-session --resume-session-at --session-id` initialized successfully but produced no durable fork transcript after clean close, so initialization alone cannot support a verified rewind.

Pinned official SDK0.3.270 `getSessionMessages`/`forkSession` provides the native disk operation without inference. A helper subprocess isolates CLAUDE_CONFIG_DIR, avoiding process-global environment changes; the existing streaming CLI remains the conversation runtime. The helper loads a separately packaged self-contained SDK module, with packaging/notices verification owned by the usage worker.

Before fork, the adapter records source digest/boundary intent. It validates complete retained type/message payloads, checks unchanged source, remaps message UUIDs, resets native permission-answer history, stores lineage and publishes a changed history epoch under the original Sotto thread/provider binding. After dispatch, failures return uncertain. A durably recorded fork target reconciles on reconnect without a second fork. A lost response before the target identity is saved stays unresolved, with no discovery/adoption of arbitrary sessions. Compacted/changed boundaries, live turns and pending requests reject before mutation. Stale source-log callbacks cannot reintroduce removed activity.

`claudeRollback.test.ts`: **2 passed**, covering exact retained turn/restart/new continuation and a real filesystem fault after native fork identity persistence. The latter returns uncertain, prohibits retry, then reconciles the recorded fork after disk restoration/restart. Fixture native transcripts now emit real parentUuid chains so the official SDK reconstructs them.

Zero-model installed adapter smoke: `SOTTO_PHASE4_CLAUDE_ROLLBACK_NATIVE=1` with `SOTTO_PHASE4_CLAUDE_SOURCE` pointing to the prior owned synthetic phase-3 Claude folder, then `npx vitest run tests/integration/claudeRollbackNative.test.ts`: **1 passed in6.73s**. Retained the exact earlier Sotto message identity/history and epoch after restart; no inference prompt. Sanitized evidence: [phase-4-claude-rollback-native.json](phase-4-claude-rollback-native.json). [Official SDK fork documentation](https://platform.claude.com/cookbook/claude-agent-sdk-05-building-a-session-browser), [native fork/permission behavior](https://code.claude.com/docs/en/sessions).

## Focused and rendered verification

Approved plan/tickets already agreed public persistence/protocol/native/Electron seams. The integrator corrected an unnecessary additional seam question; tests proceeded under existing authorization.

- Existing Claude/Grok adapter contracts, failures/safety and native skills:53 passed across5 files.
- Personal service provider lifecycle/connection failures plus prior Codex service tests:18 passed across2 files.
- Personal renderer suite:16 passed, including saved Claude/Grok identity despite a Codex default.
- Existing recovery+renderer earlier batch:36 passed. Counts overlap; they are not summed.
- New Electron provider journey:1 passed. Updated existing bridge/restart Electron tests:2 passed.
- Node/web typecheck and scoped ESLint passed before later parallel integration edits; root owns the final integrated checks/full suite.

Red/green evidence exposed the first Claude personal send's missing-history guard firing after its local origin was reserved but before the first native write. Fixed only that exact initial reservation exception; missing established history still blocks. A restart fixture replayed its last control-file completion; consuming the fixture driver command fixed the test setup without changing native production semantics. The SDK rollback test initially exposed missing parentUuid links in the fixture producer, corrected to match native history.

Tastify scope: existing Sotto desktop saved-chat composition, typography, color, motion and reduced-motion behavior remain. Concept is conversation-led: select a saved conversation and its own provider appears throughout the work area. Provider-first grouping and a provider-selection launcher were considered and rejected as unnecessary UI changes. No new art or motion was added. Screenshots `artifacts/phase-four-native-chats/{claude,grok}-{1280-dark,820-light}.png` were opened and inspected. Both providers' marks/names, pending approval actions and reply composer remain legible;1280 gives the transcript room,820 wraps header controls and scrolls transcript independently while retaining approval/composer access. Light screenshots were recaptured after checking actual appearance data-theme, correcting the initial use of the legacy theme setting.

The scoped identity/copy set is Chats, selected conversation title, provider/model, no-project tag and personal-chat label. Conversation text is native content; action labels, pending-request wording, connection/delivery feedback and storage status are operating controls/state. Existing repeated identity at navigation versus selected workspace/composer identifies those distinct targets; this change adds no promotional copy or extra section. Keyboard Enter submission, native Skip decision, disconnect and provider-specific reconnect were exercised. No overlap or clipped controls was observed. Prompt extraction/usage controls visible in these captures belong to integrated root/usage work.

No claim of macOS verification, native permission tool execution or full-suite completion is made by this worker. Root owns independent code review, combined packaging/final tests and commit.
