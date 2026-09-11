# 4. Authority lives in policy records

## Status

Accepted — 2026-09-10.

## Context

Memories preserve evidence about the user, projects and the world. Their authority metadata does not grant permission: a memory row with authority `permission` is evidence, not a grant. Imported history, repetition and agent confirmation cannot establish authority. High-impact permissions require explicit configuration or confirmation, and the questionnaire needs a durable place for the user's risk boundaries.

## Decision

**Store authority in separate policy records.** Migration 2 adds the `policies` table in `memory.sqlite`. `PolicyStore` shares the memory store's open connection and reads only policy records when authorizing an action. Each policy record carries action, resource, scope, effect, source, note, grantedAt, expiresAt and revokedAt. Authority is never derived from memory, imported history, repetition or agent confirmation.

**Check policy at dispatch through the coordinator's `Authority` interface.** The risky-action classes are `spend`, `publish`, `destroy` and `relax-verification`. Matching uses exact action, exact resource or `*`, and exact project scope or `global`. An active `always-confirm` record beats any `allow`; expired or revoked records never allow. The coordinator depends on the interface, without importing memory storage.

**Keep permission answers with the user.** Supervision never answers permission requests, including denials; they stay in the attention queue. A user's own answer can authorize one action without a stored allow, and creates no policy record. An `always-confirm` boundary requires an explicit approval answer. Rejected dispatches use the existing turn record error field.

**Record questionnaire risk boundaries as policy.** `recordRiskBoundaries` writes `always-confirm` records with source `questionnaire`, providing the seam for ticket #16. Temporary exceptions never widen authority: a future temporary allow is bounded by expiresAt and cannot override `always-confirm`.

## Consequences

- Memory retrieval and policy authorization share SQLite lifecycle and migrations while reading separate tables. No new connection, production dependency or packaged resource is needed.
- Classification is keyword-based on permission request text for now. Resource is always `*` until requests carry structured resources; text cannot reliably identify a path, repository or provider. Specific resource grants therefore cannot authorize these wildcard requests automatically.
- Policy records support expiry, revocation and retained history. The questionnaire can store boundaries without inferring grants from remembered statements.
- Explicit confirmation permits one dispatch and leaves the stored boundary in force. Supervision remains unable to answer a permission request even when a policy allows the risky action.
