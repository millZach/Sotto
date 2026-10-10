# OpenSSH in Claude, Grok and Devin threads on Windows — 2026-09-27

On September 27, while working out why forge could not be added as a host, every OpenSSH client tool in `C:\Windows\System32\OpenSSH` exited 255 without a word inside a Claude thread, `ssh -V` included (#432). Win32-OpenSSH 9.5p2 reads its system configuration from `ProgramData` and quits silently when that variable is missing. Claude, Grok and Devin threads get their environment from an allow-list, and none of those lists named it. Codex's already did. Sotto's own SSH launcher passes its whole environment through, so adding a host was never affected by this.

## What changed

`programdata` and `allusersprofile` are now on the environment allow-lists in:

- `src/main/agents/subscriptionClaude.ts`. Claude threads, and Claude reasoning and side calls, all take their environment from here.
- `src/main/agents/grokRpc.ts`, for Grok threads.
- `src/main/agents/subscriptionGrok.ts`, for Grok reasoning and side calls.
- `src/main/agents/devinRpc.ts`, for Devin threads.

`ALLUSERSPROFILE` names the same folder on current Windows, and some tools look for it instead. Neither variable carries a secret. Neither exists on macOS, so nothing changes there.

## Automated checks

- `tests/integration/subscriptionClaude.test.ts`: a Claude client's environment keeps `ProgramData` and `ALLUSERSPROFILE` and still drops `ANTHROPIC_API_KEY`.
- `tests/unit/main/grokRpc.test.ts` (new): `grokEnvironment` keeps both and still drops `XAI_API_KEY`.
- `tests/integration/subscriptionGrok.test.ts`: the fake Grok CLI records both variables in the environment it was started with, set to fixture values so an inherited value cannot pass the test.
- `tests/unit/main/devinRpc.test.ts`: `devinEnvironment` keeps both and still drops `DEVIN_API_KEY`.

Without the change to `src/`, all four fail.

Against the built app, `tests/e2e/phase-four-personal-providers.spec.ts` (Claude and Grok threads through the fake CLIs) and `tests/e2e/agents.spec.ts` pass. Two specs fail for reasons that come before this change. `tests/e2e/devin-provider.spec.ts` times out waiting for "Thread options" in the New thread dialog, and does the same when built from `origin/main`. `tests/e2e/native-provider-selection.spec.ts` expects a list of Settings sections that has no Phones tab.

## Checked on this machine

The adapters' environment functions were bundled with esbuild into a throwaway script, outside the repository. From a parent process with `ProgramData=C:\ProgramData` set, the way Sotto's main process has it, the script ran `C:\Windows\System32\OpenSSH\ssh.exe -V` under each environment. Windows 11, OpenSSH_for_Windows 9.5p2:

| Environment | Before (`origin/main`) | After |
| --- | --- | --- |
| Parent's, with `ProgramData` removed | exit 255, no output | exit 255, no output |
| Claude thread (`ClaudeSubscriptionClient.environment()`) | exit 255, no output | exit 0, `OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2` |
| Grok thread (`grokEnvironment()`) | exit 255, no output | exit 0, same |
| Devin thread (`devinEnvironment()`) | exit 255, no output | exit 0, same |

The first row is the failure from the issue: take `ProgramData` away and `ssh -V` says nothing and exits 255.

## In a real Claude thread, before the fix

The shell that finished this change was itself a Claude thread in the installed Sotto 0.1.20 (`Sotto.exe` started `claude.exe`, which started the shell). Its environment has no `ProgramData`. There, `ssh -V` exited 255 with no output, and `ProgramData='C:\ProgramData' ssh -V` in the same shell printed `OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2` and exited 0. That is the issue's failure, seen live in a thread rather than rebuilt.

## Still to check live

There are no screenshots, because nothing a user sees changed. A tool run in a thread prints the same output it would in a terminal. `ssh -V` has not yet been run from a Claude thread in a build that has this fix. That needs a turn on the owner's Claude subscription and the owner approving the shell command, so the table above runs the same executable under the environment `ClaudeSubscriptionClient.environment()` builds, the one `claude.ts` hands to the Claude process, without the model in between.

The live check, before merge: start the branch with `npm run dev`, open a Claude thread on Windows, ask it to run `ssh -V`, and record the output here. It should print `OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2`, or whatever version is installed, and exit 0.
