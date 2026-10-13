# Personal-chat persistence recovery verification

September 13, 2026. Baseline: `5dca38503287cfedc07c35c2fbf010fbb61a38d2`, branch `work/phase3-chat-recovery`. Fixes the P1 reported against `9a493bf596fda6473507070852c0191f5f302fba` in the backend audit. Scope is the personal-chat service, its shared schema and focused tests. AtomicJsonStore and native provider adapters are unchanged.

## Cause and decisions

Native assistant text inherited the 100,000-character command-input constraint, but persistence did not validate writes. On restart, `AtomicJsonStore.peek()` returned the empty default for either invalid schema data or malformed JSON. Startup then overwrote all chats with that default.

- Personal transcript text now accepts the full native string, preserving message IDs, command origins and content. Input, request and activity constraints remain unchanged. There is no synthetic replacement answer, splitting or silent text truncation.
- Every mutation validates its serialized representation against the shared personal-chat schema before publication or atomic replacement. Native messages, activities, requests, status and history metadata are validated separately. An unreadable field retains the last valid cached history with an explicit incomplete-history error. Unreadable live requests are withheld; new sends are blocked until readable requests/status arrive. No malformed request is automatically answered.
- Startup reads the personal cache directly to distinguish ENOENT from read errors, malformed JSON and invalid aggregates. Invalid storage is never rewritten, renamed, backed up or automatically repaired. A persistent storage error blocks editing and native connection, including create/connect/close after startup. Read-only selection remains available.
- For parseable invalid aggregates, recovery retains schema-valid, unambiguous chats and valid identity/draft/delivery records around damaged observational fields. Valid message/activity records are retained; recovered activity remains bounded by the existing 2,000-record contract. An unreadable decision's cached request may be omitted while its exact answer and delivery IDs remain. Unfinished intents become uncertain in memory. Invalid selection does not remove chats; duplicate identities are not guessed or rebound.
- Normal history-disabled redaction is unchanged for valid storage. Invalid originals are preserved even when history is disabled, with an explicit notice that they could not be redacted. No extra plaintext copy is created. Existing corrupt recovery files are no longer automatically deleted; the existing cleanup of abandoned atomic temporary copies runs only when storage is readable or missing.

## Executed checks

Failing regressions preceded implementation. The first run of `npx vitest run tests/integration/personalChatRecovery.test.ts` had **9 failed, 1 passed**. A two-chat real-filesystem/service/process restart returned zero chats; malformed/nonempty files were replaced with an empty aggregate; invalid live activity/request/message fields failed serialized renderer-schema validation. Expanded coverage separately failed for an oversized request nested in a saved answer decision, then passed after recovery preserved the decision identity.

Final focused command:

```text
npx vitest run tests/integration/personalChatRecovery.test.ts tests/integration/personalChats.test.ts tests/unit/main/atomicJsonStore.test.ts tests/unit/main/atomicJsonStoreRename.test.ts tests/unit/main/personalChatIpc.test.ts tests/unit/preload/personalChats.test.ts
```

**73 passed, 1 skipped, 6 files passed** (74 total; 22 new recovery cases). The skip is the existing AtomicJsonStore symbolic-link test on a Windows host without symbolic-link creation permission. Existing AtomicJsonStore and rename tests remain green.

The new tests use real files in owned temporary directories with the existing scripted child-process Codex fixture; no paid inference. The long-answer test starts two separate conversations, receives a 100,001-character answer, then creates a fresh service and child process. It verifies both saved identities, original native alias contents, exact user/assistant message identities/content, newer unsent drafts and submission records before and after refresh. Exactly two native thread starts and two turn starts remain: no restart replay. It parses JSON-serialized state with `personalChatStateSchema` and saved chats with `personalChatSchema`.

Other cases cover malformed JSON, zero-byte files, invalid envelopes, invalid selection, duplicate IDs, read errors, mixed valid/damaged observations, answer-request corruption, activity text/nested path/count limits, request text/option/context/permission-label/question-count limits, malformed message arrays and status, refusal to send/answer through unreadable requests, return to valid observations, missing-file creation, privacy-disabled redaction and uncertain intent retention. Existing focused integration tests also verify uncertain creation, lost-ack reconciliation, newer drafts, exact request ownership and intent-before-native-write behavior.

Passed: `npx tsc --noEmit -p tsconfig.node.json`, `npx tsc --noEmit -p tsconfig.web.json`, scoped ESLint for the two source files and new regression file, and scoped diff whitespace checks.

## Review and limitations

Reviewed the scoped diff against CLAUDE.md, CONTEXT.md, ADR-0010, the implement skill, audit and explicit recovery requirements. Standards review found no unresolved scoped issue. Spec review found no unresolved scoped issue. This was a self-review: the user prohibited new agents, overriding the code-review skill's parallel-agent workflow. Root owns the independent review/cherry-pick and final full suite.

Recovery does not guess the contents of malformed JSON or reconstruct invalid identity/draft/intent records. Those records remain in the original file and require explicit repair/restoration before restart enables writes and native connection. Read-only recovered observations may be incomplete and are labeled as such. Transcript text remains loaded in memory as in the existing service; this change does not add streaming or a large-cache performance redesign. No renderer/UI, installed-native inference, packaged-app smoke or full suite was run. No push or external write was performed; unrelated runtime CRLF changes were excluded.
