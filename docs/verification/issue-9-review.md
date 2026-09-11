# Issue 9 review record

Review date: 2026-09-09. Fixed baseline: `63c3c6e913da561deb314e8d337f7eaf04c0672e` on `main`. The initial review compared the staged implementation against that baseline; follow-up review included newer working-tree fixes. No implementation commit existed during the initial review.

The standards and specification reviews were performed independently. This record keeps their findings separate. It is a source and test review, not a claim that the production membership service, physical voice experience, or macOS release has been validated.

## Standards

Sources: [CLAUDE.md](../../CLAUDE.md), [ADR 0001](../adr/0001-macos-unsigned-arm64-distribution.md), the user's supplied AGENTS instructions, and the code-review/codebase-design skills. The relevant user rule requires preserving existing behavior and testing the actual user journey. Code smells are heuristic findings rather than hard requirements.

| Finding | Resolution | Evidence |
| --- | --- | --- |
| The agent widget replaced the idle dictation widget whenever assignments existed, including after agent control was disabled. It also omitted the existing dictation click and drag handlers. This regressed existing widget interaction. | Resolved in source: the agent widget now requires enabled agent control. Its header uses the established `useWidgetDragGesture` with the dictation toggle, native drag reporting, visibility generation, and cancellation handling. | `src/renderer/src/widget/WidgetApp.tsx`, `src/renderer/src/agents/AgentWidget.tsx`. Actual rendered interaction is part of the final application journey check. |
| Possible duplicated code: the same complete-supervision capability conjunction occurred in native control and the renderer. | Resolved: both call `supportsAgentSupervision`. The assignment operation applies the common predicate, including newly created threads. | `src/shared/agents.ts`, `src/main/agents/control.ts`, `src/renderer/src/agents/AgentView.tsx`. |
| A native auto-paste failure after a settings update left the replacement formatting key in the vault, while the settings transaction reported failure. Restoring a public redacted snapshot could not restore the prior secret. | Resolved: fallible auto-paste effects run before settings and credential commitment. `SecureSettings` separately restores the prior key when its repository write fails. Notification failures remain observational. | A regression test using the actual coordinator, settings repository, credential vault, and disk first failed after a persisted-vault reload, then passed after the ordering fix. A second test causes a real atomic file replacement failure and verifies the original encrypted key survives. |

No hard violation was found in the release-artifact or macOS distribution rules. Packaging decisions remain unchanged. The host, voice, and membership interfaces provide useful deep seams; the review did not identify a compelling speculative abstraction to remove.

Targeted validation after the native transaction fix:

```text
npx vitest run tests/unit/main/agentMembership.test.ts tests/unit/main/nativeSettingsCoordinator.test.ts
2 files passed; 27 tests passed (14 membership/storage, 13 native settings).
```

The storage tests use the production persistence modules and real temporary files. Only external effects such as encryption, HTTP, and native settings callbacks are controlled. Deterministic fixture encryption does not establish Windows or macOS credential-store behavior.

## Specification

Source: the [accepted specification](../superpowers/specs/2026-09-09-sotto-agent-control-center-spec.md). The independent reviewer reported four findings, then verified their fixes through the production Electron main/preload/renderer composition with controlled external host and reasoning effects.

| Finding | Specification requirement | Resolution and regression evidence |
| --- | --- | --- |
| P1: A definitive T3 validation or HTTP rejection left an unresolved outbox entry indefinitely, blocking a deliberate retry. | Recovery: distinguish attempted, accepted, failed, and unresolved actions; retain failed prompts (story 30). | Definitive rejection removes its outbox entry; unknown delivery remains pending for reconciliation. The actual application retained the draft after rejection, accepted a deliberate retry after refresh, and contained one submitted message. |
| P2: Selecting queued thread B reverted to queue-head A on the next host snapshot. | Story 51: named selection allows the user to choose priority. Ready queue: preserve the current target while other events arrive. | Named selection updates briefing ownership. The application kept the selected thread and its question through refresh and another ready event, without a duplicate briefing. |
| P2: An ambiguity clarification forgot the original spoken request and question. | Story 18 and project directories: clarify ambiguous requests before mutation. | Pending request context carries the original request, Sotto's question, and the user's clarification forward. The folder-clarification journey created the originally named project in the clarified folder and cleared the pending request. |
| P2: Assignment instructions, queue text, and failure text were retained indefinitely without respecting the history preference. | Recovery: bounded retention and respect for existing privacy/history settings. | History-off persistence excludes processed context; failure comparison uses a hash. Assignment context has a per-assignment seven-day lifetime. Tests verified private text was absent from disk, an aged assignment resumed paused with its text removed, manual ownership and follow-up count survived, and a separate recent assignment remained recoverable. The deliberately retained unsent draft is disclosed in the UI. |

Reviewer-reported validation of the initial fixes:

```text
npm run build
npx playwright test tests/e2e/agentControl.spec.ts --workers=1
Build passed; 9 application tests passed in 17.1 seconds.
```

Follow-up review identified two neighboring cases: startup redaction must also be persisted while agent mode is disabled, and explicitly selecting a nonqueued thread must remain stable while another thread is queued. Both were fixed, and the extended tests passed in the final root-owned controller/voice/UI run: 11 Electron tests passed in 28.4 seconds. A subsequent full Electron run also includes the dark minimum-window and widget permission-boundary checks; its final result is recorded in the implementation evidence.

The separate wake source review found a stale mute-button state after a spoken mute command. The main button now reads the voice session's actual state. The review verified local-only PCM flow, pre-capture file validation, generation cancellation, and dictation ownership. The preload exposes wake and synthesis methods only to the main renderer; the widget keeps the typed control/state surface, with native checks rejecting credential commands.

Five new regressions cover the four original findings above. These tests exercise the real coordinator, IPC/preload, renderer, and persistence; they do not establish live provider, billing-service, or physical audio behavior. The [implementation evidence](issue-9-implementation.md) records final combined checks, the latest regression result, and release gates.

The final specification pass found that a freeform spoken answer could submit after the first pause. Answers now use an editable draft bound to the original thread and host request, persist across restart, and require an explicit submission. Three new application regressions cover multiple speech chunks, answering while the host reports the thread running, request binding through restart, and deliberate permission decisions. The reviewer confirmed the fix with no material regression in the bounded source review; the final combined agent run passed all 15 Electron tests, with typecheck and lint also passing.

The final standards pass found no remaining material finding. A separate visual comparison exposed native checkbox hover paint in the capture harness; parking the pointer before capture removed that nondeterminism without changing production styling, keyboard focus, or image tolerances. All six normalized comparison tests and 112 expected design tuples passed.

## Additional live T3 evidence

The existing disposable project from the earlier T3 0.0.38 proof was reused to check the final automatic-reply guard. The adapter fetched the real assigned thread and was given an older historical user-message ID. It rejected the stale automatic reply before attempting dispatch; the thread's message IDs were unchanged. A fail-closed HTTP dispatch blocker guaranteed that this check could not start a model turn even if the guard regressed. It created no project or thread and used no additional model turn. Its temporary T3 client session was revoked.

Local, ignored evidence files:

- `artifacts/agent-control-smoke/Sotto integration 2026-09-09T22-24-41-370Z/compatibility-report.json`: original authenticated shared-state, provider, project/thread, bounded prompt, question-response, origin distinction, and reconnect proof.
- `artifacts/agent-control-smoke/Sotto integration 2026-09-09T22-24-41-370Z/changed-thread-guard-report.json`: `changedThreadGuard`, `zeroDispatchAttempts`, `unchangedMessages`, and `testSessionRevoked` are all `true`.

This proves the adapter's fresh-read stale-message rejection against the running host. T3 does not expose an atomic expected-last-message condition on dispatch; a direct message arriving after the final check is still a host protocol limitation. Native-window typing and visual confirmation are distinct from this shared-HTTP-state evidence.

## Remaining release evidence

The client and contract tests do not deploy the membership identity/billing service. Service deployment, product/price selection, trusted hosted account routes, and validated billing webhooks remain explicit production configuration work; see [membership service contract](issue-9-membership-service.md). No deployment or purchase was performed.

Physical microphone/speaker behavior, wake accuracy and latency thresholds, and Apple silicon macOS validation require their actual environments. They must not be inferred from deterministic tests, Windows source inspection, or T3's HTTP behavior. Final combined checks, rendered desktop inspection, packaging, and commit state are recorded by the main implementation agent in the implementation record.
