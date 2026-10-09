# Terminal truths (#879)

Checked on Windows 11 in this worktree's built Electron app, Sotto 0.1.34, on October 9, 2026. Fixtures use isolated temporary profiles, real Windows shells and Git worktrees, and scripted Claude Code, Codex and Grok commands that exit with code 7. No provider account or model turn is involved.

## What was proved

- Eight new regression failures against the original implementation cover all six issue requirements. Two additional pre-fix failures reproduce reclamation racing a branch read and a cancelled restart. A further regression reproduced two restarts taking Terminal mode's last active slot while another checkout was being reclaimed; the capacity check now follows the asynchronous checkout check. Four more failures reproduce duplicate reopened Tools/drawer tabs when events precede the reply. The final focused run passed 135 tests in seven files.
- Tools and drawer shells use main's total across every thread and both places, including ended shells. Both stores ignore an older list's capacity when a newer event has arrived; a close frees a slot. A full empty drawer offers the same explanation instead of claiming a shell is starting.
- The shared shell resolver prefers PowerShell 7 on PATH and falls back to Windows PowerShell. Injected macOS and Linux paths cover the login shell and provider launch. The macOS pane names Command+C for copy and Ctrl+C for interruption.
- The normal New terminal dialog opens a shell. Each of the three scripted provider commands then exits with its code visible; the same terminal accepts a real command at the interactive shell in the same folder. Close reclaims each clean native worktree. Unit tests over real Git separately prove that the branch remains, Reopen restores the checkout, and dirty or protected ignored files stay.
- A running Tools shell is quit and restored through a fresh Electron process. Its restored snapshot is Interrupted with empty output; the notice says what was lost and Reopen starts a fresh shell. Ended drawer hints seed the remaining slots without opening 32 PTYs: the populated Tools surface shows the shared-limit explanation, Reopen works at capacity, and ending a shell frees a slot.
- Reclamation holds the checkout reservation while checking every thread reference and live Tools/drawer shell, including a shell in an older binding. Another Terminal-mode shell also keeps the checkout. New shells cannot start under removal; Close waits for its in-flight branch read, and a cancelled restart cannot recreate the folder.
- The existing closed-shelf, drawer, truecolor, redraw, keyboard and renderer-recovery journeys remain covered. The loading fixture now accepts a host-qualified thread ID, as the other terminal specs do.

## Captures inspected

- [Provider exit at 820×560, dark](../../artifacts/terminal-truths/provider-exit-820-dark.png): Codex's scripted exit code, the next successful shell command and the unchanged working folder are visible.
- [Restored shell at 820×560, light](../../artifacts/terminal-truths/interrupted-820-light.png): the global-limit guidance and “Ended when Sotto closed. Nothing it showed was kept.” wrap within their existing notices; Reopen remains visible and reachable.

The display and loading journeys also render dark and light at 1600×1000, 1280×800 and 820×560 with reduced motion. Their minimum-size screenshots were inspected; loading-message contrast is checked against 4.5:1. The new shared-limit notice's solid foreground and background colors measure 5.63:1 in its retained light capture. Only the two captures above are retained for this change. Existing capture baselines were not intentionally changed.

## Limits

macOS and Linux behavior is covered through the services' platform injection, not a native desktop run. This lane does not package, install or run a paid provider CLI. The local throwaway copy/state prototype is `.cache/terminal-truths/copy-prototype.html`; the issue's explicit no-new-UI instruction kept the existing layout. It is not committed or pushed.

The initial Electron run had five passes and two fixture failures: the new worktree journey used a non-Git fixture folder, which correctly fell back to shared, and the old loading journey looked only for an unqualified thread ID. After correcting both setups, the affected five journeys passed. Temporary diagnostics were removed.

The subsequent four-spec run had six passes and one failure in the added global-limit recovery journey. Reopen had duplicated the new shell in the renderer when its session event and the old shell's close event preceded the reply. The locator correctly refused two identical close buttons. The store now reconciles that ID once; the deterministic regression covers both event orders in both places. The test keeps its strict single-button assertion.

## Two-axis review

Separate Codex reviewers ran `gpt-6.1-sol` at max reasoning on the pinned diff. The spec review found two P2 issues: another thread could still reference a reclaimed checkout, and a cancelled restart could restore the folder after Close. The standards review found one P2 issue: a disabled New button's title was the only populated-surface limit explanation keyboard users could get. All three are fixed, with regressions. Its nonblocking P3 duplication finding is also fixed by reusing `bareEntityId` outside serialized browser callbacks.

The Windows read-only reviewer sandbox failed to read files, so both reviewers retried on exported numbered sources and the diff, using the same model and reasoning. They ran no tests. The supplied material included AGENTS.md and the changed glossary/ADR hunks, but not the full CONTEXT.md, CI document or ADR bodies, or screenshot pixels. The implementing agent separately read those documents, inspected the captures and ran the gates. Review-fix tests cover the final changes; the independent reports assessed the preceding implementation.

## Final gates

| Command | Result |
| --- | --- |
| `npm run typecheck` | Pass: three TypeScript projects, zero diagnostics. |
| `npm run lint` | Pass: zero errors or warnings. |
| `npm test -- --maxWorkers=2` | Pass: 624 files passed, 51 skipped; 9,261 tests passed, 222 skipped, zero failures. The full suite ran once, in 1,370.06 seconds. |
| `npm run notices:verify` | Pass: 174 components verified. |

The single full-suite run completed before the native journey exposed the final Reopen event-order fix. After that fix, all 135 focused tests in seven files passed with at most two workers, and typecheck and lint were rerun. An earlier typecheck found two narrow test-mock return annotations; both are corrected. The pinned starting base is `e7e853235`; the shared `origin/main` ref advanced while this lane ran.

| Native gate | Result |
| --- | --- |
| `npm run build` | Pass: main, host, preload and renderer built; 582, 185, 144 and 4,786 modules transformed respectively. |
| `npx playwright test tests/e2e/pane-terminal.spec.ts tests/e2e/terminal-closed-output.spec.ts tests/e2e/terminal-display.spec.ts tests/e2e/terminal-loading.spec.ts` | Pass: seven tests, zero failures or skips, one worker (1.5 minutes). Ran immediately after the build with `&&`. |

Per spec: pane-terminal **1/1**, terminal-closed-output **3/3**, terminal-display **1/1**, terminal-loading **2/2**. The saved captures inspected above come from this final run. The working tree's regenerated older baselines were restored; only this lane's two new captures are retained. The changed text files pass the UTF-8 BOM and whitespace checks.
