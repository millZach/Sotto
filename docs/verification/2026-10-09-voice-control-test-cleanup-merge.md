# Merge the test suite cleanup into voice removal

October 9, 2026, Windows 11. Merged main at `0c34255c6eadb03a52e01fbf908aca6f5da8e51a` (PR #866) into `feat/remove-voice-control` (PR #880). The merge commit is `9e2871566`; `2fc59dcd0` corrects moved-suite citations found by both independent review axes. Production source and the lockfile are unchanged by this merge. Runtime dependencies remain exactly `node-pty` and `zod`; no reinstall was needed.

## Conflict resolutions

| File | Resolution |
| --- | --- |
| `eslint.config.mjs` | Keep both the removal evidence ignore and #866's e2e-runs ignore. |
| `package.json` | Use moved host/socket test paths; keep assets:verify and remove every voice script and dependency. |
| `tests/e2e/agent-attention.spec.ts` | Keep deleted. |
| `tests/e2e/agentAnswers.spec.ts` | Keep the manual answer/draft journey; discard retired widget and Agents-room paths. |
| `tests/e2e/agentSetup.spec.ts` | Keep manual Threads connection error/retry; use #866's evidence helper. |
| `tests/e2e/agentVoice.spec.ts` | Keep deleted. |
| `tests/e2e/agents.spec.ts` | Keep new-thread defaults and projects; discard voice and dormant reasoning journeys. |
| `tests/e2e/appearance-evidence.spec.ts` | Keep manual Threads and dictation evidence; use #866's evidence helper. |
| `tests/e2e/crossing.spec.ts` | Keep the manual composer journey and surviving settings; keep #866's evidence paths. |
| `tests/e2e/effort-picker.spec.ts` | Use ordinary launch and #866's evidence helper. |
| `tests/e2e/multi-provider-live.spec.ts` | Remove voice setup; retain #866's disposable evidence path. |
| `tests/e2e/pill-controls.spec.ts` | Keep dictation-only capsule controls and #866's evidence path. |
| `tests/e2e/screenshot-paste.spec.ts` | Assert assignments are absent; keep #866's evidence path. |
| `tests/e2e/settings-index.spec.ts` | Use ordinary launch and one import of #866's relocated evidence helper. |
| `tests/e2e/settings-mode-row.spec.ts` | Keep two-tab keyboard/layout checks; route screenshots and geometry through #866's helper. |
| `tests/e2e/theme-branding-evidence.spec.ts` | Keep #866's name and evidence path; test the Threads owl and dictation sliver. |
| `tests/e2e/thread-creation.spec.ts` | Keep isolated manual draft/profile journeys and cleanup; use #866's evidence paths. |
| `tests/e2e/thread-workspace.spec.ts` | Keep manual draft/queue journeys, discard Agents-room checks, and use #866's evidence path. |
| `tests/e2e/voice-home-recovery.spec.ts` | Keep deleted. |
| `tests/fixtures/phaseTwoReview/agentContextStub.ts` | Keep #866's deletion; no surviving imports. |
| `tests/fixtures/phaseTwoReview/main.tsx` | Keep #866's deletion; no surviving imports. |
| `tests/unit/renderer/hostIdentity.test.tsx` | Keep removal assertions and import the relocated renderer fixture. |
| `tests/unit/renderer/threadHandoffFocus.test.tsx` | Keep deleted. |
| `tests/unit/renderer/threadsView.test.tsx` | Keep removal cases and import the relocated renderer fixture. |
| `tests/unit/renderer/widgetApp.test.tsx` | Keep dictation-only cases; discard imports used only by deleted agent-widget tests. |

The renamed copy of the deleted disabled-coordinator remote spec stays deleted; its surviving manual replacement is `tests/e2e/remote-thread-opening.spec.ts`. No active test imports the deleted voice journey or phaseTwoReview harness. The removal plan and earlier verification note now use the moved test locations.

## Gates

The requested gates ran in this order after `515405a5d`, all with exit code 0. Production code and the lockfile remain unchanged.

| Command | Real result |
| --- | --- |
| `npm run typecheck` | Three TypeScript projects pass. |
| `npm run lint` | ESLint passes. |
| `npm test -- --maxWorkers=2` | 604 files passed, 51 skipped; 8,620 tests passed, 222 skipped; 1,180.18 seconds. |
| `npm run notices:verify` | Verified 155 third-party notice components. |
| `npm run build` | Main, preload and renderer builds pass; final renderer build reports 11.17 seconds. |
| Requested 16 Playwright spec files, `--reporter=line` | 29 passed (2.0m), one worker. |
| `SOTTO_THEME_EVIDENCE=1 SOTTO_THEME_BRANDING_EVIDENCE=1 npx playwright test tests/e2e/theme-palettes-evidence.spec.ts tests/e2e/theme-branding-evidence.spec.ts --reporter=line` | 7 passed (34.3s), one worker. |
| `node scripts/verify-design-captures.mjs` | Verified 144 exact deterministic design-review tuples. |

The requested Electron batch used widget-dictation, pill-controls, dictation-focus, dictation-retry, settings-index, settings-mode-row, agentSetup, agentControl, agentAnswers, agents, crossing, effort-picker, screenshot-paste, thread-creation, remote-thread-opening and thread-sidebar-question under their current spec names.

An additional `npm run assets:verify` passes: Claude SDK 0.3.270 history helper assets and seven terminal assets. No voice scripts or voice runtime dependencies remain. Production dependencies are exactly `node-pty` and `zod`.

Final full-suite output:

```text
Test Files  604 passed | 51 skipped (655)
     Tests  8620 passed | 222 skipped (8842)
  Duration  1180.18s
```

## Failures and main comparisons

No failure was waived as pre-existing. All final gates above are green.

- The first typecheck found a duplicate evidenceDirectory import in settings-index from conflict resolution. Removed the duplicate; subsequent typechecks and lint pass. This was a resolution error, not a baseline claim.
- The first complete two-worker run passed 8,619 tests, skipped 222 and failed `threadTitles.test.ts:334`, the older-thread case: expected Workshop, received The palette is unreadable in dark mode. The isolated branch file passed all 18 cases. Clean main at the merged commit passed the file thirteen times and passed the single older-thread case (17 other cases skipped). The original failure was not reproduced on main, so it is not declared pre-existing. The final complete branch run passes all title cases.
- A second full branch run hit the default 15-second deadline in recursive initialized-submodule reclaim, dirty-hidden initialized-submodule reclaim, and bare-repository-under-dependencies cases in `threadWorktrees.test.ts`. That red run was stopped before its final aggregate summary to shorten diagnosis. Another clean main checkout passed all 92 cases in the complete threadWorktrees and gitStatus files at the same two-worker cap. The same failures were not reproduced on main. Commit `515405a5d` gives initialized-submodule and bare-repository fixtures the existing 60-second allowance of their neighboring nested-repository cases. Assertions, test inputs and worker count are unchanged; the final full gate passes.

Both main comparisons used clean detached checkouts at `0c34255c6eadb03a52e01fbf908aca6f5da8e51a` under `D:/Talk to Text Application/.worktrees/voice-cleanup-main-proof`, created with `git worktree add --detach`. Git status was clean before the probes. There was no node_modules link; Vitest used the main checkout's binary:

```powershell
& 'D:/Talk to Text Application/node_modules/.bin/vitest.cmd' run tests/unit/main/threadTitles.test.ts --maxWorkers=2
& 'D:/Talk to Text Application/node_modules/.bin/vitest.cmd' run tests/unit/main/threadTitles.test.ts -t 'leaves an older thread alone' --maxWorkers=2
& 'D:/Talk to Text Application/node_modules/.bin/vitest.cmd' run tests/unit/main/threadWorktrees.test.ts tests/unit/main/gitStatus.test.ts --maxWorkers=2
```

Each proof checkout was removed with `git worktree remove` after the comparison. No other branch or worktree was changed.

## Rendered checks

Inspected this build's actual Settings/Dictation and Appearance screenshots at 820x560 in light and dark, and Threads in Nocturne dark at 1600x1000. The two-room switch fits, labels stay inside their controls, theme columns fit and content scrolls normally. The requested layout journey also checks 1280x800 and 1600x1000, both modes and reduced motion. Theme evidence covers every built-in half, mark and dictation-widget colors, error colors and restart persistence.

All new captures remain under ignored `artifacts/e2e-runs/`. Playwright left tracked files unchanged, so no generated tracked output needed restoring. No design baselines were regenerated.

## Standards

Sol (`gpt-6.1-sol`), max reasoning, read-only Codex CLI. One low-priority finding: grouped test citations still implied the old folders. Fixed in `2fc59dcd0`. No other material integration findings. A focused review of `515405a5d` found no standards breach or judgment smell; its allowance follows the generous-deadline rule.

## Spec

Sol (`gpt-6.1-sol`), max reasoning, separate read-only Codex CLI. The same citation finding, fixed in `2fc59dcd0`. No code integration defects or scope creep reported. A focused review of `515405a5d` found no spec finding; the assertions, inputs and product behavior stay intact.

Local logs and disposable captures are under ignored `artifacts/e2e-runs/`. The installed app, live provider accounts and other platforms are outside this test-only merge's verification.
