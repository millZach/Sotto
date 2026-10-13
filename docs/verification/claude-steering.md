# Claude steering

October 9, 2026, on the Windows laptop, against Claude Code 2.1.295 (ADR-0065).

**What the CLI does with a prompt written mid-turn.** Two hand-run probes started `claude --print --input-format stream-json --output-format stream-json --verbose --replay-user-messages --model haiku` with only `Bash(sleep:*)` allowed, and wrote the frames the adapter writes. Each asked Claude to run `sleep`, then reply `SECRET=<word>` with the secret word if it had been told one. A second prompt, "the secret word is PELICAN", was written 1.5 seconds after the tool call began.

- Left to run: the CLI answered the second prompt at once with `command_lifecycle` `queued`. When the command finished, 11.6 seconds later, it echoed the prompt (`isReplay`) and said `started`, and the turn's one reply was `SECRET=PELICAN`. There was one `result`, whose `user_message_uuid` named the first prompt.
- Stopped 2.6 seconds after the steer: the interrupt's answer was `{"still_queued":["<steer uuid>"]}`, the stopped turn ended with `error_during_execution`, and the CLI then opened a new turn, echoed the steer, replied `SECRET=PELICAN`, and ended it with a `result` naming the steer.

**The adapter against the CLI.** `SOTTO_CLAUDE_LIVE=1 npx vitest run tests/integration/claudeSteeringLive.test.ts --maxWorkers=1` passed both cases, with the account's default model and bypassing allowed so `sleep 15` needed no answer. The steer went in once the thread showed the command running.

- Steered: the steer was acknowledged and shown before Claude read it, and the thread settled idle with one completed turn and a reply carrying the word, in 23.5 seconds.
- Stopped: the turn read interrupted, then the steer's own turn completed with the word, in 25.2 seconds.

**Not tried.** A Claude Code too old to send lifecycle frames, a steer carrying a screenshot, and a CLI that exits while it holds a steer. The fake CLI in `tests/integration/claudeSteering.test.ts` covers the cases above, a steer refused on an idle thread, and a queued follow-up steered through the coordinator. The iPhone half was not run on a device: no Mac was available, so its Swift is compiled and tested only by CI's macOS job.

## A steer cuts the step Claude is on

October 11, 2026, on the Windows laptop, against Claude Code 2.1.296 (ADR-0075).

**What went wrong.** The owner steered a Claude thread and Claude went on as if it had not been told; pressing Stop made the steer go through. The session's own transcript, read for timings and record types only, showed why. The last tool result came back at 23:27:04 and Claude's next step was still thinking and writing 2 minutes later. The steer was queued at 23:29:04, and Claude Code held it there until Stop at 23:29:21 ended the step and the turn. The steer then ran as the next turn.

**What the CLI does with each kind of prompt.** Hand-run probes on Haiku, with the frames the adapter writes:

- A long reply, steered with a plain prompt: the steer was queued at 106 s and the reply ran on to its end, 8,162 characters, at 110.5 s. The steer then ran as the next turn.
- The same, steered with `priority: "now"`: the step stopped as the steer was queued, 2.5 s in. The turn ended with `error_during_execution`, `terminal_reason` `aborted_streaming`, its prompt's lifecycle said `cancelled`, and the steer's own turn answered `SECRET=PELICAN` 2 s after the steer. Claude's transcript kept no part of the dropped step and no "interrupted by user" line.
- A 25-second command, steered with `priority: "now"`: the command ran to its end. The turn then ended with `success`, `terminal_reason` `aborted_tools`, `cancelled`, and the steer ran next.
- Stop after a plain steer held behind that command: the command ended at once, rejected as the user's stop, and the steer ran next. Stop after a steer sent now: the interrupt was answered with the steer `still_queued`, but the command ran its full 20 s, and a second Stop changed nothing.
- A Write call, steered with `priority: "now"` while Claude was still writing it: the step stopped with no end to the call's block, no assistant frame for it and no tool result. The result said `success` with `terminal_reason` `aborted_streaming`, and no file was written.
- 2.1.296 refuses `sleep 25` on its own and `sleep 25 && echo finished` ("Blocked: standalone sleep"), so the live suite now waits on a Node timer.

**The adapter against the CLI.** `SOTTO_CLAUDE_LIVE=1 npx vitest run tests/integration/claudeSteeringLive.test.ts --maxWorkers=1 --disable-console-intercept` passed all three cases on the account's default model, with bypassing allowed:

- Steered while Claude thought about a 2,000-word essay: the turn read interrupted and steered, and the steer's own turn completed with the word, 2.5 s after the steer.
- Steered once Claude had written the 15-second command: one completed turn, read as no steer, with the word, 18.6 s after the steer. The transcript shows the steer queued as the call went out and read in after the command's result (`absorbed_mid_turn`).
- Steered the same way, then stopped: the transcript shows the command rejected at the stop, "[Request interrupted by user for tool use]", and the steer then read. The stopped turn read interrupted and not steered, and the steer's own turn completed with the word, 6.0 s after the steer.

**The fake CLI.** `tests/integration/claudeSteering.test.ts` now covers a steer cutting a reply, a thought and the step after a command, a steer waiting for a running call and joining its turn, and a stop after a cut, besides the cases of the first pass against a CLI that reads every steer at its next step. `tests/unit/main/claudeActivityCut.test.ts` covers a call cut while it was written.

**The header.** `SOTTO_E2E_EVIDENCE=publish npx playwright test tests/e2e/thread-activity.spec.ts -g steered` renders the real transcript at 820x560 with a turn a steer cut and the steer's own turn after it. The cut turn's header reads **Steered after 1m 05s**, nothing reads **Stopped**, nothing scrolls sideways, and the header opens from the keyboard. `artifacts/thread-activity/steered-820-dark.png` and `steered-820-light.png` show it. The fixture's sidebar is unstyled in both, as it is in the same spec's other cases on `main` today; it no longer loads the sidebar's stylesheet.

**In the built app.** `npm run build && npx playwright test tests/e2e/claude-steer.spec.ts` runs the real Claude adapter over the fake CLI in the built app, with its own profile. A prompt is sent, a steer typed while the turn runs goes in from the composer's **Steer now** by the keyboard, and the transcript shows the steer, then **Steered after 0.2s** for the turn it cut, with nothing reading **Stopped** and no error. The steer's own turn then answers. The line keeps the circled mark a stopped turn has. Captures at 1280x800 and 820x560 in dark and light stay in the ignored `artifacts/e2e-runs/claude-steer/`; nothing scrolls sideways at the minimum. The installed app against the real CLI was not driven: an unpackaged build shares the running Sotto's profile, and the live suite above runs the same adapter against the real CLI.

**Not tried.** A steer while a subagent works, which waits for it by design, and a steer on the iPhone against 2.1.296: the iPhone reaches the same adapter.
