# Keep full runtime-folder identities in proof cleanup

October 9, 2026, PR #880. The first full suite after merging `main` at `558929679e5aff28d70c240c2e667eba2129e2f5` finished with 708 passing files, 54 skipped files, 8,816 passing tests and one failure. `tests/integration/proofCleanup.test.mjs` accepted a replacement of `other-existing` at its existing line 124 assertion. The script and test were identical to that pinned `main`.

A clean detached checkout at `D:/Talk to Text Application/.worktrees/proof-880-main-558929679` reproduced the same assertion. It used the main checkout's Vitest binary, without linking dependencies:

```text
"D:/Talk to Text Application/node_modules/.bin/vitest" run tests/integration/proofCleanup.test.mjs --maxWorkers=2
FreePhysicalMemory=8680372 KiB
FAIL rejects a replaced or missing pre-existing instance: live
FAIL rejects a replaced or missing pre-existing instance: other-existing
AssertionError: expected [Function] to throw an error
tests/integration/proofCleanup.test.mjs:124:70
Test Files 1 failed
Tests 2 failed | 11 passed | 3 skipped
```

Two preceding isolated runs on the clean main checkout passed; the third failed as above. An isolated merged-tree run passed too. The throwaway checkout was removed with `git worktree remove` after the proof.

The guard compared `statSync`'s numeric device and inode values. NTFS file IDs exceed JavaScript's integer precision. A new regression, next to the replacement cases, compares the captured identity with the real filesystem's full bigint identity. It failed before the fix:

```text
preserves the full filesystem identity rather than rounded Windows file IDs
Expected ino: 1987213335577503814n
Received ino: 1987213335577503700
Tests 1 failed | 16 skipped
```

`snapshotProofInstances` now requests `{ bigint: true }`. The identity map remains internal to the existing preservation checks; its callers do not serialize these values. Renamed, missing and replaced folders are still refused, unrelated folders are still preserved, and the owned instance must still be gone. No deadline, capability skip or cleanup ownership rule changed.

The complete original suite plus the new regression passed after the fix: **14 passed, 3 skipped**, one file, 761 ms. Its skips require Linux with a working user systemd manager. Free memory was 7,534,716 KiB. Temporary instrumentation was removed. Final whole-tree gate results are recorded in the fixtures/setup merge note.

Before pushing this follow-up, typecheck passed in 39.70 s, lint in 20.53 s, build in 16.42 s, the complete cleanup suite passed again (14 passed, 3 skipped), and the manifest verifier reported 144 exact deterministic tuples. Every run checked free memory first; the lowest was 6,096,308 KiB. The earlier setup E2E and onboarding design results still apply: this change touches only proof-process cleanup, outside the app and capture helpers.
