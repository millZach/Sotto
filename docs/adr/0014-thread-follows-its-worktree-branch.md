# A thread follows its worktree's branch

Accepted September 18, 2026, amended twice on September 19, 2026 (a missing folder is put back; a branch switch is said in the pane) after the second thread in one evening stopped accepting messages. Sotto no longer compares the branch checked out in a thread's worktree with the branch it recorded at creation. It records what it sees.

## Context

An independent thread gets its own Git worktree on a fresh `sotto/thread-<id>` branch, and `ThreadWorktrees.inspect` ran before every send. It refused the message whenever the worktree's branch differed from the recorded one: "The working folder or branch no longer matches this thread. Restore its checkout before continuing." The check was written as a safety: never repair a folder destructively, and never send work to a folder that is not the thread's own.

In practice the branch changes for ordinary reasons. An agent creates a `prototype/` or `feat/` branch inside the worktree because that is where it is working, a user switches branches from the Changes panel that Sotto itself offers, or a rebase leaves the worktree detached. Twice in one evening a thread went dark with uncommitted work in its folder, the recovery was a manual `git checkout` of a branch name the user had never chosen, and both times the work being protected was the work being blocked. T3 Code, the reference for the Threads page, records a branch for a thread but never gates a send on it: a send adopts the branch the folder is on and writes it back, the label is read live from the folder, a detached HEAD counts as no branch, and a missing worktree is recreated from the recorded branch before the turn rather than refused.

## Decision

`inspect` refuses only a folder that stopped being the thread's registered worktree: missing, moved, redirected through a link, replaced by a plain directory, belonging to another repository, or locked or prunable in Git's own registry. When the folder is the registered worktree, `inspect` reads the branch from `git worktree list`, records it on the thread, and reports `ready`. A detached HEAD records no branch, and the pane shows the folder instead of a branch name.

The send path in `WorkspaceHost.threadWorkingDirectory` adopts the inspected record when the branch changed, so the pane header and the Tools panel follow a switch on the next send without a refresh.

`ensure`, the creation and repair path behind Retry setup, reuses a registered checkout on whatever branch it has, the same way, so the two paths cannot contradict each other. It still creates only with `-b` on the reserved name, never resets a branch with `-B`, and never removes anything.

Amended September 19, 2026: a folder that is simply gone is put back rather than refused. `ThreadWorktrees.restore` runs before the send path's `inspect` and inside `ensure` for a checkout Sotto had already made. When the folder is missing and Sotto recorded a branch that still exists, it runs `git worktree prune` and then `git worktree add -- <path> <branch>`, and the turn continues on the branch's own commits. It is best effort in one direction only: a folder that is still there, a thread with no recorded branch and a branch that no longer exists are all left to `inspect` to report. It refuses, naming the other folder, when that branch is checked out somewhere else, and it says so in the same terms when Git cannot put the folder back. It never resets a branch, never removes a checkout, and never adds anything outside Sotto's reserved worktree folder. `inspect` still creates nothing.

## Considered options

- **Keep refusing and improve the message.** The message already said what to do. The problem was that doing it discarded the user's own branch choice and stranded uncommitted work behind a git command.
- **Restore the recorded branch automatically.** A checkout Sotto performs on its own can fail on conflicting changes and, when it succeeds, silently moves the user off a branch they made on purpose. Sotto never switches a branch it did not create.
- **Recreate a missing worktree from the recorded branch before a turn**, as T3 does. Deferred when this was first written, then taken in the September 19 amendment above: the failure cases it worried about are handled by refusing, in plain words, when the branch is checked out elsewhere or Git will not put the folder back.
- **Follow the worktree.** Chosen. The `sotto/thread-<id>` branch is a starting point that keeps threads apart; once the user or agent has moved on, the folder's own branch is the truth, and it is what commits, pushes and pull requests from the Changes panel already read.

## Consequences

The recorded branch is descriptive from now on, not a constraint. Anything that renders it must tolerate it changing between sends and being absent for a detached HEAD, which `ThreadWorkingCopy` and the Tools panel already did. Two threads can end up on branches with unrelated names and nothing in Sotto minds. The one guarantee that remains is the folder: a send never goes to a directory that is not the thread's own registered worktree. Since the first amendment, a folder that vanished is put back there first, so the guarantee is met by recreating the checkout rather than by refusing the message; a user who deletes a thread's folder loses only what was never committed.

## Amendment, September 19, 2026: the pane says when the branch moved

Following the branch silently left the user with no way back. The thread pane now says so and offers the way: Sotto records the branch each send went to on the thread's working-copy record, re-reads the worktree after work that could have moved HEAD as well as on send, and shows a dismissible **Branch changed** notice above the composer once there is a draft to continue. Its **Restore branch** runs `git switch --no-guess` back to the branch of the last send, and only after the user answers a confirmation when the folder has uncommitted changes.

This does not reopen "restore the recorded branch automatically", which stays rejected. The decision above is about what Sotto does on its own: it still never switches a branch unasked, still never resets or removes anything, and a send still adopts whatever branch the folder is on. The switch here is one the user pressed, with the uncommitted work named before it happens.
