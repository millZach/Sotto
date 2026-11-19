# Electron Sotto baseline on forge (issue #2689)

What was measured: Sotto as it is today, built from `origin/main` at `61f9e269b` (package 0.1.43, Electron 43.8.3,
Chromium 150.0.7871.250, Node 24.22.0 in main). It ran on forge (Omarchy, Hyprland) inside a nested Hyprland, B
inside A, with an 1800x1200 output, scale 1 and animations off (`tools/nested-up.sh`). The window was Wayland-native:
`--ozone-platform=wayland`, and `hyprctl clients -j` reported `xwayland: false` in every stream and edit run. All
figures below were taken with the window at 1280x800 logical, scale 1, apart from launch (see Deviations). GPU status
(`app.getGPUFeatureStatus()`): GPU compositing, OpenGL, Vulkan and rasterization enabled.

Every build and every measured run held `flock -o $HOME/.cache/sotto-tmp/bakeoff-measure.lock`. Each run waited for
4 GB to be free and wrote `/proc/loadavg` into `runs/<run>/conditions.txt`. Forge was busy the whole time: the
1-minute load average was 12 to 22 on 16 GB shared with other agents. Read the absolute figures with that in mind.

## Results (median of runs)

| # | Figure | Median of runs | Spread / tail |
|---|--------|----------------|---------------|
| 1 | Frame interval while streaming (rAF timestamps) | 16.7 ms | p95 17.9, p99 19.3, max 99.9, mean 16.78; >16.7 ms: 484; >33.3 ms: 2; n 1,166 |
| 1 | Long tasks during the stream | 1 (110 ms) | the same single task in every run, 73 / 110 / 114 ms |
| 2 | Typing: keydown → next paint (rAF + MessageChannel) | 12.3 ms | p95 23.3, p99 23.9, max 25.7; n 60 |
| 2 | Event Timing `keydown` duration (to presentation) | 56 ms | p95 64, p99 64, max 64; n 60 (all 60 were over 16 ms) |
| 3 | Memory 5 s after the stream, whole Electron tree | PSS 753.1 MiB, RSS 1,274.5 MiB | 9 processes; the fake provider (26.8 MiB PSS) is left out |
| 4 | Launch to first rAF with the thread on screen | 2,163 ms | runs 1,834 / 2,163 / 2,182 ms (warm-up run 0: 1,885 ms) |
| 5 | Installed `sotto-bin` 0.1.38-1 | 369.98 MiB (pacman), 371 MiB (`du` of its files) | the source build is `out/` 47 MiB plus `electron/dist` 317 MiB |
| 6a | Edit to screen, Vite HMR | 90.9 ms | 90.9 / 91.0 / 61.2 ms; lower bounds 60.8 / 61.0 / 31.1 ms; resolution ~30 ms |
| 6b | Edit to screen, full rebuild + relaunch | 42.3 s | 46.4 / 41.1 / 42.3 s, of which `npm run build` took 44.3 / 39.0 / 40.6 s |

Memory by process type (median of each type across runs; the medians of the parts do not add up to the median of the
totals):

| Type | Count | PSS MiB | RSS MiB |
|------|-------|---------|---------|
| main (browser) | 1 | 225.8 | 317.3 |
| renderer (main window + floating widget) | 2 | 327.2 | 471.9 |
| of which the main window's renderer | 1 | 266.7 | 340.4 |
| gpu | 1 | 138.8 | 255.2 |
| utility (network service) | 1 | 22.9 | 75.2 |
| zygote | 2 | 13.7 | 72.3 |
| zygote (no sandbox) | 1 | 11.2 | 57.9 |
| broker (GPU sandbox broker) | 1 | 17.1 | 39.6 |
| Total | 9 | 753.1 | 1,274.5 |

## Every run

Stream runs (figures 1 to 3). Frame statistics are taken over the rAF frame timestamps between the fake CLI's first
and last chunk. Times are in ms.

| Run | loadavg at start | Frames: median / p95 / p99 / max / mean / >16.7 / >33.3 / n | Long tasks | Typing: median / p95 / p99 / max / n | Event Timing keydown: median / p95 / max | PSS / RSS MiB |
|-----|------------------|------|------|------|------|------|
| 1 | 12.26 12.93 10.52 | 16.7 / 17.9 / 18.7 / 50.0 / 16.72 / 482 / 1 / 1,170 | 1 (73) | 11.8 / 21.8 / 22.0 / 25.7 / 60 | 56 / 64 / 64 | 758.4 / 1,291.4 |
| 2 | 16.96 13.94 10.93 | 16.7 / 17.9 / 19.3 / 100.0 / 16.78 / 484 / 2 / 1,166 | 1 (110) | 12.3 / 23.3 / 23.9 / 24.6 / 60 | 48 / 64 / 64 | 640.1 / 1,160.6 |
| 3 | 17.10 14.44 11.21 | 16.7 / 17.9 / 19.8 / 99.9 / 16.83 / 524 / 5 / 1,162 | 1 (114) | 12.3 / 27.7 / 29.6 / 29.9 / 60 | 56 / 64 / 64 | 753.1 / 1,274.5 |

Over the same frames, intervals measured on the callback's own clock (`performance.now()` inside the rAF callback)
were: median 16.6 / 16.6 / 16.6, p95 22.3 / 23.0 / 21.9, p99 26.7 / 27.8 / 27.7, max 78.0 / 124.3 / 114.8.

Typing measured from the key event's `timeStamp` instead of the listener's `performance.now()`: median
12.2 / 14.8 / 14.0, p95 22.0 / 25.0 / 28.0, max 33.0 / 30.5 / 30.5.

The one long task, and the longest frame (50 to 100 ms), fell at the same point in every run, about 8.5 s in. That is
where the 191-line `diff` block closes and the next tool call (`npx tsc`) arrives, so Sotto ends one assistant message
and starts the next step. The stream itself kept time: the fake CLI's chunks were late by a median of −0.3 ms, a p99
of 1.5 / 1.8 / 1.8 ms and a maximum of 3.6 / 3.4 / 13.2 ms. Each stream lasted 19,586 / 19,584 / 19,584 ms over 1,225
chunks. Each run saw all 60 keys, and the composer held 60 characters at the end.

Launch runs (figure 4). Run 0 was a warm-up and is not in the median.

| Run | loadavg | Thread in DOM | First rAF after it | rAF + MessageChannel |
|-----|---------|---------------|--------------------|----------------------|
| 0 (warm-up) | 16.68 14.64 11.38 | 1,868.8 | 1,884.8 | 1,910.7 |
| 1 | 16.31 14.60 11.39 | 1,815.6 | 1,833.9 | 1,868.2 |
| 2 | 16.31 14.60 11.39 | 2,145.7 | 2,163.2 | 2,209.8 |
| 3 | 17.08 14.79 11.46 | 2,164.1 | 2,181.6 | 2,246.4 |

The page cache was warm: the app had been launched several times in the minutes before, and the profile is copied
fresh just before each launch.

Edit runs (figure 6). (a) One `electron-vite dev` session at loadavg 16.98 14.94 11.62 took three edits, with the time
from writing the file to the first changed capture: 90.9 / 91.0 / 61.2 ms. The start of the previous capture puts
each change no earlier than 60.8 / 61.0 / 31.1 ms. grim took a median of 8 to 12 ms per capture. Reverting each edit
reached the screen in 121.1 / 91.0 / 61.0 ms. (b) Three rebuilds, at loadavg 20.40, 20.19 and 21.69: edit to first
rAF 46,442 / 41,063 / 42,254 ms, of which `npm run build` took 44,335 / 38,962 / 40,567 ms.

Raw data for every run is in `runs/<mode>-<n>/`: `renderer.json` holds every rAF timestamp, typing sample, long task
and Event Timing entry; `memory.json` holds each process; `stream-times.json`, `launch.json`, `edit.json`,
`conditions.txt`, `client.json` and `hook.log` are there too. `results.json` holds all of it analysed, plus the medians.

## Methods, one line each

1. **Frame time.** A frame preload, in an isolated world, starts a `requestAnimationFrame` loop just before the stream
   and records each callback's timestamp. The intervals counted run from the fake CLI's first chunk write to its last
   (epoch milliseconds, converted with `performance.timeOrigin`); long tasks come from
   `PerformanceObserver({ type: 'longtask' })`. rAF intervals are the closest Chromium analogue to the Slint build's
   interval between the ends of consecutive rendered frames.
2. **Typing.** `wtype -d 150` types 60 letters into the focused composer, starting 1 s after the first chunk. A
   capturing `keydown` listener on `window` records `performance.now()`. A `MutationObserver` on the composer (TipTap's
   `.ProseMirror`) sees its text change, and the sample ends in the `onmessage` of a `MessageChannel` posted from the
   next `requestAnimationFrame`. `PerformanceObserver({ type: 'event', durationThreshold: 16 })` gives the `keydown`
   durations.
3. **Memory.** 5 s after the last chunk, `memory.py` walks the Electron main process's tree in `/proc` and reads PSS
   and RSS from each process's `smaps_rollup`. It classes each process by `--type=` and leaves out every process that is
   not the Electron binary. There was exactly one such process: the fake Claude CLI, 25.8 to 28.0 MiB PSS.
4. **Launch.** The harness takes `date +%s%N` just before it spawns Electron. The preload watches the DOM until the
   thread pane holds the newest history message's words ("Tab reaches every control in the export button in reading
   order"), then takes the next rAF callback's `performance.timeOrigin + performance.now()`. The figure is the
   difference.
5. **Size.** `pacman -Qi sotto-bin` and `du` over `pacman -Qlq sotto-bin` for the installed package. `du -sb` of `out/`
   and `node_modules/electron/dist` for the source build.
6. **Edit to screen.** (a) Under `electron-vite dev -- --ozone-platform=wayland`, `edit_poll.py` rewrites
   `.thread-prompt { … background: var(--tt-card); }` in `src/renderer/src/agents/threads.css`, the composer's own
   rule, to `#ff00ff`. It then captures a 40x8 region of the composer's top padding with `grim -t ppm` every ~30 ms until
   the pixels change. (b) The same rule is rewritten (magenta, cyan, magenta), `npm run build` runs, and Electron is
   relaunched; the figure runs from the write to the first rAF with the thread on screen.

How the reply streams through Sotto: through the real path. `SOTTO_E2E_NATIVE_FIXTURE_ROOT` makes Sotto's main run its
real Claude adapter (`ClaudeStreamJsonHost`) over the repo's unchanged fake Claude CLI
(`tests/fixtures/fakeClaudeThread.mjs`), started through `fake-provider.sh` with `stream-addon.mjs` preloaded. The
addon streams `reply.md` as Claude Code stream-json: 20 characters every 16 ms on a drift-corrected clock, text as
`text_delta` events, and each of the 12 `activity` fences as a real tool call, so Sotto draws activity rows. The
tool calls map by their title: "Ran" → Bash, "Read" → Read, "Searched for" → Grep, "Edited" → Edit. The output follows
as the `tool_result`. The 200 history messages were seeded the same way, through the fake CLI's `raw-burst` (written to
the session log, as the CLI does). Provider process → main (adapter, thread store) → IPC → renderer are all in the
path.

## Deviations from the brief

- **One extra message.** Sotto needs a prompt to start a turn, so the reply follows a 201st message ("Write up what
  you found and what you changed.") that the harness sends through `window.sotto.agents.command` before the stream.
- **Chunking.** Chunks are 20 JavaScript characters (UTF-16 units), 1,225 of them. While a chunk is inside an
  `activity` fence, no text is sent. The tool call goes out on the chunk that completes the fence's title line, and its
  result on the chunk that closes the fence. Sotto shows the reply as several assistant messages with steps between
  them, as it does for a real Claude turn. When the turn ends it folds the steps into a "Worked for 22s · 12 steps · Ran
  9 commands, used Read and Grep" line, so the finished screen is not the same as Slint's.
  `evidence/mid-stream-diff-block.png`, `evidence/mid-stream-code-block.png` and
  `evidence/after-stream-activity-summary.png` show it (taken in a separate trial run, not a measured one).
- **Frame time is not the same quantity.** The rAF loop makes Chromium produce a frame every vsync of the nested
  60 Hz output, even when nothing changed, whereas Slint renders only on change. rAF timestamps sit on vsync, so a
  normal interval reads 16.6 to 16.8 ms. ">16.7 ms" (about 480 a run) therefore counts vsync jitter, not dropped
  frames. ">33.3 ms" (1 to 5 a run) is the count that means a missed frame. The stream window is the provider's first
  and last chunk write, not when the renderer received them.
- **Typing.** All 60 keys came from one `wtype -d 150` process (one virtual keyboard), not 60 separate `wtype` calls.
  The rAF + MessageChannel figure stops before Chromium's GPU work and the compositor. The Event Timing figure (56 ms)
  runs to the presentation time the compositor reports, through both nested Hyprlands, and is rounded to 8 ms. The
  12.3 ms figure is the one to compare with Slint's "end of the first frame rendered after the change".
- **Memory.** The tree includes the floating widget's renderer, which Sotto always creates (about 60 MiB PSS; the main
  window's renderer alone is in the table). PSS swung between runs (640 to 758 MiB), mostly in the main window's
  renderer (132 to 273 MiB), which depends on when V8 last collected. No collection was forced.
- **Launch size.** Hyprland tiles a new window, so Electron's first frame is drawn at 1800x1200 (`innerWidth` 1800,
  `innerHeight` 1200), not 1280x800. The window is resized only after launch, as `tools/run-shot.sh` does for Slint.
- **Launch is the development build in e2e mode, not the installed package.** It runs `electron out/main/index.js` with
  `SOTTO_E2E=1` and the fixture providers. In e2e mode Sotto skips its starting screen (ADR-0086), which an installed
  app shows first, and it connects the fake Claude CLI at start. The thread opens because the profile, copied from a
  prepared template, last had it open.
- **Environment.** Electron ran under `env -i`: a private `HOME` and XDG folders under `~/.cache/sotto-tmp`,
  `TZ=UTC`, no `DISPLAY`, and no D-Bus session bus, so the user's keyring and settings are never touched. The profile
  is `~/.cache/sotto-tmp/sotto-e2e-bakeoff`, restored from the template before every run.
- **Instrumentation without touching Sotto's code.** `bench-main.cjs` is loaded into Electron's main process with
  `NODE_OPTIONS=--require` (it starts on the `loaded` event, because `require('electron')` fails earlier). It
  registers `bench-preload.cjs` as a session frame preload, which runs in an isolated world in the main window, and it
  drives the window through `window.sotto` with `executeJavaScript`, as Sotto's Playwright journeys do. Playwright
  itself is not used.
- **Install.** `npm ci` on Node 24.22.1 skipped install scripts (npm's `allowScripts` warning). I ran Electron's
  `install.js` by hand to fetch the binary. node-pty's native build was not redone; the terminal was not used.
- **Edit runs.** (a) The three HMR edits ran in one dev session rather than three, and the first edit came about 7 s
  after the window was ready. The resolution is the ~30 ms capture interval plus grim's 8 to 12 ms. (b) The figure
  includes the whole of `npm run build` (main, preload, store workers, renderer), about 40 s on a loaded forge.
- **Size.** The installed `sotto-bin` is 0.1.38-1, built on October 13 with Electron 43.1.0, which is older than the
  0.1.43 source that was measured. Its `/opt/sotto/sotto` binary is 210 MiB and `resources/` is 60 MiB.
- **The shared lock.** On my first run the lock was held by an orphaned `gsettings monitor
  org.gnome.desktop.interface enable-animations` (PID 2497860, parent PID 1, its session leader gone). It had inherited
  the lock's file descriptor from an earlier locked run and held the lock for about 11 minutes. I stopped it by PID.
  All my runs use `flock -o`, so nothing they start inherits the lock; the Slint runs should do the same.

## Exact commands

```sh
# Worktree and build (from the Slint worktree's root)
git worktree add .worktrees/electron-baseline origin/main
cd .worktrees/electron-baseline
flock $HOME/.cache/sotto-tmp/bakeoff-measure.lock bash -c 'TMPDIR=$HOME/.cache/sotto-tmp NODE_OPTIONS=--max-old-space-size=3072 mise exec node@24.22.1 -- npm ci && TMPDIR=$HOME/.cache/sotto-tmp NODE_OPTIONS=--max-old-space-size=3072 mise exec node@24.22.1 -- npm run build'
mise exec node@24.22.1 -- node node_modules/electron/install.js   # npm ci skipped it

# Nested desktop
ROOT=$(native-ui-slint/tools/nested-up.sh); source $ROOT/env

# From native-ui-slint/electron-baseline/
L=$HOME/.cache/sotto-tmp/bakeoff-measure.lock
flock -o $L ./run.sh prepare                       # seeds the 200 messages once, saves the profile template
for i in 1 2 3; do flock -o $L ./run.sh stream $i; done
for i in 0 1 2 3; do flock -o $L ./run.sh launch $i; done
flock -o $L ./run.sh hmr 1                         # three HMR edits in one dev session
for i in 1 2 3; do flock -o $L ./run.sh rebuild $i; done
python3 summarize.py                               # writes results.json from runs/

# Size
pacman -Qi sotto-bin
pacman -Qlq sotto-bin | grep -v '/$' | tr '\n' '\0' | du -cb --files0-from=- | tail -1
du -sb .worktrees/electron-baseline/out .worktrees/electron-baseline/node_modules/electron/dist

# Clean-up
native-ui-slint/tools/nested-down.sh $ROOT
git worktree remove --force .worktrees/electron-baseline
```

Files: `run.sh` (one run), `bench-main.cjs` (main-process hook), `bench-preload.cjs` (renderer recorders),
`stream-addon.mjs` and `fake-provider.sh` (the streaming provider), `memory.py`, `edit_poll.py`, `win-main.sh` (picks
Sotto's main window rather than its widget, which `tools/win.sh` can pick by mistake because both belong to one PID),
`analyze.py`, `summarize.py`. The worktree has been removed, so running these again needs it rebuilt with the
commands above.
