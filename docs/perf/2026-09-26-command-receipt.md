# Command receipts without the model catalog - September 26, 2026

Issue #323. After #313 a command's reply no longer copied histories, but it still carried every model catalog
the shell holds: `host.models` and the selected host's `clientHosts[]` entry. So every draft save, every chip
press and every pane change sent the whole catalog to the window, where the preload parsed it with the state
schema before the page saw it. The broadcast had stopped resending an unchanged catalog in #286; replies were
left whole on purpose, as a recovery path.

Now `AGENT_COMMAND` answers with a command receipt. `AgentStateBroadcaster.encodeReceipt` names each catalog
by its catalog revision, `{ revision, omitted: true }`, using the same counter as the broadcast, and leaves
every other field of the shell whole: the outcome, the draft revision saved, the effective settings. The
preload parses it with `agentCommandReceiptSchema`. The page's `wrapAgentBridge` puts the catalogs back from
the cache the broadcast already fills. A window that holds neither that revision nor a newer one reads the
whole state through `AGENT_GET` once and files the answer under the receipt's revisions. `AGENT_GET` still answers whole. ADR-0028 has the
amendment.

The broadcaster also stops comparing the same catalog more than once. `host.models` and the selected host's
`clientHosts[]` entry are one array in a shell, and one shell goes to both windows, so a publish compared the
catalog four times. It now remembers the last pair of arrays it compared, by identity, and compares once.

## Numbers

`tests/perf/commandReceipt.perf.test.ts` saves a draft the way the main window does. It goes through the
page's wrapped bridge, the preload's bridge and its schema, the `AGENT_COMMAND` handler, the desktop host
router and the local host service over the fixture coordinator, joined in
`tests/fixtures/commandReceiptWindow.ts`, which the unit tests share. The host lists its own model and 608
synthetic ones (`tests/fixtures/modelCatalog.ts`), 540 KB serialized. ADR-0028 measured the owner's real
608-model catalog at 649 KB, so the sizes here are not directly comparable with that ADR's. The window was
sent the catalog once by the broadcast first. `node:v8`'s `serialize` stands in for Electron's structured
clone, as it did for ADR-0028. It reads only byte counts and durations.

Medians of 40 saves after 5 warm-up saves, three runs each, on the development machine (Windows 11, Intel
Core Ultra 9 275HX, Node v24.14.1). Other agents' builds and suites were running on it, so read them as
sizes rather than budgets. "Before" is the same benchmark run once, before it was committed, with
`agentStateBroadcast.ts`, `ipc.ts`, `src/preload/index.ts`, `src/shared/agents.ts` and `agentStateCatalogs.ts`
taken from `origin/main` at `e093bd6c` (Release 0.1.19), the commit the branch started from, and the handler
registered without a receipt encoder. The committed benchmark measures only the code as it now is.

| What was measured | Before | After |
| --- | ---: | ---: |
| Reply size on the wire | 542,165 bytes | 2,308 bytes |
| Main: handler to answer | 9.9-10.6 ms | 10.2-11.2 ms |
| Main: encoding the receipt | none | 0.75-0.81 ms |
| Copying the reply (serialize and deserialize) | 2.2-2.3 ms | 0.014-0.015 ms |
| Preload: parsing the reply | 2.4-2.6 ms | 0.037-0.046 ms |
| Page: save sent to reply resolved, all of the above | 15.3-16.0 ms | 10.5-11.1 ms |

- **Handler to answer** includes the save's own work: the coordinator writes the workspace file. The receipt adds
  one content comparison of the catalog in main, which is the encoding row; the rest of the handler is the
  same work before and after, and the spread between runs is as large as the difference.
- **Copying the reply** is the stand-in for the clone Electron makes from main to the preload. It is paid on
  the renderer's side as well as main's.
- **Parsing the reply** is `invokeParsed` with the schema the preload uses: `agentStateSchema` over 609 models
  before, `agentCommandReceiptSchema` over two revision markers after. It runs on the window's own thread.
  The receipt schema accepts a catalog only as a revision, so a whole list on this channel is refused.
- **Save sent to reply resolved** is the page's `command()` promise, with the stand-in copy on the way in and
  out. After the change it includes putting the catalogs back from the cache, which is a lookup per catalog.

A catalog that changes costs the window one `AGENT_GET` of the whole shell, the size the reply used to be,
the first time a receipt names the new revision before the broadcast carrying it lands. The broadcast then
carries that revision in full as before, and later receipts resolve from the cache. A receipt that names an
older revision than the window holds, because main built it before a broadcast the window already has,
resolves from the newer catalog without a read. A reply shell built before a catalog change and encoded after
its broadcast takes a revision of its own and costs one read and one more full broadcast to both windows, the
widget included; ADR-0028's amendment says why that is left as it is.

## What was not measured here

The window's copy of the reply back across `contextBridge` into the page is not in these numbers: the
benchmark calls the preload's bridge directly. Before, that crossing copied the 609-model catalog a second
time; after, it copies two markers, so the saving in the app is larger than the table shows. Nothing a user
sees changes. The built app was run through the Playwright specs that drive commands through the bridge
(listed in the pull request); no timing was taken there. The hand tests in the running app are in
`docs/verification/command-receipt.md`.

## Tests

- `tests/unit/main/agentCommandReceipt.test.ts` runs the chain end to end with the synthetic catalog. A draft
  save on an unchanged catalog carries no model entries and needs no `AGENT_GET`. A window holding a stale
  revision recovers once for two concurrent saves and resolves the third from its cache. The draft store
  sees the exact draft revision acknowledged, and a settings change answers with the effective settings.
- `tests/unit/main/agentStateBroadcast.test.ts` checks that a receipt names every catalog by the broadcast's
  revision, that a receipt advances the revision without marking anything sent, and that one comparison
  serves a shared catalog across both windows and a receipt.
- `tests/unit/renderer/agentStateCatalogs.test.ts` checks the page's side: the cache the broadcast fills,
  the receipt's own fields kept over the recovery's, a recovered catalog serving the next broadcast, a
  receipt naming an older revision resolved from the newer one without a read, a recovery for an older
  revision never filed over a newer one, a receipt for another host recovered on its own at the same
  revision, a failed recovery asked once more, the held catalog or the last `get()`'s standing in when both
  fail, a reply that still resolves when the window holds no catalog at all, and a whole state from a test
  bridge passed through.
- `tests/unit/preload/agentStateForwarding.test.ts` checks that the preload accepts a receipt and refuses a
  catalog that is anything but a revision, a whole list included.

## Re-run

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/commandReceipt.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

It prints one `command receipt:` line of JSON with the sizes in bytes and the medians in milliseconds.
Without `SOTTO_PERF_BENCH=1` it is skipped, like every benchmark that only reports timings.
