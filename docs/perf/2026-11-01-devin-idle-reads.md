# An idle Devin thread on screen starts no process - November 1, 2026

Part of #992, its Devin item. Measured with `tests/integration/devinAdapter.test.ts`, "reads no history of an idle
thread its own process holds", in the default suite:

```sh
NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/integration/devinAdapter.test.ts -t "reads no history" --maxWorkers=1 --disable-console-intercept
```

It sends a prompt to a watched Devin thread through the fake Devin CLI, lets the turn end and the replay confirm the
dispatch, then runs five polls, each once it is due and awaited through `snapshot()`, and counts every process the fake
Devin CLI records starting. "Before" is the same test run with `src/main/agents/devin.ts` as it is on `origin/main` at
`f976052cc`.

## What it cost

The poll read every thread on screen whose own process held its session, every 15 seconds while idle. Each read started
five processes: `plugins list` and `mcp list` to check the profile, a `devin acp` that loaded the session and replayed all
of it, and both lists again to revalidate after it. The `devin acp` was then refused the session, because the thread's own
process holds it. That is four reads, twenty processes, a minute for each idle Devin thread on screen.

## The change

The poll reads a held thread only while one of its dispatches is unconfirmed: while the thread's own process holds the
session, no other client can write to it (Devin answers -32015), so a replay adds nothing else. A thread Sotto does not
hold is read as before. ADR-0017 has an amendment.

## Before and after

| Idle watched Devin thread, dispatch confirmed | Before | After |
| --- | ---: | ---: |
| Processes started over five due polls (measured) | 25 | 0 |
| Reads a minute at Sotto's 15 s pace | 4 | 0 |
| Processes a minute, one idle thread on screen | 20 | 0 |
| Processes a minute, five idle threads on screen | 100 | 0 |

The first row is the test's count. The others follow from it and the 15 s interval rather than from a timed run.

The poll asks a set of the threads with an unconfirmed dispatch, kept as dispatches are added, confirmed and taken back,
so a tick does no work for a thread's past dispatches however many it has made.

## The guards

- `devinAdapter.test.ts`, "reads no history of an idle thread its own process holds": no process started over five due,
  awaited polls once the dispatch is confirmed (25 on `f976052cc`), and a message typed in Devin while Sotto did not hold the session is read when Sotto opens the
  thread again.
- "waits for its own history read to let go of a session before reopening it (#464)" now starts its read as a wait for an
  unconfirmed dispatch would, since an idle confirmed thread is no longer read.
- The adapter contract's "observes provider takeover" check does not apply to Devin (`takeoverWhileHeld`): it types into a
  session Sotto's own process holds, which real Devin refuses.
