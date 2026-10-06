# What a send pays for its checkpoint - October 5, 2026

Issue #764, part of #762. Every send takes a file checkpoint before the provider hears the prompt. On `origin/main`
(`e8a82a03`) the send hook read the whole thread again, settled the last turn's checkpoint twice, then walked the
working copy one file at a time: `git ls-files`, an `lstat` of every path component, a `realpath`, a read, a hash
and a backup write for each file until 10,000 files or 64 MiB, then two more Git commands and a rewrite of the
whole `checkpoints.json`. On the development machine 981 of the 987 saved checkpoints were unavailable: 754 over the
size limit, 220 in folders Git does not know, 3 out of memory, and 4 for reasons that come after a capture (one turn
changed Git history, two bindings changed and one overlapped another thread). The work was almost always thrown
away.

The decision (Zach, October 5): keep the limits and make the capture cheap. What changed, in short (ADR-0027's
October 5 amendment has the whole of it):

- The hook takes the checkpoint from the thread the coordinator has just read, and settles the last turn once.
- Every file is `lstat`ed and the limits checked before any is read; each directory is checked once; reads run
  eight at a time.
- A file whose size, times, inode and mode match the folder's last snapshot keeps the hash recorded then, unless
  its times were within three seconds of that snapshot or its backup is gone.
- A folder that could not be captured keeps that verdict while Git's `HEAD`, reflog and index size, the folder's
  own listing, Git's ignore files and the paths behind the reason (the largest files, for a folder over the size
  limit) stay as they were. Holding it costs a few `lstat`s and no Git command.
- A send appends its record to `checkpoints.journal` instead of rewriting `checkpoints.json`.

## How it was measured

`tests/perf/checkpointSend.perf.test.ts` bundles `tests/fixtures/checkpointSendBench.ts` twice with esbuild: once
against `src/` as of `e8a82a03` ("before") and once against this branch ("after"). Each run is a fresh Node process
that opens a `CheckpointService` on an empty checkpoint folder, then sends six turns into one working copy: the
service's `beforeTurn`, as the send hook calls it, then a new user message and `afterTurn`, as the completed-turn
hook calls it. It times both, counts the working-copy files whose contents were read and the `git ls-files`
listings each send ran, and notes whether `checkpoints.json` was rewritten. Three runs each, alternating which goes
first. "First send" is the median of the three first sends; "later sends" the median and range of the other
fifteen.

The working copies:

- **Under the limits**: 2,000 files of 4 KiB (7.8 MiB) in 280 folders, committed. Once unchanged between turns, once
  with one file rewritten in each turn.
- **Over the limits**: 3,000 files of 32 KiB (94 MiB), committed. Once more starting from a synthetic
  `checkpoints.json` of 1.5 MB (1,000 unavailable checkpoints and five completed ones of 1,000 files each), the
  size of the file on the development machine. Once more, on its own copy, with an empty commit at the end of each
  turn, which moves `HEAD` and so turns the held verdict around before every send.
- **Not a Git repository**: 200 files of 1 KiB with no `.git`.
- **This repository**: the branch's own checkout, 4,552 files and 324 MiB as Git lists them (tracked files and
  untracked ones it does not ignore), so over the size limit.

The copies were made and then left for 3.5 s before the first run, so that no file is younger than the three
seconds within which a snapshot does not trust its times.

## Before and after

The checkpoint taken before each send, which the send waits on (run of October 6, after review):

| Working copy | First send, before | First send, after | Later sends, before | Later sends, after | Files read a later send, before / after | Listings in 15 later sends, after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Under the limits, unchanged | 4,391 ms | 1,028 ms | 2,946 ms (2,575-3,458) | 129 ms (109-178) | 2,001 / 0 | 15 |
| Under the limits, one file edited a turn | 5,089 ms | 1,135 ms | 3,454 ms (2,966-4,140) | 139 ms (112-163) | 2,001 / 1 | 15 |
| Over the limits | 7,180 ms | 391 ms | 7,882 ms (6,128-8,703) | 3.4 ms (2.4-5.5) | 2,048 (64 MiB) / 0 | 0 |
| Over the limits, 1.5 MB of saved checkpoints | 8,780 ms | 275 ms | 9,133 ms (6,054-11,612) | 4.9 ms (3.8-6.6) | 2,048 (64 MiB) / 0 | 0 |
| Over the limits, a commit each turn | 7,664 ms | 276 ms | 6,950 ms (5,684-50,148) | 142 ms (123-351) | 2,048 (64 MiB) / 0 | 15 |
| Not a Git repository | 109 ms | 123 ms | 72 ms (63-93) | 9.9 ms (3.2-331) | 0 / 0 | 0 |
| This repository | 2,971 ms | 273 ms | 1,864 ms (1,146-3,698) | 4.7 ms (2.8-20) | 605 (64 MiB) / 0 | 0 |

The checkpoint taken when a turn completes, which no send waits on unless the next one arrives first:

| Working copy | Later turns, before | Later turns, after | Files read, before / after |
| --- | ---: | ---: | ---: |
| Under the limits, unchanged | 2,955 ms | 155 ms | 2,001 / 0 |
| Under the limits, one file edited a turn | 3,379 ms | 162 ms | 2,001 / 1 |

Over the limits and outside Git a turn has no capturing checkpoint to complete, before and after, so its
completion costs nothing either way.

`checkpoints.json` was rewritten on every send before, and on none of the later sends after: each send appended one
line to the journal. Over 200 sends in `tests/unit/main/checkpointSendCost.test.ts` the journal is folded into the
file only when it has outgrown it, which that test bounds at fewer than 20 rewrites.

What the issue asked for:

- **Over the limit, every send after the first under 50 ms and no file read**: 2.4-6.6 ms and none on the synthetic
  copy, with and without the development machine's file size, and 2.8-20 ms and none on this repository, while the
  verdict holds. A send after something turned the verdict around (a commit, a checkout, a reset, a file added to or
  removed from the index, a change at the top of the folder, in its ignore files or in the large files behind the
  reason) lists the folder again: 123-351 ms and no file read in the "commit each turn" row.
- **Under the limit, nothing changed since the last snapshot, no file contents read**: none, for files last written
  more than three seconds before the snapshot that read them. What remains, about 130 ms, is the three Git commands
  every snapshot runs (`ls-files` for the file list, `ls-files --stage` and `rev-parse HEAD` for the record) and
  2,000 `lstat`s. A file edited in the turn is read once by the completion snapshot and once more by the next
  send's, because it was written within three seconds of the first.

## Memory

Each remembered file costs about 0.5 KB in the main process: 515 bytes a file for a map of 100,000 entries with
40-character paths, measured with `process.memoryUsage().heapUsed` around `global.gc()` on Node 24. A folder holds
at most 10,000 files, and at most 50,000 are remembered across the 32 folders used last, so about 25 MB at most.
The oldest folders' files are forgotten first; their verdicts, a few hundred bytes each, are kept.

## What these numbers are not

- They are the `CheckpointService` alone, with a thread resolver that answers at once. In the app the hook also
  asked the workspace to read the whole thread from its provider before every send; that read is gone and is not in
  either column. The resolver the app uses copies the workspace snapshot to find the thread, which neither column
  includes either. What the old read cost depends on the provider and the thread; for Codex a whole read was 48-902
  ms at 50 to 500 turns (`2026-09-26-codex-send-read.md`). The first send after Sotto starts also asks Git for the
  folder's checkout and its Git directory, which later sends do not.
- Taken on the Windows development machine (Intel Core Ultra 9 275HX, Node v24) while another agent's build and test
  runs shared it, which is why the ranges are wide and why the "not a Git repository" row has a 331 ms send that ran
  no listing: four `lstat`s waited on a busy disk. An earlier run of October 6, before the listing count was added,
  had stretches of held sends at 70-370 ms that I could not reproduce in about thirty runs since; the counted run
  above ran no listing on any held send. Read them as sizes, not budgets. Nothing asserts a time.
- The synthetic copies are filler of fixed sizes, not measured from real projects.

## Re-run

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/checkpointSend.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

`SOTTO_PERF_CHECKPOINT_ONLY` runs only the copies whose names contain it (for example `"this repository"`),
`SOTTO_PERF_CHECKPOINT_REPO` points "this repository" at another checkout, and `SOTTO_PERF_CHECKPOINT_BASE` names
another "before" commit.
