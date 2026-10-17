# What Watcher did and Stop all, October 16, 2026

Issue #1120. Watcher's room did things the user could not see or undo from where they were. Zach picked each design from the room polish prototype on October 16, 2026: receipt cards variant A, the takeover line and Stop all in the room header. [ADR-0073](../adr/0073-watcher-coordinates-threads-with-its-providers-own-tools.md#october-16-2026-what-watcher-did-and-stop-all-1120) records the picks and the decisions behind them. Read marks, picked the same day, were taken out of this work on October 17, 2026 and come back in their own pull request after #1142.

## What changed

- **Receipt cards.** Each action Watcher took is a card under the reply of the Watcher turn that took it: Started, Sent to, Stopped or Settled (Could not … when it never reached the thread), the thread's name as a button that opens it beside Watcher, where the thread stands now, then its provider, its computer and its project. Main places each card (`receiptReplies` in the room's projection) from the record's tie between the operation and its Watcher turn, never from anyone's words, and the cards are the only place a thread's name in the conversation is a link.
- **The takeover line.** When the user sends in a thread Watcher was driving for one of their requests, Sotto's quiet line follows that turn: "You took over Weekly note. Watcher stopped sending to it.", with the name opening the thread and the time.
- **Stop all.** In the room header while threads Watcher started are running. It asks first through main's existing preview, naming each thread with what it is doing, and then lists what came of each, including a stop still waiting to be confirmed.
- **The first message survives a reload.** The first entry keeps its message in the window's session too.
- **The phone.** Its page carries the takeover lines as an optional `takeovers` field of host protocol version 1. It already showed receipts, one card per reply.

## How it was checked

On Windows, in `.worktrees/watcher-room-polish`, against Sotto Owl built from the branch, with the room's projection seeded through the end-to-end stand-in (`src/renderer/src/e2e/watcherStandIn.ts`), which now answers Stop all as main does:

- `npx playwright test tests/e2e/watcher.spec.ts -g "receipt"`: in dark and light, at 1600x1000, 1280x800 and 820x560, three receipt cards sit under the reply that took their actions, the reply's own words hold no link, and the takeover line follows the turn; nothing leaves the window at any size; Stop all, reached from the keyboard, asks "Stop the 2 threads Watcher started?" with Cancel focused, Escape returns focus to it, Tab and Enter on "Stop 2 threads" stop them, and the results say "Stopped." and "Stop requested. Waiting for it to confirm."; Escape then leaves focus on Stop all, now for the one thread still running. With reduced motion the working ring on a card does not turn. Every text the room draws, the new controls included, measured 4.5:1 or more against the surface under it ([readings](../../artifacts/watcher-room-polish/readings.json)).
- Captures: [receipts and the takeover line, dark 1280x800](../../artifacts/watcher-room-polish/polish-receipts-dark-1280x800.png), [light 1600x1000](../../artifacts/watcher-room-polish/polish-receipts-light-1600x1000.png) and [light 820x560](../../artifacts/watcher-room-polish/polish-receipts-light-820x560.png); [Stop all asking, dark 820x560](../../artifacts/watcher-room-polish/polish-stop-ask-dark-820x560.png) and [its results, light 820x560](../../artifacts/watcher-room-polish/polish-stop-done-light-820x560.png); [the cards with reduced motion](../../artifacts/watcher-room-polish/polish-receipts-dark-1280x800-reduced-motion.png).
- `tests/unit/main/watcherReceiptReplies.test.ts`: a receipt goes under the last reply of its own turn and never another's, under the turn's message until a reply comes, nowhere for a hidden wake-up with no reply yet, under the reply the transcript shows for a wake-up's turn, and nowhere without a recorded turn or for another Watcher.
- `tests/unit/shared/watcherRoomPolish.test.ts`: a takeover line for each send in a thread the current Watcher drove, once per send, none for a paused standing watch, a stop or another Watcher; Stop all offered only for running threads Watcher started for an active request.
- `tests/unit/renderer/watcherRoomPolish.test.tsx` and `tests/unit/renderer/watcherFirstMessage.test.tsx`: the cards, the line and Stop all (which stays while its stop runs, so Escape cannot lose the results) in the room, and the first message kept through a reload, sent once after one while starting, back in the composer when main then says there is no Watcher, and Watcher's unsent draft when main finishes creating it after all.
- `tests/unit/main/watcherPhoneTakeovers.test.ts`: the phone's page carries the lines with each thread's title, and a page without them still parses.

## After review

A two-axis review found problems, each fixed in its own commit with a test that fails without the fix:

- A receipt stays under the reply of its own turn when a hidden wake-up's turn replies after it, and under the turn's reply, not the user's message, when the user wrote mid-turn. The pane keeps such a reply in view instead of folding it (`watcherReceiptReplies.test.ts`, `watcherRoomPolish.test.tsx`).
- The room resolves the current Watcher and its watched threads through one address index per thread list, never a search per thread (`watcherRoomPolish.test.tsx`).
- One send that ends several requests' work on a thread is one takeover time, so one line (`watcherTakeoverOnce.test.ts`).
- Stop all says it cannot tell what stopped when the stop's answer is lost, answers Escape while its stop runs, and keeps the results for the button's next press (`watcherRoomPolish.test.tsx`).
- A first message returned to the composer after a reload still becomes Watcher's draft after a second reload (`watcherFirstMessage.test.tsx`).
- Main and the window place cards and takeover lines by one shared rule for a shown reply (`isShownReply`).

## Not checked

- Receipt cards, the takeover line and Stop all against main's own Watcher in the running app: those journeys use the stand-in projection, and main's placement of receipts and its takeover lines are covered by the unit tests. No live provider turn was run.
- A paired host: a stop waiting on another computer, and a receipt card for a thread there, were checked only in unit tests and with this computer's threads.
- The iPhone app does not draw the takeover lines yet; it was not built or run. Its receipts are unchanged.
- macOS and Linux were not run.
