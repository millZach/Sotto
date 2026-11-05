# What pictures in a thread cost the iPhone - November 4, 2026

Zach asked how much the pictures in a thread with many of them, such as the design hill climb thread, slow the iPhone
app. This note measures it, and splits what the images cost from what the grids that hold them cost. The jump the same
thread showed is in [its verification note](../verification/2026-11-04-iphone-picture-thread-jump.md). The fix there
keeps the grids lazy. Its before and after runs ([41946092272](https://github.com/millZach/Sotto/actions/runs/41946092272),
one run each) show no change in cost past the spread between runs: about 260 tile bodies and 136 grid bodies drawn per
working update both before and after it, and working CPU of 10.2 to 14.1 s before and 6.9 to 13.8 s after for the same
30 updates.

## How it was measured

Scratch run [41916352653](https://github.com/millZach/Sotto/actions/runs/41916352653), on a GitHub `macos-26` runner, in
the iPhone 16 Pro Max simulator, with the Debug configuration built optimized as `Scripts/bench.sh` builds it. Each arm
ran five times from a cold launch, and the numbers are medians of five. One run against another is not a firm
comparison; a difference smaller than the spread between runs of one arm is noise.

The fixture (`--bench-pictures`, `AppModel.swift`) is the design hill climb thread's shape, counted from the real thread
and carrying none of its words: its runs, their steps, and 275 pictures, each a 1600 by 1000 PNG of about 190 KB.
Since these numbers were taken, the fixture has gained a last run of 40 pictures that keeps growing while the thread
works, for the jump's journey, so it now holds 315; a run of the command below measures that thread, not this one.
The arms:

- `full`: the thread as it is.
- `noimages`: the same tiles and grids, with no image bytes, so every tile stays grey.
- `nomedia`: the same steps with no pictures, so there are no grids.
- `nosteps`: the runs with no steps.

The app walks `pictures()` in `Bench.swift` by itself: open the thread, read its first tiles, scroll the whole page up
and back, then work on the thread from its end (a step every half second, a picture every fourth).

## What it costs

| | full | noimages | nomedia | nosteps |
|---|---|---|---|---|
| Open, to the first drawn frame | 2,064 ms | 2,047 ms | 1,540 ms | 1,223 ms |
| Peak memory through the scroll | 123 MB | 124 MB | 88 MB | 84 MB |
| CPU while scrolling, share of a core | 69% | 59% | 14% | 21% |
| Hitches while scrolling | 98 ms/s | 59 ms/s | 0 ms/s | 5 ms/s |
| Longest frame while scrolling | 65 ms | 58 ms | 17 ms | 38 ms |
| CPU per working update | 188 ms | 151 ms | 124 ms | 97 ms |
| Frames over 80 ms while working | 41 | 26 | 29 | 23 |
| Longest frame while working | 241 ms | 218 ms | 134 ms | 113 ms |

Split by pairing the arms (full against noimages for the images, noimages against nomedia for the grids, nomedia against
nosteps for the steps):

| | Images | Grids | Steps |
|---|---|---|---|
| Open | +17 ms (noise) | +478 ms | +555 ms |
| Peak memory | −1 MB | +35 MB | +4 MB |
| CPU while scrolling | +6 points | +30 points | +4 points |
| Hitches while scrolling | +30 ms/s | +59 ms/s | −2 ms/s |
| CPU per working update | +66 ms | +43 ms | +18 ms |

So the image bytes cost little: only about 93 of the 275 pictures were decoded in a whole journey, because the grids
make only the tiles near the screen. The grids themselves cost most: half a second to open, 35 MB, and most of the
scroll's CPU and hitches. Each working update drew 132 grid bodies and about 195 to 225 tile bodies, because every tile
watches the whole app model and is drawn again whenever anything in it changes.

## Repeating it

On a Mac with Xcode 26.6, build the app as `Scripts/bench.sh` does, then launch it on a simulator once per arm:

```sh
SIMCTL_CHILD_SOTTO_BENCH_FILE=/tmp/pictures/full.json xcrun simctl launch "$device" com.millzach.sotto.ios \
    --ui-fixture --reset-ui-preferences --ui-pictures --bench-threads 30 --bench-turns 4 --bench-chunks 1 \
    --bench-journey pictures --bench-pictures full -AppleLanguages '(en)' -AppleLocale en_US
```

Wait for `"phase":"finished"` in the report. Without the journey's test to give it a finger, the walk waits out the
finger phase, about four minutes. Read the `open`, `images`, `thread-scroll` and `working-end` phases for cost: the held
phases take a screenshot about once a second, so their frames say nothing about the thread.

## Left for later

- Tile redraws: every tile draws again on every working update because it watches the whole app model. This is next.
- The grids' scroll cost and memory: about 30 points of a core and 35 MB on this thread.
