# Phase 3 personal answer privacy — Standards P2

Verified September 13, 2026 in `work/phase3-answer-privacy`.

## Finding and correction

ADR0010 requires answer intent on disk before native writes and recovery identity retention when local history is disabled. `PersonalChatService.mutate()` instead wrote `decisions: []` in that mode. The initial four regression cases failed: both question and permission reservations were absent at the pre-pipe boundary, an uncertain answer reached the adapter again after restart, and changing the privacy setting discarded every delivery record.

The disk projection now retains decision ID, request ID, status and creation time, with an empty answer. It omits cached requests, structured answers, option/permission choices and approval values. An existing error is replaced with a fixed diagnostic so it cannot echo private content. The projection runs on every atomic save, including saves triggered by native observations. In-memory content and the exact explicitly submitted native command are unchanged.

## Acceptance checks

- [x] Real `chats.json` contains a redacted `submitting` decision before the adapter receives either a structured question answer or a permission decision.
- [x] Native fixture receives the exact original chat/request IDs and explicit answer/permission payload once; repeated answers do not dispatch.
- [x] Accepted identity survives native events, history refresh, service close and fixture child-process restart; sensitive synthetic content remains absent from the Sotto cache.
- [x] Uncertain identity survives disk and process restart; rehydrating its original pending request cannot dispatch another answer. Changing coordinator defaults does not change the original Codex/model/effort binding.
- [x] Restart from the actual pre-pipe disk checkpoint converts `submitting` to `uncertain` and enforces the same hold. The test restores captured file bytes after orderly fixture shutdown to model an exit before the final status commit; it does not kill the service process.
- [x] A failed reservation save causes no native write or in-memory reservation; a subsequent explicit answer can proceed once storage succeeds.
- [x] Disabling history redacts answer/request/diagnostic content for submitting, uncertain, accepted and failed records while retaining recovery metadata and a newer unsent draft.

## Schema and renderer review

No shared schema change is needed. `personalDecisionSchema` already accepts `answer: ''` with optional request/structured-answer/approval fields omitted. Saved decisions remain valid through disk parsing and renderer IPC. This redacted row is recovery evidence, never a command to replay.

`PersonalRequests` in `PersonalChatsView.tsx` uses `requestId` and `status` for its unconfirmed check and uncertain request-card hold. It does not reconstruct authority from saved answer or request content. Startup converts submitting decisions to uncertain; refresh cannot erase those decisions. Existing rendered-component tests cover the disabled answer card and explicit refresh action. No renderer or structured draft persistence changes were made.

## Commands and results

Initial red-capable command: `npx vitest run tests/integration/personalChatAnswerPrivacy.test.ts --maxWorkers=1` — four failures before the production fix, including `expected []` for the saved reservations and the missing service-side uncertain hold.

Final focused command:

```text
npx vitest run tests/integration/personalChatAnswerPrivacy.test.ts tests/integration/personalChats.test.ts tests/integration/personalChatRecovery.test.ts tests/unit/renderer/personalChatsView.test.tsx tests/unit/main/personalChatIpc.test.ts tests/unit/preload/personalChats.test.ts --maxWorkers=1
```

Result: **6 files, 58 tests passed**, 18.37 seconds, including six new answer-privacy cases.

- `npx tsc --noEmit -p tsconfig.node.json` — passed.
- `npx tsc --noEmit -p tsconfig.web.json` — passed.
- `npx eslint src/main/agents/personalChats.ts tests/integration/personalChatAnswerPrivacy.test.ts` — passed.
- `git diff --check` — passed.

## Limits and handoff

All native work used the local fake Codex App Server child process with temporary test data. The restart hold test injects a stale original request at the native snapshot boundary because the fake process does not persist pending RPCs. Assertions verify no adapter dispatch and no extra native answer, prompt or creation. No paid provider, real account, full suite, Electron build or graphical session was used. The user dev process and main `out` were untouched.

Previously erased decision records cannot be reconstructed. Existing unreadable-storage handling remains read-only and preserves its original file, as covered by the focused recovery tests. Native provider-owned history is outside this Sotto-cache redaction boundary. Root owns integration, final visual verification and cherry-picking; `requestAnswers.ts` and structured draft persistence are untouched.
