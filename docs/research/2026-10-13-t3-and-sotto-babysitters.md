# T3 Code's pull request watcher beside Sotto's babysitter

Studied on 2026-10-13, after babysitting PR #964 told "The required checks passed" before they had, said nothing when they did, and stopped while the laptop was asleep. This is a source reading of both. T3 Code was read at [`e9221e44`](https://github.com/pingdotgg/t3code/tree/e9221e44dadd78126c83d2eeed0b51c25dcf0fb4), its `main` on October 13, and Sotto at `8666f3c6c`, with the installed Owl build `0.1.37-owl.20261011.2` that ran on October 12. Nothing of T3 was run. The October 7 note, [2026-10-07-t3-github-rate-limits.md](2026-10-07-t3-github-rate-limits.md), studied T3 at `04ad17425`; its two errors are corrected there.

## Finding

The two match on cadence, batching and most limits: a pass every two minutes, one aliased GraphQL fingerprint for up to 25 pull requests, detail only when it moved, eight failed passes to give up, ten comment-only wake-ups to stop. They part on how checks are judged, and that is where #964 went wrong.

- **When the pass is news.** Both take the gate as the checks GitHub flags `isRequired`, or every check where none is. T3 sets its "passed" mark from each read (`passed = passedNow`), so a required check seen running or failing takes it back, and the next pass is news again. It also tells the pass again when a required check appears already finished between two reads (`gateGrew`). Sotto set "passed" once per head and never took it back, so after a premature pass the real one was silent.
- **Required checks that do not exist yet.** Both share this flaw. `isRequired` is asked of each check in the rollup, so a required job that has not been created is in neither gate. Sotto's `Gates (Windows)` job waits on all six test shards, so for several minutes after every push only `Package result` and `Desktop result` exist, both green. T3 recovers by telling the pass again once Gates appears; Sotto did not. Neither reads the base branch's rules, which name every required check whether it has started or not.
- **A rerun that fails again.** T3 rebuilds its failed list from each read, so a check seen running again leaves it and a second failure is news. Sotto's list only grew, so a second failure on the same head was never told.
- **Reads that fail.** Both skip rate-limited passes without counting them, count every other failure, and give up after eight in a row. Neither tells a computer that is offline apart from GitHub refusing. T3 keeps its count in memory, so a restart clears it; Sotto keeps it on disk. Sotto's last wake-up said "about sixteen minutes" and pointed at `gh auth status` whatever the cause.
- **News held while the agent works.** T3 refuses to send a wake if the watch changed between its read and its send. Sotto delivered waiting news with no look at the head, and it named no commit, so a pass of the commit before a push read as current.
- **Other differences.** T3 ends a watch on a merge without a word; Sotto wakes the thread. T3 puts the first 200 characters of each comment in the wake; Sotto never does (ADR-0061 decision 7). T3 keeps the thread Working while it watches; Sotto shows Babysitting instead. T3 names the commit in its pass line ("All N required checks passed on <sha>").

## What happened on PR #964

All times UTC, October 12 to 13.

| Time | What happened |
|---|---|
| 22:15 | Push of `444b9cceb`. |
| 22:19 to 22:20 | `Package result` and `Desktop result` pass. Sotto told "The required checks passed (2)". `Gates (Windows)` had no check run yet. |
| 22:22 and 22:27 | `Tests (Windows, 1/6)` and `Gates (Windows)` fail. Both were told. |
| 23:24 | The laptop's Wi-Fi drops. Every `gh api graphql` now fails with a connection error, counted as a failed read. |
| 23:31 to 02:32 | The laptop sleeps. |
| 02:38:34 | The eighth failed read, six minutes after waking, ends babysitting for #964 and #946 together, 21 minutes before Wi-Fi came back. |
| 03:04 to 03:05 | Babysitting is started again. Its first look comes during the rerun: attempt 1's failed Gates has left the rollup and attempt 2's has not been created, so it tells "(2)" again. |
| 03:07:55 | Gates passes. Nothing is told, because "passed" was already set for this head. |
| 04:46 | Merged, after the user noticed. |

## Bot notices

On the last 100 pull requests of `millZach/Sotto`, 190 of Cursor Bugbot's 193 remarks were "Bugbot couldn't run - usage limit reached", and 2 were "This PR is too large for Bugbot to review". Of Greptile's, 64 were "Your trial has ended. Reactivate Greptile to resume code reviews." and 1 said the organisation had "used all 50 credits included in the free plan". Each is 109 to 336 characters. The real reviews were 1 of Cursor's and 20 Greptile summaries of about 6,000 characters. Both bots post from `Bot` accounts, which GraphQL names by `__typename`.

## What Sotto took

The October 13 amendment to [ADR-0061](../adr/0061-a-thread-can-babysit-its-pull-request.md):

- **The rules' list.** The checks read asks `baseRef.rules` for the required checks by name, so the pass waits for every one, an unstarted job included. GitHub answered it for #964 at a cost of 1 point.
- **T3's re-arming.** The pass is told again after a rerun or a failure took it back, and a failure again after a rerun.
- **Offline skips the pass.** A failure to reach GitHub at all is not counted. The give-up names what GitHub kept answering.
- **Waiting news is trimmed.** Check news about a commit the branch has left is taken out as a waiting wake-up goes, and the pass line names the commit.
- **Bot notices are dropped.** A short bot remark that says the bot could not run wakes nobody. Its words are asked by ID and passed nowhere.

Left as T3 has it: a rerun that fails between two passes, never seen running, is still missed. Sotto's wake on a merge stays, because an agent babysitting to merge needs to know.
