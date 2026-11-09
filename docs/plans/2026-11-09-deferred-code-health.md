# Deferred code health work

The user reopened the twenty-two concerns left after pull requests #2360 and #2364 on November 9, 2026. The SQLite rollback double-failure concern remains deferred by the user's explicit choice. This change covers the other twenty-one canonical concerns; the three historical aliases are not additional work.

The previous fixes and their commit history remain intact. This work starts from `main` at `b2b70e2a87a95be944087f5fc8324836f20578e2` on `chore/deferred-health-fixes`. No unrelated scanner backlog is included.

## Scope

| Group | Concerns | Boundary and acceptance |
| --- | ---: | --- |
| Watcher ownership | 2 | One existing owner for durable Watcher records and archive views; retain flush and publication order. |
| Host runtime contracts | 2 | Separate provider responsibilities from workspace responsibilities; give the inactive host a truthful interface. |
| Broadcast wire types | 1 | Distinguish omitted fields from reassembled state without extra copying on updates. |
| Package layout | 2 | Move settings pages and existing provider/Git families to their owners; update direct consumers and entry paths. |
| Microphone lifecycle | 1 | One section owns devices, selection, sampling, cancellation and cleanup with unchanged markup. |
| Socket feature rules | 1 | Share only identical capability predicates, preserving client authorization and default inclusion. |
| Appearance startup | 1 | Explicit main/popup initialization owns subscriptions and cleanup. |
| Durable state failures | 2 | Report Teams persistence failure truthfully; fail closed on delegation read failure and clean up startup. |
| Preload promises | 1 | Promise APIs reject invalid input; synchronous subscriptions stay synchronous. |
| Send and followup ownership | 2 | Share identical outcome interpretation and lifecycle transitions while preserving durable send order. |
| Integration completion | 2 | Replace Watcher and product-event settlement sleeps with observable completion. |
| Workspace ownership | 1 | Separate serialization and worktree state at their existing boundaries. |
| Workspace options | 1 | Named optional policies replace positional arguments. |
| Held providers | 1 | Remove internal boolean compatibility while retaining saved-record compatibility and Owl gates. |
| Relayed callers | 1 | Use the caller fields actually available, preserving identity and permission checks. |

## Execution

Renderer ownership, protocol types and socket predicates can proceed independently. The coordinator and durable-state changes need their call sites mapped first. Provider and Git path moves come after behavior changes so they cannot conceal them.

### ADR-0190 checkpoint

The earlier publisher, client-update, title and detail-revision extractions are present. Broadcast and combined saved-file assembly still live in Control; this batch does not pretend the older seven-PR sequence is complete. The explicit deferred-work request resumes the bounded ownership changes below without moving that assembly or changing its ordering. Control's size cap will decrease for extracted code, and each state owner will have its own cap.

| Choice | Assessment |
| --- | --- |
| Put records, archive and scheduling in WatcherService | Mixes passive saved-state ownership with gated scheduling; rejected. |
| Separate record, archive, recall, serialization and persistence services | Adds callbacks and ordered handoffs; rejected. |
| One WatcherRecords owner in the existing module | Chosen. Owns record identity, archive/recall views and its file cache. Control keeps combined persistence and command orchestration; Watcher's file still lands before agents.json. |
| Extract a new FollowupPump class | Adds a broad callback surface for about 280 lines; rejected for this batch. |
| Share send outcome translation, then consolidate the lifecycle in Control | Chosen. One private method owns acquisition, completion, release and repumping. Intermediate durable-claim publication stays where it is. |

Workspace gets one text-cache owner; existing ThreadWorktrees already owns filesystem allocation and recovery. Provider/workspace separation is type-only and adds no forwarding host objects. These boundaries preserve immutable record identity, recall version checks, explicit authority checks, outbox-before-send ordering and current copy budgets. Missing send evidence stays unconfirmed, retaining the original draft identity.

No application launches, local integration runs or full CI runs are authorized. Use windowless typecheck, lint and the smallest relevant unit file where needed; GitHub runs the full gates after the pull request opens. The existing GPT-6-Astra reviewer choice remains in force.

## Evidence

- Socket feature predicates: the original and factored expressions returned identical lists for all 94 features over 10,000 deterministic capability combinations, including absent, false and true flags. Per-client permission checks were not changed.
- Broadcast types: windowless typecheck passed; the existing broadcaster and renderer reassembly files passed all 41 unit tests. No schema parsing or extra update-path copying was added.
- Product-event integration timing: the fixture now drains the actual deferred attribution queue after flushing adapter updates. The 80 ms sleeps are removed. Typecheck and scoped lint passed; the integration file awaits GitHub execution.
- Other groups: implementation or design mapping in progress.
