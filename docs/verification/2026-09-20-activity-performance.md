# Retained activity performance verification

Date: September 20, 2026. Windows. Base: `865e9484d0c7cf15f1516c8153c888ec7ea56b48`.

## Scope and recent PR audit

The installed 0.1.10 app retained roughly 24 MiB of command output in a roughly 25 MiB workspace JSON file. Its measured full snapshot copy took about 33-35 ms, and preparing one organization save copied the archive again before roughly 73-80 ms of JSON encoding. Seven workspace file replacements were observed in eight seconds. These are measurements from the preceding live investigation, not a matched patched-app CPU benchmark.

Recent PRs #145, #152, #155, #156, #158, #159 and #160 improve neighboring paths. Snapshot batching, smaller agent configuration writes, prepared statements and renderer batching do not remove retained activity from workspace persistence. This fix starts from the fetched main containing those changes. #164 concerns question choices; open #165 concerns queue steering.

Activity is now retained incrementally in the existing SQLite database. The bounded timeline, order, nested records and history epochs are preserved. Legacy JSON is imported before its copy is removed. Failed migration remains recoverable. Unchanged organization saves are skipped only against a successfully completed write. Internal snapshot copies isolate mutable containers without serializing immutable output strings.

## Regression evidence

- The initial reproduction failed for retained activity in JSON, five repeated organization writes, and erased output returning after history was re-enabled.
- Four threads with 96 retained records each (roughly 24 MiB total): changing one activity encodes exactly one activity record and performs zero organization JSON writes. Restart preserves the other records. This deterministic work bound is asserted without a stopwatch.
- Snapshot tests compare schema data with structuredClone, exercise writable nested containers and shared references, and handle an own __proto__ field safely. The 24 MiB copy benchmark reports the median of five samples; its timing assertion is opt-in.
- Storage tests exercise ordering, reset epochs, unchanged updates, independent returned objects, rollback/retry, erasure, and replay suppression after quitting with history disabled.
- Workspace tests exercise interrupted migration, save retry, overlapping A-to-B-to-A saves, privacy changes during storage failures, history disabled on first legacy startup, restart before re-enabling, and failed re-enabling without a plaintext fallback.
- Native Codex integration checks retained commands, diffs, errors, child lifecycle and restart without duplicate final answers. It checks database rows and SQLite/WAL bytes for privacy erasure.
- A fixture shutdown used twice by existing restart tests now shares one shutdown promise, avoiding calls into a disposed host.

## Built Electron journey

`npm run build` succeeded. `npx playwright test tests/e2e/activity-persistence.spec.ts tests/e2e/thread-workspace.spec.ts --workers=1` finished with three passes and two baseline failures.

The new journey starts with a legacy workspace, reads the saved message and expanded command output in the real Electron app, confirms the output is absent from organization JSON, quits, and repeats after a full restart. Manual prompt/permission separation and the settled-work shelf also pass.

Captures: `artifacts/activity-performance/migrated.png` and `artifacts/activity-performance/restarted.png` (ignored generated artifacts). Both captures were visually inspected at a 1280 by 800 logical window: retained message, expanded command/output and composer are readable, with no clipping. No appearance changes or design baseline regeneration were required.

The existing failures reproduce identically on a clean detached checkout of the base commit, with its own npm ci and build:

- `thread-workspace.spec.ts:52`: queued messages advance instead of remaining Paused.
- `thread-workspace.spec.ts:87`: a queued skill draft is empty after reload.

Baseline command: `npx playwright test tests/e2e/thread-workspace.spec.ts --grep 'a saved draft elsewhere|a queued follow-up' --workers=1` (two failures). The performance patch does not edit those expectations or the queue implementation.

## Review and limitations

Independent standards and spec reviews identified privacy failure paths. The final implementation erases durable history even if activity synchronization fails, persists identity-only suppression while history is disabled, records legacy identities before disabled startup removes the JSON payload, and prevents private live activity becoming a JSON fallback after failed re-enabling. Both reviewers found no remaining issues in those paths; the spec reviewer independently reran the 24 affected persistence tests.

The installed app and active user threads were not replaced or restarted. This verifies the isolated Windows build and fixture workloads; the CPU improvement for the user's live four-thread session remains unmeasured. No live provider charges, macOS validation, renderer redesign, durability weakening or dependency additions are part of this change.

## Final gates

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test -- --maxWorkers=2`: 308 files passed, 17 skipped; 4,017 tests passed, 34 skipped; zero failures (328.75 s).
- `npm run notices:verify`: passed, 174 components.
- `npm run build`: passed. Electron journeys: three passed and the two baseline failures described above.
- `SOTTO_PERF_ASSERT=1 npx vitest run tests/unit/main/cloneHostSnapshot.test.ts --maxWorkers=1`: five passed.
- `git diff --check`: clean.

Final standalone measurement used the actual TypeScript-transpiled helper on four threads, each with 96 records and 65,536-character output strings (24 MiB total), Node 24.14.1 on this Windows machine. Median of 11 copies: structuredClone 23.555 ms; cloneHostSnapshot 0.152 ms, about 155 times faster for this operation. This measures snapshot copying only, not whole-app CPU or provider execution. The unit fixture independently checks semantic equivalence and its opt-in timing threshold.


## Integration with current main and PR review

PR #167 integrates main at `93b2f0f5`, including #164, #165 and #166. Merge resolution preserves ephemeral monitoring exclusion, question-choice documentation, and the retained activity handoff before Claude resumes a transcript cursor. The eight combined activity migration, thread workspace and monitoring Electron cases pass after integration; the two queue failures documented above are historical findings from the earlier base, now fixed by #165.

Independent integration review caught the distinction between missing and known-empty activity. SQLite now records that a list was observed even when it is empty or has no epoch; unchanged empty lists cause no further writes, and erasure removes the marker. Legacy missing versus empty activity survives repeated restarts.

Greptile review identified interrupted saves where SQLite committed newer activity but organization JSON retained an older epoch or removed records. Five reproductions failed before the correction. Startup now trusts the committed whole list and epoch, including an empty/unversioned list, and avoids importing stale legacy messages into a newer epoch. The regression covers two successive restarts and verifies message history is preserved. The four-file persistence/cursor regression run passes all 51 tests. Final GitHub Gates (Windows) and automated reviews are required on the pushed revision before merge.
