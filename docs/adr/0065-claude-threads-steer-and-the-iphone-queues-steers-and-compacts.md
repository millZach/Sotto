# Claude threads steer, and the iPhone queues, steers and compacts

## Status

Accepted October 9, 2026, by the owner's choice. The owner asked to steer Claude threads right away rather than only queue for them, and for the iPhone to compact and steer. Shown three directions for the iPhone in `docs/prototypes/iphone-steer-compact-prototype.html`, they chose B, "Queue, then steer", which matches the desktop. Asked what Enter does while a Claude turn runs, they kept it queueing, with **Steer now** as the way into the turn, as for Codex. Changes no earlier decision: the iPhone still speaks host protocol version 1, and every command it adds was already on the remote command list (ADR-0025).

## Context

Steering is the user's explicit submission of new input into a provider's running turn through a native mechanism (`CONTEXT.md`). Only Codex had one, `turn/steer` (ADR-0005). The Claude adapter refused a steer outright and wrote prompts only between turns (ADR-0038: one Claude Code CLI per thread over stream-json).

Claude Code 2.1.295 was tried by hand with a prompt that ran `sleep` and a second prompt written while the command ran. The CLI answered the second at once with a `command_lifecycle` frame, `queued`, and when the command finished it echoed the prompt, said `started`, and the same turn's reply used it: one `result`, naming the first prompt. A second trial stopped the turn while a steer was queued. The interrupt's answer listed the steer as `still_queued`, the stopped turn ended, and the CLI then ran the steer as a turn of its own.

The iPhone could only reply to an idle thread and stop a working one. While a turn ran its reply box said "Reply while it works" but its only button was Stop.

## Decision

**1. A Claude thread steers through the CLI's own queue.** A steer is written to the running CLI as a user prompt, with an origin of its own as any prompt has. The `queued` lifecycle frame, or the echo if it comes first, is the acknowledgement: the CLI holds the prompt from then, a stop included, so the thread shows the message from then, as it shows a Codex steer once Codex acknowledges it. No frame within the request deadline leaves the steer uncertain, and it is never written again.

**2. Claude reads a steer at its turn's next model step, or answers it next.** A steer echoed while its turn still runs is part of that turn: it starts no turn and never stands for the turn's prompt. One the turn ends before reading starts the next turn, and the thread goes straight on to it without reading as finished in between. That includes a turn the user stops: Claude Code already holds the message, so it still runs. The guide says so.

**3. Enter still queues on the desktop.** Claude gets the **Steer now** Codex has, beside the draft and on each queued message. Grok and Devin have no native way into a running turn and keep refusing a steer rather than cancelling the turn.

**4. The iPhone queues, steers, removes and compacts.** While a turn runs, its send button queues the reply (`queue-followup`) and **Stop** sits beside it; a steer or removal on its way never holds Stop back. Queued replies show as cards over the reply box with **Steer now** (`steer-followup`, where the provider steers) and **Remove** (`remove-followup`), by the desktop's rules for when each is offered. **Compact context** (`compact-thread`) is behind **•••** beside the thread's state, offered and held back by the desktop's rules. Each is the user's own press, marked before it goes and never resent, as a reply or a stop is.

**5. A question's links open, and its flattened text goes.** On the iPhone, a question sheet with several questions has no headline: the text a provider built from its own questions only repeated them, so it shows only when it says more (the desktop's `requestExplanation`). Every web link in the request's own words, its questions and its choices gets an **Open the link** row, together above the choices, which opens Safari, so opening one never picks a choice. The rows show on an iPhone that may not answer too, since opening a page answers nothing. On the desktop, a web link in a question, a choice's label or description, a permission's choices or an explanation is a link, opened where a message's link opens.

## Consequences

A queued Claude steer that the CLI never reads, because the CLI ended or Sotto let it go, stays in the transcript, and the adapter stops counting on it to start a turn. Claude Code is the authority on what it read, and the next send resumes from its own session. An older Claude Code that sends no lifecycle frames still steers, acknowledged by its echo, and a long tool call can push that echo past the request deadline, which leaves the steer uncertain rather than lost.

The fake CLI in `tests/fixtures/fakeClaudeThread.mjs` takes a `steering` script that behaves as 2.1.295 did. The iPhone code is compiled only by CI's macOS job.

Resuming a paused queue, editing a queued reply and reordering the queue stay desktop-only.
