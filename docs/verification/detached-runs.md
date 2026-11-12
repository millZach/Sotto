# Detached runs verification

November 11, 2026. `fix/detached-agent-runs`, issue #2476, [ADR-0204](../adr/0204-sotto-finds-the-agent-runs-a-thread-detaches.md). Zach's pick on November 11, 2026: variant 1, **Background work**, of `docs/prototypes/detached-runs-prototype.html`, straight to stable.

## How it was run

On the Windows laptop, with the built app (`npm run build`):

```sh
npm run typecheck
npx vitest run tests/unit/main/detachedRunScan.test.ts tests/unit/main/detachedRuns.test.ts tests/integration/detachedRunScan.test.ts
npx vitest run tests/unit/renderer/detachedRunRow.test.tsx tests/unit/renderer/agents/threadsView.test.tsx
npx vitest run tests/unit/host/remoteCommands.test.ts tests/unit/main/monitoringWorkspace.test.ts tests/unit/main/limitRestart.test.ts tests/unit/main/claudeBackgroundWork.test.ts tests/unit/renderer/threadDelegation.test.tsx
npx vitest run tests/unit/main/codeSizeBudget.test.ts tests/unit/main/copySites.test.ts tests/unit/main/zodSchemaSites.test.ts tests/unit/renderer/scaleTokens.test.ts tests/unit/renderer/themeTokens.test.ts tests/unit/shared/interfaceCatalogs.test.ts
npx vitest run tests/perf/streamingCopyBudget.perf.test.ts tests/perf/ownerScaleWorkBudget.perf.test.ts
SOTTO_E2E_EVIDENCE=publish npx playwright test tests/e2e/detached-runs.spec.ts
```

On forge, the scan and stop bundled with esbuild and run under the pinned Node, read-only against the live run.

## What was checked

**The live example, on forge, read-only.** The scan, given the Sotto host's PID 931253 as Sotto's own, read 416 processes in 63 ms and found one agent client outside the host's tree: PID 961128, `tetherfall-art-director`, Claude Code, `claude-fable-5-2`, `high`, in `/home/zach/Projects/2.5 shooter/.claude/worktrees/art-push`, carrying `CLAUDE_CODE_SESSION_ID=0d15c982-…`. Every Claude Code process under the host was left out. The host's `claude-threads.json` names that session as the current one of adapter thread `15bf5dce-…`, and its `threads.json` binds that to Sotto thread `5a4f24ec-…`, the thread in the report. Nothing was signalled or written; the run was left to finish, as Zach asked.

**Linux, a run cut loose the way a thread does it.** On forge, a shell started a stand-in with `setsid -f nohup` and exited. The scan found it with init as its parent, its mark and its folder; it led its own process group; `endRun` ended it, and the next scan did not list it.

**Windows, the environment reader.** A stand-in started detached with `CLAUDE_CODE_SESSION_ID` set was found with that mark, its `--name` and `--model`, and its working folder, read from its environment block by the reader PowerShell compiles. A look took 2.4 s with 600 processes. `tests/integration/detachedRunScan.test.ts` does the same on whatever system runs it, checks that `ANTHROPIC_API_KEY` in the stand-in's environment is never read out, and that `taskkill` ends it.

**The watch** (`detachedRuns.test.ts`, with a fake process table): a run outside Sotto is tied to the thread its mark names, and one under Sotto or with another session's mark is not; a launcher and the client it starts count once; the same process keeps the same ID, so rows do not churn; a failed look keeps what was known; it looks 3 seconds after a turn ends and every 15 seconds while it knows of a run, then stops looking; Stop on another thread's run, on a run that ended, or on a process that took the run's number is refused and nothing is signalled. In a real `WorkspaceHost`, the run is laid after the provider's own subagent, kept across a provider update, never written to `workspace.json`, and Stop ends it and leaves the subagent.

**The row and the readout in the built app** (`detached-runs.spec.ts`, first journey, the run given as its host publishes it): under the last reply, after **Still working after this reply**, the row reads **Detached run** `tetherfall-art-director`, **Working** and **Stop**, then "Claude Code · claude-fable-5-2, high · /home/zach/Projects/2.5 shooter/.claude/worktrees/art-push · running 20m", the line, and **Command**. The readout says *Working · 1 detached run*; the sidebar keeps the thread under **Working now** with Working, though no turn runs. Focus goes from Stop to Command, and Enter opens the command. At 1600x1000, 1280x800 and 820x560, in dark and light, nothing in the pane is wider than the pane and every piece of the row's text meets 4.5:1 on what it sits on. Stop reaches main, which says nothing was stopped, since a desktop journey looks for no runs. When the run ends the row and the readout go.

**The whole way in the built app** (second journey): the real Claude adapter over the fake CLI. During the thread's first turn the test starts a stand-in outside Sotto with that thread's Claude Code session in its environment; when the turn ends, the watch finds it, the row reads **Detached run** `e2e-art-director` with Claude Code, `claude-test` and its folder, and the readout counts it. **Stop** ends the process, the row goes and the thread rests.

**Stable.** The provider's own agents' rows still keep to delegation's Owl switch; a detached run's row shows without it (the first journey runs on the stable track).

## Screenshots

- `artifacts/detached-runs/detached-run-dark-1280x800.png`: the row with its command open, the readout and the sidebar.
- `artifacts/detached-runs/detached-run-light-820x560.png`: the same at the minimum size, light.
- `artifacts/detached-runs/detached-run-dark-1600x1000.png`, `detached-run-dark-820x560.png`, `detached-run-light-1600x1000.png`, `detached-run-light-1280x800.png`: the other sizes and themes.
- `artifacts/detached-runs/found-by-the-watch-dark-1280x800.png`: a run the watch found through the real Claude adapter, before Stop.

## Not verified

- macOS: `ps -E` and `lsof` were not run on a Mac here. `tests/integration/detachedRunScan.test.ts` runs there wherever CI runs the suite on macOS.
- The forge host with this build: it needs the next Owl, and by then the art-director run may have ended. The chain it runs was checked piece by piece above against that very run.
- A real `claude -p` or `codex exec` started by a real Sotto thread's own command and found by a running Sotto. Doing it needs a second Sotto beside Zach's, on his account; the second journey stands in for it with the real adapter and a stand-in client carrying the session as Claude Code passes it.
- Codex: `CODEX_THREAD_ID` was read from a real `codex exec` on forge (it equals the Codex thread's ID), and the adapter's mapping is typed and small, but no journey runs a Codex thread.
- Reduced motion: the row's Working ring follows the existing delegation ring's rule; not captured.
