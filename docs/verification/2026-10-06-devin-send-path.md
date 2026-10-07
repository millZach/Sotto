# Devin send path against the live CLI - issue 770

October 6, 2026, Windows 11, Devin CLI 3000.10.31 (b98cc431) found on PATH, signed in to Zach's own account. Issue
#770 accepted the native account usage of the live suite. Its prompts are the suite's own synthetic ones (marker
files, a two-choice question, a one-word reply); no prompt, reply, protocol body or key was logged. The suite logs
the stage, how long each send took to be accepted, and whether the last stream-accepted send was still unconfirmed
by a replay when it returned.

## What the run shows

`SOTTO_DEVIN_LIVE=1 npx vitest run tests/integration/devinLive.test.ts --maxWorkers=1 --disable-console-intercept`
on the branch's final code: 3 passed in 41 s.

| Check | Result |
| --- | --- |
| The thread's own process still holds its session when idle | Between turns, with the thread's own connection open and no turn running, a separate ACP process using Sotto's profile asked to load the session. Devin replayed it and refused it the session, the same lock the September 19 note recorded during a turn. This is what lets a send skip reading history first. No prompt was sent by the probe. |
| A send is accepted from the thread's own stream | The `stream` stage's send returned accepted while its dispatch was still unconfirmed by any replay, so the stream was the evidence. Its one-word reply reached the thread. The suite logs this rather than asserting it: when Devin is slow to its first streamed work, the replay read a second and a half in can accept the prompt first, which is also correct. The fixture tests pin the stream path. |
| Deny, allow once, the question, restart and cancel | Unchanged and passing: the denied file absent, the allowed file exact, the question answered, the same identities after restart, the cancelled file absent. |
| Abrupt loss of the thread's own process | Both cases passing: a process lost before a clean shutdown is refused with its model kept; after one, the same session recovers and the old permission answer is rejected. |

Send to accepted, by stage, in that run (milliseconds; this includes Devin's own time to its first streamed work):

| Stage | Final run | The full run before it |
| --- | ---: | ---: |
| `send-denied` | 1,237 | 1,035 |
| `stream` | 774 | 1,035 |
| `send-allowed` | 747 | 700 |
| `question` | 642 | 821 |
| `cancel` | 2,438 | 999 |

Each figure ends when Devin first streams work for the prompt: a chunk of reply or thinking, a tool call or a
request, or when the replay confirms the prompt, which a send reads once that has not come in a second and a half and then every second and a half. Before this change the replay was read back to back, so a prompt whose first streamed work is slow can be accepted a little later than it was.
The final run's `cancel` send took 2.4 s, which is either Devin's own time or that replay read; nothing logged
says which. The run before it was on the branch before its last review fix.

## An earlier run

The first full run on the branch, before the last review fix, passed the main journey and the loss case without a
saved model, and failed the loss case with a saved model: after killing the thread's own process, the reconnect came back refused,
so the thread was missing from the snapshot. The cause was not recorded; the suite logged only the stage. Rerun
alone it passed, and both full runs after it passed all three. The suite now checks that reconnect's result itself and
names the problem kind when it is refused, so a repeat says what Devin refused. It was not run down further, and
no live run was accepted for this review to try. One cause this change could have brought is ruled in or out by the
next run: reconnecting now runs `plugins list` and `mcp list` side by side, and Sotto refuses an integration check
that writes anything to stderr. A throwaway script, not committed, ran 30 side-by-side pairs and 15 sequential ones
against the same CLI with none failing or writing to stderr. The pieces benchmark now counts list runs that write to
stderr (`listRunsWithStderr`), so that check can be repeated from the repository.

## What this does not show

- Send to `session/prompt` was not timed live; the perf note gives the pieces and the fake's whole-path figures.
- One account, one machine, the pinned CLI. Apple silicon is still unverified (ADR-0017).
