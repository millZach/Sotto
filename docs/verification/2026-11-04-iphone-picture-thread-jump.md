# iPhone picture thread jump

November 4, 2026. Branch `fix/ios-picture-thread-jump`.

## The bug

In a thread with many pictures, such as Zach's design hill climb thread, the iPhone page jumped to a picture while the
thread worked, and a finger on the page lost its place, so scrolling felt blocked. It happened on the TestFlight build
from `1d7373696`.

## The cause

Every run's pictures sit in a `LazyVGrid` (`AgentPictures`, ADR-0170) inside the eager thread page. A `LazyVGrid` makes
only the rows near the screen and guesses the height of the rest. Every working update gives each run's grid its steps
again, so every grid is laid out again, and the guess can change by more than 3,000 points in one frame with nothing in
the grid changed. The page's offset stays where it was, so what sits under the reader moves.

Scratch run [41916352653](https://github.com/millZach/Sotto/actions/runs/41916352653) (optimized build, iPhone 16 Pro Max,
five journeys each) took the thread apart. A reader held among older runs while the thread worked saw the jump:

| Arm | Jumped | Biggest height step | Screen changed |
|---|---|---|---|
| The real thread's shape | 5 of 5 | 3,817 pt | 51.3% |
| No image bytes (grey tiles) | 5 of 5 | 3,817 pt | 7.9% |
| No pictures in the steps | 0 of 5 | | |
| No steps at all | 0 of 5 | | |
| Grids left alone when their pictures don't change | 0 of 3 | 142 pt | 0% |
| Grids that make every row | 0 of 3 | | |
| Settled, nothing working, every arm | 0 | | |

So it isn't the images: grey tiles jump just as far. It's the grids being laid out again. Leaving them alone stopped
the jump for a held reader in that run, but not under a finger on the small phone (below). Making every row stopped it,
but cost about 11.6 s of CPU to open the thread and 160 to 185 MB.

## The journey

`FocusJourneyTests.testAPictureThreadStaysStillUnderItsReader` opens the picture thread (`--bench-pictures full`: the real
thread's counts of runs and pictures, with a last run of 40 that keeps growing) and lets the app walk it
(`Bench.swift`, `pictures()`):

- held mid-thread while settled, then for 15 s while the thread works (a step every half second, a picture every fourth);
- held inside the growing run for 15 s while it works;
- six 180-point drags, three up and three down, while it works;
- worked on from its end.

It fails if a held screen was looked at fewer than three times, if it changes more than 5%, if the page's height steps more than 200 points in a frame while held or
under the finger, or if a drag moves the page less than 70% or more than 130% of the finger's travel. The app reads each
drag and each height step on the frame it happens, so a busy main thread can't make a reading late.

## Before and after

Scratch run [41946092272](https://github.com/millZach/Sotto/actions/runs/41946092272) ran the journey on `main` with the
journey added ("before") and with this change ("after"), in Debug builds as CI makes them and in optimized builds, on the
iPhone SE (3rd generation) and the iPhone 16 Pro Max.

| Build | Phone | Held mid-thread: screen changed | Inside the growing run | Under a finger: biggest height step | Drags (180 pt) | Result |
|---|---|---|---|---|---|---|
| Before, Debug | SE | 5.9% | 8.2% | 3,231 pt | 132 to 309 pt | Failed |
| Before, Debug, again | SE | 5.9% | 6.8% | 3,350 pt | 158 to 289 pt | Failed |
| Before, optimized | SE | 5.9% | 8.2% | 3,349 pt | 166 to 289 pt | Failed |
| Before, optimized | 16 Pro Max | | | | | No reading: the first screenshot timed out |
| After, Debug | SE | 0.008% | 1.0% | 120 pt | 166 to 170 pt | Passed |
| After, Debug, again | SE | 0.008% | 1.0% | 120 pt | 150 to 170 pt | Passed |
| After, optimized | SE | 0.008% | 1.0% | 120 pt | 158 to 170 pt | Passed |
| After, optimized | 16 Pro Max | 0% | 0% | 141 pt | 127 to 178 pt | Passed |

The app's reports for five of these runs, before and after on both phones, are in
[`artifacts/ios-picture-thread-jump/`](../../artifacts/ios-picture-thread-jump/); the run's artifact keeps the rest and
the screen recordings for seven days.

A height step of 120 or 141 points is one new row as a picture lands; the 1.0% inside the growing run is that row
appearing. The drags that ran long (289 and 309 points) came in the before runs, when the page swung under the finger.

The same run tried grids left alone when their pictures don't change. It held on the large phone, but on the small one
it swung 3,351 points under a finger and changed 19% of the screen inside the growing run. Grids left alone together with
the known height passed two of three runs; in the third, one drag moved 297 points, with no swing. That one reading is
unexplained, and the change here is the known height alone.

Earlier run [41933876458](https://github.com/millZach/Sotto/actions/runs/41933876458) also tried a lazy stack of rows in
place of each grid. It made the jump worse (11,024 points, 85.9% of the screen on the large phone) and was dropped.

## The change

`TwoAcross`, in `PhotoViews.swift`, gives each run's grid the height its tiles come to: two across, each three by two,
the shape every tile in the grid keeps. The grid stays lazy, so opening a thread makes no more tiles than before, and
the page's height changes only when a tile is added.

## Not proven here

- A finger fully blocked from scrolling was not reproduced in the simulator. In the earlier probes 240 of 244 drags moved
  the page their full distance, and the before runs here show the page moving further than the finger rather than not at all. A jump under a
  finger is the likeliest reading of "can't scroll"; Zach's hand test settles it.
- The simulator is not an iPhone. The cost numbers in
  [the perf note](../perf/2026-11-04-iphone-picture-thread.md) are from the simulator on a GitHub runner.
- The two end-of-thread picture journeys (`testAThreadWithPicturesStaysAtItsEnd` and `…WhileAReplyStreams`) were not run
  with this change in the scratch runs; this pull request's CI runs them on both phones.

## Hand test on a real iPhone

In the design hill climb thread, on a TestFlight build with this change:

- [ ] While the thread works, scroll up among older pictures and hold still for 20 seconds. Nothing moves.
- [ ] While it works, drag up and down slowly among the pictures. The page follows the finger, with no throw and no stop.
- [ ] Scroll into the run that is adding pictures and hold there while it works. Only the new row at its end appears.
- [ ] With the thread settled, scroll the whole thread top to bottom. Nothing jumps.
- [ ] Tap a picture. The viewer opens on that picture; close it and the page is where it was.

## Review

The two-axis review (Sol, at max reasoning) found that a held phase whose screen couldn't be read would pass as still;
the journey now counts the looks set against the first and fails under three (every run above had six or more). It also
had the grid's height floor at zero for a zero-width layout query, and the perf note's picture count match the run it
measured. Left as they are: the bench fixture's arms stay strings and its image handles stay written out twice, since
both are Debug-only scaffolding for this journey.
