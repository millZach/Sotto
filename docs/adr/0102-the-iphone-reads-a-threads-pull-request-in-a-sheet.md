# The iPhone reads a thread's pull request in a sheet

## Status

Accepted by Zach on October 21, 2026 (#1281). **Number provisional until merge:** 0099 is the newest on `origin/main` at the time of writing; recheck before merging (docs/agents/domain.md). It amends [ADR-0061](0061-a-thread-can-babysit-its-pull-request.md) decision 11, which gave phones no babysitting control. It is an Owl feature, `iphone-pull-request-view` ([ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)).

## Context

The iPhone showed a thread's pull request only as a chip under its title: the number and whether it is open, a draft, merged or closed. Reviewing a pull request from the phone meant opening GitHub. The host already answers the `git-pull-request` read the desktop's Pull request surface uses, and phones are offered it, and it already takes `babysit-pull-request` and `stop-babysitting` from any paired client. What the read did not carry was how long each check took and which files changed, both of which a phone reader wants before opening GitHub.

## Decision

**Variant A of the prototype, a sheet from the thread.** Zach picked it on October 21, 2026, from `docs/prototypes/iphone-github-view-prototype.html`, over B (a GitHub tab listing every open pull request across threads and computers) and C (a card under the thread's title that opens in place). The thread page stays as it is. The pull request chip gains a dot for the checks once the phone has read them, failing, running or passed, and a press opens a full-height sheet:

- the pull request's state, number, title, and its branch into its base;
- three lines that say where it stands: the checks rolled up ("1 failing, 1 running, 9 passed"), the review decision and who made it, and whether it merges (conflicts, how far behind its base, or clean);
- **Summary**, its description drawn by the phone's own Markdown reader; **Checks**, each with its state and how long it took or has taken so far, the passed ones folded behind a press while any is not; **Reviews**, each reviewer's latest review that took a side; **Files**, each with its added and removed lines, largest first;
- chips along the top that jump to each part and follow the scroll;
- **Babysit pull request** docked at the bottom, or the babysitting line with **Stop babysitting**, as ADR-0061 says them.

**Read only otherwise.** No merge, close, mark ready or update branch from the phone in this version. A check, a review or the pull request itself opens on GitHub in Safari.

**GitHub is read when the sheet opens, not ahead of time.** The sheet asks the host's `git-pull-request` read with the pull request's URL each time it opens and when pulled to refresh. The phone keeps the last answer in memory only, for the chip's dot, and nothing on disk. Nothing reads GitHub for a pull request nobody opened, so the feature costs the gh sign-in's rate limit only what the user asks for (#820).

**The read gains two optional fields.** Each check run carries `startedAt` and `completedAt` as GitHub records them, null until it has, and a status another service posted names neither. The detail carries `files`, the first hundred changed files with their `additions` and `deletions`, and `changedFiles`, how many it changes in all. Both come from the same one GraphQL query. Both are optional: a client on an earlier build drops keys it does not know, and a host before this answers without them, which the phone reads as not known rather than none. The desktop's Pull request surface does not show them yet.

**Babysitting from the phone follows ADR-0061.** The phone sends the same `babysit-pull-request` and `stop-babysitting` the desktop's surface sends, on a pull request the thread already knows, only to a host that lists `pull-request-babysit`. Like the desktop's press, neither grants anything, so neither needs a `remote-answer` policy record. The phone reads `babysitting` and `babysitEnded` from the thread for the line. Nothing here answers a request on the user's behalf (ADR-0004).

**Gated by a host feature.** The host lists `pull-request-view` only when its own Owl answer turns `iphone-pull-request-view` on, read once at start, on the headless host and on the desktop's phone listener. A phone shown no `pull-request-view` keeps the chip as it was, with no dot and no sheet. Stable shows and starts none of it.

## Considered Options

- **B, a GitHub tab.** One place for every open pull request, but it needs each one's checks and reviews read ahead of time, which spends GitHub's rate limit on pull requests nobody opened, and a fifth tab is tight at 375 points.
- **C, a card in the thread.** Where it stands shows without a press, but it pushes the conversation down and opened it is a long scroll inside a long scroll.

## Consequences

- A pull request is reachable only from its thread on the phone; there is no list of them all.
- The chip's dot shows only after the sheet has been opened once while the phone is running. Before that the chip has no dot, rather than a guess.
- The pull request read asks GitHub for the changed files and each check run's times on every read, the desktop's included. It adds no request and no host.
