# Restore Codex replies after restart

- [x] Reproduce the reported user-only opening window against the Codex adapter and real thread store.
- [x] Confirm stored assistant replies survive in the affected local profile, using metadata only.
- [x] Prevent native user receipts from becoming duplicate saved messages.
- [x] Repair already saved duplicates using exact native identity and stored content equality; preserve event history and outside input.
- [x] Verify repair against a temporary SQLite backup of the affected profile: nine affected threads, fifty duplicate receipts, zero assistant replies removed. One opening window goes from zero to sixty-four assistant messages.
- [x] Complete automated gates and inspect the rendered restored conversation. Focused tests, typecheck, lint, notices, build and Electron verification passed. Full suite: 6,250 passed; one unrelated local Git fixture push failed and passed on an isolated rerun.
- [x] Record verification and limitations. The installed application and original profile remain untouched.

No UI design changes. The existing transcript should show its original messages in its existing layout.

PR delivery:

- [x] Merge current `main` (0.1.26) into the repair branch.
- [x] Address review findings: shared saved-content validation, consistent native identity proof, negotiated remote events, and current documentation.
- [x] Verify seeded/unwatched repairs, ambiguous native IDs, different saved words, legacy remote clients, and the rebuilt Electron reconnect/reload journey.
Delivery: open the PR, finish the final gates, resolve valid review findings, and merge with a merge commit only once green. Then delete the remote branch and remove the owned worktree. The PR records delivery status.
