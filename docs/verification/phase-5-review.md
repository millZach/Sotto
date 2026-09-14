# Phase 5 independent review

Fixed point: `896c4e4bce223b616809adefdcd12fe9bfe42b7e`, the starting commit on `main`. Review covered the complete working-tree diff and new source/tests before the implementation commit. Independent Standards and Spec agents reviewed separately and rechecked fixes; their final rechecks overlapped. The existing two unrelated user screenshots were excluded.

## Standards

Three material findings, all resolved:

- Publication verification used the remote's fetch URL while push used its push URL. Both operations now use the same revalidated raw push destination, kept inside the main process; a split fetch/push regression verifies the behavior. Display and diagnostic URLs redact credentials.
- Claude's native compaction summary and command echo appeared as authored user messages and could trigger an incorrect takeover of managed work. Native synthetic metadata, compact command envelopes and dispatched input identities are excluded from authored history. Regression fixtures use observed native shapes; the final installed-client run retains only the original Sotto prompt as a user message.
- A completed Claude compaction could remain uncertain after losing its live acknowledgement. Persisted native boundaries are now observed on reconnect and correlated against the saved request time, with older boundaries excluded. Completion restores idle without resending the operation.

Final Standards reviewer: no outstanding findings and no additional material heuristic findings. Review checked source, regression assertions and native evidence; execution is documented in the implementation report.

## Spec

Two findings, both resolved:

- Keep full history incorrectly used persistent single-slot storage. It now matches pinned T3 with a renderer-session set of thread/context-snapshot keys. Tests retain multiple dismissed snapshots and pane remounts while ignoring dismissal data from earlier app sessions.
- Claude lacked completion recovery from a newer persisted boundary after a missed live acknowledgement. The corrected reconciliation and disconnect/reconnect regression satisfy the actual completion and no-replay requirements.

Final Spec reviewer: no outstanding findings; no additional definite violations of #61 or #71. Physical microphone testing is explicitly pending by the user's direction. Real GitHub writes were not part of authorized verification; owned local push and faithful API fixtures are documented separately.

Final tally: Standards 3 resolved, 0 outstanding; Spec 2 resolved, 0 outstanding. The recovery defect was independently found on both axes.
