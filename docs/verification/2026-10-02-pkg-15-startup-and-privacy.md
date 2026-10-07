# Startup and privacy fixes

Verified on Windows in `fix/bh-15-index`, after all five package fixes.

## Regression checks

- History-off cleanup reaches both the coordinator and personal chats when either fails, then delivers the saved settings notification.
- A failed thread-store redaction rejects to the coordinator. Its next maintenance retry removes the retained words from the real SQLite file without restarting.
- After the [PR privacy finding](https://github.com/millZach/Sotto/pull/675#issuecomment-5947630010), activity and legacy-message writes share the event path's guard. Regressions fail redaction once, flush new private words before retry, and inspect SQLite and the saved files. They cover both waiting for retry and turning history back on first; an unfinished redaction still completes before durable writes resume. The follow-up standards review found legacy snapshots could replay private words after retention resumed. Private message identities now stay in memory across the transition; tests keep replaying those messages, including later text updates, and verify only fresh messages and activity are retained. A successful transition is covered too.
- Host and personal-chat startup failures drain every acquired handle. Phone access closes before the host it serves.
- A failed title request logs only `thread-title-failed` and `failed`, even when the provider error contains private text and a path.
- Only the single-instance lock owner prepares legacy user data, before runtime initialization reads it.
- A fresh-profile probe in Electron 43.1.0 confirmed the lock creates the destination folder and `lockfile` before migration. Migration then copies the legacy settings/history/widget placement and models rather than renaming the folder; the TalkType folder remains. The probe used synthetic settings and the real migration function, and confirmed the copied settings matched.
- Agent activity still reveals the widget with the idle setting off, as the owner's docs-only decision requires. No reveal rule changed.

The focused regression tests were observed failing before the corresponding fixes and passing afterward. Initial independent standards and spec reviews found no findings; the follow-up standards finding above was reproduced and fixed. The read-only review CLI could not apply its Windows sandbox ACLs; read-only reviewer agents completed both reviews instead.

## Running application

`npm run build` passed. `npx playwright test tests/e2e/app.spec.ts tests/e2e/settings-index.spec.ts tests/e2e/phones.spec.ts` passed all 19 checks with one worker. These cover onboarding, dictation and history off, settings persistence and failure feedback, widget hide/reveal, single-instance activation, quit/drain/relaunch, and phone setup/pairing/disable.

The Settings journey exercised light, dark and reduced motion at 1600×1000, 1280×800 and 820×560. No UI changed; no evidence images or replacement design baselines are included.

The provider and phone effects are scripted. This proves application behavior through the built Electron boundaries, not a live provider, SSH host or Tailscale account. S-115 required no patch: the obsolete memory-probe launch branch and raw-error log were already removed on `main`, as ADR-0003 and `CONTEXT.md` record; issue #587 has the skip explanation.

## PR rework

The failed-reopen regression reproduced `Thread store is not open` from `snapshot()` before the fix. A failed durable reopen now marks the store unavailable: snapshots and refreshes resolve, writes remain blocked, and restart restores persistence. A second regression reproduced permission and command words remaining in `workspace.json` after failed redaction; the failure path now flushes organization data before reporting the privacy error.

The legacy replay regression now receives a new message after history resumes but before redaction retries. That message remains visible and persists after cleanup, while messages received with history off remain private. Settings notification failures preserve any cleanup failure, failure log details use closed literal types, removed threads discard private identity records, and the quit-drain comments again explain ADR-0041 and Stop setup behavior.

The independent review also found two neighboring cases. A rewind changes the history epoch while retaining a private prefix; suppression now follows the thread's message identities across that change. Failed redaction can close the store before its memory reopen fails; the workspace now blocks every failed connection and reopens a pending redaction on retry. The durable-reopen regression also covers successful redaction followed by failed durable open. All 46 persistence/coordinator-retry tests passed; both independent review axes reported no remaining findings at `abce940e`.

After the first rework push passed Windows CI, the final PR comment scan found two further recovery issues. [History-off startup](https://github.com/millZach/Sotto/pull/675#issuecomment-5949706165) now defers an unavailable store's reopen until coordinator maintenance exists, while still scrubbing organization data and running checkpoint cleanup. Its regression starts with retained SQLite words and storage unavailable throughout initialization, then verifies usable startup, a visible warning, a failed maintenance retry and successful cleanup when storage returns; fresh messages and activity persist afterward.

[Unavailable-history warnings](https://github.com/millZach/Sotto/pull/675#issuecomment-5949718979) now survive normal snapshots and refreshes. An organization save cannot count as history recovery, and privacy maintenance continues rejecting while the thread store remains unavailable. The regression covers the real failed durable close/open, blocked activity writes and two coordinator maintenance ticks. Both new regressions failed before their fixes and pass afterward; all 48 persistence/coordinator-retry tests passed at `29757fe5`.
