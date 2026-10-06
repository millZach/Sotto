# Replacing a client while it runs, on Windows

The evidence for the September 28, 2026 amendment to [ADR-0042](../adr/0042-provider-client-updates.md) and for [ADR-0038](../adr/0038-one-client-process-per-thread.md): a client update can run while threads keep working, because Windows lets the installer put a new client beside a running one.

Measured September 28, 2026 on Windows 11 Home 10.0.26200, Node 24.14.1 and npm 11.11.0. The running executable was a copy of `C:\Windows\System32\PING.EXE` (`-n 6 127.0.0.1`, about five seconds), so nothing on the machine was touched outside a temporary folder, and the npm install used a temporary `--prefix` rather than the machine's global folder.

## What was run

1. Start `client\client.exe`, then, while it runs, copy a new executable over it, rename its folder to `client.old`, and write a new `client\client.exe`.
2. Pack two versions of a package that ships `client.exe` in its own folder, the way `@openai/codex` ships its native binary. Install 1.0.0 with `npm install -g --prefix <tmp>`, start `node_modules\sotto-measure-client\client.exe` from the installed package, and while it runs install 2.0.0 the same way.

## What happened

| Step | Result |
| --- | --- |
| Overwrite the running executable in place | Refused, `EBUSY` |
| Rename the running executable's folder | Allowed |
| Write a new executable at the old path | Allowed |
| The first process | Ran to the end, exit code 0 |
| `npm install -g` over the package whose executable was running | Exit code 0 |
| Installed version afterwards | 2.0.0 |
| The process started from 1.0.0 | Ran to the end, exit code 0 |
| Left in `node_modules` | `sotto-measure-client` and `.sotto-measure-client-<random>`, the old folder npm moved aside and could not remove while its executable ran |

So "Windows refuses to overwrite a running executable" is true, and it is not a reason to stop the client first: npm moves the old package folder aside and installs beside it, and the running process never notices.

Grok Build's own installer does the same to a single file, moving a running `grok.exe` to `grok.exe.old`, and Claude Code's native updater replaces `~/.local/bin/claude.exe` while sessions run. Both were seen on the development machine while the change was planned and were not run again for this note.

## What this does not show

- It does not run a real provider client's installer, or a client's own updater, against a running thread. The adapters' side of that (a working thread finishes on its old process, an idle one moves at once) is covered by the fakes in `tests/integration/claudeClientUpdate.test.ts`, `codexSessionProcesses.test.ts`, `grokThreadProcesses.test.ts` and the client update case in `adapterContract.ts`.
- It says nothing about macOS, where replacing a running executable's file has never been refused.
