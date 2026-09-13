# Phase 3 request card verification (#52)

Worker: phase3-requests (Claude Opus 5), branch `work/phase3-requests` from `e34936f`. This covers only the shared request card (`src/renderer/src/agents/requests/*`), its unit tests and one complete-app Electron spec. Target: the Windows Electron desktop window, checked at 1280 × 860 and at the window minimum of 820 × 560, in dark and light.

## What changed

- **Optional native fields.** `required: false` shows a muted **Optional** label. An unanswered optional field is left out of `questionAnswers`. A required field (including one with no `required` value) must be answered. Option IDs are sent exactly as the provider gave them. An optional single choice gets a **Clear choice** button that works by keyboard and moves focus back to the first option. If Other is picked but left empty, sending is blocked, even on an optional question.
- **Unavailable fields.** When a field has an `unavailableReason`, the card shows that reason in place of an input, and no value is ever sent for it. If the field is required, Send stays disabled and the footer says "Finish this form in the provider’s app."
- **Permission choices.** `permissionChoices: []` no longer falls back to Allow/Deny. The card shows no buttons and says "Sotto has no choice it can send for this request. Answer it in the provider’s app." It also hides the voice hint. Only `undefined` still gets the legacy Allow/Deny. Choice IDs, scopes and `approved = kind.startsWith('allow-')` are unchanged.
- **Answer state.** Unchanged. Answers are stored per owner and request, and the key still uses the escaped NUL separator. There are new regression tests for simultaneous requests, refusals and pending or unconfirmed delivery.

## Checks run

| Check | Result |
|---|---|
| `npx vitest run tests/unit/renderer/requests tests/unit/main/codexForms.test.ts tests/integration/nativeProviderRequests.test.ts tests/integration/personalChats.test.ts` | 4 files, 41 tests passed (request card 20, 11 of them new) |
| `npm run typecheck` (node + web) | passed |
| `npx eslint src/renderer/src/agents/requests tests/unit/renderer/requests tests/e2e/phase-three-requests.spec.ts` | passed |
| `npm run build` then `npx playwright test tests/e2e/phase-three-requests.spec.ts --workers=1` | 2 passed, and passed again on three more consecutive runs |
| Tests that render ThreadsView and the thread pane (8 files) | 119 passed, 3 failed. The 2 `threadsView.test.tsx` failures also fail on the baseline `e34936f` request card. The `threadQueueSkills` failure was a timing flake and passed 3 of 3 reruns. See Gaps. |

The new unit tests were written first and failed against the old code: 7 failures (no `answerProgress` or `isRequired`, optional fields blocked sending, Allow shown for `[]`, the voice hint shown). The simultaneous-request tests passed on the baseline store and now guard against regressions.

## Complete-app Electron journeys

`tests/e2e/phase-three-requests.spec.ts` launches the real app through `launchSotto()` with a synthetic owned profile. The app shell, Threads page, preload, IPC and the main `AgentControl` are all real. Requests enter through `window.sottoE2E.agentEvent({ type, threadId, text, request })` and target the default connected `workshop` and `docs` threads. `window.sotto` is untouched. To record the exact answer payload, the test wraps the registered `sotto:agents:command` invoke handler in the main process through `ipcMain._invokeHandlers`. That is Electron-private and test-only. The wrapper records `answer` commands, can hold them to simulate a slow bridge, and always calls the real handler.

1. **Questions.** Workshop gets five questions: a radio with Other, a multiselect, free text, an optional radio, and an optional unavailable field. Docs gets a radio plus a required unavailable field.
   - Every question renders. Optional appears twice, and the unavailable field has no input.
   - Choosing and then clearing the optional radio by keyboard puts focus back on its first option.
   - Docs keeps its selection while Send stays disabled with the explanation.
   - After switching Docs → Workshop, the Workshop selections are intact.
   - After a provider disconnect, the card shows "Reconnect … to answer." with the inputs disabled and the selections kept. The pane's **Reconnect** button re-enables the same `layout-form` request.
   - The branch field was answered and sent by keyboard: End, type, Enter.
   - Recorded payload, exactly: `{ type:'answer', threadId:'workshop', requestId:'layout-form', answer:'', questionAnswers:{ layout:{optionIds:['sidebar']}, checks:{optionIds:['unit','types']}, branch:{optionIds:[],text:'settings-layout'} } }`. The optional `depth` and the unavailable `workers` are absent.
   - Afterwards: `state.error === null`, `assignments` is `[]`, workshop has no requests, docs still has `['audience-form']`, and the persisted `agents.json` outbox is empty. Docs still shows Maintainers selected.
2. **Approvals.** Docs gets a permission with `permissionChoices: []`: no buttons and no voice hint. Workshop gets Allow once, Allow for this session, Always allow (the provider's own `allow_always` ID) and Deny, shown in the provider's order with the command, cwd and description.
   - At 820 × 560, starting from an older reading position, keyboard focus brings each choice into view with nothing covering it.
   - With the `reject` fixture, choosing session shows the provider error inside the card. The buttons stay enabled and `run-tests` is still pending.
   - With the IPC call held, pressing Enter on Allow once shows "Sending…" and disables every choice. A second Enter and a Docs → Workshop round trip do not resend. After release, the card is gone.
   - Recorded payloads, exactly: `{…requestId:'run-tests', answer:'Allow for this session', approved:true, permissionChoice:'acceptForSession'}`, then `{…answer:'Allow once', approved:true, permissionChoice:'once'}`. Docs still has `['network-profile']`, `assignments` is `[]`, and the outbox is empty.

In every capture, the layout check asserts: the composer is fully inside the window, the transcript ends above the composer, the transcript is at least 180px tall (160px in the refused state, where the pane's error banner takes about 40px), and neither the page nor the card scrolls horizontally.

Screenshots were inspected. They are untracked in this worktree at `artifacts/crossing/phase3-requests-*.png`: `workshop-form`, `workshop-form-footer`, `docs-required-unavailable`, `permission-no-choices`, `permission-choices` and `permission-refused`, each at 1280 and 820 in dark and light, plus `permission-sending-1280-dark`.

## Tastify acceptance (scoped edit inside the existing Crossing request card)

- **Reference and concept.** The existing card is the reference: one ruled block with an attention-colored left edge. The new states reuse its type scale and tokens, and no new surface was added. Confirmed in every capture.
- **Composition.** Optional sits on the question's own line. The unavailable reason takes the place of the input, with a thin rule that turns to the warning color only when the field is required. Clear choice sits under the options it clears. In the Docs capture the disabled Send and its reason share the footer line.
- **Type and color.** Prompts are 16px and option labels 15px (unchanged). The unavailable reason and the fallback line are 14px. Optional, Clear choice and the footer are 13px. Nothing is below 12px. Only existing tokens are used, and all text read clearly in both themes.
- **Copy.** New text: "Optional", "Clear choice", "Finish this form in the provider’s app.", "Sotto has no choice it can send for this request. Answer it in the provider’s app." The field reason itself comes from the backend. The first footer draft ("A required field can only be answered in the provider’s app.") repeated that reason and was replaced with the instruction.
- **Motion.** None added. The card has no transitions, so reduced motion is unaffected.
- **Keyboard.** Radios and checkboxes are native. Clear choice is a real button that returns focus to the group. Enter in text fields sends. Permission choices are buttons reachable in order with Tab. All of this was checked in Electron.

## Gaps and integration notes for other owners

1. **The error shows twice after a refusal** (ThreadPane, primary UI). `ThreadPane` also shows the controller's error as `.thread-workspace__error` above the transcript. The card already shows it, so the banner repeats it and costs the 820 × 560 window about 40px (`permission-refused-*`). Suggestion: don't show the pane banner for answer errors, since the card owns them.
2. **Composer copy contradicts the no-choice case** (ThreadComposer, primary UI). When `permissionChoices` is `[]`, the placeholder and hint still say "Allow or deny the request above to continue." They also repeat each other.
3. **Jump to latest covers content** (ThreadTranscript). When the reader scrolls up in a short window, the floating button can cover the request card's buttons or text (`permission-refused-820-light`, `docs-required-unavailable-820-*`). Keyboard focus is not affected, which the spec asserts.
4. **Voice approval with an explicit empty list** (controller, and the hint condition in ThreadPane). `ThreadRequests` still passes the "Say allow or deny" hint for `[]`; the card now hides it. The spoken "allow"/"deny" path in `control.ts` still sends a legacy `approved` without a choice, so adapters must keep rejecting it. Codex does this for `item/permissions/requestApproval`. Not verified for Claude or Grok.
5. **Stale ThreadsView tests** (`tests/unit/renderer/threadsView.test.tsx`, layout owner). "keeps permission decisions explicit…" expects Deny to send after Allow already succeeded, which conflicts with resolve-once. "writes an answer in the selected workspace…" changes only the queue item, not the request. Both fail on `e34936f` too.
6. **Fixture coverage.** All E2E threads use the fixture Claude model. Codex (MCP form, empty permission profile), Claude (header/multiselect) and Grok (`allow_always`) request shapes go through the shared contract and card, but provider-specific mapping is covered only by the backend's own tests. No native clients were launched.
