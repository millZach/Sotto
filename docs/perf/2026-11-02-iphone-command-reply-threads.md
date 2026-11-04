# What an iPhone's command reply carries, and what compression would save (November 2, 2026)

#2031 left an answer from the iPhone one whole-shell trip: the command's own reply. This note records what
`command-changed-thread-records` (ADR-0028, November 2 amendment) takes off that reply, what is left, and whether
compressing phone traffic is worth doing.

## The measure

```sh
SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/phoneAnswerBytes.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

On the real listener with 632 synthetic thread records and no Watcher page:

| One reply | Before | After |
|---|---:|---:|
| With the connect cuts, as the iPhone connects | 27 KB | 4 KB |

Its guard runs in every test run, without the bench flag. With every record listed, an answer stays under 2% of a whole
shell, 1,559 KB. It grows only by the records that changed. `socketChangedThreadRecords.test.ts` checks that the list put
back matches a `shell` read at the same moment.

## Real shells

The synthetic fixture has little around its records, so it flatters this change. These come from forge's phone listener on
the evening of November 2, with the iPhone's hello, by a throwaway client whose pairing was removed when each run
ended. It printed sizes only and kept nothing. The laptop was not captured again: its figures are worked out from the
November 1 replay (`2026-11-01-phone-connect-size.md`), where 7 open records are 16 KB of a 295 KB shell.

| One reply | Before | After | Saved |
|---|---:|---:|---:|
| forge, 14 listed records, no Watcher page | 119 KB | 84 KB | 29% |
| Laptop, 7 listed records, Watcher's page, worked out | about 295 KB | about 279 KB | about 5% |

The saving is whatever the phone's list holds. A phone connected for a long time saves more, since its list keeps every
thread it has carried since hello.

## What is left is mostly parts that do not change

Forge sent the listener's client 120 shell pushes in 60 seconds, 10,409 KB, with threads working. A second run broke 45
pushes down by part, comparing each push with the one before:

| Part of a push | Bytes a push | Pushes in which it changed |
|---|---:|---:|
| `deliveries` | 46,231 | 0 of 44 |
| `deliveredDrafts` | 12,929 | 0 of 44 |
| `obsoleteDrafts` | 12,929 | 0 of 44 |
| `followupReceipts` | 3,435 | 0 of 44 |
| `host.projects` | 3,390 | 0 of 44 |
| `host.providers` | 2,533 | 0 of 44 |
| `clientUpdates` | 1,821 | 0 of 44 |
| Changed thread records | 2,690 | 44 of 44 |

About 3 KB of each 87 KB push is news. A reply carries the same parts. The window stopped resending these in #1940 (kept
parts); a phone still gets them whole, and on the laptop Watcher's page, 207 KB in the November 1 replay, comes on top.

## Would compression be worth it?

Each frame deflated alone at level 6, with no context kept between messages, as `socketFrames.ts` does for a desktop:

| Frames on forge, 60 s | Frames | Raw | Deflated | Ratio | Median deflate | Median inflate |
|---|---:|---:|---:|---:|---:|---:|
| Hello | 1 | 132 KB | 31 KB | 4.3x | 1.85 ms | 0.40 ms |
| `shell` read | 1 | 119 KB | 30 KB | 4.0x | 1.23 ms | 0.25 ms |
| Shell pushes | 120 | 10,409 KB | 2,913 KB | 3.6x | 1.10 ms | 0.23 ms |
| Thread details | 2 | 840 KB | 205 KB | 4.1x | 5.60 ms | 1.02 ms |
| Detail deltas | 24 | 21 KB | 11 KB | 1.9x | 0.09 ms | 0.03 ms |

Level 1 gave 3,067 KB for the pushes against level 6's 2,913 KB. The times are forge's CPU, not an iPhone's. The November 1
replay found a laptop connect 5.3 times smaller compressed (598 KB to 113 KB).

| A minute of forge's pushes, by what would be built | KB | At 0.5 MB/s |
|---|---:|---:|
| As now | 10,409 | 20.8 s |
| Compressed | 2,913 | 5.8 s |
| Unchanged parts left out, 3 KB a push, worked out | about 360 | 0.7 s |

So compression is worth doing, but second. It cuts everything about four times, including what nothing else can cut: a
419 KB thread detail takes about 0.8 s at 0.5 MB/s, and 0.2 s compressed. Leaving out the unchanged parts cuts pushes and
replies about thirty times, and compression has little left to work on after it.

It may also be small to build. `compresses()` in `socketServer.ts` is what keeps phones out, and `deflateOffered` already
reads an offer of the form Apple's forum threads show URLSession sending. Those threads say URLSession offers
`permessage-deflate` on its own, with no public setting, but Apple does not document it, and this was not read off an
iPhone. So the first step is to record what the iPhone offers and whether Tailscale Serve passes it through. Then send it a
compressed reply on a real device, which ADR-0025's October 18 amendment asks for in any case.

Sources: [Apple forum thread 654362](https://developer.apple.com/forums/thread/654362),
[Apple forum thread 775190](https://developer.apple.com/forums/thread/775190).
