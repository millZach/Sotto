# Check each checkout path once per ownership decision

October 5, 2026. Scope: `WorkspaceHost.ownsCheckoutAlone`, following ADR-0014 and ADR-0041.

Each ownership decision now shares a checkout-identity promise for an exact path. The map exists only inside that decision. Missing-folder parent discovery and every ownership refusal remain in place. A later rename or removal reads identities again.

The regression creates thirty additional threads in one shared project folder. That folder is checked once in the first removal decision. Before a second removal decision, its reported identity changes to the owned checkout; removal is refused before reclaim runs. This proves reduced operation count and fresh ownership checks, not a measured end-to-end typing latency improvement.

The built Electron app passed the thread-worktrees.spec.ts journey named "a worktree can be reclaimed from the pane or on settle, keeps its branch, and comes back on the next send" (1 test, 24.3 seconds). It checks manual removal, confirmations for local files, settlement, branch preservation and next-send restoration. The current run's reclaimed Working copy screenshot was visually inspected at 1280x800; the folder-removed message and next-send recovery remained readable. Routine screenshots were restored to their committed bytes because this change has no intended visual difference. Existing evidence is in `artifacts/reclaim-worktrees/`; those committed images are previous captures, not new evidence from this run.

Build, typecheck, lint and third-party notices passed. The full two-worker unit/integration suite passed: 544 files passed, 40 skipped; 7,428 tests passed, 156 skipped (1,015.35 seconds). Parent review of the isolated source/test diff found no standards or scope findings. No live-provider scenario or subjective typing-latency measurement was run for this change.
