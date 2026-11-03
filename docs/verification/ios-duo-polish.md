# The Duo polish round

Checked on November 1 and 2, 2026, for Zach's polish of the iPhone app on the unfolded iPhone Duo. Pictures come from the iPhone Duo simulator (iOS 27.1) on the `xcode-27` runner, unfolded and held sideways, in the dark theme unless a row says Light. "Before" is `main` at the time, and "after" is this branch. Zach approved the round on one card with these pictures.

## What the pictures show

| Picture | What it shows |
| --- | --- |
| `artifacts/ios-duo-polish/1a-before-watcher-top.jpg` | Before: the Conversation and Watched bar over Watcher's page |
| `artifacts/ios-duo-polish/1b-after-watcher-top.jpg` | After: no bar, and Watcher opens on its conversation |
| `artifacts/ios-duo-polish/2a-before-working-row.jpg` | Before: three lines in the box with the keyboard up, and **Watcher is working** cut off under the box |
| `artifacts/ios-duo-polish/2b-after-working-row.jpg` | After: the same text and keyboard, with the working row whole, 16 points above the box |
| `artifacts/ios-duo-polish/3a-before-box-gap.jpg` | Before: the words end 2 points above the row with the model pill |
| `artifacts/ios-duo-polish/3b-after-box-gap.jpg` | After: a 12-point gap above the row |
| `artifacts/ios-duo-polish/4a-before-tap-above-pill.jpg` | Before: a press 4 points above the model pill opens Watcher's settings |
| `artifacts/ios-duo-polish/5a-after-threads-rail.jpg` | After: sidebar and New thread at the top of the rail, the four tabs low in one pill, and the page reaching every edge |
| `artifacts/ios-duo-polish/5b-after-thread-sidebar-light.jpg` | After, Light: a thread with the sidebar beside it |
| `artifacts/ios-duo-polish/5c-after-sidebar-dragged-away.jpg` | After, Light: the same thread after a drag left, with the sidebar put away |

The after picture of the press above the pill was missed by the frame grabber. The same journey pressed the same spot and recorded `DUO-STATE tap keyboards 1 settings-sheet false`: the keyboard came up and the settings sheet stayed shut.

`DuoJourneyTests` checks the rail's measures and the sidebar's drag on the unfolded Duo. It runs only there: CI's iPhone SE and Pro Max skip it, so its sideways journeys ran on the capture branch rather than in Native iOS client. `FocusJourneyTests` checks Watcher's page.

## Speed

`apps/ios/Scripts/bench.sh` on an iPhone 16 Pro Max simulator, five journeys a side, medians. None of the Duo layout applies on that iPhone, and the branch keeps the whole-app ground and the thumb's drag off it. Each row is one workflow run.

| Run | Before | After | Streaming CPU (ms) | CPU per chunk (ms) | Stutters | Footprint in a thread after scrolling (MB) | Peak (MB) |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| [41487171134](https://github.com/millZach/Sotto/actions/runs/41487171134) | main | main | 13,926 → 14,332 | 69.6 → 71.7 | 82 → 81 | 120 → 117 | 134 → 131 |
| [41487114412](https://github.com/millZach/Sotto/actions/runs/41487114412) | main | branch | 14,352 → 16,832 | 71.8 → 84.2 | 84 → 92 | 115 → 130 | 129 → 147 |
| [41496814684](https://github.com/millZach/Sotto/actions/runs/41496814684) | branch | main | 14,935 → 11,102 | 74.7 → 55.5 | 80 → 53 | 115 → 116 | 132 → 131 |

Read straight, main beat the branch in both runs that compare them. The machine accounts for most of that. A run's whole side moves together: in the third run even the pure code tests, which never start the app, ran almost twice as fast on the main side, and main against itself moved them by 30%.

So each journey's streaming CPU was divided by two timers inside the same journey, over code this branch doesn't change (`list.focusThreads` and `timeline.rows`). Pooled over 20 journeys of main and 10 of the branch:

| Phase | Main | Branch | Change |
| --- | ---: | ---: | ---: |
| Streaming | 11.40 | 11.82 | +3.7% |
| Scrolling a thread | 5.17 | 5.35 | +3.4% |
| Opening a thread | 3.30 | 3.44 | +4.3% |
| Scrolling the list | 3.31 | 3.59 | +8.5% |

No change is clearly apart from noise: on a rank test, the largest is 1.89 standard errors, with four phases compared. The bench can't rule out a real cost of a few percent. The adjustment was chosen after seeing the numbers, and those timers are themselves measured inside the app. The memory rise of the second run did not come back with the sides swapped.

### What the earlier runs showed

Against the base this work started from (`0c81acedf`), streaming measured about 60% slower: 88.6 → 143 ms per chunk. That base lacks #2012. In those runs, `Conversation.toBottom` took about 400 samples on the branch and none on the base. With both sides on #2012 it takes almost none on either side. Why the rail work made that call run on the old base wasn't established, and the comparison was only made fair by merging `main`.

The launch and list gains the first runs seemed to show did not hold from run to run, so none is claimed.

## Not checked here

The simulator can't turn the unfolded Duo upright, so `DuoJourneyTests`' two upright journeys skip there and upright has not run on any screen: the right-edge rail, the sidebar that follows the thumb and the page under the status bar upright were only seen in the interactive prototype. They need Zach's Duo on TestFlight, and so do the thumb's reach and how the drag feels.
