# Hermes on Windows and Linux — November 16, 2026

Branch `feat/hermes-windows-linux`, from `origin/main` at `9316ba59b`. Hermes was held off every platform but macOS
(#2361); this change lifts that hold, adds the official installers' folders to the lookup, and ends the gateway's
whole tree on Windows. The screenshots named here are in `artifacts/hermes-windows-linux/`.

## How it was run

Each system ran a build of this branch (`npm run build`, then Playwright driving `out/main/index.js`) on a throwaway
profile (`--user-data-dir`), with `SOTTO_OWL_FEATURES` turning the Owl features on. The installed Sotto on the laptop
was not restarted, quit or updated. Hermes ran on the user's keyless own model server, Obsidian
(`deepseek-v4.1-flash`), added through **Add an API or server → Another address**. No key was used.

- **Windows**: the laptop, Windows 11. Hermes Agent **0.23.1** from its official installer (`install.ps1`), at
  `%LOCALAPPDATA%\hermes\bin\hermes.exe`. `hermes pm repair` was run against the throwaway profile's `hermes` folder.
- **Linux**: forge, Omarchy. Hermes Agent **0.23.2** from its official installer (`install.sh`, read first; its
  stable channel had moved past 0.23.1). `hermes pm repair` was run against the throwaway profile's `hermes` folder.

## What each check showed

| Check | Windows | Linux |
| --- | --- | --- |
| 1. Connect in Settings › Providers | **Connected, 0.23.1** (`windows-settings-connected.png`) | **Connected, 0.23.2** (`linux-settings-connected.png`) |
| 2. A Hermes thread replies from Obsidian | **Replied** (`windows-thread-reply.png`), but see *First send in a new project* | **Replied** on the first send (`linux-thread-reply.png`) |
| 3. A background command is counted and released | **Not counted** (`windows-thread-background-command.png`) | **Not counted** (`linux-thread-background-command.png`) |
| 4. Disconnect leaves no Hermes process | **None left** | **None left** |

**Check 4.** On Windows, a thread started `sleep 300` in the background, then Disconnect was pressed. The recorded
gateway (`hermes.exe` and its Python), the thread's `hermes acp` (both processes), and the command's `bash.exe` and
`sleep.exe` were all gone afterwards. Before the `taskkill /T` change, the same steps left `bash.exe` and `sleep.exe`
running with their parent gone, and they were stopped by hand. On Linux, the gateway, `hermes acp` and `sleep 300` were
all gone; Hermes's own process supervisor reaps what the gateway registered. Quitting the app left no Hermes process on
either system.

The thread's history came back after the app restarted on Windows, and the next turn ran in the same session.

## Found along the way

**Background commands are not found with Hermes 0.23.** #2637 looks for a command among the children of the thread's
`hermes acp` process, carrying `HERMES_SESSION_KEY` equal to the thread's ACP session. Hermes 0.23 runs turns in its
gateway, so the command is a child of the gateway's Python, and its mark is
`agent:project-<profile>:local:dm:<ACP session>`. Both were read live on both systems; the same holds on a Mac with
0.23, where #2637 was not checked live either. Nothing is counted, nothing fails, and the turn ends as usual. This is
the same on every platform, so it is left as a follow-up rather than changed here.

**First send in a new project, Windows only.** The first Hermes thread in each new project failed three times out of
three with *Native thread creation is not confirmed* (`windows-first-send-new-project.png`): `session/new` did not
answer within Sotto's 30 seconds. A second thread in the same project then worked. A stack taken from a traced
`hermes acp` during the stall shows Hermes building the model picker (`model_state` → `build_models_payload` →
`get_curated_nous_models` → `hermes_user_agent` → `get_version_info`) waiting on `subprocess.run(["git", "rev-parse",
"HEAD"], timeout=3)` that never returns. The same steps on forge answered on the first send. The guide tells Windows
users to start a new thread; the cause is in Hermes and is left as a follow-up.

**Omarchy's own `hermes`.** forge already had `~/.local/bin/hermes` from Omarchy's AI menu: a stub that installs
Hermes through `mise use -g` on its first run. The official installer leaves a file it did not write in place, so it
published only `hermes-acp` and `hermes-agent` there. The CLI lookup already passes over a script that runs through
mise, so without this change Sotto would have said Hermes is not installed; it now finds the installer's own launcher
in `~/.hermes/hermes-agent/.hermes/bin`.

**`hermes.exe` is a launcher.** On Windows it runs Hermes in Python as its child. The child dies with the launcher, but
what the gateway's Python starts does not, which is why Disconnect now ends the tree with `taskkill /T`. Hermes
starts background commands with its bundled Git Bash: `bash.exe -lic "set +m; <command>"`, as on the other systems.

## Focused checks

- `npx vitest run tests/unit/main/hermesEnvironment.test.ts tests/unit/main/hermes.test.ts`: 27 passed, with new tests
  for the Windows and Linux installer folders and for `taskkill /T` on Windows.
- `npx vitest run tests/unit/shared/interfaceCatalogs.test.ts`: 4 passed, after `npm run i18n:extract` for the Settings
  row's "this computer".
- `npm run typecheck` and `npx eslint` on the changed files: passed.

These ran on Node 24.14.1 on the laptop, not the pinned 24.22.1. The full suite was left to GitHub CI.

## Not checked here

- macOS. The hold was lifted only for other platforms; the Mac's lookup, launch and stop paths are unchanged.
- A packaged installer. Both systems ran the built app unpackaged.
