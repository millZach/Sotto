# Saved answers whose native question closed

Verified September 13, 2026 in `phase3-draft-recovery-ui`, on backend source commits `a8e3a93` and `81d0c8a` (cherry-picked locally as `01b73b8` and `85c3e23`).

A native client can close a pending question while it shuts down. The structured answer draft survives on disk (see [structured answer draft durability](phase-3-answer-drafts.md)), but before this change it loaded only into a live request card, so a question that never came back left the answer unreachable.

## Delivered behavior

- Thread panes and personal chats list the owner's retained forms through `requestDrafts.list(owner)`, below the live request cards in the transcript.
- A form is hidden only while a live structured card renders the same request ID and question definition. A reused request ID with a changed definition shows the new, empty live card and the older saved answer beside it.
- Each saved answer shows the original question labels with the chosen option labels, Other text and free text. Unanswered questions say "No answer". A held attempt is titled "Unconfirmed answer".
- The one sentence under the title states whether the answer was sent and what Sotto can see about its question. While the provider is disconnected, connecting, loading or its history failed, it never says the question is gone.
- Actions are **Copy answer** (main-owned clipboard path, "Copied" feedback, readable failure) and **Discard** (inline confirmation with Keep focused, Escape returns to Discard, exact target and revision). A held form's confirmation says discarding does not cancel or resend the answer. A stale revision is refused with main's reason and the newer content is shown.
- Nothing in the recovery surface sends, checks, releases a hold, recreates a request or grants management authority. Composer drafts are untouched.
- Listing re-reads on owner change, live request or connection/history changes, personal decision changes, after a discard, and when a save or answer acknowledgement settles for a request that left the live set. Responses for an owner the view has left are ignored. A failed read keeps what was shown and offers Try again, unless a live card already reports the storage error.

## Source

UI commits, in order: `1eb91e4`, `820957a`, `0e04d4d`, `2bda6e5` (source and unit tests), then `c19311f` (Electron journey). `820957a` hid a just-accepted held answer in the renderer; `0e04d4d` removes that inference and keeps only the re-list on acknowledgement, so the two apply together.

- `src/renderer/src/agents/requests/RequestDraftRecovery.tsx`: `useRequestDraftRecovery` and `RequestDraftRecovery`.
- `src/renderer/src/agents/requests/requestDraftRecovery.css`.
- Mounts only in `src/renderer/src/agents/ThreadPane.tsx` and `src/renderer/src/agents/personal/PersonalChatsView.tsx`.
- `tests/unit/renderer/requests/requestDraftRecovery.test.tsx` (15), `tests/unit/renderer/requests/requestDraftRecoveryMounts.test.tsx` (2), `tests/e2e/request-draft-recovery.spec.ts` (3).

## Checks

- `npm run typecheck`: node and web pass ([log](../../artifacts/phase-three-draft-recovery/typecheck.log)). ESLint passes on every changed file.
- `npx vitest run tests/unit/renderer/requests tests/unit/renderer/personalChatsView.test.tsx tests/unit/renderer/threadRequestSurroundings.test.tsx tests/unit/renderer/threadsView.test.tsx tests/unit/main/requestDrafts.test.ts tests/unit/main/requestDraftIpc.test.ts tests/unit/preload/requestDrafts.test.ts --maxWorkers=1`: 113 passed in 11 files ([log](../../artifacts/phase-three-draft-recovery/vitest.log)). Removing the acknowledgement phase from the re-list trigger fails the absence-before-acknowledgement test.
- `npm run build` in this worktree's own `out/` ([log](../../artifacts/phase-three-draft-recovery/build.log)).
- `npx playwright test tests/e2e/request-draft-recovery.spec.ts tests/e2e/request-draft-restart.spec.ts --workers=1`: 9 passed ([log](../../artifacts/phase-three-draft-recovery/e2e-recovery.log)).
- `npx playwright test tests/e2e/phase-three-requests.spec.ts tests/e2e/phase-three-personal-requests.spec.ts --workers=1`: 3 passed, so live request cards are unchanged ([log](../../artifacts/phase-three-draft-recovery/e2e-neighbours.log)).

## Electron journey

Each journey launches the built app with E2E fixture providers, closes the process, and launches a new one. History is off.

1. The native request is offered, and the form is filled with an option, two checks and Other or free text. While the live card is shown, the recovery list stays empty.
2. The app closes. The native side closes the question: the personal fixture's native store file loses its requests between processes (as Codex does on shutdown), and the in-memory thread fixture loses them with its process. The question is never emitted again.
3. After relaunch the provider is disconnected and the stored drafts file is byte-identical. The card says "Reconnect Claude/Codex to see whether its question is still open."
4. After connecting there is still no live card. The card says "no longer shows this question". Answers match what was typed, and the only buttons are **Copy answer** and **Discard**.
5. Copy shows "Copied", and the app's isolated E2E clipboard holds the question and answer text.
6. A same-ID request with a changed definition arrives. It gets a fresh, unchecked live card, and the saved answer says "changed this question".
7. Keyboard discard: Enter opens the confirmation with Keep focused. Escape returns focus to Discard. Enter, Tab, Enter discards. The owner's drafts on disk become `[]`, the live card and "Newer composer text" remain, and the answer IPC was called 0 times.
8. Held thread answer: the answer IPC is held while Send is pending, then the app restarts and connects. "Unconfirmed answer" shows "The answer may have arrived, so Sotto won’t send it again." Its confirmation says it doesn't cancel or resend. Keep leaves it held, with 0 answer calls.

## Rendered review

Captures are in [artifacts/phase-three-draft-recovery](../../artifacts/phase-three-draft-recovery/). Thread and personal views have the closed question at 1280×860 and 820×560 in dark and light (the 820 views have head and `-actions` shots), plus disconnected, changed-question, discard confirmation and the held thread at 1280 dark.

The target is desktop Electron. Tastify checks, as observed in those captures:

- **Concept and reference:** the reference is the existing live request card. The recovery card reuses its surface, radius, padding, title weight, action row and error line. It swaps controls for read-only question and answer pairs, and uses a hairline left rule (warning color when held) instead of the live card's accent. The composer and transcript are unchanged.
- **Hierarchy:** the answer text (15px, full text color) dominates each pair. Question labels are muted 14px. The status sentence is 14px secondary. Copy answer is the outlined action and Discard is quiet, with the danger color only inside the confirmation.
- **Type, color and sizes:** every text is at least 14px, and buttons are 34px high. Contrast is readable in both themes. Nothing wraps awkwardly or clips horizontally at 820; the card scrolls in the transcript above the composer.
- **Copy budget:** per card there are five text elements: title, status sentence, answer pairs (the content itself), Copy answer, and Discard. "Copied" and the confirmation are state feedback.
- **Repeats:** the held title "Unconfirmed answer" no longer shares a sentence with "could not confirm". The sentence now says only what that means for sending. Provider state appears once, in the sentence, not also in a badge.
- **Motion:** not applicable. The live request card it matches has none, and nothing new animates.
- **Keyboard:** confirmation focus, Escape, and focus after removal (next card or transcript) pass in unit tests and in the Electron journey.

## Limits

- The journeys use fixture providers only, never real Codex or Claude. The native disappearance is from fixture state across a real process restart; the backend's `81d0c8a` covers the real Codex adapter shutdown against its fake App Server.
- The thread fixture auto-connects, so the journey sends its `disconnect` command to show the unknown state before connecting.
- The copied text is checked in the E2E isolated clipboard, not the OS clipboard.
- There is no recover-to-composer action. Copy answer and Discard are the whole flow, so a newer composer draft is never touched.
- In an empty thread, ThreadTranscript's "What is next for this thread?" hero sits above the card. ThreadTranscript is outside this change.
- In the personal disconnected capture, the fixture's earlier submitted message renders as an empty "You · Sent" bubble after restart with history off. This comes from existing personal history presentation, not the recovery card.
- Not run: the full unit suite, the full E2E suite, and a packaged build. The 1600px width and system appearance were not captured separately; the layout has no width breakpoints and uses theme tokens only.
