# The message scrubber

Checked on Windows on October 22, 2026, in the built app on the Owl track, for Zach's request through Watcher. A long
conversation, in a thread and in Watcher's Conversation tab, has a column of ticks in its left margin, one for each message
the user sent. Zach picked ticks A (evenly spaced, set further out into the margin, rising on a normal curve under the
pointer) and card B (square, with a clear border) from `prototype/message-scrubber`. ADR-0109 records the decision.

## What was done

`tests/e2e/message-scrubber.spec.ts` gave Release notes 1.4 a history of 24 turns and opened it. The column showed 24
ticks, wholly in the margin left of the column, at 1600x1000, 1280x800 and the 820x560 minimum, in dark and light, and the
page did not overflow at any size. Pointing at the sixth tick showed its card, "Message 6 of 24", with the message and
"Codex replied" and the start of the reply. The card stayed inside the transcript and clear of the lane, and the ticks either
side of the pointer were shorter the further they were from it. Pressing the third tick put its message at the top of
the transcript, marked. From the keyboard, Down moved to the next tick and showed its card with the keys it answers, Escape
closed the card, a second Escape returned to the transcript, and Enter on the first tick put focus on the first message.
With motion reduced, the ticks rose and the card appeared without moving. On stable there was no column.

`tests/e2e/watcher.spec.ts` gave Watcher's conversation 20 messages sent. Its column showed 20 ticks in the margin at every
size, and the card said "Watcher replied".

Once Watcher's owl family (#1363) merged, `tests/e2e/watcher-night-scene.spec.ts` gave the same conversation, with three
watched threads, at 1600x1000, 1280x800 and 820x560 in dark and light. Before the fix the landscape painted 161 pixels
inside the lane at 1600x1000, and Watcher's owl sits at the column end of its limb, inside the lane. Now the scene reads
the lane and lays its left margin out from the lane's outer edge, and not one pixel of either canvas, nor any thread
owl's button, falls inside it at any of the six. At 820x560 the left margin is narrower than the lane, so the rail of
eyes shows on the right only, as Zach picked.

| Screenshot | What it shows |
| --- | --- |
| `artifacts/message-scrubber/rest-dark-1280x800.png` | The column at rest, faint, dark |
| `artifacts/message-scrubber/rest-light-820x560.png` | At rest at the minimum window, light |
| `artifacts/message-scrubber/hover-dark-1600x1000.png` | The card and the swell, dark, 1600x1000 |
| `artifacts/message-scrubber/hover-dark-1280x800.png` | The same at 1280x800 |
| `artifacts/message-scrubber/hover-dark-820x560.png` | The same at the minimum, where the lane is the whole 24-pixel margin |
| `artifacts/message-scrubber/hover-light-1600x1000.png` | The card, light, 1600x1000 |
| `artifacts/message-scrubber/hover-light-1280x800.png` | The same at 1280x800 |
| `artifacts/message-scrubber/hover-light-820x560.png` | The same at the minimum |
| `artifacts/message-scrubber/keys-light-1280x800.png` | Reached from the keyboard: the focus ring and the keys line |
| `artifacts/message-scrubber/hover-reduced-dark-1280x800.png` | Motion reduced |
| `artifacts/message-scrubber/watcher-hover-dark-1600x1000.png` | Watcher's conversation, 1600x1000 |
| `artifacts/message-scrubber/watcher-hover-dark-1280x800.png` | The same at 1280x800 |
| `artifacts/message-scrubber/watcher-hover-dark-820x560.png` | The same at the minimum |
| `artifacts/message-scrubber/watcher-owls-dark-1600x1000.png` | The owls and the lane, dark, 1600x1000 |
| `artifacts/message-scrubber/watcher-owls-dark-1280x800.png` | The same at 1280x800 |
| `artifacts/message-scrubber/watcher-owls-dark-820x560.png` | At the minimum: the rail on the right alone |
| `artifacts/message-scrubber/watcher-owls-light-1600x1000.png` | The owls and the lane, light, 1600x1000 |
| `artifacts/message-scrubber/watcher-owls-light-1280x800.png` | The same at 1280x800 |
| `artifacts/message-scrubber/watcher-owls-light-820x560.png` | The same at the minimum |

The ticks and the card take every colour from theme roles in `src/renderer/src/agents/messageScrubber.css`, which
`themeTokens.test.ts` checks. The card's text is the transcript's own text roles on the elevated surface.

## October 24: every message sent, from the thread's store

The fix for the scrubber cut off on long threads ([ADR-0109, October 24 amendment](../adr/0109-a-column-of-ticks-reaches-every-message-the-user-sent.md)),
checked on the built app on Owl, on Windows, with `npx playwright test tests/e2e/message-scrubber.spec.ts tests/e2e/watcher-night-scene.spec.ts` (12 passed).

Before the fix, a thread of 60 messages sent, left and opened again, showed 10 ticks: the window's ten turns. Each Show
earlier messages added twenty more. After it:

- The same thread shows 60 ticks while its window holds ten turns, and the first tick's card reads "Message 1 of 60" with the
  start of its reply, read from the thread's store.
- Show earlier messages, and a press on the first tick, never take the scrubber off the page: a watch on the page for any
  moment without `.message-scrubber` counted none.
- A press on the first tick loads the window back to it and lands it at the top, marked; Home then Enter from the keyboard
  lands it with focus.
- Watcher's conversation, left for Dictate and opened again on its newest ten turns, shows all 60 ticks, and Home then Enter
  lands on the first message with focus.
- Jumping to the first message of a thread of 1,000 turns took 1.2 seconds, the window then drawing all 2,000 messages, and
  of 200 turns 0.3 seconds.

| File | What it shows |
| --- | --- |
| `artifacts/message-scrubber/stored-dark-1280x800.png` | 60 ticks with ten turns loaded, the first one's card from the store, dark, 1280x800 |

`tests/perf/threadPrompts.perf.test.ts` reads 2,500 turns' prompts in a median of 44 ms on the development machine, a 2.6 MB
answer; `tests/perf/scrubberTicks.perf.test.tsx` draws a streamed word with 5,000 ticks in 3.3 ms, writing to no tick.

## Not checked here

The column is faint at rest on purpose (Zach asked for it to stay faint until hovered), so its resting ticks are below 3:1
against the canvas; they reach full strength under the pointer or the keyboard. A flight between Watcher's two trees crosses
behind the room above the column, as it always has, and is not checked against the lane. macOS and Linux were not checked.
A remote host's store answering the scrubber is checked over the socket in `tests/integration/socketThreadPrompts.test.ts`,
not with a real host.
The design captures run on stable, where the column does not show, so no baseline changes.

## October 27, 2026: half the length, and the scroll emphasis

Checked on macOS with headless Chromium, not in the app: a page draws a transcript of 90 messages sent at 1280x800 and
the scrubber's real stylesheet over it, with Citrine's dark and light text roles, placing the ticks as `tickPlaces` does
and marking the messages on screen as `readInView` does. Before is `origin/main`'s stylesheet at a share of 0.8, after is
this change's at 0.5. On that transcript the column went from 640 to 400 pixels and the pitch from 7.2 to 4.5. The
messages on screen read as a short, slightly longer and brighter run of ticks in the column. A 900-pixel scroll over 900 ms,
shot every 33 ms in the lane alone, shows that run sliding down the column a tick at a time, with nothing else moving.
The night scene, the card and the reached states were not drawn; nothing in them changed.

| Screenshot | What it shows |
| --- | --- |
| `artifacts/message-scrubber-half/before-dark-middle.png` | Before, dark, halfway down: the column runs four fifths of the height. |
| `artifacts/message-scrubber-half/after-dark-middle.png` | After, dark, same scroll: half the height, the messages on screen a little longer. |
| `artifacts/message-scrubber-half/before-light-top.png` | Before, light, at the top. |
| `artifacts/message-scrubber-half/after-light-top.png` | After, light, at the top. |
| `artifacts/message-scrubber-half/scroll-frames-dark.png` | Twenty frames of a scroll, left to right, in the lane: the brighter run moves down the column. |
