# The iPhone at rest, and a list push the size a host sends - November 10, 2026

Two additions to the iPhone benchmarks ([the benchmarks](2026-10-31-iphone-benchmarks.md)), both from the November 10
audit ([the audit](2026-11-10-performance-and-data-audit.md)). The benchmarks had no phase in which the app sits still,
so what it costs at rest had no number (#2400). And their stream sent a thread list push of 2,075 bytes where a running
host sends a phone about 209 KB, so they never gave the phone the work a real push does (#2390). This note says what was
added and how to read it; its baseline comes from the first green run.

## Two idle phases

- `idle-thread`: 30 seconds on the long thread with nothing arriving, after `reply-box-stream`. Its record still says
  it works, so its working line stays.
- `idle-list`: 30 seconds on the Threads list with nothing arriving, after `back`, the long thread working at its top.

Each lasts 30 seconds whatever the screen does, not until the screen is quiet as the other phases do. Each reports the
app's CPU time over its 30 seconds, its memory as it ends, every view body that ran in it, and how often the main run loop
woke (`wakes_per_second`).

Frames are not counted. The driver's display link ticks at every refresh whether anything was drawn or not, so it cannot
say what the app drew, and its own ticks would wake the main thread 60 or 120 times a second. In the idle phases the
driver stops it, and the half-second timer that writes its report, and counts the main run loop's wake-ups instead. A
frame the app commits needs its main thread awake, so the wake-ups bound the frames it draws.

What neither number holds: the background wash and a working card's breathing dot, glow and streak are Core Animation
loops (`LoopingView` in `apps/ios/Sotto/Design.swift`). The render server draws them without waking the app, so their cost
falls outside the app's CPU time and its wake-ups. A working card's one-second clock (`ElapsedText`) wakes the app
each second, and is counted.

## A stream whose list pushes are the size a host sends

`stream-real-push` streams 200 more words the way `stream` does, after `idle-thread`. Every fifth word is followed by a
list push carrying the long thread's record and, beside it, the parts a running host sends whole in every push, made up
at the sizes forge's host sent a phone while one thread worked (`BenchWire.hostSizedState`):

| Part | forge's host, bytes | The benchmark, bytes | The phone reads it |
| --- | ---: | ---: | --- |
| `skillCatalogs` | 115,223 | 115,223: six threads of 60 skills | No |
| `deliveries` | 45,933 | 45,933: 128 deliveries, all accepted | Yes |
| `deliveredDrafts` | 12,929 | 12,929: 128 receipts | Yes |
| `obsoleteDrafts` | 12,929 | 12,929: 128 receipts | No |
| `followupReceipts` | 7,980 | 7,980: 79 receipts | Yes |
| `clientUpdates`, `threadDrafts`, `threadDraftPersistence` | 3,282 | 3,282 | No |
| `host.projects`, `host.providers`, `configuration` and the rest | about 7,000 | the laptop's, as in `stream` | Yes, but for a few |
| The changed thread record | 2,509 | the long thread's, as in `stream` | Yes |
| A whole push | 208,925 | about 200,500 | |

The benchmark's push is 96% of forge's. The difference is forge's projects, providers and settings, which stay as the
benchmark's laptop has them so the list and the new thread sheet do not change, and a longer record. The threads the made-up
ledgers name are not on the list and every delivery was accepted, so no row, reply box or queue reads them; `PhoneBenchTests`
holds each part to its size, the push to between 195 and 209 KB, and the ledgers to what the phone reads and leaves alone.

`stream` is unchanged, so its numbers still compare with earlier runs. The two streams differ in one more way than the
push: at `stream-real-push` the reply is 400 words longer. So set the pushes' own rows against each other
(`decode_per_push.shell`, `apply_per_push.shell`, `bytes_per_push.shell`), and read the difference in CPU per word as the
push and the longer reply together. `core.shell-real.read` reads the same push on the runner's Mac without the simulator,
beside `core.shell-changed.read`.

`journey.frames_unread` counts frames the phone could not read or place in any phase, in the worst journey, with a budget
of zero: the made-up parts are new, and a push the phone refused would make the stream look cheap. Main's November 10 run
had none in either column. The idle phases' counts get no budget until a run shows which are zero.

## What it costs the workflow

The three phases add about 85 seconds to a journey: two half minutes, a stream of about 25 seconds and its quiet. Five
journeys make about seven minutes a side, and the change's traced journey about two more. Main's November 10 run took 23
minutes for its base and 31 for its change, against limits of 50 and 60 minutes and 120 for the whole run.

## Baseline

Owed from the first green run of the iPhone benchmarks on this change's pull request: the `idle-thread.*`,
`idle-list.*` and `stream-real-push.*` rows, `core.shell-real.*`, and how long each side took.

## What it says

Owed with the baseline: whether the wash or a working card's loops cost enough to change, with the number, and what a
host-sized push costs the phone set against the push it sends today.
