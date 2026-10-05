# Computer Use connection guidance

The native pipe failure is connection evidence, not proof that Codex is closed. The reported case had Codex open and a Full access thread: Codex had restarted, replaced its named pipe, and Sotto's existing runtime still held the old address. A fresh connection worked. This patch changes the diagnosis and recovery words only; automatic connection refresh is separate work.

Sotto now says: "Computer Use connection is unavailable. Keep Codex open and try again. If this continues, restart Sotto when your other threads are idle." It preserves the provider's own failure underneath. It does not claim that no earlier action happened: a compound call can type before a later connection failure. Sandbox-specific advice and the distinction between sandboxed and Full access process crashes stay as before. Permission answers are unchanged.

## Prototype decision

The throwaway logic prototype is preserved on local branch `prototype/computer-use-guidance`, commit `c1402e9b`, at `src/main/agents/computer-use-guidance.prototype.html`. It uses a pure guidance function, in-memory state, free play and tabbed walkthroughs for app closed, app open with a stale connection, sandbox failure and an unrelated failure. The prototype worktree was removed after capture; a preview copy was inspected in headless Chromium. Verdict: closed and stale connections need the same connection advice; evidence cannot distinguish them or establish whether earlier input happened. The production activity row needs no new control or style.

## Verification

- Before the fix, `npx vitest run tests/unit/main/codexComputerUse.test.ts --maxWorkers=2` failed 2 tests and passed 8. The failures displayed the previous app-open message where connection guidance was expected.
- After the fix, the same 10 tests passed. Combined with `codexActivity.test.ts`, 20 tests passed across 2 files. These cover projected errors from provider text and error fields, stale connection variants, sandbox failures, Full access crashes, authorization errors, unrelated failures and ordinary JavaScript tool calls.
- `npm test -- --maxWorkers=2` passed: 541 files passed and 40 skipped; 7,369 tests passed and 156 skipped (1,330.88 seconds).
- `npm run typecheck`, `npm run lint`, `npm run notices:verify` (174 components) and `npm run build` passed.
- `npx playwright test tests/e2e/computer-use-guidance.spec.ts` passed 1 test. It launched the actual built Electron application with an isolated synthetic saved activity, opened the failure using Enter, checked the guidance and retained provider failure, and collapsed it using Enter. At 1600x1000, 1280x800 and 820x560 in dark and light appearance with reduced motion, transcript horizontal overflow was zero and the error remained within the viewport. The screenshots were inspected: guidance wraps without clipping, including at the minimum size.

Cited captures:

- [1600x1000 dark](../../artifacts/computer-use-guidance/1600-1000-dark.png)
- [820x560 dark](../../artifacts/computer-use-guidance/820-560-dark.png)
- [820x560 light](../../artifacts/computer-use-guidance/820-560-light.png)

The retained activity fixture is deliberately disconnected; it proves presentation, not live Computer Use recovery. No live typing, clicking or permission answers were performed by this verification. No design baselines were changed. Historical verification notes remain unchanged.

Before merging, the branch incorporated the separately reviewed connection-refresh fix from PR #737. Only their shared README paragraph conflicted; it now preserves both behaviors. Typecheck and the combined refresh, Computer Use and activity regression suites passed (29 tests across three files). CI checks this combined revision; the guidance PR merges after #737 so its final diff contains only the guidance change.
