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

A run takes about 25 minutes for each side, and a few more for the change's traced journey. The workflow keeps the summaries, the logs and the app's own reports as
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
3. **Where the main thread goes**, on the change's side only: one more journey with `--bench-sample`, in which a
   background thread in the app suspends the main thread about once a millisecond, walks its frame pointers and resumes
   it (`BenchSampler`). `Scripts/bench-sample.py` names the addresses with `atos` and writes `trace.md`: for the open,
   the thread's scroll and the stream, the functions and images the main thread was in, and the app's own functions,
   anywhere on the stack and as the innermost app frame. Instruments' `xctrace` cannot record a simulator app on
   GitHub's runners: attaching hung or found no process, a launch was ambiguous because of the Share extension and
   ignored its time limit, and recording the whole Mac never finished saving (#1976, six runs). Each phase's frames
   longer than 50 ms get the same tables for the samples taken while they lasted. The sampler slows the app, so the
   traced journey's numbers are not summarized; read its shares, not its times.
4. **SottoCore's share.** `SOTTO_IOS_BENCH=1 swift test -c release --filter PhoneBenchTests` times reading, merging and
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
| `<phase>.app.textview_measure`, `stream.textview_measure_per_chunk` | Time the paragraphs' text views spent measuring their words: in the phase, or per streamed word. |
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

`main` as of `bde56ebfe` with these benchmarks, on a `macos-26` runner with Xcode 26.6 and iOS 26 on an iPhone 16 Pro
Max simulator: [run 41265243831](https://github.com/millZach/Sotto/actions/runs/41265243831). Runners differ: an earlier
run of the same code ([41262437881](https://github.com/millZach/Sotto/actions/runs/41262437881)) timed SottoCore's
steps two to three times slower, which is why a change is always measured beside its base on one runner.

| Metric | Baseline | Unit |
| --- | ---: | --- |
| `launch.xctest.duration_applicationfirstframepresentationresponsive` | 5.50 | s |
| `launch.app.first_list` | 4,155 | ms |
| `launch.app.footprint` | 103 | MB |
| `launch.decode.shell_full` (287 KB) | 32.6 | ms |
| `list-scroll.app.hitch_time_ratio` | 11.7 | ms/s |
| `list-scroll.app.longest_frame` | 88 | ms |
| `open.app.tap_to_drawn` | 17,481 | ms |
| `open.app.longest_frame` | 17,475 | ms |
| `open.app.cpu` | 19,317 | ms |
| `open.app.textview.make` | 500 | count |
| `open.app.body.MessageView` | 402 | count |
| `open.app.footprint` | 484 | MB |
| `thread-scroll.app.hitch_time_ratio` | 512 | ms/s |
| `thread-scroll.app.hitches` (8.7 s) | 170 | count |
| `stream.cpu_per_chunk` | 368 | ms |
| `stream.wall_per_chunk` | 355 | ms |
| `stream.app.hitch_time_ratio` | 947 | ms/s |
| `stream.app.hitches` (200 words) | 194 | count |
| `stream.per_chunk.body.MessageView` | 1.00 | count |
| `stream.per_chunk.textview.update` | 1.00 | count |
| `stream.bytes_per_push.delta` | 229 | B |
| `stream.bytes_per_push.shell` | 2,075 | B |
| `journey.app.peak_footprint` | 615 | MB |
| `core.timeline-200.items` | 48.5 | ms |
| `core.delta.timeline-200` | 49.8 | ms |
| `core.detail-200.read` | 5.6 | ms |
| `core.shell-full.read` | 4.9 | ms |

What they say:

- **Opening the long thread blocks the main thread for the whole open**, about 17 seconds: its longest frame is its
  open-to-drawn time. It builds a body for each of the 402 messages and a text view for each of 500 paragraphs, and
  costs 380 MB more than the list.
- **Each streamed word costs about 370 ms of CPU** and leaves the screen stuck for 95% of the stream, though only the
  growing message's body runs again for it. It is not the paragraphs' text views measuring their words, which happens
  about twice a word (under 1 ms): the sampled trace puts it in SwiftUI's graph update and layout of the whole thread
  page, which holds every row at once (#749), so each word costs in proportion to the thread. Rebuilding the
  timeline for each word (`core.delta.timeline-200`) adds about 50 ms on the runner's Mac, outside the simulator.
- **Scrolling the long thread** is late for half of every second.
- **The thread list** draws about 4 seconds after launch and scrolls smoothly. The pushes are small since #1910.

## Earlier turns made as they scroll into view

The first change of the climb. The thread page laid out every row at once (#749), so SwiftUI updated and placed every
row of a long thread for each streamed word, and opening one built every message first. Now the latest ten turns, as
many as a computer sends when a thread opens, are laid out whole, and the turns before them are made as they scroll
into view; each reply paragraph is measured once for its words, text size and width.
[Run 41302083390](https://github.com/millZach/Sotto/actions/runs/41302083390) measured the page against the
benchmarks' base on one runner, and [41306747223](https://github.com/millZach/Sotto/actions/runs/41306747223) the
measuring once against the page:

| Metric | Before | After | Unit |
| --- | ---: | ---: | --- |
| `open.app.tap_to_drawn` | 10,095 | 2,931 | ms |
| `open.app.textview.make` | 500 | 22 | count |
| `open.app.body.MessageView` | 402 | 44 | count |
| `open.app.footprint` | 478 | 117 | MB |
| `stream.cpu_per_chunk` | 245 | 113 | ms |
| `stream.app.longest_frame` | 923 | 436 | ms |
| `journey.app.peak_footprint` | 513 | 130 | MB |
| `thread-scroll.app.hitches` | 176 | 84 | count |
| `thread-scroll.app.longest_frame` | 54 | 192 | ms |
| `thread-scroll.app.textview_measure` (the second run) | 275 | 12 | ms |

Scrolling up through the earlier turns makes each as it arrives, so the longest frame of that scroll rose: the long
frames' samples are SwiftUI sizing one tall turn (about half) and making its text views (about a fifth). The page laid
out whole was late on nearly every frame of the same scroll, about 20 frames a second, so its longest frame was short
because none were quick. Zach chose to ship the change with the longer frame named; making a turn cheaper is the
next item.

