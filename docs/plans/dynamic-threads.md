# Dynamic threads

Approved by Zach on November 4, 2026, to build in this order. The decisions are in [ADR-0191](../adr/0191-a-dynamic-threads-model-oversees-and-chooses-a-model-for-each-piece.md). The mock-up is kept at the tag `prototype/dynamic-mode`.

## Zach's picks, November 4, 2026

- **The picked model oversees and does no work itself.** Told, and marked if it edits.
- **A Dynamic thread ignores the role cards.** Other threads keep following them.
- **It reads** limits left, what each model can do, its record and the user's note. The last two come after the first version.
- **Limits move workers.** If the overseer's own provider stops, the thread stops as today.
- **Switch A:** the foot of the model menu, and the composer reads "Opus 5.5 oversees".
- **Steps 1:** a row per worker in the Worked for fold, with its model, effort and reason.
- **One allowed list**, plus highest effort and workers per message. No keep-back and no speed setting.
- **An Owl feature.**

## Zach's picks on what the code raised

- **The allowed list is firm even against the user's own words.** This is the privacy line, so a press in Settings is the one place it changes. The overseer says to tick it there.
- **A first-use dialog** names the companies the first time Dynamic is turned on.
- **"Workers per message" means at once.** Four at a time, with the next starting as one returns.
- **A worker may delegate,** held to the list and to Highest effort. He turned down a rule that workers could not delegate at all.
- **Dynamic can change mid-thread, by a note.** The live check found that real clients ignore new instructions on resume, so a change after the first message goes as one **overseer note** with the next message.
- **#1202 lands first:** the role holds, and the result says so, unless the user's newest message names the model.

Already the rule in the code:

- **Ultracode is never the overseer's to choose.** ADR-0148 and `delegate` already refuse it.

In the plan Zach approved, without a card of their own:

- **No swarms on a Dynamic thread.** A swarm's lead, counts and model come from a role.
- **No effort offer on a Dynamic thread.** Its model does none of the work the offer speaks to.
- **A provider that reports no limits starts unticked,** as the mock-up drew it.
- **Give it to another model…** comes after the comparison. The first version's ··· holds Open this thread and Stop this worker.

## Order

Main first, so the switch never appears before it does something. Each part is one pull request. Part 1 goes to stable on its own; every other part is behind `dynamic-threads`.

| Part | What | Needs |
| --- | --- | --- |
| 0 | ADR, glossary and README | Nothing |
| 1 | #1202: roles hold on every other thread | Part 0 |
| 2 | The record and the settings | Part 1 |
| 3 | The overseer's instructions and the mark | Part 2 |
| 4 | `delegate` on a Dynamic thread | Parts 2 and 3 |
| 5 | Rows | Part 4 |
| 6 | The switch and the Settings card | Parts 3, 4 and 5 |
| 7 | The comparison on real tasks | Part 6 |
| 8 | Later: record, note and the rest | Part 7's result |

## Part 0: ADR, glossary and README

The documents in this change: the ADR, `CONTEXT.md`'s **Dynamic thread** and **Overseer**, and the README paragraph that AGENTS.md asks for before a patch. Tag the prototype.

## Part 1: #1202

Sotto should hold a thread to its role, or Dynamic's freedom can't be told from a thread ignoring its settings. Zach's pick: Sotto starts the role's model whatever the call names, and the result says so. The user's own words get through because main checks them. It reads the user's newest message from Sotto's record for the model's name, as a **told request** does for Watcher's, and never takes a model's word for what the user said. It stands alone and ships to stable by itself.

Done when a thread that isn't Dynamic can't start role work on another model unless the user's newest message names it, and the result says which model ran.

## Part 2: The record and the settings

- `src/shared/owlFeatures.ts`: add `dynamic-threads`, with this ADR as its owner.
- `src/shared/agents.ts`: an optional `dynamic` mark on the thread, Sotto's own, beside `continuedFrom`. `workspace.ts` keeps it across restarts.
- `src/shared/settings.ts`: `dynamicThreads` with `providers`, `highestEffort` and `workersAtOnce`, each read one at a time so a damaged value costs only itself. Add it to the patch allow-list in `src/main/ipc/registerIpc.ts`.
- A command that sets the mark at rest and is refused while a turn runs or a request waits.

Tests: `tests/integration/settingsHistoryIpc.test.ts` catches a missing allow-list entry. Unit tests for the schema's defaults and a damaged row. With the feature off, the settings and the mark stay whole and the command is refused.

## Part 3: The overseer's instructions and the mark

- `src/shared/workerRoles.ts` or a new `src/shared/dynamicThreads.ts`: one function that writes the standing instructions. No edits, a piece per worker, name the model with `why`, prefer room, one writer at a time in a shared checkout.
- `src/main/agents/claude.ts` (`subagentRoles`, `--append-system-prompt`) and `src/main/agents/codex.ts` (`launchRoles`, `developerInstructions`): on a Dynamic thread, send these in place of the role table and leave out the role agents.
- A thread set before its first message starts on these instructions. One that changes later owes an **overseer note**, which the workspace puts on its next send, through the channel Watcher's request note uses (`claude.ts`'s prompt hook, `codex.ts`'s `additionalContext`). A change at rest also lets go of the idle process, so the next one starts without role agents, or with them.
- `src/main/agents/watcherOwnChanges.ts` and `src/renderer/src/watcher/WatcherOwnChange.tsx`: let the mark serve an overseer too. It names the model, and the thread's transcript draws it when `speaker` is not Watcher.

Tests: integration over the fake Claude Code and Codex for what each launch and reload sends, and for the role table's absence. The live check below.

**Checked on the real clients, November 4, 2026.** Both obey instructions given at creation and ignore new ones on resume, and both obey an overseer note. `dynamicThreadInstructionsLive.test.ts` stays behind `SOTTO_CLAUDE_LIVE` and `SOTTO_CODEX_LIVE`. This also means a changed role table doesn't reach a resumed thread's instructions, which ADR-0091 decision 9 assumed; that is its own follow-up.

## Part 4: `delegate` on a Dynamic thread

All in `src/main/agents/delegation.ts`, `delegationTools.ts` and `src/shared/delegation.ts`:

- Skip `startFromRole` for a Dynamic caller, which is the existing path for a start with roles off.
- Add `why`, a short line, and `replaces`, a delegation ID. A Dynamic caller's new thread needs `why`.
- Refuse a provider off the list with a new recorded refusal, in plain words, naming where to change it.
- Hold effort to **Highest effort**, with the receipt saying so.
- Turn down a start past **Workers at once**, unrecorded, with what to do next.
- Refuse `count` above one, and a machine other than This computer.
- A start by a Dynamic thread's worker finds the Dynamic thread above it and is held to its list and **Highest effort**.
- `listing`: only allowed providers, adding what each can do and its limits left, read through `UsageService` when the tool is called.
- A delegation stopped by a limit says the provider and reset, in its read and its news.
- `replaces` links the rows and calls `LimitRestart.cancel` for the old thread. If that restart has already gone, it stops the old thread as `cancel_delegation` does.

Tests: a new `tests/integration/delegationDynamic.test.ts`, on `delegationByRole.test.ts`'s pattern, one case per line above, a worker's own start and a restart that has already gone among them, plus a wake-up reaching an overseer that was stopped at a limit once it restarts. If `listing` copies state, its line goes on `tests/fixtures/copySites.json` with its reason. Nothing here runs on the update path, so `streamingCopyBudget` and `ownerScaleWorkBudget` should not move.

**Check first.** `delegate`'s schema takes any provider ID, while its description names five. Whether a start reaches Cursor, OpenCode and DeepSeek Harness gets read and tested here. Any that can't stay out of the list.

## Part 5: Rows

`src/renderer/src/agents/DelegatedWork.tsx`, `delegation.css` and the shared view: the model, the effort and "Why:" on a row whose thread is a Dynamic thread's worker; a ··· with **Open this thread** and **Stop this worker**; "3 workers on 2 providers" on the Worked for line; the held-effort line; a moved row naming the row it replaced. Rows on other threads don't change. The reason follows Keep local history as a check's reply excerpt does.

Tests: unit tests of the row's words. `tests/e2e/thread-delegation.spec.ts` gains a case. Colour stays on `--tt-*` tokens, and a state keeps its word and its shape.

## Part 6: The switch and the Settings card

- `src/renderer/src/agents/ModelPicker.tsx` and `modelPicker.css`: the foot row. It keeps the menu one height (#1596) and takes focus in order after the list.
- `src/renderer/src/agents/ThreadOptions.tsx`: "oversees" after the model's name, with the accessible name "Choose model. Now Opus 5.5, overseeing"; no effort offer.
- The first-use dialog, with Escape, and focus returning to the model chip.
- A card in Settings → Threads with the list, its limit readings and the two limits, and its entries in `settingsPages.ts` for Find a setting.
- Docs: `docs/guide.md`, `docs/agent-control.md` and README's feature list.
- `tests/e2e/dynamic-threads.spec.ts`, over the fake clients: both themes at 1600x1000, 1280x800 and 820x560, with text contrast. No motion is added. A note in `docs/verification/` with its screenshots in `artifacts/dynamic-threads/`.

A new stylesheet goes on the `owned` list in `themeTokens.test.ts`. Baselines change only if a captured page does; with the switch off, none should.

## Part 7: The comparison on real tasks

Before Zach decides on stable, and before the later parts. About five real tasks, a one-line fix among them, each run twice: once on a Dynamic thread and once on today's roles. Measured from Usage and the delegation records, in a note in `docs/verification/`:

- Tokens and limits used, by provider.
- Time to finished.
- How often Zach overruled a pick.
- How often it picked its own maker.
- Pieces moved, and edits the overseer made itself.

Proposed bar, for Zach to change: it goes on if it uses no more limit than roles on the larger tasks and he overrules fewer than one pick in five. Otherwise the result says which half failed. Five tasks is small, so the note reports them one by one and never as an average that claims more than it can show.

## Part 8: Later

In the order the comparison points to:

- **Its record:** counts per model on this computer, on Usage's numbers-only terms, with a clear press.
- **The user's note.**
- **Give it to another model…** on a row's ···.
- **More overseers:** Grok Build, whose rules are set only at creation, and Muse, whose instructions go with each message.
- **The iPhone's switch, paired hosts, and Watcher starting Dynamic threads.**
- **A per-project allowed list,** if client work calls for it.

## Not in this

A change during a turn (#2160), a keep-back setting, a chosen speed, swarms on a Dynamic thread, and continuing on another provider without a press.
