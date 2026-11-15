# Why each idle provider session is held - November 10, 2026

Part of #2398, finding 9 of `docs/perf/2026-11-10-performance-and-data-audit.md`. Forge's host held seven Claude Code
CLIs, five of them idle for two to five and a half hours, well past the session reaper's thirty minutes. Each is held by
a rule or by a bug, and nothing could say which. This adds the read that says, and sets down what the code says until a
release with the read runs on forge.

## The picture the read is for

The host's children at 17:00 on November 10, read from `/proc` only:

```sh
python3 scripts/perf-bench/host-children.py <the host's pid> 60
```

| Process | Age, minutes | Memory, MB | CPU in 60 s |
| --- | ---: | ---: | ---: |
| claude | 137 | 288 | 0.70 s |
| claude | 264 | 277 | 0.46 s |
| claude | 77 | 248 | 0.14 s |
| claude | 402 | 242 | 0.41 s |
| claude | 459 | 236 | 0.69 s |
| claude | 144 | 233 | 0.18 s |
| claude | 39 | 214 | 0.21 s |
| claude | 459 | 129 | 0.16 s |
| codex | 138 | 22 | 0.00 s |

Nine processes, 1,889 MB, against the audit's eight and 2,093 MB. Agents were working on forge while this was read, so
some of these CLIs were mid-turn. The host had run 457 minutes, and two of the CLIs were started within two seconds of
it: connect starts only the live-session set's CLIs (ADR-0038, November 1, 2026 amendment), so those two were in that set
when the host started, and have run ever since without a stop. Four CLIs had a `uv` child, an MCP server the CLI starts
with itself, as old as the CLI; three were running shell commands no older than eight minutes, and no CLI had a
long-lived shell of its own.

One more thing `/proc` can say: whether the host has asked a CLI to stop. Stopping a Claude Code CLI ends its input
first (`ClaudeProtocol.stop`), and once it has, the host no longer holds its end of the CLI's stdin socket (checked with
a throwaway child: held before `stdin.end()`, gone after). `ss -xp` showed the host still holding the stdin socket of
all eight CLIs. So none of them is a stop that did not take: the reaper has spared each of them on every sweep, by a rule
or because it is not sweeping, or it does not track them at all. Which thread each CLI is for, and which rule spares it,
is only in the host's memory.

## What the read reports

`POST /v1/admin/held-sessions` on the headless host's administrative listener, with the admin bearer
(`docs/host-protocol.md`). One row for each session a provider adapter's session reaper tracks:

- `provider`, and `threadId`, the Sotto thread it belongs to (absent for a session no thread owns).
- `idleMs`, since the session's own last activity: a command for it, or an event its provider sent. A sweep that spares
  a session renews its idle window but not this, so a CLI kept for hours by a rule reads hours here.
- `holds`, every rule keeping it now, asked the way the sweep asks:
  - `busy`: a turn, a start, a command mid-dispatch, a rollback, or any other part of the adapter's busy rule that is
    not one of the next three.
  - `request`: a question or permission nobody has answered.
  - `background`: a live watch or background work the CLI runs (Claude Code only).
  - `compaction`: a compaction still running, or one that ended without the provider confirming it (Claude Code and
    Codex).
  - `reading`: an owned history read (Grok Build), which defers the stop without renewing the window.
  - `watched`: the adapter's watched set (every provider but Claude Code, and Claude Code before it hears a live-session
    set).
  - `live-session`: Claude Code's live-session set.
  - With none of those: `recent` while its thirty minutes run, and `none` once the next sweep, at most five minutes
    away, will stop it.
- `pid`, the session's own process, where the adapter knows it (all nine adapters with a reaper do).

Names, ages and IDs only. No title, no prompt, nothing a thread said. The desktop window shows none of it.

Each adapter names the parts of its busy rule; the reaper asks for the names only while the rule says yes, and says
`busy` when the adapter names nothing, so the read cannot call a session free that the sweep keeps. A test runs the read
and then a sweep across each combination of rules and checks `none` is exactly what the sweep stops.

Two readings point at a bug rather than a rule: a row that says `none` and stays across reads more than five minutes
apart (the sweep is not running, or its stop never ends the process), and a row that says `recent` with an idle time far
past thirty minutes (a stop that failed and was put back for the next sweep). A host child that matches no row is a
process the reaper does not track at all.

## How to run it

On the host's machine, against the host's data folder:

```sh
node scripts/perf-bench/held-sessions.mjs --data ~/.sotto --seconds 60
```

It reads the host's process ID, admin port and token from `host-listener.json` (the token is never printed), asks the
route, reads each of the host's child processes from `/proc` and joins them by process ID. `--seconds` adds the CPU each
process used over that many seconds. A host whose release has no route yet answers `invalid_request`; the script says
so and prints the processes with every session unknown. Linux only.

Checked here against a listener started from this branch with three synthetic sessions, two of them pointing at real
child processes:

```text
Process     PID      Age min  Memory MB  CPU in 2 s  Provider    Thread                                Idle min  Held by
MainThread  2230698  0        65         0.01        no session
MainThread  2230686  0        47         0.00        claude      7f8e2a10-5b3c-4d1e-9a2f-1c0b3d4e5f60  121       live-session
MainThread  2230687  0        47         0.00        claude      0a1b2c3d-4e5f-4061-8a7b-9c0d1e2f3a4b  330       background
-                                                    codex       11111111-2222-4333-8444-555555555555  32        none

3 processes, 160 MB; 3 sessions held
live-session 1, background 1, none 1
```

The first row is the script itself, a child of that listener's process with no session. Forge's host runs a release
without the route, so the reading there waits on the next release; this note's last section is what the code says
until then.

## What the code says about long holds

Read from the code at `b12703555`, with what `/proc` shows. File and line references are to that commit.

### Which rule most plausibly held the five

Probably not a running turn: none of the five used more than a quarter of a second of CPU a minute, and a turn running
for hours would show its thread as working. Not a stop that failed: a CLI the host has asked to stop has its input
closed, and every CLI under the host today still has it open (above). That leaves `request`, `background`, `compaction` and `live-session`. The audit recorded
no child processes, so a background shell cannot be ruled out for those five; today none of the eight CLIs has one.

`live-session` is the most plausible for most of them. It is the only rule that holds an idle, quiet CLI for as long as
nothing else happens, and the only one that starts a CLI with nobody acting: today's two oldest CLIs started with the
host, which only the live-session set does. On a headless host the set is Watcher's watched threads, the threads a
delegation or a council follows, threads with a queued follow-up of the user's or an outbox entry, and a send's own thread
(`liveSessionIds`, `src/main/agents/control.ts:2842`). Of those, Watcher's last longest by design (next section).
`request` is next: a question or permission card nobody answered holds its CLI with no timeout, by design. Which of these
held each of the five, the read will say once it runs on forge.

### Rules that can hold a session for hours with no end

| Rule | What ends it | Hours with no end? |
| --- | --- | --- |
| `live-session`, a standing watch | Stop watching, or the thread is settled (`watcher.ts:1167`; CONTEXT.md, Standing watch) | Yes, by design. |
| `live-session`, a Watcher request's thread | The desktop stops the request, or every thread in it is settled and connected (`requestDone`, `watcher.ts:4271`) | Yes, by design. Nothing times out a request whose desktop never returns. |
| `live-session`, a delegation or council | Its outcome is final (`delegation.ts:2601`, `councilService.ts:1000`) | Only while the work it follows runs. |
| `live-session`, a queued follow-up | Delivered, removed or restored | Yes, while it cannot be delivered (a pending request, a settled thread, a provider not connected). |
| `live-session`, an outbox entry | Its echo or its reconciliation (`control.ts:6156`) | Maybe: an uncertain entry waits for an echo with no deadline. |
| `live-session`, a send's own thread | The next observation, follow-up change or outbox change | Bug, small: `sendDraft` names the thread live (`control.ts:5769`) and does not observe again after it, so a send refused before dispatch leaves the thread live until something else changes the set. On a host nobody is using, that can be hours. |
| `request` | An answer, Stop, or the CLI ending (`claude.ts:1266`, `1295`) | Yes, by design: the user answers every request (ADR-0004). |
| `background` | Its end, Stop, an error result or the CLI ending (`claudeMonitoring.ts:76`) | Yes, by design (ADR-0023): a background command or watch that never ends. |
| `compaction` | A compaction boundary, or a new compaction | Yes, and it looks like a bug. A compaction whose result came with no boundary is left `uncertain` (`claude.ts:2049`), and `compactionPending` counts `uncertain` as pending (`src/shared/compaction.ts:9`), so the CLI is busy until a boundary turns up; the record's own error says it will not be retried. Sotto's idle compaction (ADR-0127) runs on exactly the idle threads in question. |

Two of these are worth their own issues, and neither is changed here:

- **A watched thread keeps its CLI until it is settled.** The live-session set spares an idle CLI so that Sotto's next
  unasked send does not pay a start. For a watched thread waiting on a review or a merge, that is 210 to 360 MB for as
  long as it is watched, and after a host restart every watched thread gets a CLI at once. The fix is a rule change for
  ADR-0038: spare a live-session CLI only while it is busy, stop it after thirty idle minutes like any other, and let the
  send that needs it start it, as a send already does for a thread only on screen.
- **An unconfirmed compaction holds its CLI with no end.** The fix: stop counting `uncertain` as pending for the reaper
  (it already refuses sends while it lasts), or give it a deadline after which it is read from the transcript and
  settled.

The send's own thread is a small one: `sendDraft` should observe again when it ends, however it ends, as `sendManual`
does on success.

One more, latent: `ClaudeProtocol.stop` ends the CLI's input and sends SIGTERM half a second later, and never SIGKILL.
The reaper awaits each stop, and sweeps never overlap (`sessionReaper.ts`), so a CLI that ignored SIGTERM would stop
every later sweep of that adapter. The read would show it as rows that say `none` across reads more than five minutes
apart. Today's `/proc` shows no CLI the host asked to stop, so it is not what holds the five.
