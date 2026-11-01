# A covered Sotto window stops drawing on Windows - November 1, 2026

The last item of #993: "A covered window renders at full rate on Windows." Measured on the Windows laptop with
`scripts/perf-bench/windows-occlusion/`, by a thread that ran there, with Chromium's Windows occlusion detection off (the
switch Sotto set until now) and on (this change). The benchmark launches the built app directly with Electron and drives
it from inside its own main process.

```sh
npm run build
node scripts/perf-bench/windows-occlusion/run.mjs cpu off 1
node scripts/perf-bench/windows-occlusion/run.mjs cpu on 1
node scripts/perf-bench/windows-occlusion/run.mjs capture on 1
```

The off side adds the old switch itself before the app's main runs (`entry.cjs`), so both sides run the same build.

## What it cost

Sotto turned off `CalculateNativeWinOcclusion` for the whole app on Windows (`src/main/index.ts`), because ADR-0020 found
in September 2026 that a detached or fully occluded page had no capture surface. With it off, Windows never tells
Chromium the window is covered, so a covered Sotto window keeps drawing every frame: #993 estimated up to 55% of the
renderer's work.

## Why Playwright cannot show it

Playwright's Electron launcher adds `--disable-backgrounding-occluded-windows` and similar switches, and even with them
removed, a minimal Electron page launched through Playwright still drew 60 frames a second while covered or minimized.
The first four runs, launched that way, showed no difference between off and on (a covered renderer at about 27% of a
core both ways). They are not used below. A minimal Electron 43 app launched directly showed the effect on its own: with
no switch, a covered window went `hidden` and drew nothing; with Sotto's switch it drew 60 frames a second while covered.

## Before and after

Electron 43.8.3 (Chrome 150.0.7871.250), 24 logical CPUs, the Sotto window at 1280x800 on a 1920x1080 display at scale
1. The `phase3-workspace` scenario on Threads with two panes side by side, each streaming one reply at 20 updates a
second through main's e2e handler; each reply is a sliding window of its last 400 words, so every update costs the same.
Each launch went through six states, each a 5 s settle and a 25 s sample. Off and on alternated, off, on, off, on, off,
on, because another build ran on the laptop at the same time: the whole computer was 31-83% busy during the samples, and
that is kept with each run. CPU is a percentage of one core: each process's cumulative CPU time over the sample's wall
time. Every launch sent 3,710-3,754 updates with no error.

| Window | Renderer, off: median (min-max) | Renderer, on: median (min-max) | Main, off | Main, on | GPU, off | GPU, on |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Visible | 28.0 (27.7-38.5) | 28.9 (27.9-32.5) | 15.9 | 15.6 | 11.2 | 11.5 |
| Covered by a Sotto window | 20.9 (20.7-37.6) | **3.6 (2.5-4.0)** | 14.5 | 13.7 | 10.1 | 0.4 |
| Covered by another app's window | 20.2 (17.9-31.6) | **1.4 (1.3-1.4)** | 11.4 | 11.6 | 10.2 | 0.4 |
| Minimized | 3.4 (2.6-3.4) | 1.2 (1.1-1.3) | 9.7 | 9.7 | 0.4 | 0.4 |
| Hidden to the tray | 1.3 (1.1-1.3) | 1.3 (1.3-1.9) | 10.7 | 10.5 | 0.4 | 0.4 |
| Visible again | 22.5 (16.1-26.8) | 16.8 (16.6-17.0) | 13.4 | 14.2 | 12.2 | 8.8 |

Main and GPU are medians of the three runs. A covered window drew 27-60 frames a second with detection off and none with
it on. The on runs saved the most though the computer was busiest during them, and the off and on ranges do not overlap
in either covered row.

- **Covered:** the renderer falls by 83% under Sotto's own window and 93% under another app's, and the GPU process from
  about 10% of a core to 0.4%. This is more than #993's estimate of 55%.
- **Minimized:** a small saving, 3.4 to 1.2%. A minimized window already stopped drawing.
- **Hidden to the tray:** none. A hidden window already stopped drawing, and #1971 already holds its state.
- **Main:** unchanged, 11-15%. Main's work for streaming threads does not depend on whether the window draws.

## Hidden captures still work

The capture probe opens a page of two known colours with the agent browser tool and asks for `browser_action`
screenshots; a pass is a picture of that page, not a blank surface. Two runs each side, the same result both times.

| Where the page is / Sotto's window | Off | On |
| --- | --- | --- |
| Shown in the browser pane / visible | pass, 292 ms | pass, 276 ms |
| Shown in the browser pane / covered by a Sotto window | pass | pass, 79 ms |
| Shown in the browser pane / covered by another app's window | pass | pass |
| Shown in the browser pane / minimized | fails after 10 s | fails after 10 s |
| Shown in the browser pane / hidden to the tray | pass | pass |
| Browser hidden (the off-screen capture host) / all five window states | pass, about 200 ms | pass, about 200 ms |

The failure is the same both ways, "The page did not draw in time. Inspect it before trying again.", so it is not from
this change: #1999. `agent-browser.spec.ts` and `browser-pane.spec.ts`, run as CI runs them, gave 3 passed and 1 failed
both ways, the failure a click the row's Open-beside button takes (#2000); they cannot show occlusion either way.

## What is not measured

- The laptop alone: one Windows 11 computer, one display arrangement and one GPU. Other drivers may report occlusion
  differently, and Chromium counts a window covered only when other windows cover it whole.
- No CI job measures this. CI's desktop journeys launch through Playwright, which hides occlusion, so the benchmark runs
  by hand on Windows.
