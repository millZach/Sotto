# Startup marks - November 10, 2026

Issue #2396, its first piece, part of #995 (the November 10 audit, finding 7). #995 lists nine changes to show the main
window sooner and asked for timing marks first, so each later change has a before and an after. The audit's
`tests/e2e/launch-time.spec.ts` timed launch from outside the app: the ask, the window's page starting to load and its
first paint. It could not see inside main. Now main records where launch has got to, and the spec reports it.

## What changed

- **Main records nine startup marks** (`src/main/performance/startupMarks.ts`). Each is the time since main's clock
  started, from `performance.now()`. Recording one pushes onto a list of at most nine. Each name is kept the first time
  launch reaches it, and nothing is kept once launch has finished, so a window made later leaves no late mark.
- **Names and numbers only, kept in memory.** Nothing logs them, writes them or sends them. Only an unpackaged e2e
  launch (`SOTTO_E2E=1`) can read them, through `globalThis.sottoStartupMarksE2E` (`src/main/e2e/startupMarks.ts`), the
  way the other e2e hooks are reached.
- **Launch itself is unchanged.** No step moved and none was added beyond the marks.
- **The spec reports them**, beside what it reported before: each mark's median, lowest and highest, and
  `askedToMainClockMs`, when main's clock started after the launch was asked. With that, the marks and the page's clocks
  sit on one line from the ask. A run that does not reach a mark leaves it out, and the summary says how many runs had
  it. `SOTTO_LAUNCH_OUT` writes the same JSON to a file.
- **`.github/workflows/launch-time.yml` times launch on Windows and macOS** (the section in `docs/ci.md`), since the
  laptop runs no suites. Started by hand, it measures a base and the chosen ref on the same runner and writes both and
  their ratio to the run's summary.

## The marks

In the order launch reaches them. Every time is milliseconds since main's clock started, which is the main process
starting: on forge it starts about 21 ms after Playwright asks for the launch.

| Mark | Where | Launch has reached |
|---|---|---|
| `main-bundle-evaluated` | `src/main/index.ts`, its first line | Electron has started, and main's bundle has loaded and run every import |
| `app-ready` | `bootstrapSotto`, after `app.whenReady()` | Electron is ready; the single-instance lock is held |
| `runtime-created` | `bootstrapSotto`, after `createRuntime` | Every store, migration, the agent runtime, hosts and drafts |
| `main-window-created` | `WindowManager.createMainWindow` | The main window exists, hidden, and starts loading its page |
| `main-window-loaded` | the same, once its page loads | The main window's page has finished loading |
| `widget-created` | `WindowManager.createWidgetWindow` | The widget's window exists. Not at launch while dictation is off (ADR-0107) |
| `widget-loaded` | the same, once its page loads | The widget's page has finished loading |
| `main-window-shown` | `WindowManager.showMain` | The main window is first shown. Not at launch with Start minimized on |
| `launch-finished` | `bootstrapSotto`, after the runtime's start | Everything above, and the resting widget's first state. Nothing is kept after it |

## Baseline on forge

Forge (Linux, Intel Core i5-14400F, 16 threads) under a virtual display, Node 24.22.1, an empty profile, which opens on
first-run setup. Seven launches after one to warm the disk, on `c568e948b` with this change. Each row is that mark's
median; the step is the gap between one median and the one before it.

| | Since main's clock started | Step |
|---|---:|---:|
| `main-bundle-evaluated` | 315.5 ms (312.9 to 352.8) | 315.5 ms |
| `app-ready` | 358.4 ms (352.4 to 398.7) | 42.9 ms |
| `runtime-created` | 622.3 ms (614.6 to 658.1) | 263.9 ms |
| `main-window-created` | 659.0 ms (649.3 to 692.2) | 36.7 ms |
| `main-window-loaded` | 991.0 ms (971.0 to 1,015.2) | 332.0 ms |
| `widget-created` | 1,007.8 ms (988.4 to 1,032.0) | 16.8 ms |
| `widget-loaded` | 1,180.3 ms (1,156.8 to 1,207.8) | 172.5 ms |
| `main-window-shown` | 1,183.5 ms (1,160.0 to 1,211.4) | 3.2 ms |
| `launch-finished` | 1,183.6 ms (1,160.1 to 1,211.5) | 0.1 ms |

The ask to first paint was 1,215.6 ms. Less the 21.7 ms before main's clock started, that is 1,194 ms on main's clock,
about 10 ms after `main-window-shown`. The window's page had finished loading about 200 ms before that, so on forge the first paint
waits for the window to be shown, which waits for the widget's page. That is #995's fourth change, "Show the main window
without waiting for the widget", read from a fast Linux machine. The Windows and macOS runs will say how much of it holds
there.

Evidence: `docs/perf/data/2026-11-10-startup-marks/launch-time-forge-after.json`.

## What the marks cost

The same spec, run on the same build without and with the marks, one after the other under the heavy-job lock. Before
is `c568e948b` as it is; after is the same commit with this change. Medians of seven, lowest to highest.

| | Before | After | After / before |
|---|---:|---:|---:|
| Asked to the page starting to load | 709.0 ms (663.7 to 720.1) | 683.6 ms (670.1 to 714.2) | 0.96 |
| Page start to first paint | 524 ms (516 to 536) | 524 ms (520 to 540) | 1.00 |
| Asked to first paint | 1,225.1 ms (1,195.7 to 1,256.1) | 1,215.6 ms (1,190.1 to 1,238.0) | 0.99 |
| Memory at rest, all six processes | 960.5 MB | 960.8 MB | 1.00 |
| Main's memory at rest | 312.8 MB | 312.3 MB | 1.00 |

Within the runs' spread: the marks cost nothing the spec can see. Evidence:
`docs/perf/data/2026-11-10-startup-marks/launch-time-forge-before.json` and `launch-time-forge-after.json`.

`tests/unit/main/startupMarks.test.ts` holds the names and their order, that each is kept once and none after launch
finishes, that a normal session cannot read them, and that main places each name exactly once and reads them only
through the e2e hook.

## On Windows and macOS

Not measured yet. A workflow can be started by hand only once it is on `main`, so the first Launch time run follows this
change's merge. Its summary, base and change side by side, is the Windows and macOS baseline the later pieces of #995 are
measured against.

## Re-run

```sh
npm run build
SOTTO_PERF_BENCH=1 SOTTO_LAUNCH_RUNS=7 xvfb-run -a -s '-screen 0 1920x1080x24' npx playwright test tests/e2e/launch-time.spec.ts
npx vitest run tests/unit/main/startupMarks.test.ts tests/unit/scripts/launchTimeCompare.test.mjs
```

On Windows and macOS, without `xvfb-run`, or from the Actions tab: **Launch time**, with a ref to compare against.
