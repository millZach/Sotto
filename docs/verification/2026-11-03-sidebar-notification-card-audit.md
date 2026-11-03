# Sidebar and notification card audit

This audit follows [PR #1964](https://github.com/millZach/Sotto/pull/1964), merge `a1d27757`, and ADR-0144. It checks card lifetime, hidden Watcher news in previews, empty content and statements about data a provider did not supply. It adds no feature or permission.

## Defects fixed

- **A new limit failure could create a restart card for a settled or archived thread.** `LimitRestart.read` recorded the new failure before checking whether the thread was closed. With no reset time, that record had no timer to remove it. The closed-thread check now precedes recording a stop, while still remembering the observed turn so reopening does not treat an old failure as new. Regressions cover settled timestamps, the settled override and archives, with and without a reset, both an existing record and a first stop.
- **Another thread's stop could recreate a restart card for Watcher history.** At a provider's first stop, `LimitRestart.stopped` also recorded threads with background work. That path did not exclude read-only Watcher history. `Workspace.setWatcherKind` retains background work, so this is a reachable state. If history was read before the failing sibling, its cleanup had already run. The background-work path now applies the same history exclusion as #1964. Regressions put history first, with and without a reset, and check that only the worker is persisted.
- **Claude Code's failure notice promised a reset time elsewhere when none was supplied.** `claudeUsageLimitSentence(undefined)` said “Claude Code shows when.” It now says Claude Code did not say when its limit resets, using the existing restart-strip wording. The supplied-time sentence and recognition of saved older notices stay covered.

## Cards and previews audited

| Surface | Evidence and result |
| --- | --- |
| Restart bands, composer strip and row status | `RestartStopped.tsx`, `restartWords.ts`, `limitRestart.ts`: bands disappear for no groups; strips return nothing without a record; unknown resets offer no timed restart. The two record-creation defects above are fixed at the owner of the state. |
| Subscription limit cards and usage overview | `UsageSubscriptions.tsx`, `UsageOverview.tsx`, `usagePresentation.ts`: missing windows have text; missing usage stays unknown; reset labels and time markers depend on supplied metadata; expired windows are filtered. No additional defect proved. |
| Failed-turn and provider-upgrade recovery notices | `FailedTurnNotice.tsx`, `ProviderUpgradeNotice.tsx`, `ThreadsView.tsx`: closed, busy, loading or request-owned failures do not render a competing notice; recovered drafts require actual text or attachments. The unknown-reset sentence above is fixed. |
| Saved request-draft recovery | `requests/RequestDraftRecovery.tsx`: matches current requests and their definitions, guards asynchronous results by owner, returns nothing for no recoverable content and no error. No defect proved. |
| Storage recovery alerts and toast cards | `recoveryNoticeCenter.ts`, `AppContext.tsx`, `ToastRegion.tsx`: resolved notices publish a clear; cleared codes prevent an older startup snapshot from reviving them. An empty live region contains no card and remains for accessibility. No defect proved. |
| Needs You cards and thread-list previews | `NeedsYouQueue.tsx`, `ThreadSidebar.tsx`, `threadFacts.ts`, `control.ts`, `workspace.ts`, `watcherNews.ts`, `threadAlerts.ts`: cards derive current rows; excerpts use the presented summary; Watcher news is filtered before message, summary and generated-title presentation. Notifications use the presented title and fixed event sentences. #1964's title repair remains in place. No further leak or empty card proved. |

## Suspects left unchanged

- A reset beyond the eight-day scheduling horizon is represented like an absent reset and can receive the unknown-reset wording. No real provider reading demonstrating this was found. Preserving a separate reason would change the restart record contract; this audit leaves it unchanged.
- A renderer receiving a stale `scheduledRestart` from an older remote host could still show a band for a settled thread or Watcher history. The current host owns removal, including the fixes here; no current-host reproduction of a remaining stale snapshot was found. No duplicate renderer policy was added.
- Saved restart records do not retain the stopped turn ID. A different completed turn first observed after startup may be indistinguishable from the previously stopped turn. No reproduction establishing an unwanted card from the current persistence flow was found; the record format is unchanged.

## Verification

Before the fixes, the eight new restart cases failed at their stale-card assertions and the missing-reset sentence case failed at its exact wording assertion. With the fixes, separate `NODE_OPTIONS=--no-experimental-webstorage npx vitest run <file> --maxWorkers=1` invocations produced:

- `tests/unit/main/limitRestart.test.ts`: 26 passed.
- `tests/unit/shared/continueThread.test.ts`: 13 passed.
- `tests/unit/shared/interfaceCatalogs.test.ts`: 4 passed in 12.37 seconds on the final run. Its initial run alongside other checks hit the 120-second collection and 15-second parsing deadlines; the unchanged file passed when rerun after those checks finished. No deadline was changed.

`npm run typecheck`, `npm run lint` and `git diff --check` passed.

`npm run i18n:extract` completed without catalog changes. It emitted three warnings about the unchanged `COMMAND_NOTE` comments in `MessageContent.tsx`. No full suite, Playwright, design captures or app launch is part of this audit, as requested. There is no layout or styling change and no screenshot claim.

Assumptions: current provider and host snapshots are the source of truth; existing permission and Owl gates remain authoritative. Unproved candidates above are reported rather than patched.
