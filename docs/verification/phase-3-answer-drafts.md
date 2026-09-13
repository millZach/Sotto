# Structured answer draft durability

Correction: [draft recovery verification](phase-3-draft-recovery.md) supersedes the cleanup and request-free restart claims below. Native request disappearance or definition changes now retain answers; automatic cleanup requires exact positive attempt acceptance. The earlier reintroduced-request Electron evidence remains historical.

Verified September 13, 2026 in `phase3-answer-drafts`, based on `0bde0441bc75bef64dc203af6f16c0382ec88cd2`. Production source and the tested build are at `55d905312b5ad630bd02919b979c1c5a76b7e733`.

The original regression selected a structured radio option, recreated the renderer store, and failed because the option was unchecked. The send callback was never invoked. The same regression now passes through the draft bridge.

## Delivered behavior

- A dedicated main service writes `request-drafts.json` through the existing `AtomicJsonStore`. Both composer stores remain independent and unchanged.
- Draft identity includes owner kind, Sotto owner ID, provider ID, request ID, the question definitions and per-question selections. Separate requests can reuse question IDs without inheriting each other's answers. Revisions reject stale/conflicting writes.
- Every edit queues a save independently of the component's lifetime. Saved feedback requires the exact atomic acknowledgement. Delayed initial reads, retries after failed reads, and older save acknowledgements preserve newer local edits.
- Sending first persists a held revision. Restored held revisions remain unconfirmed; neither loading nor checking submits an answer. Main performs the native read and consults native delivery/outbox uncertainty before releasing a hold.
- Empty disconnected/loading/startup snapshots do not prune restored drafts. Main can retire a changed question definition, an observed completed held request, or a held revision with accepted main delivery evidence. A newer editing revision survives acceptance of an older attempt. Unsent records with no definitive stale/completed evidence remain retained.
- Threaded accepted receipts contain IDs and a SHA-256 question-definition digest, without question or answer text. Personal completion uses the existing main-owned decisions. No changes to `personalChats.ts` or its shared decision schema were required.
- History-disabled unsent drafts remain on disk. Accepted held content is removed, including after restart before native requests reconnect. Startup removes only this service's abandoned atomic temporary copies once the primary file is readable.
- Invalid storage stays unchanged and read-only, without creating plaintext backups. Save failures keep local input visible, disable Send and offer Save again. Over-limit input is retained with a readable error rather than throwing an unhandled rejection. Checking delivery after a failed save cannot falsely mark newer local text saved.

## Verification

Final source checks: **312 tests passed in 15 scoped files**, no skips; both TypeScript projects passed; ESLint on all changed TypeScript/TSX files passed; `git diff 0bde044 --check` passed. No full suite was run.

```powershell
npx vitest run tests/unit/main/requestDrafts.test.ts tests/unit/main/requestDraftIpc.test.ts tests/unit/main/threadDrafts.test.ts tests/unit/main/agentControlRecovery.test.ts tests/unit/preload/requestDrafts.test.ts tests/unit/preload/personalChats.test.ts tests/unit/renderer/requests tests/unit/renderer/threadRequestSurroundings.test.tsx tests/unit/renderer/personalChatsView.test.tsx tests/unit/renderer/threadsView.test.tsx tests/integration/requestDraftDelivery.test.ts tests/integration/draftManagementHandoff.test.ts tests/integration/ipc.test.ts --maxWorkers=1
npm run typecheck
npm run build
npx playwright test tests/e2e/request-draft-restart.spec.ts tests/e2e/phase-three-requests.spec.ts tests/e2e/phase-three-personal-requests.spec.ts --workers=1
```

The final **nine complete-app Electron journeys passed in 31.1 seconds**:

1. Existing personal native questions, exact approvals and refused-answer recovery.
2. Existing threaded simultaneous structured questions and optional fields.
3. Existing threaded approvals, refusal and single dispatch while held.
4. Threaded full-process restart: text, Other text, multiselect and a second request survive with history disabled; the separate composer is unchanged. No answer command occurs until explicit Send. Accepted content is then removed without clearing the other request.
5. The equivalent personal full-process restart and cleanup journey.
6. Threaded interrupted-answer restart restores disabled/unconfirmed input and never replays. Check again performs main recovery without sending.
7. The equivalent personal interrupted-answer restart journey.
8. A real filesystem rename failure leaves the visible answer unsaved and Send disabled; repairing access and clicking Save again writes the exact retained answer, with zero delivery calls.
9. A genuinely malformed file stays byte-for-byte unchanged, creates no backup, displays its storage warning and retains newer local text without sending.

The service tests additionally cover malformed selections, duplicate identities, foreign owners/providers/questions/options, stale revisions, held edits, cleanup of accepted revisions before reconnect, preserved newer revisions, and file repair/restart. Renderer tests cover delayed/reordered acknowledgements, initial load retry, over-limit input and failed pre-send persistence. Main integration tests cover durable privacy-safe receipts, loading snapshots and a disconnected owner while another provider is connected.

## Evidence and limits

All builds used this worktree's own `out`, with the existing `node_modules` junction and no installation. No runtime assets were copied. [Build hashes](../../artifacts/request-drafts/build-provenance.json) identify the main, preload and renderer artifacts built from the committed source.

The final captures were opened and visually inspected:

- [Thread restart](../../artifacts/request-drafts/thread-restarted.png), [personal restart](../../artifacts/request-drafts/personal-restarted.png).
- [Thread held after restart](../../artifacts/request-drafts/thread-held-restarted.png), [personal held after restart](../../artifacts/request-drafts/personal-held-restarted.png).
- [Real save failure](../../artifacts/request-drafts/save-failure.png), [invalid storage](../../artifacts/request-drafts/invalid-storage.png).

The tests use existing unpackaged `SOTTO_E2E` hooks and fixture providers, with real main services, preload, renderer and local files. The threaded fixture stores native requests in memory, so restart tests explicitly re-emit the same requests after reconnect; the personal fixture reloads its native request file. Held restart tests pause the incoming answer IPC before the real answer handler; separate main integration tests exercise actual outbox uncertainty. These are full Electron process exits/relaunches, not merely renderer reloads, but they do not validate real provider accounts, native protocol delivery, an OS power loss or a packaged release. No paid providers, remote writes, subagents or full-suite run were used. All owned app instances were closed.

The final app run began after the root visual critic's `visual-review.exit` reported completion. Native explanation/context rendering and the compact layout control belong to the separate UI worker and are not redesigned here. Root owns combined integration and release verification.

Source commits, in order: `33e2915f49371c4717d526991e2e4deb07c7d7dd`, `5999f6ecf0053b5219a85f5375455772fca3a130`, `1ea00cdb5d32cf6b9a4e6d0e33e392fc98fc4908`, `55d905312b5ad630bd02919b979c1c5a76b7e733`.
