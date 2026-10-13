# iPhone CPU while a thread streams and while typing, before and after the stores

October 6, 2026, on `perf/iphone-typing` (PR #761). After [the idle work](2026-10-06-iphone-idle-cpu.md), Zach still found TestFlight build 16 laggy while scrolling Threads, scrolling in a thread, typing a reply and opening threads, and could not say when.

## Why it lagged

Every change published on `AppModel` makes every view that watches it evaluate its body again, and nearly every view watches it, the Threads list under an open thread included. A working thread's computer sends its shell up to twenty times a second (the host coalesces at 50 ms) and the open thread's history as often, and each keystroke in a reply box published on the model too. While any thread worked, the whole app was redrawn up to forty times a second, and everything else the user did waited behind that.

Most of those shells change nothing the iPhone reads: a message streaming into a thread moves no field the phone decodes. The fix leaves a computer's unchanged state unpublished, keeps the reply boxes' words in a `DraftStore` and the open thread's history in a `DetailStore` that only their readers watch, lets the title block, folded runs and reply box skip a redraw that changes nothing they show, and stops the looping layers being handed the same colours on every redraw.

## What was measured

`XCTCPUMetric` journeys in `apps/ios/Tests/SottoUITests/FocusJourneyTests.swift`, three times each, on the iPhone SE (3rd generation) and iPhone 16 Pro Max simulators in the macOS CI job. `--ui-streaming` grows a message in the working thread by a word every 50 milliseconds and sends the thread list again unchanged each time; the streaming journeys sit for three seconds on Threads or in that thread. The typing journeys type one sentence into the reply box. Each runs once as the app is and once with `--ui-publish-everything`, which publishes every change on the whole model as the app did before. That comparison restores the publishing only: the skipped redraws stay on in it, so it reads somewhat lower than the app before the branch did.

CPU seconds, averaged over three readings, from run [37426014629](https://github.com/millZach/Sotto/actions/runs/37426014629) at `b8a2be08`:

| Journey | Phone | Publishing everything | As the app is now |
|---|---|---|---|
| Streaming, on Threads | SE | 2.81 | 0.32 (0.80, 0.11, 0.06) |
| Streaming, on Threads | Pro Max | 2.71 | 0.03 |
| Streaming, in the thread | SE | 2.94 | 1.01 |
| Streaming, in the thread | Pro Max | 2.95 | 1.99 (2.79, 1.93, 1.25) |
| Typing a sentence | SE | 1.46 | 1.17 |
| Typing a sentence | Pro Max | 1.32 | 1.11 |
| Still thread, keyboard open | SE | | 0.06 |
| Still thread, keyboard open | Pro Max | | 0.04 |

Earlier runs on the branch agree in shape: streaming on Threads 2.87 to 0.06 and 2.62 to 0.04, in the thread 3.11 to 0.87 and 2.89 to 1.58, typing 1.19 to 0.83 and 0.97 to 0.77. Between runs the same journey moved by up to a fifth on unchanged code, so the redraw skips added in `0a0a26b2` are not visible against that noise.

## What it means

With everything published, a streaming thread held the app at nearly three seconds of CPU in three seconds: one core busy for as long as any thread worked, which is why scrolling, typing and opening all dragged at once and why Zach could not say when. Threads now sits near idle while a thread streams. The open thread still spends about a third of a core redrawing its conversation as words arrive, twice that on the large phone at accessibility text sizes; the conversation is laid out whole rather than lazily, since a lazy list opened long threads on a blank page (`086da154`), and the growing message is parsed and measured again each time. That is the next place to look if a working thread still feels heavy on the phone. A still thread with the keyboard open costs next to nothing, so the slower simulator readings seen there during the branch were the simulator's, not the app's.

The simulator reports CPU time only. Whether scrolling and typing now feel smooth is checked on Zach's phone through TestFlight.
