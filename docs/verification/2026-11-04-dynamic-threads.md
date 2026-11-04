# Dynamic threads in the built app

November 4, 2026, on forge (Linux), in the built app over the real Claude Code and Codex adapters and the fake CLIs in `tests/fixtures/`, and against the real clients for the one thing the fakes cannot show. Records ADR-0191's switch, rows and limits.

`tests/e2e/dynamic-threads.spec.ts` covers these journeys:

- **Dynamic before the first message.** The client is launched with the overseer's instructions and no role agents.
- **Dynamic after it.** One overseer note goes through the prompt hook with the next message, the message stays as typed, and the message after it carries none.
- **An overseer's worker.** A provider off the list is refused, ticking it lets the start go, and an effort over the limit is held. The row names the model and effort, gives the reason, and says the effort was held. Its ··· opens the thread or stops the worker, and Escape returns the focus to the ···.
- **The switch.** It is off at first. The first press asks once and names the companies. Escape leaves everything as it was and returns focus to the chip, **Choose providers** opens the card and turns nothing on, **Turn on** makes the list, and from then on Space on the switch just switches. The chip reads "oversees".
- **The Settings card.** It lists each provider with its company, and unticking one, Highest effort and Workers at once all save.
- **Both themes at 1600x1000, 1280x800 and 820x560.** Nothing overflows or clips, the menu's foot sits inside the window at the smallest size, and the card's text meets 4.5:1.
- **Stable.** The command is refused.

`tests/unit/renderer/threadDelegation.test.tsx` holds a row on stable to an ordinary row and a row whose reason has gone to its model, effort and menu. `tests/unit/renderer/features/settings/dynamicThreadsSettings.test.tsx` holds a quick second change to the first, and a limit's change to leaving the list unmade.

`tests/integration/dynamicThreadInstructionsLive.test.ts`, behind `SOTTO_CLAUDE_LIVE` and `SOTTO_CODEX_LIVE`, ran against Claude Code 2.1.318 and Codex 0.166.0. Run by hand against Claude Code's CLI, a new appended prompt on `--resume` is ignored and the session's first one is kept. Against both real clients through the adapters, an overseer note reaches the model on a session that has already started.

## Screenshots

In `artifacts/dynamic-threads/`:

- `row-dark-1280x800.png`: a worker's row, with its model, effort and reason, and the composer reading "Opus 5.5 oversees".
- `menu-dark-820x560.png`: the switch at the foot of the model menu at the smallest window.
- `settings-light-1280x800.png`: the Settings card in the light theme.

## Not checked

- Windows and macOS, which CI's desktop job covers for what it runs, and by hand when Part 7's comparison runs.
- A real overseer choosing well. That is Part 7 of `docs/plans/dynamic-threads.md`, and nothing here says it does.
