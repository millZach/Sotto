# Worktree origin fetch investigation

## Incident evidence

Read-only inspection of `~/Library/Application Support/sotto/workspace.json` found two Sotto-project threads with the reported origin-fetch error and no allocated folder: `0c3dd351-c618-441b-8b75-0cacfed4ec75` and `f1008b74-f199-4ffc-8218-53d07311fb75`. Their failed sends in `turns.jsonl` started at 17:32:22 and 17:33:25 Phoenix time on November 5, and lasted 30,197 ms and 49,832 ms. The first duration is consistent with the runner's 30-second deadline. The second can include waiting on an early fetch before the send's own fetch. Neither record retains Git stderr, the command stage or the timeout flag, so those timings do not prove which Git command failed or why.

The install log records build `0.1.43-owl.20261105.3` installed at 17:22:11. No evidence establishes a causal connection to the relaunch. A current read-only `ls-remote` with `nativeEnvironment()`'s allow-list and the runner's Git environment succeeded in 1.11 seconds; with the system-only PATH it succeeded in 0.90 seconds. The historical process environment is unavailable.

Follow-up evidence supplied by the user comes from other services on the same Mac: one logged `[Errno 8] nodename nor servname provided, or not known` from 17:28:24 to 17:39:05, and another logged `fetch failed` every 30 seconds from about 17:27 to 17:38. A third check at 17:41 succeeded. Both failed sends fall inside this window, and their 30,197 ms and 49,832 ms durations fit Git hitting its 30-second deadline during a DNS outage, with the longer send potentially waiting on an early fetch too.

The incident was most likely a local DNS outage on the Mac. This is an inference from those logs and the send timings, not direct proof from Git, whose stderr was not kept. The collision below is a separate defect, reproduced and fixed here, and was probably not what caused this incident.

## Reproduced defect

In a temporary local repository, clone its old `main`, add a linked worktree, then advance the source's `main`. Run these concurrently from the clone and linked worktree, with `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0` and `GIT_OPTIONAL_LOCKS=0`:

```sh
git fetch --quiet --no-tags --no-write-fetch-head origin
git fetch --no-tags --no-write-fetch-head origin refs/heads/main:refs/remotes/origin/main
```

On the first attempt, the background command exited 0 and the targeted command exited 1:

```text
error: cannot lock ref 'refs/remotes/origin/main': is at 1cc1672763ceb4f74568bf9d9db54620916c28a6 but expected 141f9d28d97380d25607ff5597f7e38e2a3ef925
! 141f9d2..1cc1672 main -> origin/main (unable to update local ref)
```

The two production paths have separate fetch coordination. Retrying only a failure to lock this exact selected ref handles both a ref that another fetch moved and a lock file that another fetch still holds, without changing either fetch service's queue or weakening the requirement for a successful origin fetch. A stale lock still fails after three attempts. This separate defect was probably not the historical incident's cause.

## Retry inspection

`trackOriginFetch` deletes rejected entries. `resolveOriginBase` waits for an early fetch and makes a new request after failure. `updateThreadWorktree(..., true)` calls setup again for a failed thread that has not started its provider session. Both renderer buttons use `useWorkingCopyAction`, whose `finally` clears the busy state. The popover's Refresh checks state; the separate Retry setup button performs setup. A screenshot of Checking alone does not establish a stuck promise. No retry or UI behavior was changed.

## Verification scope

`node node_modules/vitest/vitest.mjs run tests/unit/main/threadOriginFetch.test.ts` passed all nine tests. The focused file covers collision recovery with both moved-ref and existing-lock-file wording, bounded attempts, another-ref refusal, connection/credential refusal at both stages, missing remote branches, failed-cache eviction, persisted timeout stderr and real child-process stderr. `npm run typecheck` passed, and ESLint passed on the two changed TypeScript files. No app was launched; full CI, Playwright, design gates and a packaged-app reproduction are intentionally not run. The original incident is most likely explained by the local DNS outage inferred above; a recurrence can now supply Git's own diagnostic.
