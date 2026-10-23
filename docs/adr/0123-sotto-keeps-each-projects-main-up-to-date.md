# Sotto keeps each project's main up to date

## Status

Accepted October 23, 2026, at Zach's request, as an Owl feature (`keep-main-current`, [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)). It adds to [ADR-0027](0027-git-the-way-t3-code-does-it.md)'s Automatically pull and changes none of it. The mock-up is `design/keep-main-current/mockup.html`; Zach picked variant A.

Zach's own Sotto checkout fell 1,320 commits behind `origin/main`, because nothing pulls a project's folder on its own. Automatically pull only acts on a folder a thread shows, while the window is in front, and it is off by default. Every merged pull request widens the gap, and the next thread that shares the project folder starts from old code. Old uncommitted edits in that folder would have blocked a pull anyway, and nothing said so.

## Context

Sotto already knows each project's folder and fetches `origin` in the background (the Git fetch interval). It reads the default branch and how far behind a branch is (Git status), fast-forwards with `--ff-only` under the checkout guard (Automatically pull), and learns that a pull request merged in three places: the Pull request surface, babysitting, and a thread's own status read. None of these moves a project's folder that no thread is looking at.

## Decision

**1. Every 15 minutes, shortly after Sotto starts, and when a pull request merges, the desktop checks each of its projects' checkouts.** Zach picked 15 minutes. The check runs whether or not the window is in front, since being away is when main falls behind. A merge seen by the Pull request surface, by babysitting or by a thread's status read checks, within seconds, the projects whose `origin` is that pull request's repository, once per pull request. Projects that are folders of one repository are checked once. A settled project is left alone.

**2. A check fetches `origin`, then fast-forwards the default branch only when nothing of the user's is in the way.** The default branch is `origin/HEAD`, else a remote `main` or `master`. The update is `git merge --ff-only` of the fetched `origin/<default>`, run under the checkout guard and the folder's one-Git-action rule, and decided again inside them. It is skipped when:

- another branch, or a detached HEAD, is checked out;
- a merge, rebase, cherry-pick or revert is in progress;
- the default branch has commits the remote's lacks;
- tracked files have local changes;
- an untracked file would be overwritten (Git refuses and names it);
- a thread whose working copy is that checkout is working, waiting on an answer, being set up, running a Git action or holding queued work;
- the remote cannot be reached.

Sotto never switches a branch, stashes, resets, rebases, merges or forces. It never runs an install either.

**3. What stopped it is said on the project row, quietly.** A muted line under the project's name in the Threads sidebar reads, for example, "main is 1,320 behind · local changes block the update · Show changes". **Show changes** lists what is in the way: the changed files, the untracked files Git named, or the local commits (**Show commits**). It has **Open folder** beside the list and nothing else, since Sotto does not undo the user's work. Zach picked Show changes over an Update now press. When another branch is checked out the line says so, with no press: "main is 38 behind · fix/tray-icon is checked out". A thread busy in the checkout, or a remote Sotto cannot reach, says nothing. The first is tried again a minute later, and for the second the last line stands. When nothing is in the way the line goes.

**4. An update that changed a lockfile says dependencies changed, until dismissed.** After a fast-forward that changed `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock` or `bun.lockb` at any depth, the row reads "Updated main · dependencies changed, run install", with **What changed** and a dismiss press. The notice is kept in `main-checkout.json` in the data folder, so it survives a restart. The next update replaces it.

**5. On by default where the feature is on, with a switch and a per-project override.** **Keep main up to date** sits under Settings → Git & worktrees, In the background, and is on. Settings → Threads → Project defaults gains **Keep this project's main up to date**: Use the Git setting, On or Off.

**6. This computer's projects only, for now.** The keeper lives in the shared runtime, but a headless host builds none. A paired host's projects would need the line to reach the desktop through the host protocol and the host's own settings; that is a follow-up.

**7. Off, nothing of it runs.** With the feature off, main builds no keeper, the window gets no bridge, and Settings shows neither switch. The saved settings stay, so turning the feature on restores them.

## Consequences

Sotto now writes to a project's folder on its own, which only Automatically pull did before, and only when the user turned it on. The rules above are what make that safe. A fast-forward can only add commits to a clean, checked-out default branch, and Git refuses anything that would overwrite a file. A repository's own `post-merge` hook runs as it would for the user's own pull.

Each project's `origin` is fetched every 15 minutes, also while the window is not in front and whatever the Git fetch interval says. No new host is contacted: Git talks only to the remote the user configured, with its existing authentication and with prompts off. The README's Privacy and cost section says so.

Sotto has no battery or metered-connection policy, so the check has none either. If Sotto gains one, this check should follow it.

The log keeps only `main-checkout-updated`, `main-checkout-blocked` and `main-checkout-update-failed`, never a path, a branch or a file.
