# A command's reply to the window - October 30, 2026

Measured with the data-transfer benchmark (`tests/perf/dataTransfer.perf.test.ts`, `docs/perf/2026-10-29-data-transfer.md`),
its A1 block: the owner-scale pipeline on Owl, 293 threads, and sixteen draft saves on the open thread, the command the
composer sends at each pause in typing. Before each save the window is broadcast the state as it stands, through the same
encoder that encodes the replies, as main sends its window each change. Each reply is then:

1. encoded as that version of main encodes it for the page;
2. copied with `structuredClone`, as IPC copies it;
3. checked with the schema the preload checks it with;
4. completed by the page's real bridge wrapper (`wrapAgentBridge`) over the broadcast its subscription holds;
5. shared into the state the page shows.

```sh
SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/dataTransfer.perf.test.ts -t "measures what main moves" --maxWorkers=1 --disable-console-intercept
```

`SOTTO_AUDIT_REPLY_PARTS=1` prints what one reply is made of.

## What it cost

Every reply carried every thread record whole: 272,706 bytes for a draft save that changed none of them. The window
received it, the preload parsed every record against the thread schema, contextBridge copied it, and state sharing
walked every record, because each was a fresh object. Draft saves come at each pause in typing, Refresh on every pane at
every window focus, selecting a pane and telling main which panes are open all reply the same way.

## The change

The main window's page asks for a reply's threads as the records that changed since its last broadcast, the shape a
broadcast already has (ADR-0028, October 30 amendment). Main measures them from the same base and moves nothing. The
preload checks only the changed records against the thread schema. The page puts the whole array back from the records
its subscription holds, so the threads that did not change are the broadcast's own and sharing meets them by identity. A
reply measured from a broadcast the page does not hold reads the whole state instead.

## Before and after

Three runs each on forge, the same benchmark before and after; each figure is the median of fifteen replies.

| Per reply | Before | After |
| --- | ---: | ---: |
| Bytes | 272,706 | 11,462 |
| Received (IPC copy) | 1.38-1.39 ms | 0.10-0.11 ms |
| Checked in the preload | 3.12-3.25 ms | 0.31-0.33 ms |
| Completed by the page | 0.02 ms | 0.08-0.10 ms |
| Shared into the shown state | 1.86-2.11 ms | 0.19-0.20 ms |
| The window's work | about 6.5 ms | about 0.7 ms |

A draft save changes no thread record, so its reply carries none. What is left is the rest of the shell, about 8.9 KB
of it the host's projects, paired hosts and providers. A command that changes threads carries those records, a few
kilobytes each. The contextBridge copy, not measured here, falls with the bytes.

## The guards

- `tests/unit/main/agentStateThreadsBroadcast.test.ts`: a reply asked for as changes carries only the records changed
  since the last broadcast. The next broadcast is measured from the same one and carries the same change. A reply
  lists every record before any broadcast and after the window read the whole state.
- `tests/unit/renderer/agentStateCatalogs.test.ts`:
  - the page asks for changes once it holds a broadcast, gives back the broadcast's own record for each thread the
    reply did not change, and moves nothing it holds;
  - a reply measured from a broadcast it does not hold reads the whole state;
  - a page with no subscription asks for the whole reply.
- `tests/unit/main/agentCommandReceipt.test.ts`, end to end through the IPC handler, the preload and the page: a draft
  save's reply crosses with no thread record, and the page's reply holds the broadcast's records.
- `tests/integration/preloadBridge.test.ts` lists the preload's new `commandWithThreadChanges`.

## What it leaves

The rest of the shell still crosses whole with every reply: the host's projects, paired hosts, providers and the
coordinator's own fields. Sending the window only the parts of the shell that changed is a later item in the plan.
