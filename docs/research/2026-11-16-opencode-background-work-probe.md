# OpenCode 2 background work, live probe

November 16, 2026, issue #2635. OpenCode 2.3.0 (`~/.opencode/bin/opencode2`, the build Sotto drives) on forge, started the way Sotto starts it (`serve --hostname=127.0.0.1 --port=0` with a password of its own). The probe followed `/api/event`, made a session in an empty Git folder with every action allowed, and sent one prompt. The prompt asked for a subagent (`sleep 40`, then write a file) and a background shell (`sleep 50 && echo done > bg.txt`), neither waited for. It read `GET /api/experimental/job?sessionID=…&descendants=true` every 5 s. Times are milliseconds from the start.

| ms | Event | Session |
|---|---|---|
| 7,598 | `session.tool.called` `task` (`description`, `prompt`) and a shell call (`command`, `background: true`) | parent |
| 7,621 | `session.created` with `parentID` = the parent; `session.execution.started` | child |
| 7,621 | `session.tool.success` for `task`: "The subagent is working in the background", `metadata: { sessionID: <child>, status: running }` | parent |
| 7,731 | `shell.created`, then `session.tool.success` for the shell: "Command moved to the background", `metadata: { status: running, shellID }` | parent; `shell.created` names no session |
| 11,840 on | the job list: `{ kind: subagent, id: <child>, status: running }` and `{ kind: shell, id: <shellID>, status: running }` | |
| 12,209 | `session.execution.succeeded` | parent: its turn has ended |
| 57,730 | `shell.exited` `{ id, exit: 0 }` | names no session |
| 57,761 | `session.inbox.enqueued` `{ type: synthetic, payload: { text: "<shell id=… state=\"completed\" …>", metadata: { source: shell } } }`, then `session.execution.started` | parent |
| 57,991 | `session.execution.succeeded` | child: the subagent's end |
| 57,991 | `session.inbox.enqueued` synthetic `<subagent sessionID=… state="completed">`, `metadata.source: subagent` | parent |
| 61,876 on | the job list is empty | |
| 62,420 | `session.execution.succeeded` | parent: its report run has ended |

## What follows for Sotto

- A background subagent's or shell's start is its call's success with `metadata.status: running`. Its end is the child's own run ending, or `shell.exited` with its ID.
- The events say what the job list says, so no polling is needed.
- OpenCode reports each ending in the session's inbox as a synthetic item, not the user's, and runs the session to read it.
