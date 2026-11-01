# The iPhone benchmarks - October 31, 2026

What the iPhone app costs on a long thread and a long list, measured the same way before and after every change of the
iPhone performance climb (#1702). The desktop's climb measured each change with a perf test on forge; the iPhone app
only builds on a Mac, so these run on GitHub's `macos-26` runners in the iOS simulator.

## Running them

On a pull request that touches `apps/ios`, add the `ios-perf` label. The `iPhone benchmarks` workflow
(`.github/workflows/ios-perf.yml`) measures the pull request's base and its head on the same runner, one after the other,
and writes both columns and their ratio to the run's summary. It runs again at every push while the label is on. From
the Actions tab it measures any ref against another. On a Mac with Xcode 26.6:

```sh
sh apps/ios/Scripts/bench.sh /tmp/bench/after
python3 apps/ios/Scripts/bench-summary.py compare /tmp/bench/before /tmp/bench/after
```

A run takes about 25 minutes for each side. The workflow keeps the summaries, the logs and the app's own reports as
the `ios-benchmarks` artifact for 30 days.

## What runs

`Scripts/bench.sh` makes one iPhone 16 Pro Max simulator on the newest iOS runtime and builds the app's Debug
configuration, which holds the UI fixture, optimized as Release is (`-O`, whole module) and without Xcode's preview stub.

The fixture's computer is the benchmark's data (`SottoCore/BenchWire.swift`). Its frames are built as strings, so every
run reads the same bytes:

- **The list:** 300 threads on the laptop, sent as one `shell` push of every thread record (about 287 KB), the way a host
  that offers `changed-thread-records` (#1910) sends them when a phone connects.
- **The long thread:** 200 turns, each a question, four steps (thinking, a file read, a command, a file change) and a
  Markdown reply in one of four shapes, as one `detail` push (402 messages, 801 steps, about 281 KB). A host sends a phone
  only the last turns of a thread at first; a phone that has stayed on a long thread, or scrolled back through it, holds
  this many.
- **The stream:** 200 `detail-delta` pushes, one word each, one every 50 ms after the last was applied. Every fifth is
  followed by a `shell` push carrying only the long thread's record, and every twentieth finishes a step and starts
  another, as a working thread does.

Every frame goes through `Wire.readFrame` off the main actor, the records cache, and `AppModel.push`, the path a live
computer's frames take.

Then:

1. **Launch.** `PerformanceJourneyTests` measures five cold launches with XCTest's launch metric, to the first
   responsive frame.
2. **The journey, five times**, each from a cold launch by `simctl` with nothing attached. The app walks it by itself
   (`Sotto/Bench.swift`):
   - `launch`: to the first frame that shows all 300 threads.
   - `list-scroll`: the list scrolled 12,000 points down and back at 3,000 points a second.
   - `open`: the long thread opened as a notification opens it, to its first drawn frame.
   - `thread-scroll`: the long thread scrolled 12,000 points up and back.
   - `stream`: the reply streamed in.

   Each phase lasts until half a second passes without a late frame. The scroll sets the offset from the clock every
   frame, so a late frame jumps as a fling would.
3. **SottoCore's share.** `SOTTO_IOS_BENCH=1 swift test -c release --filter PhoneBenchTests` times reading, merging and
   laying out the same frames on the runner's Mac, without the simulator.

The journey is not driven by XCUITest. XCUITest turns on and reads the whole accessibility tree for every gesture, and
on the long thread that cost more than the thread: the first version of these benchmarks spent 57 minutes on its swipes
([run 41251919327](https://github.com/millZach/Sotto/actions/runs/41251919327)).

## What the numbers mean

Every number is the median of the five launches or the five journeys; a `core.*` timing is the median of the rounds
`PhoneBenchTests` times it (7 to 31). Lower is better for all but `journey.completed`, which counts the journeys that
finished. A journey that ends on `failed-<why>` (the list or the thread never drew) fails the script and is left out.

| Metric | What it is |
| --- | --- |
| `launch.xctest.duration_applicationfirstframepresentationresponsive` | XCTest's launch metric: process start to the first responsive frame. |
| `launch.app.first_list` | Process start to the first display frame after the frame that shows all 300 threads was committed (launches and journeys). |
| `launch.bytes/decode/apply.shell_full` | The connect push: its bytes, reading it off the main actor, applying it on the main actor. |
| `launch.list_rebuild` | Building the list's sections from every computer's threads (`FocusThreads`), summed over the launch. |
| `<phase>.app.cpu` | CPU time on every thread of the app while the phase lasted. |
| `<phase>.app.hitches` | Frames that came later than one and a half of the display link's frame times (`targetTimestamp - timestamp`), counted from the phase's start. |
| `<phase>.app.hitch_time_ratio` | Milliseconds of lateness for each second of the phase, as Apple's hitch time ratio counts it. |
| `<phase>.app.longest_frame` | The longest time between two frames: the longest the screen was stuck. |
| `<phase>.app.footprint` | The memory the system charged the app as the phase ended (`phys_footprint`, Xcode's memory gauge). |
| `journey.app.peak_footprint` | The most it charged at any point of the journey, the kernel's high-water mark. |
| `open.app.tap_to_drawn` | From the open to the first display frame after the frame that draws the long thread was committed. |
| `open.app.<count>` | What opening it built: message bodies, Markdown blocks, text views, bytes of Markdown parsed. |
| `stream.wall_per_chunk` | Time per streamed word, including the 50 ms wait after each: 50 ms is the floor. |
| `stream.cpu_per_chunk` | CPU time per streamed word. |
| `stream.per_chunk.<count>` | View bodies, text view updates, Markdown parses and timeline rebuilds per streamed word. |
| `stream.bytes/decode/apply_per_push.<kind>` | The stream's pushes: bytes, reading time, applying time. |
| `core.*` | SottoCore's timings on the runner's Mac, from `PhoneBenchTests`. |

A decode is timed from the call to its return on the main actor, so a busy main actor lengthens it; the `core.*.read`
lines time reading alone.

Simulator numbers are the runner's Mac, not an iPhone: they compare a change with its base on the same runner, and say
nothing absolute about a phone. A phone is slower than the runner, so a cost that grows with a thread grows faster there.

## Baseline

Two runs of the same harness on `main` as of `bde56ebfe` plus the benchmarks, on two `macos-26` runners with Xcode 26.6
and iOS 26 on an iPhone 16 Pro Max simulator: [run 41262437881](https://github.com/millZach/Sotto/actions/runs/41262437881)
and [run 41260169131](https://github.com/millZach/Sotto/actions/runs/41260169131). The second runner was two to four
times slower on the same code (compare the `core.*` lines), which is why a change is always measured beside its base on
one runner. In the earlier run, the open's and the launch's frame counts started at the phase's first frame and missed
the block that starts it; they are left out.

| Metric | Run 41262437881 | Run 41260169131 | Unit |
| --- | ---: | ---: | --- |
| `launch.xctest.duration_applicationfirstframepresentationresponsive` | 6.19 | 6.66 | s |
| `launch.app.first_list` | 5,078 | 4,714 | ms |
| `launch.app.footprint` | 103 | 102 | MB |
| `list-scroll.app.hitch_time_ratio` | 13.6 | 11.4 | ms/s |
| `list-scroll.app.longest_frame` | 86 | 82 | ms |
| `open.app.tap_to_drawn` | 16,918 | 12,734 | ms |
| `open.app.longest_frame` | 16,918 | – | ms |
| `open.app.cpu` | 19,696 | 15,527 | ms |
| `open.app.textview.make` | 500 | 500 | count |
| `open.app.footprint` | 472 | 481 | MB |
| `thread-scroll.app.hitch_time_ratio` | 540 | 452 | ms/s |
| `thread-scroll.app.hitches` | 171 | 168 | count |
| `stream.cpu_per_chunk` | 367 | 296 | ms |
| `stream.wall_per_chunk` | 361 | 289 | ms |
| `stream.app.hitch_time_ratio` | 942 | 935 | ms/s |
| `stream.app.hitches` (200 words) | 197 | 197 | count |
| `stream.per_chunk.body.MessageView` | 1.00 | 1.00 | count |
| `stream.per_chunk.textview.update` | 1.00 | 1.00 | count |
| `stream.bytes_per_push.delta` | 229 | 229 | B |
| `stream.bytes_per_push.shell` | 2,075 | 2,075 | B |
| `journey.app.peak_footprint` | 494 | 503 | MB |
| `core.timeline-200.items` | 162 | 44 | ms |
| `core.delta.timeline-200` | 88 | 42 | ms |
| `core.detail-200.read` | 20.3 | 5.0 | ms |
| `core.shell-full.read` | 9.9 | 4.9 | ms |

What they say:

- **Opening the long thread blocks the main thread for the whole open**, 13 to 17 seconds: its longest frame is its
  open-to-drawn time. It builds a body for each of the 402 messages and a text view for each of 500 paragraphs, and
  costs 370 MB more than the list.
- **Each streamed word costs 300 to 370 ms of CPU** and leaves the screen stuck for 94% of the stream, though only the
  growing message's body runs again for it. The likely cost is layout: every paragraph's text view measures its words
  again on each layout pass, with nothing cached, in a stack that lays out every row when one grows.
- **Scrolling the long thread** is late for half of every second.
- **The thread list** draws in about 5 seconds from launch and scrolls smoothly. The pushes are small since #1910.
