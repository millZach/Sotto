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

## Not checked here

The column is faint at rest on purpose (Zach asked for it to stay faint until hovered), so its resting ticks are below 3:1
against the canvas; they reach full strength under the pointer or the keyboard. A flight between Watcher's two trees crosses
behind the room above the column, as it always has, and is not checked against the lane. macOS and Linux were not checked.
The design captures run on stable, where the column does not show, so no baseline changes.
