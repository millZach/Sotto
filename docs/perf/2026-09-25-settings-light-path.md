# Thread settings on a light path - September 25, 2026

Issue #318. A press on a thread settings chip used to read the thread before the change and again after it. Each read went all the way to the provider. On Claude a read opens the thread, so a thread the reaper had stopped started its CLI for the first read, and then the change stopped it and started it again. On Codex each read is `thread/read` with the whole transcript. The coordinator also wrote its state twice per change: once to add the outbox entry and once to clear it.

Now the coordinator checks the change against the thread it already holds and sends it. Each adapter still checks the thread's status, pending requests and model before it acts. An adapter that has the provider's confirmation hands back the snapshot it emitted for it (`AgentHostResult.snapshot`), and that snapshot is the reconciliation. Codex, Claude and the workspace always do when the change is confirmed; Grok and Devin do in the cases ADR-0007's amendment names, and otherwise the coordinator reads the thread once after the change. Claude's snapshot comes from #317's settings path, which applies a change over the running CLI's control channel or starts the CLI with it, so the coordinator reads a Claude thread neither before nor after. The outbox entry is still written before the change goes out. When the provider confirms inside the same dispatch and nothing else changed, the write that would only clear the entry is not made; the next write carries it, and closing Sotto writes it.

## Numbers

One chip press is one permission-mode change through the whole host stack: the coordinator, the workspace, provider selection, Sotto's thread identities and the real adapter, over the fake Claude and Codex clients the adapter contract uses, each a real child process. "Running" is a thread on screen with its session up. "Reaped" is a thread nothing is watching, whose session the reaper has stopped. Every figure is the median of five presses. Counts were the same in all four runs of each side unless a range is shown.

| Provider | Session | Thread reads | Coordinator writes | Adapter alias writes | Session starts |
| --- | --- | ---: | ---: | ---: | ---: |
| Codex | running | 2 → 0 | 2 → 1 | 4 → 2 | 0 → 0 |
| Codex | reaped | 2 → 0 | 2-7 → 1 | 5 → 3 | 1 → 1 |

Claude was measured three ways: before either change, with this change alone, and joined with #317 in the same checkout. The presses alternate between full access and auto-accept edits, which Claude Code enters and leaves only by starting its CLI again, so the joined code was also run on a running thread between auto-accept edits and approval required, which its CLI takes in place. Before either change every Claude press restarted the CLI whatever the mode, so the in-place row has no earlier figures.

| Session | Modes | Thread reads | Coordinator writes | Adapter alias writes | Session starts |
| --- | --- | ---: | ---: | ---: | ---: |
| running | full access and auto-accept edits | 2 → 1 → 0 | 2 → 1 → 1 | 1 → 1 → 1 | 1 → 1 → 1 |
| running | auto-accept edits and approval required | 0 | 1 | 1 | 0 |
| reaped | full access and auto-accept edits | 2 → 1 → 0 | 2 → 1 → 1 | 1 → 1 → 1 | 2 → 1 → 1 |

A thread read is a call to the adapter's `refreshThread`. A write is one `AtomicJsonStore` write: `agents.json` for the coordinator, `claude-threads.json` or `codex-threads.json` for the adapter. A session start is a CLI launch or resume for Claude and a `thread/resume` for Codex.

With both changes the fake Claude client heard `set_permission_mode` alone for an in-place press; the old CLI's exit, then `resume` and `initialize`, for a press on a running thread into or out of full access; and `resume` and `initialize` for a press on a reaped thread.

What the fake Codex client heard for one press:

| Session | Before | After |
| --- | --- | --- |
| running | `thread/read`, `thread/settings/update`, `thread/read` | `thread/settings/update` |
| reaped | `config/read`, `thread/resume`, `thread/read`, `thread/settings/update`, `thread/read` | `config/read`, `thread/resume`, `thread/settings/update` |

Median milliseconds from the press to the coordinator's reply, the range across four runs:

| Provider | Session | Before | After | Joined with #317 |
| --- | --- | ---: | ---: | ---: |
| Claude | running, full access and auto-accept edits | 69-149 | 69-130 | 71-118 |
| Claude | running, auto-accept edits and approval required | | | 9-16 |
| Claude | reaped | 115-195 | 77-108 | 79-104 |
| Codex | running | 30-40 | 13-20 | |
| Codex | reaped | 35-58 | 20-27 | |

A reaped Claude thread no longer starts its CLI twice, and that is most of its time. With this change alone a running Claude thread still stopped its CLI and started it again for every press. Joined with #317, its CLI takes a change between the other modes in place, with nothing started and nothing read, in about a tenth of the time; entering or leaving full access still starts it again (ADR-0023), now without the read after. Codex no longer reads its transcript at all for a settings change, so it takes about half the time, and a real transcript is far longer than the fixture's.

## What these numbers are and are not

- They are Sotto's own work, the disk and the fake clients' start-up. There is no model, no network and no real transcript. A real Codex `thread/read` grows with the thread, so the reads removed cost more in use than here; a real Claude CLI takes longer to start than the fake one.
- The times were taken on the Windows development machine (24 cores, Node v24.14.1) while another agent's tests ran on it. Read them as sizes, not budgets. The counts do not depend on the machine.
- Codex's reaped "before" wrote its coordinator state two to seven times: resuming the session emitted snapshots that changed other saved facts while the reads ran. "After" wrote once in every run.
- "Before" is `control.ts`, `workspace.ts`, `providerSwitch.ts`, `threads.ts`, `codex.ts`, `grok.ts` and `devin.ts` from `origin/main` at `c4b8af02`, put back in this checkout for the run, with the same benchmark. "After" is this change with `claude.ts` still as on `origin/main`. "Joined" is this change and #317 together, run four times on the same machine. Codex was not run again for it, since #317 changes nothing on its path.
- Grok and Devin were not timed. Grok hands back the snapshot of the reload that applied the mode, so its coordinator read after the change is gone. Devin's read after the change started the session the change had just stopped; ADR-0022 resumes it on the thread's next action, and now nothing starts it sooner.
- Settings that are already in effect are still sent to the adapter. The issue allows skipping them when the adapter reports the effective values, and this change does not: Grok and Devin already treat an unchanged setting as nothing to do, while Codex sends it again. Claude sends a running CLI no request for it but saves it again, and starts a CLI that is not running. A skip is left for a later change.

## Re-run

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/threadSettings.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

It is skipped without `SOTTO_PERF_BENCH=1`, because it starts real child processes and waits for the reaper. Each line it prints is counts, timers and protocol method names only: nothing a thread says is recorded. The counts are pinned in the default run by `tests/integration/threadSettingsLightPath.test.ts` (a running Claude thread's change starts no CLI and reads nothing, and a reaped one's starts its CLI once and reads nothing; a Codex change reads no transcript and writes the coordinator state once) and `tests/unit/main/agentSettingsLightPath.test.ts` (no read with a snapshot, one without; an uncertain or unconfirmed change keeps its outbox entry and its error; one coordinator write per confirmed change, and a restart or a close clears the entry left on disk). The adapter contract's "thread settings result" section checks what every adapter hands back.
