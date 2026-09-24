# The context and cost figures leave the corner under the composer (#127)

The owner's pick for the workspace and branch layout in #127, recorded in a comment on that issue, removed the two usage figures (how full the context window is, and the estimated cost at API rates) from under the composer on Threads and on Chats. Sotto still records and prices usage; nothing on screen shows it. The compaction row stays on Threads.

What the row does now. On a pane by itself the row is empty until compaction has something to say, so it takes no height and the transcript keeps the space. With panes side by side it holds one quiet line open (23.3px) whether or not a pane has been compacted, so the composers stay level. That was the reason it was one row with the figures, and the figures were what used to hold it open. Below 450px of pane height the line tightens as the figures' padding used to.

Checked in the built app (`npm run build`, the `success` e2e scenario, Claude fake threads Workshop and Docs), measuring each composer's bottom and the row's height:

| Window | Layout | Composer bottoms | Row height |
|---|---|---|---|
| 1600x1000 | Workshop alone | 980 | 0 |
| 1600x1000 | Workshop and Docs side by side | 960.8, 960.8 | 23.3, 23.3 |
| 1600x1000 | Side by side, Workshop showing "Context compacted" | 960.8, 960.8 | 23.3, 23.3 |
| 1280x800 | Side by side, Workshop showing "Context compacted" | 760.8, 760.8 | 23.3, 23.3 |
| 820x560 | Tabs, one pane shown | 550, 550 | 0, 0 |

The fake Claude threads do not offer Compact context, so the compacted rows were made by placing exactly what `ThreadCompaction` renders for a finished compaction (`<div class="thread-compaction"><p role="status">Context compacted</p></div>`) into Workshop's row. No `.thread-usage` element exists on either page. The change adds and removes no transition or animation, so reduced motion has nothing new to hold still. Chats was checked in light; the only thing removed there is text that read theme tokens, and the Threads captures cover dark.

Captures, in `artifacts/remove-usage-figures/`:

- `threads-single-1600x1000-dark.png`: one pane, nothing under the composer.
- `threads-split-1600x1000-dark.png`: side by side, "Context compacted" under Workshop and nothing on its right, Docs' composer level with it.
- `threads-split-1280x800-light.png`: the same in light.
- `threads-split-820x560-dark.png`: the minimum window, tabbed, nothing under the composer.
- `chats-1280x800-light.png` and `chats-820x560-light.png`: a Chats conversation with the voice row under the composer and no figures.

`tests/e2e/composer-short-window.spec.ts` now measures the row itself rather than the figures, and its panes are found by their host-keyed thread IDs.
