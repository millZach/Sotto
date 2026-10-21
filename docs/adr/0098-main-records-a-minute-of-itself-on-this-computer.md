# Main watches its own event loop and records a minute of itself on this computer

Accepted by Zach on October 20, 2026 (#1233). An Owl feature (ADR-0072), `main-freeze` in `src/shared/owlFeatures.ts`: stable builds none of it, starts no monitor, shows no notice and registers no bridge.

Finding the October 20 lag meant attaching a debugger to the running app by hand. Main now watches its own event loop, says so when it is frozen, and can record one minute of its own CPU profile and the main window's, saved on this computer, ready to hand to a thread.

## The watch

A timer in main asks to run every 100 ms and counts how late it ran. Lateness over the timer's own jitter (2 ms) is time main spent on something else and could not answer. The window keeps the blocked stretches themselves, each a start and an end, and drops a stretch once it ends before the last sixty seconds; a minute holds at most one a sample. Every figure is read from those stretches over exactly the last sixty seconds, with nothing averaged: the blocked share, the sixty one-second bars counted back from now, the longest freeze and how many freezes of 100 ms or more. A freeze partly outside the minute counts for its part inside, in the bars, the longest freeze and the count alike. **Frozen** means main was blocked for more than half of the last minute (Zach's pick). Seconds before the watch started count as answered, so a busy start does not read as a freeze.

The watch is a subtraction and at most two typed-array writes a sample (about 0.02 µs), ten samples a second, with the frozen answer worked out once a second; its timer is unreferenced, so it never keeps Sotto running. What it costs is the timer waking Electron's main process: measured over 20 s windows on the development PC, a 100 ms timer cost the process about 2 ms of CPU a second against about 6.5 ms for a 50 ms one, so the watch takes 100 ms and reads a freeze's length to within that. A freeze is counted from how late the timer ran, which is never longer than the freeze itself. The window hears from main only when the frozen answer, Not now or a recording changes, and reads the numbers once a second only while the popover or Settings > Performance is open. Lateness was chosen over `performance.eventLoopUtilization()` because in Electron's main process it reads no idle time and no use at all, busy or not (checked October 20, 2026), so it cannot tell a freeze from a quiet minute.

## The notice

Variant A of `docs/prototypes/main-freeze-recorder-prototype.html`: a **Main is slow** pill in the title row, left of the window controls (alone in that corner on macOS and Linux), opting out of dragging. It shows only while main is frozen, while a recording runs, or while a saved recording waits. It opens a popover with the numbers, the minute's chart, **Record a minute** and **Not now**; Escape wherever focus is, a press outside or Tab out of it closes it. Not now hides the notice until main recovers and freezes again. **Tell me when main freezes** in Settings > Performance turns the notice off; it is on by default in Owl. Settings > Performance keeps the numbers and the record control either way.

## An activity recording

Record a minute profiles main through an in-process `node:inspector` session (`Session.connect`, which opens no port and no listener) and the main window through its own `webContents.debugger`, both with the DevTools Profiler domain at one sample a millisecond. When DevTools or anything else already holds the window's debugger, the recording keeps main's profile alone and says so. Stop without saving keeps nothing, and wins at any point before the folder is published, even while the profiles are being collected or the files written.

The recording is a folder, `sotto-activity-<date>-<time>`, under Sotto's data folder in `performance-recordings`:

- `main.cpuprofile` and `window.cpuprofile`, Chrome CPU profiles holding each node's function name, script, line and column, hit count and children, and the samples and their time deltas. `positionTicks`, deopt reasons and everything else the profiler adds are dropped.
- `summary.json`: the format, Sotto's version, the platform, when it started, how long it ran, the files, whether the window was recorded, and the minute's numbers before and during the recording.

A script is kept by its place inside the app (`sotto:///out/main/index.js`), or by name for Node's and Electron's built-in modules, so no folder of this computer is saved. A frame from any other script, such as a page embedded in the window, or with no script address at all, such as code evaluated from text whose function names can be anyone's words, keeps neither its function name nor its address: both read `(outside Sotto)`, with only its timing kept. V8's own frames, `(root)`, `(program)`, `(idle)` and `(garbage collector)`, keep their names. Only the newest five recordings stay; saving a sixth removes the oldest.

A recording is written into a `.partial` folder and renamed when every file is written. When a save fails, Sotto removes what it wrote and says nothing was kept; if it cannot remove a folder, the message names the folder that is left. A half-written folder, from a failure or a quit mid-save, is removed when Sotto starts and before every save. A recording stopped just after it was published is renamed back to a half-written folder before it is removed, so if removing it fails the same sweep takes it; only if that rename fails too is it left under its own name, and the message says it is kept like a saved recording until five newer ones are saved.

**Attach to a thread** (Zach's pick) starts a new thread on the Threads page, in the current project when it is on this computer and through the project chooser otherwise, with an unsent draft that names the folder and its files. The user sends it. The composer's attachments are images checked by their signature (ADR-0031), so the files are named by path rather than attached; a thread on this computer reads them where they are. **Show in folder** reveals the recording in the system's file manager.

## Why this keeps the privacy promise

A CPU profile is code and timing: which of Sotto's functions ran and for how long. It holds no prompt text, transcript, provider body, key or dictation audio, because those are values and a profile records no values. The ways a profile can name something outside Sotto, a script URL from an embedded page or a function name from code with no address, are renamed before anything is written. Nothing leaves this computer: no host is added, and the recording reaches a provider only if the user sends the draft that names it. Logs carry stable event names only (`activity-recording-saved`, `activity-recording-failed`, `activity-recording-window-unavailable`), never a path or anything a recording holds.

## Testing hooks

Development runs of the e2e suite may shorten the window (`SOTTO_E2E_MAIN_LOOP_WINDOW_SECONDS`) and the recording (`SOTTO_E2E_ACTIVITY_RECORDING_MS`); a packaged build reads neither.
