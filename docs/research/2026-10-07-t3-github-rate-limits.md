# T3 Code's GitHub rate-limit work and pull request watcher

Studied on 2026-10-07, after Theo wrote that T3 Code had cut its GitHub rate-limit use by over 75%, moved API calls off the `gh` CLI, and rebuilt its pull request watcher. This is a source inspection, not a live T3 test. A clone of `pingdotgg/t3code` was read at [`04ad17425a80484bf323a7d5076bd477a9499119`](https://github.com/pingdotgg/t3code/commit/04ad17425a80484bf323a7d5076bd477a9499119) (main, 2026-10-07) and compared with [`7810fb263f5a92b9d438d1eabf408d2ac705e944`](https://github.com/pingdotgg/t3code/commit/7810fb263f5a92b9d438d1eabf408d2ac705e944), the revision ADR-0027 copied Sotto's Git model from. The merged pull requests' own descriptions were read as well. T3 Code is MIT licensed ("Copyright (c) 2026 T3 Tools Inc."), so code taken from it keeps that notice.

## Finding

The work is about 38 merged pull requests between September 22 and October 7, 2026, and comes down to three things:

1. **A new HTTP layer.** T3 now calls `api.github.com` (REST and `/graphql`) itself. It still uses `gh` to get a token (`gh auth token`). Settings, `GH_TOKEN` and `GITHUB_TOKEN` can also supply one.
2. **A quota guard.** It reads GitHub's own `x-ratelimit-*` headers, with REST and GraphQL as separate quotas.
3. **Aliased GraphQL batching.** Many branches or pull requests go in one query of 1 point, and the new pull request watcher polls through it.

Three parts of the announcement are not in the source as worded:

- **Choosing GraphQL or REST.** Nothing picks between the two by quota at run time. Each operation's API is fixed in code, to whichever is cheaper for it.
- **"Over 75%".** The closest measured figure is [#14673](https://github.com/pingdotgg/t3code/pull/14673): 278 calls became 72 over a replayed 27.6-minute sample, which is −74%. [#16270](https://github.com/pingdotgg/t3code/pull/16270) claims about 90% fewer points for watches, and [#13189](https://github.com/pingdotgg/t3code/pull/13189) about 40% across the fleet.
- **"30 implementations of the PR watcher".** The history shows nine merged watcher pull requests and one closed one. The rest were local.

Most of T3's saving came from code Sotto never copied. At `7810fb26`, T3 ran a sync that read every linked pull request once a minute with `gh pr view`, and a settlement sweep that re-checked every merged or closed thread uncached. [#16321](https://github.com/pingdotgg/t3code/pull/16321) blames a branch lookup that ignored the rate-limit pause for 84,501 warnings over October 4 to 6. Sotto's only background GitHub call is the branch's pull request lookup (ADR-0027 decision 2).

## Moving off the CLI

[#16319](https://github.com/pingdotgg/t3code/pull/16319), [#16320](https://github.com/pingdotgg/t3code/pull/16320), [#16321](https://github.com/pingdotgg/t3code/pull/16321) and [#16322](https://github.com/pingdotgg/t3code/pull/16322), by Julius Marminge, merged together on October 6. `GitHubCredentials.ts` takes a credential in this order:

1. a token saved in Settings, per host
2. `GH_TOKEN` or `GITHUB_TOKEN`
3. `gh auth token --hostname <host>`, with prompts and debug output off and a 10-second timeout

The credential is cached for 5 minutes and dropped on any 401. It is keyed by `host:sha256(token)`, never by the token itself. The only `gh` processes left are `gh auth token`, `gh --version` and `gh auth status`.

That move added problems of its own. Open [#16171](https://github.com/pingdotgg/t3code/pull/16171) reports that a fine-grained token cannot read checks, and GitHub's `FORBIDDEN` then fails the whole detail query. `GitHubApi` traces GraphQL query text and rate-limit headers, though never variables or tokens.

## Quota guard

[`githubQuota.ts`](https://github.com/pingdotgg/t3code/blob/04ad17425a80484bf323a7d5076bd477a9499119/apps/server/src/sourceControl/githubQuota.ts) keeps the latest `x-ratelimit-limit`, `remaining`, `reset` and `resource` per host, resource and credential. Nothing is debited locally, so an ETag 304 drains nothing.

- **Reserve.** Background reads stop below 10% remaining (`RESERVE_RATIO = 0.1`). A read or write the user asked for may spend down to the last point (`allowReserve`).
- **What counts as rate-limited:** HTTP 429; a GraphQL `RATE_LIMITED` error; errors while `remaining` is 0; a message matching `/rate limit (already )?exceeded/`; a 403 with `remaining` 0, a `retry-after` header, or "rate limit" in the body. The last catches secondary and abuse limits.
- **Pause.** The pause lasts until `retry-after`, else `x-ratelimit-reset`, else 30 seconds doubling up to 15 minutes. It covers the whole host for that credential. User requests may pass through a pause, but not an empty quota.
- **Concurrency.** At most 8 requests are in flight per process. There are no automatic retries.
- **Before the rework.** At `7810fb26`, `githubGraphQlBudget.ts` appended `rateLimit { cost limit remaining resetAt }` to every GraphQL read and seeded it from `gh api rate_limit`. That REST endpoint's `graphql` entry disagreed with GraphQL's own `rateLimit` (10 points used against 1,419), so the reserve never held. The `rateLimit` field inside a GraphQL query is the accurate reading ([#14673](https://github.com/pingdotgg/t3code/pull/14673), [#16270](https://github.com/pingdotgg/t3code/pull/16270)).

## Batching

[`buildPullRequestsByHeadQuery`](https://github.com/pingdotgg/t3code/blob/04ad17425a80484bf323a7d5076bd477a9499119/apps/server/src/sourceControl/GitHubSourceControlProvider.ts#L383-L405) writes one aliased `pullRequests(headRefName: $hN, states: $sN, first: N)` per branch inside one `repository(owner:, name:)`, with every head and state passed as a variable rather than written into the query.

- **How many per query.** Interactive lookups gather for 50 ms, up to 50 per query. Background lookups gather for 500 ms, up to 25 per query, because 50 heads took about 10 seconds, which is GitHub's processing limit ([#16760](https://github.com/pingdotgg/t3code/pull/16760)). Either way the query costs 1 point.
- **Head repository.** Rows are filtered by `headRepositoryOwner`, so a fork's branch of the same name is not taken for the repository's own.
- **Caching.** A branch with an open pull request is cached for 60 seconds, and one without for 5 minutes ([#13189](https://github.com/pingdotgg/t3code/pull/13189)). The failure backoff, 20 seconds doubling up to 15 minutes, is unchanged from `7810fb26` and is the same as Sotto's.
- **Summaries.** Pull request summaries batch 25 to a query ([#13198](https://github.com/pingdotgg/t3code/pull/13198)).

## The pull request watcher

[#15057](https://github.com/pingdotgg/t3code/pull/15057), October 3, then eight more. An agent calls `watch_pull_request`, or the user picks **Watch for changes** on the linked pull request. The server then wakes the thread when:

- a check fails (each one as soon as it fails)
- the required checks pass (GitHub's `isRequired`, or every check where none is marked required)
- someone other than the user or the agent comments or reviews, with edits counted ([#15415](https://github.com/pingdotgg/t3code/pull/15415))
- the branch starts to conflict
- the pull request merges or closes, which ends the watch

"A wake is news, not a merge decision": the server finds events, and the agent judges them.

How it works:

- **Where its state lives.** The watch lives on the thread's pull request link and records what the agent was last told, so each change is reported once. The wake and the saved progress commit in one command, which is refused if the watch was stopped meanwhile.
- **How it reads.** It reads every 2 minutes (`SWEEP_MINUTES`). One read per pull request per pass is shared by every thread watching it ([#16208](https://github.com/pingdotgg/t3code/pull/16208)).
- **The fingerprint** ([#16270](https://github.com/pingdotgg/t3code/pull/16270)). Before any expensive read it asks one batched query, at 1 point per 25 pull requests. The answer is a status string (state, mergeable, head commit, check counts by state) and a remarks string (comment, review and thread counts, and the newest edit time).
  - The detail is read only when the status moved or a check is still running.
  - The activity, at about 15 points, is read only when the remarks moved.
  - The activity is read again every 30 minutes anyway (`FINGERPRINT_REREAD_MS`) to catch edits inside review threads.
- **When it ends.** It ends after 10 comment-only wakes in a row (`PULL_REQUEST_WATCH_WAKE_LIMIT`), so a chatty bot cannot loop an agent. It also ends after 8 failed reads in a row (`READ_FAILURE_LIMIT`, rate limits not counted), which wakes the agent with the reason. Settling or archiving the thread ends it too ([#16095](https://github.com/pingdotgg/t3code/pull/16095)), and so does Stop ([#16002](https://github.com/pingdotgg/t3code/pull/16002)).
- **How the thread looks.** A watched thread stays in Working ([#16204](https://github.com/pingdotgg/t3code/pull/16204)).
- **Run-time instructions.** These tell agents to use the tool rather than poll with `gh` or sleep loops.

## Other monitoring fixes

- **Closed pull requests** are read again every 15 minutes. Merged is final. Settled threads stop syncing ([#16762](https://github.com/pingdotgg/t3code/pull/16762)).
- **A rate-limited project** is skipped until its retry time instead of failing every pull request each minute ([#16203](https://github.com/pingdotgg/t3code/pull/16203)).
- **A shell `gh pr merge` or `close`** run by the agent forces a fresh sync when the run ends ([#15024](https://github.com/pingdotgg/t3code/pull/15024)).
- **A detail read that sees a newer state** triggers a sync at once ([#16761](https://github.com/pingdotgg/t3code/pull/16761)).
- **Detail caches** went from 15 seconds to 60, and merged ones to 10 minutes ([#16280](https://github.com/pingdotgg/t3code/pull/16280)).
- **ETag revalidation** of checks (`gitHubConditionalChecks.ts`) is used only for the checks popover. #16270 turned it down for sync and the watcher, because the batched fingerprint already costs 1 point per 25 pull requests.

## What applies to Sotto

Sotto's GitHub calls all go through `gh`, and all are GraphQL underneath. With ten threads on ten pushed branches and the window in front, the branch lookup costs about 400 to 600 points an hour out of 5,000 (`GitStatusReader.pullRequest`, `src/main/agents/gitStatus.ts`).

**Taken, keeping `gh` (#820):**
- the batched head lookup, with the head repository checked
- the 5-minute no-pull-request cache
- a `rateLimit` reading inside the query, with T3's reserve and pause
- per-repository invalidation
- one Pull request surface read

**Not taken:** the move off `gh`. It contradicts ADR-0027 decision 7. It would have Sotto hold a GitHub token, and saving one in Settings would be a second key. After the batching, it would save only a process launch per call.

**Taken as a new feature:** the watcher, filed separately. "Watch" is already a Sotto word (Watched set in `CONTEXT.md`), so it needs a word of its own.
