# Git on a send's path - October 6, 2026

Issue #766, part of #762. A send waited on Git twice before the provider heard the prompt. First, the workspace host
ran every read of a thread's folder in that thread's own order of work, so a send queued behind a background Git
status read, and a remote read can start with a `git fetch` (up to five seconds) and a `gh` question. Second, the
send inspected its own folder with Git: `ThreadWorktrees.inspect` and the checkout guard's identity lookup.

The issue's references had moved by the time this was built; on `origin/main` (`e8a82a03`) the lane is
`workspace.ts:648` (`gitActionFinished`) and `:659` (the timer), the send's lane is `execute` at `:2054`, the folder
check is `threadWorkingDirectory` at `:2024` called from `:2243`, and `recordSentBranch` is `:2015`. `gitStatus.ts`
still fetches at `:331`. What they do was as the issue says, with one addition: reserving the checkout for the send
(`checkoutMutations.acquire`) ran `git rev-parse --show-toplevel` too.

## What changed

- Reads of a thread's folder that change nothing in it run in a status lane of their own beside the thread's lane:
  the timer's reads, the read after a Git action, a thread coming into view, the re-read after a turn, and a refresh
  of a folder that is there (the refresh a draft starts). A send never waits for one. A read's answer lands only on
  the folder it read, and a thread's reads run one at a time, so an older answer never lands over a newer one.
  Automatically pull still runs in the thread's lane, because it changes the folder. The coordinator runs a refresh
  outside its own thread lane, so a send pressed during one is not held there either.
- A send to a ready folder checks it from the checkout's own files (`ThreadWorktrees.readyOnDisk`) and reads its
  branch from HEAD. Git's own inspection runs once the prompt is out and corrects the record; a folder Git will not
  confirm makes the next send inspect with Git first. Anything the files do not settle takes the old path.
- The checkout guard finds the checkout root from the `.git` entries on disk, the way Git's discovery does, and
  asks Git only when they leave it open.

## How it was measured

`tests/perf/gitOffSendPath.perf.test.ts` drives the real workspace host over a real repository with an origin, real
Git and the fake provider. It makes one thread, sends once so its working copy is set up, and then times nine more
sends from `execute` to the moment the fake provider is handed the prompt, idle between sends and with the inspection
the previous send owes finished (a refresh of the folder waits behind it in the status lane), so each sample is one
send alone. It counts every `git` process started in that window through `spawn`, `execFile` or their sync forms
(`tests/fixtures/gitSpawnCounter.ts`, which the default-run test in `tests/integration/workspaceSendGit.test.ts`
shares with it, with the repository and the timed send in `tests/fixtures/sendGit.ts`). Three cases:

- a thread on its own ready worktree;
- a thread in the shared project folder;
- a worktree thread whose refresh (the one a draft starts) has left its remote status read in a `git fetch` scripted
  to take two seconds; five sends, each made once the fetch has begun.

"Before" is `workspace.ts` and `threadWorktrees.ts` as they are on `origin/main` (`3bc5efa1`), the only source files
this change touches under the workspace host, under the same benchmark; "after" is this change. Each figure is the
median of a run's sends, and each range is across three runs.

| Case | Send to provider, before | Send to provider, after | Git processes before the provider heard it, before / after |
| --- | ---: | ---: | ---: |
| Ready worktree | 250-366 ms | 7.7-9.1 ms | 6 / 0 |
| Shared project folder | 230-237 ms | 3.5-4.2 ms | 4 / 0 |
| Worktree, status read in a two-second fetch | 2,475-2,667 ms | 7.8-8.9 ms | 11 (up to 13) / 0 |

The before and after runs were taken back to back, while another agent's test runs shared the machine. The first
version of this note, against `e8a82a03` and with the held read started from the Changes panel's hook rather than a
refresh, measured 130-210 ms, 112-210 ms and 2,314-2,533 ms before and 5.5-11.9 ms, 3.4-4.5 ms and 5.0-8.4 ms after,
with the same counts for the first two cases and 13 for the third.

Before, a worktree send started `git rev-parse --show-toplevel` to reserve the checkout and then `inspect`'s five:
the common-directory lookup, then `rev-parse --show-toplevel`, the second common-directory lookup and
`worktree list` together, then `status --porcelain`. A project-folder send started `rev-parse --show-toplevel` for the
reservation and `rev-parse --show-toplevel`, `branch --show-current` and `status --porcelain` for `inspect`. Behind the
fetch, the send waited for the fetch and for the rest of the status read after it before its own six: seven more
processes for the status, the line counts, the default branch, the distance from it and whether the branch was
pushed, of which the refresh's read had usually started one or two before the send began. The benchmark answers `gh` with a refusal, so the pull request lookup that follows in the app is not in it.

After, none of those runs before the prompt. What is left of a send in these figures is the workspace host's own
work and the provider hosts between it and the fake; the file reads that replaced the Git processes are fewer than
twenty `stat`, `realpath` and `readFile` calls for a linked worktree, and fewer for a project folder. Git's own inspection of the folder still happens
for every such send, once the prompt is out.

## What these numbers are not

- The provider is the fake one, and the workspace host is driven directly; the coordinator, the checkpoint taken
  before a turn (#764) and an adapter's own reads before it writes the prompt (#765) are outside these figures. That
  the coordinator lets a send past a refresh is shown by `tests/unit/main/agentCommandLanes.test.ts`, not timed. The
  full send-to-first-words figure is #763's benchmark.
- The fetch is scripted to take two seconds and touches no network. A real fetch takes what the remote takes, up to
  the five-second deadline, and a `gh` lookup after it can add more; before this change a send waited for all of it,
  and after it waits for none of it.
- A send still waits for a Git action or an automatic pull that has begun on its folder, as it always has: those
  change the folder, and the checkout guard refuses or holds a send while they run.
- The repository is a one-commit fixture in the temporary folder. `git status` in a large repository takes longer,
  which made the old path slower there and changes nothing in the new one.
- Taken on the Windows development machine (Intel Core Ultra 9 275HX, Node v24.14.1, Git 2.53.0.windows.2) while
  another agent's tests ran on it. Read them as sizes, not budgets. The default test run asserts the process counts, not
  the times (`tests/integration/workspaceSendGit.test.ts`).

## Re-run

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/gitOffSendPath.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

For the "before" figures, check out `src/main/agents/workspace.ts` and `src/main/agents/threadWorktrees.ts` from
`3bc5efa1` and run the same command; the benchmark uses only the public host API both versions have.
