# Activity history performance

Original request: check recent PRs for the measured CPU bottleneck; if it remains, fix it without regressions.

Base: `865e9484d0c7cf15f1516c8153c888ec7ea56b48`, fetched main on September 20, 2026. PRs #145, #152, #155, #156, #158, #159 and #160 address neighboring work; none removes activity from workspace saves. Open #164/#165 concern composer behavior. Root checkout and installed app remain untouched.

Acceptance checks:

- [x] Identify already-shipped fixes before implementing.
- [x] Reproduce retained activity in JSON, repeated organization saves, and off/on history revival with failing tests.
- [x] Persist changed activity independently in existing SQLite, preserving ordering, retained output, migration and restart.
- [x] Keep writable snapshot isolation while avoiding large immutable string copies.
- [x] Do not weaken FULL durability, add dependencies, change permissions or lose user history.
- [x] Cover failed migration/save retry and overlapping command saves.
- [x] Full typecheck, lint, suite with two workers, notices.
- [x] Built Windows Electron migration/restart journey and rendered inspection.
- [x] Independent standards and spec review, resolve findings.

Decision: amend ADR-0016 to keep bounded activity records alongside messages. Small organization JSON saves remain ordered and are skipped only against the last successful save. Hashes of erased activity identities prevent provider replay restoring removed output. Snapshot copies retain string values while isolating every mutable container. No UI redesign or new network host.

Verification: [activity performance evidence](../verification/2026-09-20-activity-performance.md). The full suite passed 4,017 tests; the two neighboring queue E2E failures also reproduce on the clean base. The installed app is unchanged.
