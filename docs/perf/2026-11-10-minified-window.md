# The window's bundle, minified - November 10, 2026

Issue #2396, its second piece, part of #995 (the November 10 audit, finding 7). electron-vite leaves the renderer's
build unminified, and the main window loaded 7.8 MB of script and 1.2 MB of stylesheet before React started. The
renderer build now minifies. The window's first scripts are half the size. On forge, first paint did not move by more
than the run-to-run spread.

## What changed

- **The renderer build minifies.** `electron.vite.config.ts` sets `minify: 'esbuild'` on the renderer: the main window,
  the widget and the popup. Vite minifies their scripts and, following that setting, their stylesheets with the esbuild
  it already carries. No dependency was added.
- **Main's bundle and the preload are as they were.** Neither is parsed by the window's page, so neither moves page
  start to first paint, and each has a reason to stay readable: main's uncaught-exception report names where it was
  thrown (`tests/e2e/e2e-uncaught-exception.spec.ts`), and the visual preload injects a function's own source into a
  frame (`protectPage.toString()` in `src/preload/visual.ts`). Minifying either is a separate change with its own
  measurement.
- **No source maps, as before.** None were built before this change and none are now. `electron-builder.yml` ships
  `out/**/*`, so a map would ship with the app.
- **A guard.** `tests/unit/release/rendererMinify.test.ts` reads the build config: the renderer minifies, stylesheets
  follow it, and no build makes source maps. electron-vite's default would quietly put the bytes back.

## Sizes

`npm run build` at `b12703555`, before and after, bytes on disk.

| | Before | After | |
|---|---:|---:|---:|
| **The main window's first scripts** | **7,805,892** | **4,037,536** | **-48%** |
| `main-*.js` | 4,901,474 | 2,474,719 | -50% |
| `global-*.js` | 1,506,582 | 704,699 | -53% |
| `interfaceLanguage-*.js` | 1,373,270 | 843,795 | -39% |
| `ListeningBars-*.js`, `diagramSteps-*.js` | 24,566 | 14,323 | -42% |
| The main window's first stylesheets | 1,180,730 | 853,529 | -28% |
| `main-*.css` | 843,305 | 622,098 | -26% |
| `global-*.css` | 335,105 | 230,200 | -31% |
| The widget's first scripts | 1,421,160 | 868,098 | -39% |
| The widget's first stylesheets | 26,433 | 17,394 | -34% |
| The popup's first scripts | 2,919,201 | 1,568,407 | -46% |
| Every script under `out/renderer/assets` (255 files) | 29,753,961 | 22,275,526 | -25% |
| Every stylesheet there | 1,225,267 | 882,827 | -28% |
| Files over 100 KB | 111 | 107 | |
| Main's bundle, `out/main/index.js` | 8,923,066 | 8,923,066 | unchanged |
| The preload, `out/preload/index.js` | 691,899 | 691,899 | unchanged |

The other files over 100 KB load later, with the first diagram, terminal or formula:

| | Before | After |
|---|---:|---:|
| `cynefin-*.js` | 1,304,485 | 687,746 |
| `diagramRenderer-*.js` | 1,287,577 | 732,586 |
| `cytoscape.esm-*.js` | 961,036 | 443,036 |
| `terminalView-*.js` | 679,612 | 518,056 |
| `katex-*.js` | 484,523 | 261,313 |
| `architectureDiagram-*.js` | 423,313 | 151,905 |
| `index-*.js` (the code highlighter) | 336,144 | 173,010 |
| `swimlanes-*.js` | 298,744 | 115,870 |
| `cose-bilkent-*.js`, `sequenceDiagram-*.js`, `ganttDiagram-*.js`, `c4Diagram-*.js`, `flowDiagram-*.js` | 766,513 | 395,992 |
| The interface language catalogs, all 186 files (6 for each of 31 languages) | 14,050,157 | 14,048,297 |

The catalogs are compiled message data, already as short as they can be, which is why everything under `assets`
shrank by a quarter while the scripts the window starts with shrank by half. Every file is listed in the evidence.

## Launch

`tests/e2e/launch-time.spec.ts` on forge (Linux) under `xvfb-run`, an empty profile, seven launches after a warm-up
each time, the two builds in turns: before, after, before, after. Each cell is that round's median, with its range.
Other agents were working on forge; the load average is when the round started.
So these rounds say only that minifying did not move first paint by more than the spread between rounds on a busy
machine. `docs/ci.md` asks for a timing benchmark on an idle one, and forge was not: the before and after that counts is
the Launch time workflow's, on a Windows and a macOS runner of its own, once that workflow is on `main` (#2412).

| Round | Build | Load | Asked to page start | Page start to DOM ready | Page start to first paint | Asked to first paint |
|---|---|---:|---:|---:|---:|---:|
| 1 | Before | 3.9 | 705 (679-804) | 319 (306-336) | 532 (528-544) | 1,233 (1,212-1,348) |
| 2 | After | 2.8 | 778 (696-901) | 314 (292-330) | 528 (496-564) | 1,310 (1,200-1,465) |
| 3 | Before | 3.1 | 767 (715-1,212) | 355 (322-1,038) | 596 (536-1,380) | 1,354 (1,251-2,180) |
| 4 | After | 8.0 | 721 (684-767) | 316 (292-355) | 532 (492-572) | 1,231 (1,176-1,303) |

Milliseconds. Page start to first paint was 532 and 596 ms before and 528 and 532 ms after. **The difference is
inside the run-to-run spread**: round 1, before, and round 4, after, have the same median, and round 3 is 64 ms slower
than round 1 on the same build, with one launch at 1,380 ms. Page start to DOM ready, which takes in running the
window's module scripts, is the same story: 319 and 355 before, 314 and 316 after. Asked to page start is Electron and
main starting, which this change does not touch, and it moved by as much as 62 ms between rounds of the same build.

Why halving the script did not show on forge was not measured. The likely reason is that the bytes were not where the
time went: V8 compiles a function when it is first called and before that only scans it, so 3.8 MB less source is
3.8 MB less to read and scan, a few milliseconds on a fast machine reading a warm disk cache. A slower laptop may show
more. #2396 asks for Windows numbers too; they were not taken here.

**At rest**, from the same spec, five seconds after first paint:

| Round | Build | The two windows | Main | GPU process | All six processes |
|---|---|---:|---:|---:|---:|
| 1 | Before | 391.9 MB | 321.0 MB | 137.2 MB | 1,018.5 MB |
| 2 | After | 378.7 MB | 321.1 MB | 136.9 MB | 1,003.5 MB |
| 3 | Before | 387.3 MB | 320.1 MB | 136.4 MB | 1,009.0 MB |
| 4 | After | 365.7 MB | 314.7 MB | 128.1 MB | 960.6 MB |

Working sets, medians. The windows held 9 to 26 MB less after. Some of round 4's drop is the machine: main and the GPU
process fell too, and this change touches neither. CPU at rest was 0% in every round.

## What reads a name the build changes

Minifying renames local functions, classes and variables. Everything in the window's bundle (`src/renderer`, and the
parts of `src/shared` it imports) was searched for code that depends on a name surviving the build.

- **Error names.** `audioRecorder.ts`, `microphoneTest.ts` and `dictationController.ts` compare `error.name` with
  `NotAllowedError`, `SecurityError`, `NotFoundError` and `OverconstrainedError`. Chromium sets those names on its own
  exceptions; they are not names from Sotto's code. `AudioRecorderError` and `TranscriptionError` set `this.name` to a
  string. `ImageTooLargeError`, `DiagramRefusal` and `ThemeLibraryError` set no name, so their `name` is `Error`
  minified or not (an instance's `name` is not its class's), and code tells them apart with `instanceof`, which the
  build keeps. Safe.
- **`constructor.name`, `Function.prototype.name`, `displayName`.** None in the window's code. No component sets a
  `displayName`, and no e2e spec reads a component's name or React's internals. Safe.
- **zod** (in the window through `src/shared`). zod names its own classes with `Object.defineProperty` and tells
  schemas apart by trait strings. Its two `constructor.name` reads are of `AsyncFunction`, a built-in, and of the
  received value's class in an error message; the window parses structured-clone data, plain objects and built-ins.
  Sotto's `z.custom` checks use `instanceof`. Safe.
- **Lingui.** The macros become `i18n._({ id, values })` before minifying, and a placeholder's name is an object key
  and a string in the catalog, which minifying keeps. Checked in the minified build: `values:{intentName:...}` beside
  the catalog's `[["intentName"],": "]`. Safe.
- **Names over IPC or in storage.** The window sends no function or class name to main. Its storage keys are string
  constants (`sotto.threadWorkspace.sidebar` and the like), and `window.sotto` is a property, which minifying never
  renames. Safe.
- **Dynamic imports.** `interfaceLanguage.ts` lists catalogs with `import.meta.glob`, which Vite resolves before it
  minifies; every other `import()` takes a literal path. The audio worklet is a public file copied as it is and
  registered by the string `sotto-audio-capture`. Safe.
- **CSS class names.** No CSS modules; every class name is a string literal, and esbuild's stylesheet minifier renames
  no class. Safe.
- **Stylesheet syntax esbuild does not know.** `threadSidebar.css` has keyframes keyed by timeline ranges
  (`entry 0%, entry 80%`). esbuild warns `css-syntax-error` and copies the block as written, which the minified
  stylesheet shows; every build now prints that warning. Left visible rather than silenced, since silencing the
  category would hide a real mistake too.
- **Function source.** `src/preload/visual.ts` sends `protectPage.toString()` into a frame. That is the preload, which
  this change leaves alone.
- **Stacks.** The window reports no stack anywhere: a window that crashes reaches main as `render-process-gone`, with
  no frames (`windowManager.ts`, `popupWindow.ts`), and `e2e-uncaught-exception.spec.ts` covers main's report, which
  stays unminified. What changes is DevTools in a built app: a renderer error there now shows short names, on line 1 of
  each file. `npm run dev` does not minify.

## Journeys on the minified build

On forge under `xvfb-run`, one at a time. Forge is not where these are checked, so a failure was run again on the
unminified build and only differences count.

| Spec | Minified | Unminified |
|---|---|---|
| `app.spec.ts` | 10 passed, 8 failed | the same 8 failed, with the same messages |
| `daily-workspace.spec.ts` | 1 passed, 1 skipped (Windows only) | not needed |
| `settings-index.spec.ts` | skipped (Windows only) | not needed |
| `split-workspace.spec.ts` | 1 passed | not needed |
| `thread-activity.spec.ts` | 6 passed | not needed |
| `linux-settings-copy.spec.ts` | 1 failed | the same failure |

No difference between the builds. The eight in `app.spec.ts` fail on forge for reasons of the machine, not of the
window's code: the dictation shortcut cannot be triggered there (`E2E_SHORTCUT_UNAVAILABLE`), the room follows the
Omarchy theme where the spec expects another, the microphone wording it looks for is another system's, and the
widget's native bounds come out differently under the virtual display. Since `settings-index.spec.ts` and the main
`daily-workspace.spec.ts` journey run only on Windows, the last three rows were added to drive the Threads page and
Settings on Linux. CI's Windows desktop journeys run both Windows-only specs on this build: a change to
`electron.vite.config.ts` makes Package (Windows) needed, and with it the journeys (`docs/ci.md`).

**The look, build against build.** `split-workspace.spec.ts`, `thread-activity.spec.ts` and `daily-workspace.spec.ts`
save 40 screenshots between them: the Threads page with one pane and two, light and dark, from 760 to 1600 pixels wide
and at 125%. Each was compared pixel for pixel between the builds, and between two runs of the same build to see what
a run changes by itself. Every screenshot that differed between the builds also differed between runs of one build:
times such as "Worked for 2909h 56m", and a step or scroll caught partway. One, `asked-where-820-light.png`, differed
between the builds but not between the two unminified runs; a second minified run matched the unminified one pixel for
pixel. No screenshot differed in a way a run does not.

The design captures were not run against their baselines, which were taken on Windows and macOS, and CI does not run
them (`docs/ci.md`). Tried on forge to compare the two builds instead, `design-capture-pages.spec.ts` stopped at its
second onboarding step on the unminified build, as `app.spec.ts` does on both: on forge the first run does not show the
step that chooses a look. Stylesheets are minified too, so the captures on Windows and macOS are still the check this
change most needs.

Who runs them: on Windows, a worker on the laptop runs `npm run design:verify` on this branch before it merges, which
Watcher arranges once the pull request is otherwise ready; this pull request does not merge without that. On macOS
nobody has been named: the captures there are taken by hand on the Apple silicon Mac, and whoever cuts the next Mac
build runs `npm run design:verify` on it first.

## Re-run

```sh
npm run build
node -e "for (const f of require('fs').readdirSync('out/renderer/assets')) { const s = require('fs').statSync('out/renderer/assets/' + f).size; if (s > 100000) console.log(s, f) }"
SOTTO_PERF_BENCH=1 SOTTO_LAUNCH_RUNS=7 xvfb-run -a -s '-screen 0 1920x1080x24' npx playwright test tests/e2e/launch-time.spec.ts
npx vitest run tests/unit/release/rendererMinify.test.ts
```

The scripts a page loads at start are the `<script>` and `<link rel="modulepreload">` entries in
`out/renderer/index.html`, `widget.html` and `popup.html`. For "before", set `minify` back to `false` and build again.
On Windows, run the launch spec without `xvfb-run`.

Evidence: `data/2026-11-10-minified-window/sizes-and-launch-forge.json`, every asset over 100 KB in both builds, each
page's first files, and each round's summary from the launch spec.
