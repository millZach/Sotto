# The coordinator has a code size budget

## Status

Accepted November 4, 2026, by Zach's pick of the plan in [docs/plans/2026-11-04-split-agent-control.md](../plans/2026-11-04-split-agent-control.md). **Number provisional until merge** (docs/agents/domain.md).

## Context

`AgentControl` in `src/main/agents/control.ts` is about 7,100 lines with about 190 fields, and it is the file that changes most: 502 commits touched it in the 60 days to November 4, 2026. New behaviour lands there because everything it needs is already there, so the file only grows. Smaller modules beside it, such as `requestWaits.ts`, show the shape that works, and nothing asks anyone to reach for it.

## Decision

**1. Listed files have a cap.** `tests/unit/main/codeSizeBudget.test.ts` fails when a file on `tests/fixtures/codeSizeBudget.json` holds more code than its cap, or when a listed file is gone. It runs in the normal test gate.

**2. The size is characters of code.** Comments and indentation do not count. A line count would reward cramming, since about 300 of the file's lines already run past 160 characters. Counting comments would reward deleting the ones that say why.

**3. Caps only tighten.** A pull request that moves code out lowers the cap to the new size plus about 13 KB, which leaves room for ordinary features, so everyday pull requests do not conflict on the list. A raise needs its reason in the PR.

**4. A module taken out of a listed file goes on the list.** Otherwise the growth only moves. `workspace.ts` and `watcher.ts` are not listed yet, and each can be added with a line.

## Consequences

A feature that would take `control.ts` over its cap moves something out first, or says in its PR why it cannot. The test measures size, not design: code can be moved out and still be tangled, which the plan's rules for each move are there to prevent.
