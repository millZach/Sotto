# Startup crash: one snapshot per Claude transcript line

Date: 2026-09-18
Scope: installed Sotto 0.1.3 on the Windows PC dying on every launch, about ten seconds in, with no window.

## Symptom

`Sotto.exe` exits with code -36861 after roughly ten seconds. Windows records no crash, there is no
dump and nothing reaches the event log, because V8 aborts the main process itself:

```
OOM error in V8: MarkCompactCollector: young object promotion failed Allocation failed - JavaScript heap out of memory
```

The heap is 3.7 GB at the abort. Leftover `agents.json.tmp-*` files in the profile mark each launch
that died between writing and renaming.

## Loop

Launch the installed build with its streams captured and wait for the exit. The shell that runs inside
an agent harness inherits `ELECTRON_RUN_AS_NODE=1`, which turns `Sotto.exe` into a bare Node process
that exits 0 in a tenth of a second; strip every `ELECTRON_*` variable first or the loop lies.

```powershell
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'C:\Program Files\Sotto\Sotto.exe'; $psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
foreach ($k in @($psi.EnvironmentVariables.Keys)) { if ($k -like 'ELECTRON_*') { $psi.EnvironmentVariables.Remove($k) } }
$psi.EnvironmentVariables['ELECTRON_ENABLE_LOGGING'] = '1'
$p = [System.Diagnostics.Process]::Start($psi); $err = $p.StandardError.ReadToEndAsync()
$p.WaitForExit(45000); "exit $($p.ExitCode)  oom $($err.Result -match 'heap out of memory')"
```

Red on 0.1.3 every run (exit -36861, oom True, 10 to 12 s). The unpackaged build
(`node_modules\electron\dist\electron.exe .`) against the same profile goes red the same way.

Electron ignores the `APPDATA` variable when resolving the profile, so pointing it at a copy does not
isolate anything; every such run used the real profile. Bisection therefore moved files aside instead.

## Cause

`Sotto.exe --inspect=9229` plus a sampling heap profile over the inspector, taken in the seven seconds
before the abort, put 2.7 GB of the 3.7 GB under `structuredClone` inside `workspaceSnapshot`, reached
from `ClaudeSessionLog.read`. On connect the Claude adapter reads each thread's transcript under
`~/.claude/projects` from its first byte. Its per-entry callback in `claude.ts` called `emit()` for
every line, and each emit clones the adapter view, the aggregate view and the workspace state, then
queues a write of the 3.5 MB `workspace.json`. The five thread transcripts hold 3,600 entries between
them (the largest 17 MB), so startup queued thousands of multi-megabyte snapshots faster than they
could be written or collected.

Confirmed by moving the five transcripts aside: the same build started and stayed up. Restored
afterwards.

## Fix

`ClaudeSessionLog` takes an `onSettled` callback that runs once after a read that delivered entries,
and the adapter emits there instead of per entry. One publish per poll; the same messages arrive.

Regression test: `tests/integration/claudeTranscriptCatchUp.test.ts` appends 1,500 authored entries to
a fixture thread's transcript and asserts that one poll publishes at most four snapshots while the last
entry still arrives. It reported 1,500 before the fix.

## Result

- Regression test, `claudeAdapter`, `claudeAdapterSafety`, `claudeRollback` and `adapterContract`: 51 passed, 2 skipped.
- Typecheck and eslint clean.
- Fixed unpackaged build against the real profile: alive at 45 s, main-process working set peak 469 MB.

Not covered here: the Codex rollout reader, which tails rather than replays and did not appear in the
profile.
