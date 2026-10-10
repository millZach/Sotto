# Terminal truths (#879)

Windows built Electron app: **VERIFIED**. Native macOS and Linux desktop: **NOT VERIFIED**. Checked Sotto 0.1.34 on October 9, 2026, using the Windows build at `a92a2edb2`. The final merged revision is `16909d9f1`, including `origin/main` at `09ea3f423`; its Windows/npm source and test trees are identical to the verified build. Isolated temporary profiles use real Windows shells and Git worktrees, with scripted Claude Code, Codex and Grok commands that exit with code 7. No paid provider account or model turn is involved.

## What was proved

- Restored Tools/drawer shells have empty output and say that nothing was kept. Main supplies the shared 32-shell count across both places and every thread, including ended shells. Reopen works at capacity, and closing a shell frees a slot. Event-order regressions prevent duplicated reopened tabs and stale capacity responses.
- All three surfaces use one shell rule: PowerShell 7 on PATH, otherwise Windows PowerShell; platform-injected tests cover the macOS/Linux shell choices and launch syntax. The macOS hint separates Command+C copying from Ctrl+C interruption.
- The normal New terminal dialog opens a shell. Each of the three scripted provider commands reports its exit code and leaves an interactive shell accepting a command in the same folder. Close reclaims each clean native worktree. Real-Git service tests separately prove branch retention, restoration on Reopen, and preservation of dirty or protected local work.
- Close holds removal against sends, Git work, new shells and new thread references. Draft working-copy selection and thread creation reserve an existing destination through inspection and publication; both are refused while removal holds it, and retry succeeds after release. Shared project folders and reused worktrees are covered. Existing idle threads, another Terminal-mode shell and a Tools/drawer shell in an older binding keep the checkout.
- Close waits for owned-folder preparation before checking reclaimed metadata. A held Reopen restoration failed before the fix because no second reclamation happened; it now reclaims the restored folder without starting another process. Restart's branch lookup belongs to preparation, including a previous lifecycle's pending read. Held branch-read regressions failed on early removal and pass after the fix.
- Concurrent discovered-shell validations cannot dereference a cleared cache. A deferred-check regression reproduced the null-path exception; both calls now share replacement lookup and select the same fallback.
- Tools/drawer checkout refusals name removal, a Git action, an automatic pull or a checkpoint revert, explain that the terminal did not start, and ask for retry after it finishes. Service tests exercise the actual reservation, confirm no spawn or retained capacity, and then start successfully after release.
- The Tools and drawer refusal journeys script only the IPC response and drive the actual preload, renderer, existing notice and keyboard retry. Dark/light and reduced motion are checked at 1600x1000, 1280x800 and 820x560. Screenshot inspection caught a clipped drawer sentence despite a partial-visibility assertion passing. Internal scrolling preserves the explanation and existing layout; the stronger check requires the whole alert inside the drawer after scrolling.
- The broader focused run exposed an unnecessary reclamation wait for a shared-folder terminal. Restoring the no-owned-worktree early exit fixes the held-launcher cancellation deadlock without bypassing preparation for an owned restored folder.
- The Closed shelf, drawer keyboard path, truecolor/redraw and view-load recovery remain covered in the final native run. The post-merge focused run passed 143 tests across eight terminal and checkout test files, including the moved workspace mutation tests.

## Captures inspected

- [Provider exit at 820x560, dark](../../artifacts/terminal-truths/provider-exit-820-dark.png): Codex's exit code 7, the successful next shell command and its unchanged worktree folder.
- [Restored shell at 820x560, light](../../artifacts/terminal-truths/interrupted-820-light.png): shared-limit guidance, the honest empty-output notice and reachable Reopen.
- [Tools refusal at 820x560, light](../../artifacts/terminal-truths/busy-tools-820-light.png): the active operation, retry guidance and focused Start terminal.
- [Drawer refusal at 820x560, dark](../../artifacts/terminal-truths/busy-drawer-820-dark.png): the complete recovery sentence and retry button within the drawer after internal scrolling.

The new refusal captures at larger sizes and the minimum light/dark variants were inspected too. Display/loading journeys retain their existing contrast assertions. No design baselines were regenerated. Main's shared evidence helper keeps ordinary run captures under ignored `artifacts/e2e-runs/`. The four images named above were refreshed from the merged run; no other captures are retained for this change.

## Two-axis review before the merge

The supplied standards/spec reports contained five unique findings; restoration and branch-drain findings appeared in both. All five were confirmed with reproductions and fixed in separate commits. None was rejected.

The final independent review used Sol (`gpt-6.1-sol`) at max reasoning, one reviewer per axis, on the pinned diff from `e7e853235` to `5e34bbbc0`. The initial prompts exceeded the CLI character limit and were retried with numbered relevant coordinator excerpts and complete other supplied sources. Windows read-only exec initialization failed. The spec reviewer used the exported diff/sources; the standards reviewer found a read-only Node fallback and read the exact pinned diff and sources. Neither changed files or ran tests/builds.

Both found the earlier-lifecycle branch-read variant, fixed by retaining prior preparation in Restart. Follow-up reviews through `c1396f8b2` and `b8b6cec7d` report no unresolved code findings. The proposed generic exception rename was rejected because `CheckoutSendRefusal` specifically identifies the `send` reservation; read/mutation reservations use `GitActionRefusal`. Its inaccurate provider-only comment was corrected, and the reviewer withdrew the naming suggestion. This note fixes the finding that verification counts still described an earlier revision.

The earlier run could not complete native Forge verification: two SSH attempts required a Tailscale identity check and timed out before any remote command executed. Native Linux verification remains outstanding before a PR under AGENTS.md and ADR-0062. This merge update runs the owner's requested Windows gates below; no pull request was opened.

## Merge and Windows gates

The default-subject merge commit is `a92a2edb2`: **Merge remote-tracking branch 'origin/main' into fix/terminal-truths**. It preserves main's voice-control removal, cleanup model, split suites, shared fixtures, Linux packaging and Omarchy shell integration alongside #879.

Nine files conflicted. `eslint.config.mjs` keeps both sets of ignores. `checkoutMutations.ts` drops main's removed assignment kinds while retaining the terminal-start holder. The two terminal e2e specs retain this branch's new tests and ID handling with main's prompt and evidence helpers; removed speech configuration stays removed. The main and renderer terminal-workspace suites keep the new regressions with shared IPC, deferred, state and view fixtures. The drawer, store and surface suites use main's terminal bridge fixture with this branch's capacity data and regressions. The fixture's default list now supplies the capacity required by the merged schema.

Git carried the branch's workspace mutation regressions into `tests/integration/workspaceMutations.test.ts`; the deleted unit file was not restored. All 26 literal test titles added by this branch are present in the merged layout. Main's removed voice modules were not restored.

While the gates ran, another worktree refreshed the shared `origin/main` ref to `09ea3f423` (#904, iPhone Markdown tables). A second default-subject merge, `16909d9f1`, carries that Swift and documentation change without conflicts. Git object hashes match the verified revision for `src/`, `tests/`, `scripts/`, `resources/`, `build/`, both dependency files, and the build, TypeScript, Vitest, Playwright and ESLint configurations. The full suite remains at one run. After the second merge, a fresh `npm ci` passed again and the two npm suites that read the changed guide and CI documentation passed all 34 tests.

| Command | Exact result |
| --- | --- |
| `npm ci` | Exit 0 after each merge: 840 packages installed, 841 audited; fresh worktree dependencies, no link to another checkout. The final install took 56.80 seconds. |
| `npm run typecheck` | Exit 0: all three TypeScript projects, no diagnostics. |
| `npm run lint` | Exit 0: no errors or warnings. |
| Focused terminal and checkout Vitest run, `--maxWorkers=2` | Exit 0: 8 files passed; 143 tests passed; zero failures or skips; 34.15 seconds. |
| `npm test -- --maxWorkers=2` | Exit 0: 714 files passed, 55 skipped; 8,902 tests passed, 276 skipped; zero failures. One full run, 1,199.14 seconds. |
| Post-merge documentation checks, `--maxWorkers=2` | Exit 0 on `16909d9f1`: 2 files passed; 34 tests passed; zero failures or skips; 2.37 seconds. |
| `npm run notices:verify` | Exit 0: 182 components verified. |
| `npm run build` | Exit 0: main, host, preload and renderer built. |
| `npx playwright test tests/e2e/pane-terminal.spec.ts tests/e2e/terminal-closed-output.spec.ts tests/e2e/terminal-display.spec.ts tests/e2e/terminal-loading.spec.ts` | Exit 0: 9 passed, zero failures or skips, one worker, 1.0 minute as reported by Playwright. Ran immediately after build with `&&`; the combined command took 84.45 seconds. |

Per spec: pane-terminal **1/1**, terminal-closed-output **5/5**, terminal-display **1/1**, terminal-loading **2/2**. The full Windows gates and native journeys used merge revision `a92a2edb2`; the identical Windows/npm trees in `16909d9f1` retain that evidence. The additional fresh install and documentation checks ran on `16909d9f1`. Follow-up evidence commits change only this note and the four inspected captures. Changed text files are UTF-8 without a BOM; `git diff 09ea3f423 --check` passes.

The first build/Electron invocation was interrupted by the ignored Python log wrapper's Windows console encoding when Vite printed a checkmark. The wrapper was changed to emit UTF-8, and the complete build/Electron command then passed. No product source fix was needed, and the full suite was not repeated.

## Limits

macOS/Linux behavior is covered by platform injection, not a native desktop run. No packaged installer or release was exercised. The native Windows provider-exit journey uses real ConPTY with scripted clients, not paid provider turns. The UI refusal journeys script IPC rather than driving a live Git removal from the UI; service regressions exercise the actual checkout guard.

Local throwaway prototypes under `.cache/terminal-truths/` compared copy and drawer overflow. The issue's explicit no-new-UI instruction kept the existing surface, and this run authorizes only `fix/terminal-truths`, so no prototype branch or tag was published. No user-selected variant is claimed; the reversible copy and scrolling choices followed the supplied review and observed clipping.
