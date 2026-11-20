# Why a thread picked in the sidebar takes seconds to show (November 20, 2026)

Zach, November 20: a thread clicked in the sidebar takes 5 to 10 seconds to show. This note is what was measured on the
laptop that day, the order of the fixes (#2733) and how each is to be measured. It is the before for all of them.

## How it was read

Everything was read on the laptop without restarting Sotto or changing any data, on Owl `0.1.44-owl.20261120.1`
(`5e0b7d1a0`), with 1,065 threads on the laptop, 235 on forge and three working:

- **One activity recording** (Record a minute) from 18:28:52 to 18:29:53 UTC, while Zach clicked 19 laptop threads in
  the sidebar, one to six seconds apart. Zach said most of them felt slow. Its frames were read against that build's own
  `out/renderer` and `out/preload` bundles.
- **`turns.jsonl`**, which times every `select-thread` main runs, from November 15 on.
- **An outside probe on main's loop**: `GET /` on one of main's thread tool servers ten times a second for 15 minutes,
  from 18:28:06 UTC.
- **Read-only queries of `threads.sqlite`** for the stored activity of every thread clicked since November 19.
- Main's and the window's hang recordings, and the process list's CPU over 20 s at rest.

## Main, the store and forge are not it

| Where | Measured |
| --- | --- |
| Main running `select-thread` (`turns.jsonl`) | November 20, 54 switches: median 36 ms, highest 174 ms. November 19, 221 switches: highest 350 ms |
| The same, in the recording | 2 to 184 ms each; `navigate` 486 ms and `observeThreads` 507 ms over the 19 clicks |
| Main's loop, from outside | 8,668 answers: median 1 ms, 99th percentile 50 ms. Nothing over 210 ms during the recording |
| Main's hang watch (a stop of 1 s or more) | Nothing after start-up at 16:09 to 16:10 UTC |
| Reading a clicked thread's stored activity | 1 to 304 ms for the query and up to 46 ms to parse, on a quiet store; 101 ms of main in the whole minute |
| The history handed to the window (`wholeDetail`) | 47 ms of main in the minute |
| Forge | No clicked thread was on forge. #1990 (a remote thread sent whole twice, about 1.6 s for a 3.7 MB thread on October 18) applies only to forge's threads |

The clicked threads held 0 to 2,000 activity records (2,000 is the cap), 0.01 to 14.9 MB of them, and up to 1,017
messages. At rest, with nobody clicking, the window used 27% of a core, main 11% and the GPU process 19%. 7.8 GB of 31 GB
was free.

## The window is

The window ran 19.0 s of JavaScript in the minute, beside about 9 s of native time the profile cannot break down (style,
layout, paint and the bridge's copies). It was about 30% busy at rest with three threads working and 40% to 70% busy
around the clicks, in tasks of up to 1.5 s, and it was never 0.4 s without work before the next click. A switch cost the
window 0.3 to 3.7 s of work before the next press. The window's hang watch never fired, because it asks every 2 s and the
window answers between tasks.

Where the 19 s went, each figure the minute's total:

| | ms | Where |
| --- | ---: | --- |
| React rendering, all of it | 9,899 | of which the urgent commits (`flushSync`) 4,474 and the transitions 1,934 |
| Structural sharing of the whole state on each commit | 4,380 | `session.share` in `AgentContext.tsx` (`stateSharing.ts`), inside `setSnapshot`'s updater; up to 688 ms in one commit |
| The preload parsing main's replies and histories with zod | 2,046 | `invokeParsed` in `src/preload/index.ts` (`command`, `threadDetail`) |
| The preload receiving broadcasts | 1,672 | the `onState` subscription: its zod parse, `mapHostReferences` and about 700 ms of copying across the bridge |
| Measuring the composer in a layout effect | 456 | `ThreadPane.tsx`, `getBoundingClientRect` forcing layout |
| The reply editor's decorations | 408 | ProseMirror's `applyOuterDeco` |
| Writing the shell cache | about 1,000 | `writeShellCache`, a `JSON.stringify` of the whole shell every 2 s |

One of the 1.36 s tasks right after a click: the urgent commit of the selection's answer 350 ms, of which the structural
sharing 257 ms; the preload's parse of a reply 158 ms; a broadcast 116 ms; 292 ms of native time and 59 ms of garbage
collection.

## What comes next

One pull request each, in this order (Zach's pick, November 20):

1. **Time each switch** (this note's pull request). The window notes each switch in `thread-switch-diagnostics.jsonl`:
   milliseconds from the press to the handler (`inputMs`), to main's answer drawn (`replyMs`), to the history held
   (`historyMs`) and to the first frame painted with it (`paintedMs`). Every fix below is measured by the median and the
   90th percentile of `paintedMs` over a day of Zach's own switches, before and after its Owl, beside its own benchmark.
2. **Share only what changed.** Find what the structural sharing walks again on every commit and hand it over by
   identity, as #1330 did for unchanged thread records.
3. **A click redraws only the selection**, and the composer is measured when its size changes.
4. **The shell cache is written far less often.**
5. **The preload stops parsing what main sends**, and keeps checking everything the window sends main.
