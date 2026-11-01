# An idle Devin thread on screen starts no process - November 1, 2026

Part of #992, its Devin item. Measured with `tests/integration/devinAdapter.test.ts`, "reads no history of an idle
thread its own process holds", in the default suite:

```sh
NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/integration/devinAdapter.test.ts -t "reads no history" --maxWorkers=1 --disable-console-intercept
```

It sends a prompt to a watched Devin thread through the fake Devin CLI, lets the turn end and the replay confirm the
dispatch, then counts the `session/load` requests over twenty of the fixture's 20 ms read intervals. "Before" is the same
test run with `src/main/agents/devin.ts` as it is on `origin/main` at `f976052cc`.

## What it cost

The poll read every thread on screen whose own process held its session, every 15 seconds while idle. Each read started
a `devin acp` process of its own, which loaded the session and replayed all of it, revalidated, merged the replay, and
was then refused the session because the thread's own process holds it. That is four processes a minute for each idle
Devin thread on screen, twenty a minute with five.

## The change

The poll reads a held thread only while one of its dispatches is unconfirmed: while the thread's own process holds the
session, no other client can write to it (Devin answers -32015), so a replay adds nothing else. A thread Sotto does not
hold is read as before. ADR-0017 has an amendment.

## Before and after

| Idle watched Devin thread, dispatch confirmed | Before | After |
| --- | ---: | ---: |
| Reads in twenty 20 ms intervals (fixture pace) | 4 | 0 |
| Reads a minute at Sotto's pace (15 s) | 4 | 0 |

Each read is a `devin acp` process started and a whole replay. Five idle Devin threads on screen started twenty
processes a minute; they now start none. The second row follows from the 15 s interval rather than from a timed run.

## The guards

- `devinAdapter.test.ts`, "reads no history of an idle thread its own process holds": no read over twenty intervals once
  the dispatch is confirmed, and a message typed in Devin while Sotto did not hold the session is read when Sotto opens the
  thread again.
- "waits for its own history read to let go of a session before reopening it (#464)" now starts its read as a wait for an
  unconfirmed dispatch would, since an idle confirmed thread is no longer read.
- The adapter contract's "observes provider takeover" check does not apply to Devin (`takeoverWhileHeld`): it types into a
  session Sotto's own process holds, which real Devin refuses.
