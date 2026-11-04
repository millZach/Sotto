# Another owner's words are untrusted and start nothing

## Status

Accepted by Zach on November 3, 2026. Amends [ADR-0073](0073-watcher-coordinates-threads-with-its-providers-own-tools.md) and [ADR-0004](0004-authority-in-policy-records.md), and changes one line of `docs/plans/teams-watchers.md`: the plan said a teammate's ask starts a turn in the receiving Watcher, and Zach chose a side call instead on the question card (decision 1). [ADR-0186](0186-a-team-link-joins-two-owners-computers-over-a-closed-list.md) says how a team link carries these messages.

## Context

Zach's plan says a message from Drake's Watcher is "show and read only", and that the action tools refuse anything it triggers, enforced in code, because ADR-0073 treats a prompt rule as guidance only. Sotto can refuse its own tools in a Watcher turn. It cannot refuse Watcher's native tools there: they run under the user's permission mode (ADR-0073, October 13), no provider has a per-turn switch Sotto could rely on, and at Full access a command runs without a card. So a turn started by another owner's words could run commands on this computer, whatever Sotto's own tools refuse.

## Decision

**1. A teammate's message starts no Watcher turn.** Nothing that arrives over a team link sends anything to Watcher's thread, queues a follow-up or sends a wake-up. There is no path from the listener to the coordinator's commands: what handles an ask is given a read of the thread list and a writer of short text, and nothing else.

**2. A side call writes the answer, with no tools.** An ask is answered by one side call (ADR-0026) on Watcher's provider and model, on the receiving owner's account, with the provider's tools off by each adapter's own switches. Its material is what the owner's summaries are: each thread's title, project, where it stands and its pull requests' numbers, titles and states, without the projects the owner left out (ADR-0186, decision 10). The thread's messages, tool output, file names and paths are never in it. Neither Watcher's conversation nor its kept state is. When the provider writes nothing, or there is no Watcher, Sotto sends the same facts as a plain list, with no model.

The asker's words go in as material, marked as another person's. The worst they can do is steer the words of an answer made only from what the owner already shares.

**3. A reply cannot quote a thread, so nothing is held for it.** Plan open question 2 recommended showing a reply that quotes thread content before it goes. Under decision 2 no reply can, because the writer never sees any, so there is no hold card in this slice and the answer goes at once. A thread's title does go, and titles come from the user's words; the Teams tab says so and the leave-out list is the control. A later slice that lets an answer read a thread brings the hold card with it.

**4. A reply shows first, and Watcher reads it with the user's next message.** An answer comes back as a **teammate's message**: a row in Watcher's conversation, under the reply it came in after, in words that say whose it is and that it changes nothing. It is not a provider message, and it is not news. `read_teammate_messages` gives Watcher the messages that were on screen before the user's current message went, labelled as a teammate's words. A note from Sotto tells Watcher when there are any, in fixed words that carry none of them. So Watcher never reads another owner's words before the user could, and no answer reaches a model in the turn that asked for it.

**5. An ask comes only from the user's own message.** `ask_teammate` is refused in a wake-up, in a turn a thread's message started, and in every turn the user's own message did not start. Each user message may ask each of the two asks once. So two Watchers cannot keep asking each other: an answer never starts a turn on the asking side and an ask never starts one on the answering side (plan, open question 3). The ask goes at once, as Zach chose (plan, decision 8), and says nothing beyond the asker's words and which ask it is.

**6. The caps are on what a teammate can spend.** A teammate's asks are answered at most 20 times a day and 5 times in any 10 minutes, per link, and one at a time. Past that the ask is refused before anything runs, the asker's row says why, and the owner's Teams tab counts it. Every answer's side call is on the answering owner's account.

**7. A message answers nothing.** There is no command on the link that reaches a card, a policy record or a permission, and nothing in a message is read as one. A message's words are never kept by `keep_state`, and a rule never comes from one. Merge priority is advice: it orders work and merges nothing, and each owner still merges under their own confirmation (ADR-0027, ADR-0004).

## What the code does not stop

Once the user has sent a message, Watcher has the teammate's words in front of it in a turn the user started, and its native tools run under the user's mode, as they do when it reads a web page or a tool's output. Sotto labels the words and the prompt says they are not the user's, and that is guidance. What is enforced is the order: the words are on screen first, and only the user's own message starts the turn. The two owners have chosen to trust each other this far (plan, decision 1), and a later slice that widens what crosses reopens this.

## Options rejected

- **A real Watcher turn with Sotto's tools refused.** The plan's wording. It keeps Watcher's whole conversation behind an answer, and leaves native tools live on another owner's say. Zach's second choice on the card; rejected for that reason.
- **Handing Watcher the answer as the tool's result.** It reads better in the moment, but an answer could then steer a turn no one has read it in.
- **A wake-up on each answer.** Spends the asker's usage on what the row already says, and it is a turn another owner's words started.

## Consequences

- An answer knows only what the thread list knows. It can say #2031 and #2039 are both iPhone work when their titles say so, and cannot say which files they touch.
- A teammate's answers cost one cold side call each, 9 to 22 seconds in ADR-0026's checks.
- "Teammate's message" sits outside provider history, so it stays when Watcher's conversation is compacted, and is dropped with Keep local history off, as a Council's record is.

## Proof

Unit and integration tests: an ask and an answer leave Watcher's thread with no send, follow-up or wake-up, by count; the side call's material holds no message text from a fixture thread and no left-out project; `ask_teammate` is refused in a wake-up and a told turn and past one of each kind per message; `read_teammate_messages` leaves out what arrived after the user's message; the caps refuse before the writer is called; and a provider that writes nothing gets the plain list.
