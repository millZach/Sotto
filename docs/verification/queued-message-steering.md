# Queued message steering

Verified on Windows, September 20, 2026, in an isolated worktree based on main at `e29cd544`. No live paid provider turn or macOS run was performed.

## Behavior

Steer now appears beside each queued message while its thread runs and its provider supports steering. The action names the queue item, so main reads its saved content and retains edits, image attachments, skills and file references. Main durably claims the item before dispatch. Other queued messages and newer composer text stay untouched. Duplicate clicks cannot send it twice. Refusal retains the message as Not sent; uncertain delivery remains immutable across restart. A late confirmation removes the selected message even when it was behind another queue item.

The command uses the thread lane, existing provider steering and authority checks. No permission is answered, host added, key introduced or provider protocol changed.

## Evidence

- Red regression: `npx vitest run tests/unit/renderer/threadQueueSkills.test.tsx -t 'offers steering' --maxWorkers=2` failed because the queued row had no Steer now button.
- Final focused run: `npx vitest run tests/unit/main/followups.test.ts tests/unit/main/agentCommandLanes.test.ts tests/unit/renderer/threadQueueSkills.test.tsx tests/unit/renderer/threadQueuePolish.test.tsx tests/integration/nativeFollowupOutcomes.test.ts --maxWorkers=2`: 86 passed.
- `npm run build`: passed.
- `node node_modules/@playwright/test/cli.js test tests/e2e/queued-steering.spec.ts --reporter=line --output=artifacts/queued-steering/playwright`: passed against the built Electron app. The synthetic provider received both selected messages in the same running turn. Keyboard focus returned to the queue, then to the composer when the last item left. The newer draft survived both actions. Reduced motion was enabled for the steering actions.
- `npm run lint`: passed on the final run. `npm run notices:verify`: passed, 174 components.
- Source review: the UI checks provider support, connectivity, running state, requests, busy state and pending delivery. Main revalidates before dispatch and the queue claim rejects already-dispatched items. The non-head late-confirmation gap found during review was fixed and covered.

## Rendered review

Inspected dark and light captures at 1600x1000, 1280x800 and 820x560: [dark minimum](../../artifacts/queued-steering/dark-820.png), [light minimum](../../artifacts/queued-steering/light-820.png), and the 1280/1600 captures in the same directory. The new secondary action sits beside its message before the existing reorder/edit/remove controls. Figtree and theme-derived colors are retained. There is no added animation; existing arrival behavior remains. Controls fit without horizontal queue overflow at all sizes. The minimum-size view retains both message labels and all controls.

The affected queue adds one action label per message, with no companion copy. In the two-message fixture its text purposes are the queue count, two message labels and two action labels (five); existing icon controls retain their accessible names. The transcript's existing queued echoes remain intentional delivery feedback. The composer and transcript remain the dominant workspace; no new surface or visual direction was introduced.

## Pull request review

Independent standards and spec reviews found no code defects. The standards review requested fresh isolated-checkout evidence; the six captures are retained with this note. Existing design baselines were not regenerated.

## Isolated gates

- `npm run typecheck`, `npm run lint`, `npm run notices:verify`: passed.
- `npm test -- --maxWorkers=2`: 3,982 passed, 34 skipped; 305 test files passed, 17 skipped.
- Neighboring `composer-short-window.spec.ts`: the keyboard test passed. The attached-image test fails at line 66 because it expects `16px` and the current stylesheet renders `15px`. The same command fails at the same assertion on untouched main `e29cd544` in an independently installed and built worktree. The steering change does not alter prompt typography.

## Review follow-up

Greptile identified a renderer/main mismatch for settled projects. A focused regression reproduced enabled steering for both a settled project and an individually settled workspace thread. The action now uses the same `isWorkspaceThreadSettled` helper as main, and neither case dispatches a command. The initial full local gate counts above refer to `59721254`; latest-revision CI is tracked on PR #165.

After this fix, both queue UI suites passed (44 tests); typecheck and lint passed.

The final-build keyboard repeat initially pressed the next action before delivery released its busy state. The test now asserts the action is enabled before pressing Enter. Three traced repetitions passed after this synchronization change.

## Synchronize the desktop check after resizing

October 11, 2026, during [PR #934](https://github.com/millZach/Sotto/pull/934). [Windows desktop run 38178628223](https://github.com/millZach/Sotto/actions/runs/38178628223/job/114586322649) failed while capturing the first 820×560 queue. The saved context still shows a running turn and two queued messages, with the queue collapsed. The test waited for renderer width, then read `aria-expanded` before React received the short-window media-query update. It could therefore skip opening the queue and wait for rows that had just been hidden.

The fixture now asserts the first short-window collapse before opening the queue. It also waits for each submitted item to appear with an enabled Steer now action before entering the next one; an initial Linux verification attempt exposed that second admission race (one row instead of two). All original row visibility, width, draft preservation, turn identity, keyboard and final-message assertions remain, with their existing deadlines. Production and platform behavior are unchanged.

The unchanged isolated Linux case passed once (3.6 seconds), which does not clear the Windows race. The final repaired case passed through `scripts/verify-shell-plumbing.mjs` in the private-bus, nested-only sandbox: **1 passed in 3.3 seconds**. Both 820×560 captures were opened and inspected; both queued rows and the newer draft fit in Light and Dark. The proof stopped its owned compositor and process, emptied all recorded cgroups, removed `/tmp/sp-J73m6J` and preserved all four protected live trees. No portal service activated. No baseline was regenerated; the six ordinary captures remain disposable E2E evidence. Fresh typecheck and lint passed before pushing; the final-head Windows CI result is recorded in PR #934.
