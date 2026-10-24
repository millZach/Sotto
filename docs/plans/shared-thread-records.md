# A thread record kept through every layer (#925)

The plan behind ADR-0016's proposed amendment of October 24, 2026. **It is a draft for Zach's review. Nothing here is built until he picks an option.**

## The problem

On every streamed chunk, five steps between an adapter and the window build a new record for every thread. They are the adapter's view and copy, the Sotto identity wrapper, the provider switch, the workspace's accept and the host stamp. Because every record arrives new, the workspace's publication then walks every thread to prove it unchanged. In the October 23 recording (0.1.38-owl.20261023.3, about 529 threads) that was about 12 s of a 44.7 s busy minute, 27% of main, and it grows with the threads rather than with what changed. The ADR amendment has the breakdown and the four options.

## Recommendation: option 1

Keep a record's identity through every layer:
- An adapter publishes frozen per-thread records and reuses the record of a thread that did not change.
- Each later layer hands out the same output for the same input.
- The workspace keeps a thread's merged record while nothing about that thread moved.

An update then costs one identity check per thread plus the threads that changed. Nothing a user sees changes, so there is no prototype.

## How it would be built

One pull request per step, each tightening the counting gates. Each step can ship alone and does no harm without the next.

1. **Gates first.**
   - `ownerScaleWorkBudget.perf.test.ts` gains "thread records built per streamed update". Today it is about every thread at every layer. The target is the threads that changed: 1 or 3 in its scenarios.
   - `streamingCopyBudget.perf.test.ts` gains the same count at 20 and 200 threads, which must not grow with the threads.
   - A verifying mode in the owner-scale fixture rebuilds every reused record fresh and compares the two, so a stale record fails the gate.
2. **Adapters.**
   - Each adapter (Claude, Codex, Grok, Devin, Muse, OpenCode) marks a thread changed on every path that changes its state.
   - Its activity view reuses the frozen record of an unmarked thread, and `cloneActivitySnapshot` stops copying records that are already frozen and owned.
   - A shared helper beside `ActivitySubscribers` holds the per-thread cache, so each adapter only supplies its marking.
   - Adapters that cannot mark yet keep today's path. The later layers then do what they do today for those threads.
3. **The wrapper and the provider switch.**
   - `mapSnapshot` in `threads.ts` and `aggregate` in `providerSwitch.ts` keep a per-thread map from input record to output record, with the bound ID or the provider as part of the key.
   - The switch's aggregate list stays its own.
4. **The workspace.**
   - `accept` stops re-spreading earlier threads.
   - It keeps a thread's merged record when the incoming record and the workspace's own state for that thread are unchanged.
   - Its own state includes the thread's messages, activities, worktree, Git action, pull requests and the other fields it lays over the provider's.
   - `activityPublication`'s `immutableUpdates` then stops at identity.
5. **The host stamp.** `stampHostSnapshot` and the router keep the stamped record per input record.

Each step finds and replaces any in-place write into a record it now shares. ES modules run in strict mode, so a write into a frozen record throws, and the suite finds such writes.

## What it means for #1457

Do this first, then design #1457 around it:
- With identity kept, the workspace knows which threads changed on each publish, so its saves and event batch can look only at those.
- A thread-store worker can be sent just the changed threads' events and records, so moving the store off main costs in proportion to the change.
- Opening a stored thread can read and parse its list on that worker and swap the frozen records in whole.

## Risks

- **A stale record.** An adapter path that changes a thread without marking it leaves the window showing an old record. The verifying mode in step 1 is the guard, and the adapter contract (`tests/integration/adapterContract.ts`) would gain a check that every state change publishes a changed record.
- **A write into a shared record.** A layer that writes into a record it now shares throws in strict mode. Tests find these, and each is replaced with a new record, as #1326 and #1334 did.
- **Memory.** Each layer keeps one record per thread, which is what it holds today for one publish, now kept between publishes.

## Questions for Zach

- **Option:** is option 1 the one to build, or would you rather weigh option 2, publishing only what changed?
- **Order:** should #925 go before #1457, as recommended?
