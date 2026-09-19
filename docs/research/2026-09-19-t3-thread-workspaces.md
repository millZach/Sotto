# T3 Code thread workspaces compared with Sotto

Research date: 2026-09-19. Scope: the branch-change notice in Zach's screenshot, thread identity, working copies, and branch lifecycle. This is source research with focused Sotto tests, not an application change or a live desktop reproduction.

## Finding

The two applications apply the branch-change notice to opposite working-copy modes. T3 warns for a shared project checkout and explicitly excludes dedicated worktrees. Sotto warns only for independent worktrees and excludes shared project folders. Sotto therefore announces an ordinary branch switch made inside a thread's isolated folder, including the agent creating a task branch. Its send path already accepts that switch. The screenshot matches this intentional renderer behavior; it does not establish which process switched the branch or whether any work was lost.

Recommendation: keep independent working copies and their folder-identity checks, follow their current branch quietly, and put intentional branch switching in the branch control. If Sotto needs T3's warning, apply it to the shared-project-folder case, where another thread or terminal can move the same checkout. Keep any dismissal across pane remounts. Changing the default working-copy mode is a separate product decision, not a prerequisite for fixing this notice.

## T3 Code reference

The official repository is [pingdotgg/t3code](https://github.com/pingdotgg/t3code), not `t3dotgg/t3code`. This investigation pins current main to [`7810fb263f5a92b9d438d1eabf408d2ac705e944`](https://github.com/pingdotgg/t3code/commit/7810fb263f5a92b9d438d1eabf408d2ac705e944), committed 2026-09-19. The installed T3 application version was not established; these findings describe this source revision. The repository was cloned outside Sotto into the Windows temporary directory for inspection. No T3 tests or application were run.

### The important distinction

T3 has a very similar **Branch changed / Restore branch** notice. However, its mismatch detector explicitly returns no mismatch when a thread has a worktree path, or is not in local mode. It warns about the project checkout being on a different branch from the thread's recorded branch. It does not warn about a dedicated worktree changing branches. The branch control separately prefers Git's actual current branch for an existing checkout. [Mismatch and label logic](https://github.com/pingdotgg/t3code/blob/7810fb263f5a92b9d438d1eabf408d2ac705e944/apps/web/src/components/BranchToolbar.logic.ts#L174-L235)

The local-checkout warning waits until the composer contains content, then stays visible until resolved or dismissed. Dismissal is keyed by thread and the old/new branch pair in a module-level set, so changing routes or remounting the view does not restore the same warning during that client session. It is not a durable cross-device acknowledgement. [Notice visibility and dismissal](https://github.com/pingdotgg/t3code/blob/7810fb263f5a92b9d438d1eabf408d2ac705e944/apps/web/src/components/ChatView.logic.ts#L923-L977)

The notice does not require a restore before sending. The send path updates the thread's recorded branch to the current local checkout branch. Restore is a separate user action and asks for confirmation when there are working-tree changes. [Send metadata](https://github.com/pingdotgg/t3code/blob/7810fb263f5a92b9d438d1eabf408d2ac705e944/apps/web/src/components/ChatView.tsx#L8307-L8323), [restore and banner](https://github.com/pingdotgg/t3code/blob/7810fb263f5a92b9d438d1eabf408d2ac705e944/apps/web/src/components/ChatView.tsx#L6463-L6552)

For a dedicated worktree, the server refreshes Git status after a provider turn completes and silently adopts the checked-out branch in thread metadata. It only does this when the worktree belongs to exactly one thread, the stored branch is non-null, and the actual branch is neither detached nor a temporary placeholder. It uses an expected-old-branch comparison to avoid overwriting a concurrent update. This is not a claim of continuous adoption of every terminal-side switch: the verified server trigger is turn completion. [Refresh trigger and drift adoption](https://github.com/pingdotgg/t3code/blob/7810fb263f5a92b9d438d1eabf408d2ac705e944/apps/server/src/orchestration/Layers/CheckpointReactor.ts#L510-L639)

### Identity, creation, and parallel work

- **Thread identity is independent of Git.** The web client creates a UUID thread ID. Provider runtime bindings are stored by that thread ID with a provider instance and resume/runtime data. Branch name and worktree path are separate thread metadata, not the thread's identity. [ID creation](https://github.com/pingdotgg/t3code/blob/7810fb263f5a92b9d438d1eabf408d2ac705e944/apps/web/src/lib/utils.ts#L43-L47), [provider binding](https://github.com/pingdotgg/t3code/blob/7810fb263f5a92b9d438d1eabf408d2ac705e944/apps/server/src/provider/Services/ProviderSessionDirectory.ts#L18-L31)
- **The shipped default is Current checkout.** The default environment mode is `local`; project settings can override it, then `t3.json`, then the global setting. An explicit composer choice wins over those defaults. Current checkout means threads share the project folder and its checked-out branch; it is not filesystem isolation. [Default](https://github.com/pingdotgg/t3code/blob/7810fb263f5a92b9d438d1eabf408d2ac705e944/packages/contracts/src/settings.ts#L1173-L1178), [precedence](https://github.com/pingdotgg/t3code/blob/7810fb263f5a92b9d438d1eabf408d2ac705e944/packages/shared/src/threadEnvMode.ts#L3-L17)
- **New worktree is an explicit alternative.** Creation is requested with the first send when a draft is in worktree mode and has no worktree yet. The user needs a base branch. The request carries that base, a temporary branch, and the start-from-origin choice; the global default for the latter is true. The server runs `git worktree add -b` against the resolved base and then setup. [First-send condition](https://github.com/pingdotgg/t3code/blob/7810fb263f5a92b9d438d1eabf408d2ac705e944/apps/web/src/components/ChatView.tsx#L7661-L7676), [bootstrap request](https://github.com/pingdotgg/t3code/blob/7810fb263f5a92b9d438d1eabf408d2ac705e944/apps/web/src/components/ChatView.tsx#L8355-L8368), [server creation](https://github.com/pingdotgg/t3code/blob/7810fb263f5a92b9d438d1eabf408d2ac705e944/apps/server/src/ws.ts#L1426-L1475)
- **Temporary branch names are short and replaceable.** The initial name is `t3code/<8 hex characters>`, independent of the UUID thread ID. First-turn processing attempts to generate a descriptive branch name from the message, rename the branch, and update metadata. Failure is caught and leaves the turn running. Worktree folders default to `<worktreesDir>/<repo basename>/<initial branch with slashes replaced by hyphens>`; branch renaming does not move that folder in the inspected path. [Temporary name](https://github.com/pingdotgg/t3code/blob/7810fb263f5a92b9d438d1eabf408d2ac705e944/packages/shared/src/git.ts#L95-L108), [automatic rename](https://github.com/pingdotgg/t3code/blob/7810fb263f5a92b9d438d1eabf408d2ac705e944/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts#L880-L938), [folder allocation](https://github.com/pingdotgg/t3code/blob/7810fb263f5a92b9d438d1eabf408d2ac705e944/apps/server/src/vcs/GitVcsDriverCore.ts#L3050-L3061)
- **A worktree need not mean one conversation forever.** Previous worktree can seed a follow-up thread, and selecting a branch already in a worktree reuses that folder. Separate worktrees provide separate checkouts; threads deliberately sharing a folder share files and HEAD. Automatic branch adoption excludes shared worktree paths. [Previous worktree](https://github.com/pingdotgg/t3code/blob/7810fb263f5a92b9d438d1eabf408d2ac705e944/apps/web/src/components/BranchToolbar.logic.ts#L96-L147), [existing-worktree selection](https://github.com/pingdotgg/t3code/blob/7810fb263f5a92b9d438d1eabf408d2ac705e944/apps/web/src/components/BranchToolbar.logic.ts#L237-L264)

### Missing folders and deletion

Before starting a turn, T3 checks whether a thread's stored worktree directory exists. If absent and it has a branch, it prunes stale Git worktree entries and attempts to recreate the same directory on the recorded branch. This is best effort: failure is logged and execution continues to the provider's actual error. The inspected helper is an existence check, not Sotto-style validation of a present folder's registered worktree identity. [Recovery](https://github.com/pingdotgg/t3code/blob/7810fb263f5a92b9d438d1eabf408d2ac705e944/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts#L467-L512), [before-turn call](https://github.com/pingdotgg/t3code/blob/7810fb263f5a92b9d438d1eabf408d2ac705e944/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts#L1325)

Deleting a thread can also remove its worktree only when no other loaded thread references that folder. The web deletion flow asks separately unless automatic worktree cleanup is configured; cleanup failures have their own feedback after the thread has been deleted. This describes the inspected web deletion path, not every archive or server cleanup policy. [Shared-folder protection](https://github.com/pingdotgg/t3code/blob/7810fb263f5a92b9d438d1eabf408d2ac705e944/apps/web/src/worktreeCleanup.ts#L11-L32), [delete prompt and cleanup](https://github.com/pingdotgg/t3code/blob/7810fb263f5a92b9d438d1eabf408d2ac705e944/apps/web/src/hooks/useThreadActions.ts#L354-L489)

### Evidence limits

T3 includes tests for adopting a dedicated worktree's changed branch, skipping shared worktrees and temporary branches, and recreating a missing folder. They were read, not executed. This investigation establishes source behavior, not installed-build behavior, a live reproduction, or a guarantee that T3 has no other workspace edge cases. [Drift tests](https://github.com/pingdotgg/t3code/blob/7810fb263f5a92b9d438d1eabf408d2ac705e944/apps/server/src/orchestration/Layers/CheckpointReactor.test.ts#L1235-L1347), [recovery test](https://github.com/pingdotgg/t3code/blob/7810fb263f5a92b9d438d1eabf408d2ac705e944/apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts#L2606-L2655)

## Sotto comparison

Sotto baseline: local checkout at `7b63b3672812c209b5ae4ee5716c6247d1889bc0`, with pre-existing uncommitted work left intact. Links below point to the local source. No application files were changed by this investigation.

| Behavior | T3 at the pinned revision | Sotto |
|---|---|---|
| Default working copy | Current checkout; configurable | New worktree unless the creation choices override it |
| Worktree creation | First send, selected base, optional origin start | Background preparation when the thread opens, from the project's current committed HEAD |
| Initial branch | Short temporary name; attempts descriptive rename on first turn | `sotto/thread-<UUID>`; branch can subsequently be changed by user or agent |
| Dedicated worktree branch changes | No mismatch banner; live branch display, conditional metadata adoption after turn completion | Adopts actual branch, but compares it with `sentBranch` and shows a banner when composing |
| Shared project folder branch changes | Eligible for the mismatch notice; sending adopts current branch | Excluded from this notice |
| Dismissal | Client-session set survives view remounts | Component-local state; remount/restart forgets it |
| Missing worktree | Best-effort recreation before turn | Recreation on recorded branch, followed by strict registered-folder validation |
| Put thread aside | Has separate deletion/cleanup flows | Settle changes grouping only; does not remove the worktree |

Sotto's [NewThreadDialog](../../src/renderer/src/agents/NewThreadDialog.tsx) defaults to independent mode at line 62; [WorkspaceHost](../../src/main/agents/workspace.ts) repeats that default at line 765 and begins background preparation at line 780. [ThreadWorktrees](../../src/main/agents/threadWorktrees.ts) allocates the base commit, branch, and folder at lines 44-65. Despite the shorthand in the domain documentation, the branch suffix is a separately allocated UUID, not literally the Sotto thread ID. Worktrees live under `<userData>/thread-worktrees/<allocation UUID>`. Uncommitted project-folder edits are not copied into a new worktree.

The exact Sotto notice condition is in [ThreadBranchNotice](../../src/renderer/src/agents/ThreadWorkingCopy.tsx), lines 156-169: ready, independent, a remembered send branch, a different current branch, and a nonempty draft. There is no distinction between an intentional agent branch switch and an unexpected switch. Dismissal uses `useState`, not persisted thread state. [ThreadPane](../../src/renderer/src/agents/ThreadPane.tsx), lines 136-153, refreshes on draft start and window focus; [WorkspaceHost](../../src/main/agents/workspace.ts), lines 472-495, also refreshes after relevant finished activity with a 1.5-second coalescing delay.

The current send path restores and inspects the folder, adopts its actual branch, and records `sentBranch` immediately before provider dispatch ([WorkspaceHost](../../src/main/agents/workspace.ts), lines 696-723 and 858-865). Thus a subsequent send on the changed named branch normally resolves the comparison. This marker records attempted dispatch, not proof that the provider completed or accepted the work. Restore is a real Git switch to the remembered branch, not merely a label reset; dirty work requires confirmation, and Git can refuse conflicting changes ([WorkspaceHost](../../src/main/agents/workspace.ts), lines 675-691; [ThreadWorktrees](../../src/main/agents/threadWorktrees.ts), lines 161-176).

[ADR-0014](../adr/0014-thread-follows-its-worktree-branch.md) explains the history: branch mismatch originally blocked sends; that restriction was removed, missing-folder repair followed, and the composer notice was then added. The current annoyance is the notice rule layered onto a send path that already tolerates normal branch changes. A change to that rule should amend this ADR and the branch-notice description in [CONTEXT.md](../../CONTEXT.md) and [agent-control.md](../agent-control.md).

Sotto's stricter worktree checks still serve a separate purpose: they reject redirected, replaced, unregistered, locked, or wrong-repository folders rather than accidentally directing a thread elsewhere. Those checks need not be removed to eliminate routine branch-change notices. Settling a thread only changes `workspaceSettledAt` ([WorkspaceHost](../../src/main/agents/workspace.ts), lines 575-589).

## Checks run

All 20 selected Sotto tests passed:

```text
npx vitest run tests/unit/renderer/threadBranchNotice.test.tsx --maxWorkers=2
6 passed

npx vitest run tests/unit/main/workspace.test.ts -t 'adopts the branch|re-reads the worktree|restores the branch|puts a deleted folder' --maxWorkers=2
4 passed, 13 skipped

npx vitest run tests/integration/threadWorktreesNative.test.ts --maxWorkers=2
6 passed

npx vitest run tests/unit/main/threadWorktrees.test.ts -t 'follows the branch|switches back|recreates a deleted|refuses to recreate' --maxWorkers=2
4 passed, 9 skipped
```

The renderer tests exercise the notice with React in jsdom. Workspace unit checks mock Git inspection; the worktree checks use real temporary Git repositories. Native integration checks use real Git and fixture provider processes, not live provider accounts. The renderer run emitted jsdom canvas warnings; Node emitted its SQLite experimental warning. Neither failed the checks. No desktop UI session, installed binary version, T3 runtime, full CI run, or freeze/performance diagnosis was verified. Fix and regression phases were intentionally out of scope because the request was to investigate and report.

## Follow-up: why the AppData folders look different

Read-only directory listings on this machine confirmed 72 root entries in `%APPDATA%/sotto` and 23 in `%APPDATA%/t3code` at inspection time. Those are entry counts, not total disk usage.

The T3 screenshot shows its Electron profile, not all of T3's application data. This machine also has `%USERPROFILE%/.t3/{userdata,worktrees,caches,tools}`. Its `userdata` directory contains `state.sqlite`, settings, attachments, logs, and other host data. T3's server source explicitly separates `userdata`, `worktrees`, and `caches` under its base directory ([path derivation](https://github.com/pingdotgg/t3code/blob/7810fb263f5a92b9d438d1eabf408d2ac705e944/apps/server/src/config.ts#L124-L159)). Only names and metadata were inspected, not private file contents.

Sotto supplies Electron's user-data directory directly to its host and stores its own worktrees, JSON state, databases, and feature folders alongside Chromium's profile files ([main wiring](../../src/main/index.ts), lines 566-578; [workspace storage](../../src/main/agents/workspace.ts), lines 114-119). Thus the screenshot mixes browser caches, actual app state, project working copies, and leftovers at one level. That layout is less organized, but file count alone does not prove heavier resource use or explain freezes.

There is also a concrete cleanup gap: 20 `*.tmp-*` files remained in the Sotto root, totaling 1,020,246 bytes. Fourteen belonged to `agents.json` and six to `claude-usage.json`; their timestamps predated the inspection. [AtomicJsonStore](../../src/main/storage/atomicJsonStore.ts), lines 86-153, writes a uniquely named temporary file, syncs it, then renames it over the destination. Success consumes the temporary file; a caught failure attempts deletion. Abrupt process termination before that cleanup, or failed cleanup itself, can leave one behind. The exact cause of these particular leftovers was not established. The generic store has no startup sweep, although a few feature-specific privacy paths remove their own matching temporary files.

The `backup-remove-thread-*` directory is another extra entry. No producer with that name was found in current `src/` or `scripts/`; its provenance and whether its contents remain useful were not established. It was not deleted.

Recommended follow-up is a deliberate application-data layout with separate state, caches, recovery material, and worktrees, plus safe stale-temporary-file recovery/cleanup. A migration must preserve existing threads, worktree registrations, credentials, and user edits. Consolidating overlapping state should follow ownership analysis; reducing filenames alone is not a reason to merge stores. No profile files were moved, edited, or deleted during this investigation.
