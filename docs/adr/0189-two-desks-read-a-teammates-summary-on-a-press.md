# Two desks read a teammate's summary on a press, and Sotto orders the advice

## Status

Accepted November 4, 2026, by Zach's picks on question cards, from the prototype kept at the tag `prototype/teams-desks` (variant A, read on a press, order 1). It is the second slice of `docs/plans/teams-watchers.md`, part of the Owl feature `teams` (ADR-0072). Amends [ADR-0186](0186-a-team-link-joins-two-owners-computers-over-a-closed-list.md), decision 5, which said a later slice that wants a command adds it on purpose, and decision 6.

## Context

The first slice let two Watchers ask each other two things. Zach also asked for two desks, his and Drake's side by side, with the merge order across the top. His November 2 drawing had a conversation on each desk, a composer, an "online" line and an answer card. ADR-0186 and ADR-0187 have since ended all of those, and the asks and answers already show in Watcher's conversation.

A merge order needs facts in a shape Sotto can sort, and a written answer is not that. Zach's rule still holds: "We need to be very careful with this we don't want to be sending a ton of data back and forth."

## Decision

**1. Each desk shows work.** Your threads and open pull requests beside your teammate's, opened by **Open two desks** on a link's card on the Teams tab. It has no composer and sends no words. Asks still go through Watcher.

**2. A fourth command, `read-desk`, carries the desk.** It takes nothing but the token. Its answer is a **team desk**: the team summary's facts (each thread's title, project and where it stands, and its open pull requests' numbers, titles and whether each is a draft), plus how each pull request's checks stand and when Sotto first saw them pass. Each pull request carries a short hash of its address, so two desks can tell it is the same one while the repository's name stays on its owner's computer. Left-out projects are gone before it is built, as they are for an answer. It holds no thread's messages, tool output, file names or paths, and no project keys or machine names.

**3. A read runs no model.** Sotto builds the answer from the facts, so it costs neither owner any usage and has no writer for words to steer. It does not start a Watcher turn, and it has no path to a thread, a card or a permission. Nothing in it reaches Watcher: it makes no **teammate's message**, and `read_teammate_messages` cannot return it.

**4. Only a press reads it.** **Get Drake's desk** reads once, and the desk says when until the next press. Opening the desks, leaving them open and a restart send nothing. A failed read is not retried and nothing waits to send.

**5. A read is small, and the owner sees each one.** A desk is at most 40 threads with 5 pull requests each, its texts cut at 160 characters, within 32 KB; threads past that are counted and not sent. The answering computer turns down more than 10 reads from one link in any 10 minutes. Its Teams tab lists the newest 100 reads it answered, by name and time, in a fold under **Latest**. The list holds no words, so it stays with **Keep local history** off.

**6. A desk that was read stays in memory.** It goes when Sotto quits or the link goes. Another owner's thread titles are not written to this computer's disk for a view.

**7. Your own desk is what you share.** It reads the same facts on this computer, without the projects you left out, and refreshes while it is open. Showing the left-out ones would give each owner a different order, and show them something their teammate never sees as if it were shared. It says so when something is left out.

**8. Sotto works out the merge order, and it is advice.** Pull requests with checks passed come first, the oldest pass first, as in the **merge queue**. Then checks running, checks not read and checks failed, each by number, and drafts last. The order does not depend on whose computer works it out, so two owners with fresh desks see the same one. A pull request both desks hold shows once: a reading beats none, the less hopeful of two readings wins, the earlier pass time wins, and a draft on either side is a draft. There is nothing to arrange and nothing else crosses. It merges nothing and offers no merge, and each owner merges under their own confirmation (ADR-0186, ADR-0187).

**9. Checks not read says so.** Sotto reads a pull request's checks for the threads Watcher watches. A pull request it has no fresh read of shows **checks not read** and sorts after those running, rather than being guessed at. Reading more would add GitHub traffic for a view.

## Options rejected

- **Conversation desks,** the November 2 drawing: they repeat rows Watcher's conversation shows, and still need these facts for an order.
- **Merge order first,** a table with the desks below it: Zach chose the desks.
- **Reading once on each open:** every glance would send something.
- **Answers only, with no new command:** the least data, but words cannot be sorted into an order.
- **Arranging the order by hand, or sending a suggestion:** either lets two owners hold different orders or adds another command and more traffic, for advice.

## Failure modes

- **The other computer is off or unreachable.** The desk says it did not answer and that nothing is waiting. A desk read earlier stays with its time.
- **The link ran out or was removed.** The desk says so and what to do. An expired link's token still reads nothing.
- **Too many reads.** The desk says to try again in a few minutes.
- **A desk larger than the budget.** It says how many threads did not fit.
- **Files that collide.** The order cannot see them, because file names never cross. It says so where it shows, and overlap stays between the two owners.

## Consequences

- The closed list has four commands. `README.md`, `CONTEXT.md` and `docs/guide.md` say so.
- A team desk adds one thing to what ADR-0186 and Drake's agreement covered: how checks stand. The Teams tab's **What you share** says it, and the leave-out list applies.
- `src/main/teams/` still imports nothing from the host protocol's command path.
