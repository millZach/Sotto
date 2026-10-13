# Reattaching a missing staged screenshot

Issue #385, verified on Windows on September 27, 2026. Production repair `58da4d28`, integrated with main `68f7974c`; final Electron test `b94925d6`.

A missing content file now invalidates its stale digest entry through the same guarded cleanup as damaged content. The next attachment of the same bytes writes a fresh file. A delayed read of the older missing or corrupt file cannot remove the replacement, and non-missing filesystem errors still propagate without discarding the image.

The desired-behavior baseline cases failed for both the stale store entry and same-image coordinator retry. After the repair, the two focused suites passed all 32 tests. They cover missing and corrupt content, deduplicated concurrent restaging, delayed old reads, restart, mismatched handles, host boundaries, and memory-only restaging with history off. No new per-stage file read or write was added to the successful deduplication path.

## Real desktop journey

The built Electron app passed both `tests/e2e/staged-images.spec.ts` journeys in 19.7 seconds: missing-image recovery (6.2 seconds) and the existing staged-image save/reload/restart journey (12.6 seconds). The latter checks light and dark at 1600 by 1000, 1280 by 800 and 820 by 560 with reduced motion.

The recovery journey pastes a real PNG into the composer, removes its file from the test's owned temporary profile, then reads the digest through the actual preload/main attachment-content bridge. That read returns null. This explicit boundary read matters: the scripted E2E provider does not resolve image bytes like a real adapter does. The test does not fabricate a refusal or substitute the coordinator.

The Send press produces the existing Not sent row and returns the image to the composer. Removing it and pasting the same PNG restores exactly the original bytes; sending then shows one submitted preview and clears the composer. The older failed-delivery row remains available to dismiss, as before. Unit coverage separately proves that only the repaired bytes reach the provider.

- [Missing content and recovery instructions](../../artifacts/review-385/missing.png).
- [One submitted preview after attaching again](../../artifacts/review-385/repaired.png).

Both saved captures were visually inspected. The recovery copy, attachment chip and submitted preview are legible; no product styling or design baseline changed. Only synthetic profiles, images and providers were used.

## Gates and review

Typecheck, lint, notices (174 components), runtime preparation and build passed. The full two-worker suite at `bc39f6a8` finished in 1,023.25 seconds: 5,740 passed, 131 skipped, one failure. The existing subagent workflow test queried a unique `phase-1-perf` description before its assignment detail settled and found two matching elements (`subagents.test.tsx:194`). Main already contains the causal fixture repair `56c064b2`, which holds/releases that detail explicitly. The run used a verified-absent owned `SOTTO_PERF_DATA` path; no personal-profile benchmark ran.

Main `53bb7910` was integrated at `f6bfa421`; only additive artifact-ignore entries conflicted, and the attachment production and regression files stayed unchanged. The integrated focused suites pass all 47 tests, including the 32 image cases and the 15 subagent tests with the incoming repair. Typecheck, lint and notices pass again on this integration. The original full run remains a recorded failure; final integrated CI is required before merge.

Two independent native GPT-6 Astra/high reviewers completed Standards and Spec reviews with no findings, and the root review agreed. Later test-only corrections aligned the deferred Buffer type with Node and the exact visible refusal with its delivery-row suffix. Cross-model review was not available; no such review is claimed.
