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

## After

Each message, each folded turn and each activity group in the transcript now carries `content-visibility: auto`
with a remembered intrinsic size, so a message out of view skips layout and paint until the reader scrolls near
it. Two things go with it:

- The last twelve elements are forced back to `content-visibility: visible`. Everything that measures the end of
  the transcript — following the stream, Jump to latest, and the request card that steps the Jump button aside —
  needs the end laid out for real rather than estimated.
- The scroller's `overflow-anchor` is back to `auto`. Without it, a message resolving from its estimate to its
  true height as the reader scrolls back moves the text under them; that is what `driftPx` below measures.

Chromium, 400 messages:

| | plain | contained | contained, `overflow-anchor: none` | contained, 240px estimate |
| --- | ---: | ---: | ---: | ---: |
| Layout for the whole transcript | 73 ms | **26.6 ms** | 26.7 ms | 27.8 ms |
| Off by, after scrolling to the end | 0 px | **0 px** | 0 px | 48 px |
| Content jump scrolling 24 steps back | 0 px | **7 px** | 3167 px | 3892 px |
| Worst single step | 0 px | **0.8 px** | 314 px | 455 px |
| Scrolling 24 steps back | 792 ms | 790 ms | 791 ms | 794 ms |

Laying out the transcript is 2.7x cheaper, the reader still lands exactly at the end, and the history stays
still under them. Scrolling itself is unchanged, as it must be: content scrolled into view has to be laid out
either way. The estimate is 160px rather than a truer average of 230px because an estimate that overshoots
leaves `scrollHeight` longer than the transcript really is, and Jump to latest then stops 48px short — exactly
the follow slack, so the transcript would think the reader had stopped following.

React is untouched, as jsdom has no layout to skip: the mount stays at about 1.9x the real thread's
(175 ms → 331 ms in a later, busier session where the real thread's own mount had gone from 139 ms to 175 ms —
read the ratio, not the absolute).

## Why not windowing

Rendering only the turns near the viewport was not needed. The transcript already pages at `TRANSCRIPT_PAGE`
(80 messages), so React never mounts 400 articles; the React cost that is left is the O(n) derivation over the
whole history, which windowing does not remove. Containment takes the part that does grow — layout and paint —
without touching folded turns, activity groups, pending messages, the composer's scroll anchoring, find-in-page
or anchors, none of which a windowed list keeps for free.

One caveat to watch: a `content-visibility: auto` subtree is skipped until it is relevant, so the very old part
of a long thread is laid out only when it is scrolled near, found by find-in-page, or focused. The end of the
conversation, which is what the app measures and what a reader arrives at, is always real.
