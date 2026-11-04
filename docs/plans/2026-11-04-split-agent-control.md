# Splitting up AgentControl

`AgentControl` in `src/main/agents/control.ts` is about 7,100 lines. This plan moves out the parts that hold their own state and call back the least, under a size budget (ADR-0190), then stops at a checkpoint. It removes about 1,400 lines. The send path, about 2,400 lines, gets its own design after that.

Zach picked this plan on November 4, 2026. It changes nothing a user sees.

## Why this order

Every part of the class shares `state`, `dependencies`, `disposed` and the outbox, so `AgentControl` stays the owner of `state`. The figures are rough: methods grouped by line range and counted with a script, on November 4.

| PR | Module | Lines moved | Calls back into `AgentControl` | Lines changed in the last 7 days |
|---|---|---|---|---|
| 1 | Size budget test | none | n/a | n/a |
| 2 | State and detail publishers (`coalesce…`) | ~150 | 0 | 0% |
| 3 | Client updates | ~285 | 6 | 9% |
| 4 | Thread titles | ~140 | 8 | 13% |
| 5 | Thread detail | ~255 | 3 | 11% |
| 6 | Broadcast | ~250 | 15 (10 to thread detail) | about 10% |
| 7 | Saved file: reading and writing `agents.json` and Watcher's file | ~340 | 4 | 18% |

Saved file comes last because it reads the most shared state (39 fields), and tests replace its `persist` method 26 times.

## Rules for every move

- **Move only.** No behaviour changes, and tests stay as they are unless a test names the moved code's location, such as a module mock. The existing tests are the proof. `git diff --color-moved` shows what moved.
- **Narrow inputs.** A module gets a small typed set of what it needs, never the `AgentControl` itself.
- **No extra copying.** A module reads `state` through a getter. `copySites.json` counts shift between files and their total does not rise.
- **Plain classes.** Follow `requestWaits.ts`. Nothing varies behind these modules yet, so they have no port.
- **Tests move afterwards.** 34 test files cast `AgentControl` to reach its private members, 85 times in all. Thin pass-through methods stay at first, then a follow-up moves a module's tests to its interface and removes them.
- **Lower the cap.** Each PR lowers `control.ts`'s cap in `tests/fixtures/codeSizeBudget.json` to the new size plus about 13 KB and adds the new module (ADR-0190).

## Checkpoint after PR 7

The file should be about 5,700 lines, which alone does not fix it. Check whether moved modules stayed small, whether agents and tests found them easier to work in, and how many conflicts the moves caused.

Out of this plan until then:

- **Watcher's section, about 480 lines.** 45% of this block changed in the last 7 days, so moving it now would conflict constantly. It waits for a quieter stretch.
- **The send path, about 2,400 lines.** Admission, `execute` (498 lines), `dispatchPending` (278), `pumpFollowups` (273), answers, drafts and set-aside. These call each other heavily and rely on ordering, and the permission checks of ADR-0004 run here. Compare a few designs before committing to one.
- **Attachment and media methods, about 145 lines.** They have no state of their own and may only forward calls. A module has to pass the deletion test.

## Risks

- **Conflicts.** At about 630 commits a week, big moves collide. Each PR covers one region, starts from fresh `main` and merges quickly.
- **Start and stop order.** `start` and `dispose` touch nearly everything, so a module's timers and waits stop in the same order as before.
- **Performance.** Thread detail and broadcast run on the update path, so `streamingCopyBudget` and `ownerScaleWorkBudget` pass unchanged on PRs 5 and 6.
