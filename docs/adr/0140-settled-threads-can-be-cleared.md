# Settled threads can be cleared

## Status

Accepted October 23, 2026, as an Owl feature (`clear-threads`). Zach's picks on October 23, 2026 from `docs/prototypes/clear-threads-prototype.html`: variant C (Settings only), no undo, a cleared thread's own clean worktree goes and every branch stays, Owl first. Amends [ADR-0041](0041-a-worktree-has-an-end.md), which refused a command that deletes a thread, and gives [ADR-0016](0016-sotto-owned-history-on-an-event-store.md)'s `ThreadStore.forget` its first caller. **Number provisional until merge** (docs/agents/domain.md).

Amended October 25, 2026: Zach chose 30 days as the default for **Clear settled threads after**, in place of Never, which stays a choice. See decision 2.

## Context

Zach asked for "a way to clear old threads from Sotto history", the way T3 Code has one. Nothing in Sotto removes a thread. Settle files it away, and the Settled shelf only grows. ADR-0041 refused a delete because "Sotto's threads are its history and there is no delete", and gave back the disk by reclaiming worktree folders instead. What remains is the history: a long Settled shelf to scroll past, and words kept on disk that the user no longer wants kept.

T3 Code (`pingdotgg/t3code`, read October 23, 2026) deletes one thread from its menu, or several selected in the sidebar, after a confirmation that says it "permanently clears conversation history". There is no undo. Archive, separate from delete, has five seconds of Undo. Nothing deletes threads by age; its age rules cover worktrees, logs and browser files. Delete asks "Delete the worktree too?" when the thread is the folder's last, removes it with force, and keeps the branch. Its store keeps the deleted thread's rows and marks them deleted (open issue #17845).

Sotto keeps a thread in more places than its history: the organization record in `workspace.json`, the event store `threads.sqlite`, the sub-agent roster `subagents.sqlite`, each provider adapter's alias record (which holds the title and the native session ID), the coordinator's drafts and delivery records, delegation records, checkpoints, and a worktree folder when the thread made one. A provider snapshot is merged into the workspace by thread ID, so a thread whose record alone is removed comes back on the next snapshot.

## Decision

**1. Clearing is for settled threads, and it is final.** Only a thread that is settled, on its own or with its project, can be cleared. Settle remains the step that can be taken back; clearing is the one that cannot. There is no trash and no Undo. The confirmation lists what goes and what stays. A deleted thread's words are taken out the way forgetting already takes them out (ADR-0016): its messages, activity, visuals and wake-up marks are deleted, its events keep only that they happened, and the commit waits for the disk.

**2. Three ways to clear, all in Owl.**
- **Delete thread…** in a settled thread's pane menu (**⋯**) deletes that one thread.
- **Clear now…** in Settings → Threads, **Clearing threads**, clears this computer's settled threads that have been quiet longer than an age the user picks (7, 30 or 90 days, or any age). It opens **Clear settled threads**, which lists the threads that go and the threads kept with the reason for each, and clears on **Clear N threads**.
- **Clear settled threads after** in the same section (Never, 30, 90 or 180 days; 30 days by default) clears them on its own. It runs at start, every hour, and when the setting changes, beside the worktree sweep (ADR-0041), on the computer whose setting it is.

An Owl user who never chose has no saved value, so the first start with the feature takes 30 days and its first run clears what has been quiet that long. That run keeps back everything decision 3 keeps back, as every run does, and starts only once the coordinator, Watcher and delegation have recovered what they hold, so a thread queued, babysat or watched before the restart is still kept.

A thread's age here is the time since the later of its settle and its last activity, so a thread that is settled but still being written to is not old.

**3. What is kept back.** Clearing never takes a thread that:
- is running, compacting, has background work, or waits on the user;
- has anything queued for it or an action whose result is unknown;
- has an open pull request, or a thread it delegated to has one;
- has a thread it delegated to that is not itself at rest;
- is being babysat or watched by Watcher;
- has uncommitted changes in its own worktree;
- has a worktree Sotto would not remove on its own: one holding ignored files besides `node_modules`, nested work, or a link out of the folder, or one another thread or a terminal is using. **Delete thread…** on that one thread lists the ignored items and nested work the way **Remove worktree** does (ADR-0041's List and tick), and deletes the thread once they are ticked. Clear now and the automatic rule keep it and say why;
- is Watcher's own conversation, or is hidden because its provider is held to Owl or Watcher is off.

The lists are worked out in main and checked again for each thread as it is deleted, so a thread that changed between the dialog and the press is kept.

**4. What a deletion removes.** The thread's record and its creation record; its rows in `threads.sqlite` (through `ThreadStore.forget`) and `subagents.sqlite`; its provider alias record and the adapter's in-memory state for it, through a new `AgentHost.forgetThread`; its drafts, request drafts and remote drafts; its finished delegation records; its checkpoints; and its own worktree folder, reclaimed under ADR-0041's guards. A worktree folder that was reused from another thread, or a shared project checkout, is not the thread's to remove and is left alone. Clearing many threads forgets them in one store transaction and one scrub.

**5. What a deletion keeps.** Every branch and its commits. Usage's numbers (ADR-0078 already keeps them through deletion). The provider's own transcript of the session, in `~/.codex`, `~/.claude` and the others' folders, which belongs to the provider and the user. Other threads that point at the deleted one (a delegated thread, a continuation) keep their own history and lose only the link.

**6. A cleared thread stays cleared.** The workspace keeps the IDs of cleared threads in `workspace.json` and refuses them in every provider snapshot and thread event, so a provider that still reports one, because its alias could not be removed or an older adapter reported it, cannot bring it back. The list holds Sotto thread IDs only, never a title or a word.

**7. A paired host's threads.** **Delete thread…** reaches a host's thread through the remote command allow-list, as Settle does. Deletion is a destructive command, so it needs the remote-answer policy, like `usage-clear`. A host offers the host feature `thread-delete` once it can; for a host that does not, the item is shown off with "Update <host> to delete its threads". Clear now and the automatic rule act on the computer whose Settings set them; Settings says so. Paired phones get the whole thread list in each shell, so a deleted thread leaves their list with no protocol change; neither phone app offers deletion.

**8. Stable shows nothing of it.** The renderer asks `useOwlFeature('clear-threads')` before drawing the Settings section or the menu item; main reads the answer once at start and runs no automatic rule without it. The setting is saved on every track, so sending the feature to stable keeps the user's choice.

**9. Logs carry event names only**: `threads-cleared` with a count, and `thread-clear-kept` with the reason's code, never a title, path or branch. The automatic rule logs `threads-cleared` only for a run that cleared something and logs no kept reasons, since it keeps the same threads back every hour.

## Considered options

- **A, on the Settled shelf**, with Delete on each settled row and **Clear…** on the Settled heading. Zach chose the Settings section instead.
- **B, select and delete in the sidebar** (T3 Code's way). More presses for the common case, and a selection mode the sidebar does not otherwise need.
- **A trash kept for seven days.** The words stay on disk for that week, and a cleared thread has to stay out of every snapshot while it waits. Settle already is the reversible step.
- **A short Undo notice.** A deletion that waits ten seconds before it commits is a deletion that a crash in those seconds either loses or undoes.
- **Deleting the record alone.** It is what T3 Code does, and in Sotto the next provider snapshot would bring the thread back under its alias.
- **Deleting the provider's own session files.** They are the provider's and the user's, outside Sotto's folder, and the user may resume them in the provider's own app.

## Consequences

"There is no delete" in ADR-0041 is no longer true; its considered option now points here. `ThreadStore.forget` has a caller. `AgentHost.forgetThread` is new, and each adapter implements it by stopping the thread's process if it has one, removing its alias record and saving. The coordinator gains `delete-thread`, `preview-clear-threads` and `clear-threads`. Settings gains `clearSettledThreadsAfterDays`, on the IPC patch allow-list. The cleared-ID list grows by one short ID per cleared thread and is read as a set, so a snapshot's work does not grow with it.
