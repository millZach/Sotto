# Thread settings on a light path - September 26, 2026

Issue #318. A press on a thread settings chip used to read the thread before the change and again after it. Each read went all the way to the provider. On Claude a read opens the thread, so a thread the reaper had stopped started its CLI for the first read, and then the change stopped it and started it again. On Codex each read is `thread/read` with the whole transcript. The coordinator also wrote its state twice per change: once to add the outbox entry and once to clear it.

Now the coordinator checks the change against the thread it already holds and sends it. Each adapter still checks the thread's status, pending requests and model before it acts. An adapter that has the provider's confirmation hands back the snapshot it emitted for it (`AgentHostResult.snapshot`), and that snapshot is the reconciliation. Codex, Grok and Devin do this now. Claude does not yet; #317 changes its settings path, and until then the coordinator reads a Claude thread once, after the change. The outbox entry is still written before the change goes out. When the provider confirms inside the same dispatch and nothing else changed, the write that would only clear the entry is not made; the next write carries it, and closing Sotto writes it.

## Numbers

One chip press is one permission-mode change through the whole host stack: the coordinator, the workspace, provider selection, Sotto's thread identities and the real adapter, over the fake Claude and Codex clients the adapter contract uses, each a real child process. "Running" is a thread on screen with its session up. "Reaped" is a thread nothing is watching, whose session the reaper has stopped. Every figure is the median of five presses. Counts were the same in all four runs of each side unless a range is shown.

| Provider | Session | Thread reads | Coordinator writes | Adapter alias writes | Session starts |
| --- | --- | ---: | ---: | ---: | ---: |
| Claude | running | 2 → 1 | 2 → 1 | 1 → 1 | 1 → 1 |
| Claude | reaped | 2 → 1 | 2 → 1 | 1 → 1 | 2 → 1 |
| Codex | running | 2 → 0 | 2 → 1 | 4 → 2 | 0 → 0 |
| Codex | reaped | 2 → 0 | 2-7 → 1 | 5 → 3 | 1 → 1 |

A thread read is a call to the adapter's `refreshThread`. A write is one `AtomicJsonStore` write: `agents.json` for the coordinator, `claude-threads.json` or `codex-threads.json` for the adapter. A session start is a CLI launch or resume for Claude and a `thread/resume` for Codex.

What the fake Codex client heard for one press:

| Session | Before | After |
| --- | --- | --- |
| running | `thread/read`, `thread/settings/update`, `thread/read` | `thread/settings/update` |
| reaped | `config/read`, `thread/resume`, `thread/read`, `thread/settings/update`, `thread/read` | `config/read`, `thread/resume`, `thread/settings/update` |

Median milliseconds from the press to the coordinator's reply, the range across four runs:

| Provider | Session | Before | After |
| --- | --- | ---: | ---: |
| Claude | running | 69-149 | 69-130 |
| Claude | reaped | 115-195 | 77-108 |
| Codex | running | 30-40 | 13-20 |
| Codex | reaped | 35-58 | 20-27 |

A reaped Claude thread no longer starts its CLI twice, and that is most of its time. A running Claude thread is unchanged: its change still stops the CLI and starts it again, which is what #317 is for. Codex no longer reads its transcript at all for a settings change, so it takes about half the time, and a real transcript is far longer than the fixture's.

## What these numbers are and are not

- They are Sotto's own work, the disk and the fake clients' start-up. There is no model, no network and no real transcript. A real Codex `thread/read` grows with the thread, so the reads removed cost more in use than here; a real Claude CLI takes longer to start than the fake one.
- The times were taken on the Windows development machine (24 cores, Node v24.14.1) while another agent's tests ran on it. Read them as sizes, not budgets. The counts do not depend on the machine.
- Codex's reaped "before" wrote its coordinator state two to seven times: resuming the session emitted snapshots that changed other saved facts while the reads ran. "After" wrote once in every run.
- "Before" is `control.ts`, `workspace.ts`, `providerSwitch.ts`, `threads.ts`, `codex.ts`, `grok.ts` and `devin.ts` from `origin/main` at `c4b8af02`, put back in this checkout for the run, with the same benchmark.
- Grok and Devin were not timed. Grok hands back the snapshot of the reload that applied the mode, so its coordinator read after the change is gone. Devin's read after the change started the session the change had just stopped; ADR-0022 resumes it on the thread's next action, and now nothing starts it sooner.
- Settings that are already in effect are still sent to the adapter. The issue allows skipping them when the adapter reports the effective values, and this change does not: Grok and Devin already treat an unchanged setting as nothing to do, while Codex sends it again and Claude restarts for it. A skip is left for a later change.

## Re-run

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/threadSettings.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

It is skipped without `SOTTO_PERF_BENCH=1`, because it starts real child processes and waits for the reaper. Each line it prints is counts, timers and protocol method names only: nothing a thread says is recorded. The counts are pinned in the default run by `tests/integration/threadSettingsLightPath.test.ts` (a reaped Claude thread starts its CLI at most once and is not read before the change; a Codex change reads no transcript and writes the coordinator state once) and `tests/unit/main/agentSettingsLightPath.test.ts` (no read with a snapshot, one without; an uncertain or unconfirmed change keeps its outbox entry and its error; one coordinator write per confirmed change, and a restart or a close clears the entry left on disk). The adapter contract's "thread settings result" section checks what every adapter hands back.
