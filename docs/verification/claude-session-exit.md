# One Claude Code session ending affects only its thread — 2026-09-23

After the Chats connection fix, Zach asked whether one Claude chat's process ending could stop marking every Claude chat disconnected.

## Cause

Claude Code is the one provider that runs a process per thread; Codex and Grok run one process for all their threads. When a thread's Claude Code process ended on its own, the adapter marked the whole provider disconnected. Every Claude chat and thread read as disconnected, and the reconnect that followed (Threads' own retry, the Chats retry, or pressing Connect) began by stopping every other Claude Code process, so a reply running in another chat was cut off and its pending requests denied.

## What changed

The exit is now the thread's own:

- The provider stays connected and no reconnect happens, so other chats and threads keep running.
- A reply that was running is marked failed with the line "Claude Code stopped before this reply finished, so it may be cut short. Send a message to carry on." It shows under that turn, where a failed turn's error already shows.
- Lost background work or a live watch leaves the thread needing attention. An idle thread says nothing: nothing was lost.
- Compaction interrupted by the exit becomes unconfirmed, as it did on reconnect, and is read from the native session rather than retried.
- The process starts again from its native session the next time the thread or chat is opened or sent to, the way a session the reaper stopped starts again. Zach chose this over restarting at once, so a process that keeps failing cannot loop.
- A prompt still waiting for Claude Code to confirm it reports uncertain as soon as the process ends, rather than after the 15-second deadline. If the process ends while a message is being prepared, nothing is sent and the send says so.

## Evidence

`tests/integration/claudeSessionExit.test.ts` runs the real adapter over the fake Claude Code client with two threads replying: the first thread's process exits, the provider stays connected with no error, the first thread's turn is failed with the line above, the second thread finishes its reply on its original process, and the first thread's next message starts a second process and completes. A second test ends an idle thread's process and finds nothing changed except that the next message starts a new one. `tests/integration/claudeMonitoring.test.ts` still finds a lost live watch leaves the thread needing attention.

## Limits

The end-to-end specs drive Chats through a fake host rather than the Claude adapter, so there is no capture from the running app; the line uses the existing failed-turn surface. Lost background work has no turn to carry a line, because a settled turn is never reopened, so the thread reads Needs attention without saying why. Compaction interrupted before Claude Code wrote its result stays unconfirmed and blocks sending, as it did after a reconnect. Not checked on macOS.
