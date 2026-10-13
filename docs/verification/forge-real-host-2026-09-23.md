# The SSH transport against forge, a real remote host

September 23, 2026. The first time Sotto's launcher met a real remote machine rather than a fake ssh or a loopback sshd: the desktop's `DesktopHosts` and `SshHostLauncher` from `main` at 76fc8d76, driven against `forge` over Tailscale SSH. Part of #237; advances #138, #142, #131 and #134 without closing them.

## What was proved

One journey, the one the Linux CI job runs against a localhost sshd (`tests/integration/realSshd.test.ts`), against forge instead, from the Windows laptop:

1. **Connect** resolved `forge` with `ssh -G`, read `ssh -V` once, found Node 24 through the login-shell probe (no `node` on the non-interactive path; mise's shims give 26.8.1, which the probe reported as too new and passed over for the 24.21.0 in mise's installs), started the host from `~/sotto-host` with `--data ~/.sotto --port 0`, forwarded a local port to it, read a pairing code over the one-shot launch script and paired itself. The row reached `connected` with `owned: true` in 1.4 s. The host's descriptor recorded `startedBy: "launch-script"`, `sottoVersion: "0.1.16"` and `features: ["detail-delta"]`.
2. **A command reached the host** through the forward: a `configure` from the router changed the host's enabled providers, and the shell came back changed.
3. **Kill the forward** (SIGKILL on the `-N -L` ssh). The row went `connecting, reconnecting: true`, waited the first backoff step and was `connected` again 3.7 s after the drop, to the same host process, with the same pairing. The retry schedule recorded exactly `[0]`.
4. **Disconnect** left the host running: its process answered `kill -0` and its health check answered 200 on forge afterwards.
5. **Connect, then Stop host** ended the process; the descriptor was gone.
6. **Connect** started a new host process on the same host identity and the same pairing.
7. **Forget** removed the row and the credential, revoked the pairing on forge (`paired-clients.json` went from one client to none) and stopped the host. Two seconds past the first backoff step, no ssh had been spawned and no retry scheduled. A further connect was refused with "no longer saved".

No prompt was shown during the run: Tailscale SSH authenticates by tailnet identity, and forge's host key was already in `known_hosts`. Sixteen ssh processes ran for the four connects, plus one `ssh -V`.

## The same journey through the Windows ssh.exe

The first run drove Git Bash's OpenSSH 10.2, because `C:\Windows\System32\OpenSSH\ssh.exe` exits 255 with no output when started from inside the agent harness: `-V`, `-G` and a plain command all do, piped, without `windowsHide`, with a stripped environment and under node-pty's pseudo-console alike. Started through WMI (`Win32_Process.Create`), which puts the process outside the harness's process tree, the same binary printed `OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2` and ran a command on forge with exit 0. The failure belongs to the harness, not to the machine or to how Sotto spawns ssh.

So the driver ran a second time through WMI with `SOTTO_FORGE_WINSSH=1`: the launcher's own defaults, which pick the System32 `ssh.exe` on Windows and pass `LogLevel=DEBUG1`. Every step above passed again (vitest 1 passed in 16.1 s). All sixteen connection processes and the `ssh -V` were `C:\Windows\System32\OpenSSH\ssh.exe`; the version check read 9.5p2 as new enough; the reconnect came 4.1 s after the forward was killed, on the first backoff step; Forget left no paired client and no host running.

## Evidence

- `artifacts/forge-hand-test/journey.json` (Git Bash's OpenSSH) and `journey-windows-ssh.json` (the System32 `ssh.exe`): every step with its time, every status the row passed through, the spawn arguments of every ssh (with nothing from the askpass environment), the descriptor read on forge before and after each step, and the counts above. It holds no token, code, key or prompt text.
- `artifacts/forge-hand-test/forgeJourney.test.ts.txt`: the driver, kept beside the logs rather than in the suite. It is `realSshd.test.ts` with the target set to `forge` and the host machine inspected over a second ssh at each step. By default it gives the launcher `platform: 'linux'` and Git Bash's `ssh.exe`; with `SOTTO_FORGE_WINSSH=1` it leaves the launcher's Windows defaults alone. Run it from a checkout with `SOTTO_FORGE=1` after copying it back under `tests/integration/`.

Vitest reported 1 passed in 13.5 s through Git Bash's OpenSSH and 1 passed in 16.1 s through the Windows `ssh.exe`.

## The machine

- forge: Omarchy Linux (kernel 7.2.5), user `zach`, reached at its Tailscale name. OpenSSH's sshd is inactive there; port 22 is Tailscale SSH, which needed a one-time browser check for this laptop before the run and asked nothing during it. Its Tailscale SSH host key replaced the OpenSSH one on line 17 of the laptop's `known_hosts`; the old file is kept as `known_hosts.old`.
- Node: 26.8.1 is forge's mise default. `mise install node@24` put 24.21.0 in `~/.local/share/mise/installs/node/`, which the probe scans, without changing the default.
- The host: `Sotto-host-0.1.16-linux-x64.tar.gz` from the CI run on 76fc8d76 (35920261631), checksum verified on forge, extracted into `~/sotto-host`. After the run the install stays; the data folder `~/.sotto` holds the host's stores with no paired client and no host running.

## What this does not prove

- **The Windows askpass path.** The `ssh.exe` run asked nothing, so whether ssh.exe starts the `.cmd` askpass shim, and whether its `DEBUG1` output carries the `Server host key` line the fingerprint recovery reads, are still unverified. A host behind plain OpenSSH with a new host key or a passphrase-protected key would exercise both.
- **The released app.** Sotto 0.1.16 was cut from 3ef46ad3, before the five pull requests this run exercises, so the installed app still has the old launcher. It reaches forge but runs a bare `node`, which forge's non-interactive shell does not have, and reports that exit as "SSH refused the connection". A release from `main` carries the launcher proved here.
- **Password, passphrase and host-key prompts.** Tailscale SSH asked for nothing, so the askpass helper carried no question here. The Linux CI job covers a passphrase and a new host key through the real helper against a loopback sshd.
- **A provider turn.** No provider client is signed in on forge, so no prompt was sent and no reply seen. #138's acceptance still owes that.
- **A dropped network.** The forward was killed, not the link, so the `ServerAlive` timeout path did not run.
