# Native target reads: regression evidence

September 12, 2026. Implementation baseline: `6175989`. This records the backend portion of #24; renderer submission feedback and real native UI verification are separate integration work.

## Source and design

The official T3 source was inspected at `d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3`, including the body of [`getThreadDetailSnapshot`](https://github.com/pingdotgg/t3code/blob/d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3/apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts#L3537-L3584), alongside the pinned native-thread source study. Its useful distinction is the separately scoped thread-detail read, with a consistent state boundary. Sotto implements that distinction against its own adapters and durable identity/outbox stores. No T3 implementation or runtime dependency was copied.

`AgentHost.refreshThread(id)` refreshes only the requested native thread and returns the full cached snapshot, preserving the coordinator's snapshot contract. The thread registry maps Sotto IDs before delegating; provider selection forwards the call to the active adapter. Generic test adapters without the optional method can still use `snapshot()`. All three native adapters implement the targeted method.

Manual prompts, managed drafts, uncertain-send reconciliation and dispatch confirmation use target reads. Explicit broad refresh, catalog discovery and background history polling remain available. Observation calls remain intact. This change does not add concurrent coordinator command lanes or change branding and presentation.

## Reproduction and hypotheses

Before the fix, this command ran against the real coordinator and native adapters, replacing only an unrelated history I/O boundary with a held gate:

```powershell
npx vitest run tests/unit/main/agentTargetRefresh.test.ts tests/integration/nativeTargetRefresh.test.ts
```

All four original cases failed in 1.93 seconds: the coordinator exceeded its 200 ms check, and each native adapter exceeded its 250 ms check while waiting for the unrelated gate. The native fixtures still used their real child-process protocol and disk persistence. The gate was released only during cleanup. These checks demonstrate a dependency, not production network latency.

Ranked falsifiable hypotheses recorded after the red run and before implementation:

1. Broad adapter traversal or a global in-flight history promise causes blocking. A target-only native read should allow prompt acknowledgement before the unrelated gate is released.
2. Coordinator pre-send/post-send snapshots independently cause blocking. Fixing only the native adapter should still leave the coordinator regression red.
3. Shared provider execution or metadata persistence imposes an independent dependency. The native regression should remain red after removing broad reads if this is the cause.

The target-only changes made both kinds of test pass. No change to shared command serialization or durable persistence was needed to pass the held-history scenario. This supports the first two hypotheses for this reproducible pattern; it does not attribute the earlier observed 10,829 ms production send to individual stages.

## Authority and delivery checks

- Target reads use a per-thread fresh-read queue: they cannot join an unrelated in-flight read. Claude retains its existing per-log queue. Codex's guarded log read drains to the captured file size using bounded buffers; background polling keeps its byte budget.
- Codex refresh reads native thread status/history, retries a read invalidated by live events, and ignores timed-out/obsolete read callbacks. Final dispatch checks re-poll authored input after the durable origin write, before registering that text as Sotto's own input. Live native requests/status remain authoritative.
- Claude and Grok recheck target history and pending requests after the durable origin write. An undispatched origin is removed on rejection. A new test first demonstrated that a permission arriving in this interval could otherwise be bypassed in both adapters.
- Pure pre-dispatch history timeouts reject as unsent. Tests first demonstrated Codex/Grok incorrectly reporting these as uncertain despite never writing a prompt. Genuine prompt acknowledgement loss still retains its origin/outbox identity and is never automatically resent.
- Added coverage includes manual and managed confirmation before an unrelated gate releases, identity-wrapper delegation, all three native adapters, permission arrival during origin persistence, Codex live completion during a stale read, and takeover input beyond the background byte budget. Existing adapter contracts, recovery, delivery, navigation and settings tests cover neighboring behavior.

The held-history checks pass with the unrelated gate still closed. This is a synthetic dependency regression result; no real-provider latency percentile or native UI completion claim is made here.

## Validation result

The final added regression suite passed **14 tests in 3 files** in 4.61 seconds:

```powershell
npx vitest run tests/unit/main/agentTargetRefresh.test.ts tests/unit/main/codexTargetLog.test.ts tests/integration/nativeTargetRefresh.test.ts --maxWorkers=1
```

Node typechecking and ESLint on every changed TypeScript file passed. An earlier focused native/recovery run passed 158 tests in 10 files. The expanded serial check ran 14 files: 219 passed, 2 skipped, and 2 existing Codex recovery tests failed while polling durable metadata. One failure included Windows `EPERM` replacing `codex-threads.json`; the other observed an outbox file still containing its entry after the in-memory draft cleared.

To distinguish that failure from this implementation, the exact late-rejection/outbox tests were run on a clean detached `6175989` worktree. The first baseline run passed; the second reproduced the same late-rejection assertion and `AtomicJsonStore` rename `EPERM`. Thus a pre-existing intermittent Windows persistence failure is independently confirmed. No storage or fixture workaround is included in this change. The full expanded run is not reported as passing; the integration owner has the baseline evidence for storage follow-up.

## Separate Windows persistence fix

The integration owner subsequently authorized a bounded storage fix for that demonstrated blocker. The target-read implementation above was left unchanged.

The local test runtime is Node `24.14.1`, libuv `1.51.0`, on Windows. That libuv version implements rename using [`MoveFileExW` with replacement](https://github.com/libuv/libuv/blob/v1.51.0/src/win/fs.c#L2109-L2115). Its [Windows error mapping](https://github.com/libuv/libuv/blob/v1.51.0/src/win/error.c#L62-L167) maps access denial to `EPERM` and lock/sharing violations to `EBUSY`. The captured Sotto failure was `EPERM`; the particular process or handle causing it was not identified. A transient handle conflict is an explanation consistent with the intermittent evidence, not a verified attribution to antivirus or a particular reader.

Before the storage fix, `npx vitest run tests/unit/main/atomicJsonStoreRename.test.ts --maxWorkers=1` failed both deterministic cases in 307 ms. Each case injected exactly one rename denial after the real temporary file had been written and synced; the next rename would have succeeded. The existing store rejected immediately.

Ranked hypotheses recorded after that red run and before the fix:

1. A transient Windows rename denial causes the failure. Retrying the same source/destination should preserve the old document until atomic replacement succeeds.
2. A permanent permission denial can have the same code. It must still fail after a bounded wait, preserve the original, and clean the temporary file.
3. An unrelated filesystem or queue failure requires different handling. Non-Windows denials and unrelated error codes must fail immediately; subsequent queued operations must remain usable.

`AtomicJsonStore` now retries only its final atomic rename, only on Windows, and only for `EPERM` or `EBUSY`. Five backoff delays of 10, 20, 40, 80 and 160 ms permit six rename attempts. The 310 ms bound covers scheduled backoff, not a guarantee about filesystem-call or scheduler duration. Every attempt uses the same already-written, synced and closed temporary file. The destination is never unlinked, rewritten in place, or copied over. Permanent errors retain the existing failure/temporary-cleanup path, and the operation queue remains serialized.

Verification after this separate fix:

- `atomicJsonStoreRename.test.ts` plus the existing `atomicJsonStore.test.ts`: **35 passed, 1 skipped** in 2.86 seconds. The skip is the existing Windows symlink-permission case. New coverage checks both transient codes, bounded permanent denial, same temporary-file reuse, original-file preservation, temporary cleanup, immediate unrelated/platform-specific failures, and queued write ordering.
- The original `codexHost.test.ts` cases matching `late send acknowledgement|rejection arrives after the deadline`: **both passed in five consecutive runs**, with no fixture or provider changes.
- Node typechecking, ESLint on both changed TypeScript files, and `git diff --check` passed.

No full suite was run for the storage follow-up. The bounded retry addresses temporary replacement denials; permanent filesystem failure still reaches the caller rather than being reported as durable success.
