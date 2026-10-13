# Devin empty sessions: why a thread could not reconnect

September 26, 2026, Windows 11, Devin CLI 3000.10.31 (the pinned version), on Zach's own installation. No
prompt was sent, so no model ran and no credit was spent. Each run used a fresh empty temporary folder and
Sotto's own `everything` profile.

## The report

The Providers page showed Devin as **Needs attention** with "Devin could not find this saved session", and
Retry connection did not clear it. Discovery succeeded. The only saved Devin thread was a new Bypass
Permissions thread with no messages, recorded as not confirmed and not released.

Devin's own CLI logs, read for method names and errors only, show the order. The creating process answered
`session/new`, then the model and mode changes. Sotto never followed with the profile readback, so creation
stopped inside Sotto's revalidation, and the thread kept a session ID it could not confirm. The cause of
that stop was not recorded: Sotto keeps no log, and Devin's log ends before it. Every later open then sent
`session/load` for that ID and got `-32016 Session not found`. The thread was open in a pane, so every
connect reopened it, and the failure stopped the whole connection.

## Native control

| Step | Result |
| --- | --- |
| `session/new`, then set the mode to `bypass` | Devin echoes `bypass` as the current mode |
| `session/load` of that session in the same process | `-32016` |
| `session/load` from a new process after the first exits | `-32016 Session not found` |

The first row rules out the mode check: Devin confirms Bypass the way the adapter expects. The other two
repeat the September 19 finding that an unprompted session is never saved, and show why it matters. Once
the process that made an empty session is gone, however it ended, that session cannot come back.

## What changed

ADR-0017's September 26 amendment. A thread with no messages gets a new session when Devin reports its old
one missing. One thread that cannot be opened no longer stops Devin connecting. Integration cases in
`tests/integration/devinAdapter.test.ts` cover a crashed owner, a creation stopped after `session/new`, and
a prompted thread whose session is gone. All three failed when run with the adapter change stashed. A fourth
keeps a thread whose stored history holds a message from being renewed; it failed against a first draft that
missed history seeded without its words.
