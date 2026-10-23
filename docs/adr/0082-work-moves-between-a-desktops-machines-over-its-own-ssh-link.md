# Work moves between a desktop's machines over its own SSH link

## Status

Accepted by Zach on October 14, 2026. It is built with #1033 (ticket E10). Zach decided on October 14 that workers can start on any machine connected to the desktop and that code moves directly over the SSH link rather than through GitHub (decision 6 of the Watcher engine ticket map, #1023). This record settles how, from a spike run the same day against forge. It is an Owl feature ([ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)).

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

**1. Only committed branches move, as the commit Sotto checked.** Before a move, Sotto reads `git status --porcelain` in the sending working copy. Anything listed refuses the move in plain words, asking the user or the worker to commit first, and moves nothing. Sotto then resolves the branch to its commit and moves that commit by its hash (`<commit>:<ref>`), not the branch name, so work committed between the check and the transfer is never carried unchecked. Sotto never commits, stashes or discards on anyone's behalf.

**2. A moved branch always lands in a ref of its own on the receiving side.** Each move lands in `refs/sotto/incoming/<move>/<branch>` in the receiving repository, where `<move>` is the move's own identity: from forge to the laptop, the laptop fetches forge's branch; from the laptop to forge, the desktop pushes to that ref on forge. No checked-out branch, and no branch the user made, is written by a move.

**3. Nothing is forced.** No move passes `--force`, `--force-with-lease` or a `+` refspec. Because every move has its own incoming ref, a later move or a move back never meets an earlier move's ref, so a non-fast-forward cannot leave moves stuck. Sotto removes a move's incoming ref when the worktree made from it is cleaned up (ADR-0041), and never removes one a worktree still uses.

**4. The receiving worker starts in a new worktree.** It starts on a branch of the moved name, made from the move's incoming ref, in a worktree Sotto owns on that machine (ADR-0014, ADR-0041). A branch of that name that already exists there is never moved: when one exists, the new worktree's branch gets a distinct name Sotto shows (the way a new worktree's temporary `sotto/<token>` branch does, ADR-0014), and the user's branch stays as it was.

**5. Git uses the same ssh, target and identity as the launcher.** On Windows, `GIT_SSH_COMMAND` names Windows' own OpenSSH, because Git would otherwise use its bundled ssh, which the launcher deliberately avoids. Elsewhere it is `ssh` from PATH, as the launcher's is. The options are exactly the launcher's (`sshLauncher.ts`, `baseArguments()`), which keep `StrictHostKeyChecking=ask`, the keepalive (`ServerAliveInterval`, `ServerAliveCountMax`) and `IdentitiesOnly=yes` with the saved identity file and port, with one change: `BatchMode=yes`, so an unknown or changed host key refuses rather than being accepted. The spike's shorter option list above showed the transport works; the build reuses the launcher's list. Each move opens its own SSH session; it does not ride the launcher's port forward, which keeps multiplexing off by design, and a host on its **tailnet connection** is still reached for a move over SSH. A move asks nothing: when ssh would need an answer, such as a passphrase or an unknown host key, the move stops and says to connect the host again first. Whether a move should instead ask through the launcher's askpass is left to the build.

**6. No new host, nothing through GitHub.** A move contacts only the SSH host the user already added and runs only Git at each end. It needs no GitHub remote and never pushes to one. The README's privacy section says so.

**7. Watcher and continuing elsewhere use it.** `start_thread` gains a start from a thread's branch: Sotto moves the branch, then starts the worker. Results come back the same way, and #1030 (E7) brings them onto the parent's branch. Continuing a thread on another machine moves the branch first.

## Consequences

- Work in progress stays on the user's own machines. GitHub sees a branch only when the user or a thread pushes it there.
- `refs/sotto/incoming/*` holds one ref per move until the worktree made from it is cleaned up (decision 3). They hold commits Git would otherwise collect, so a move whose worktree is never made is also removed when its thread is.
- The receiving machine must already have a clone of the project; E9 refuses a machine without one in plain words and never clones.
- A key with a passphrase, or a host whose key changed, stops moves until the user connects the host again. That is the cost of asking nothing.
- A Mac host should behave as forge did but is unverified until one is connected.

## Proof, when built

Integration with two local repositories behind a file transport stand-in: uncommitted work refused, the checked commit moved even when the branch moves on during the transfer, a second move and a move back after a non-fast-forward both land, a checked-out branch untouched, a new worktree on the moved branch, an existing branch of the same name untouched, and the incoming ref removed with its worktree. Then a live run on forge: laptop to forge and back, Linux journeys on forge, Windows tests on the laptop.

## Amended October 23, 2026: where a new worker starts (#1032)

The Owl feature Work across machines (`cross-machine-work`, [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)) is owned by this record. Its first part, #1032 with #1313's machine list and #1312's choice of system, decides where a new worker starts. Nothing moves a branch yet; that is #1033's.

1. **Where new workers start** is a setting (`newWorkerMachine`): **This computer**, the default, so nothing moves until the user chooses; a connected machine, by its saved host ID; or **Let Watcher choose**. Its control in Settings, Watcher comes with the prototype Zach is shown (variant B of October 14, the machine tiles); until then it stays on This computer.
2. **A start's own words decide for that start.** Watcher's `start_thread` may name a `machine` (a host ID from `list_machines`) or an `os` (`windows`, `macos`, `linux`), matched against **host facts**. A machine is kept to. A system goes to a connected machine of that system, the machine new workers start on first, then the project's, then This computer, and never falls back to another: with none connected, nothing starts and Sotto says so ("No Mac is connected. Connect a Mac, or run this on This computer. Nothing was started.").
3. **With neither named**, a project Watcher named on another machine starts there, as Watcher has always placed work, and one named on This computer goes to the machine new workers start on. Watcher names a project, and the project already says a machine; treating that as the request's own words keeps every start Watcher made before this the same. *This rule is Sotto's reading of #1032, not Zach's words; it is listed for him to confirm.*
4. **A machine that is not connected, or no longer saved,** starts the worker on This computer instead, and the receipt's note says why (Zach, October 14: build the fallback, not the prototype's refusal). A machine named in the start's own words is refused when not connected.
5. **The same project on another machine** is the one whose `origin` remote names the same GitHub repository (`sameRepository`). A machine with none is refused in plain words ("Forge has no copy of Sotto. Add the project on forge first."), and Sotto never clones. A headless host reports its projects' origins through a new optional host-v1 feature, `project-origins`, only to a desktop and only where its own Owl answer turns the feature on; it carries the repository's host, owner and name, never a path or a URL. An older host cannot be matched, so a start there must name one of its own projects, and a start that would need matching says to update it. A working-copy or base-branch choice read on one machine is refused on another.
6. **The receipt records the machine** (`placement`: host ID, name, `awayFromDefault`, Sotto's note), in memory as a worker role's note is, and Watcher is told to say in its reply which machine and why whenever a start is away from where new workers start. Its instructions also tell it to read a project's own notes on where checks run.
7. **Working threads are counted on each machine**, and a Watcher start on another machine that leaves more than ten working there warns, as one on This computer does (#1183). Nothing is refused at any count. `workingThreadsByMachine` gives the window each machine's count for the room.
8. **A delegating thread** gets `list_machines` on `sotto_delegate`, the same list Watcher reads, and `delegate` takes `machine` or `os` for a new thread. A delegated thread starts only on This computer until delegation reaches other machines (#1316): a placement anywhere else is refused and recorded, and a setting that puts new workers on another machine is noted in the result, not followed. ADR-0081 decision 10 is amended to match.

Stable reads no setting for it, offers no machine or system, lists no `newWorkersStart` and asks no host for its projects' origins; a host on stable lists no `project-origins`. The setting itself is saved whatever the track, as every setting is, so turning the feature on restores it.
