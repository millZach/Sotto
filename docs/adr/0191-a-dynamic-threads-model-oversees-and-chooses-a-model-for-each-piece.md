# A Dynamic thread's model oversees and chooses a model for each piece

## Status

Accepted November 4, 2026, by Zach's picks on question cards, from the prototype kept at the tag `prototype/dynamic-mode` (switch A, steps 1). **Number provisional until merge** (`docs/agents/domain.md`): #2170 holds 0190.

It is an Owl feature (`dynamic-threads`, [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)). The build order is `docs/plans/dynamic-threads.md`.

It amends [ADR-0081](0081-a-thread-may-delegate-work-to-threads-it-starts.md) (decisions 7 and 9), [ADR-0091](0091-worker-roles-say-what-each-kind-of-work-starts-on.md) (decisions 4 and 9), [ADR-0144](0144-stopped-threads-restart-when-their-limit-resets.md) (a moved piece's restart) and [ADR-0172](0172-zachs-composer-is-the-only-composer-and-its-effort-word-offers-a-level.md) (no effort offer on a Dynamic thread). It changes nothing in [ADR-0002](0002-sotto-owned-thread-identity.md), [ADR-0004](0004-authority-in-policy-records.md), [ADR-0089](0089-a-thread-continues-on-another-provider-as-a-new-linked-thread.md) or [ADR-0148](0148-ultracode-is-the-effort-level-past-max-on-claude.md).

## Context

Zach: "a dynamic mode in Sotto for threads. Essentially, what this would do is have an overseer model that chooses the best model and effort level for a given task. Rather than having hard-defined roles like we have right now, this would be dynamic… The user would still select the model they want to run, and then there would be a secondary option asking whether they want to run in dynamic mode."

This goes against two earlier decisions, on purpose. ADR-0091 exists because "the right model for the work was whichever one the agent thought of". #1202, still open, is Zach asking "Why are they able to ignore my setting?" after threads kept starting reviews on a model he had changed away from. Dynamic asks for that freedom only where the user turns it on, and only inside limits they set.

The case for it is that only Sotto sees every subscription. A provider's own automatic choice, such as Cursor's Auto, picks inside one plan. Roles move on when a provider disconnects, never when it is nearly used up, and nothing today suggests less effort than the level set.

The case against it is recorded under Consequences. It chooses on reputation until a record exists, every message pays for two models, and code can reach a company the user did not pick for that thread.

What providers allow decides the shape. A thread stays on one provider session for life (ADR-0002, ADR-0089), so reaching another subscription takes another thread. Nothing changes during a turn: Sotto refuses it, and Codex's `turn/settings/update` needs a feature that is off and still in development (#2160). `delegate` can already start a thread on a named model. So the overseer stays where it is and hands work to threads it starts, and no provider has to switch anything.

## Decision

**1. A switch on one thread.** **Dynamic** is a switch at the foot of the model menu, off by default, with the sentence "Opus 5.5 oversees and chooses a model for each piece. It does no work itself." With it on, the composer reads "Opus 5.5 oversees". It changes only at rest, and the thread's provider session reloads at the next send, since Claude Code and Codex read standing instructions when a thread loads. The thread keeps its Sotto thread ID and provider session.

The first time the user turns it on, a small dialog names the companies the allowed list would send work to, with **Turn on** and **Choose providers**. After that the switch just switches.

**2. The overseer does no work itself.** The model the user picked plans, briefs workers, reads what they return and answers the user. Its standing instructions tell it not to edit project files or run changing commands. If it does anyway, its reply is marked with the files and its reason, or "It gave no reason", as Watcher's is (ADR-0073). It is told and marked, not blocked. A block would need each provider's own proof and a new ceiling for its workers, and Zach moved Watcher off read-only on October 13, 2026.

It may read code, so its briefs and its checks of a worker's result are its own.

**3. Authority does not move (ADR-0004).** The composer's shield is the most a worker may do, held to the user's new-thread default as every delegated thread is (ADR-0081 decision 4). The user answers every worker's question and permission card, which also stands in the overseer's pane. Choosing a model grants nothing.

**4. Every piece goes to a delegated thread.** Pieces on the overseer's own provider go the same way, so each one has its model, its row and a thread the user can open. Stop on the overseer stops them all (ADR-0081 decision 6). A worker is an ordinary delegated thread. Its own sub-agents and its own `delegate` follow the role cards, as any thread's do.

**5. It ignores the role cards.** A Dynamic thread carries no role table and no `sotto_<role>` agents. Its `delegate` fills in nothing from a role, so a start names its provider, model, effort and permission, as it did before worker roles. Roles stay exactly as they are for every other thread. When #1202 lands, a Dynamic thread is the one exception it leaves open.

A start with `count` above one is refused on a Dynamic thread, because a swarm's lead, counts and model come from a role.

**6. A worker may delegate, inside the limits.** A worker can start one more thread, as any delegated thread can (ADR-0081 decision 2). Sotto finds the Dynamic thread above it from the link between them and holds that start to its allowed list and **Highest effort**, so the list cannot be walked around one level down. Zach chose this over a worker not delegating at all.

**7. One allowed list, and it is firm.** Settings → Threads holds one list of providers for every Dynamic thread on this computer. `delegate` refuses a provider off the list in plain words, even when the user's message names it, and the overseer tells the user to tick it in Settings. Instructions can be ignored; this cannot. A provider that reports no limits stays off the list at first, and its row says it would be chosen blind.

**8. Two limits beside the list.** **Highest effort** holds any worker's effort, Extra high by default. A higher one is held to it and the row says so, as a ceiling holds a permission. **Workers at once**, four by default, counts the overseer's own workers. It turns down a start beyond it without recording a row, unlike the refusals in ADR-0081 decision 7, since nothing is wrong with the piece, and the overseer starts the next when one returns. The machine's **ceiling** still applies. Workers stay at Standard speed unless the user's message asks for more, which the overseer is told and the row shows. Ultracode stays the user's own choice, never an agent's (ADR-0148).

**9. What it reads when it chooses.** `read_delegation` with no delegation already lists ready models with their efforts, speeds and permissions. On a Dynamic thread it lists only allowed providers and adds what each model can do and its limits left: percent used, reset time and when that was read. Usage's reads supply them (ADR-0083). Some providers answer at any time and Muse only from a running thread, so a reading can be old, and each says when it was read. A provider with no reading says so. This runs when the tool is called, never on the update path.

Two more come later: **its record**, how each model's earlier pieces ended on this computer, in counts and no words, cleared with a press; and **the user's note**, a few lines in Settings sent with its standing instructions. The note is advice, so a provider that must not be used belongs off the list.

**10. Running out.** The overseer is told to prefer providers with room. A worker stopped by a limit has an outcome that says which provider and when it resets. Giving the piece to another model names the old delegation in `delegate`'s `replaces`, which links the two rows and cancels the old thread's restart (ADR-0144), or stops the old thread if its restart has already gone, so two models don't carry on with the same piece. Partial work stays in the folder and the new brief says so.

If the overseer's own provider stops, the thread stops as any thread does: **Restart** at the reset, or **Or continue now on** with a press (ADR-0089). Workers on other providers go on, and their results wait for its next turn. Sotto never continues a thread on another provider without a press.

**11. What a turn shows.** One row per worker in the **Worked for** fold, as **delegated work** already draws them, adding its model, its effort and a line "Why:" in the overseer's words, from `delegate`'s `why`. The Worked for line adds "3 workers on 2 providers". The reason follows Keep local history and never reaches a log.

The user overrules it by naming a model in a message, by **Stop this worker** on a row's ···, by opening a worker and typing there, which pauses delegated sends (ADR-0081 decision 6), or by turning Dynamic off. **Give it to another model…** joins that ··· later.

**12. No effort offer.** The **effort offer** does not stand on a Dynamic thread. It speaks to how hard the thread's model should think about the draft, and this model does none of that work.

**13. Where it runs first.** This computer, with Claude Code or Codex as the overseer, because their standing instructions are checked (ADR-0091 decision 9). The switch is absent on other providers and on a thread on a paired host. A worker starts on This computer. The iPhone shows a Dynamic thread's rows as delegated work and has no switch. Watcher can watch and message a Dynamic thread and cannot start one.

**14. Stable has none of it.** With the Owl feature off, no switch or Settings card shows, and a thread saved as Dynamic runs as an ordinary thread with its mark and settings kept whole.

**15. README first.** "Privacy and cost" gains a paragraph in the same change as this record. No new host is added: each provider's own client reaches its own company, as it does for any thread.

## Considered options

- **Stay and hand off, doing small work itself.** The brainstorm's recommendation, since a one-line fix then pays for one model. Zach chose an overseer that does no work.
- **Change the thread's own model each turn.** No cold starts, but it stays on one provider and cannot reach another subscription.
- **Use the role cards as a starting point.** The brainstorm's recommendation, since the cards are the best evidence of what works. Zach chose to ignore them on a Dynamic thread.
- **A plain rule: a role moves to its next default near a limit.** It gets part of the limit benefit with no overseer, and remains worth doing on its own. It does not choose by task.
- **Trial by prompt before any record.** A thread told to act as overseer, on real tasks, needing no code. Zach chose to write this first. The plan runs that comparison before this goes to stable.

## Consequences

- Every message pays for two models, even a one-line fix, and each worker starts cold. A trimmed Claude sub-agent's first turn still costs 6.6k tokens (ADR-0091).
- Until **its record** exists, it chooses on limits, abilities and what it believes about models, which is thin for models newer than it. It may favour its own maker. Nothing has tested this yet, and the plan measures it.
- Without a keep-back setting, the overseer alone decides when a provider is too close to its limit, until a worker actually stops. A reading can be stale, and each computer has its own.
- Two workers writing in one checkout would collide. The overseer is told to run one writer at a time there, or to give a worker its own worktree. That is told, not enforced.
- Limits are per computer and per provider, so what it sees can be wrong when the user works outside Sotto on another machine.

## Proof

To be written with the build (`docs/plans/dynamic-threads.md`). Integration over the fake providers for the allowed list, held effort, workers at once, `replaces` cancelling a restart, a worker's own `delegate` held to the list, instructions at launch and reload, and all of it absent with the feature off. An end-to-end journey for the switch, a row with its reason and the Settings card. A comparison on real tasks, in `docs/verification/`, before Zach decides on stable.
