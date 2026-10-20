# Main freeze notice and Record a minute (#1233)

October 20, 2026, on the Windows development PC, from the built app with `SOTTO_OWL_FEATURES=main-freeze=1` (`tests/e2e/main-freeze-notice.spec.ts`, run with `SOTTO_E2E_EVIDENCE=publish`). Main was made to freeze by busy-waiting in its own process for 800 ms of every second; the watch's window was shortened to six seconds and the recording to three, through the development-only overrides ADR-0097 names. Sotto's data folder sat under a short neutral folder at the drive's root rather than the temporary folder, so the path the draft names carries no user name.

## What was checked

- **Stable shows none of it.** With `main-freeze=0` the window has no `mainActivity` bridge, a freeze shows no pill, and Settings has no Performance section.
- **The pill.** It appears once main is blocked for more than half the window, reads **Main is slow**, names itself "Main is slow: blocked N% of the last minute. Show details", and opts out of the drag strip (`-webkit-app-region: no-drag`). A thread is open behind it, so the pane's title row makes room.
- **The popover.** Pressing the pill moves focus to its heading, shows the share, the longest freeze, the count of freezes over 100 ms and the chart (named for a screen reader), with **Record a minute** and **Not now**. Escape closes it and returns focus to the pill. Tab out past its last control closes it and leaves focus where Tab put it.
- **Reduced motion.** With `prefers-reduced-motion: reduce` emulated, the popover arrives with no animation (`animation-name: none`, and its arrival animation is back once the emulation is lifted) and the recording's progress bar moves without easing (its transition is 1 ms at most, under Sotto's global reduced-motion rule).
- **Not now** hides the pill while main stays frozen; after main recovers and freezes again it comes back.
- **Settings > Performance** shows the live numbers in the warning colour while frozen, Record a minute, and **Tell me when main freezes**, on. The heading reads **Performance** alone, as the other Owl sections do.
- **Record a minute** from the popover counts down in the pill (**Recording, N s**) with a progress bar, then shows **Activity recording saved** with the folder's name, its three files and size.
- **The files.** `performance-recordings/sotto-activity-<date>-<time>/` holds `main.cpuprofile`, `window.cpuprofile` and `summary.json`. Every profile node has only `id`, `callFrame`, `hitCount` and `children`; every script URL is empty (V8's own frames), a Node or Electron built-in, `sotto:///…` or `(outside Sotto)`; neither the data folder's path nor the checkout's appears anywhere; the summary has exactly the fields ADR-0097 lists and says the window was recorded.
- **Attach to a thread** opens the Threads page on a new thread whose composer holds the unsent draft naming the folder and files; nothing in the window carries the Windows user name. The popover then says it was added, and **Close** puts the pill away.
- At 1600x1000, 1280x800 and 820x560, in dark and light, nothing spills past the window and the popover stays inside it.

What the running app does not show, the unit tests hold: a frame with no script address keeps neither its name nor its URL; the window reads exactly the last minute; Stop without saving wins while the profiles are collected or the files written; a failed save leaves no files, or names the folder it could not remove.

## Screenshots

In `artifacts/main-freeze-notice/`. None shows a user name or a folder of this computer outside the neutral data folder.

- `pill-{1280x800,820x560}-{dark,light}.png`: the pill beside the window controls, a thread open.
- `popover-{1600x1000,1280x800,820x560}-{dark,light}.png`: the popover with the numbers, the chart, Record a minute and Not now.
- `popover-1280x800-dark-reduced-motion.png`: the popover with reduced motion emulated.
- `settings-{1600x1000,1280x800,820x560}-{dark,light}.png`: Settings > Performance while main is frozen.
- `saved-{1280x800,820x560}-{dark,light}.png`: the saved recording in the popover over Settings > Performance.
- `attached-1280x800-dark.png`: the new thread Attach to a thread opened, its unsent draft naming the recording.

The spec also captures the pill and the saved recording at 1600x1000; those are checked for overflow and not committed.

## Cost

`tests/perf/mainLoopMonitor.perf.test.ts`: about 0.02 µs a sample. Measured in Electron's main process over 20 s windows, a 100 ms timer costs the process about 2 ms of CPU a second (about 6.5 ms for a 50 ms timer), which is why the watch samples every 100 ms.

## Notes on the run

While main busy-waits most of every second, Playwright's own evaluate in main now and then loses its context, and a window resize lands only in main's free moments, so the spec retries that evaluate and waits up to 30 s for a resize. Neither touches what the app does. The final run: 2 passed.

## Not checked here

macOS and Linux, where the pill stands alone in the top-right corner.
