# Command replies without history copies - September 25, 2026

Issue #313. A command from the window used to be answered with `AgentControl.get()`: a structured clone of the whole state, every loaded thread's messages included, and then a walk over every message to place attachment preview markers. The desktop host router read only the answer's error, and the IPC handler stripped the histories with `agentShell` before sending. So the copy and the walk were made and thrown away on every command.

Now the window's commands run through `AgentControl.commandShell`, which answers with `shell()`. The shell puts an empty constant in place of each thread's messages before it clones, so no history is copied and nothing is decorated. `LocalHostService.command` calls it, the router answers with its own shell as before, and the IPC handler no longer strips an answer that has no history in it. `AgentControl.command` still answers with the whole state, for a caller that reads histories from the answer. The tests and the integration suites use it that way. No window does. `AGENT_GET` already answered with the shell and is unchanged. The draft save was already answered with the shell inside the coordinator; only the IPC strip came off it.

One reply built with `get()` fed back into the coordinator: a reconnect that failed marked the host disconnected from the answer's host. With the shell as the answer, that would have emptied the loaded histories, so it now reads the live host instead.

## Numbers

Median of 40 runs after 5 warm-up runs, three runs of the benchmark each, on the development machine (Windows 11, Intel Core Ultra 9 275HX, Node v24.14.1). Other agents' builds were running on it, so read them as sizes rather than budgets. Eight threads each hold 1,500 synthetic messages of 800 characters, all loaded. The "before" column is the same benchmark with `control.ts`, `hostService.ts` and `ipc.ts` taken from `origin/main`.

| What was timed | Before | After |
| --- | ---: | ---: |
| `get()` alone | 27-29 ms | 27-29 ms |
| `shell()` alone | 2.0-2.4 ms | 2.0-2.6 ms |
| `voice` command, handler to answer | 32-37 ms | 6.4-8.8 ms |
| `select-thread` command, handler to answer | 39-45 ms | 12-17 ms |
| `save-thread-draft` command, handler to answer | 11.5-12.9 ms | 9.7-12.5 ms |

Every answer carried no messages before and after, because the handler stripped them before; what changed is the work done in main to build it. The command times include the command's own work: `select-thread` and `save-thread-draft` write the workspace file. The `voice` answer still costs about three shells, because the router builds its own shell for the answer and another for its broadcast, each over the coordinator's `shell()`. That is the router's cost, not the coordinator's, and is left alone here.

These are synthetic timings in a Vitest worker, not app latency. They do not include the structured clone Electron makes to send the answer to the renderer, which is the same before and after because the answer is the same, or the renderer's handling of it. The fixture holds far more loaded history than a usual session, where the watched set keeps most threads to their summary (ADR-0016), so the saving in the app is smaller in proportion to what is loaded.

## Tests

- `tests/unit/main/agentCommandReply.test.ts` sends commands through the `AGENT_COMMAND` handler, the desktop host router and the local host service. It checks that the answer carries no thread messages and that neither `get()` nor `AttachmentPreviews.decorate` is called.
- `tests/unit/main/agentShellDetail.test.ts` checks the same of `commandShell` on each command lane, the answer while stopping, and that `get()` and `command()` still carry histories.

## Re-run

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/commandReply.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

It prints one `command reply:` line of JSON with the medians in milliseconds. Without `SOTTO_PERF_BENCH=1` it is skipped, like every benchmark that only reports timings, so the default `npm test` does not pay for it.
