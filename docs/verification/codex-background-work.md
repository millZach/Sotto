# Codex background work verification

November 16, 2026. `fix/codex-background-subagents`, issue #2634, [ADR-0023](../adr/0023-working-reads-the-providers-agent-tasks.md) (amendment for Codex), following #2631 and #2633.

## How it was run

On forge, with Node 24.22.1 and codex-cli 0.169.0 signed in:

```sh
npm run typecheck
npx eslint <changed files>
npx vitest run tests/integration/codex*.test.ts tests/integration/adapterContract.test.ts tests/unit/main/codex*.test.ts tests/unit/main/subagent*.test.ts tests/unit/main/watcherWakeUp.test.ts tests/unit/main/copySites.test.ts tests/unit/main/zodSchemaSites.test.ts tests/unit/main/codeSizeBudget.test.ts
SOTTO_CODEX_LIVE=1 npx vitest run tests/integration/codexBackgroundWorkLive.test.ts --maxWorkers=1 --disable-console-intercept
```

## What was checked

**The protocol, live.** The frames are in [the probe note](../research/2026-11-16-codex-background-work-probe.md).

**The failure on main.** The fake app-server now sends those frames (`background-agent`, `background-agent-end`, `background-command`, `background-command-end`). Its contract driver turns on the shared adapter contract's background-work case for Codex, which was skipped before. With main's adapter, that case and the three new Codex tests failed: the thread had no background work while the sub-agent or the command ran.

**The fix:**
- the sub-agent is background work, with its row running, until its own turn ends, and its row then reads completed;
- a command still running when the turn completed is a background command, with its row running, until its own completion;
- a lost app-server ends both, and the sub-agent's row reads unknown with its agent interrupted;
- read from history, an unfinished command reads unknown as before, and nothing is restored;
- a stopped turn closes its command as interrupted, as before.

**After review** (Sol at max, both axes), each fixed with a projection test that failed before the fix:
- a reread of the same history no longer closes rows the live stream kept running;
- a command is tracked from its live start, apart from the bounded rows, so a long turn that dropped its row still leaves it in the background;
- a sub-agent that outlived its turn stays background work when a later turn messages it;
- a lost app-server stops every agent it ran, even in a row a stop had already closed, so Watcher's roster stops counting them.

**After Bug Bot's review at 14c6a1f:** a rewind is refused while background work runs, as a Claude Code thread's is. Rewinding the turn that left a command running dropped the command's later completion, which names that turn, so the thread read Waiting for good and its app-server was held. A test against the fake app-server reproduced it (`{ accepted: true }`) before the fix.

The review also asked for two things this PR does not do:
- Drop a stopped or failed parent's sub-agents. They count only while their own threads say they work, which is the provider's evidence. The ADR wording that said otherwise was corrected.
- Poll `thread/backgroundTerminals/list`, as the issue suggested. The command's own `item/completed` says when it ends, and the list agreed with it throughout the probe.

Across the Codex, contract, sub-agent, Watcher wake-up and guard files, 670 passed and 53 skipped.

**The real adapter over the real Codex.** The opt-in live case started a sub-agent it did not wait for and ran `sleep 40` past its turn. The thread went:

```text
running work= rows=
running work= rows=subagent:running
running work= rows=subagent:running,command:running
idle work=subagent:sleep_then_done,command:sleep 40 rows=subagent:running,command:running
idle work=command:sleep 40 rows=subagent:completed,command:running
idle work= rows=subagent:completed,command:completed
```

## Not checked here

- **The window.** No end-to-end hook runs the real Codex adapter in the built app. The native fixture mode uses the fake app-server, which is what the integration tests drive. Nothing new is drawn: the window shows this work as it does for Claude Code (#2638's captures).
- **A stopped parent turn.** What Codex does with a sub-agent or a command then was not probed, so a stopped or failed turn closes them as before.
