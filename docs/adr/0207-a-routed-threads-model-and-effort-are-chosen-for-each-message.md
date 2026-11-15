# A routed thread's model and effort are chosen for each message

## Status

Accepted November 14, 2026, for an Owl feature pull request by the owner. The routing choices were made by Drake on November 13 question cards.

It is an Owl feature (`model-router`, [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)). The build order and the benchmark are in `docs/plans/model-router.md`.

It uses [ADR-0026](0026-short-writing-runs-on-the-threads-own-provider.md)'s side call for a fifth job and lets it name an effort, and it stands beside [ADR-0191](0191-a-dynamic-threads-model-oversees-and-chooses-a-model-for-each-piece.md) and [ADR-0192](0192-a-thread-keeps-a-choice-for-its-next-turn.md) without changing either. It changes nothing in [ADR-0004](0004-policy-records-are-the-only-authority.md): choosing a model answers no request and grants nothing.

## Context

Claude Code has four models and five efforts, and Anthropic's guide "Which Claude model should you build with?" (claude.dev, November 9, 2026) says which suits what. Choosing by hand for each message is work the user does badly and resents, and a thread left on one setting either wastes the big model on small talk or sends hard work to a small one.

A Dynamic thread (ADR-0191) answers a different question: its model oversees and hands pieces to workers on other threads. Here the thread does its own work, and only what it runs on changes.

The guide also prices a change. A new model pays the cache-write price on the whole conversation, and a move to a smaller model loses the earlier reasoning, since a model never reads the thinking of a model above it. An effort change keeps the cache.

## Decision

**1. A routed thread.** A Claude Code project thread on this computer that no thread delegated to can be **routed**: Sotto's own mark, which the provider never sees, set by a **Model routing** switch at the foot of its model menu under Dynamic's. A thread is routed or Dynamic, never both; each switch is fixed while the other is on, and main refuses the pair. The mark can change while a turn runs, because only the next send reads it.

**2. Each of the user's messages is classified first.** Before a routed thread's message goes (typed, dictated, from a paired phone, or a queued follow-up when its turn comes), main asks a classifier which model and effort it should run on, then puts the thread on them with the same `configure-thread` a chip press makes, then sends the message. Steers, wake-ups, and Watcher's, delegation's and the Council's sends are never routed.

**3. The classifier is a side call on the user's own Claude Code.** It is the call ADR-0026 describes: no tools, no customisations, no session file, so it can read nothing and do nothing, and the thread's transcript never sees it. It runs on Opus 5.5 at low effort, chosen by benchmark over Haiku and Sonnet at every effort for accuracy and for giving the same answer run to run. Its instruction is Sotto's routing rules and its own summary of the task guidance; no article text is bundled. It reads the message (to 4,000 characters) and, on a later message, what the thread runs on, the start of the user's previous message and the end of the last reply. Nothing goes to any company but the thread's own provider.

**4. It chooses between Haiku, Sonnet, Opus and Fable, and between low, medium, high and xhigh.** Never `max`, never Ultracode, never speed. The models are found in the catalog by their line, not by an id written in the code.

**5. The rules lean one level above the guide's efforts** (Drake's pick): real work starts at high where the guide says medium. Between Opus and Fable, work whose result can be checked, and review, go to Opus; work that rests on judgment, design or new ideas goes to Fable.

**6. A model may move up or down, and a switch is the exception** (Drake's pick). A go-ahead, a status question, an aside or a follow-on step keeps the model. The thread moves up when the work needs a bigger model, and down only when the message clearly starts a new, smaller job. **Stay on the first model**, in Settings under Threads and off by default, holds a thread to the model its first message got; later messages then change only the effort.

**7. The user's own choice wins.** A model pressed by hand turns routing off for that thread before the press is taken. A model or effort set by hand since the thread's last message, from a paired phone or kept for the thread's next turn (ADR-0192), is left alone: the next message runs on it and is not routed, and the one after is.

**8. A failure never holds a message.** The message is saved before the classifier is asked, so a restart during the wait loses nothing. If the classifier does not answer within 20 seconds, cannot be asked or cannot be read, the message goes on what the thread has. If the settings change does not come back accepted, the message still goes and the router names no settings, because the exception does not say whether the thread kept the old ones or took the pick; the chips read the thread's own record, as they always do.

**9. What the user sees.** The model chip reads **Auto** with Claude's mark, then the model the thread runs on once the router has chosen. The effort chip shows the effort, fixed. The chip carries the pending mark while the classifier is asked, and its card says what was chosen and the classifier's reason in a few words.

**10. The reason is kept in memory only.** It is about the user's words, so it never reaches a log, the thread's saved record or the window's startup cache, and a restart drops it. Main keeps the last routing of at most 100 threads, drops a deleted thread's, and logs event names alone.

**11. New threads.** The same switch sits at the foot of the model menu in Settings' **New threads start with** row. Where new threads also start Dynamic, Dynamic wins. A new routed thread waits to start its provider session until its first message has chosen a model, so typing cannot pin it to the default before that pick.

## Consequences

- Each routed message costs one small Opus call from the user's subscription and two to four seconds before it is sent.
- A thread can change model mid-conversation, which re-reads the conversation at full price and, on a move down, loses the earlier reasoning. The rules keep this rare and **Stay on the first model** turns it off.
- Stable changes nothing. With the Owl feature off no switch, setting or send path exists, and a saved mark stays whole.
- A thread on another machine, a delegated thread and Watcher cannot be routed. The iPhone and Android show the model and effort a routed thread runs on, as for any thread.
- The pre-PR review replaced the copied guide with Sotto's own task summary. The local benchmark below measured the earlier instruction, so its accuracy and latency figures do not establish the shipping summary's performance. No live provider run was authorized for this landing.
- The benchmark ranks classifiers on 81 prompts. It does not show that routing beats always using Opus; only use will.
