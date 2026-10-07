# The folder npm leaves behind, and the update after it

The evidence for the October 3, 2026 amendment to [ADR-0042](../adr/0042-provider-client-updates.md). A Codex update from Settings → Providers failed with `npm error EBUSY: resource busy or locked, copyfile '…' -> '…'` although the update stops no thread and [the September 28 note](2026-09-28-client-update-over-running-executable.md) had shown npm installing over a running executable.

Measured October 3, 2026 on Windows 11 Home 10.0.26200 with npm 11.11.0 and the real `@openai/codex` package, installed with `--prefix` into a temporary folder that was deleted afterwards. Each "thread" was the package's own `codex.exe app-server`, started with its stdin held open.

## What npm does with the old version

npm moves the package it replaces to `.<name>-<hash>` beside it and deletes that folder once the new version is in. The September 28 note called the name random. It is not: `@npmcli/arborist/lib/retire-path.js` takes the first eight letters and digits of a SHA-1 of the package's path, so every update of Codex in one place uses the same name (`.codex-HJxjGPEp` in the test folder, `.codex-6TeUjdn8` in the development machine's `%APPDATA%\npm\node_modules\@openai`). When a thread is still running the old `codex.exe`, the delete fails, npm warns `cleanup Failed to remove some directories`, exits 0, and the folder stays.

When the next update finds that name taken, the folder rename fails with `EPERM` and `@npmcli/fs/lib/move-file.js` falls back to moving one file at a time. Renaming a file onto a program that is still running is refused too, so it copies instead, and the copy onto the running program fails with `EBUSY`. npm then rolls back, and the version is unchanged.

## What was run

| Step | Result |
| --- | --- |
| Install 0.159.3, start a thread on it, update to 0.160.0 | Exit 0, 0.160.0 installed, `.codex-HJxjGPEp` left holding the running 0.159.3 |
| Start a second thread on 0.160.0, then `npm install -g` again, the old thread still running | `npm error EBUSY: resource busy or locked, copyfile '…\codex\…\codex.exe' -> '…\.codex-HJxjGPEp\…\codex.exe'`, version unchanged. The same line as the failed update |
| The same, with nothing running from the leftover folder | Exit 0. npm reuses the folder and deletes it |
| Open a running `codex.exe` for writing (`fs.open(path, 'r+')`) | `EBUSY`. The same file once the program stops: opens. This is how Sotto tells a leftover in use from one that is not, without changing it |

So an update made while a thread works leaves the folder, which costs nothing, and the update after it fails only if something from before the first update is still running. On the development machine that was two Codex processes left running by an editor plugin whose own session had closed. A thread that stays busy across two updates would do the same.

## With the fix

The same steps through Sotto's own installer (`ProviderClients.install`, real npm, the npm prefix pointed at the test folder):

1. Install 0.159.2 and start a thread on it. Update to 0.159.3 while it runs: `.codex-yjEjpYLb` is left holding 0.159.2.
2. Start a second thread on 0.159.3. Plain npm would now fail as above.
3. Sotto's update to the latest version: `{"ok":true}`. 0.160.0 is installed. The leftover still in use was moved to `.codex-yjEjpYLb.old-<time>` before npm ran, and npm left a new `.codex-yjEjpYLb` holding 0.159.3. Both threads' processes were still running afterwards.
4. Both threads stop. The next update: `{"ok":true}`, and only `codex` is left. Both leftover folders were deleted.

Renaming the leftover works while its program runs, because Windows refuses to rename a folder only when a file in it is open without delete sharing or a process's working directory is inside it. A running program does neither. Measured here: a `codex.exe` started with its working directory inside the package does block the rename (`EBUSY`, `syscall rename`). Neither Sotto nor Codex starts it that way, and Sotto leaves such a folder where it is, so npm says what it says.

One more refusal turned up while the test ran under the full suite: in 2 runs of 25 the probe found the program running, and moving the folder then failed with `EPERM`. Opening the folder's idle programs for writing is enough for a virus scanner to read them, and while it does the folder cannot be moved. That passes, so Sotto tries the move again for up to about three seconds. With that, 0 of 25 runs under the same load failed.

## What this does not show

Claude Code and Grok Build installed through npm take the same path through npm and get the same cleanup, but were not run here. The cleanup runs on Windows only: elsewhere npm deletes a running program's folder like any other, so nothing is left behind. Grok Build's program lives in `~/.grok/bin`, outside the package, and its installer moves a running `grok.exe` aside for itself. The leftover folder is cleared only when an update runs. Until then it stays, about 450 MB for Codex.
