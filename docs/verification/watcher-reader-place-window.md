# A reader's place in Watcher's conversation as news arrives: verification

November 13, 2026. `fix/watcher-reader-place-window`, on Windows 11 with the built app (`npm run build`) and main's own
Watcher over the fake Codex app server, so the news, its wake-ups and main's history window are the real ones. Zach
reported that the place he was reading in Watcher's conversation jumped whenever a new message came in.

## The cause

Main holds a thread on screen as a history window of its newest ten turns and reads that window again at every publish
(`loadWindow` in `src/main/agents/workspace.ts`, `readMessages({ turns })` in `threadStore.ts`). A turn begins at each
user-role message. In Watcher's conversation every piece of news is one: Sotto's wake-up, which the conversation leaves
out, then Watcher's reply. So each piece of news took the oldest turn off the top of what the pane drew. A reader above
the end lost the rows above them one turn at a time, and then the row they were reading. In a thread the user writes to,
the window moves only when they send, which is why it showed in Watcher's room.

It is not a regression from #1590, #1610, #1885, #1952 or #2369, and #1471's keeper still does its work: it holds a place
by the message the reader is on, and here that message was no longer drawn. Cards appearing and closing above a reader
were measured too and are not part of it (below).

## What was measured

The measure is the first message row reaching the top of the view and how far below the top it starts, before and after
a piece of real news, at 1280x800. A watched thread finishes a turn, main sends Watcher the news, Watcher replies.

| Reader | Before the fix | After the fix |
| --- | --- | --- |
| On the oldest reply drawn (offset 0 px, `scrollTop` 182) | Thrown: that reply is no longer drawn, another message stands at +82 px, `scrollTop` 0. Every piece of news after it does the same. | 0 px for each of three pieces of news; the reply is still drawn, `scrollTop` unchanged at 654; worst frame of about 1,500 sampled for each piece of news: 0 px. |
| Mid-window (offset 0 px, `scrollTop` 2070) | 0 px, but 472 px of rows leave above them with each piece of news (`scrollTop` 2070, 1598, 1126, 654), so the fifth piece of news throws them as above. | 0 px, and nothing leaves above them. |
| At the end | Follows the end. | Follows the end: after Jump to latest the rows held go (26 rows to main's 18) and the next news lands with 0 px to the end. |

Cards above a reader, on the seeded room (`watcherStandIn`), before the fix, in the order they happened: two receipt
cards appearing (+170 px of content above), a watched thread's request card appearing (+220 px), Watcher's own question
appearing (+299 px) and being answered (−271 px), and the request card closing (−220 px). After each, the row being read
stood 0 px, 0 px, −0.3 px, −0.5 px and −0.5 px from where it started: under a pixel in all, which the keeper and the
window's own anchoring already held.

## How it was run

```sh
npx vitest run tests/unit/renderer/readingWindow.test.ts tests/unit/renderer/threadWorkspace.test.tsx tests/unit/renderer/readingPlace.test.ts tests/unit/renderer/watcherNewsTurns.test.tsx
npm run build
npx playwright test tests/e2e/watcher.spec.ts -g "moves main’s window on|keeps a reader’s place while Watcher works on news"
```

- `readingWindow.test.ts` covers what is held and when it is let go.
- Two cases in `threadWorkspace.test.tsx` mount the real Threads page: one counts the rows kept and let go, the other reads
  an answer from its middle while its turn leaves the window and checks the answer's offset and that its turn stays folded.
- The journey in `watcher.spec.ts` is the measurement above, against main's own Watcher.

With the hold switched off, the two component cases fail (the row being read is gone) and the journey fails with the
reader on another message at +82 px. With it on, all pass. The full gates run in CI.

## What it does not do

- A reader who stays above the end while more than 240 messages leave the window is let go of, so the transcript does not
  grow for as long as the room stays open.
- When more turns arrive between two draws than everything the transcript holds, there is nothing to join the new window
  to, and the transcript draws the window as main gives it.
- Leaving Watcher's room and coming back opens the conversation on main's newest ten turns, as before. The place kept
  across that trip (`useKeptReadingPosition`) comes back only if its message is among them.
