# Grok Build background work verification

November 15, 2026. `fix/grok-background-subagents`, issue #2633, [ADR-0023](../adr/0023-working-reads-the-providers-agent-tasks.md) (amendment for Grok Build), following #2631.

## How it was run

On forge, with Node 24.22.1 and Grok Build 1.0.77 signed in:

```sh
npm run typecheck
npx eslint <changed files>
npx vitest run tests/integration/grok*.test.ts tests/unit/main/nativeActivity.test.ts tests/unit/main/subagentObservations.test.ts tests/unit/main/copySites.test.ts tests/unit/main/zodSchemaSites.test.ts tests/unit/main/codeSizeBudget.test.ts
SOTTO_GROK_LIVE=1 npx vitest run tests/integration/grokAdapterLive.test.ts -t "background subagent"
```

## What was checked

**The protocol, live.** The frames are in [the probe note](../research/2026-11-15-grok-background-work-probe.md). Grok answered the prompt 6.5 s in, while the subagent ran on to 58.6 s, and then started a turn of its own to report.

**The failure on main.** The fake Grok client now sends those frames (`background-agent`, `background-agent-end`, `wake-turn`, `shells`). Its contract driver turns on the shared adapter contract's background-work case for Grok, which was skipped before. With main's adapter, that case and the three new Grok tests failed: the thread had no background work while Grok's subagent ran. With the fix, all 42 run Grok adapter tests pass, and all 14 Grok, activity and guard files pass.

**The fix** (`grokAdapter.test.ts` and the contract):
- the subagent is background work once its turn has ended, until `subagent_finished`, and is never restored after a restart;
- one that wakes Grok is held until Grok's report turn completes;
- a command Grok lists as running is a command, until the list says otherwise;
- a subagent's own subagent is never the thread's work;
- a lost Grok process clears the work, and every subagent row it was running, a subagent's own included, reads unknown with its agent interrupted, so Watcher's roster stops counting it.

**After review** (Sol at max, both axes), each fixed with a test:
- A subagent that outlived its turn stays background work through a follow-up turn. Before, the follow-up hid it until it ended.
- A woken subagent is held only until its own report turn, or a turn that began after it finished. Before, any turn's end let it go.
- A permission change, which reloads the session, is refused while background work runs.
- A lost process now closes a subagent's own subagent too.

The review also said a cancel should clear background work. A second live probe showed Grok ends the background subagents on a cancel and says so with `subagent_finished` (`cancelled`), so the tracker already ends them on Grok's own word.

**The real adapter over the real Grok, twice.** The opt-in live case started a background subagent that ran `sleep 30`; the cards were allowed once by the test. The thread went:

```text
running work= rows=
running work= rows=running/running
idle work=subagent:Sleep then write done.txt rows=running/running
running work=subagent:Sleep then write done.txt rows=completed/completed
idle work= rows=completed/completed
```

Its turn ended with the subagent as background work. The subagent read running until Grok said it finished. The thread read running through Grok's report, then rested with nothing left.

## Not checked here

- **The window.** No end-to-end hook runs the real Grok adapter in the built app: the native fixture mode replaces Grok with a fake. Nothing new is drawn, so the window shows Grok's background work with the same readout, sidebar state and rows a Claude Code thread uses (#2638's captures). The live case above checks the state the window reads.
- **A background command the parent itself starts.** The probe saw only the subagent's own. The tests cover the list's shape as the probe showed it.
