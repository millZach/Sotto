# Work moves between a desktop's machines over its own SSH link

## Status

Proposed October 14, 2026, for Zach's decision. Nothing here is accepted until he says so, and nothing is built until then. Zach decided on October 14 that workers can start on any machine connected to the desktop and that code moves directly over the SSH link rather than through GitHub (decision 6 of the Watcher engine ticket map, #1023). This record proposes how, for #1033 (ticket E10), from a spike run the same day against forge. It is an Owl feature ([ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)).

## Context

The laptop and forge each keep their own clone of a project. A worker on forge commits to a branch the laptop cannot see, and the only way across today is to push to GitHub and pull on the other side. That puts work in progress on GitHub, which nobody asked for, and it needs a remote the user may not want touched.

The desktop already reaches each host it added over SSH ([ADR-0025](0025-headless-host-and-client-identity.md)), with the saved target, port and identity file, and the user's own `~/.ssh/config` deciding the rest. Git can carry a branch over exactly that.

## The spike, October 14, 2026

Run from the Windows laptop against forge (Omarchy, Linux 7.2.5), with throwaway repositories in `/tmp/sotto-e10-spike.*` on forge and under `%TEMP%` on the laptop, both removed afterwards. No real clone on either machine was touched. Every step below passed.

- **Which ssh.** Sotto's launcher runs Windows' own OpenSSH, `%SystemRoot%\System32\OpenSSH\ssh.exe` (9.5p2 on the laptop), not whatever comes first on PATH (`sshProcess.ts`). Git for Windows does not: with no `GIT_SSH_COMMAND` or `core.sshCommand`, `git` started from a Windows shell, whose PATH lists the System32 OpenSSH folder first, still ran its own bundled MSYS ssh (`C:\Program Files\Git\usr\bin\ssh.exe`, OpenSSH 10.2p1). The two told apart by their own error text for an unknown host. Setting `GIT_SSH_COMMAND` to the System32 executable made Git use it, and Git ran it through its bundled `sh -c`, so the path must be quoted if it ever holds a space.
- **The options.** `-o BatchMode=yes -o ConnectTimeout=15 -o ControlMaster=no -o ControlPath=none -o ControlPersist=no -o RemoteCommand=none -o RequestTTY=no -o ForwardAgent=no -o ForwardX11=no`, which are the launcher's own options except that a move asks nothing (`BatchMode=yes` rather than the launcher's askpass). The saved target `forge` carries no identity file, so `~/.ssh/config` supplied the host name, user and key, exactly as it does for the launcher. Git adds only `-o SendEnv=GIT_PROTOCOL`.
- **Forge to laptop.** `git fetch forge:<repo> refs/heads/work:refs/sotto/incoming/work` landed the branch in the laptop's repository in about 0.27 seconds.
- **Laptop to forge.** `git push forge:<repo> refs/heads/laptop-fix:refs/sotto/incoming/laptop-fix` landed as a new reference in about 0.26 seconds, while forge's checked-out branch, index and working tree stayed as they were.
- **A checked-out branch is safe.** A push into forge's checked-out `work` was refused by forge's Git ("branch is currently checked out") with `receive.denyCurrentBranch` at its default.
- **Nothing is forced.** A push that was not a fast-forward of an existing incoming ref was refused ("non-fast-forward"), and so was a fetch after forge rewrote `work`. Both refs stayed where they were. Both refusals are Git's, on the side that runs the command, and hold because Sotto never passes `--force` or a `+` refspec.
- **A new worktree from the moved branch.** `git worktree add -b laptop-fix <path> refs/sotto/incoming/laptop-fix` on forge, and the same on the laptop for a fetched branch, each in under 0.2 seconds, leaving the main checkout untouched.
- **Uncommitted work shows.** `git status --porcelain` listed a modified and an untracked file on the laptop and a modified file on forge, and nothing once they were put back.
- **Round trip.** A commit made in forge's new worktree came back to the laptop by fetch as a fast-forward of the branch the laptop had sent.
- **Git on forge.** `/usr/bin/git`, version 2.55.0. The laptop has Git for Windows 2.53.0.

## Decision

**1. Only committed branches move.** Before a move, Sotto reads `git status --porcelain` in the sending working copy. Anything listed refuses the move in plain words, asking the user or the worker to commit first, and moves nothing. Sotto never commits, stashes or discards on anyone's behalf.

**2. A moved branch always lands in a ref the receiving side keeps for it.** Both directions land in `refs/sotto/incoming/<branch>` in the receiving repository: from forge to the laptop, the laptop fetches forge's branch; from the laptop to forge, the desktop pushes to that ref on forge. No checked-out branch, and no branch the user made, is written by a move.

**3. Nothing is forced.** No move passes `--force`, `--force-with-lease` or a `+` refspec. When an incoming ref already holds work the move would not fast-forward, the move is refused in Git's words and in Sotto's, and both sides keep what they had.

**4. The receiving worker starts in a new worktree.** It starts on a branch of the moved name, made from the incoming ref, in a worktree Sotto owns on that machine (ADR-0014, ADR-0041). A branch of that name that already exists there is never moved; a move that would need it moved is refused.

**5. Git uses the same ssh, target and identity as the launcher.** On Windows, `GIT_SSH_COMMAND` names Windows' own OpenSSH, because Git would otherwise use its bundled ssh, which the launcher deliberately avoids. Elsewhere it is `ssh` from PATH, as the launcher's is. The options are the launcher's, with `BatchMode=yes`, plus the saved identity file and port when the host has them. Each move opens its own SSH session; it does not ride the launcher's port forward, which keeps multiplexing off by design, and a host on its **tailnet connection** is still reached for a move over SSH. A move asks nothing: when ssh would need an answer, such as a passphrase or an unknown host key, the move stops and says to connect the host again first. Whether a move should instead ask through the launcher's askpass is left to the build.

**6. No new host, nothing through GitHub.** A move contacts only the SSH host the user already added and runs only Git at each end. It needs no GitHub remote and never pushes to one. The README's privacy section says so.

**7. Watcher and continuing elsewhere use it.** `start_thread` gains a start from a thread's branch: Sotto moves the branch, then starts the worker. Results come back the same way, and #1030 (E7) brings them onto the parent's branch. Continuing a thread on another machine moves the branch first.

## Consequences

- Work in progress stays on the user's own machines. GitHub sees a branch only when the user or a thread pushes it there.
- `refs/sotto/incoming/*` accumulates on both machines. They hold commits Git would otherwise collect, so the build needs a rule for removing them once the worktree that used one is cleaned up.
- The receiving machine must already have a clone of the project; E9 refuses a machine without one in plain words and never clones.
- A key with a passphrase, or a host whose key changed, stops moves until the user connects the host again. That is the cost of asking nothing.
- A Mac host should behave as forge did but is unverified until one is connected.

## Proof, when built

Integration with two local repositories behind a file transport stand-in: uncommitted work refused, a non-fast-forward refused, a checked-out branch untouched, a new worktree on the moved branch. Then a live run on forge: laptop to forge and back, Linux journeys on forge, Windows tests on the laptop.
