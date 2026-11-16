# Claude Code and Codex start off main - November 16, 2026

Zach saw Sotto stop for about two seconds at 11:28 local on November 16, 2026, on Owl 0.1.43-owl.20261116.1. Main's
hang recording for it (`performance-recordings/sotto-hang-2026-11-16-11-28-15/hang.json` in Sotto's data folder, #2518)
says main answered after 2,679 ms, and its one stack, taken at 2,423 ms, is inside Node's `spawn` under
`new ClaudeProtocol`. Two seconds before, Zach had selected a Claude thread, which starts its CLI early (#769). This
is #2550.

## What the recordings show

The day's ten main hang recordings, by what main was doing:

| Time (local) | Answered after | Where main was |
| --- | --- | --- |
| 00:05 | 2,644 ms | `spawn` < `ClaudeProtocol` |
| 10:35 | 2,622 ms | `spawn` < `ClaudeProtocol` |
| 11:02 | 1,658 ms | `createSocket` < `spawn` < `ClaudeProtocol` |
| 11:28 | 2,679 ms | `spawn` < `ClaudeProtocol` |
| 11:30 | 2,575 ms | `spawn` < `ClaudeProtocol` |
| 08:53 | 1,461 ms | `immutableUpdates` < `shellOf` < `broadcastShell` |
| 10:20 | 1,770 ms | `readLog` (Claude session log) |
| 10:31 | 1,588 ms | `visitUsage` < `acceptSnapshot` under a Claude frame |
| 10:34 | 1,734 ms | `clonePlainData` < `shellOf` under `openTailnet` |
| 09:22 | 57 min | no stack (the laptop asleep) |

Five of the nine real stops are a Claude Code start. The stack is always the JavaScript just after the native
CreateProcess call returns, because a stack can only be taken between JavaScript steps: the time went to CreateProcess.
The other four have their own causes and are not changed here.

## Why a start is sometimes slow

Claude Code's `claude.exe` is 372 MB, and it had not changed since November 13: the slow starts are not the first
start after an update. A start of it from plain Node took 5-10 ms when warm, with the same arguments and environment
as a thread's or with a new session ID, a long system prompt and a new environment variable each time. A fresh copy of
the file, which Windows has never started, took 1.1-2.1 s to start, and 2-5 ms the second time. Reading the whole copy
first, so it was in the file cache, still left 0.7-0.9 s. The cost is Windows' first start of an image it has let go
of (with Defender's check of it), not Sotto's arguments, and it came back five times in a day with the file unchanged,
twice two minutes apart. So warming the executable after an update, the other way #2550 named, would not have
prevented any of these.

## The change

Claude Code's thread processes (`ClaudeProtocol`, which also reads skills) and Codex's app-servers (`CodexProcess`)
start through the launcher Git already starts through (`gitLauncher.ts`, `docs/perf/2026-10-19-git-launch-off-main.md`),
on a worker of their own (`providerLauncher`). The worker does only the launch: it starts the process and relays its
output, exit and close; everything else stays in main. A slow start holds the worker instead, so the provider worker is
separate from Git's: a provider start does not wait behind Git's frequent launches, nor a Git read behind a provider's
slow start. The pid now arrives a moment after the start, so Claude's halt waits for it before stopping the tree.

## Before and after

`tests/perf/providerStartMainThread.perf.test.ts`. The default run asserts that a Claude Code start and a Codex start
each make no launch on the test's thread through the worker (one each before), and goes red on the old code. The
benchmark (`SOTTO_PERF_BENCH=1`) starts a fresh copy of an executable each time, so every start is cold, and measures
the longest the event loop could not turn with a chain of `setImmediate`. Same laptop as the Git note (Intel Core Ultra
9 275HX, Windows 11, Defender on), Node 24.14.1, three runs of five cold starts each.

| Cold start of | Started in main's thread | Started on the provider worker |
| --- | --- | --- |
| A copy of Node (91 MB) | 824-1,291 ms per start | 0.4-4.0 ms |
| A copy of Claude Code 2.1.325's `claude.exe` (372 MB) | 1,167-4,140 ms per start | 0.4-3.6 ms |

Every output chunk now crosses from the worker to main. Reading 64 MB of Codex notifications in 16 KB lines cost main's
event loop 123 / 132 / 143 ms read in its own thread and 118 / 139 / 81 ms through the worker: no measurable cost.

## What was not changed

Cursor, DeepSeek, Devin, Hermes, Muse, Pi, OpenCode and the subscription probes still start in main's thread. None
has a recorded stop; each can move to `launchProviderProcess` the same way if one does.
