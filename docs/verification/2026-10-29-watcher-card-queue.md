# Queue messages while Watcher waits on a card

A question or permission card now holds delivery, not admission to the user's
follow-up queue. Desktop Send, its keyboard shortcut, and the iPhone all keep the
card pending and queue the new message. The card remains the only place to
answer or skip it. When answering resumes a provider turn, the queue waits for
that turn's next available slot; it never silently steers into the turn. The
same desktop composer and admission rules serve ordinary threads.

## Focused checks

Using Node 24.22.1 after `npm ci --ignore-scripts`:

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
- `npm run i18n:extract` and `tests/unit/shared/interfaceCatalogs.test.ts`: 4 passed.
  Extraction reports the existing nonliteral `COMMAND_NOTE` comment warnings in
  `MessageContent`; it exits successfully.

The native iPhone model test and existing phone integration test were updated.
Those suites, the rest of CI, and native iPhone compilation are left to GitHub.
No Electron app, provider process, local e2e test or full suite was launched.
The phone, socket and `sotto_threads` schemas are unchanged.

## Headless layout and interaction

A temporary Vite page mounted the real `AgentRequestCard` and `ThreadComposer`
with the app's styles, fixture state, a pending question, one queued message,
and a draft for the next one. Chromium ran headlessly in reduced motion. Both
layouts were checked at 1600×1000, 1280×800 and the 820×560 desktop minimum,
in dark and light. All twelve cases kept the card visible, accepted Queue,
issued only `queue-followup`, and had no horizontal overflow. The captures at
1280 and 820 were visually inspected.

The checkout at `617392e844afc4ec91561d51406691699ef0add5` still excludes Watcher
from the quiet pill. To check the incoming pill without changing another
thread's work, the harness extracted PR #1812's
`fd5de5c45c0a06208c5bfb9dcc71694ba6b0ae07` source to a temporary directory and
merged this change's `ThreadComposer` and `ThreadFollowups` edits into it. The
one overlap retained #1812's quiet options and removed this fix's permission
editing restriction. The full composer used the same fixture with the switch
off. These captures prove that combined desktop source, not a running Owl or
native iPhone screen. A 393px exploratory desktop render is below Sotto's
820px desktop minimum and does not represent the native iPhone composer.

| Layout | Dark | Light |
| --- | --- | --- |
| Pill, 1280 | [Capture](../../artifacts/watcher-card-queue/pill-dark-1280.png) | [Capture](../../artifacts/watcher-card-queue/pill-light-1280.png) |
| Pill, 820 | [Capture](../../artifacts/watcher-card-queue/pill-dark-820.png) | [Capture](../../artifacts/watcher-card-queue/pill-light-820.png) |
| Full, 1280 | [Capture](../../artifacts/watcher-card-queue/full-dark-1280.png) | [Capture](../../artifacts/watcher-card-queue/full-light-1280.png) |
| Full, 820 | [Capture](../../artifacts/watcher-card-queue/full-dark-820.png) | [Capture](../../artifacts/watcher-card-queue/full-light-820.png) |

[Machine-readable checks](../../artifacts/watcher-card-queue/checks.json).
