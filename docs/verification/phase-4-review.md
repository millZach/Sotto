# Phase 4 independent review

Fixed point: `d596d832ea2466bb515d58560f11dc410ff3df78`, the current-branch implementation baseline. Review covered the complete tracked and new working-tree source before the implementation commit. Separate reviewers ran concurrently against the six Phase 4 tickets, approved workspace plan, CLAUDE.md and repository ADRs. Unrelated existing user images were excluded.

## Standards

One P2 finding: Claude exposed its native session UUID as public `historyEpoch`, contrary to ADR-0002/0005's adapter boundary. Claude now persists a separate random UUID for the public history revision; Codex likewise uses an independent revision rather than concatenated native turn IDs. The Claude regression failed before the fix, then both adapter rollback suites passed (7 tests), including persisted restart identity and interrupted-write recovery. The Standards reviewer inspected the final changes and reported no outstanding findings or additional material Fowler-baseline smells.

## Spec

Three findings were fixed:

- P1: an interrupted checkpoint capture could include unrelated edits made while Sotto was closed. Persisted incomplete captures now become unavailable on restart, and the new regression verifies that no native rollback occurs and the unrelated file survives.
- P2: an existing prompt could not incorporate later corrections. The editor now detects a changed transcript and offers explicit regeneration while preserving the current draft until a successful replacement. The Electron regression appends a correction, verifies the existing edit remains, then generates from the latest discussion.
- P2: ambiguous lower cumulative Codex usage could establish a lower baseline and double-charge unseen replay. Durable high-water accounting now charges only previously unaccounted increments; regression assertions cover restart and historical observations.

The Spec reviewer inspected all three fixes and reported no outstanding findings. Human prompt-format review remains pending and the format is explicitly provisional.

Final tally: Standards 1 resolved, 0 outstanding; Spec 3 resolved, 0 outstanding. Integrated checks and remaining limitations are recorded in [phase-4-implementation.md](phase-4-implementation.md).
