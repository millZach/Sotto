# OpenCode background work verification

November 16, 2026. `fix/opencode-background-work`, issue #2635, [ADR-0023](../adr/0023-working-reads-the-providers-agent-tasks.md) (amendment for OpenCode), following #2631, #2633 and #2634.

## How it was run

On forge, with Node 24.22.1 and OpenCode 2.3.0:

```sh
npm run typecheck
npx eslint <changed files>
npx vitest run tests/integration/opencode*.test.ts tests/integration/hostOpenCode.test.ts tests/unit/main/opencode*.test.ts tests/unit/main/copySites.test.ts tests/unit/main/zodSchemaSites.test.ts tests/unit/main/codeSizeBudget.test.ts
SOTTO_OPENCODE_LIVE=1 SOTTO_OPENCODE_EXECUTABLE=~/.opencode/bin/opencode2 npx vitest run tests/integration/opencodeLive.test.ts -t "background subagent and shell" --maxWorkers=1 --disable-console-intercept
```

## What was checked

**The protocol, live.** The events are in [the probe note](../research/2026-11-16-opencode-background-work-probe.md).

**The failure on main.** The fake server now sends those events (`background`, `background-end`, with OpenCode's synthetic report and the run it wakes). Its contract driver turns on the shared adapter contract's background-work case for OpenCode, which was skipped before. With main's adapter, that case and the two new tests failed: the thread had no background work while its subagent or shell ran.

**The fix:**
- a background subagent is background work, with its `task` row running, until its child session's run ends, and stays through OpenCode's report run;
- OpenCode's `<subagent>` report is not recorded as the user's message;
- a background shell is a command until `shell.exited`, and its row then reads completed;
- a lost server ends both, and the rows read unknown.

Across the OpenCode, contract and guard files, 244 passed and 9 skipped.

**After review** (Sol at max, both axes):
- An ending that comes before its call's success, as a quick shell's can, is kept. That call's work is then taken as already ended, not left running for good (`opencodeBackgroundWork.test.ts`).
- The fixture's waiting action is named for what it waits for, and the running-tools selection lives in one place.

The review's two other points were looked at and left:
- **OpenCode's report run has no turn of its own.** It runs under the last user turn, as Claude Code's report run does: Claude Code's `<task-notification>` is likewise kept out of the user's messages. A new kind of turn with no user message behind it is out of this PR's scope.
- **Reading the job list.** The issue suggested reading it after each turn and report. The events say the same, and early endings are now kept, so it is not read.

**The real adapter over the real OpenCode 2.3.0.** The opt-in live case started a subagent and a background shell. The thread went:

```text
running work= users=1
running work=subagent:Sleep then write agent.txt users=1
running work=subagent:Sleep then write agent.txt,command:sleep 40 && echo done > bg.txt users=1
idle work=subagent:Sleep then write agent.txt,command:sleep 40 && echo done > bg.txt users=1
running work=subagent:Sleep then write agent.txt,command:sleep 40 && echo done > bg.txt users=1
idle work= users=1
```

Its turn ended with both as background work. The thread read running through OpenCode's report, then rested with nothing left. It had one user message throughout: none of OpenCode's reports was taken for the user's.

## Not checked here

- **The window.** No end-to-end hook runs the real OpenCode adapter in the built app. Nothing new is drawn: the window shows this work as it does for Claude Code (#2638's captures).
- **A live run on OpenCode 2.0.31**, the oldest client Sotto connects. Its own bundle, read on forge, already answers a subagent call with `{ sessionID, status: "running" }` and "The subagent is working in the background", the same shape as 2.3.0.
