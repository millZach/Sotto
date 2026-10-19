# Continue after an unconfirmed prompt

October 17, 2026. Windows laptop. Branch `fix/unconfirmed-send`, based on `f000d7612`; final runtime source `09e638e71`.

The installed app has not been replaced or restarted. Packaged Windows, live Muse, macOS and Linux recovery are **not verified**. The checks below drive the built Windows app with scripted provider effects and real coordinator, IPC, persistence and renderer.

## Failure and choice

A provider can lose the evidence needed to confirm a prompt. **Check again** reconciles the original, so it cannot resolve a prompt the provider no longer reports; every later message stayed blocked. The initial renderer regression reproduced the missing recovery action and disabled composer.

Zach chose **Continue with a new message**, without resending the old prompt. He rejected a standalone approximation and chose A in Sotto's actual Watcher layout: the action beside **Check again**. The throwaway A/B/C prototype is preserved separately in the local tag `prototype/unconfirmed-send-recovery-20261017`.

Recovery saves the choice before releasing the composer, preserves a newer draft, and keeps exact identity and delivery evidence. It grants nothing and never replays the old revision. Zach also chose to resume normal updates after a new message: a fresh explicit manual or queued prompt's exact confirmation releases only the recovery holds it follows. Rejected or uncertain new sends, request answers, messages in another thread and echoes of the original release nothing. Existing turn, permission, Stop and news-freshness guards remain.

## Built Windows journey

`tests/e2e/watcher.spec.ts`, **an unconfirmed prompt has a recovery in the actual Watcher room**, opens Watcher, sends a prompt with uncertain acknowledgement, removes its provider echo, types `hello`, reloads, and checks again. The new draft remains blocked until explicit recovery. Keyboard recovery returns focus to the composer, preserves `hello`, and leaves the old prompt **Set aside · Unconfirmed**. Reload retains the choice; Enter sends `hello` exactly once. Its confirmation releases the automatic-update hold while the old delivery stays uncertain. The journey then queues another user message, completes the current turn, explicitly denies a permission and answers a question.

The Watcher projection uses its existing fixture bridge. External provider effects are scripted. This proves recovery from missing evidence, not the cause of Zach's original Muse acknowledgement loss.

Dark/light and reduced motion passed at 1600×1000, 1280×800 and 820×560. Checks inspect overflow/clipping and recovery text contrast of at least 4.5:1. Captures were opened and inspected; no design baselines were regenerated.

- [Recovery in the actual Watcher room](../../artifacts/unconfirmed-send/watcher-recovery-dark-1280x800.png).
- [Newer draft ready at the minimum size](../../artifacts/unconfirmed-send/watcher-set-aside-light-820x560.png).

## Final validation

- `npm run typecheck`, `npm run lint`, `npm run notices:verify` (189 components), `npm run assets:verify`: passed.
- `npm test -- --maxWorkers=2`: 941 files passed / 78 skipped; 12,281 tests passed / 348 skipped (1832.16 seconds).
- Expanded nine-file recovery group: 246 passed. Includes real standing-watch continuation, paired-phone permission/question answers with denied/revoked grants, atomic sending, restart and unchanged copy budgets.
- `npm run build`, then `npx playwright test tests/e2e/watcher.spec.ts tests/e2e/thread-composer-recovery.spec.ts --workers=1 -g "an unconfirmed prompt has a recovery|permissions keep composer focus"`: two passed (15.0 seconds).
- Independent GPT-6.1-Sol/high Standards and Spec reviews of the complete base-to-source diff: no remaining material findings on either axis at `09e638e71`. Reviewers read source; execution evidence above comes from the lead's runs.

Review exposed deadlocks involving later answers, hidden news and restart notes, stale restart metadata and superseded staged answers, a standing watch's readiness, guarded Stop and phone answers, and late confirmation races. Each material path was reproduced by a failing regression before correction. The final concurrent-write cases hold the recovery write, inject the original exact echo, inspect every accepted write, and repeat with and without restart. Delivery confirmation and recovery choice are both preserved; held evidence survives receipt trimming. Failed persistence never optimistically unlocks the composer.

## Remaining surfaces

The earlier broader three-spec run had 20 passes, five failures and one test not run. All five failures reproduced after rebuilding unchanged base `f000d7612` with the same dependencies:

| Existing journey | Same failure on the base |
| --- | --- |
| Watcher provider-change handover | Claude fixture starts where the assertion expects the Codex first reply. |
| Independent text/image draft restart | Bare `docs` lookup in host-qualified IDs reads `undefined.text`. |
| Project settlement | Bare `docs` lookup reads `undefined.workspaceSettledAt`. |
| Light provider controls | Expected New thread dialog does not appear. |
| Failed-send keyboard recovery | Retry remains visible after newer typing. |

That broader E2E run is not green. The two focused built-app journeys above pass on final source. Main's existing CI run `39029045551` also failed its host-update cleanup hook and an iOS standing-watch assertion; those failures predate this branch, and PR #1150 is a separate test-repair lane.

Remote hosts and phones cannot perform the owning-desktop recovery. Explicit paired-phone answers remain available under current grants. Uncertain answers, queued deliveries and live sends keep their separate recovery rules. No installer, release or live provider journey was run for this PR preparation.
