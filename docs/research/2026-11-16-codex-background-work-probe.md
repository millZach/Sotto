# Codex background work, live probe

November 16, 2026, issue #2634. codex-cli 0.169.0, signed in with ChatGPT on forge. Each probe started `codex app-server --stdio` and sent `initialize` (with `experimentalApi`). It then sent `thread/start` in an empty Git folder (`approvalPolicy: never`, `danger-full-access`, ephemeral) and one `turn/start`. Every frame was logged with its time; times are milliseconds from the start.

## A sub-agent not waited for

The prompt asked for `spawn_agent` with a task of `sleep 40` and then writing a file, without waiting.

| ms | Frame | Thread |
|---|---|---|
| 14,800 | `item/started` and `item/completed` `subAgentActivity`, `kind: started`, `agentThreadId`, `agentPath: /root/write_agent_file` | parent, on its turn |
| 14,802 | `turn/started` (`rootTurnId` is the parent's turn) | the sub-agent's own |
| 17,280 | `turn/completed`, `completed` | parent |
| 18,748 to 64,757 | the sub-agent's commands and reply | the sub-agent's own |
| 65,256 | `turn/completed`, `completed` | the sub-agent's own |
| 65,256 | `item/started` and `item/completed` `subAgentActivity`, `kind: completed`, id `subagent-completed-<child turn>` | parent, on the turn that started it |

The parent's turn ended 48 s before the sub-agent did. Codex did not start a parent turn afterwards.

## A command left running

The prompt asked for `exec_command` with `yield_time_ms: 1000` on `sleep 45 && echo done > bg.txt`, without `nohup` or `&`, and no polling.

| ms | Frame |
|---|---|
| 5,071 | `item/started` `commandExecution`, `status: inProgress`, `source: unifiedExecStartup`, `processId` |
| 8,059 | `turn/completed` |
| 10,577 to 40,589 | `thread/backgroundTerminals/list` (asked every 10 s) lists it: `itemId`, `processId`, `command`, `cwd` |
| 49,924 | `item/completed` `commandExecution`, `status: completed`, on the turn that started it |
| 50,590 on | the list is empty |

An earlier prompt that did not name the tool had Codex use `nohup … &` instead. That item completed at once, and the list stayed empty: a detached process Codex does not track (#2480's ground).

## What follows for Sotto

- The parent's `turn/completed` is not the end of what the turn started. A sub-agent's own `turn/completed`, and a command's own `item/completed`, are.
- No polling is needed. The list agrees with the item notifications, so it adds nothing for the ending.
- Not seen: what Codex does with a sub-agent or a command when the parent's turn is stopped.
