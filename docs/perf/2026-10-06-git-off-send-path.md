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

- Only the slow half of a status read leaves the thread's order of work: the `git fetch` and the GitHub lookup. They
  run outside it, in the repository's common Git directory rather than the thread's folder, and a local read in the
  thread's order then takes what they brought and decides Automatically pull. Every local read, Git's inspection of
  the folder after a send, a turn or a refresh, and every write to the worktree record stay in the thread's order with
  its sends, as before. A send never waits for a fetch or a GitHub lookup; it may wait for a local read or an
  inspection already under way.
- A send to a ready folder checks it from the checkout's own files (`ThreadWorktrees.readyOnDisk`) and reads its
  branch from HEAD. Git's own inspection runs once the prompt is out, behind the send in the thread's order, and
  corrects the record; a folder Git will not confirm makes the next send inspect with Git first. Anything the files
  do not settle takes the old path.
- The checkout guard finds the checkout root from the `.git` entries on disk, the way Git's discovery does, and
  asks Git only when they leave it open.

An earlier version of this change moved every read and inspection of the folder beside the thread's order, so a send
waited for none of them. Review found races that overlap opened (ADR-0027's #766 amendment says which), and the
reads went back into the thread's order. The fourth case below is what that costs.

## How it was measured

`tests/perf/gitOffSendPath.perf.test.ts` drives the real workspace host over a real repository with an origin, real
Git and the fake provider. It makes one thread, sends once so its working copy is set up, and then times sends from
`execute` to the moment the fake provider is handed the prompt, idle between sends. It counts every `git` process
started in that window through `spawn`, `execFile` or their sync forms (`tests/fixtures/gitSpawnCounter.ts`, which
the default-run test in `tests/integration/workspaceSendGit.test.ts` shares with it, with the repository and the
timed send in `tests/fixtures/sendGit.ts`). Four cases:

- a thread on its own ready worktree, nine sends, each made once the inspection the previous send owes has finished
  (a refresh of the folder waits behind it in the thread's order), so each sample is one send alone;
- the same for a thread in the shared project folder;
- a worktree thread whose refresh (the one a draft starts) has left the remote half of its status read in a
  `git fetch` scripted to take two seconds; five sends, each made once the fetch has begun;
- a worktree thread whose refresh has just begun, so its Git inspection of the folder is under way when Send is
  pressed; nine sends.

"Before" is `workspace.ts` and `threadWorktrees.ts` as they are on `origin/main` (`3bc5efa1`), the source files under
the workspace host this change touches besides the status reader, under the same benchmark; "after" is this change.
Each figure is the median of a run's sends, and each range is across three runs, taken back to back.

| Case | Send to provider, before | Send to provider, after | Git processes before the provider heard it, before / after |
| --- | ---: | ---: | ---: |
| Ready worktree | 206-331 ms | 6.3-8.6 ms | 6 / 0 |
| Shared project folder | 157-298 ms | 2.6-4.0 ms | 4 / 0 |
| Worktree, remote half in a two-second fetch | 2,500-2,615 ms | 5.6-8.8 ms | 11 (up to 13) / 0 |
| Worktree, Send pressed as a refresh begins | 527-590 ms | 189-301 ms | 11 / 5 |

The earlier version that read the folder beside the thread's order measured 7.1-8.0 ms and no Git processes for the
fourth case, against which the 189-301 ms here is the wait for the refresh's own inspection: its five Git processes
run in the window and count in it. A set of after runs taken just before these, under heavier load from other work
on the machine, measured 7.4-9.1 ms, 4.0-4.8 ms, 8.5-10.5 ms and 210-673 ms. The first version of this note, against
`e8a82a03`, measured 130-210 ms, 112-210 ms and 2,314-2,533 ms before for the first three cases.

Before, a worktree send started `git rev-parse --show-toplevel` to reserve the checkout and then `inspect`'s five:
the common-directory lookup, then `rev-parse --show-toplevel`, the second common-directory lookup and
`worktree list` together, then `status --porcelain`. A project-folder send started `rev-parse --show-toplevel` for the
reservation and `rev-parse --show-toplevel`, `branch --show-current` and `status --porcelain` for `inspect`. Behind the
fetch, the send waited for the fetch and for the rest of the status read after it before its own six: seven more
processes for the status, the line counts, the default branch, the distance from it and whether the branch was
pushed, of which the refresh's read had usually started one or two before the send began. Pressed as a refresh began,
it waited for the refresh's inspection and then made its own. The benchmark answers `gh` with a refusal, so the pull
request lookup that follows in the app is not in it.

After, none of the send's own Git runs before the prompt. What is left in the first three cases is the workspace
host's own work and the provider hosts between it and the fake; the file reads that replaced the Git processes are
fewer than twenty `stat`, `realpath` and `readFile` calls for a linked worktree, and fewer for a project folder. Git's
own inspection of the folder still happens for every such send, once the prompt is out. In the fourth case the send
waits for the refresh's inspection and no longer makes its own.

## What these numbers are not

- The provider is the fake one, and the workspace host is driven directly; the coordinator, the checkpoint taken
  before a turn (#764) and an adapter's own reads before it writes the prompt (#765) are outside these figures. In the
  coordinator a refresh holds the thread's lane while the host does its local work, so a send pressed then waits there
  for the same inspection the fourth case times. The full send-to-first-words figure is #763's benchmark.
- The fetch is scripted to take two seconds and touches no network. A real fetch takes what the remote takes, up to
  the five-second deadline, and a `gh` lookup after it can add more; before this change a send waited for all of it,
  and after it waits for none of it.
- A send still waits for a Git action, an automatic pull, a refresh's inspection or a local status read that has begun
  on its thread, as it always has: those run in the thread's order, and a pull or an action changes the folder, which
  the checkout guard refuses or holds a send for while it runs.
- The repository is a one-commit fixture in the temporary folder. `git status` in a large repository takes longer,
  which made the old path slower there, and makes the fourth case's wait longer in the new one.
- Taken on the Windows development machine (Intel Core Ultra 9 275HX, Node v24.14.1, Git 2.53.0.windows.2) while
  other agents' work ran on it. Read them as sizes, not budgets. The default test run asserts the process counts, not
  the times (`tests/integration/workspaceSendGit.test.ts`).

## Re-run

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/gitOffSendPath.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

For the "before" figures, check out `src/main/agents/workspace.ts` and `src/main/agents/threadWorktrees.ts` from
`3bc5efa1` and run the same command; the benchmark uses only the public host API both versions have.
