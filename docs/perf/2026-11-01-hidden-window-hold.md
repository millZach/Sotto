# A hidden window draws nothing until it is shown - November 1, 2026

Part of #993, its third item. Measured with `tests/perf/hiddenWindowCommits.perf.test.tsx`, in the default suite:

```sh
NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/hiddenWindowCommits.perf.test.tsx --maxWorkers=1 --disable-console-intercept
```

It drives the window's real agent connection (`useAgentConnection`) with the window hidden. A thread streams for four
seconds, fifteen broadcasts a second as main sends them, and the benchmark counts React's commits of the state. Then the
window is shown. "Before" is the same file run on `origin/main` at `6e97b4f16`.

## What it cost

A hidden window committed every update it was sent, as a low-priority transition, and so drew itself again for nobody.
Sotto sits in the tray much of the day while threads work. #993 measured about 8 ms of renderer time per update, and
`threadsRender.perf.test.tsx` puts one update at 3-23 ms in jsdom depending on what it touches.

## The change

While `document.hidden`, a broadcast, or a thread detail that would commit the shell, does everything but the commit:

- it prunes request answers, as it always did before the commit;
- it keeps the newest shell, and asks for the history of the thread on screen;
- it hands the draft store the state directly, so a draft's confirmation is not held.

When the window is shown, the newest state commits at once.

What must not wait does not:

- a command's own reply commits, since it is urgent;
- a state that adds or removes a thread commits, since the browser tools watch each thread's tasks from the threads
  committed;
- a shell held for its animation frame still commits when the window hides, as before.

The browser itself, its tasks and its captures run in main and on the browser's own bridge, so ADR-0029's tools keep
acting while the window is hidden.

## Before and after

| Four seconds of a thread streaming, window hidden | Before | After |
| --- | ---: | ---: |
| Commits while hidden (60 broadcasts) | 60 | 0 |
| Commits when shown | 0 | 1 |

At 15 updates a second and 3-23 ms each, that is 45-345 ms of renderer time a second before, and none now, while any
thread streams with the window in the tray. This pull request does not measure the built app's renderer CPU while
hidden, which #993 also asks for. A covered window on Windows is a separate case: Windows never marks it hidden while
occlusion detection is off (ADR-0020), which is #993's fourth item.

## The guards

- `tests/perf/hiddenWindowCommits.perf.test.tsx`, in the default suite: 60 broadcasts while hidden commit nothing, and
  showing the window commits the newest once.
- `tests/unit/renderer/agentShellAssembly.test.tsx`:
  - a state held while hidden reaches the draft store at once, with no wait on a suspended animation frame, and shows
    once the window is shown;
  - a state that adds a thread, and a command's own reply, commit while hidden;
  - a shell pending its frame is let go of when the window hides, what arrives while hidden is held, and batching
    resumes when shown.
