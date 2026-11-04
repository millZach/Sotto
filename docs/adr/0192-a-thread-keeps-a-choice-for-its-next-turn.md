# A thread keeps a choice for its next turn

## Status

Accepted November 4, 2026. Zach's pick, November 4, 2026, on the question card for #2158: option A (a choice kept in Sotto for every provider), look A of the `rohit-codex-audit` prototype's `#2158` section (the chip shows the kept value with its pending mark), and an Owl feature.

It is an Owl feature (`next-turn-choice`, ADR-0072). Stable keeps today's fixed chips while a thread works, and its "Available after this turn finishes." line, until Zach sends it.

Widens [ADR-0073](0073-watcher-coordinates-threads-with-its-providers-own-tools.md)'s **next-turn choice** (November 1, 2026) from Watcher to every thread. Watcher's own keeps working as that ADR says. Leaves #2160 open.

## Context

rohit3a's audit (#2158) found that while a Codex turn runs, or a request waits, the composer fixes the model, effort, speed and permission chips, and main refuses the change too. The user cannot set up the next turn while this one runs. Every provider adapter refuses a change then as well, and Watcher already kept a choice for its own next turn, but only for model, effort and speed.

Codex's `thread/settings/update` takes a change during a turn and applies it from the next turn. Using it would leave Claude Code, Grok, Muse and Devin out, and it brings its own trouble on the running turn: the adapter would show the new model as in force for a turn still on the old one, a narrowed permission stops the session and the turn with it, a refusal arrives as an event rather than an answer, and Fast reaches running sub-agents at once. So the choice is kept in Sotto, the same way for every provider.

Codex's `turn/settings/update` changes the turn that runs (#2160). It is experimental and off in the installed Codex, its answer cannot be confirmed as having taken effect, and it can change the approvals reviewer of a running turn. Nothing here builds it.

## Decision

**1. A press while a thread works is kept, not refused.** While a turn runs, a request waits or a prompt is on its way, the model, effort, speed and permission chips stay pressable. A press is kept in main for that thread, as its **next-turn choice** (`CONTEXT.md`). Nothing is sent to the provider. A press names one setting, so it joins what already waits. A new model takes its own default effort unless an effort is pressed with it, and keeps a chosen speed only where that model offers it. What the thread already runs on goes from the choice, so pressing the value in force puts that part away.

**2. It is sent once the thread rests.** Rests means no turn, no request, no compaction, a connected provider and no prompt or change of its own on its way. Main then sends the choice as the same `configure-thread` a press at rest makes, on the thread's own lane, before its queue sends anything. A message queued behind the turn goes on the new settings.

**3. It never touches a request (ADR-0004).** It answers, narrows and widens nothing that waits. While a request waits, the request card is the only way to answer it, and the choice waits with the thread until the request is answered and the turn ends.

**4. A wider permission is checked twice.** When it is pressed, against the pressing client's grant, as a change at rest is. When it is sent, against that client's grant again, so a phone whose grant ended meanwhile does not widen the thread.

**5. Refused, it goes.** If the provider or the check refuses it, the choice goes, the chips show what the thread runs on, and the window says what happened. A turn that starts anyway runs on what the thread had, never on a guess. A change the provider gives no result for is kept as any such change is (#1192): the choice stays on the chips and is not sent again until main lets that change go.

**6. What the user sees (look A).** The pressed chip shows the kept value with the existing pending mark. A line under the chips, where the composer puts what it says about them, reads, for example, "This turn runs on GPT-6.1 Terra, Low effort, Auto. The next turn starts on Medium effort.", with **Keep current settings** beside it. That button sends the values in force, which puts the choice away, and hands focus back to the first chip it was about. The line is quiet text, not a warning, and it describes each chip that shows a kept value.

**7. It is kept in memory.** Quitting or restarting Sotto drops it, with nothing written to disk, the window's startup cache included. Persisting it with the thread would mean sending a remembered permission choice after a restart, with a grant that may have ended, so it is left out until there is a reason for it.

**8. Where it applies.** Every thread of every provider on the computer whose main runs with the Owl answer on, including a headless host's threads. Watcher keeps its own next-turn choice (ADR-0073) and its fixed permission chip. The iPhone and Android chips stay fixed while a thread works, and show the host's settings once the choice is sent.

## Consequences

- Stable changes nothing.
- A paired host on a build without this, or with the Owl answer off, refuses a press while its thread works with the sentence it always used, under the chips.
- The shell carries `nextTurnSettings`, one entry per thread with a kept choice, beside `unconfirmedSettings`. It is made only on a press, a send and its end, so a provider's update costs nothing more.
- #2160 stays open: the change to the running turn waits for Codex's `step_model_switching` to leave development.
