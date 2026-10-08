# GitHub calls before and after asking within the rate limit - issue 820

October 7, 2026, Windows 11, Git 2.53.0, gh 2.89.0. Issue #820 changed how often Sotto asks GitHub, through `gh` on
the user's own sign-in, about the pull requests of the branches it shows (ADR-0027, October 7 amendment). This note
counts the gh processes before and after over the same simulated span, says how they were counted, and records the
two GraphQL documents checked against GitHub itself.

## How it was measured

The figures are counts of gh processes the status reader starts, taken by a counting fake rather than a stopwatch.
`tests/unit/main/gitStatusGitHub.test.ts`, "gh calls for ten threads on ten branches over one hour with the window in
front", builds ten worktrees of one repository, each on its own pushed branch, with Git and gh both scripted: every
`git` command answers from a table and every `gh` command is recorded and answered as GitHub would. It then does what
the workspace timer does at the default Git fetch interval of 30 seconds with the window in front, 120 times, the
simulated clock moving 30 seconds each time: for every thread at once, a local read, the remote half as a background
read, and the read that takes what it brought. Nothing else asks GitHub in it, and no rate limit is reached.

The before figures come from the same simulation, run against the status reader at `90536557c` (this branch's base:
`origin/main` with the study committed) before any of #820's code, its scripted gh answering `gh pr list --head` the
way it answered on that code. The after figures are the test's assertions, run with `npx vitest run
tests/unit/main/gitStatusGitHub.test.ts` on the branch's final code.

The Pull request surface's figures are what `tests/unit/main/gitPullRequests.test.ts` asserts over its scripted gh
("reads ... in one query" and "reads GitHub once after a press"), and for before, what the same file asserted at
`90536557c` (`gh pr view`, then `gh api graphql`, for every read).

## Ten threads on ten branches, one hour, window in front

| What GitHub has | Before (gh processes) | After (gh processes) | After, branches asked about |
| --- | ---: | ---: | ---: |
| An open pull request on every branch | 600 | 60 | 600 |
| No pull request on any branch | 600 | 12 | 120 |
| Open pull requests on five, none on five | 600 | 60 | 360 |

Before, each branch was one `gh pr list --head <branch>` a minute, whatever GitHub answered: one gh process and about
one GraphQL point each, 600 points an hour of the sign-in's 5,000. After, the ten branches are one `gh api graphql`
query, which GitHub charges as one point, so the points follow the process count: 60 an hour at most. A branch with an
open pull request is asked about every minute and one with none every five, so with five of each the five without ride
along in the same query every fifth minute; a merged or closed answer is kept fifteen minutes or until the branch moves.

The process count stays the same for up to 25 branches of one repository, since 25 heads go in one query (thirty
branches are two queries, which the same file asserts), and each further repository adds its own query.

## The Pull request surface

| Moment | Before (gh processes) | After (gh processes) |
| --- | ---: | ---: |
| Opening it, or Refresh | 2 (`gh pr view`, then `gh api graphql`) | 1 (`gh api graphql`) |
| A press such as Merge, with the read that settles it and the window's read after it | 5 (the press, then two reads of two each) | 2 (the press, then one read; the window's read is answered by it) |
| The same, the repository's merge methods asked again | every read | at most every 15 minutes per repository |

The branch toolbar's own lookup after a press is asked again as before, now in the batched query.

## Settings saves

With the worktree cleanup's merged rule or Auto-settle merged threads on, every settings save swept worktrees and asked
GitHub about each candidate branch. A save that changes neither the cleanup rules nor Auto-settle merged threads now
asks nothing; `tests/unit/main/worktreeCleanup.test.ts` asserts it.

## The two queries against GitHub

Both GraphQL documents were run once by hand through `gh api graphql` against `millZach/Sotto`, read-only, before the
code used them, to check that GitHub accepts them as written: the batched head lookup with two heads passed as
variables, and the Pull request surface's read of an open pull request. GitHub answered both, charged one point each,
and accepted `refs/pull/<number>/head` as the head of the comparison, giving the same distance as the branch's own
name. No answer was saved. The rate-limit paths (a refused answer, a low reading, the pause) were not provoked against
GitHub; the tests in `tests/unit/main/gitStatusGitHub.test.ts` and `tests/unit/main/github.test.ts` cover them over a
scripted gh.
