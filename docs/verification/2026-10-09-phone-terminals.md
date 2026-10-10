# Terminal approvals on paired phones

Issue [#884](https://github.com/millZach/Sotto/issues/884), branch `feat/phone-terminals`, based on `origin/feat/terminal-agent-states`. Windows 11 on LAPTOP-RUSSH2J5, October 9, 2026. Source install used this worktree's own `npm ci`; no dependency link was made. No push or pull request is authorized in this run.

**Native iPhone surface: NOT VERIFIED.** Windows cannot compile Swift or run the simulator. Twelve SottoCore terminal cases, sixteen AppModel terminal cases and three terminal simulator journeys are written, but none was run here. The journeys name nine planned attachments, including Starting under Working; no simulator attachment was generated here. The Native iOS client (macOS) CI job is the compile/test check when the lead opens a pull request. Simulator screenshots remain a required follow-up; the HTML reference and desktop capture below are not simulator evidence. Android was left untouched because no JDK was found on PATH, through JAVA_HOME or in the standard Java/Microsoft/Adoptium/Android Studio locations.

## Reference inspected

The existing prototype was opened at `?variant=B` and its iPhone frame inspected. [Approved variant B](../../artifacts/phone-terminals/approved-variant-b.png) is a reference capture only. Its persistent native choices are historical illustration; ADR-0066 governs the actual one-time hook answers. The prototype source was preserved unchanged. Reproduce its capture with `node tools/capture-phone-terminal-prototype.mjs`.

## Built desktop and wire: VERIFIED

`tests/e2e/phone-terminals.spec.ts` launches the current built Electron app with an isolated profile, stand-in Tailscale and the native PTY running the synthetic Claude CLI. It turns on phone access, pairs a wire client through the issued code, opens Terminal mode and its real New terminal dialog, submits work and reaches the current native permission screen. [Desktop live approval](../../artifacts/phone-terminals/desktop-live-approval.png) was opened and visually inspected: the Needs you row, full-pane attention edge and live permission are visible without clipping.

The paired client opts into `terminals`, receives the row without screen text, reads the bounded approval preview, is refused with Can answer off, then sends No after the switch is enabled. Its response confirms the actual packaged helper's hook acknowledgement. A second answer is stale. This proves the built desktop path, not a native iPhone or real provider session. No terminal keystroke is sent by the phone path.

`tests/integration/phoneTerminals.test.ts` uses the real socket listener and terminal workspace with a scripted hook. Fifteen tests cover feature negotiation and older clients, omission of output from rows/pushes, bounded current screen reads, changed/reopened/expired targets, client-bound review, revocation and removal, concurrent answers, receipt reconciliation and payload replay protection, and foreground/background/disconnected visibility. Review regressions also distinguish question chrome from a permission, publish only changed/withdrawn fingerprints and report refused visibility observations. Existing terminal state and phone access journeys check their neighboring surfaces too. Their design captures were not adopted as new baselines because no desktop look change was intended.

## Gates and review

[The separate two-axis review record](2026-10-09-phone-terminals-review.md) reports Standards and Spec independently. Four concrete findings in each axis are corrected (the receipt and question findings overlap); one UI duplication heuristic is corrected and one transport duplication heuristic is deferred to a macOS-verified transport refactor. Native verification remains pending.

| Required gate | Latest result |
| --- | --- |
| `npm run typecheck` | PASS, exit 0; all three TypeScript configurations |
| `npm run lint` | PASS, exit 0; no lint findings |
| `npm test -- --maxWorkers=2` | PASS, exit 0; 630 files passed, 51 skipped (681); 9,416 tests passed, 222 skipped (9,638); 1,069.35 seconds; no unhandled errors |
| `npm run notices:verify` | PASS, exit 0; 174 notice components |
| `npm run build` | PASS, exit 0; four bundles |
| `npx playwright test tests/e2e/phone-terminals.spec.ts tests/e2e/phones.spec.ts tests/e2e/terminal-agent-states.spec.ts` | PASS, exit 0; 3 tests, one worker, 34.2 seconds |

The first completed full run returned exit 1: 627 files passed, one failed and 51 skipped (680 collected); 9,322 tests passed, one failed and 222 skipped (9,634 collected), plus one unhandled worker-exit error. The test failure was the exhaustive host-request catalogue, which omitted the three deliberately admitted terminal operations; commit `47b9a6eb0` updates that catalogue. The focused catalogue and phone protocol check then passed 24 tests in two files. The worker error had no test-file attribution or matching Windows Node crash event. Its cause was not established from the available evidence; it did not recur in the next completed run. An earlier unfinished run was stopped while applying the two-axis review corrections.

The next completed full run returned exit 1: 628 files passed, one failed and 51 skipped (680 collected); 9,411 tests passed, one failed and 222 skipped (9,634 collected). The existing `proofCleanup.test.mjs` folder-preservation case intermittently accepted a replaced directory. An isolated Windows reproduction showed different exact file IDs `9570149208426652` and `9570149208426653` rounding to the same JavaScript number. The helper now requests bigint identities; commit `d05deeff1` adds a deterministic regression that failed before the fix and passed afterwards. The focused regression and original cleanup suite passed 14 tests with 3 Linux-only skips in two files. A real-filesystem probe rejected 200 replacements on Windows. The corrected helper also preserved an unchanged folder and rejected its replacement on forge (Node v26.8.1), using only an owned temporary fixture; no desktop processes were launched. A subsequent full run passed with the same two-worker cap, as recorded below. Neither the preservation failure nor the earlier worker error recurred.

The next full run passed (exit 0): 630 files passed, 51 skipped (681); 9,413 tests passed, 222 skipped (9,635), in 1,082.83 seconds. The follow-up two-axis review then found an uncovered Yes/No structured-question overlap, described in the review record. Commit `e2ffe8ea2` fixes it, and the three new assertions failed before the correction and passed afterwards. The final full command then passed on that corrected source with the same two-worker cap and the counts in the table above. No unhandled error was reported.

The final combined `npm run build && npx playwright test tests/e2e/phone-terminals.spec.ts tests/e2e/phones.spec.ts tests/e2e/terminal-agent-states.spec.ts` passed (exit 0), transforming 588 main, 188 host, 144 preload and 4,786 renderer modules and passing all three tests with one worker in 34.2 seconds. The latest desktop approval capture was opened and visually inspected. Captures generated by the neighboring terminal state spec were restored because the desktop look was not changed intentionally.
