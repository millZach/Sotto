# A Claude steer cuts the step Claude is thinking or writing

## Status

Accepted October 11, 2026, by the owner's choice. The owner reported that a Claude steer was accepted and then ignored until they pressed Stop. Shown why, they chose to have **Steer now** cut the step Claude is on rather than wait for it and say it is waiting, and for the turn it cuts to read **Steered** rather than **Stopped**. Amends decision 2 of ADR-0065, and the glossary's **Steering**, which said a steer never cancels a turn.

## Context

ADR-0065 sends a steer to the running Claude Code CLI as a plain prompt. Claude Code queues it and reads it at the turn's next model step. A model step is one request to the model: Claude thinking, then writing text or a tool call. Claude Code does not read a queued prompt during one, so a steer that lands while Claude thinks or writes waits for the step to end. With a large model at high effort that can be minutes. In the session the owner reported, the steer came 1.5 minutes into a step that had not ended when they pressed Stop 17 seconds later. Stop ended the turn, and Claude Code ran the steer as the next one, as ADR-0065 says it does.

Claude Code 2.1.296 has a second way in. A prompt written with `priority: "now"` is what its own Ctrl+Enter, "send now", writes. Probes against the installed CLI (`docs/verification/claude-steering.md`) showed:

- While Claude thinks or writes, a prompt sent now drops the step at once. The turn ends with a result whose `terminal_reason` is `aborted_streaming`, its prompt's lifecycle says `cancelled`, and the prompt runs as the next turn about a second later. No "interrupted by user" note is added to what Claude reads.
- While a tool call runs, a prompt sent now waits for the call, then ends the turn (`aborted_tools`) before the next step. A plain prompt also waits for the call, then joins the same turn. Both are read at the same moment.
- With a prompt sent now held behind a running command, Stop is acknowledged but the command runs to its end, twice pressed or once. With a plain prompt held there, Stop ends the command at once.

## Decision

**1. While Claude thinks or writes, a steer goes as Claude Code's send now.** The adapter writes it with `priority: "now"`. Claude Code drops the step it is on, ends the turn, and answers the steer as its next turn. What Claude was writing in that step is lost, as it is when the user presses Stop, and the user has asked for that by steering.

**2. While one of the turn's tool calls runs, a steer goes as a plain prompt.** It is read as soon as sent now would be, it joins the turn rather than ending it, and Stop still ends the command. The adapter counts a call as running from the assistant message that makes it to the result that answers it, in the root turn's own frames. A call still being written is a step Claude is writing, not a running call. So a long file write is cut, though the thread already shows the file change as running. A subagent is a call its turn waits on, so a steer while one works waits for it, as it did before.

**3. A turn a steer cut is steered, not stopped or failed.** An aborted result while the CLI holds one of Sotto's steers is the cut. The turn is interrupted, its record is marked `steered`, and the thread's header for it reads **Steered after …** where a stopped turn reads **Stopped after …**. No error is raised, the background work Claude left running stays shown, and the thread goes straight on to the steer's turn. A call Claude was still writing was never made, and Claude Code says nothing more about it, so its row settles as interrupted with the turn. That holds for a stop mid-call too. A turn that finished as the steer arrived is completed, and the steer still runs next. A turn the user stops is stopped, steer or not. Claude Code cuts a turn only for a stop or a prompt sent now, so any other cut reads as a stop, as one does when Stop lands while the turn before it is ending. A turn Claude Code gave itself, such as a report on finished background work, answers no message, so cutting it marks no record, least of all the steer's own.

**4. Nothing else moves.** Enter still queues, **Steer now** keeps its name and place, and the iPhone's steer goes through the same adapter. Codex steers as it did. Watcher's steer reaches a Claude worker by the same path. Its authority to stop a worker already covers cutting a step.

## Consequences

The adapter knows only what the CLI has said, and the CLI moves on while the steer is on its way. A call that starts or returns in the moment a steer is written can tip the choice the wrong way. Sent now just as a command starts, the steer holds a stop until the command ends. Sent plain just after a call returned, it waits for the step after it.

The phones show no turn headers, so they say nothing new. A Claude Code too old to honour `priority: "now"` reads the steer at the next model step, as ADR-0065 described. A cut such a CLI never makes leaves no aborted result, so nothing reads as steered.

`tests/fixtures/fakeClaudeThread.mjs` cuts the turn for a prompt sent now, as 2.1.296 does, unless its `steering` script is `'queue'`, which keeps 2.1.295's behaviour for the cases a plain prompt still takes. The live suite asks for a Node timer rather than `sleep`, which 2.1.296 refuses to run on its own.
