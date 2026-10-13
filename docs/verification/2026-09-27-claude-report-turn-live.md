# Claude reporting back on background work, against the installed CLI

Evidence for the fix to #373. Windows 11, 2026-09-27, **Claude Code 2.1.283**, the installed and signed-in client.

The check is `tests/integration/claudeBackgroundReportLive.test.ts`, run with `SOTTO_CLAUDE_LIVE=1`. It makes a synthetic project in a temporary folder and runs two threads through the adapter:

- **Background agent:** the thread leaves one background agent running.
- **Background command:** the thread leaves one background command running (`sleep 20`). This thread runs with bypassing allowed, so the command needs no answer.

In both, Claude replies, ends its turn, and reports back once the work is done. The check samples the thread every 100 ms. It prints the words the sidebar row would show and how long the row read Done between the work ending and the report settling. It prints no reply text.

## What the CLI sends

#373 was built on the fake CLI, which files Claude's own turn as a user frame carrying its origin. The real CLI sends no user frame on stdout for that turn. Frame by frame, once the background work ends:

1. `system/task_notification`
2. `system/init`
3. `system/status` with `status: "requesting"`
4. the streamed reply
5. a `result` with `origin: {"kind": "task-notification"}` and no `user_message_uuid`

A turn Sotto sent opens the same way, with `init` then `requesting`. The difference is that `command_lifecycle` frames come first, and the replayed prompt comes after. `requesting` also recurs within a turn after each tool result. No `status` frame came from the background agent while it worked.

A prompt sent during Claude's own turn was queued by the CLI and started after that turn's result. With #373's fallback, the report's result was taken for the end of that prompt, so the prompt ran while its thread read Done.

## Results

| Run | Adapter | Longest Done before the report settled | Prompt sent during the report |
| --- | --- | ---: | --- |
| Background agent | `main` at `a6ba7c1c` | 608 ms | never tried: the thread did not read running |
| Background command | `main` at `a6ba7c1c` | 2,116 ms | never tried |
| Background agent | this branch | 101 ms | refused |
| Background command | this branch | 0 ms | refused |

On `main` both cases fail the check. On this branch both pass, and the row reads Working (or Waiting, for the command) from the prompt to the report, then Done.

The 101 ms is one sample falling between `task_notification` and Claude opening its report turn. That is a single chunk of output apart on some runs and about 100 ms on others.

## What this does not cover

- Messages from another session (`peer`) and continuing after a usage limit (`auto-continuation`). The adapter reads any turn Claude opens on its own the same way, but no run produced one of these.
- Stopping Claude's own turn against the real CLI. The integration tests cover it with the fake CLI.
