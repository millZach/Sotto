# A worktree has an end

Accepted September 22, 2026.

Note, September 24, 2026: what the Git interface ([ADR-0027](0027-git-the-way-t3-code-does-it.md)) changed here.

- **The rules stay under Settings → Application.** The other Git settings moved to Settings → Git, except the Generated switches, which stay under Cleanup; the owner's pick for that section left the worktree cleanup rules where they were.
- **Auto-settle merged threads rides this sweep.** The setting, off until turned on, settles a thread at rest whose last-sent branch's pull request is merged. It asks GitHub on this sweep's hourly schedule and shares the `merged` rule's `gh` question, once per branch when both want the answer. An auto-settle is not the user's Settle press, so it asks "Remove its worktree too?" of no one. Only the `onSettle` rule, when it is on, then decides about the folder, under every guard below.
- **The background fetch does not reopen the `unchanged` rule.** The considered option below refused a fetch because no periodic network action was documented; ADR-0027 now documents one under the **Git fetch interval**. The rule still compares with the local default branch (`refs/heads/<default>`) and fetches nothing itself. The background fetch moves only remote-tracking refs, so it does not change the rule's answer. **Automatically pull**, when it is on, fast-forwards a clean checkout of the default branch, and so moves forward what counts as already in it.
- **Previous worktree and New worktree.** A thread that picks **Previous worktree** on the branch toolbar works in another thread's worktree as a reused folder, and `reclaim` refuses a reused folder, so only the thread that made it can give it back. That thread's own Remove worktree waits while another thread works in the checkout. A worktree made by **New worktree**, including one a pull request checkout made, is the thread's own and can be reclaimed like any other. **Remove worktree** stays in the Working copy panel of the pane header.
- **Where `merged` asks.** The sentence below that says `merged` asks GitHub "the way the Changes panel already does" describes the panel of the time. Changes no longer reaches GitHub; the Git status reader and the Pull request surface ask through the same `gh`.

## Context

Sotto took T3 Code's working-copy lifecycle in two halves and left out the third. A thread can be given its own Git worktree under `<userData>/thread-worktrees/<token>` (ADR-0014), and a worktree that goes missing is put back on its recorded branch before the next send. Nothing ever removed one. `ThreadWorktrees` said so in its own words, "never removes files or branches", and ADR-0014 hardened it into "settling a thread removes nothing".

The cost showed up on Zach's machine on September 21: `%APPDATA%\sotto` held 31.8 GB and 758,000 files, almost all of it sixteen thread worktrees. Each one was a full checkout in which an agent had run `npm ci`, so each carried its own 1.4 GB `node_modules`; three also held a 600 MB `release/` from `npm run package`, and two held a nested `.worktrees/` an agent had made inside them. Thirteen of the sixteen belonged to settled threads. The repository's own `.worktrees/` and `.claude/worktrees/`, made by agents following this project's own guidance and never removed, held another 75 GB. Removing them by hand was the only exit, and `git worktree remove --force` follows a `node_modules` junction into the real install on Windows, which is the trap `AGENTS.md` warns about.

T3 Code, the reference for the Threads page, gives a worktree an end in two ways. Deleting a thread asks "This thread is the only one linked to this worktree. Delete the worktree too?" and removes it on a yes. A background sweep, hourly and on every settings change, removes worktrees under four opt-in rules, all off by default: idle for N days, pull request merged, thread deleted, or every commit already in the default branch. Before it removes anything it checks that the thread is idle with nothing pending, no terminal is open in the folder, the folder is inside T3's worktree directory and is a linked worktree rather than a main checkout, the branch on disk is the recorded one, there are no uncommitted changes, and the only ignored content is `node_modules`, because "ignored files can contain secrets or local datasets; dependency installs are reproducible". It keeps the branch and the thread's record so a resumed thread recreates the checkout.

## Decision

A thread's own worktree can be reclaimed: its folder removed, its branch and its thread kept, and the folder put back on that branch by the next send through the restore path ADR-0014 already has. The word is **reclaim**, and it is defined in `CONTEXT.md`.

Sotto reclaims a worktree in three ways, and in no other:

1. **Remove worktree**, in the pane's Working copy panel. The confirmation names the folder, says the branch keeps its commits and that sending puts the folder back, and, when the folder has uncommitted changes, says they are lost and turns the confirm button red.
2. **Settle asks.** Settling a thread whose worktree can be reclaimed settles it at once, as before, and then asks "Remove its worktree too?" with **Remove worktree** and **Keep folder**; Escape keeps it. Settle itself is unchanged and is not the confirmation.
3. **Rules the user turned on**, T3's four with settle standing in for T3's delete: `worktreeCleanup.afterDays`, `onSettle`, `unchanged` and `merged` in Settings under Application. Every rule is off by default. A sweep runs at start, every hour, when the rules change and, for the on-settle rule, when a thread is settled. `unchanged` compares the folder's HEAD with the local copy of the repository's default branch and does not fetch; `merged` asks GitHub through `gh`, the way the Changes panel already does, and only when that rule is on.

`ThreadWorktrees.reclaim` refuses, in plain words and changing nothing, a shared or reused folder, a folder outside Sotto's reserved worktree folder, one with no branch checked out (there would be nothing to come back on), one whose `.git` is a directory rather than a linked worktree's file, and one holding a link that leads out of the folder, so a removal can never follow a junction into the real `node_modules`. A folder with uncommitted changes goes only after the user's answer; a rule never gives that answer, whatever else it was told. A rule also leaves alone a folder with anything but `node_modules/` among its ignored files, T3's line, because build output and captures are not Sotto's to discard unasked. `WorkspaceHost.reclaimThreadWorktree` adds the thread's side: not while the thread is running or has requests waiting, not while working-copy setup is in flight, not when another thread works in the same checkout, and not while a Tools terminal is running in it.

The record keeps `path`, `branch` and `repositoryRoot` and gains `reclaimedAt`. `inspect` clears `reclaimedAt` whenever it finds the folder present, so a folder that came back by any route is simply a folder again. A refresh reads a reclaimed folder but does not put it back; only a send does. The Working copy panel says "Folder removed. Sending to this thread puts it back on <branch>", and offers neither Open folder nor Remove worktree for it.

## Considered options

- **Keep removing by hand.** It is what happened for two months, and it produced the 107 GB and a near miss with a junction. The app that makes the folders should be able to give them back.
- **Share `node_modules` between worktrees with a link.** It is what the by-hand attempts did (82 of the 160 worktrees held one), and it is exactly what makes removal dangerous on Windows. Refused; the outside-link guard is the opposite decision.
- **Remove on settle without asking.** A settle is filing, not a confirmation. Offered only as the opt-in `onSettle` rule, and even then a dirty folder still asks.
- **A Remove thread command that deletes the thread as well.** T3 has one; Sotto's threads are its history and there is no delete. Reclaiming the folder alone gets the disk back and keeps every thread.
- **Fetch before the `unchanged` rule**, as T3 does. An hourly background fetch is a new periodic network action Sotto has not documented; comparing with the local default branch is enough for a repository the user pulls anyway. If it proves too conservative, that is a README change and an amendment here.

## Consequences

"Never removes" is no longer true of `ThreadWorktrees` or of settling; ADR-0014 carries a note pointing here, and the guarantee that remains is the one that matters: a send never goes to a folder that is not the thread's own registered worktree, and a reclaimed folder is put back before it does.

`worktreeCleanup` is a new setting with a nested object, on the IPC patch allow-list. The `merged` rule reaches GitHub through `gh` on the user's own credentials, hourly, only when on; the README's privacy section says so.

The sweep's log carries two event names, `worktree-cleanup-reclaimed` and `worktree-cleanup-skipped`, and never a path or branch.

The sweep belongs to the agent runtime that owns the worktrees, so it runs wherever a host runs: in the desktop when its local host is on, and in every headless host, which reclaims its own worktrees under the rules in its own data folder's settings (amended September 23, 2026 for #245; see ADR-0025). Each drains a sweep in progress before closing the workspace it asks.

Agents working in this repository are told in `AGENTS.md` to remove any worktree they created when they are done with it, and never to make one inside a thread's worktree. The 107 GB was cleared by hand on September 22 with the branches kept and fourteen patches of uncommitted work saved under `%APPDATA%\sotto\backup-worktree-patches\`.
