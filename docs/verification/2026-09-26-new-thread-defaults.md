# A new thread opens straight away, on defaults from Settings (#347)

October 9, 2026: Voice control and thread management described below are historical under [ADR-0065](../adr/0065-remove-voice-control-and-thread-management.md); the original plan or evidence is retained.

Checked on September 26, 2026, on Windows, in the built app (`npm run build`, then `npx playwright test tests/e2e/thread-creation.spec.ts tests/e2e/settled-folder-new-thread.spec.ts tests/e2e/thread-agent-inheritance.spec.ts tests/e2e/workspace-projects.spec.ts tests/e2e/thread-worktrees.spec.ts --workers=1`, plus a one-off capture run for the 1600x1000 and reduced-motion pair below). The captures are in `artifacts/new-thread-defaults/`. The design is variant b of the prototype on `prototype/new-thread-defaults`, with the composer's own model selector.

## Starting a thread

- `fresh-thread-dark-1280.png`, `fresh-thread-light-820.png`, `fresh-thread-dark-1600.png` and `fresh-thread-dark-1600-reduced-motion.png`: the pen on a project row opens an empty "New thread" in that project at once, selected, with its composer focused and the default model, effort and permissions on its chips. No dialog opens. The thread names itself from its first exchange.
- Pressing the pen or the shortcut again while the project has a new thread that was never used (default title, no message, at rest, not settled) returns to that thread instead of opening another, so an accidental press leaves nothing behind (`tests/unit/renderer/unusedNewThread.test.tsx`).
- `chooser-dark-1280.png` and `chooser-light-820.png`: the sidebar's top **New thread** button asks only which project; choosing one opens the thread the same way.
- The Agents room's own managed flow is unchanged: it still asks name, model, reasoning effort and permissions in its own form once a project is chosen, before the thread opens (`tests/unit/renderer/newThreadProjectCreation.test.tsx`, "the managed flow's own form").
- **Ctrl+Shift+N** opens a new thread in the focused thread's project, or the chooser when no thread is focused. It stands down when the dictation hotkey claims the chord (`tests/unit/renderer/newThreadShortcut.test.ts`).
- A new thread in a settled project still returns the folder to Projects with only that thread, and the working-copy default (project folder or new worktree) still applies (`settled-folder-new-thread.spec.ts`, `thread-worktrees.spec.ts`). Settings unreadable at that moment refuses the creation instead of guessing a shared checkout (`tests/unit/renderer/newThreadProjectCreation.test.tsx`).
- A creation the app refuses says plainly that it is gone from here and that anything typed into it is kept for the project's next new thread, which is what actually happens: the sidebar carries the text over rather than losing it (`tests/unit/renderer/agents/threadCreationRecovery.test.tsx`, "carries text typed before a refusal").
- The coordinator's and voice's own threads (a spoken "start a thread in…") also follow the new-thread defaults now, the same as every other unconfigured creation, instead of the older reasoning-model default (`src/main/agents/control.ts`).

## The defaults

- `settings-agents-dark-1280.png`, `settings-agents-light-820.png`, `settings-agents-dark-1600.png` and `settings-agents-dark-1600-reduced-motion.png`: Settings → Agents has a **New threads** group with one row, **New threads start with**, holding the composer's model, effort and permissions chips. The reasoning rows sit under **Personal chats and reasoning**, and the project rows under **Projects**. At 1280 and 1600 the chips sit on one line; at 900 and below and at 820 they wrap without being squeezed into a narrow fixed column.
- `settings-agents-model-menu-dark-1280.png` and `-light-820.png`: the model chip opens the composer's own model selector, grouped by provider.
- The permissions chip lists **Provider default** at the top of its own menu, so a chosen default can go back to unset the same way the composer's own chip does (`tests/unit/renderer/newThreadDefaultsSettings.test.tsx`).
- Main applies the defaults to any new thread that leaves an option unset, including the coordinator's and voice's; a thread's own choices win (`tests/unit/main/newThreadDefaults.test.ts`). A default effort the chosen model lacks maps to the nearest level it has by relative position, never jumping to the top for an effort with no position to map from — that falls back to the provider's own default instead (`tests/unit/shared/newThreadDefaults.test.ts`). A permissions default the provider lacks falls to its nearest safer mode (Grok: Allow edits → Ask for approval), which the row says, and Devin starts on its first profile.
- An existing install keeps today's behaviour until the user picks: the model comes from the reasoning model, and effort and permissions stay at the provider's default.

## Unchecked

- macOS.
- Paired remote clients cannot change the new-thread defaults; they stay a desktop setting.
