# Hermes background commands verification

November 16, 2026. `fix/process-found-background-commands`, issue #2637, [ADR-0023](../adr/0023-working-reads-the-providers-agent-tasks.md) (amendment for Hermes). Zach's choice on November 16, 2026: **count it only**. Devin is split out to #2649.

## How it was run

On forge, with Node 24.22.1:

```sh
npm run typecheck
npx eslint <changed files>
npx vitest run tests/unit/main/hermes*.test.ts tests/unit/main/detachedRun*.test.ts tests/integration/detachedRunScan.test.ts tests/unit/main/backgroundCommandWatch.test.ts tests/integration/childProcesses.test.ts tests/unit/main/copySites.test.ts tests/unit/main/zodSchemaSites.test.ts tests/unit/main/codeSizeBudget.test.ts
```

## What was checked

- **The source.** [The source note](../research/2026-11-16-hermes-background-commands-source.md) has what Hermes 0.19.0's own code says about starting a background command and about its end.
- **The match** (`backgroundCommandWatch.test.ts`):
  - a child carrying the thread's own `HERMES_SESSION_KEY` is a background command;
  - a child with no mark (an MCP server) is not, and neither is one carrying another session's mark;
  - the command is named from Hermes's own `-lic "set +m; …"` form, from macOS's unquoted line, or as the shell left it after replacing itself.
- **The watch** (same file, with a stand-in process list and stand-in timers):
  - it looks 3 seconds after a turn ends, or at once when asked, then every 15 seconds while it finds any;
  - each command keeps its ID from look to look, and goes once its process has;
  - nothing more is looked at once none is found;
  - a failed look keeps what was known, and stopping it drops everything.
- **The real process table** (`childProcesses.test.ts`): a process started from the test carrying `HERMES_SESSION_KEY` is listed as the test's child, with its mark and command read back, and is not listed once it ends. This runs on Linux here, and on Windows in CI, where it goes through the same environment reader as detached runs.

**After review** (Sol at max, both axes):
- The first build matched on Hermes's command line, which a shell replacing itself with the command changes, and which macOS lists without quotes. It now matches on the session mark, which outlasts both.
- A turn that ran a command now waits for one look before its end goes out. Before, Watcher heard the turn finished with no background work, and its once-per-turn news could not be corrected.
- The process reading reuses the detached-run scan's, with a choice of which processes to read, rather than a second copy.
- The glossary no longer calls detached runs the only work Sotto finds itself.
- Two timing options nothing used are gone.

## Not checked here

- **Live Hermes.** Hermes is not installed on forge and has no model credentials there, and was not installed for this. So no live Hermes session has shown a background command found and counted, and the adapter's wiring is checked by its types and the tests above, not by a Hermes process. There is no fake Hermes client in the adapter contract to drive it.
- **Hermes on Windows and macOS**: whether its shell is started with the same `-lic` there.
- **Devin**: #2649.
