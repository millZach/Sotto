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

A run takes about half an hour for each side, and about ten minutes more for the change's traced journey; the idle phases
and the second stream (November 10) added about seven minutes a side. The workflow keeps the summaries, the logs and the app's own reports as
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
- **What a running host sends whole** (#2390): the second stream's `shell` pushes also carry the parts a host sends whole
  in every thread list push, made up at the sizes forge's host sent a phone on November 10, 2026
  (`docs/perf/2026-11-10-performance-and-data-audit.md`, finding 2): each thread's skill list (115 KB), the delivery
  ledger (46 KB), the delivered and obsolete draft ledgers (13 KB each), the follow-up receipts (8 KB) and three small
  parts no phone reads, about 200 KB a push against forge's 209 KB. The rest of forge's is its projects, providers and
  settings, which stay as the laptop's so the list does not change. The threads the parts name are not on the list and
  every delivery was accepted, so the phone shows nothing of them (`BenchWire.hostSizedState`).

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
   - `reply-box`: the reply box out to full and back to small twenty times, by a draft put in and taken out, so no
     keyboard moves the page. Its budgets hold that this draws no part of the conversation (ADR-0184).
   - `reply-box-stream`: the same for as long as another 200 words stream in, to set against `stream`.
   - `idle-thread`: 30 seconds on the long thread with nothing arriving. Its record still says it works, so its
     working line stays.
   - `stream-real-push`: 200 more words as `stream` sends them, each list push the size a running host sends. The
     reply is 400 words longer than at `stream`, so read the pushes' own rows to set the two against each other.
   - `back`: back to the Threads list, as a press on Back goes, until the list is drawn as it stands.
   - `idle-list`: 30 seconds on the Threads list with nothing arriving, the long thread working at its top.

   Each phase lasts until half a second passes without a late frame, but for the idle phases, which last 30 seconds
   whatever the screen does. The scroll sets the offset from the clock every frame, so a late frame jumps as a fling
   would. The three phases added on November 10 come after the ones before them, so those still compare with a base
   from before; only `back` now starts after `idle-thread` and `stream-real-push`.

   In the idle phases the driver stops its own display link and its report's half-second timer, which would wake the
   app's main thread at every refresh, and counts the main run loop's wake-ups instead. The display link ticks at every
   refresh whether anything was drawn or not, so it cannot count frames drawn; a frame the app commits needs its main
   thread awake, so the wake-ups bound them. The background wash and a working card's breathing dot, glow and streak are
   Core Animation loops, which the render server draws without waking the app: neither the app's CPU time nor its
   wake-ups hold what they cost.
3. **The long thread's look**, twice from a cold launch: the app photographs the long thread at fixed distances above
   its end. `bench-summary.py look` fails the run when the change's photos differ from the base's at a distance where
   the base's two launches agree.
4. **Where the main thread goes**, on the change's side only: one more journey with `--bench-sample`, in which a
   background thread in the app suspends the main thread about once a millisecond, walks its frame pointers and resumes
   it (`BenchSampler`). `Scripts/bench-sample.py` names the addresses with `atos` and writes `trace.md`: for the open,
   the thread's scroll and the stream, the functions and images the main thread was in, and the app's own functions,
   anywhere on the stack and as the innermost app frame. Instruments' `xctrace` cannot record a simulator app on
   GitHub's runners: attaching hung or found no process, a launch was ambiguous because of the Share extension and
   ignored its time limit, and recording the whole Mac never finished saving (#1976, six runs). Each phase's frames
   longer than 50 ms get the same tables for the samples taken while they lasted. The sampler slows the app, so the
   traced journey's numbers are not summarized; read its shares, not its times.
5. **SottoCore's share.** `SOTTO_IOS_BENCH=1 swift test -c release --filter PhoneBenchTests` times reading, merging and
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
| `stream.worst_per_chunk.<count>` | The Threads page's and its list's bodies per streamed word in the worst of the five journeys, for the budgets of zero. |
| `list-scroll.worst.<count>` | Bodies of the Threads page's `SheetPage`, its list and its rows during the list's scroll in the worst of the five journeys, for the budgets of zero. |
| `journey.page.<count>` | Over each whole journey, the Threads page coming into the window (`shown`), holding its list as it went out of sight (`holds`), holding it while still in the window (`held_in_window`), and turns of the main run loop that ended, after Core Animation's commit, with the page in the window and drawn from a held list (`stale_frames`). |
| `stream.bytes/decode/apply_per_push.<kind>` | The stream's pushes: bytes, reading time, applying time. |
| `stream-real-push.*` | The same rows as `stream`'s for the stream whose list pushes are the size a running host sends. |
| `<idle>.app.cpu` | CPU time on every thread of the app over the idle phase's 30 seconds. |
| `<idle>.app.wakes_per_second` | Times a second the app's main run loop woke while the idle phase lasted, with the driver's display link and timer stopped. |
| `<idle>.app.bodies`, `<idle>.app.body.<view>` | View bodies that ran in the idle phase: all of them, and each view that ran in any journey's idle. |
| `journey.frames_unread` | Frames the phone could not read or place in any phase, in the worst journey: a push it refused is work the benchmark never measured. |
| `core.*` | SottoCore's timings on the runner's Mac, from `PhoneBenchTests`; `core.shell-real.*` reads a list push the size a host sends. |

Some counts have a budget, the most a change may leave them at (`BUDGETS` in `Scripts/bench-summary.py`); the workflow
fails when the change's side is over one. Counts are the same on any runner, so a budget sits just above what the
change that set it measured, and only tightens.

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
next item. While words in a reply are selected, a new turn leaves the split where it was, so moving the oldest whole
turn into the lazy stack never drops the selection. The open's text views, message bodies and measures, and the
measures per streamed word, now have budgets.

## The Threads list held under an open thread

The second change. The Threads page stays alive under a thread opened over it, and every update to any thread made its
list again for nobody to see: each streamed word drew the list's sections and rows again, and building its groups was
6% of the stream's slow frames. Leaving the page out altogether while a thread covered it halved the CPU of a streamed
word in one experiment (161 to 81 ms), which is what holding it is after. Now the page holds the list it drew as it goes
out of sight, under a thread or on another tab, and lets go in `onAppear`. A swipe back or a press on Back reaches
that at its start, and it completes before the first frame that shows the page again, so no old row is drawn. The list
no longer watches the model itself: its caller hands it which threads Watcher watches and which rows can change that,
so it draws again only when what it shows has changed. The unfolded Duo's sidebar reads the model as before and keeps
updating beside the thread.

The journey's `back` phase and the page counts came first, on their own (`dc5e61f19`), so the base goes back to the list
too. [Run 41400299960](https://github.com/millZach/Sotto/actions/runs/41400299960) and
[run 41400303458](https://github.com/millZach/Sotto/actions/runs/41400303458) measured the hold against that base,
the same commits on two runners:

| Metric | Before | After | Unit |
| --- | ---: | ---: | --- |
| `stream.per_chunk.body.ThreadListSections` | 0.27, 0.27 | 0, 0 | count |
| `stream.per_chunk.body.ThreadListRow` | 0.2, 0.2 | 0, 0 | count |
| `stream.cpu_per_chunk` | 126, 133 | 116, 104 | ms |
| `stream.wall_per_chunk` | 130, 136 | 117, 111 | ms |
| `stream.app.longest_frame` | 568, 650 | 504, 524 | ms |
| `back.app.cpu` | 1,450, 1,573 | 1,556, 1,576 | ms |
| `back.app.longest_frame` | 772, 638 | 707, 731 | ms |
| `journey.app.peak_footprint` | 158, 157 | 156, 158 | MB |
| `journey.page.stale_frames` | 0, 0 | 0, 0 | count |
| `journey.page.held_in_window` | 0, 0 | 0, 0 | count |

The streamed word's CPU fell by 8% and 22% rather than by half: the list's share went, and what remains is the thread
itself, its text and its view graph. The back phase and the peak memory moved within the runners' noise in both
directions. Catching the list up is about a tenth of the back phase's slow frames, and the rest is the page's text and
the transition, which the base pays too. The benchmark goes back with `popViewController`, the transition Back and the
swipe use, not with a finger. The list's bodies per streamed word in the worst journey, and the stale frames, have budgets of zero; the base is over
the first two. The two-axis review found that the list's equality, now the only thing that decides when it draws, left
out a thread's state and the delegated thread a Needs you row waits in, and that the look and back checks could pass
without proving anything; all are fixed. The fixes were not measured again: they add words to an equality check and
make the checks stricter.

## The Threads list's fade under the status bar

The third change. The first full comparison of #2023 showed the list's longest scroll frame rising from 109 to 319 ms
(#2100). The fade under the status bar was state on `SheetPage`, so its body ran as the page left its top and as it came
back, and went back over everything on the page. In about one journey in six SwiftUI then drew all 241 rows again without
asking the list's equality. A diagnostic, [run 41658511677](https://github.com/millZach/Sotto/actions/runs/41658511677),
counted two page bodies in all 50 scrolls, placed the redraws at those two moments, and found no field of the equality
changed in any of them. Why SwiftUI skips the equality after some launches is still unknown, and the fix does not depend
on it. Now the fade is published to one small view, as Watcher's page already did, so that view is all that runs.

[Run 41679524784](https://github.com/millZach/Sotto/actions/runs/41679524784) took turns between main at `7e900174c` and
the fix on one runner, 8 rounds of five journeys a side. The fix's longest frame, hitch time and hitches were lower in all
8 rounds, the most an exact sign-flip test can say with 8 (p = 0.008):

| Metric, in the list's scroll | Main | With the fix | Unit |
| --- | ---: | ---: | --- |
| `app.longest_frame`, median journey | 94 | 17 | ms |
| `app.longest_frame`, worst journey | 587 | 40 | ms |
| Journeys with a frame over 100 ms | 18 | 0 | of 40 |
| Journeys with a frame over 250 ms | 5 | 0 | of 40 |
| `app.hitch_time_ratio`, median journey | 13.5 | 0 | ms/s |
| `app.hitches`, median journey | 3 | 0 | count |
| Journeys that ran the list's body | 7 | 0 | of 40 |
| Journeys that drew its rows again | 6 | 0 | of 40 |
| `body.SheetPage`, per scroll | 2 | 0 | count |

Main has no probe on `SheetPage`, so its 2 comes from the diagnostic, and a comparison against a base from before this
change shows 0 in that column. The gain is wider than the redraws: main's journeys that drew nothing again still had a
frame near 90 ms, the page's body and SwiftUI going back over the page, and those went too.

The other phases moved within the runner's noise in both directions: `open.app.tap_to_drawn` 2,946 to 2,844 ms, the
stream's CPU 13.1 to 12.5 s, the journey's peak memory 154.8 to 154.5 MB. One small thing rose in all 8 rounds: memory as
launch ends, 102.2 to 103.9 MB, and at the list's scroll, 102.9 to 104.5 MB. Later phases go both ways and the peak does
not rise. What it is has not been found; one small object on each page does not account for it by size.

The fix does not stop the list drawing elsewhere. In 2 of its 40 journeys the held list drew 1,928 rows while the long
thread opened, with that phase's longest frame at 3,952 and 6,116 ms, against a median of 2,795. Builds without the fix did
the same in 3 of 145 journeys, too few to say the fix changes the rate. That is #2120. A journey like this on a pull request's head
fails the workflow on the stream's budgets of zero, if it draws during the stream too.

The page, the list and the rows have budgets of zero in the list's scroll in any journey. The benchmark scrolls 50 points
a frame, so it crosses the fade's 24 points at once and changes it once at each end. A finger changes it on every frame
of those 24 points, so main likely cost a person more than these numbers show, but that is read from the code and not
measured. The benchmark builds Debug with optimization, so whether Release builds drew the rows again is also not
measured. The workflow's look step photographs the long thread and not this fade, so the fade's look rests on the code:
the same view, opacity and 24 points.

## The tabs' watch and the thread page's warm-up

The fourth change, aimed at opening the long thread and at #2120. The aim was 1.75 s from the tap to the drawn thread,
and it was not reached. Two scratch runs on one runner each took turns between candidate builds of one change commit, 12
rounds, each journey a cold launch, the long thread opened, 60 streamed words, then back and opened again twice. Main has
no such journey, so the reference is the change built with neither candidate on, whose launch matched main's.

[Run 41972451740](https://github.com/millZach/Sotto/actions/runs/41972451740) placed #2120. In the journeys whose held
list drew, SwiftUI ran `ThreadsView`'s body on every update even with its equality saying nothing changed and its own
watch stopped while held, and `MainTabs`, which watched the whole model, ran every time too. In journeys that drew nothing
`MainTabs` also ran on every update but the page under it did not. So what runs the page is the tabs above it running.
Now `RootView` and `MainTabs` read the model without watching it, and a small view under each compares what they read
(`ModelWatch`, `MainTabsInputs`) and runs them only when it changes, in the same update. The page stops watching while it
is held and catches up as it lets go, and its equality keeps the tabs from drawing it again.

The second change is the warm-up. A second after launch, in a turn of the run loop that isn't following a scroll, a short
made-up thread is read from wire bytes and laid out hidden for 300 ms, so the first thread opened doesn't pay for the page's first use.

[Run 41981480704](https://github.com/millZach/Sotto/actions/runs/41981480704), on a slower runner than the first, with
each round's journey set against the reference's in the same round:

| Metric | Reference | Watch only | Warm-up only | Both | Unit |
| --- | ---: | ---: | ---: | ---: | --- |
| `open.app.tap_to_drawn`, median | 3,830 | 3,473 | 3,016 | 2,916 | ms |
| Rounds the open was faster than the reference | | 7 of 12 | 8 of 12 | 9 of 12 | |
| Open, median of the rounds' differences | | −63 | −653 | −859 | ms |
| Journeys whose held list drew in the stream | 3 of 12 | 0 of 12 | 3 of 12 | 0 of 12 | |
| `ThreadsView` bodies in the stream, worst journey | 24 | 0 | 24 | 0 | count |
| Stream CPU, median of the rounds' differences | | −838 | −2,379 | −1,151 | ms |
| Launch CPU, median | 5,260 | 5,479 | 5,871 | 6,005 | ms |
| Launch CPU, median of the rounds' differences | | +390 | +773 | +1,057 | ms |
| Launch's longest frame, median | 1,313 | 1,315 | 1,194 | 1,265 | ms |

In the first run the warm-up alone opened the thread in 2,188 ms against the reference's 2,557, faster in 9 of 12
rounds, for 596 ms more launch CPU. The launch's longest frame and the time to the first list stayed within a few
milliseconds of the reference or below it in both runs. In the second run no journey with the new watch drew the held list in the stream, against 8 of the other
candidates' 36. The list still draws in about one open in four, in every build: `ThreadsView` runs about four times
while the thread pushes over it, which is the navigation, not the model. `stream.worst_per_chunk.body.ThreadsView` has a
budget of zero. The app's own body still runs on every update; that is #2120's next lead.
