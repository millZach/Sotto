# Git launches off main, and one re-read per folder - October 19, 2026

Typing into the window lagged now and then while threads ran. A 40 s CPU profile of the installed Owl build's Electron
main, taken while threads worked, counted about 200 separate `child_process.spawn` calls holding main for 3.1 s in
all, most of them 5-15 ms each, and one from `runWorktreeGit` that held it for 2,168 ms. On Windows `spawn` runs
CreateProcess on the thread that calls it, and in Electron main's JavaScript thread is the browser UI thread, so a
keystroke to the window waits for every launch in front of it. A bare `spawn('git', ['--version'])` from plain Node on
the same PC took 3 ms. Most of the launches were thread Git status reads (`gitStatus.ts`), the rest worktree Git
(`threadWorktrees.ts`): inspections, the reclaim scan and merged-branch checks.

This note measures the two changes made: Git and gh launch on a worker thread, and threads that share a folder share
its re-read after finished work.

## Setup

A Windows 11 laptop with 24 logical cores (Intel Core Ultra 9 275HX) and an SSD, Git 2.53.0.windows.2, Windows
Defender on, Node 24.14.1. Both benchmarks run on vitest under plain Node, against `main` at 339378ce2 for the before
figures. Each was run three times; the figures are the three runs.

## Launches on main's thread

`tests/perf/gitLaunchMainThread.perf.test.ts`: eight rounds of four threads at once, each a status read of a real
repository with an origin, a branch ahead of `main` and an uncommitted change, and an inspection of it as a shared
folder. Every launch on the test's thread is counted and timed around the `spawn` call, and a chain of `setImmediate`
measures how long the event loop could not turn (Windows' timer granularity rounds `monitorEventLoopDelay` to about
16 ms, so it cannot see this).

| | Launches on main | Main held by launches | Longest launch | Event loop held, longest | Event loop held, in all |
| --- | --- | --- | --- | --- | --- |
| Before: launched on main | 288 | 1,233 / 1,283 / 1,410 ms | 11.5 / 17.5 / 13.7 ms | 19.6 / 24.0 / 28.4 ms | 1,419 / 1,471 / 1,605 ms |
| After: launched on the worker | 0 | 0 ms | - | 2.4 / 4.8 / 5.8 ms | 9 / 43 / 43 ms |

The rounds took as long either way (3.7-4.2 s against 3.7-4.0 s): the Git processes themselves are no faster, main is
only free while they start. What is left of main's time is reading their output and the reader's own work.

## Git processes while threads work

`tests/perf/gitStatusCadence.perf.test.ts` (`SOTTO_PERF_BENCH=1`): three threads in one shared project folder, the
default for a new thread (ADR-0014), each finishing a tool call on its own beat (230, 290 and 370 ms) for 8 s, with
the host's own 1.5 s refresh delay and the real reader. Every finished tool call asks for the trailing re-read of the
thread's folder, which inspects it (three Git commands for a shared folder) and reads its status (four here).

| | Git processes in 8 s | A second | Status read calls | Folder inspections |
| --- | --- | --- | --- | --- |
| Before: a round per thread | 73 / 66 / 68 | 9.1 / 8.3 / 8.5 | 13 / 12 / 13 | 14 / 13 / 13 |
| After: a round per folder | 35 / 34 / 29 | 4.4 / 4.3 / 3.6 | 15 / 15 / 12 | 5 / 5 / 5 |

Before, each thread's re-read ran on its own timer, so the three threads read the same folder at three different
moments, each inspection and most status reads its own. Now the first finished record in a folder starts the round's
timer, every thread that finishes work in that folder before it fires joins it, and the round inspects the folder once
and reads its status once for all of them. Each joining thread's work finished before the timer fired, so before the
round's reads began: the round sees it, as the thread's own re-read would have. A thread can be read sooner than it
was, never later. A Git action in the folder after the round's inspection or status read began (`invalidateGitStatus`)
makes the next thread of the round read again rather than take it.

## What was not changed

- An inspection of a shared folder and its status read still read overlapping things (the branch, whether the tree is
  dirty): three Git commands of the seven in each round. Folding the inspection into the status read would change how
  a missing folder and a folder that is not a repository are reported, so it is left as a question.
- Status for threads nobody is viewing is still read after their work, since the Watcher overview and babysitting read
  the pull request it carries. Leaving those threads to the next view would make what they show staler.
- The timer's remote round reads each watched thread's folder again, fresh, after the fetch. That is once per fetch
  interval (30 s by default), so it was left alone.
- `githubPullRequestMerged` still runs its hourly `gh pr list` with `execFile` on main.
