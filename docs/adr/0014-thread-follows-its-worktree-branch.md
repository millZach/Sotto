# A thread follows its worktree's branch

Accepted September 18, 2026 after the second thread in one evening stopped accepting messages. Sotto no longer compares the branch checked out in a thread's worktree with the branch it recorded at creation. It records what it sees.

## Context

An independent thread gets its own Git worktree on a fresh `sotto/thread-<id>` branch, and `ThreadWorktrees.inspect` ran before every send. It refused the message whenever the worktree's branch differed from the recorded one: "The working folder or branch no longer matches this thread. Restore its checkout before continuing." The check was written as a safety: never repair a folder destructively, and never send work to a folder that is not the thread's own.

In practice the branch changes for ordinary reasons. An agent creates a `prototype/` or `feat/` branch inside the worktree because that is where it is working, a user switches branches from the Changes panel that Sotto itself offers, or a rebase leaves the worktree detached. Twice in one evening a thread went dark with uncommitted work in its folder, the recovery was a manual `git checkout` of a branch name the user had never chosen, and both times the work being protected was the work being blocked. T3 Code, the reference for the Threads page, records a branch for a thread but never gates a send on it: a send adopts the branch the folder is on and writes it back, the label is read live from the folder, a detached HEAD counts as no branch, and a missing worktree is recreated from the recorded branch before the turn rather than refused.

## Decision

`inspect` refuses only a folder that stopped being the thread's registered worktree: missing, moved, redirected through a link, replaced by a plain directory, belonging to another repository, or locked or prunable in Git's own registry. When the folder is the registered worktree, `inspect` reads the branch from `git worktree list`, records it on the thread, and reports `ready`. A detached HEAD records no branch, and the pane shows the folder instead of a branch name.

The send path in `WorkspaceHost.threadWorkingDirectory` adopts the inspected record when the branch changed, so the pane header and the Tools panel follow a switch on the next send without a refresh.

`ensure`, the creation and repair path behind Retry setup, reuses a registered checkout on whatever branch it has, the same way, so the two paths cannot contradict each other. It still creates only with `-b` on the reserved name, never resets a branch with `-B`, and never removes anything.

## Considered options

- **Keep refusing and improve the message.** The message already said what to do. The problem was that doing it discarded the user's own branch choice and stranded uncommitted work behind a git command.
- **Restore the recorded branch automatically.** A checkout Sotto performs on its own can fail on conflicting changes and, when it succeeds, silently moves the user off a branch they made on purpose. Sotto never switches a branch it did not create.
- **Recreate a missing worktree from the recorded branch before a turn**, as T3 does. Worth doing, but separate: it is a creation path with its own failure cases, and today's `ensure` refuses a branch that is checked out elsewhere. Not part of this decision.
- **Follow the worktree.** Chosen. The `sotto/thread-<id>` branch is a starting point that keeps threads apart; once the user or agent has moved on, the folder's own branch is the truth, and it is what commits, pushes and pull requests from the Changes panel already read.

## Consequences

The recorded branch is descriptive from now on, not a constraint. Anything that renders it must tolerate it changing between sends and being absent for a detached HEAD, which `ThreadWorkingCopy` and the Tools panel already did. Two threads can end up on branches with unrelated names and nothing in Sotto minds. The one guarantee that remains is the folder: a send never goes to a directory that is not the thread's own registered worktree.
