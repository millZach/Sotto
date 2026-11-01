# A hidden window draws nothing until it is shown - November 1, 2026

Part of #993, its third item. Measured with `tests/perf/hiddenWindowCommits.perf.test.tsx`, in the default suite:

```sh
NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/hiddenWindowCommits.perf.test.tsx --maxWorkers=1 --disable-console-intercept
```

It hands the window's real agent connection (`useAgentConnection`) sixty broadcasts, one after another, with the window
hidden: as many as main sends in four seconds while a thread streams. It counts React's commits of the state, then shows
the window. It counts commits and times nothing. "Before" is the same file run on `origin/main` at `6e97b4f16`.

## What it cost

A hidden window committed every update it was sent, as a low-priority transition, and so drew itself again for nobody.
Sotto sits in the tray much of the day while threads work. #993 measured about 8 ms of renderer time per update, and
`threadsRender.perf.test.tsx` puts one update at 3-23 ms in jsdom depending on what it touches.

## The change

"Hidden" means nobody can see the window: its page is hidden, or main says the window is. Main's word, which
`startWindowVisibility` keeps on the root as `data-window-hidden`, counts because a window started hidden, or kept
visible for a capture, reports its page visible.

While the window is hidden, a broadcast, or a thread detail that would commit the shell, does everything but the commit:

- it prunes request answers, as it always did before the commit;
- it keeps the newest shell, and asks for the history of the thread on screen;
- it hands the draft store the state directly, so a draft's confirmation is not held.

When the window shows again, by its page or by main's word, the newest state commits at once.

Every state the window receives is numbered as it arrives, and the draft store is handed only one newer than the last it
was handed, directly or by a commit. A broadcast that began committing as a transition before the window hid can still
commit after a newer one was handed over, and handing over the older one would mark the newer draft superseded.

What must not wait does not:

- a command's own reply commits, since it is urgent;
- a state that adds or removes a thread commits. The browser tools watch each thread's tasks from the threads committed,
  so they are fed through a commit when the threads change, rather than outside React as #993 suggested;
- a state that turns Keep local history on or off commits, so the cached shell, which holds excerpts of messages, is
  cleared at once (ADR-0016).

A shell waiting for its animation frame when the window hides is held, not left waiting for a frame that a hidden window
does not draw. The browser itself, its tasks and its captures run in main and on the browser's own bridge, so ADR-0029's
tools keep acting while the window is hidden.

## Before and after

| Four seconds of a thread streaming, window hidden | Before | After |
| --- | ---: | ---: |
| Commits while hidden (60 broadcasts) | 60 | 0 |
| Commits when shown | 0 | 1 |

The benchmark counts commits. What a commit costs is an estimate from elsewhere: if each costs what an update costs in
`threadsRender.perf.test.tsx`, 3-23 ms in jsdom, fifteen a second come to 45-345 ms of renderer time a second, which a
hidden window no longer spends on commits. Assembling each state, pruning request answers and handing the draft store
its state still run. This pull request does not measure the built app's renderer CPU while hidden, which #993 also asks
for. A covered window on Windows is a separate case: Windows never marks it hidden while
occlusion detection is off (ADR-0020), which is #993's fourth item.

## The guards

- `tests/perf/hiddenWindowCommits.perf.test.tsx`, in the default suite: 60 broadcasts while hidden commit nothing, and
  showing the window commits the newest once.
- `tests/unit/renderer/agentShellAssembly.test.tsx`:
  - a state held while hidden reaches the draft store at once, with no wait on a suspended animation frame, and shows
    once the window is shown;
  - a draft handed over while hidden is never followed by an older state that began committing before the window hid;
  - a state that turns Keep local history off commits while hidden, and the cached shell is cleared;
  - a window main calls hidden is held though its page reports it visible, and catches up when main says it shows;
  - a state that adds a thread, and a command's own reply, commit while hidden;
  - a shell pending its frame is let go of when the window hides, what arrives while hidden is held, and batching
    resumes when shown.

Each of the second, third and fourth fails with its part of the change taken out.

Hidden captures for browser tasks and the test iPhone run in main and are not exercised here; nothing they read is held.
