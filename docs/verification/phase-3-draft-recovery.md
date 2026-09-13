# Draft recovery corrections

Verified September 13, 2026 in `work/phase3-draft-recovery`, based on `c7b2b549db5b1ed68a111612ed71ca1ff98ef96a`. Production source and regressions: `a8e3a931a17dc0b4d4f332d14602662bf50a4456`, then `81d0c8aa3700d86f2f2fcc5c83e715d9df0f8deb`.

This corrects two Spec P2 findings in the earlier [answer-draft verification](phase-3-answer-drafts.md). That earlier Electron restart fixture reintroduced questions. It did not demonstrate recovering answers after Codex shutdown declines and clears native pending requests.

## Delivered boundary

`RequestDraftBridge.list(owner)` returns all retained drafts for one exact known owner kind, Sotto owner ID and provider ID. It needs no native request or connection, and returns the original questions, option labels, selections, text, held uncertainty and revision. Unknown owners return no content. Main-only authorized IPC and preload validate both arguments and results. Listing never refreshes or delivers anything.

`discard({ target, revision })` atomically removes only the exact saved definition and revision. A stale revision or failed write retains content and rejects; an already absent form returns false. Explicit discard can remove held recovery content, but it cannot cancel, retry or acknowledge native delivery. Corrupt storage remains byte-for-byte unchanged and read-only for recovery reads and discard too.

Storage identity now includes the question definition. Reused request IDs with different questions coexist. Changes, disappearance and disconnected/loading observations never prune unsent or uncertain content. Final queued edits to an already saved obsolete definition remain writable as local drafts, while holding/submitting still requires an offered native question. Legacy version-1 files remain readable without a migration or content backup.

## Completion and privacy

Both personal and threaded sends bind a main-owned decision/command ID to the held draft before the native write. Binding checks the original form and compares the submitted structured answers to saved selections in memory; mismatched older content cannot bind to a newer held draft. No answer digest or text is added to receipts. Renderers cannot invent a saved decision identity.

Automatic cleanup requires a held draft, its exact bound decision ID, its question-definition SHA-256 digest, and positive acceptance of that attempt. An older receipt cannot clear a later held attempt, even with the same request ID and identical question definition. A disappeared question does not create an accepted receipt. An adapter's positive acknowledgement can still clear its bound content when the native request-disappearance event arrived first.

Personal history-disabled redaction retains only safe recovery metadata (IDs, definition digest, status, timestamps, blank answer and fixed diagnostic). The prior `0c13e2b` privacy fix remains intact: no question/option labels, structured answers, permission choice or echoed diagnostic is copied into history-disabled decision storage. Legacy receipts lacking a digest or bound decision identity conservatively retain content for explicit recovery/discard.

## Verification

The pre-fix command `npx vitest run tests/unit/main/requestDrafts.test.ts --maxWorkers=1` reproduced both losses: changed-definition reconciliation wrote an empty draft array, and a legacy personal receipt erased the newer held answer during submitting. Both assertions now pass.

Final scoped run: **262 tests passed in 11 files**, no skips. Both TypeScript projects, ESLint for all changed TS/TSX files, and `git diff --check` passed.

```powershell
npx vitest run tests/unit/main/requestDrafts.test.ts tests/unit/main/requestDraftIpc.test.ts tests/unit/preload/requestDrafts.test.ts tests/unit/renderer/requests tests/integration/requestDraftDelivery.test.ts tests/integration/personalChatAnswerPrivacy.test.ts tests/unit/main/agentControlRecovery.test.ts tests/integration/draftManagementHandoff.test.ts tests/integration/ipc.test.ts --maxWorkers=1
npm run typecheck
```

The personal integration tests run the real `PersonalChatService`, production owner-state projection, `RequestDraftService`, `AtomicJsonStore`, and `CodexAppServerHost` against the existing local Node fake App Server. They disconnect/reset the real adapter, create a new adapter and service from actual files, reconnect, and assert that native requests remain absent. Both unheld and held drafts preserve original content; checking cannot release a disappeared request; no answer is replayed.

The reused-ID integration cases first obtain a real accepted decision, then offer a same-ID different or identical definition at the native snapshot seam. At the next answer's actual pre-native-write checkpoint, disk contains the old accepted decision and new submitting decision, while request-drafts.json still retains the new held answer. The next native effect is deliberately reported uncertain. Restart reads the actual files without reintroducing the request and retains the new content. History-disabled receipt files contain no private fixture strings, and only the original accepted answer reached the fake server.

The threaded integration cases check the real controller-to-draft binding with a provider disappearance event before acknowledgement. Positive acceptance cleans the exact draft; an uncertain result retains it across restart with zero replay. Unit/IPC cases cover separate definitions, legacy receipts, stale discard, failed atomic discard/retry, missing owner/provider, invalid storage, queued obsolete-form edits, forged decision IDs and a delayed different-content answer.

## Limits and integration

The separate Opus UI worker owns the recovery component, mounts, copy feedback and rendered checks. This backend work does not edit ThreadPane/PersonalChatsView TSX, CSS or composer presentation. Its API was published early in the main orchestration `draft-recovery-api.md`; no renderer store production change was needed. Root must integrate both workers and verify the complete user-facing recovery journey, including owner-switch async suppression and re-listing after queued-save or terminal-answer completion.

No UI launch, Electron build, paid/native account, remote action, install, subagent or broad full suite was used. These are real local-file/service restarts and real adapter shutdown semantics against a synthetic protocol server, not an OS power-loss, packaged release or real provider account test. Uncertain and legacy content is intentionally retained until a user discards it or main receives exact positive acceptance; no native request or sending authority is restored.
