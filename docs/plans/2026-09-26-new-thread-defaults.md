# Open a new thread straight away, on defaults from Settings (#347)

October 9, 2026: Voice control and thread management described below are historical under [ADR-0068](../adr/0068-remove-voice-control-and-thread-management.md); the original plan or evidence is retained.

Starting a thread in an existing project opens the **New thread** dialog every time: folder, then a collapsed **Thread options** (name, model, reasoning, permissions), then **Create thread**. Zach asked for it to open straight away on defaults kept in Settings → Agents, with permissions added to them, and for a shortcut.

## Today (read on `main`, September 26, 2026)

- The dialog is `NewThreadDialog` (`src/renderer/src/agents/NewThreadDialog.tsx`), opened by the pen on a project row (`ThreadSidebar.tsx`, straight to that project), the sidebar's top **New thread** button (project chooser first), the same buttons from other pages (`PageSidebar.tsx` through `threadIntent.ts`), the empty Threads page's button (`ThreadsView.tsx`), and the Agents room (`AgentRoom.tsx`, managed).
- Its model default is `defaultThreadModelId` (`src/shared/agents.ts`), inherited from Settings → Agents' reasoning model. Effort and permissions start at the provider's default. Settings → Agents' reasoning effort is used only by personal chats and the coordinator, and nothing holds a permissions default.
- Permissions are Sotto's four runtime modes (`agentRuntimeModeSchema`: approval-required, auto-accept-edits, auto, full-access). Claude and Codex offer all four, Grok has no auto-accept-edits, and Devin offers its own profiles (`providerModes`). Left unset, Claude and Grok ask for approval and Codex allows edits.
- The working copy (project folder or new worktree) already comes from Settings, not the dialog.

## Decisions (Zach, September 26, 2026)

1. **The project buttons skip the dialog.** The pen on a project row and the empty Threads page's button open an empty thread at once, with the composer focused, on the defaults. It is titled "New thread" and names itself from the first exchange. The sidebar's top **New thread** button still asks which project, and only that: choosing one opens the thread the same way. The Agents room's own new-thread flow is unchanged.
2. **New threads get their own defaults**, apart from personal chats' reasoning model and effort: model, reasoning effort and permissions. Settings → Agents shows them as one row, **New threads start with**, holding the composer's own chips (prototype variant b), with the model chip being the composer's model selector grouped by provider. The existing reasoning rows sit under their own heading for personal chats and the coordinator.
3. **One permissions default, nearest fit.** The default is one of the four modes. A provider that lacks it starts on the nearest safer mode it has (Grok: Allow edits → Ask for approval), and Settings says so under the row when the chosen model's provider lacks it. Devin starts on its first profile. A default effort the chosen model does not offer falls back to the nearest level it does.
4. **Ctrl+Shift+N** (Cmd+Shift+N on a Mac) opens a new thread in the focused thread's project, or the project chooser when no thread is focused. It is checked against the dictation hotkey like every other chord, and an open dialog or a terminal keeps its keys.

Prototype: on branch `prototype/new-thread-defaults` (variant b picked, with the composer's grouped model selector).

Also shipped, beyond these decisions: a project whose folder was moved or deleted says so in plain words ("The folder … is not there any more. Move it back, or add the project again from where it is now.") instead of the file system's ENOENT text; the composer's own permissions chip and Settings' new row both offer "Provider default" the same way, so a chosen default can go back to unset; and Settings → Agents groups the new row, the personal-chat and reasoning settings, and Projects each under their own heading.

## Build

- **Defaults.** Where `defaultThreadModelId` and the reasoning configuration live (`AgentConfiguration`), add a new-thread model, effort and runtime mode, with their schema and a migration that keeps today's behaviour for an existing install (model from the reasoning model, effort and permissions unset). Main applies them to any `create-thread` that leaves an option unset, so the coordinator's and voice's new threads follow them too; a thread's own choices still win.
- **Nearest fit.** One shared function maps the default mode onto a model's offered modes, used by main when it creates a thread and by Settings for its note.
- **Instant thread.** The project buttons and the chooser create the thread directly (the same `create-thread` the dialog sent, with the project's working copy default), select it and focus its composer. A refused creation says why in the thread list's usual error place and loses nothing. `NewThreadDialog`'s options section goes; what remains of it is the project chooser.
- **Settings.** The **New threads start with** row reuses `ModelPicker`, `EffortPicker` and the permissions chip from `ThreadOptions.tsx`, saving as each changes.
- **Shortcut.** `mod+shift+n`, resolved per platform like the toolbar's chords, skipped when the dictation hotkey claims it.
- **Docs.** `CONTEXT.md` (new-thread defaults), `docs/guide.md` (starting a thread, the shortcut), `README.md` if it describes the dialog, and the older `docs/plans/new-thread-setup.md` pointed here.
- **Tests.** Unit tests for the nearest fit, the defaults' migration and the shortcut; renderer tests for the instant thread and the Settings row; IPC and settings tests for the new configuration; the Playwright specs that open the dialog updated to the new flow; design captures retaken for Settings → Agents and anything that showed the dialog.
