# New thread greeting verification

October 14, 2026, on `feat/new-thread-greeting` from `main` at e3e7e2c3. Zach asked for a new thread to say something
like "what should we work on" in place of "What is next for this thread?", picked at random, and for the composer to
sit up where the eye is until the thread starts. He answered the questions first: a bit playful, a project line under
the greeting, every pane centring its own new thread, the placeholder left as it is, straight to stable. From
`docs/prototypes/new-thread-greeting-prototype.html` he picked variant a, centred rather than about 40% down, and a
720px composer after saying the prototype's 900px one was too wide. The pick is recorded in
`docs/plans/new-thread-greeting.md`; the glossary term is **Greeting**.

## What changed

- `threadGreeting.logic.ts` holds the eleven lines and the three timed ones (morning, evening, late night), picks one
  the first time the window shows a thread, keeps it while the window is open, and never opens two new threads in a
  row on the same line.
- `ThreadTranscript` decides when a thread greets: nothing sent, nothing pending or queued, history loaded and its
  summary counting no messages, idle rather than working or failed, not settled or archived, not compacting, no request
  and no older history to show, and not Watcher's own conversation. The last four of those were added after Sotto's bug
  bot showed a resumed, archived or failed empty thread greeted as new. It draws
  `ThreadGreeting` through a portal into a slot the pane keeps directly above the composer. Every other empty case
  keeps the line it had.
- `ThreadPane` adds a balance element under the composer. While the slot holds a greeting, `threads.css` gives the
  empty transcript and the balance the same share of the room, so the greeting and composer stand in the middle, and
  narrows the composer to 720px. On a send from the pane it notes where the composer stood; when the greeting leaves,
  the composer slides from there to the bottom and widens as it goes (320ms), and does neither under reduced motion.
  A greeting emptied any other way, such as a message from the phone, moves at once.
- `threadHostName` in `HostBadge.tsx` names where a thread runs for both the greeting and the branch toolbar's
  Run on, which had the rule inline.

## In the running app

`tests/e2e/new-thread-greeting.spec.ts` opens the e2e profile's empty Workshop thread and checks, at 1600x1000,
1280x800 and the 820x560 minimum, that the room above the greeting and the room below the composer are within 48px of
each other, that the composer is no wider than 720px, and that nothing passes the pane's edges. At the minimum the
model picker, opened from the middle, opens downward and stays inside the window. After a send the greeting is gone
and the composer is back at the bottom at its usual width. Captures from that run, with
`SOTTO_E2E_EVIDENCE=publish`, are in `artifacts/new-thread-greeting/`:

- `greeting-1600x1000-dark.png`, `greeting-1280x800-dark.png`, `greeting-820x560-dark.png`: the greeting, the project
  line ("Sotto test", "This computer"; the e2e folder is not a Git repository, so no branch shows) and the composer
  in the middle of the pane.
- `greeting-820x560-model-picker.png`: the model picker at the minimum, opened below the chip.
- `greeting-1280x800-light.png`: the light theme.
- `greeting-1280x800-after-send.png`: the first message sent and the composer at the bottom.

Reduced motion is checked in `tests/unit/renderer/agents/threadsView.test.tsx`: the first send starts one animation on the
composer, and none when `data-reduced-motion` is on. A greeting kept past its hour gives up a timed line the next
time the thread is drawn (`threadGreeting.test.ts`).

`tests/e2e/effort-picker.spec.ts` clicked "What is next for this thread?" to close the effort card with a pointer
outside it. The card now opens over the greeting, so the spec clicks the empty transcript above instead.

## Not checked

- Two panes side by side were not captured. Each pane centres its own new thread, which Zach chose knowing that the
  composers then sit at different heights until the new one starts.
- The greeting on a paired host's thread, where it says the host's name, was read from the code, not run.
