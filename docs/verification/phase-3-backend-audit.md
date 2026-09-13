# Backend integration audit

Pinned HEAD: `9a493bf596fda6473507070852c0191f5f302fba`.
Baseline: `bf500b42f91cfc1bd198c2d75d62ee48ef4232a8` (three-dot comparison).
HEAD advanced during the audit; findings and line numbers below refer exclusively to the pin.

## Findings

1. **P1 — One oversized native answer erases every saved personal chat on restart.** `src/main/agents/personalChats.ts:112`, `:97`, `:54–63`.

   Trigger: with local history enabled, Codex returns an assistant message longer than 100,000 characters. Native messages are copied into saved state and written without validation, although the inherited `agentMessageSchema.text` rejects that length. On restart, `AtomicJsonStore.peek()` maps the invalid aggregate to its empty default; startup immediately writes that default over `chats.json`. All personal-chat identities, drafts and submission recovery records disappear, including unrelated valid chats. Native aliases remain, but `accept()` deliberately ignores conversations without a saved chat, so reconnect cannot restore them.

   Verified using the pinned service, actual shared schemas and actual AtomicJsonStore with an in-memory filesystem: two saved chats, one 100,001-character native answer; disk retained both initially but failed schema validation; restart produced and persisted zero chats with no error. Malformed JSON independently followed the same destructive path.

   Minimal direction: make persisted native content satisfy the storage contract without losing conversation identity; distinguish invalid storage from a missing file and prevent startup from overwriting invalid data with an empty aggregate. Preserve recoverable identities/drafts and surface the error while respecting history privacy.

   Acceptance #68: “Add durable personal-chat identity and history” and “Offer New chat and saved chats, preserving each native conversation”.

2. **P2 — Grok history reconciliation conflates distinct assistant messages by text.** `src/main/agents/grok.ts:222–234`.

   Trigger: a turn has separate assistant streams around a tool, and the later stream repeats or extends text from an earlier stream while durable history lags. The new stream identities are ignored during reconciliation: any matching text anywhere in the turn suppresses the later message; a prefix match can overwrite an earlier message under its old identity.

   Verified against the pinned adapter with synthetic ACP notifications and an in-memory history reply: live user → assistant “Done.” → tool → separate assistant “Done.” produced two distinct assistant IDs. Reading history persisted only through the tool removed the second assistant message from the published snapshot. It can remain absent until native history catches up. This is an observational-history bug, not evidence of repeated native execution.

   Minimal direction: reconcile each live stream against its matching stable assistant ID, retaining unmatched streams in order; compare text only within that identity.

   Acceptance #50: “Recover from reconnect and replay without duplicated actions, output or answers.”

## Scope and limitations

Inspected the scoped provider/request/activity/skill changes, complete new personal-chat and tools services, related shared contracts, preload/IPC, coordinator/workspace routing, focused regression sources, CLAUDE.md, CONTEXT.md, relevant ADRs, canonical ticket bodies and approved plans. Read existing native/provider/chat/tools and packaged Windows verification evidence. Browser isolation, mount ordering, terminal ownership/restart and working-copy diff paths were source-traced; no new native/UI/platform smoke was run. Executed only the two families of read-only, in-memory reproductions described above. No full suite, paid inference, extra agents, implementation edits or remote writes. This is a bounded backend audit, not the separate final two-axis review or blanket approval.

## Integration disposition

- P1 personal-chat cache loss: confirmed by the independent reproduction; isolated backend correction and regression verification in progress.
- P2 Grok stream identity: root reproduced both identical-text suppression and prefix overwrite with the actual adapter fixture, then changed reconciliation to match stable assistant IDs within the owning turn. Four native activity integration tests pass, including the two new regressions. A later chunk extends only its own matching partial stream; history catch-up, replay and process restart retain both IDs/texts, and only one native prompt is recorded. Typecheck and focused lint passed.

This is an interim backend audit. The final Standards and Spec reviews will assess the completed integrated change separately.
