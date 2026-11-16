# Muse background work verification

November 16, 2026. `fix/muse-background-items`, issue #2636, [ADR-0023](../adr/0023-working-reads-the-providers-agent-tasks.md) (amendment for Muse), following #2631.

## How it was run

On forge, with Node 24.22.1 and Muse Code 1.4.20 signed in:

```sh
npm run typecheck
npx eslint <changed files>
npx vitest run tests/integration/muse*.test.ts tests/integration/watcherOnMuse.test.ts tests/unit/main/muse*.test.ts tests/unit/main/copySites.test.ts tests/unit/main/zodSchemaSites.test.ts tests/unit/main/codeSizeBudget.test.ts
SOTTO_MUSE_LIVE=1 npx vitest run tests/integration/museAdapterLive.test.ts -t "command it left running" --maxWorkers=1 --disable-console-intercept
```

## What was checked

**The protocol, live.** The frames are in [the probe note](../research/2026-11-16-muse-background-work-probe.md).

**The failure on main.** The fake host now sends those frames (`background` for a command, a workflow or a subagent, and `background-end` with Muse's report turn after it). Its contract driver turns on the shared adapter contract's background-work case for Muse, which was skipped before. With main's adapter, that case and the two new tests failed: the thread had no background work while the item ran.

**The fix:**
- a command the turn left running is background work, with its row running, until its own completion and Muse's report turn, and the row then reads completed;
- a workflow counts once, never the agents inside it;
- a lost host ends the items it still ran, and their agents, the workflow's own included, stop counting as running;
- the contract's case passes: kept past the turn, ended by the provider, and never restored after a restart.

Across the Muse, Watcher-on-Muse and guard files, 315 passed and 7 skipped.

**After review** (Sol at max, both axes), each fixed with a test in `museBackgroundWork.test.ts`:
- a late older revision of an item no longer brings back work that ended;
- only `inProgress` is open, as MSP's `ItemStatus` says, so an unknown status is an ending;
- a failed or stopped turn leaves nothing of its own running, while work earlier turns left keeps to its own ending;
- an item is counted until its own end however many turns follow, rather than dropping out after 256;
- a workflow's own agents keep their rows running past the turn's end, uncounted;
- a history read after a gap ends any item it shows ended.

**After Bug Bot's review at a354a06**, each with a test that failed on that head:
- **L1:** a host's stop ends only the items it still ran, and an agent that had already ended keeps Muse's own ending (`resultReady`, `timedOut`, `rejected`) rather than reading interrupted.
- **L2:** a client update waits for the background work in the host to end, as Claude Code's does, and then moves the thread to the new client.
- **L3:** a history read with no live host ends any background-kind item it shows still open outside the running turn, so its row does not read running for good.
- **N2:** a history read records the item's revision, so an older one arriving live later cannot open it again.
- **N5:** the wording above now says which rows a lost host ends.

Bug Bot's N1 and N3 are on #2645.

One point is filed on #2645 rather than fixed here: when the host is lost, an agent whose row has already left the 2,000-row activity window can't be marked interrupted, so the roster may still count it. That limit is the activity window's, for every provider.

**The real adapter over the real Muse Code 1.4.20.** The opt-in live case asked for a command left running. The thread went:

```text
running work=
idle work=command:Run sleep then write bg file
running work=
idle work=
```

Its turn ended with the command as background work. Once the command ended, Muse ran its report turn, and the thread then rested with nothing left.

## Not checked here

- **The window.** No end-to-end hook runs the real Muse adapter in the built app. Nothing new is drawn.
- **A stopped turn**, and a standalone subagent outside a workflow, were not seen live. The tests cover the latter in the shape the schema gives it.
