# Ultracode is the effort level past Max on Claude

## Status

Amended October 31, 2026, by [ADR-0172](0172-zachs-composer-is-the-only-composer-and-its-effort-word-offers-a-level.md) decision 5: the composer's effort offer may suggest Ultracode for work that splits across agents. Only the user's press picks it, as decision 6 has it.

Accepted October 26, 2026, at Zach's request. It goes straight to stable, Zach's call; it is not an Owl feature. The look was chosen from a prototype, kept as the tag `prototype/ultracode-effort`: variant A of the effort card (Ultracode as the next stop after Max) and variant A of the setting (a list). It replaces the line in `docs/agent-control.md` that said Ultracode was not offered because the adapter could not confirm workflow availability; decision 5 says what Sotto does about that instead.

## Context

Claude Code 2.1.311 has Ultracode: standing multi-agent workflow orchestration for a session, where the model authors and runs a workflow for every substantive task and token cost is not a constraint. It is not an effort level of Claude Code's: `--effort` takes `low`, `medium`, `high`, `xhigh` and `max`, and Ultracode is the `ultracode` settings key, set per session through `--settings` or the `apply_flag_settings` control request, with `/effort ultracode [on|off]` in the terminal. `--effort ultracode` is accepted as shorthand for Extra high with Ultracode on. Claude Code allows it on exactly the models that offer Extra high, and only while its dynamic workflows are on. Once set, it reminds the model on every turn; nothing has to be typed into a prompt. The keyword `ultracode` in a prompt opts in for that turn alone.

Read from the installed binary and checked against it with control requests that sent no prompt: `apply_flag_settings` with `ultracode` answers success, `get_settings` then shows it, and the answer is the same success on a model that cannot run it.

Zach asked to pick Ultracode in the effort control "similar to using any reasoning level": per thread, on the chip, applied to every message until another level is picked, and never typed into the draft the way **Add Ultrathink to prompt** is.

## Decision

**1. Ultracode is a level.** Claude Code's catalog becomes Sotto's with `ultracode` after the last level on every model that reports `xhigh` (`withUltracode`, `src/shared/ultracode.ts`). The thread saves it as `reasoningEffort: 'ultracode'`, validation, the chip, pending settings, a restart and a continued thread treat it as any level, and it is the model's highest level, so it wears the effort colour and plays the arrival. Its line names the level the agents run at; its stop, and the chip at that level, say "Runs a multi-agent workflow; uses many more tokens." on hover, Zach's words. The chip, the card's word and the thumb carry lucide's Workflow mark.

**2. Claude Code is told a real effort and the session setting, never an effort called ultracode.** At launch the CLI gets `--effort <level>` and `ultracode: true` in the `--settings` flag layer that already carries fast mode. Every other launch names `ultracode: false`, so a value saved in the user's own Claude Code settings never runs a thread as a workflow, as fast mode does (ADR-0143). A change in place is one `apply_flag_settings` with `effortLevel` and `ultracode` together, so the CLI never runs a workflow at a level the thread does not show; a change between two other levels names only the effort.

**3. The level underneath is this computer's setting, Extra high by default.** Zach prefers High and expects others to differ, so **Ultracode effort** sits under Compact idle threads on Claude Code's row in Settings → Providers: a list of Low to Max, with Extra high marked as Claude Code's choice. It is `claudeUltracodeEffort` in the agent configuration, beside `museDisableSandbox`, because the adapter that reads it runs on each host; Settings → Providers is this computer's page, so it sets this computer's, and a paired client may not change it. A model without the chosen level runs at the nearest level below it (`ultracodeRunsAt`).

**4. Every prompt goes at the setting's current level.** The CLI keeps a session's level until told, and the setting may change while a thread's CLI runs. Before each prompt on a thread at Ultracode, a steer included, the adapter compares the level it last told that CLI with the one the setting now asks for, and sends `apply_flag_settings` first when they differ. A CLI that does not confirm it still has Ultracode on at its old level, so the prompt goes ahead and the log names `claude-ultracode-effort-unconfirmed`.

**5. Sotto offers it where Claude Code says the model can run it, and says what it cannot see.** The success Claude Code answers does not say whether the workflow will run, and no frame Sotto reads says so either. Where an organisation or Claude Code's `/config` has dynamic workflows off, the thread runs the level without workflows; the guide says so rather than Sotto guessing.

**6. A person picks it.** It is offered in a thread's composer, New thread and Continue in a new thread. Watcher's own composer, worker roles and the agent setting do not offer it, and neither Watcher nor a thread's delegate tool lists it among a worker model's levels or starts a worker on it: it spends many times the tokens, so it is the user's choice for a thread. A new-thread default of Ultracode lands on another provider's highest level, since it ranks above Max, and no other default lands on it by its place, so a default at the top of another provider's list, such as Muse's Ultra, starts a Claude thread on Max.

## Consequences

- Ultrathink stays: it is a keyword for one prompt's thinking, not a level, and Zach chose to keep it beside Ultracode.
- A thread on another host names no level on the card's line, because this window does not read that host's setting; the host runs its own, Extra high unless set there.
- The agent configuration is a strict schema, so a desktop older than this change does not read the state of a host newer than it until the desktop updates. Every field added to it has done the same, `museDisableSandbox` among them.
- If Claude Code reports Ultracode per model or confirms it in a frame, decision 5 can tighten to that.
