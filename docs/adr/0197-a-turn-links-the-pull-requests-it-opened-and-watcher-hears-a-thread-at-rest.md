# A turn links the pull requests it opened, and Watcher hears when a watched thread rests with one open

## Status

Accepted November 6, 2026. Fixes #2307. Amends [ADR-0027](0027-git-the-way-t3-code-does-it.md)'s **Linked pull requests** and [ADR-0073](0073-watcher-coordinates-threads-with-its-providers-own-tools.md)'s **Watcher news**. Straight to stable: a fix to Watcher, not a new feature.

## Context

Watcher learns about a watched thread's pull requests only from two records on that thread: the pull requests linked to it (`pullRequests`) and its branch's own (`worktree.git.pullRequest`). read_state's `pullRequests`, the merge queue, the background pull request reads (ADR-0144) and all pull request news start from them.

On November 6, 2026, five lanes on forge had opened six pull requests between them (#2262, #2264, #2267, #2270, #2272), and read_state showed `pullRequests: []` for every one. forge's record had no links and `pullRequest: null` for each branch. Two gaps:

- **The branch's pull request is asked of GitHub only for an open thread.** The status timer reads the threads a window has open (`pollGitStatus`), and a Git action Sotto runs reads its own. A lane nobody opens, which pushes and runs `gh pr create` from its own shell, is never asked about.
- **A lane can open a pull request from another branch.** Lane B worked in a worktree on `sotto/keep-state-diff-read-state-filter` and opened #2262 and #2267 from two other branches. Its branch could never name them.

A second gap sat behind the first. A watched thread whose turn ended with CI still running sends no news later. Watcher has no timer of its own, and quiet news covers only a thread whose work is still running, so the thread waited until the user noticed.

## Decision

**1. A turn's end links the pull requests it opened, as created from the thread.** As a thread's turn ends, its host reads that turn's records and reply:

- the URLs that a `gh pr create` the turn ran printed, in its output or error, are the pull requests it opened, or the one that already existed for its branch;
- a GitHub pull request URL its reply names counts only if GitHub says that pull request was opened during the turn, from two minutes before its start for clock drift on. A reply that cites another lane's pull request, or an old one, links nothing.

Each is read through `gh` first, as **Link pull request** reads one, and linked with the source `created`, which the Pull request surface already shows as **Created from this thread**. It adds no source, so no host or client changes its schema. At most five URLs are read per turn, and a pull request already linked is not read again. Only the newest turn's records and reply are read, never the thread's history. Watcher's own threads and council judges link nothing.

**2. A turn's end asks GitHub for its branch's own pull request.** A thread on a pushed branch other than the default, with a remote, has the remote half of its status read as the timer's background read, under the same rules: a fresh answer is not asked again, and the rate-limit reserve and pause hold (#820). It runs off the update path and outside the thread's lane.

**3. The pull request read names when it was opened.** `createdAt` joins the pull request detail as an optional field, which an earlier host or client leaves out or ignores.

**4. At-rest news.** A watched thread at rest for twenty minutes (`WATCHER_AT_REST_MS`, quiet's twenty minutes) with a pull request of its own still open brings Watcher one news line, `at-rest`. At rest means connected, a turn has ended, nothing is running, no sub-agent is working, no work is unknown and nothing waits on the user. The twenty minutes run from the thread's last progress, as quiet's do. The line says the thread is at rest with a pull request open, and its detail lists each open pull request with how its checks stand.

It is told once for each state: the newest turn, and each open pull request's head and whether its checks have finished. The same state is not told again, after a restart too, since the event's ID is that state. A new turn, a new head or checks that finish while the thread still rests is a new state, told once more. News that stops being true before it goes, because the thread began a turn or its pull request merged, does not go. A thread that never ran a turn brings none.

It is ordinary news (the twenty-second batch) and a wake, alongside quiet in #2226's set of news Watcher must act on. Its words grant nothing and approve no merge.

## Consequences

- read_state, the merge queue and pull request news cover a lane's pull requests from the end of the turn that opened them. A lane that opened one before this change is found by its branch at its next turn's end. One opened from another branch before this change stays unlinked until Watcher or the user links it.
- The Pull request surface lists those pull requests under **Linked pull requests** as **Created from this thread**, the same as one the Git action made.
- A turn that runs `gh pr create`, or names a new pull request in its reply, makes one more `gh` read per pull request at its end. A turn on a pushed branch may make one batched branch lookup and one fetch, both kept fresh as the timer's are.
- Two lanes that open pull requests at the same moment can each name the other's in a reply and both be linked to it. That needs the reply to cite a pull request opened during its own turn, which is rare, and **Unlink from thread** undoes it.
- At-rest news says nothing of a thread at rest with no pull request open, however much its reply says it has still to do, or of a workflow-dispatch run (#2260). Those need a signal Sotto can read, which this change does not add. A watched thread whose turn failed is #2234's **work left** (PR #2264), which restarts it; at-rest news is for a turn that ended and left a pull request waiting.
