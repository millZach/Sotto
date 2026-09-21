# Waiting reads the clock, not a watch

Accepted September 21, 2026. Zach noticed that the creature above the composer never appears while a
model is waiting on something, reviewed `docs/prototypes/waiting-creature-prototype.html` — the shipped
walk beside three waiting poses, each against seven thread states — and chose the hourglass. He then
agreed to scope it to long-running work rather than to a pending request, and to a twenty-second
threshold. This decides what the second pose is allowed to claim, because the first pose was defined
by refusing exactly this evidence.

ADR-free until now, the monitoring creature's rule lives in `docs/verification/process-creature.md`:
"No elapsed-time buffer, assistant-text classification, ordinary command or surviving-shell heuristic
is used." That rule exists because **Monitoring** is a claim about the provider — that it is watching
background work and will report the result — and only `monitor`/`monitor_mcp` lifecycle events are
evidence for it. A ten-second buffer was removed during that work for asserting more than it knew.

## Decision

**Waiting is a separate, weaker claim, and it is the only claim the hourglass makes.** The readout says
the command and how long it has run. It does not say the provider is watching, that a result will be
reported, or that anything may act. So elapsed time is sufficient evidence for it, in a way it was never
sufficient for monitoring: the sentence "this has run for 4m 12s" is true by construction from the record
that produced it. `hasWaited` is the whole rule, and `WAITING_AFTER_MS` is twenty seconds — long enough
that a file read or a `git status` never raises it, short enough to arrive before the user starts wondering.

**It reads `activities`, so it is provider neutral.** `blockingAction` takes the live turn's newest running
record (`liveTurnId`, then `currentAction`) and accepts it when its kind is `command`, `tool` or `subagent`
and it carries a `startedAt`. Reasoning and planning are excluded: those are the model working rather than
waiting, and a long one of either says nothing a reader can act on. Because every adapter writes activity,
Codex, Grok and Devin threads get the hourglass, which the walk — Claude-only by its evidence — cannot offer.

**A confirmed monitoring task outranks it.** The composer reserves room for one ornament, and where both
apply the walk keeps the track: it names the task the provider confirmed, where the hourglass names only a
clock. Everything that hides the walk hides the hourglass on the same condition, through one
`ornamentAllowed` flag in `ThreadPane`: a pending request or question, a coordinator block, an error, a
closed thread, a disconnect, and the turn ending.

**The threshold is crossed by one timer, not a poll.** `useWaitingAction` schedules a single `setTimeout`
for the time remaining and re-renders once as it passes; the readout's clock then counts up inside its own
element, so a waiting thread never re-renders its transcript to show a number. A held clock — the
`design-threads` capture — answers from that clock and schedules nothing, which is why `now` reaches
`ThreadPane` from `ThreadsView`.

## Considered Options

- **The hourglass on a pending permission or question too.** The transcript already shows that card, with
  Allow and Deny in it, and `ThreadPane` clears the track for it deliberately. A second signal would have
  said a thing the screen was already saying, and an hourglass is the wrong verb for the user's turn.
- **Extending the monitoring creature's walk to cover both.** The walk is read as "the provider is watching
  this", which is what the monitoring evidence buys. Reusing it for an elapsed-time guess would have spent
  the meaning the first pose was careful to earn.
- **A shorter threshold, or a spinner from the first second.** Every tool call would have raised it, which
  is the noise the ten-second buffer was removed to avoid; at twenty seconds the pose means something.
- **Deriving waiting from assistant text ("this takes about 7 minutes").** Classification of prose is the
  heuristic `process-creature.md` rejected, and it stays rejected: what the model says about a command is
  not evidence about the command.

## Consequences

`docs/verification/process-creature.md` is amended rather than contradicted: its rule still holds for
monitoring, and it now names the one claim elapsed time is enough for. `CONTEXT.md` gains **Waiting**
beside **Monitoring task**. The pose shares the creature's body, so both are one character; the animation
scaffolding both use is `usePixelLoop`, which keeps the 30fps throttle, the held pose under system or app
reduced motion, and the stopped loop while the window is hidden. No new setting, no new IPC, no new host,
and nothing is persisted: like a live monitor, a waiting ornament is never restored from history.
