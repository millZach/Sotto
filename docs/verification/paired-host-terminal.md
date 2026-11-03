# A thread on a paired host opens its terminal over SSH

November 2, 2026. The branch `feat/paired-host-terminal` from `main` at 2e3a59929, recorded in ADR-0183.

## What was proved

Two runs, since no single run here has both a real SSH server and the built app.

**A real OpenSSH server under the real terminal.** `tests/integration/realSshdTerminal.test.ts` starts a throwaway `sshd` on a loopback port and runs the terminal service with the real `ssh` under the real `node-pty`, with the arguments the app uses, on forge:

- OpenSSH asks about the unknown host and for the key's passphrase in the terminal, and answers typed there are taken.
- The shell starts in a project folder whose name holds spaces and both kinds of quote.
- Typing reaches the shell, and a resize reaches it too: `stty size` reads 30 100, then 20 90.
- `exit 7` reports exit code 7. Reopen starts a new shell. Killing the session's `sshd` reports exit code 255.

**The built app, with a real paired headless host and a stand-in for ssh.** `tests/e2e/paired-host-terminal.spec.ts`, in dark and light, under Xvfb on forge. The stand-in runs the remote command here under the app's real terminal, as sshd would:

- Terminal drawer in the header isn't greyed, and a press opens a shell in the project folder.
- The bar says "on Forge" at 1280x800, 1600x1000 and the 820x560 minimum, and nothing in the bar spills out.
- The arguments ssh received start with `-tt` and name the saved host's target. The window sent only a thread.
- Tools' Terminal starts its own shell, with "on Forge" on its bar.
- `exit 255` shows "The connection to Forge ended." with Reopen, and Reopen starts a new shell.
- Ctrl+J hides the drawer from inside the terminal.

`tests/e2e/pane-header.spec.ts` still passes: with the feature off, the button is greyed and names the machine, as ADR-0182 has it.

## How it was run

```sh
SOTTO_REAL_SSHD=1 SOTTO_SSHD=/usr/bin/sshd npx vitest run tests/integration/realSshdTerminal.test.ts --maxWorkers=1
npm run build
SOTTO_E2E_EVIDENCE=publish xvfb-run -a npx playwright test tests/e2e/paired-host-terminal.spec.ts --workers=1
```

## Captures

`artifacts/paired-host-terminal/`: `drawer-1280x800`, `drawer-1600x1000`, `drawer-820x560`, `tools-1280x800` and `connection-ended-1280x800`, each in `-dark` and `-light`.

## Not proved here

- Windows' OpenSSH under ConPTY, which is the laptop's route to forge. This journey isn't in the desktop smoke selection, so no CI job runs it, on Windows or anywhere else, and its Windows branches have not been run.
- A real Tailscale SSH session, including its approval banner in the terminal.
- A host folder written the Windows way against a real PowerShell. Unit tests check the encoded script's shape, not a run of it.
- A sleeping laptop. The keepalive's numbers follow from OpenSSH's own rule, not a run.
