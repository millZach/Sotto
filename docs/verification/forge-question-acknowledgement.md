# Forge question acknowledgement

Verified on Windows with an Electron desktop and a paired, loopback headless host. Providers are scripted fixtures; the socket, host coordinator, client router, durable saved answers, IPC, preload and rendered question panel are real. The fixture bypasses SSH discovery and launch. This is not a live Forge or paid-provider run.

## Cause and repair

The desktop never bound a remote saved answer to its submission, and its remote recovery projection always returned an empty completed-receipt list. Codex, Claude Code and Grok all accepted one answer and removed the question while the laptop kept its answer as unconfirmed. `npx vitest run tests/integration/remoteRequestDraftDelivery.test.ts --maxWorkers=2` reproduced all three failures before the fix.

The desktop now binds the exact saved answer before sending. An authenticated host receipt proves acceptance for that submission, Sotto thread, provider, request and original question form. Reconnect recovery reads that receipt without replaying an answer. Refusals, genuine uncertainty, mismatched receipts and older unbound drafts cannot erase saved text. A positive receipt remains authoritative when a subsequent host or desktop detail read fails.

The review found three additional failures and each received a red regression before its fix. Checking delivery could fail on a later detail read despite having exact acceptance. Background reconciliation could remove an answer on disk while its already-mounted recovery card stayed visible. The Electron test gates a real receipt until the card mounts, then releases it without another provider update; the visible card must disappear and the provider must still have received only one answer. A pending receipt could also stay cached when an absent question's native command later finished; the recovery key now includes whether that thread's command is still in progress, so completion permits one fresh read. The negative counterpart stays saved, and unchanged state does not poll.

## Validation

- `npm run typecheck`, `npm run lint` and `npm run notices:verify` passed. The app and standalone host build passed.
- `npm test -- --maxWorkers=2`: 481 files passed and 39 skipped; 6,382 tests passed and 153 skipped. No failures. The two additional pending-command cases were checked in a focused run after this suite collected its files.
- `npx vitest run tests/integration/remoteRequestDraftDelivery.test.ts tests/unit/main/desktopHostRouter.test.ts --maxWorkers=2`: all 33 cases passed after consolidating the two pending-command cases into the permanent regression file. Main, preload and renderer notification tests also passed all 41 cases.
- `npm run build && npx playwright test tests/e2e/remote-question-receipt.spec.ts`: all five cases passed against the final production source. The neighboring host-identity, question, sidebar and saved-answer Electron journeys passed all 13 cases.
- Separate GPT-6.1 Sol standards and specification reviews have no remaining findings. Their three delivery findings were reproduced before fixing them.

Three existing saved-answer UI tests initially failed because they looked up bare thread IDs after the host-scoped identity migration. A clean checkout of `77d24f8d` reproduced the same three failures. The tests now use the existing `hostKeys` helper, and all three pass; these changes do not alter production behavior. The temporary baseline checkout was removed after preserving its test evidence.

The neighboring run was `npx playwright test tests/e2e/thread-sidebar-question.spec.ts tests/e2e/request-draft-restart.spec.ts tests/e2e/request-draft-recovery.spec.ts tests/e2e/host-identity.spec.ts`.

The Electron journey covers legacy choices and structured answers for Codex, Claude Code and Grok, genuine uncertainty through renderer reload, and delayed receipt recovery after socket reconnect. Captures cover 1600×1000, 1280×800 and 820×560 in light and dark appearances with reduced motion. No stylesheet, layout, control label or theme changes are part of the fix.

Inspected captures:

- [Prepared answer at the minimum size, light](../../artifacts/forge-question-ack/form-saved-820-light.png): the selected choice and Send answer remain usable.
- [Confirmed answer, dark](../../artifacts/forge-question-ack/form-accepted-1280-dark.png): the question and saved-answer warning are gone; the thread continues.
- [Genuine uncertainty at the minimum size, dark](../../artifacts/forge-question-ack/form-unconfirmed-820-dark.png): the answer remains readable and recoverable.
- [Delayed confirmation after reconnect](../../artifacts/forge-question-ack/late-receipt-cleared.png): the mounted warning clears without navigating away or waiting for another provider update.

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

The fix is based on local `main` at `77d24f8d`, on `fix/forge-question-ack`. The original launch-video checkout was preserved. No installed desktop, live Forge host, macOS app or iPhone app was updated or exercised. The prototype is retained separately on `prototype/forge-answer-receipt` at `4f81c4b4`.
