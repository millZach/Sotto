# A send waiting on a checkpoint it cannot take - October 23, 2026

Reported by Zach on Owl 0.1.41-owl.20261023.5 (Windows, built from `6ec9c1fa8`): sending to a thread took 10 to 60
seconds. This note is what was measured in the running app and the one cause found on the send path itself. The rest
of the delay is main being busy, which #1334, #1450 and #1451 cover.

## Where a send's time went

`turns.jsonl` records each send's steps (`src/main/agents/sendStages.ts`). Of the sends since 10 a.m. Pacific, 122
took 10 s or more, against 5 in the eleven hours before; the build did not change at that boundary. Across those 122
(102 Claude, 19 Codex, one Muse) the mean was 19.0 s: admission 1.1 s, the read before the send 1.9 s, preparation
11.4 s (60%), the adapter 0.6 s, acknowledgement 3.2 s and first output 1.2 s. Acknowledgement is Claude Code
echoing the prompt back, which Sotto reads on main; first output is where Anthropic's reply shows. Every step Sotto
owns grew by the same three to seven times from that hour, for Claude and Codex alike, for sends and wake-ups, and
after a restart.

Preparation was timed step by step with logpoints in the running main process, which never paused it, for 35
minutes: 21 sends. The steps between two awaits that do nothing themselves took 0 to 4 ms when main was quiet and 200
to 750 ms when it was not. Main's event loop lost 23% of the time to lag while it was sampled. Of 58 s of preparation
across 14 sends in the second half, the checkpoint taken before each send was 30 s: walking the working copy
17.0 s, saving the record 9.9 s, settling the previous turn's checkpoint 2.4 s and reading the thread 0.6 s. The
rest was Claude Code starting a session on two first sends (11.6 s), taking its snapshot (3.8 s) and smaller steps.

Every one of those checkpoints was refused. 298 of the last 300 saved were unavailable: the checkout, Sotto's own
or a worktree of it, is over the 64 MiB limit (7,509 files and 533 MiB as Git lists them, the seven largest
over 64 MiB together), or Git cannot list the folder. A size verdict is held while nothing that decided it moves (ADR-0027), but a
thread's agent commits and stages in its worktree between sends, so the verdict was held for 3 of the 21 sends. Each
of the other 18 listed the folder, then `lstat`ed every listed file and directory, 32 at a time, and started two more
Git commands, only to refuse it. With main busy, each batch of 32 waits a turn of the event loop, so a walk that takes
0.3 s when main is idle took up to 5.5 s.

The save's occasional 1.1 to 6.3 s is the journal's `fsync` waiting on a busy disk; it is not changed here.

## What changed

A size verdict that stops holding now leaves behind the files that put the folder over: the file over the per-file
limit, or the largest files that alone exceed the total, however many. The next capture lists the folder as before. While that fresh listing still names all of them and they still put the folder over as regular files, the
folder is refused from them, before Git's state is read or anything else is sized. A walk of every file could only
refuse such a folder too, though it might name a link it reaches first rather than the size. Anything else, a file
gone, shrunk, ignored or no longer a regular file, walks the whole folder as before.

## How it was measured

`tests/perf/checkpointSend.perf.test.ts`, with `SOTTO_PERF_CHECKPOINT_BASE` set to `origin/main` (`2e15bd8a1`) as
"before". It gains a copy shaped like Sotto's checkout: 7,000 files of 4 KiB in 280 folders and nine of 7.5 MiB,
committed, with an empty commit after each turn so that no verdict holds. `lstat`s are now counted too. Three runs
each, six sends a run; "later sends" is the median and range of the fifteen after the first.

| Working copy | Later sends, before | Later sends, after | `lstat`s a later send, before / after |
| --- | ---: | ---: | ---: |
| A few large files over the limits, a commit each turn | 328 ms (296-509) | 96 ms (91-116) | 7,350 / 28 |
| The same, with the event loop busy 20 ms a turn | 10,535 ms (10,394-10,679) | 456 ms (439-524) | 7,350 / 28 |
| Over the limits, a commit each turn (3,000 files of 32 KiB) | 224 ms (200-374) | 128 ms (124-205) | 3,331 / 2,059 |

The last copy takes its 2,049 largest files to exceed the limit, so a later send sizes those, not all 3,000 and their
folders. The busy row is from an earlier run; nothing on this copy's path has changed since. `SOTTO_PERF_CHECKPOINT_BUSY_MS=20` keeps each
process's event loop busy for 20 ms at every turn, close to what the live walk's times imply for main.

The first send into a folder still walks it whole, and a folder Git cannot list is still asked again on every send,
as ADR-0027 decided.
