# Files, Changes and Agents for a thread on a paired host (ADR-0025, October 5 amendment)

Checked on October 5, 2026, on Windows, in the built app driven by `tests/e2e/remote-thread-tools.spec.ts` (`npm run build`, then `npx playwright test tests/e2e/remote-thread-tools.spec.ts`: 1 passed). The host is real: the spec builds the headless host from `tests/fixtures/e2eSshHost.ts` into a fake installation, adds it as "forge" through Add host over the scripted ssh, and makes a project there whose folder is a Git repository with one file changed and one new. The captures are in `artifacts/remote-thread-tools/`, and `verification.json` holds the journey's checks.

## Files

- `files-1280x800-dark.png`: Tools > Files for the forge thread lists the host's folder (`moondust/`, `README.md`) where it used to say *Files is on the host machine*. Opening `moondust/score.mjs` shows its text in the preview, read on the host (`filesListedFromHost`, `previewFromHost`).
- The preview offers Wrap, Copy path and Close, and nothing named Show in folder anywhere in the panel (`noShowInFolder`).
- The footer reads *Space Race · master · Project folder · on forge* (`footerSaysOnForge`).
- **Copy working folder path** said *Path copied* and copied the host's own path of the working folder (`copyPathIsHostPath`; an e2e run copies to its scripted clipboard).

## Changes

- `changes-1280x800-dark.png`: Working tree against HEAD, read on the host, with the changed `moondust/score.mjs` and the new `moondust/storyboard.md` and their diffs (`changesFromHost`).
- The scope menu offers Working tree and Branch changes, and nothing else (`twoScopesOnly`).
- A file changed on the host after the panel opened appeared on its own, with nothing pressed, from the window's four-second check of the host's change list (`changeAppearsOnItsOwn`).
- `changes-820x560-light.png`: the same at the minimum window, in light, with the new `README.md` change at the top. Nothing overflows the window.

## Agents, file mentions and the tools still on the host

- `agents-1280x800-dark.png`: Tools > Agents reads the host's roster for the thread, which has spawned none (`agentsFromHost`). A roster with agents is covered by `tests/unit/main/desktopHostRouter.test.ts`, which passes a host's agent row through to the window, since the fake provider runs inside the host process and spawns none.
- Tools > Terminal still says *Terminal is on the host machine.* (`terminalStillOnHost`).
- Typing `Read @READ` in the thread's composer offered the host's `README.md` (`fileMentionFromHost`).

## Not checked here

- Forge itself: this is the real headless host on this computer, reached through the scripted ssh. A host on forge offers these surfaces once it runs a Sotto with this change; an older host gets the version sentence in each surface.
