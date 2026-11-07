# Tips are removed

Accepted by Zach on November 5, 2026, answering a prototype card about where a thread's tip should sit: "Remove tips, not a useful feature." It supersedes [ADR-0159](0159-tips-come-from-what-they-point-at.md). **Number provisional until merge** (docs/agents/domain.md).

## Decision

**Tips go, and everything only they used goes with them.** That is the tip row under a running turn's working line and under Watcher's, its Try it and Hide, the tips and their documentation sources (`tips.tsx`, `tipsSetAside.ts`, `tipSources.json`), the weekly **Tip sources** workflow and `scripts/check-tip-sources.mjs`, Settings › Threads › **Show tips** (`threadTips`) and **Show hidden tips again** with their Find a setting entry, the `thread-tips` Owl entry (ADR-0072), and their tests. The working line is as ADR-0134 left it, with nothing under its words but the turn's steps.

**Nothing is migrated.** A saved settings file that still holds `threadTips` loads as before: Sotto reads only the keys it has, and the old key is gone from the file at the next save. The tips a user hid or used stay in the window's storage under `sotto.tips.setAside.`, and nothing reads or clears them. No notice says tips are gone.

## Consequences

- Sotto shows nothing under the working words that the turn did not report.
- The prototype stays at the tag `prototype/thread-tips`. The verification note and its captures went with the feature and stay in the history before this change.
- Bringing tips back would be a new decision, not a revert.
