# 4. Authority lives in policy records

## Status

Accepted — 2026-09-10.

## Context

Memories preserve evidence about the user, projects and the world. Their authority metadata does not grant permission: a memory row with authority `permission` is evidence, not a grant. Imported history, repetition and agent confirmation cannot establish authority. High-impact permissions require explicit configuration or confirmation, and the questionnaire needs a durable place for the user's risk boundaries.

## Decision

**Store authority in separate policy records.** Migration 2 adds the `policies` table in `memory.sqlite`. `PolicyStore` shares the memory store's open connection and reads only policy records when authorizing an action. Each policy record carries action, resource, scope, effect, source, note, grantedAt, expiresAt and revokedAt. Authority is never derived from memory, imported history, repetition or agent confirmation.

**Check policy at dispatch through the coordinator's `Authority` interface.** The risky-action classes are `spend`, `publish`, `destroy` and `relax-verification`. Every matching class is checked. Matching requires exact action and either exact project scope or a record scope of `global`. An `always-confirm` record matches if its resource is `*`, equals the query resource, or the query resource is `*`. An unknown query resource therefore matches every boundary for that action and scope. An `allow` record matches only if its resource is `*` or equals a specific query resource; a specific-resource allow never allows an unknown resource. An active `always-confirm` record beats any `allow`; expired or revoked records never allow. The coordinator depends on the interface, without importing memory storage.

**Keep permission answers with the user.** An `always-confirm` boundary means the request always reaches the user; the user's Allow is the confirmation. A user's own answer can authorize one action without a stored allow, and creates no policy record. Supervision never answers permission requests, including denials; they stay in the attention queue. Supervision follow-ups never approve anything. A supervision `send` that asks the agent for a risky action is assumed safe because the provider must raise a permission request before executing it, and Sotto never executes commands itself.

**Retain allow records for future automatic approval.** The store supports grant, revoke and list with expiry and revocation history. `allow` records have no dispatch consumer today and are stored for a future automatic-approval feature. Until then every permission is answered by the user.

**Record questionnaire risk boundaries as policy.** `recordRiskBoundaries` writes `always-confirm` records with source `questionnaire`, providing the seam for ticket #16. Temporary exceptions never widen authority: a future temporary allow is bounded by expiresAt and cannot override `always-confirm`.

## Consequences

- Memory retrieval and policy authorization share SQLite lifecycle and migrations while reading separate tables. No new connection, production dependency or packaged resource is needed.
- Classification uses keyword matching over free text and can still misclassify: unusual phrasing can produce false positives, and paraphrases can be missed. The only effect of a miss is that a boundary is not looked up; the user still answers every permission themselves. Resource is always `*` until requests carry structured resources; text cannot reliably identify a path, repository or provider. Specific-resource boundaries apply to these unknown resources, while specific-resource allows do not.
- Policy records support expiry, revocation and retained history. The questionnaire can store boundaries without inferring grants from remembered statements.
- Explicit confirmation permits one dispatch and leaves the stored boundary in force. Supervision remains unable to answer a permission request even when a policy allows the risky action.
- `allow` records are stored for a future automatic-approval feature and have no dispatch consumer today. Every permission is answered by the user, and supervision follow-ups never approve anything. This relies on providers raising permission requests before executing risky actions requested in supervision messages; Sotto never executes commands itself.
