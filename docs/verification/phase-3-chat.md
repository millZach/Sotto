# Phase 3 personal-chat backend verification (#68)

Scope: backend/native/persistence, main-window IPC and preload only, built from `bf500b4` in `phase3-chat`. Renderer implementation and visible Windows review belong to the main integrator. No dependency installs, pushes, external comments or additional agents were used.

## Acceptance checklist

- [x] Distinct durable personal identity/history; no project row, fake project ID, ThreadRegistry migration or provider rebind.
- [x] Local chats and selected chat load before connecting; configuration model/effort are captured for new chats and saved chats remain Codex-bound. Unsupported coordinators reject new-chat creation with an availability reason.
- [x] Native creation and submission intent precede dispatch; a send returns after local persistence, independent of provider latency. Newer draft revisions survive an old acceptance.
- [x] Restart marks unfinished writes uncertain and reconciles same-native-session history without replay. Unknown creation aliases remain unresolved rather than being recreated.
- [x] Normal Codex native skill input, user approval reviewer and workspace sandbox; no constrained CodexSubscriptionClient parser or disabled native-tool configuration.
- [x] Existing explicit global-memory retrieval only; project/private, inferred, permission and irrelevant memories excluded. Retrieval does not mutate memory or grant authority.
- [x] Exact owned pending requests, durable explicit answer intent, duplicate-answer protection and disconnect denials. Shared structured answers integrated through the shared answer schema, verified with the provider worker's current changes.
- [x] History-disabled disk cache redacts messages/activity/generated titles/submission text and answers; retains unsent draft and recovery IDs. Native rollout retention remains Codex-owned.
- [x] Main-frame-only validated IPC; widget, foreign/child/spoofed/missing frames and added authority fields rejected.
- [ ] Final integrated UI and visible Windows journey: main integrator's scope, not claimed here.

## Focused tests and build

TDD red runs established the missing service, missing durable answer intent and generated-title privacy leak before their fixes. Tests use actual child-process JSON-RPC fixtures and synthetic data.

- `npx vitest run tests/integration/personalChats.test.ts`: 12 passed on the baseline contracts; 2 shared structured-request tests are conditional until the provider worker's #52 schema lands. Covers saved/restarted drafts, uncertain creation, lost send acknowledgement, identity/origins, default changes, global retrieval/authority exclusion, explicit native skills, subsequent-memory refresh, cross-chat request rejection, disk failure before dispatch and cache privacy.
- The local durable-ack test requires less than 100 ms while native acknowledgement is delayed 350 ms. This is service acknowledgement, not renderer feedback or network response latency.
- `tests/unit/main/personalChatIpc.test.ts` and `tests/unit/preload/personalChats.test.ts`: passed; IPC trust, strict payloads, main-only surface, parsed state subscriptions and unsubscription.
- `tests/unit/main/codexHost.test.ts`: all 42 existing project-host tests passed alongside the initial two personal tests (44 total), preserving project functionality.
- Personal chat plus `tests/unit/main/codexActivity.test.ts`, `tests/integration/codexActivity.test.ts`, `tests/unit/main/codexSkills.test.ts`: 35 passed plus the then-pending structured test skip. Activity parameter narrowing changes no projection behavior.
- Temporary provider integration overlay (only copies in this worktree, fully restored afterward): provider worker's shared agents/skills/host, codexRequests/nativeRequests and its one-line Codex answer forwarding. All 16 tests across personal integration, IPC and preload passed, including exact structured question mapping and rejection of an invented session permission. Node typecheck passed. Those shared changes remain owned by the provider worker and must be included by the integrator; this commit derives from them rather than maintaining a second answer schema.
- `npm run typecheck`: passed for node and web configurations.
- Scoped ESLint: passed. `npm run build`: passed for Electron main/preload/renderer (existing Lucide `use client` bundling notices only). No full suite was run; the integrator owns that final gate.

## Installed native evidence

Used the [official App Server documentation](https://learn.chatgpt.com/docs/app-server#threads) and generated the installed schema with `codex app-server generate-json-schema --experimental --out artifacts/personal-chat-schema`. Installed native version: `0.154.0`. Checked ThreadStartParams/ThreadResumeParams developerInstructions, ephemeral/history mode, cwd and model/effort fields. Normal runtime protocol and executable/environment handling remain in the existing CodexAppServerHost.

Opt-in command: `SOTTO_NATIVE_PERSONAL_CHAT=1 npx vitest run tests/integration/personalChatsNative.test.ts` (PowerShell sets the environment variable separately). Model was exactly `gpt-6-astra`, reasoning `high`; no fallback model or account change.

The first native attempt exposed a real difference from the fixture: a just-created thread cannot be resumed before its first user message materializes a rollout. That attempt made one owned `thread/start` and **zero** `turn/start` calls; it failed before spending an inference turn. The implementation now supplies initial global context on start, and refreshes it by resume only after native messages exist. A regression assertion prohibits pre-first-message resume.

The corrected smoke passed in 6.25 seconds of test execution. It listed 58 native skills (user/system, zero catalog errors), created one owned personal conversation and sent one benign prompt asking for `SOTTO_PERSONAL_OK` with no tools, browsing, delegation or file changes. The native assistant replied exactly that marker. Native turn duration was 4,031 ms. A new service and new app-server process restored cached history and resumed the same native ID with identical user/assistant message IDs and the original command ID. There was exactly one start and one turn submission in the passing smoke; no replay at restart.

Recorded successful calls: initialize x2, model/list x2, skills/list x1, thread/start x1 (`ephemeral:false`), thread/read x6, thread/resume x1, turn/start x1. The sanitized exact call sequence and synthetic message/identity evidence are in [phase-3-chat-native.json](phase-3-chat-native.json). Temporary test app data was removed; no arbitrary user/native thread, account or global configuration was changed. No quota failure occurred.

## Limits and integration notes

Full native tool execution was not exercised by the paid smoke; availability is retained through the unchanged normal native host configuration and structured skill protocol fixture. A second paid memory-refresh turn was not run; its field is installed-schema-verified and covered by the process fixture. Native catalog discovery and first-message/restart behavior were exercised live.

Personal sends deliberately expose no attachments, follow-up queue, steering, automatic project creation, management or delegation in this slice. A lost creation response with no saved native alias requires review/new chat, never automatic replacement. Uncertain sends remain blocked until matching native identity confirms delivery. This conservative limitation is surfaced rather than silently retrying.

The renderer contract was published early to `../phase3-orchestration/chat-contract.md`; methods are get/create/select/saveDraft/send/skills/refresh/interrupt/answer/connect/disconnect/onState. View unmount only unsubscribes. Additive main index/preload/contracts hunks may need ordinary conflict resolution with the tools worker. Native personal connection is disabled in the existing synthetic E2E runtime so a fixture cannot accidentally launch a real account; the integrator should supply its UI fixture bridge.

Final local housekeeping: automatic approval review rejected recursive cleanup of the two generated `artifacts/personal-chat-*` directories with only `blocked by policy`. They remain untracked and are excluded from the scoped commit. Sanitized live evidence is committed under docs/verification; the pre-existing runtime asset modifications are also excluded.
