# What a send pays for its checkpoint - October 5, 2026

Issue #764, part of #762. Every send takes a file checkpoint before the provider hears the prompt. On `origin/main`
(`e8a82a03`) the send hook read the whole thread again, settled the last turn's checkpoint twice, then walked the
working copy one file at a time: `git ls-files`, an `lstat` of every path component, a `realpath`, a read, a hash
and a backup write for each file until 10,000 files or 64 MiB, then two more Git commands and a rewrite of the
whole `checkpoints.json`. On the development machine 981 of the 987 saved checkpoints were unavailable: 754 over the
size limit, 220 in folders Git does not know, 3 out of memory. The work was almost always thrown away.

The decision (Zach, October 5): keep the limits and make the capture cheap. What changed, in short (ADR-0027's
October 5 amendment has the whole of it):

- The hook takes the checkpoint from the thread the coordinator has just read, and settles the last turn once.
- Every file is `lstat`ed and the limits checked before any is read; each directory is checked once; reads run
  eight at a time.
- A file whose size, times, inode and mode match the folder's last snapshot keeps the hash recorded then, unless
  its times were within three seconds of that snapshot or its backup is gone.
- A folder that could not be captured keeps that verdict while Git's `HEAD`, reflog and index size and the folder's
  own listing stay as they were. Holding it costs a few `lstat`s and no Git command.
- A send appends its record to `checkpoints.journal` instead of rewriting `checkpoints.json`.

## How it was measured

`tests/perf/checkpointSend.perf.test.ts` bundles `tests/fixtures/checkpointSendBench.ts` twice with esbuild: once
against `src/` as of `e8a82a03` ("before") and once against this branch ("after"). Each run is a fresh Node process
that opens a `CheckpointService` on an empty checkpoint folder, then sends six turns into one working copy: the
service's `beforeTurn`, as the send hook calls it, then a new user message and `afterTurn`, as the completed-turn
hook calls it. It times both, counts the working-copy files whose contents were read, and notes whether
`checkpoints.json` was rewritten. Three runs each, alternating which goes first. "First send" is the median of the
three first sends; "later sends" the median and range of the other fifteen.

The working copies:

- **Under the limits**: 2,000 files of 4 KiB (7.8 MiB) in 280 folders, committed. Once unchanged between turns, once
  with one file rewritten in each turn.
- **Over the limits**: 3,000 files of 32 KiB (94 MiB), committed. Once more starting from a synthetic
  `checkpoints.json` of 1.5 MB (1,000 unavailable checkpoints and five completed ones of 1,000 files each), the
  size of the file on the development machine.
- **Not a Git repository**: 200 files of 1 KiB with no `.git`.
- **This repository**: the branch's own checkout, 4,552 files and 324 MiB as Git lists them (tracked files and
  untracked ones it does not ignore), so over the size limit.

The copies were made and then left for 3.5 s before the first run, so that no file is younger than the three
seconds within which a snapshot does not trust its times.

## Before and after

The checkpoint taken before each send, which the send waits on:

| Working copy | First send, before | First send, after | Later sends, before | Later sends, after | Files read a later send, before / after |
| --- | ---: | ---: | ---: | ---: | ---: |
| Under the limits, unchanged | 4,625 ms | 1,047 ms | 2,992 ms (2,413-3,574) | 118 ms (104-171) | 2,001 / 0 |
| Under the limits, one file edited a turn | 3,867 ms | 1,113 ms | 2,775 ms (2,330-3,140) | 132 ms (109-200) | 2,001 / 1 |
| Over the limits | 5,886 ms | 201 ms | 9,047 ms (5,156-10,525) | 1.9 ms (1.6-3.2) | 2,048 (64 MiB) / 0 |
| Over the limits, 1.5 MB of saved checkpoints | 4,825 ms | 185 ms | 4,586 ms (3,357-6,900) | 3.9 ms (3.5-6.8) | 2,048 (64 MiB) / 0 |
| Not a Git repository | 82 ms | 131 ms | 78 ms (66-117) | 2.5 ms (1.7-3.8) | 0 / 0 |
| This repository | 1,824 ms | 250 ms | 2,432 ms (1,831-3,147) | 1.9 ms (1.5-4.0) | 605 (64 MiB) / 0 |

The checkpoint taken when a turn completes, which no send waits on unless the next one arrives first:

| Working copy | Later turns, before | Later turns, after | Files read, before / after |
| --- | ---: | ---: | ---: |
| Under the limits, unchanged | 3,038 ms | 158 ms | 2,001 / 0 |
| Under the limits, one file edited a turn | 2,797 ms | 163 ms | 2,001 / 1 |

Over the limits and outside Git a turn has no capturing checkpoint to complete, before and after, so its
completion costs nothing either way.

`checkpoints.json` was rewritten on every send before, and on none of the later sends after: each send appended one
line to the journal. Over 200 sends in `tests/unit/main/checkpointSendCost.test.ts` the journal is folded into the
file only when it has outgrown it, which that test bounds at fewer than 20 rewrites.

What the issue asked for:

- **Over the limit, every send after the first under 50 ms and no file read**: 1.9-6.8 ms and none, on the synthetic
  copy, with the development machine's file size, and on this repository.
- **Under the limit, nothing changed since the last snapshot, no file contents read**: none. What remains, about
  110 ms, is the three Git commands every snapshot runs (`ls-files` for the file list, `ls-files --stage` and
  `rev-parse HEAD` for the record) and 2,000 `lstat`s. A file edited in the turn is read once by the completion
  snapshot and once more by the next send's, because it was written within three seconds of the first.

## What these numbers are not

- They are the `CheckpointService` alone, with a thread resolver that answers at once. In the app the hook also
  asked the workspace to read the whole thread from its provider before every send; that read is gone and is not in
  either column. What it cost depends on the provider and the thread; for Codex a whole read was 48-902 ms at 50 to
  500 turns (`2026-09-26-codex-send-read.md`). The first send after Sotto starts also asks Git for the folder's
  checkout and its Git directory, which later sends do not.
- A held verdict is checked against Git's `HEAD`, reflog and index size and the folder's top-level listing. A copy
  that falls under the limits only through untracked or unstaged changes deeper down keeps its verdict until one of
  those moves or Sotto restarts. That costs a checkpoint, never a wrong revert, and the benchmark does not exercise
  it; `tests/unit/main/checkpointCapture.test.ts` does.
- Taken on the Windows development machine (Intel Core Ultra 9 275HX, Node v24) while another agent's build and test
  runs shared it, which is why the "before" ranges are wide and why this repository's "before" is slower than the
  0.5-0.8 s the issue measured for a copy of the loop alone: these runs also write each file's backup and rewrite
  the checkpoint file. Read them as sizes, not budgets. Nothing asserts a time.
- The synthetic copies are filler of fixed sizes, not measured from real projects.

## Re-run

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/checkpointSend.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

`SOTTO_PERF_CHECKPOINT_ONLY` runs only the copies whose names contain it (for example `"this repository"`),
`SOTTO_PERF_CHECKPOINT_REPO` points "this repository" at another checkout, and `SOTTO_PERF_CHECKPOINT_BASE` names
another "before" commit.
