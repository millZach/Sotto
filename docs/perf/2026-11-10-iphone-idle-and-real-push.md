# The iPhone at rest, and a list push the size a host sends - November 10, 2026

Two additions to the iPhone benchmarks ([the benchmarks](2026-10-31-iphone-benchmarks.md)), both from the November 10
audit ([the audit](2026-11-10-performance-and-data-audit.md)). The benchmarks had no phase in which the app sits still,
so what it costs at rest had no number (#2400). And their stream sent a thread list push of 2,075 bytes where a running
host sends a phone about 209 KB, so they never gave the phone the work a real push does (#2390). This note says what was
added and how to read it; its baseline comes from the first green run.

Everything added runs after `back`, the journey's last phase before. Every phase before it runs as it did, with the
same work, so its numbers still compare with earlier runs. The journey now goes on: `settle-others`, `idle-list`,
`reopen`, `stream-real-push`, `end-turn`, `idle-thread`.

## Two idle phases

- `idle-list`: 30 seconds on the Threads list with nothing arriving and one thread working, the long one. The
  benchmark's list shows eight threads working, so a phase of its own before it, `settle-others`, settles the other
  seven in one list push. The list's other phases keep all eight.
- `idle-thread`: 30 seconds on the long thread with nothing arriving, once it has stopped working. A phase of its own
  before it, `end-turn`, ends the turn as a host does: a `detail-delta` that finishes its running step, and a list push
  with its record settled. The page then shows no working line, running step or breathing light.

Each lasts 30 seconds whatever the screen does, not until the screen is quiet as the other phases do. Each reports the
app's CPU time over its 30 seconds, its memory as it ends, every view body that ran in it, and how often the main run
loop woke (`wakes_per_second`). Each keeps how many threads were working as it began, and the workflow fails when the
list shows more than one or the thread is still working (`<idle>.worst.working_threads`, budgets of 1 and 0).

Frames are not counted. The driver's display link ticks at every refresh whether anything was drawn or not, so it cannot
say what the app drew, and its own ticks would wake the main thread 60 or 120 times a second. In the idle phases the
driver stops it, and the half-second timer that writes its report, and counts the main run loop's wake-ups instead. A
frame the app commits needs its main thread awake, so the wake-ups bound the frames it draws.

## What the loops cost

The background wash and a working card's breathing dot, glow and streak are Core Animation loops (`LoopingView` in
`apps/ios/Sotto/Design.swift`). The render server draws them without waking the app, so the idle phases' own numbers
cannot tell them apart from the rest. So the benchmarks walk the two idle phases again in a short journey of their own
from a cold launch (`--bench-journey idle`), three times as the app runs and three times with `--ui-still`, which stops
every looping animation, taking turns so a runner that slows down weighs on both alike. The difference is what the loops
cost the app:

- On the list, `idle-list.loops.app_cpu` is the wash and one working card.
- On the thread, `idle-thread.loops.app_cpu` is the wash alone, as a thread that has stopped shows no working loops.
- The first less the second is about what one working card's loops cost.

A working card's one-second clock (`ElapsedText`) is not a loop: it runs in both, so it falls out of the difference.
`<idle>.loops.spread` is how far the three runs on either side went apart on their own; a difference smaller than that
is the runner's, not the loops'.

What the loops cost the render server is not measured here, and cannot be from the app. The app reads only its own CPU
time and its own main thread, and in the simulator the render server is a process on the runner's Mac, drawing with the
Mac's graphics, not an iPhone's. Instruments on a real iPhone, which records the render server and the GPU beside the
app, would measure it.

## The second open

The stream with a host-sized push needs the long thread open, and the journey left it at `back`. So `reopen` opens it
again, as `open` did, after `idle-list`. The page shows the thread as it was left until a fresh copy is read, and the
fresh copy is the thread's first `detail` push again, so the reply is as short as `stream` found it. Its numbers are
`reopen.app.*`, kept out of `open`'s rows. It costs the journey about as long as `open` does, about 4 seconds; its own
CPU and time to draw are in the baseline below.

## A stream whose list pushes are the size a host sends

`stream-real-push` streams 200 words the way `stream` does, after `reopen`. Every fifth word is followed by a list push
carrying the long thread's record and, beside it, the parts a running host sends whole in every push, made up at the
sizes forge's host sent a phone while one thread worked (`BenchWire.hostSizedState`):

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

`stream` is unchanged, so its numbers still compare with earlier runs. Both streams start from the same reply. They
differ in one more way than the push: `stream` follows `thread-scroll`, which made the earlier turns as they scrolled
into view, and `stream-real-push` follows an open, which makes only the latest ten. So set the pushes' own rows against
each other (`decode_per_push.shell`, `apply_per_push.shell`, `bytes_per_push.shell`), and read the difference in CPU per
word as the push and the page together. `core.shell-real.read` reads the same push on the runner's Mac without the
simulator, beside `core.shell-changed.read`.

`journey.frames_unread` counts frames the phone could not read or place in any phase, in the worst journey of any kind,
with a budget of zero: the made-up parts and the settling pushes are new, and a push the phone refused would make the
stream look cheap or leave an idle phase on the wrong page. Main's November 10 run had none in either column.

## What it costs the workflow

The phases after `back` add about 95 seconds to a journey: two half minutes, the second open, a stream of about 25
seconds, and the settling phases' waits. Five journeys make about eight minutes a side, and the change's traced journey
about two and a half more. The six idle journeys take about 80 seconds each, about eight minutes a side. Main's
November 10 run took 23 minutes for its base and 31 for its change, so expect about 23 and 50 on this pull request, and
about 39 and 50 once main has them, against limits of 50 and 60 minutes a side and 120 for the whole run.

## Baseline

Owed from the first green run of the iPhone benchmarks on this change's pull request, from its change column:
[run …](https://github.com/millZach/Sotto/actions/runs/…), on a `macos-26` runner with Xcode 26.6 and iOS 26 on an
iPhone 16 Pro Max simulator. Its sides took … and … minutes.

| Metric | Value | Unit |
| --- | ---: | --- |
| `idle-list.app.cpu` | … | ms |
| `idle-list.app.wakes_per_second` | … | /s |
| `idle-list.app.bodies` | … | count |
| `idle-list.app.footprint` | … | MB |
| `idle-thread.app.cpu` | … | ms |
| `idle-thread.app.wakes_per_second` | … | /s |
| `idle-thread.app.bodies` | … | count |
| `idle-thread.app.footprint` | … | MB |
| `idle-list.loops_on.cpu` | … | ms |
| `idle-list.loops_off.cpu` | … | ms |
| `idle-list.loops.app_cpu` | … | ms |
| `idle-list.loops.spread` | … | ms |
| `idle-thread.loops_on.cpu` | … | ms |
| `idle-thread.loops_off.cpu` | … | ms |
| `idle-thread.loops.app_cpu` | … | ms |
| `idle-thread.loops.spread` | … | ms |
| `open.app.tap_to_drawn` | … | ms |
| `reopen.app.tap_to_drawn` | … | ms |
| `open.app.cpu` | … | ms |
| `reopen.app.cpu` | … | ms |
| `stream.bytes_per_push.shell` | … | B |
| `stream-real-push.bytes_per_push.shell` | … | B |
| `stream.decode_per_push.shell` | … | ms |
| `stream-real-push.decode_per_push.shell` | … | ms |
| `stream.apply_per_push.shell` | … | ms |
| `stream-real-push.apply_per_push.shell` | … | ms |
| `stream.cpu_per_chunk` | … | ms |
| `stream-real-push.cpu_per_chunk` | … | ms |
| `core.shell-changed.read` | … | ms |
| `core.shell-real.read` | … | ms |

## What it says

Owed with the baseline. A share of one core is the CPU time over the phase's 30,000 ms.

- **At rest on the list**, with one thread working, the app spent … ms of CPU in 30 seconds (…% of one core), its main
  thread woke … times a second, and … view bodies ran.
- **At rest on a thread that has stopped**, … ms (…% of one core), … wake-ups a second, … view bodies.
- **The loops** cost the app … ms of the list's 30 seconds (the wash and one working card) and … ms of the thread's (the
  wash alone), against runs … ms and … ms apart on their own. Then one of:
  - Each share is inside its spread: the loops cost the app nothing the benchmark can tell from the runner, and they stay
    as they are.
  - A share is past its spread: the [wash / working card's loops] cost the app …% of one core while the page sits still,
    which is enough to change, and an issue holds the number.

  What they cost the render server is not measured: the app cannot read it, and Instruments on a real iPhone would.
- **The second open** drew in … ms against the first's … ms, for … ms of CPU against ….
- **A list push the size a host sends** took … ms to read and … ms to apply, against … ms and … ms for the 2 KB push.
  Each streamed word cost … ms of CPU against `stream`'s … ms.
