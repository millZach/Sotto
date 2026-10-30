# Queue messages while Watcher waits on a card

A question or permission card now holds delivery, not admission to the user's
follow-up queue. Desktop Send, its keyboard shortcut, and the iPhone all keep the
card pending and queue the new message. The card remains the only place to
answer or skip it. When answering resumes a provider turn, the queue waits for
that turn's next available slot; it never silently steers into the turn. The
same desktop composer and admission rules serve ordinary threads.

## Focused checks

Initial checks used Node 24.22.1 after `npm ci --ignore-scripts`:

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `tests/unit/main/watcherSendHolds.test.ts`: 9 passed. Actual coordinator
  admission, unchanged cards, skip, later manual Send joining the FIFO queue,
  phone origin preservation, and release after a completed turn.
- `tests/unit/main/watcherPhonePage.test.ts`: 12 passed. Questions and permissions,
  idle and running, with the legacy phone packet and the negotiated steer packet.
- `tests/unit/renderer/watcherView.test.tsx` and
  `tests/unit/renderer/threadQueueSkills.test.tsx`: 93 passed. Editable drafts,
  enabled Queue, unchanged cards, keyboard queueing, and no implicit answer or
  steer. Watcher cases run with the quiet-composer switch both on and off.
- `tests/unit/renderer/threadRequestSurroundings.test.tsx` and
  `tests/unit/renderer/threadComposerRecovery.test.tsx`: 10 passed. Native, legacy,
  and provider-app cards stay pending while follow-ups queue; arriving cards keep
  the draft and focus, and clearing cards preserves newer typing.
- `tests/unit/main/agentAttentionWorkspace.test.ts`,
  `tests/unit/main/prototypeQuestionsControl.test.ts`, and
  `tests/unit/main/wakeUpQueue.test.ts`: 38 passed. Pending requests accept user
  follow-ups without sending or answering, hidden cards hold delivery, and user
  messages keep their place ahead of wake-ups. Closed/disconnected guards remain.
- `npm run i18n:extract` and `tests/unit/shared/interfaceCatalogs.test.ts`: 4 passed.
  Extraction reports the existing nonliteral `COMMAND_NOTE` comment warnings in
  `MessageContent`; it exits successfully.

The first GitHub run caught two omissions: the new iPhone labels lacked their
30 translations, and existing request/queue tests still expected admission to be
blocked or paused. The catalog now includes both labels in every language;
`node apps/ios/scripts/check-strings.mjs` passes. The affected unit expectations
now assert queue admission while preserving cards and delivery order. The
permission-layout e2e expectations were updated too; execution stays on GitHub.

After merging main at `07604b760` (PR #1812), typecheck, lint and all ten targeted
unit files passed again: 179 tests, including the new Watcher speed and strict
phone-projection cases from main. The native String Catalog check also passed.
The conflict resolution keeps the new effort/speed controls and allows draft
editing while a card waits. A separate source audit confirmed that the queue
holds, phone origins and strict phone projection all survived the merge.

The native iPhone model test and existing phone integration test were updated.
Those suites, the rest of CI, and native iPhone compilation are left to GitHub.
No Electron app, provider process, local e2e test or full suite was launched.
The phone, socket and `sotto_threads` schemas are unchanged.

## Review

Muse reviewed the implementation and found no correctness issues. Its one
wording finding is fixed: the iPhone button now says “Queue” while a card waits,
instead of promising “after this turn” when Watcher can be idle. The Watcher test
helpers also match #1812 to avoid an unnecessary merge conflict; their 53 tests
passed again after that alignment.

## Headless layout and interaction

A temporary Vite page mounted the real `AgentRequestCard` and `ThreadComposer`
with the app's styles, fixture state, a pending question, one queued message,
and a draft for the next one. Chromium ran headlessly in reduced motion. Both
layouts were checked at 1600×1000, 1280×800 and the 820×560 desktop minimum,
in dark and light. All twelve cases kept the card visible, accepted Queue,
issued only `queue-followup`, and had no horizontal overflow. The captures at
1280 and 820 were visually inspected.

The final captures were regenerated from this checkout after merging main at
`07604b760`. The harness now imports the merged source directly, including the
Watcher pill and effort dots beneath the model name. All twelve checks passed
again, and the refreshed dark/light pill and full-composer captures were
visually inspected at the 820px minimum. These captures prove the merged desktop
source, not a running Owl or native iPhone screen. No app was launched.

| Layout | Dark | Light |
| --- | --- | --- |
| Pill, 1280 | [Capture](../../artifacts/watcher-card-queue/pill-dark-1280.png) | [Capture](../../artifacts/watcher-card-queue/pill-light-1280.png) |
| Pill, 820 | [Capture](../../artifacts/watcher-card-queue/pill-dark-820.png) | [Capture](../../artifacts/watcher-card-queue/pill-light-820.png) |
| Full, 1280 | [Capture](../../artifacts/watcher-card-queue/full-dark-1280.png) | [Capture](../../artifacts/watcher-card-queue/full-light-1280.png) |
| Full, 820 | [Capture](../../artifacts/watcher-card-queue/full-dark-820.png) | [Capture](../../artifacts/watcher-card-queue/full-light-820.png) |

[Machine-readable checks](../../artifacts/watcher-card-queue/checks.json).
