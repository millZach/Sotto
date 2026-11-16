# Muse background work, live probe

November 16, 2026, issue #2636. Muse Code 1.4.20 (`1.4.20-R8619.1`), signed in on forge, run as `muse serve` over MSP the way Sotto runs it (`initialize`, `session/start` with `approvalMode: allowAll` in an empty Git folder, then one `turn/start`). Every frame was logged with its time; times are milliseconds from the start. The schema facts come from `muse schema generate-ts --experimental` on the same binary.

## A command left running

The prompt asked for `sleep 45 && echo done > bg.txt` with a short yield, not waited for.

| ms | Frame |
|---|---|
| 6,850 | `item/started` `toolCall`, `inProgress`, args `{"command":"sleep 45 && echo done > bg.txt","description":"Run background sleep task","yield_time_ms":…}`, `backgroundTarget` |
| 7,885 | `item/updated`, still `inProgress`, `durationMs: 1060` (the call yielded) |
| 10,587 | `turn/foregroundCompleted` (reminder checks hold the turn open) |
| 16,666 | `turn/completed`, the item still `inProgress` |
| 52,062 | `item/completed`, `status: completed`, on the turn that started it |
| 52,078 | `turn/started`: a turn of Muse's own, which reports it |

## A subagent asked for in the background

Muse launched it as a workflow:

- 32 s: a `toolCall` launches a workflow script, and a `workflow` item opens (`entryId`, `fallbackText`, `workflowRunId`, `stopAvailable`).
- That workflow failed. Muse started a turn of its own and launched another, whose `workflow` item was still `inProgress` when that turn completed, at 70.1 s.
- 70.2 s: a `subagent` item opened after that turn had completed, on its turn ID, with the workflow's `workflowRunId` and `agentPath: main/workflow-agent/1`. Its `controlStatus` went accepted, running, then resultReady.
- 127.2 s: the `workflow` item completed.
- 127.3 s: Muse started a turn of its own to report it.

## What follows for Sotto

- A `toolCall`, `workflow` or standalone `subagent` item still `inProgress` when its turn completes runs in the background, and its own `item/completed` is its end.
- A workflow's agents carry its `workflowRunId` and can open after the turn has completed.
- Muse reports what ended in a turn of its own, at once.
- The schema has experimental members too (`backgroundStatus`, `background`, `backgroundInitiator`), but the live stream above did not send them to a stable client. The item's own status is the evidence used.
- Not seen: a stopped turn's effect on such an item.
