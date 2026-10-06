# Bounded desktop quit (#492)

The desktop quit drain now has ten seconds to finish. Its listener runs before bootstrap, so a prevented quit keeps the native windows and tray. A settled drain resumes normal quit and bootstrap disposes the native runtime. A drain that reaches the deadline calls `app.exit()`, which closes the windows and releases the single-instance lock.

## Regression evidence

Before the fix, `npx vitest run tests/unit/main/quitDrain.test.ts --maxWorkers=2` failed three new checks: the two deadline cases never called exit, and bootstrap disposed the native runtime before the drain settled. After the fix, those checks pass. They also verify that a repeated quit does not restart the deadline, a late resolve or rejection does not quit again, and successful cleanup cancels the deadline.

`npx vitest run tests/unit/main/quitDrain.test.ts tests/integration/ipc.test.ts --maxWorkers=2` passed 141 checks, including existing startup cancellation and teardown failures.

The new check in `tests/e2e/app.spec.ts` launches the built Electron app, records that native windows remain when quit is prevented, waits for a clean process exit, and relaunches with the same profile. The first version of this test harness timed out; replacing its test-side file write during quit with a synchronous observation fixed the harness. The focused native quit and relaunch check then passed, and `npm run build` followed by `npx playwright test tests/e2e/app.spec.ts` passed all 16 journeys. Typecheck, lint and third-party notices also passed.

The [capture before quit](../../artifacts/review-quit-drain/before-quit.png) was inspected: onboarding and its native window controls render normally. This change adds no controls, copy, or styling to the app, and no design baselines were regenerated.

## Limits

The deadline and late completion cases use fake timers and held promises. No live provider was deliberately hung, and macOS was not exercised. Forced exit can interrupt a worktree sweep or unsaved write; the deadline applies to desktop shutdown, not the headless host.
