# Long transcript cost

What a thread of hundreds of messages costs to open, to scroll and to stream into. The companion to
`threads-render.md`, which measures one streaming update on a real thread; this one measures length.

Two rigs, because one machine cannot answer both halves:

```
npx vitest run tests/perf/longTranscript.perf.test.tsx --disable-console-intercept
node scripts/perf-bench/bench-transcript-paint.mjs
```

The first mounts the Threads page on a synthetic thread of 400 messages, built by repeating a real thread's
messages with fresh ids and timestamps (the first copy keeps its own ids so the thread's activities still anchor
where they did). It reports React's work: the mount, and one streaming chunk. It runs in jsdom, which has no
layout and no paint, so **it cannot see CSS containment at all**.

The second is a Chromium rig: the transcript's geometry with 400 messages of widely different heights, measured
for layout and for the two behaviours containment can break — landing exactly at the end (Jump to latest, and
following a stream) and scrolling back through the history without the text moving under the reader.
`driftPx` is the total unexpected movement over 24 upward scroll steps of 600px: a reader scrolling back by
600px expects the text to move by exactly 600px, and anything else is the content jumping.

Windows 11, dev build, three runs of each.

## Before

React, on the 400-message thread (medians, spread in brackets):

| | 31 messages (the real thread) | 400 messages |
| --- | ---: | ---: |
| Mount | 139 ms (106–143) | 204 ms (181–273) |
| React mount | 134 ms (101–137) | 201 ms (153–255) |
| ms per streaming update | — | 21 (12–23) |
| Message articles drawn at open | 31 | 58 |
| Message articles drawn when the reader shows every earlier message | 31 | 283 |
| ms per streaming update, fully expanded | — | 19 (19–35) |

The transcript already pages: `TRANSCRIPT_PAGE` is 80, so opening a 400-message thread mounts the last 80
messages, of which 58 are drawn — the rest are inside folded turn work. That is why 400 messages cost 200 ms to
mount rather than thirteen times the 31-message thread: the extra ~65 ms is the O(n) derivation over the whole
history (splitting turns, placing activities), not React drawing 400 articles. Memoisation already holds the
per-update cost flat as the transcript grows.

Chromium, same 400 messages, no containment:

| | plain |
| --- | ---: |
| Layout for the whole transcript | 73 ms (50–92) |
| Off by, after scrolling to the end | 0 px |
| Scrolling 24 steps back | 792 ms |
| Content jump over those steps | 0 px |

So the cost that grows with length is the browser's, not React's: laying out and painting every message the
reader has asked for, which is the whole history once they press *Show earlier messages*.
