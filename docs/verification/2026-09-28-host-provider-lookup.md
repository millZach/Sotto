# A host connects every signed-in provider it can find (#459)

September 28, 2026. Branch `fix/host-provider-lookup` from `main` at ef5ee727 (Sotto 0.1.22), with `main` at 27e2f697 merged in after review, on the Windows development machine. The running-app journey is `tests/e2e/host-provider-lookup.spec.ts` against the built app (1 passed, run again after the review fixes, when the four no-provider captures were retaken). It adds a host named forge through a scripted ssh that runs the real launch script, which starts a real headless host with scripted providers. The local host is off and reduced motion is on in that profile, and the host's home is a throwaway folder, so no real account or provider is touched.

## What was proved in the running app

1. **Nothing signed in on forge.** The host saved nothing that names a provider, and each of its four providers fails to connect the way Claude Code did on forge. All four show as `error` in the host's provider list. Add project on forge, with the folder `~/code/site`, is refused in the folder dialog with "No provider is connected on forge. Connect one in Settings > Hosts." The host itself says "this host", and the desktop puts in the name the host was saved under. There is no "Your draft is saved." because adding a project has no draft. The alert and **Use this folder** stay inside the window at 1600x1000, 1280x800 and 820x560, in dark and light, and nothing scrolls sideways.
2. **Signed in, then restarted.** The providers are signed in on the host, and the host is restarted from Settings → Hosts: **Stop host** in the row's More menu, then the switch back on. All four connect by themselves. Nothing on the host names them, and no turned-off record is written (`host-providers.json`). The same folder is then added as a project, and it shows in the sidebar under a forge badge.
3. **No page error.** The spec fails on any uncaught page error. Without the browser fix on this branch (below), the Threads page unmounted once forge's threads arrived, and the spec failed at "Add project" in step 2.

## What the tests prove instead

- `tests/unit/main/cliLookup.test.ts` runs over a fake home folder. It finds each of Claude Code, Codex, Grok Build and Devin under the login shell's PATH, `~/.local/bin`, mise's `installs/<tool>/latest` (in `bin`, at its top, and in `node_modules/.bin`, and under `MISE_DATA_DIR`), asdf, nvm, fnm, Volta, Homebrew and the npm global prefix (`npm_config_prefix` and `.npmrc`). It prefers PATH and never starts the login shell when PATH has the client. It passes over the mise and asdf shim folders and anything whose real path is `mise`. It passes over forge's `~/.local/bin` wrappers, which run `mise use -g` and `mise x`, for every provider, and takes the install under mise's `latest` that the wrapper would have run. It passes over `mise exec` and `asdf exec` wrappers too, and still takes an npm `#!/usr/bin/env node` launcher. On Windows it finds each client by its `.exe` name, skips npm's `.cmd` shims, finds Codex inside `%APPDATA%\npm`, and never asks a login shell. It also checks the PATH a found client runs with: its own folder and Node's go ahead of the inherited PATH, the login shell's other folders follow it, and nothing else in the environment changes. The link and login-shell cases need symbolic links and `/bin/sh`, so they skip on Windows and run in the Linux CI job.
- `tests/integration/hostProviderLookup.test.ts` starts real headless hosts. A host that had saved only Claude Code, with Claude Code signed out, connects the other three at start. A provider disconnected through the host is recorded in `disconnectedProviders` and stays disconnected after a restart; connecting it again clears the record. Disconnect with no provider turns all four off, and a changed enabled set records what it left out. The mise journey starts the host the way forge's was started: PATH is `/usr/local/bin:/usr/bin:/bin` less any folder that holds Node (a CI runner's `/usr/local/bin` does), and the login shell adds mise's shims and `~/.local/bin`. The shims folder holds a `claude` linked to a stand-in `mise`, and `~/.local/bin/claude` is forge's wrapper that runs `mise use -g` and `mise x`. A scripted Claude Code at `~/.local/share/mise/installs/claude/latest/bin/claude` runs `#!/usr/bin/env node`, and mise's Node beside it marks every process it starts. Claude Code connects on its own and a create-project succeeds; every Claude Code process ran on mise's Node, and mise never ran. That case skips on Windows and runs in `npm run test:socket` on Linux.
- `tests/unit/main/noProviderRefusal.test.ts` covers the desktop's own coordinator: "No provider is connected on this computer. Connect one in Settings > Providers.", with "Your draft is saved." for a send and without it for a create. `tests/unit/main/desktopHostRouter.test.ts` checks that the desktop names a remote host in that refusal, for a command and for the state it shows.

## Not checked here

- **The Linux-only cases were not run on this machine.** Windows cannot run them, and Docker Desktop would not start here. They run in CI's Linux job (`npm run test:socket`).
- **forge itself, live: pending.** The owner or the orchestrator checks it after the branch is built into a host archive:
  1. Remove the workaround `~/.codex/bin/codex`, and restore `~/.sotto/agents.json` from `agents.json.before-codex`.
  2. Restart the host.
  3. Check that Codex connects by itself, and that Grok Build connects from `~/.grok/bin`.
  4. Check that Claude Code shows its sign-in error without stopping the others.
  5. Check that `~/.config/mise/config.toml` is unchanged after the restart: nothing Sotto starts runs forge's `mise use -g` wrappers.

  Read-only checks over SSH found the layout this change expects. Claude Code is at `installs/claude/latest/claude`, the top of the install. Codex is a native binary at `installs/codex/latest/bin/codex`. Node is at `installs/node/latest/bin/node`. Grok Build is at `~/.grok/bin/grok` and in mise's `node_modules/.bin`. The login shell's PATH is `…:~/.local/share/mise/shims:~/.local/bin:…`. The lookup skips the shims folder and passes over the wrappers in `~/.local/bin`, so on forge Claude Code starts from `installs/claude/latest/claude` and Codex from `installs/codex/latest/bin/codex`, never through `mise x`.

## Captures

In `artifacts/host-provider-lookup/`:

- `no-provider-1600x1000-dark.png`, `no-provider-1280x800-light.png`, `no-provider-820x560-dark.png`, `no-provider-820x560-light.png`: the folder dialog refusing Add project on forge.
- `project-added-1280x800-dark.png`: the same project added after the host restarted with its providers signed in.
- `host-providers.json`: each provider's connection on forge after the restart, and the enabled set the host saved.

## Design gate

No surface changed its look: the refusal is new wording in an alert the folder dialog already has. `npm run design:verify` fails on this branch only where it fails on `main`: the onboarding, dictate, focus and feedback capture differs from its baseline, and the serial captures after it do not run. No baseline was regenerated.
