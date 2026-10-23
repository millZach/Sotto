# Terminal mode removed

Checked October 22, 2026, on Windows 11, for [ADR-0111](../adr/0111-terminal-mode-is-removed.md).

The built app was captured with `node scripts/capture-design.mjs` after `npm run build`. The populated Threads page at 1080x720, dark:

- Before: [the committed baseline](../../artifacts/design/app-review/baseline/threads-populated.png), with the Threads | Terminal switch between the wordmark and Add project.
- After: [threads-populated-after.png](../../artifacts/remove-terminal-mode/threads-populated-after.png). The switch is gone. The wordmark still pushes Add project, New thread and Collapse sidebar to the row's end, so they stay where they were and no gap opens. The rest of the capture matches the baseline.

The capture run also reported onboarding, scaling and widget captures as changed. Those differences were already on `main` (onboarding's first step now says "the speech model you choose" where the baseline says "Parakeet v3"), have nothing to do with the sidebar, and are left for a baseline refresh of their own. The baselines were not regenerated here.
