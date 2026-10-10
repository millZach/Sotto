# Command receipts in the running app

October 9, 2026: Voice control and thread management described below are historical under [ADR-0068](../adr/0068-remove-voice-control-and-thread-management.md); the original plan or evidence is retained.

Issue #323. The pull request's three hand tests, run in the built app on the `phase3-workspace` fixture by
`tests/e2e/command-receipt.spec.ts`, with the screenshots in `artifacts/command-receipt/`. The size figures
for a large catalog are in `docs/perf/2026-09-26-command-receipt.md`; this note is about behaviour.

The fixture lists three models, so the reply is barely smaller here (13,000 bytes against 13,488 for the whole
state). What the run shows is that the reply crosses without its catalog and nothing a user does notices.

## How the reads were counted

The spec wraps main's `sotto:agents:get` and `sotto:agents:command` handlers, through Electron's private
`ipcMain._invokeHandlers` map. The first counts every read of the whole state; the page recovers a catalog only
through that read, so the count says whether a receipt was resolved from the page's cache or recovered. The
second sees each command receipt as main sends it, before the preload or the page touch it, and counts the
commands main has answered. Each count is taken once the step has settled: main has answered the command the
step waits for and every other the page sent, and the page has made one round trip to main after that, so a
read the page makes on receiving a receipt is already counted. No step waits a fixed time. The spec's own
`get()` calls, which it uses to check what main saved, are kept outside the counted spans.

## What was seen

- **The wire.** The draft save's receipt, as main sent it, names `host.models` as `{ revision, omitted: true }`
  and lists no models.
- **A draft saves as it is typed.** Typing "Draft kept by a command receipt" into the composer of Grok voice
  previews saved it (the saved thread draft matched), with no read of the whole state while typing, counted
  once main had answered the save of the whole text. After a reload the composer showed the draft again, with
  no alert. See `draft-saved.png`.
- **A setting stays.** On Settings, Agents, changing Reasoning account to Claude saved it in the effective
  settings, and once its receipt had come back to the page the control still showed it rather than snapping
  back. See `setting-kept.png`.
- **A model can be picked after the provider reconnects.** The receipts of the commands around it named
  catalog revision 2 while connected, 3 after the disconnect and 4 after the reconnect, so the catalog changed
  each time. The reconnect was the pane's own Reconnect action, so it went through the page's wrapped bridge.
  Whether its receipt needs a read depends on which lands first: when the broadcast of revision 4 is ahead of
  the receipt the page resolves it from the cache, and when the receipt is ahead the page reads the whole
  state once. Five passing runs saw one read three times and none twice; the spec asserts at most one. The pen then
  opened a new thread on the Codex model at once (issue #347), its model chip listed Grok 4.6 as available
  (`model-picker-after-reconnect.png`), picking it made no read of the whole state (asserted), and the thread
  moved to that model (`thread-on-picked-model.png`).
- No page errors were raised.

The spec names a Codex model under "New threads start with" before the pen is pressed. Changing Reasoning
account to Claude in the step before makes an unset "New threads start with" follow the Claude account's own
model, which the fixture catalog does not list, so the pen would refuse to create the thread.

## Not covered

- The widget was not driven. It shares the page-side code (`wrapAgentBridge`) and the unit tests cover it.
- A reply whose recovery fails twice was not provoked in the app; `tests/unit/renderer/agentStateCatalogs.test.ts`
  covers it.
- The owner's real 608-model catalog was not loaded; the perf note uses a synthetic one of that size.

## Re-run

```sh
npm run build
npx playwright test tests/e2e/command-receipt.spec.ts
```

It prints the receipt's size, the catalog revisions across the reconnect and the read counts, and asserts
the read counts.
