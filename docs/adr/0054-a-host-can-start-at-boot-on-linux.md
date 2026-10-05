# A host can start at boot on Linux

## Status

Proposed October 5, 2026, for the owner to confirm on the pull request; it becomes Accepted with the date of that confirmation. The owner delegated the open questions to the agent that wrote this ("Go ahead and do everything we discussed, no need to stop and ask me"), so the picks below are the agent's, made under that delegation and recorded as such. The design is the boot offer and the consent modal of variant C with A's controls in `docs/prototypes/host-tailnet-prototype.html`; the plan is `docs/plans/host-tailnet-connection.md`. Companion to [ADR-0053](0053-a-desktop-reaches-a-host-over-its-tailnet-first.md). Amends [ADR-0025](0025-headless-host-and-client-identity.md), [ADR-0040](0040-an-older-host-is-updated-from-the-threads-page.md) and [ADR-0050](0050-a-hosts-phone-access-is-turned-on-from-the-desktop.md), whose first consequence left running the host as a service to separate work. This is that work.

## Context

A host Sotto started outlives the desktop (ADR-0025, September 22 amendment) but not its machine. After forge restarts, its threads are out of reach, from phones and from a tailnet connection alike, until a desktop connects over SSH and the launch script starts the host again. On a tailnet whose Tailscale SSH policy is in `check` mode, that connect waits for the owner's approval in a browser. So a reboot undoes most of what ADR-0053 buys.

Linux machines with a systemd user manager can start a user's own process at boot without root, through a user unit and the account's linger setting. Without linger, the account's user manager, and every unit it runs, starts at the account's first sign-in and stops when its last sign-in session ends; a forward-only `ssh -N -L` opens no sign-in session. A host started by the launch script today is detached and survives sign-out, so a unit without linger would keep the host up for less time than today, not more. The host's release is Linux-only (ADR-0025).

## Decision

**Start at boot** is a host's systemd user unit, installed by Sotto, that starts the host when its machine starts. `CONTEXT.md` has the term. Avoid "service", which is the host service, and "daemon".

**Where it applies.** Linux with a systemd user manager. macOS hosts are out: a LaunchAgent starts only at sign-in, and a LaunchDaemon needs root. Windows hosts are out: the launch script is POSIX only. Linux without a user manager (WSL without systemd, a container) is out. In each case the launch script's `boot-status` says `unsupported` with one plain sentence saying why, and the desktop offers nothing.

**Linger comes first.** Start at boot needs the account to linger, and nothing on the host changes until it does. The unit is installed only once linger is on, and a launch uses the unit only while the account lingers; if linger is later turned off, launches go back to starting a detached host, and `boot-status` says why.

**The launch script's operations.** Three new operations, each one `ssh` command like the others:

- `boot-status` reports whether boot start is supported, installed and active, whether the account lingers, and whether the unit's pinned Node has drifted from the one the host archive wants. A launch reports it too.
- `boot-install` reads the account's linger setting first (`loginctl show-user -p Linger`). If it is off, it runs `loginctl enable-linger` for the account, without sudo, since linger is the account's own setting and the owner consented to it with the press. If polkit refuses, it stops there: nothing is written and the running host is untouched, and the result carries `sudo loginctl enable-linger <user>`, which the modal shows with a copy button and the advice to run it on the host and press Start at boot again. Sotto never runs sudo, as with the Serve operator (ADR-0050). Once the account lingers, it writes `~/.config/systemd/user/sotto-host.service` and a small `boot-start.sh` in the installation folder, reloads the user manager and enables the unit. It then hands over a running host: one Sotto started is stopped the way Stop host stops it (SIGTERM, 15 seconds to save and exit) and started again by the unit, so it restarts once; one Sotto did not start is left running and the unit takes over at the next boot. The modal says which before the press.
- `boot-remove` disables and stops the unit, removes both files, and starts the host the way a launch does, so a host that is switched on keeps running. That is a restart, and the modal says so before the press. Forget runs it without the last step (below).

**A busy host asks first.** Installing the unit over a host Sotto started, and removing it, each restart the host once, which stops its turns in progress. Both use ADR-0040's busy-host question: when one of the host's threads is working, the modal says how many and offers to wait until they finish, to stop them now, or to cancel, as Update does.

**The unit.** It runs `boot-start.sh` with `SOTTO_HOST_STARTED_BY=boot`, restarts the host on failure after 5 seconds, gives it 25 seconds to stop, and is wanted by the user's default target. `boot-start.sh` resolves `current` the way the launch script does (ADR-0040) and runs the host with an absolute Node path, the data folder and the port, and no key file, as a launch does. The Node path is pinned when the unit is written, and an update rewrites the script when the probe finds a different Node or the new version needs a different range. Provider clients under systemd's short `PATH` are found by the login-shell fallback the host already has.

**Ownership.** `startedBy: "boot"` is a new value in the host's listener descriptor. A host started by the launch script or by its boot unit counts as started by Sotto, so Stop host, Forget's stop and Update still apply.

**Lifecycle with the unit installed.**

- A launch never starts a detached host while the unit is enabled and the account lingers. It asks the user manager to start the unit and waits for the host, so a launch and the unit cannot race for the host lock.
- **Stop host** stops the unit. Its confirmation says "forge's host stops now and starts again when forge restarts or when you switch it on."
- **Forget** removes the unit and its script wherever it is installed, and stops the host only if Sotto started it, so a forgotten host does not come back at the next boot. Its confirmation says so.
- **Update**'s restart writes `current` and restarts the unit, then waits for the new host. A rollback points `current` back and restarts the unit again.
- The host puts Serve back at start from its own `phoneAccess` and `tailnetConnections` settings (ADR-0053), and the Serve setting survives a reboot in tailscaled too. A user unit cannot be ordered after `tailscaled`, so for the first 5 minutes after a start the host's phone access retry, every 30 seconds, also covers Tailscale missing and Serve failing.

**What the owner sees (the delegated picks).** Add host's connected card offers **Start forge's host at boot**, one consented press. The row's More menu has **Start at boot…**, or **Stop starting at boot…** once it is installed, and each opens a modal that says what changes on the host (linger for the account, a unit in the account's systemd folder, a script in the installation folder), that a host Sotto started restarts once and its turns stop, and the linger command for the owner to run there if the host asks for an administrator. Each runs over the SSH connection, or opens an admin connection when the host is on its tailnet connection (ADR-0053), so a Tailscale approval shows in the modal.

**Outside the voice gate.** Start at boot is a press in Settings. Nothing speaks, listens or manages a thread, so it sits outside `voiceCoordinatorEnabled` (ADR-0012), like Update.

**Privacy.** Nothing new is contacted. The unit and its script stay on the host, and the commands Sotto runs there (`systemctl --user`, `loginctl`) talk only to that machine's own system.

## Consequences

- A host started at boot keeps its threads reachable from phones and tailnet connections across a restart of its machine, with no desktop and no SSH.
- Installing the unit, and removing it, each restart a host Sotto started once. Its turns in progress stop, as Stop host's do, after the busy-host question.
- A host whose account cannot linger without an administrator gets nothing until the owner runs the command; Sotto does not install a unit that would stop the host at sign-out.
- The pinned Node path drifts when a version manager upgrades Node. `boot-status` reports the drift and an update rewrites the script.
- Tests use fake `systemctl` and `loginctl` executables on the path. Only a check on a real Linux host, recorded in `docs/verification/`, proves the unit, linger and a reboot.
- A macOS or Windows host, and a Linux host without the unit, keep today's behaviour: it starts again only when a desktop connects.
