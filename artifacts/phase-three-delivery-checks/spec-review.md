SPEC final resolution: **0 open findings; worst severity: none. Prior P2 resolved.**

Frozen source: `387cbb8643239c9eb7cf5a8675bd0f1b52006855`.
Reviewed delta: `e3640d1f7626ff808f45fba9662d5363e3748cc7...387cbb8643239c9eb7cf5a8675bd0f1b52006855` and necessary surrounding methods only. Original baseline: `bf500b42f91cfc1bd198c2d75d62ee48ef4232a8`; unchanged Phase 3 was not re-audited.

Requirement from my `spec-closure-review-result.md`: “Queued saves/newer revisions/owner switching must not lose or expose another owner's content.” `docs/threads-product-discussion.md:52` requires “Persist per-thread unsent drafts, queued messages and workspace pane arrangement across restart” and delivery states “without silently resending uncertain submissions.”

**Resolution:** `src/renderer/src/agents/requests/requestAnswers.ts:190–198` derives a primitive stable snapshot from surviving store bindings, including requests absent throughout a remounted view. `RequestDraftRecovery.tsx:72–81` subscribes and re-lists when saves settle or terminal phases change. The queued write acknowledgement (`requestAnswers.ts:253–266`) now reaches recovery without view-local departed history. The real card binds through `AgentRequestCard.tsx:35–37`; thread and personal mounts supply matching owners (`ThreadPane.tsx:36,162`; `PersonalChatsView.tsx:112,212`).

Executed `npm exec -- vitest run tests/unit/renderer/requests/requestDraftRecovery.test.tsx --maxWorkers=1`: **16/16 passed**. The new regression at lines 154–186 commits the older edit, delays acknowledgement, queues the newer edit, unmounts, returns without a live question, then verifies recovery and Copy use “Newest edit.” Neighboring tests cover exact-live versus changed-definition visibility, late owner responses, terminal acknowledgement re-listing, held copy and recovery without send/check controls.

Source checks: snapshot exclusion requires owner kind/provider/ID plus matching structured request ID/definition (`requestAnswers.ts:193–196`; `src/shared/requestDrafts.ts:49,57`). Main's list remains retention authority (`RequestDraftRecovery.tsx:77–92`); Copy uses the listed draft (`:174–176`). Held wording states uncertainty and the no-resend consequence (`:148`). No inferred acceptance, replay authority, concrete neighboring regression or material scope creep found.

Limits: executed production renderer modules in JSDOM with a mocked persistence/clipboard bridge; reviewed restart E2E as source only. Relevant tested files match the frozen SHA. No Electron, real-disk restart, providers, full suite, build/package, Mac or release verification performed. #24 remains separate. No source edits, remote writes, subagents or other-axis reports; Standards not assessed.
