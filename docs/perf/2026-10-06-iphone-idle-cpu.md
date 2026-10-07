# iPhone idle CPU, before and after moving the Glow look's loops to Core Animation

October 6, 2026, on `perf/iphone-scroll-cost` (PR #745). Zach found the iPhone app laggy to scroll after the Glow look (ADR-0051) and chose to keep the look and fix its cost.

## What was measured

Four UI journeys in `apps/ios/Tests/SottoUITests/FocusJourneyTests.swift` record `XCTCPUMetric` for the app over three seconds while Threads, or the working thread "Refine the iPhone thread view", sits still, three times each, on the iPhone SE simulator in the macOS CI job. Two of them pass `--ui-still`, which stops every looping animation, as the floor. The simulator reports CPU time only; its cycles and instructions read zero, and it does not report scroll hitches, so these numbers say how busy a still page keeps the app, not how a phone's scrolling feels.

| Page | Loops in SwiftUI (8a8d1058) | Loops in Core Animation (7b0ba7fc) | Loops stopped |
|---|---|---|---|
| A thread | 0.32 s | 0.05 s | 0.02–0.07 s |
| Threads | 0.54 s | 0.02 s | 0.02 s |

A thread with its place-keeping (the readers that follow its bar, title, reply box and end) switched off measured 0.29 s, so place-keeping was not the cost.

## What it means

SwiftUI runs a `repeatForever` animation by evaluating its views again on every frame, forever, so the breathing lights, the breathing card glows, the drifting wash and the light along working cards kept a still page busy and left scrolling to compete with them. Run by Core Animation, the same loops cost the app nothing per frame and a still page sits at the floor. The shadows were moved to `SoftShadow`, drawn once, in the same pull request; their part was not measured on its own.

Whether scrolling now feels smooth is checked on Zach's phone through TestFlight.
