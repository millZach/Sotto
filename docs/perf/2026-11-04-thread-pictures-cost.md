# What pictures in a thread cost the desktop app (November 4, 2026)

Zach: "One thing we need to understand is how much these images in threads are Bogging down performance. It seems pretty bad in threads with a lot of images." This note measures that. It changes no product code.

## The short answer

On forge, a thread of 275 pictures does not feel slow to open or to scroll. It costs memory and main's time, and both grow with how many pictures the reader has passed:

- **Opening is fine.** The last reply draws in about 60 ms with or without pictures. Only the tiles near the view load, so filling them levels off at about 0.4 s at 100 pictures and up.
- **The window keeps what it has shown.** One trip up and back takes the window from 132 MiB to about 440 MiB, 1.1 MiB for each picture passed, and further trips take it to about 640 MiB. Most of that is decoded thumbnails Chromium holds on to after the tiles have let go.
- **Main does the same work again.** Main decodes the whole picture to make each thumbnail, on its main thread. One trip made 403 decodes for 275 pictures, and every later trip 482. That is about 4.1 s of main's thread in a 15 s trip, and main peaks at 744 MiB against 334 MiB.
- **An update costs a little more per tile.** A step in a working turn of 275 tiles costs the window's main thread 24 ms against 13 ms, and main's 17 ms against 9 ms. More than half of that is a Lingui warning each tile logs on every render. A streamed word costs the same with or without pictures.

**This does not reproduce "pretty bad".** The longest frame in any clean run on forge was 58 ms, and at most 4 of a trip's 918 frames went over 33 ms. These numbers compare with and without pictures on one machine, and they are not absolute times for Zach's laptop. That the laptop's trouble is this memory and main's stalls is a guess until this harness runs there.

## What I would fix first

| Order | Fix | Measured gain, 275 pictures | Status |
|---|---:|---|---|
| 1 | Main keeps every thumbnail it has made in the session, instead of the newest 120 | Decodes in a later trip 482 to 0. In the first trip decodes 403 to 248, main stalled about 620 to about 90 ms, main's peak about 640 to about 480 MiB | **Measured**, with a patched build |
| 2 | Run a tile's name through the Lingui macro, so it stops warning | A step at 275 tiles: window's main thread 24.3 to 17.1 ms, main's 16.9 to 8.0 ms, all of main 30.4 to 15.5 ms | **Measured**, by silencing the warning in the app with no debugger on it |
| 3 | Make thumbnails for the screen's scale rather than always for 2x | Window after one trip 455 to 200 MiB, after several 648 to 277 MiB | **Measured on a 1x screen only.** At 2x a tile needs today's size, so I expect no gain there (guess) |

Fix 1 is one number, and the thumbnails are small: 37 KB each, about 10 MiB for 275. It should have a limit rather than none, and a limit well above the longest thread's pictures gives the same result (guess). Fix 2 also corrects a bug: "Picture 3" is never translated, because `pictureName` in `ThreadMediaTiles.tsx` receives `t` as a parameter, so the macro never reaches it. `Picture {` is in no catalog.

Bigger changes I would expect to help but have not tried, all guesses:

- **Save thumbnails beside the pictures, by digest.** The first open after a restart would then decode nothing, which should remove most of opening's main stall of 260 ms (about 500 ms with 2560x1600 pictures).
- **Make thumbnails off main's thread.** A first trip's 248 decodes at 9 ms each would stop stalling main. `nativeImage` is not offered in a Node worker, so this needs a different decoder or a utility process, and perhaps an ADR (a new dependency is one).
- **`memo` on the tile, with a stable press handler.** Tiles account for what is left of a step's growth, 12.5 to 17.1 ms at 275 tiles, so it could save up to about 4.6 ms a step.

## The fixture and its limits

The thread has the shape of the design hill climb thread: 4 turns, 1,322 steps, 275 pictures, in runs of 76, 34, 29, 27 and 23 and seven smaller ones. Its words and pictures are made up, and nothing was read from the real thread. It passes through the real Claude adapter over the fake CLI, with **Show every picture and video an agent makes** on, so the saved thread holds real handles and the transcript holds the pictures' bytes (85 MB), as Claude Code's does.

- **The other seven runs and the turn each run sits in are invented.** I had only the five biggest runs and the turn count. This matters because the desktop draws one list of tiles per turn while the iPhone's `AgentPictures` draws one per run. The newest turn here holds 111 tiles, and the update table below covers 0 to 275 in the working turn because the real number is unknown.
- **The pictures are 1600x1000 PNGs of about 240 KB,** one screenshot of Sotto scaled with text-like marks over it, all different. Real screenshots of 1280x800 in `artifacts/` run 53 to 273 KB. The real thread's sizes are unknown, so 2560x1600 is measured too, about 390 KB each.
- **Forge is not the laptop.** It runs Linux on an i5-14400F with 16 threads, drawing under Xvfb at 1x. Raster and decoding ran on the window's own CPU threads, where the laptop probably rasters on its GPU, which also keeps decoded pictures differently (guess). Zach mostly sees this on Windows, which was not run. Use these numbers to compare with and without pictures, and do not read them as laptop times.
- **Forge is shared.** Cases take turns in rounds, so a neighbour's load falls on all of them. Each cell gives the median with the lowest and highest in brackets. `earlyoom` killed another thread's `tsc` during one stretch.
- **The scroll is driven by script on the window's main thread,** at 2,400 px/s. A real wheel scroll on the compositor would hide some late frames, so this is the harsher reading.
- **A debugger changes the answer.** Playwright's debugger on the window makes each `console.warn` far dearer: a step at 275 tiles read 63 ms of window time under it (`sweep-warning-under-debugger.jsonl`). So every pass silences that one warning, and the undriven pass has no debugger on the window, drives the app through main's inspector and reads CPU from `/proc`. Only the undriven tables give the warning's true cost.
- **Not measured:** a paired host (below), videos and GIFs, callouts, Watcher, the iPhone (thread c68def0d), Codex's transcript path, folds held open, startup with a large transcript, and how long the window takes to give memory back with no pressure beyond 30 seconds.

## Results

Each case is the same 1,322 steps with that many pictures. **275-off** is the same profile with `inline-media` off, which draws no tile. It matches 0 pictures on the window in every table, so handles on records cost the window nothing measurable. Main alone holds about 35 MiB more before opening with the 275-picture profile, with the switch on or off. I would guess that is the 85 MB transcript's read at start, not measured.

A capture of the fixture open at 275 pictures is at [`artifacts/thread-pictures-cost/open-275-pictures.png`](../../artifacts/thread-pictures-cost/open-275-pictures.png).

### The curve

| Pictures | Near tiles filled on open, ms | Window after one trip, MiB | Main's peak in a trip, MiB | Tile reads in a trip | Decodes in a trip | Main stalled in a trip, ms |
|---:|---:|---:|---:|---:|---:|---:|
| 0 | 55 | 132 | 334 | 0 | 0 | 0 |
| 25 | 263 | 159 | 440 | 10 | 10 | 0 |
| 100 | 366 | 257 | 561 | 127 | 75 | 66 |
| 275 | 415 | 439 | 744 | 475 | 403 | 584 |

Opening levels off because at most about 27 tiles are near. Memory grows in a line, about 1.1 MiB per picture passed. Main's work grows faster than the pictures past 120, where its thumbnail cache starts to lose them.

### Opening and switching back

"Reply drawn" is from the press until the thread's last reply is in the pane and two frames have drawn. "Tiles" is until every tile near the view holds its picture. Switching back is three switches in each of five runs.

| Case | Runs | Open: reply drawn, ms | Open: tiles, ms | Tiles near | Back: reply drawn, ms | Back: tiles, ms | Main stalled opening, ms | Longest main stall, ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 5 | 55 (53-72) | 55 (53-72) | 0 | 52 (41-60) | 52 (41-60) | 0 | 7 (6-11) |
| 25 | 5 | 61 (50-91) | 263 (252-295) | 15 | 57 (41-62) | 94 (92-111) | 150 (146-187) | 79 (59-106) |
| 100 | 5 | 60 (59-65) | 366 (364-373) | 25 | 42 (40-60) | 113 (102-127) | 239 (220-249) | 168 (121-182) |
| 275 | 5 | 61 (59-65) | 415 (383-421) | 27 | 44 (40-59) | 128 (120-146) | 260 (222-269) | 209 (181-222) |
| 275-off | 5 | 60 (50-77) | 60 (50-77) | 0 | 58 (40-60) | 58 (40-60) | 0 | 9 (6-11) |

With no debugger on the window, 275 pictures open in 54 ms and fill in 372 ms, and switching back fills in 128 ms, about the same.

### Window memory

Proportional memory of the window's process in MiB, with no thread open before the press. A forced collection frees nothing here, because what is held is not garbage.

| Case | Before | Peak opening | Settled | Peak in a trip | After a trip | After collection | Peak with updates |
|---|---:|---:|---:|---:|---:|---:|---:|
| 0 | 123 | 137 | 135 | 152 (152-157) | 132 (131-133) | 132 | 164 (156-166) |
| 25 | 123 | 146 | 144 | 185 (185-186) | 159 (158-159) | 159 | 223 (215-223) |
| 100 | 123 | 148 | 148 | 294 (290-297) | 257 (248-297) | 251 (241-257) | 351 (343-364) |
| 275 | 123 | 154 | 155 | 536 (520-546) | 439 (335-455) | 438 (334-454) | 542 (423-546) |
| 275-off | 123 | 136 | 134 | 153 (150-157) | 132 (131-133) | 132 | 165 (163-166) |

**How much is image data.** From a Chromium memory dump, for 275 pictures after one trip, against 0 pictures:

| Part, MiB | 0 pictures | 275 pictures | What it is |
|---|---:|---:|---|
| Whole window | 131 to 152 | 455 (451-455) | |
| Decoded thumbnails (`cc/image_memory`) | 0 | 258.8 | Over half the window, and about 80% of the growth |
| PartitionAlloc | 17.9 | 51.1 | Grows with reads, so picture text, I would guess |
| Blink GC | 5.8 | 19.2 | The tiles' DOM and images |
| V8 | 47.5 | 52.5 | Includes the kept data URLs |
| Encoded pictures (`web_cache`) | 0 | 2.8 | |
| Data URLs on the tiles now showing | 0 | 1.0 | |

The thumbnails are 416x260 and hold 0.43 MiB each decoded, so 258.8 MiB is about 600 decodes of 275 pictures: a picture that comes back is decoded again as a new image. Keeping the window's thumbnails did not change this (below), so I would guess it is the re-mounted `<img>` that costs, and not the read.

**Further trips, and giving it back.**

| Case | After updates and three more trips, MiB | Decoded, MiB | 30 s later, MiB | Told memory is short, MiB |
|---|---:|---:|---:|---:|
| 0 | 136 | 0 | 131 | 130 |
| 25 | 236 | 71.7 | 218 | 143 |
| 100 | 508 | 257.9 | 461 | 192 |
| 275 | 648 (617-648) | 257.9 | 549 (540-549) | 273 (266-273) |

Decoded thumbnails stop at about 258 MiB at 1x. PartitionAlloc does not stop within these trips, reaching 125 MiB after the last, and I did not find what holds it. Nothing gives the memory back in 30 seconds, but a simulated memory-pressure signal returns about 275 MiB. So a computer short of memory should get most of it back, at the price of decoding again. That is true of this Chromium on Linux with no GPU; Windows is not measured.

### Scrolling

One trip up and back at 2,400 px/s. The thread without pictures is only 1,234 px long, so its frames are few. "Busy" is the window's time per second of the trip.

| Case | Trip, px | Frames | Longest frame, ms | Over 33 ms | Over 50 ms | Long tasks | Busy, ms/s | Main stalled, ms | Longest main stall, ms | Jump to top until tiles hold, ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 1,234 | 32 | 17.6 (17.3-21.4) | 0 | 0 | 0 | 78 (75-135) | 0 | 6 | - |
| 25 | 5,060 | 128 | 18.0 (17.8-18.2) | 0 | 0 | 0 | 96 (94-97) | 0 (0-63) | 19 (16-21) | 25 (23-27) |
| 100 | 14,548 | 363 | 50.6 (20.1-57.9) | 1 (0-1) | 1 (0-1) | 0 | 137 (131-150) | 66 (20-85) | 23 (20-28) | 27 (25-60) |
| 275 | 36,776 | 918 | 49.8 (26.0-54.0) | 2 (0-4) | 0 (0-1) | 0 | 187 (181-207) | 584 (524-817) | 32 (29-48) | 299 (294-358) |
| 275-off | 1,234 | 32 | 17.6 (17.4-17.9) | 0 | 0 | 0 | 93 (75-106) | 0 | 5 | - |

With no debugger on the window, the 275-picture trip's longest frame is 25.0 ms (23.6-25.1), with none over 33 ms. The window's frames are not where forge shows the cost.

### An update while the thread works

CPU beyond the same stretch idle, per update, with no debugger on the window, in ms. The turn at work holds that many tiles among 275 extra steps, so the steps are the same in every row. Four runs per row, nine for the first.

| Tiles in the working turn | Warning | Step: window's main thread | Step: all of window | Step: main's thread | Step: all of main | Chunk: window's main thread | Chunk: main's thread |
|---:|---|---:|---:|---:|---:|---:|---:|
| 0 | on | 12.6 (9.4-15.6) | 26.4 (12.6-34.6) | 8.9 (5.0-10.5) | 19.4 (7.4-22.0) | 7.9 (5.2-9.1) | 2.5 (1.9-2.8) |
| 0 | silenced | 12.5 (8.5-15.0) | 21.5 (15.6-24.1) | 6.9 (5.4-7.4) | 9.9 (8.9-9.9) | 6.9 (6.3-8.5) | 2.4 (1.9-2.8) |
| 100 | on | 19.3 (13.8-19.7) | 31.6 (25.0-37.4) | 12.4 (10.5-12.9) | 23.9 (18.4-23.9) | 8.7 (7.1-9.5) | 2.4 (2.0-2.5) |
| 100 | silenced | 15.8 (12.4-16.3) | 27.3 (15.8-30.5) | 7.9 (5.9-9.5) | 13.9 (7.8-16.5) | 9.1 (7.3-9.1) | 2.3 (1.4-2.8) |
| 275 | on | 24.3 (20.5-25.8) | 37.1 (31.8-43.2) | 16.9 (15.9-18.4) | 30.4 (26.9-32.4) | 7.3 (5.9-8.8) | 2.5 (1.4-2.5) |
| 275 | silenced | 17.1 (6.6-18.8) | 23.4 (12.9-25.5) | 8.0 (7.9-8.5) | 15.5 (13.9-16.0) | 8.9 (7.0-9.6) | 2.2 (1.4-2.3) |

So a new step re-renders every tile of its turn, which grows with that turn's tiles; a finished turn's tiles stay out of it. A streamed word touches none of them. A step in a thread with 275 pictures, 76 of them in the working turn, costs 15.1 ms (13.4-24.5) on the window's main thread and 12.9 ms (12.4-16.5) on main's.

A step **that brings a picture** costs main about 71 ms of CPU across its threads at any thread size (60.5-72.8 at 275), against about 15 ms for a step without one, measured under the debugger with the warning silenced. At 275 tiles in the turn, a step can also bring tiles near that had let go: 62 reads in the 20 steps of the profiled run, and none at 100.

### What crosses to the window

From counted runs, on the 275-picture thread.

| Phase | Tile reads | Picture bytes to the window | Decodes on main | Main decoding, ms | Resizing, ms | JPEG, ms | Whole pictures read in main, bytes | Thread detail sends | Detail bytes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Open | 27 | 1,008,933 | 27 | 162 | 57 | 22 | 8,667,394 | 2 | 976,145 |
| Back, three times | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 12 | 2,932,449 |
| One trip | 475 | 17,600,541 | 403 | 2,502 | 835 | 295 | 127,250,034 | 0 | 0 |
| Jump to top | 27 | 1,008,705 | 27 | 163 | 56 | 19 | 8,563,114 | 0 | 0 |
| Updates: 76 new pictures, then 10 more | 86 | 3,203,174 | 86 | 504 | 178 | 63 | 27,085,888 | 118 | 121,661 |
| Each later trip | 627 | | 482 | | | | | | |

- **Bytes.** ADR-0170 holds: no picture bytes ride in a record. The window gets one thumbnail of about 37 KB per read. Thread details weigh the same with and without pictures (976,801 bytes at 0 and 976,145 at 275). That 1 MB of detail for each switch back is the steps' cost, not the pictures'.
- **Reads and decodes.** The same picture is read and decoded again. The window keeps 48 thumbnails and main 120, and a trip passes 275, so both lose them. Main decodes the whole picture each time, 9.0 ms of its main thread a tile (6.2 decoding, 2.1 resizing, 0.7 JPEG), or 18.9 ms at 2560x1600.
- **The window's own decoding is cheap and off its main thread.** It decoded thumbnails 358 times in a traced trip, 261 ms in all, 0.7 ms each.
- **A paired host, not run.** The router asks a host for the whole picture for each decode, so the "whole pictures" column is what would cross the socket: about 127 MB in base64 per trip, one read at a time. That follows from reading `desktopHostRouter.ts`, with the latency not measured. Fix 1 would cut it the same way.

### Where the cost goes

Traced trip at 275 pictures, 15.3 s, against the 0.5 s trip without pictures, with the warning silenced, two runs each (the raster and decoding split is from one). Traces add overhead, so they say how the time divides rather than how much there is.

| Where | 0 pictures, ms | 275 pictures, ms |
|---|---:|---:|
| Main process busy | 5 | 4,356 (4,282-4,356) |
| Window, other threads: raster | 31, with decoding | 1,995 |
| Window, other threads: thumbnail decoding tasks | | 872 |
| Window's main thread: script | 21 | 1,254 (1,212-1,254) |
| Window's main thread: paint and commit | 12 | 985 (947-985) |
| Window's main thread: other | 10 | 615 (599-615) |
| Window's main thread: layout | 1 | 315 (292-315) |
| Window's main thread: style | 7 | 87 (84-87) |
| Window's main thread: garbage collection | 0 | 52 (31-52) |

| Cost | Grows with | Measured |
|---|---|---|
| **Decoding on main** | Pictures read, not in the thread. Worse past 120 pictures passed, and with picture size | 9.0 ms a read, or 18.9 ms at 2560x1600. 4.1 s of main's thread in a trip with no debugger on the window |
| **Memory** | Pictures passed, in a line, to a cap | 1.1 MiB a picture in the window at 1x |
| **Layout and paint** | Tiles coming into view as they scroll | About 1.3 s in a trip. Small against the 15 s, and no long tasks |
| **Re-rendering** | Tiles in the working turn, on steps only | 0.017 ms a tile on the window's main thread, plus 0.026 ms for the warning, and 0.032 ms on main's thread for the warning |

### The other conditions

| Condition, 275 pictures | Open: tiles, ms | Window after a trip, MiB | Main's peak, MiB | Longest frame, ms | Over 50 ms | Main stalled in a trip, ms | Longest main stall opening, ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| As above | 415 (383-421) | 439 (335-455) | 744 (738-749) | 49.8 (26.0-54.0) | 0 (0-1) | 584 (524-817) | 209 (181-222) |
| Window's main thread 4x slower, 3 runs | 704 (673-819) | 417 (389-573) | 749 (748-749) | 79.2 (76.1-83.1) | 2 (2-6) | 496 (458-1,028) | 190 (182-204) |
| 2x screen, 3 runs | 469 (381-492) | 398 (394-413) | 735 (734-753) | 44.9 (31.1-49.4) | 0 | 535 (468-608) | 170 (144-171) |
| 2560x1600 pictures, 3 runs | 657 (650-660) | 420 (336-469) | 978 (962-995) | 25.9 (24.4-41.3) | 0 | 5,643 (5,545-6,250) | 402 (282-410) |

- **The 4x window** slows only the window's main thread. Main and raster keep forge's speed, so a slower laptop would be worse than this row.
- **A 2x screen** raises the decoded cap: 414 MiB after several trips, and the window reaches 785 MiB. If the laptop runs above 1x, its window would sit between the 1x and 2x readings (guess).
- **2560x1600 pictures** make the biggest difference anywhere in this note. Main stalls for over a third of the trip, its longest stall opening is 402 ms, and its peak is nearly 1 GiB. If the real thread's pictures are this large, main is the likeliest thing Zach feels (guess).

### The experiments

Patched in the local built bundle only and then restored, on 275 pictures, two counted runs each. Nothing here is in this pull request.

| Patch | Decodes: first trip, later trips | Tile reads, first trip | Main stalled in a trip, ms | Main's peak, MiB | Window after a trip, MiB | Window after several, MiB |
|---|---:|---:|---:|---:|---:|---:|
| As built | 403, 482 | 475 | 566, 669 | 619, 667 | 455 | 648 |
| Main keeps 2,000 thumbnails | 248, 0 | 475 | 86, 92 | 480, 482 | 455 | 640 |
| Main and the window keep 2,000 | 248, 0 | 248 | 224, 313 | 482, 489 | 451 | 617 |
| Thumbnails at 208x140, half the size | 403, 482 | 475 | 276, 249 | 471, 467 | 200 | 277 |

The window's cache adds nothing worth keeping once main's is large. Main stalled more with it than without, in these two runs, and I did not find why. Half-size thumbnails cut the bytes to the window from 17.6 to 5.2 MB a trip as well, and would look soft on a scaled screen.

## How to repeat this

The fixture is `tests/e2e/support/threadPicturesFixture.ts`, the harness `tests/e2e/thread-pictures-cost.spec.ts`, and `tests/perf/threadPicturesReport.mjs` makes the tables. Each pass saves one JSON line per run under `~/.cache/sotto-thread-pictures`, or `SOTTO_PICTURES_ROOT`. The results behind this note are in `docs/perf/data/2026-11-04-thread-pictures-cost/`, sizes, counts and times only. On forge, hold Node's heap down, keep the temporary folder off tmpfs, and run one pass at a time; a pass stops if available memory falls under 2,500 MiB (`SOTTO_PICTURES_MIN_FREE_MIB`).

```sh
npm run build
export SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 TMPDIR=$HOME/.cache/sotto-thread-pictures/tmp
mkdir -p "$TMPDIR"
run() { env "$@" xvfb-run -a -s '-screen 0 3000x2000x24' npx playwright test tests/e2e/thread-pictures-cost.spec.ts --reporter=line; }

run SOTTO_PICTURES_PASS=seed                          # once: a profile per picture count
run SOTTO_PICTURES_PASS=clean    SOTTO_PICTURES_RUNS=5   # open, back, scroll, memory, updates
run SOTTO_PICTURES_PASS=undriven SOTTO_PICTURES_RUNS=4   # no debugger on the window, warning on and silenced
run SOTTO_PICTURES_PASS=counted  SOTTO_PICTURES_RUNS=2   # bytes, reads, decodes, memory dumps, further trips
run SOTTO_PICTURES_PASS=sweep    SOTTO_PICTURES_RUNS=3   # an update by tiles in the working turn
run SOTTO_PICTURES_PASS=trace    SOTTO_PICTURES_RUNS=2   # Chromium traces of each phase
run SOTTO_PICTURES_PASS=profile  SOTTO_PICTURES_RUNS=1   # self time by function while steps arrive

# The other conditions; give another picture size its own root, since the profiles hold the pictures.
run SOTTO_PICTURES_PASS=clean SOTTO_PICTURES_RUNS=3 SOTTO_PICTURES_THROTTLE=4 SOTTO_PICTURES_LABEL=throttle4 SOTTO_PICTURES_CASES=0,100,275
run SOTTO_PICTURES_PASS=clean SOTTO_PICTURES_RUNS=3 SOTTO_PICTURES_SCALE=2 SOTTO_PICTURES_LABEL=scale2 SOTTO_PICTURES_CASES=0,275

node tests/perf/threadPicturesReport.mjs                    # the tables
node tests/perf/threadPicturesReport.mjs ~/.cache/sotto-thread-pictures scale2
```

On Windows, leave out `xvfb-run`; memory falls back to the working set, and the undriven pass's `/proc` readings do not exist there. The experiments edit `mediaTiles.size > 120` and `MEDIA_TILE_PIXELS` in `out/main/index.js`, and `tile: 48` in the renderer's `global-*.js`, then rebuild.

Seven of the undriven pass's launches failed at the inspector connection before measuring anything and were retried once. A fifth round stopped when a launch failed twice, during a stretch when forge was short of memory, so that pass has four rounds.
