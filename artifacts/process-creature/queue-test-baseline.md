# Existing queue-test races

Verified on untouched main 865e9484 in a separate detached worktree, with its own npm ci, runtime:prepare and build. No production source changes.

The first thread-workspace scenario failed expecting Paused after ready; the queue instead sent. A synthetic state probe showed resumeAfterTurnId unknown because the test queued after optimistic UI feedback while the coordinator still saw idle. Waiting for host Docs status running before queueing preserved all original assertions and passed.

The second scenario failed expecting the saved skill draft after reload but received an empty composer. Waiting for the first native send to report running before installing the next saved draft preserved all original assertions and passed.

Baseline commands: npx playwright test tests/e2e/thread-workspace.spec.ts -g "a saved draft elsewhere" and -g "a queued follow-up keeps its skill". Each failed unmodified and passed in a temporary copy with the condition-based wait. The copied probes were removed. The feature branch subsequently passed all four scenarios twice (eight passes).
