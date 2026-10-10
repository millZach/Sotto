# Claude steering

October 9, 2026, on the Windows laptop, against Claude Code 2.1.295 (ADR-0065).

**What the CLI does with a prompt written mid-turn.** Two hand-run probes started `claude --print --input-format stream-json --output-format stream-json --verbose --replay-user-messages --model haiku` with only `Bash(sleep:*)` allowed, and wrote the frames the adapter writes. Each asked Claude to run `sleep`, then reply `SECRET=<word>` with the secret word if it had been told one. A second prompt, "the secret word is PELICAN", was written 1.5 seconds after the tool call began.

- Left to run: the CLI answered the second prompt at once with `command_lifecycle` `queued`. When the command finished, 11.6 seconds later, it echoed the prompt (`isReplay`) and said `started`, and the turn's one reply was `SECRET=PELICAN`. There was one `result`, whose `user_message_uuid` named the first prompt.
- Stopped 2.6 seconds after the steer: the interrupt's answer was `{"still_queued":["<steer uuid>"]}`, the stopped turn ended with `error_during_execution`, and the CLI then opened a new turn, echoed the steer, replied `SECRET=PELICAN`, and ended it with a `result` naming the steer.

**The adapter against the CLI.** `SOTTO_CLAUDE_LIVE=1 npx vitest run tests/integration/claudeSteeringLive.test.ts --maxWorkers=1` passed both cases, with the account's default model and bypassing allowed so `sleep 15` needed no answer. The steer went in once the thread showed the command running.

- Steered: the steer was acknowledged and shown before Claude read it, and the thread settled idle with one completed turn and a reply carrying the word, in 23.5 seconds.
- Stopped: the turn read interrupted, then the steer's own turn completed with the word, in 25.2 seconds.

**Not tried.** A Claude Code too old to send lifecycle frames, a steer carrying a screenshot, and a CLI that exits while it holds a steer. The fake CLI in `tests/integration/claudeSteering.test.ts` covers the cases above, a steer refused on an idle thread, and a queued follow-up steered through the coordinator. The iPhone half was not run on a device: no Mac was available, so its Swift is compiled and tested only by CI's macOS job.
