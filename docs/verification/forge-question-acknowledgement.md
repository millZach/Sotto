# Forge question acknowledgement

Verified on Windows with an Electron desktop and a paired, loopback headless host. Providers are scripted fixtures; the socket, host coordinator, client router, durable saved answers, IPC, preload and rendered question panel are real. The fixture bypasses SSH discovery and launch. This is not a live Forge or paid-provider run.

## Cause and repair

The desktop never bound a remote saved answer to its submission, and its remote recovery projection always returned an empty completed-receipt list. Codex, Claude Code and Grok all accepted one answer and removed the question while the laptop kept its answer as unconfirmed. `npx vitest run tests/integration/remoteRequestDraftDelivery.test.ts --maxWorkers=2` reproduced all three failures before the fix.

The desktop now binds the exact saved answer before sending. An authenticated host receipt proves acceptance for that submission, Sotto thread, provider, request and original question form. Reconnect recovery reads that receipt without replaying an answer. Refusals, genuine uncertainty, mismatched receipts and older unbound drafts cannot erase saved text. A positive receipt remains authoritative when a subsequent host or desktop detail read fails.

The review found additional failures and each received a red regression before its fix. Checking delivery could fail on a later detail read despite having exact acceptance. Background reconciliation could remove an answer on disk while its already-mounted recovery card stayed visible. The Electron test gates a real receipt until the card mounts, then releases it without another provider update; the visible card must disappear and the provider must still have received only one answer. A pending receipt could also stay cached when an absent question's native command later finished; the recovery key includes whether that thread's command is still in progress, so completion permits one fresh read. The negative counterpart stays saved, and unchanged state does not poll.

The final specification review reproduced a later timing case with the real Claude adapter and fake CLI. The response bytes were forwarded exactly once while only the stdin callback was held. After the existing two-second fixture deadline returned uncertainty, `control_cancel_request` removed the question and an idle receipt lookup returned no acceptance. Releasing the original successful callback then persisted host acceptance without changing the question or busy state. The negative cache hid that new proof. An opted-in `answer-receipt` push now carries the exact proof to the client that queried it; the independent probe cleared the hold without another read or response. A failed callback retains the answer.

The same probe and an inspected Electron screenshot exposed a separate stale delivery banner after the held answer cleared. The strengthened UI regression failed on that exact error. Delivery notices now belong to their exact answer attempt, so its receipt retires both the saved warning and that notice while preserving newer or unrelated errors. The rendered regression checks both the absence of the recovery card and the absence of an alert.

## Validation

The initial validation below applies to `f516eb06`, published with evidence at `ad77b7a6`. The subsequent PR review fixes and their validation are recorded separately below.

- `npm run typecheck`, `npm run lint` and `npm run notices:verify` passed on the final source; 174 third-party notice components were verified. The app and standalone host build passed.
- `npm test -- --maxWorkers=2` on `f516eb06`: 567 files passed and 42 skipped; 7,910 tests passed and 166 skipped. No failures, in 1,329.55 seconds. Source and tests stayed unchanged throughout the run.
- `npx vitest run tests/integration/remoteRequestDraftDelivery.test.ts tests/unit/main/desktopHostRouter.test.ts tests/integration/remoteClaudeLateAnswer.test.ts --maxWorkers=2`: all 57 cases passed. The earlier six-file transport/recovery run passed all 150 cases; the full gate above includes the final versions of every regression.
- On the final source at `f516eb06`, `npm run build` passed, followed by `npx playwright test tests/e2e/remote-question-receipt.spec.ts tests/e2e/thread-sidebar-question.spec.ts tests/e2e/request-draft-restart.spec.ts tests/e2e/request-draft-recovery.spec.ts tests/e2e/host-identity.spec.ts --workers=1 --trace retain-on-failure --output test-results/forge-ack-all-final`: all 20 cases passed in 2.8 minutes. The seven remote cases include both late native completion outcomes and the absence of a stale delivery alert.
- Separate GPT-6.1 Sol standards and specification reviews have no remaining findings. Their delivery findings were reproduced before fixing them, including the independent real-Claude callback probe after the final fix.

## PR review follow-up

[PR #796](https://github.com/millZach/Sotto/pull/796) found four additional defects. The desktop Check callback passed a full request target into a strict owner-only list lookup, so both Check and the automatic check after a refusal failed before reaching the host. It now reads and refreshes that exact target. Optional receipt-read failures after acknowledgement preserve the command-local outcome and retain unproved text. Recovery reconciles known acceptance immediately and queues receipt reads separately per connection; a blocked host cannot stall local, personal or other-host acceptance. Finally, an acceptance push notifies recovery without clearing an unrelated oversized-shell error.

Both new Electron regressions failed against the prior bundled desktop, then passed after rebuilding: Check makes an unsent held answer editable without submitting it, and a refused answer can be edited and retried. The tests exercise the actual main-process callback through IPC and the rendered controls. The unsent-hold fixture saves a held revision through preload to model an interrupted send; it does not submit an answer through that bridge.

The router's two blocked-host regressions and the transport regressions also failed before their fixes. Final focused runs passed 84 router/draft/delivery cases, 49 socket-client unit cases and 70 socket integration cases. The router tests include independent 16-read-per-second budgets and bounded 512-entry pending/negative caches. Separate GPT-6.1 Sol standards and specification reviews have no open findings; the standards review's shortened polling timeout was removed.

On the review fixes, typecheck, lint, notices (174 components) and build passed. All 22 Electron cases passed in 1.8 minutes with the five-spec command above, using `--output test-results/forge-ack-review-final`. The complete two-worker suite and GitHub gates are checked on the published revision before merge; their final status is recorded on the PR. No source or test edits are made during the complete local run.

The inspected [Check result](../../artifacts/forge-question-ack/remote-check-editable.png) retains the selected answer, removes Check again and enables Send answer. The test then edits the choice and verifies one accepted submission and no saved hold.

A subsequent PR finding exposed the receipt-reply counterpart to the late push: acceptance recorded while the laptop was disconnected cleared its saved answer after reconnect, but the receipt reply did not notify subscribers, so the mounted delivery banner remained. Both a unit test and a new Electron test failed before the fix. The Electron fixture preserves the selected thread through the production router replacement path, holds the recovery read until the warning mounts, then releases only that reply. It never polls `agents.get()`, changes selection or reads the router shell after acceptance. The reply now notifies subscribers once when it adds exact acceptance; duplicate proof and unrelated shell errors keep their existing behavior.

The inspected [failed reply-only result](../../artifacts/forge-question-ack/receipt-reply-banner-before.png) has no retained card but still shows the red delivery banner. The [fixed result](../../artifacts/forge-question-ack/receipt-reply-confirmed.png) clears both. Final typecheck, lint, notices, build and the 86-case focused run passed, as did all 23 Electron journeys in 1.9 minutes using `--output test-results/forge-ack-reply-final`. The earlier full-suite repeat was stopped when this new defect was confirmed; the complete run is restarted with this fix and frozen source, and only its completed result counts toward merge.

The next review found two Check-result defects: accepted retirement returned the same `null` as a missing editable draft, so the renderer saved delivered text again; a receipt notification could also reconcile the hold away while Check awaited refresh, producing false uncertainty. Check now captures its held attempt before the native read and returns distinct accepted and editable results through a validated preload contract. Exact proof remains usable if reconciliation retired that captured hold. A newer saved revision or decision makes the old check stale. The renderer marks only the confirmed revision sent, never flushes accepted text, and ignores delayed results or errors when its binding or revision changed. Bound cards let this operation own the refresh so an earlier read cannot consume the attempt first; unbound permission checks retain their existing provider read.

Main-side red regressions cover both reported failures and newer editable/held revisions. Renderer and preload reds cover accepted checks after errors, no re-save, stale native uncertainty, newer local edits, and delayed accepted/editable/error outcomes. Focused runs passed 100 main/integration and 82 renderer/preload cases; typecheck and lint passed. The real Electron Check journey also passed: after masked host publication, the user's Check alone obtains proof, leaves the [still-visible native card sent and locked](../../artifacts/forge-question-ack/check-accepted-sent.png), and never recreates a saved answer when the native question later closes. Initial fixture attempts released a host push before Check or duplicated the synthetic question; the final fixture holds proof through publication and retains exactly one native request.

The complete local run on `e1b89b04` finished with 7,923 passed, 166 skipped and one Devin adapter test failing with a disconnected-before-acknowledgement error. Seven isolated reruns and 20 in-memory replicas passed; no causal reproduction or source change was inferred. That run does not count as a green gate. Its Windows CI failed two separate host-connection polls while still connecting. The final integrated revision must pass the complete suite and CI before merge; the PR records those outcomes.

Three existing saved-answer UI tests initially failed because they looked up bare thread IDs after the host-scoped identity migration. A clean checkout of `77d24f8d` reproduced the same three failures. The tests now use the existing `hostKeys` helper, and all three pass; these changes do not alter production behavior. The temporary baseline checkout was removed after preserving its test evidence.

The neighboring run was `npx playwright test tests/e2e/thread-sidebar-question.spec.ts tests/e2e/request-draft-restart.spec.ts tests/e2e/request-draft-recovery.spec.ts tests/e2e/host-identity.spec.ts`.

During current-main integration, one neighboring permission test lost its Electron window during setup, before any permission or answer was emitted. Its diagnostic retry and the complete 18-case rerun passed with normal process exits; no crash cause was established. The final 20-case run above passed without retries. No design baseline was intentionally regenerated; neighboring tests' incidental screenshot changes were restored.

The Electron journey covers legacy choices and structured answers for Codex, Claude Code and Grok, genuine uncertainty through renderer reload, and delayed receipt recovery after socket reconnect. Captures cover 1600×1000, 1280×800 and 820×560 in light and dark appearances with reduced motion. No stylesheet, layout, control label or theme changes are part of the fix.

Inspected captures:

- [Prepared answer at the minimum size, light](../../artifacts/forge-question-ack/form-saved-820-light.png): the selected choice and Send answer remain usable.
- [Confirmed answer, dark](../../artifacts/forge-question-ack/form-accepted-1280-dark.png): the question and saved-answer warning are gone; the thread continues.
- [Genuine uncertainty at the minimum size, dark](../../artifacts/forge-question-ack/form-unconfirmed-820-dark.png): the answer remains readable and recoverable.
- [Delayed confirmation after reconnect](../../artifacts/forge-question-ack/late-receipt-cleared.png): the mounted warning clears without navigating away or waiting for another provider update.
- [Late native completion before the notice fix](../../artifacts/forge-question-ack/native-late-banner-before.png) and [after the fix](../../artifacts/forge-question-ack/native-late-confirmed.png): exact acceptance clears both the held answer and its error banner without a further action.

## Interactive follow-up, 6 October 2026

At the user's request, the committed build at `56fe5e16` received a separate screenshot-guided walkthrough in visible Electron windows. The native Windows computer-use runtime could not initialize: first it reported `apply deny-read ACLs`, then `trusted Node process exited unexpectedly` after reset. The fallback used Playwright mouse coordinates and keyboard input chosen from a fresh screenshot after each action. Fixture setup, receipt delay, socket reconnect and renderer reload used the existing test harness. No answer was submitted through a direct bridge call.

The walkthrough checked four flows at 1280×800, dark appearance and reduced motion:

| Flow | Observed result |
| --- | --- |
| Codex fixture, legacy choice | Selecting Coast saved the answer. Send answer showed its sending state, then the question disappeared with no warning. One submission. |
| Codex fixture, typed answer | Typed a custom answer, used Tab to focus Send answer and Enter to submit. The exact text arrived once and its saved answer cleared. |
| Claude fixture, delayed receipt | The accepted answer remained visibly unconfirmed while evidence was withheld. After socket reconnect, releasing only the receipt cleared the mounted warning without another click, reload or provider update. One submission. |
| Grok fixture, genuine uncertainty | The answer and recovery controls remained visible after renderer reload. The saved hold remained and the provider still had one submission. |

There were no renderer page errors. One screenshot session stalled while opening a second test window; restarting that isolated runner and explicitly showing its window before capture restored screenshots. The temporary controller, app windows, profiles and test hosts were closed or removed after verification. Production source was unchanged.

Evidence: [typed answer with keyboard focus on Send](../../artifacts/forge-question-ack/interactive-typed-answer.png), [warning awaiting the delayed receipt](../../artifacts/forge-question-ack/interactive-delayed-warning.png), [warning cleared after the receipt](../../artifacts/forge-question-ack/interactive-delayed-cleared.png), [genuine uncertainty retained after reload](../../artifacts/forge-question-ack/interactive-uncertain-reload.png), and [recorded counts and exact-text check](../../artifacts/forge-question-ack/interactive-summary.json).

These are real desktop and host/socket flows with scripted provider results. They do not establish live Forge or native provider compatibility. The installed laptop app and active Forge host were not changed.

## Limits and delivery

Both desktop and host need the optional `answer-receipts` capability. Older hosts still accept authorized answers but cannot supply this evidence. Previously saved drafts without a submission identity, and receipts evicted from the host's bounded history of 128 accepted answers, remain recoverable instead of being guessed delivered.

The fix began on local `main` at `77d24f8d`, on `fix/forge-question-ack`, and integrated current `main` at `febe51a6`. The original launch-video checkout was preserved. No installed desktop, live Forge host, macOS app or iPhone app was updated or exercised locally. The prototype is retained separately on `prototype/forge-answer-receipt` at `4f81c4b4`.
